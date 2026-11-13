// Node-only helpers. Project identity is display metadata, never an execution cwd.
import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { isAbsolute, normalize } from 'node:path'

function git(cwd: string, args: string[]): string {
    return execFileSync('git', ['-C', cwd, ...args], {
        encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
    })
}

/** Resolve each cwd once per scan, using Git's common directory and registrations.
 * Missing paths are matched only to an exact registered worktree path. Pruned
 * historical worktrees intentionally remain ungrouped; names are not evidence.
 */
export function resolveProjectRoots(paths: Array<string | null | undefined>): Map<string, string> {
    const roots = new Map<string, string>()
    const repositories = new Map<string, string>()
    const registered = new Map<string, Set<string>>()
    const unique = [...new Set(paths.filter((path): path is string => Boolean(path && isAbsolute(path))))]
    for (const cwd of unique) {
        if (!existsSync(cwd)) continue
        try {
            const common = realpathSync(git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim())
            let root = repositories.get(common)
            if (!root) {
                const entries = git(cwd, ['worktree', 'list', '--porcelain', '-z']).split('\0')
                const worktrees = entries.filter(entry => entry.startsWith('worktree ')).map(entry => entry.slice(9))
                if (!worktrees.length) continue
                // Git lists the main checkout (or bare repository) first.
                root = existsSync(worktrees[0]) ? realpathSync(worktrees[0]) : normalize(worktrees[0])
                repositories.set(common, root)
                for (const path of worktrees) {
                    const candidates = registered.get(normalize(path)) ?? new Set<string>()
                    candidates.add(root)
                    registered.set(normalize(path), candidates)
                }
            }
            roots.set(cwd, root)
        } catch { /* Non-Git, inaccessible, or invalid paths retain their original cwd. */ }
    }
    for (const cwd of unique) {
        if (existsSync(cwd)) continue
        const candidates = registered.get(normalize(cwd))
        if (candidates?.size === 1) roots.set(cwd, [...candidates][0])
    }
    return roots
}

export function attachProjectRoots<T extends { cwd?: string | null; projectRoot?: string | null }>(sessions: T[]): T[] {
    const roots = resolveProjectRoots(sessions.map(session => session.cwd))
    for (const session of sessions) {
        const root = session.cwd ? roots.get(session.cwd) : undefined
        if (root) session.projectRoot = root
    }
    return sessions
}

/** Read bounded head/tail previews rather than loading huge native transcripts.
 * Full message import still reads only explicitly selected transcripts.
 */
export function readTranscriptPreview(file: string): string {
    const fd = openSync(file, 'r')
    try {
        const size = fstatSync(fd).size
        const limit = 1024 * 1024
        const read = (start: number, length: number) => {
            const buffer = Buffer.alloc(length)
            return buffer.subarray(0, readSync(fd, buffer, 0, length, start)).toString('utf8')
        }
        if (size <= limit * 2) return read(0, size)
        const head = read(0, limit)
        const tail = read(size - limit, limit)
        return head.slice(0, head.lastIndexOf('\n') + 1) + tail.slice(tail.indexOf('\n') + 1)
    } finally { closeSync(fd) }
}
