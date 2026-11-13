import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../store'
import { SyncEngine } from './syncEngine'
import { RpcRegistry } from '../socket/rpcRegistry'
import { CodexProjectAutoImport } from './codexProjectAutoImport'
import { importSelectedCodexSessions } from '../web/routes/codexDesktop'

const cleanup: Array<() => void> = []
afterEach(() => { for (const f of cleanup.splice(0)) f() })
function transcript(id: string, overrides = {}) {
    return {
        id, title: id, file: `/native/${id}.jsonl`, cwd: '/worktrees/feature', projectRoot: '/repo',
        createdAt: 200, modifiedAt: Date.now(), threadSource: 'user',
        messages: [{ role: 'user' as const, content: { type: 'text' as const, text: 'same prompt' }, meta: { sentFrom: 'cli' as const } }],
        ...overrides
    }
}
function setup() {
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    const online = spyOn(engine, 'getMachine').mockReturnValue({ active: true, namespace: 'ns' } as never)
    const rpc = spyOn(engine, 'listCodexSessionsForMachine')
    const scanner = new CodexProjectAutoImport(store, engine)
    store.codexAutoImport.enable({ namespace: 'ns', machineId: 'm', projectRoot: '/repo', enabledAt: 100 })
    cleanup.push(() => { scanner.stop(); engine.stop(); store.close() })
    return { store, engine, rpc, online, scanner }
}

describe('project-scoped passive Codex imports', () => {
    it('filters old/unknown/future/unenabled/internal threads and shares project identity across worktrees', async () => {
        const { store, rpc, scanner } = setup()
        const sessions = [transcript('old', { createdAt: 99 }), transcript('boundary', { createdAt: 100 }),
            transcript('unknown', { createdAt: undefined }), transcript('future', { createdAt: Date.now() + 100000 }),
            transcript('other', { projectRoot: '/other' }), transcript('child', { threadSource: 'subagent' }),
            transcript('voice', { threadSource: 'realtime_voice' }), transcript('missing-source', { threadSource: undefined }),
            transcript('main'), transcript('agent-created', { threadSource: 'agent_created_thread', cwd: '/another-worktree' })]
        rpc.mockImplementation(async (_m, _cwd, ids) => ({ success: true, sessions: ids ? sessions.filter(s => ids.includes(s.id)) : sessions }))
        await scanner.scan()
        const saved = store.sessions.getSessions()
        expect(saved).toHaveLength(2)
        expect(saved.map(s => (s.metadata as Record<string, unknown>).codexSourceSessionId).sort()).toEqual(['agent-created', 'main'])
        expect(saved.every(s => !s.active)).toBe(true)
        expect(saved.map(s => (s.metadata as Record<string, unknown>).path).sort()).toEqual(['/another-worktree', '/worktrees/feature'])
        expect(rpc.mock.calls[0]).toEqual(['m', null, undefined, true])
    })

    it('retries offline, failed and empty transcripts independently; deletion and duplicate scans never reimport', async () => {
        const { store, rpc, online, scanner } = setup()
        let ready = false
        const sessions = [transcript('bad'), transcript('empty'), transcript('good')]
        rpc.mockImplementation(async (_m, _cwd, ids) => {
            if (!ids) return { success: true, sessions }
            if (ids[0] === 'bad' && !ready) throw new Error('unreadable transcript')
            return { success: true, sessions: sessions.filter(s => ids.includes(s.id)).map(s => s.id === 'empty' && !ready ? { ...s, messages: [] } : s) }
        })
        online.mockReturnValue(undefined)
        await scanner.scan()
        expect(rpc).not.toHaveBeenCalled()
        online.mockReturnValue({ active: true, namespace: 'ns' } as never)
        await scanner.scan()
        expect(store.sessions.getSessions()).toHaveLength(1)
        const imported = store.sessions.getSessions()[0]!
        store.sessions.deleteSession(imported.id, 'ns')
        ready = true
        await Promise.all([scanner.scan(), scanner.scan()])
        expect(store.sessions.getSessions()).toHaveLength(2)
        await scanner.scan()
        expect(store.sessions.getSessions()).toHaveLength(2)
        expect(store.codexAutoImport.has('ns', 'm', 'good')).toBe(true)
    })

    it('isolates namespaces and skips already represented native sessions', async () => {
        const { store, rpc, scanner, online } = setup()
        store.sessions.getOrCreateSession('existing', { machineId: 'm', codexSessionId: 'existing' }, {}, 'ns')
        rpc.mockResolvedValue({ success: true, sessions: [transcript('existing')] })
        online.mockReturnValue({ active: true, namespace: 'other' } as never)
        await scanner.scan()
        expect(rpc).not.toHaveBeenCalled()
        online.mockReturnValue({ active: true, namespace: 'ns' } as never)
        await scanner.scan()
        expect(store.sessions.getSessions()).toHaveLength(1)
        expect(store.codexAutoImport.has('ns', 'm', 'existing')).toBe(true)
    })

    it('only successful explicit manual imports enable a project and never move its enablement', async () => {
        const store = new Store(':memory:')
        cleanup.push(() => store.close())
        const options = { store, namespace: 'ns', machineId: 'm', enableProject: true }
        await importSelectedCodexSessions({ ...options, codexSessionIds: ['empty'], localSessions: [transcript('empty', { messages: [] })] })
        expect(store.codexAutoImport.list()).toHaveLength(0)
        await importSelectedCodexSessions({ ...options, codexSessionIds: ['manual'], localSessions: [transcript('manual')] })
        const first = store.codexAutoImport.list()
        expect(first).toHaveLength(1)
        expect(first[0]!.enabledAt).toBeGreaterThan(100)
        await importSelectedCodexSessions({ ...options, codexSessionIds: ['another'], localSessions: [transcript('another')] })
        expect(store.codexAutoImport.list()).toEqual(first)
    })

    it('persists the one-time existing-project baseline and deletion receipts across restarts', () => {
        const path = join(mkdtempSync(join(tmpdir(), 'codex-auto-')), 'hapi.db')
        const store = new Store(path)
        const imported = store.sessions.getOrCreateSession('imported', { projectRoot: '/repo', path: '/worktree', machineId: 'm', codexSourceSessionId: 'old' }, {}, 'ns')
        store.sessions.getOrCreateSession('voice-test', { path: '/test', machineId: 'm', codexSessionId: 'test' }, {}, 'ns')
        store.codexAutoImport.baseline(store.sessions.getSessions(), 100)
        store.sessions.deleteSession(imported.id, 'ns')
        store.close()
        const reopened = new Store(path)
        cleanup.push(() => reopened.close())
        reopened.codexAutoImport.baseline(reopened.sessions.getSessions(), 300)
        expect(reopened.codexAutoImport.list()).toEqual([{ namespace: 'ns', machineId: 'm', projectRoot: '/repo', enabledAt: 100 }])
        expect(reopened.codexAutoImport.has('ns', 'm', 'old')).toBe(true)
        expect(() => reopened.codexAutoImport.transaction(() => {
            reopened.codexAutoImport.remember('ns', 'm', 'rolled-back')
            throw new Error('interrupted')
        })).toThrow('interrupted')
        expect(reopened.codexAutoImport.has('ns', 'm', 'rolled-back')).toBe(false)
    })
})
