import type { Store } from '../store'
import type { SyncEngine } from './syncEngine'
import { importSingleCodexSession } from '../web/routes/codexDesktop'

/** Passive discovery only: never resume, spawn, or apply agent configuration. */
export class CodexProjectAutoImport {
    private running = false
    private stopped = false
    private timer?: ReturnType<typeof setInterval>

    constructor(private readonly store: Store, private readonly engine: SyncEngine) {}

    start(): void {
        this.store.codexAutoImport.baseline(this.store.sessions.getSessions(), Date.now())
        this.timer = setInterval(() => void this.scan(), 30_000)
        void this.scan()
    }

    stop(): void {
        this.stopped = true
        clearInterval(this.timer)
    }

    async scan(): Promise<void> {
        if (this.running || this.stopped) return
        this.running = true
        try {
            const groups = new Map<string, ReturnType<Store['codexAutoImport']['list']>>()
            for (const project of this.store.codexAutoImport.list()) {
                const key = JSON.stringify([project.namespace, project.machineId])
                const group = groups.get(key) ?? []
                group.push(project)
                groups.set(key, group)
            }
            for (const projects of groups.values()) {
                if (this.stopped) break
                const { namespace, machineId } = projects[0]!
                const machine = this.engine.getMachine(machineId)
                if (!machine?.active || machine.namespace !== namespace) continue
                try {
                    // Full summaries, not recent-N: offline gaps may exceed the picker limit.
                    const result = await this.engine.listCodexSessionsForMachine(machineId, null, undefined, true)
                    if (!result.success || this.stopped) continue
                    for (const summary of result.sessions) {
                        if (this.stopped) break
                        if (summary.threadSource !== 'user' && summary.threadSource !== 'agent_created_thread') continue
                        const project = projects.find(p => p.projectRoot === (summary.projectRoot || summary.cwd))
                        // Never use mtime: editing an old transcript must not make it new.
                        if (!project || summary.createdAt === undefined || summary.createdAt <= project.enabledAt
                            || summary.createdAt > Date.now() || this.store.codexAutoImport.has(namespace, machineId, summary.id)) continue
                        const existing = this.store.sessions.getSessionsByNamespace(namespace).some(session => {
                            const m = session.metadata as Record<string, unknown> | null
                            return m?.machineId === machineId && (m.codexSessionId === summary.id || m.codexSourceSessionId === summary.id)
                        })
                        if (existing) {
                            this.store.codexAutoImport.remember(namespace, machineId, summary.id)
                            continue
                        }
                        try {
                            const detail = await this.engine.listCodexSessionsForMachine(machineId, null, [summary.id])
                            if (!detail.success || this.stopped) continue
                            const transcript = detail.sessions.find(s => s.id === summary.id)
                            if (!transcript || !('messages' in transcript) || !transcript.messages.length
                                || (transcript.projectRoot || transcript.cwd) !== project.projectRoot
                                || transcript.createdAt !== summary.createdAt) continue
                            // Import and durable receipt commit together. Deleting the HAPI session
                            // never deletes the receipt. Empty/unavailable transcripts retry later.
                            this.store.codexAutoImport.transaction(() => {
                                if (this.store.codexAutoImport.has(namespace, machineId, summary.id)) return
                                const imported = importSingleCodexSession({
                                    automatic: true, codexSessionId: summary.id,
                                    localSessionsById: new Map([[summary.id, transcript]]),
                                    store: this.store, namespace, machineId, getSyncEngine: () => this.engine
                                })
                                if (!imported.success) throw new Error(imported.error ?? 'Passive import failed')
                            })
                        } catch (error) {
                            console.warn(`[Codex auto-import] Session ${summary.id} will retry:`, error instanceof Error ? error.message : String(error))
                        }
                    }
                } catch (error) {
                    // A failed/offline machine must not advance any watermark or block others.
                    console.warn('[Codex auto-import] Scan will retry:', error instanceof Error ? error.message : String(error))
                }
            }
        } finally {
            this.running = false
        }
    }
}
