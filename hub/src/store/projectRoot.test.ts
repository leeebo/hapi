import { describe, expect, it } from 'bun:test'
import { Store } from './index'
import { MetadataSchema, SessionSchema } from '@hapi/protocol/schemas'
import { toSessionSummary } from '@hapi/protocol'

describe('project identity persistence', () => {
    it('survives sparse CLI updates, schema parsing and sidebar projection without replacing cwd', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('project-test', {
            path: '/worktrees/feature', host: 'test', flavor: 'codex',
            projectRoot: '/projects/repo', codexSessionId: 'native-thread', machineId: 'machine'
        }, null, 'ns')
        const updated = store.sessions.updateSessionMetadata(session.id, { path: '/worktrees/feature', host: 'test' }, session.metadataVersion, 'ns')
        expect(updated.result).toBe('success')
        const saved = store.sessions.getSession(session.id)!
        const metadata = MetadataSchema.parse(saved.metadata)
        expect(metadata.projectRoot).toBe('/projects/repo')
        expect(metadata.path).toBe('/worktrees/feature')
        expect(metadata.codexSessionId).toBe('native-thread')
        expect(metadata.worktree).toBeUndefined()
        expect(store.sessions.updateSessionMetadata(session.id, { projectRoot: '/wrong' }, session.metadataVersion, 'ns').result).toBe('version-mismatch')
        // Use the production summary projection, whose explicit field list must keep identity.
        const summary = toSessionSummary(SessionSchema.parse({ ...saved, metadata, active: false, activeAt: 0, thinking: false, thinkingAt: 0, agentState: null, todos: undefined, teamState: undefined, todosUpdatedAt: 0, teamStateUpdatedAt: 0 }))
        expect(summary.metadata?.projectRoot).toBe('/projects/repo')
    })
})
