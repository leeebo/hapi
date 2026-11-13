import type { Database } from 'bun:sqlite'
import type { StoredSession } from './types'

export type CodexProjectSubscription = {
    namespace: string
    machineId: string
    projectRoot: string
    enabledAt: number
}

/** Additive tables deliberately survive session deletion and binary rollback. */
export class CodexAutoImportStore {
    constructor(private readonly db: Database) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS codex_auto_projects (
                namespace TEXT NOT NULL, machineId TEXT NOT NULL, projectRoot TEXT NOT NULL,
                enabledAt INTEGER NOT NULL,
                PRIMARY KEY (namespace, machineId, projectRoot)
            );
            CREATE TABLE IF NOT EXISTS codex_auto_imports (
                namespace TEXT NOT NULL, machineId TEXT NOT NULL, nativeId TEXT NOT NULL,
                PRIMARY KEY (namespace, machineId, nativeId)
            );
            CREATE TABLE IF NOT EXISTS codex_auto_state (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
        `)
    }

    transaction<T>(fn: () => T): T { return this.db.transaction(fn)() }

    enable(project: CodexProjectSubscription): void {
        this.db.query('INSERT OR IGNORE INTO codex_auto_projects VALUES (?, ?, ?, ?)')
            .run(project.namespace, project.machineId, project.projectRoot, project.enabledAt)
    }

    list(): CodexProjectSubscription[] {
        return this.db.query('SELECT * FROM codex_auto_projects').all() as CodexProjectSubscription[]
    }

    has(namespace: string, machineId: string, nativeId: string): boolean {
        return Boolean(this.db.query('SELECT 1 FROM codex_auto_imports WHERE namespace=? AND machineId=? AND nativeId=?')
            .get(namespace, machineId, nativeId))
    }

    remember(namespace: string, machineId: string, nativeId: string): void {
        this.db.query('INSERT OR IGNORE INTO codex_auto_imports VALUES (?, ?, ?)').run(namespace, machineId, nativeId)
    }

    baseline(sessions: StoredSession[], now: number): void {
        this.transaction(() => {
            if (this.db.query("SELECT 1 FROM codex_auto_state WHERE key='baseline'").get()) return
            for (const session of sessions) {
                const m = session.metadata as Record<string, unknown> | null
                if (typeof m?.codexSourceSessionId !== 'string' || typeof m.machineId !== 'string') continue
                const root = typeof m.projectRoot === 'string' ? m.projectRoot : m.path
                if (typeof root !== 'string' || !root) continue
                this.enable({ namespace: session.namespace, machineId: m.machineId, projectRoot: root, enabledAt: now })
                this.remember(session.namespace, m.machineId, m.codexSourceSessionId)
            }
            this.db.query("INSERT INTO codex_auto_state VALUES ('baseline', ?)").run(now)
        })
    }
}
