import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachProjectRoots, readTranscriptPreview, resolveProjectRoots } from './projectRoot'

const temporary: string[] = []
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }) })

describe('verified project roots', () => {
    it('groups main and linked checkouts, retains registered deleted paths and separates namesakes', () => {
        const base = mkdtempSync(join(tmpdir(), 'project-roots-'))
        temporary.push(base)
        const main = join(base, 'main', 'repo')
        const other = join(base, 'other', 'repo')
        const first = join(base, 'first')
        const deleted = join(base, 'deleted')
        const unknown = join(base, 'unknown', 'repo')
        const plain = join(base, 'plain')
        mkdirSync(plain)
        for (const root of [main, other]) {
            mkdirSync(root, { recursive: true })
            execFileSync('git', ['init', '-q', root])
            execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-q', '--allow-empty', '-m', 'fixture'])
        }
        for (const path of [first, deleted]) execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '--detach', path])
        rmSync(deleted, { recursive: true })
        const paths = [deleted, first, main, other, unknown, plain]
        const roots = resolveProjectRoots(paths)
        for (const path of [deleted, first, main]) expect(roots.get(path)).toBe(main)
        expect(roots.get(other)).toBe(other)
        expect(roots.has(unknown)).toBe(false)
        expect(roots.has(plain)).toBe(false)
        const sessions = attachProjectRoots(paths.map(cwd => ({ cwd, projectRoot: undefined as string | undefined })))
        expect(sessions.map(session => session.cwd)).toEqual(paths)
        expect(sessions[0].projectRoot).toBe(main)
        execFileSync('git', ['-C', main, 'worktree', 'prune', '--expire', 'now'])
        expect(resolveProjectRoots(paths).has(deleted)).toBe(false)
    })

    it('bounds large previews and keeps complete header and final records', () => {
        const base = mkdtempSync(join(tmpdir(), 'transcript-preview-'))
        temporary.push(base)
        const file = join(base, 'session.jsonl')
        writeFileSync(file, '{"type":"session_meta"}\n' + 'x'.repeat(3 * 1024 * 1024) + '\n{"last":true}\n')
        const preview = readTranscriptPreview(file)
        expect(preview).toBe('{"type":"session_meta"}\n{"last":true}\n')
    })
})
