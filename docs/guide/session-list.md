# Session list

HAPI's Web session list combines live session state, project grouping, search,
and local display filters. The list is designed to keep sessions that need
attention easy to find while still allowing older sessions to be searched.

## Ordering and grouping

The default order follows **your most recent input**, not the agent's most
recent output. Sending a new message moves a session forward once. Streaming,
tool/Todo updates, waiting for approval, completion, and reconnects do not
reorder ordinary rows. Status and unread indicators still update live.

1. Globally pinned sessions.
2. Project-pinned sessions.
3. `lastUserMessageAt` descending (or `createdAt` before any user input).
4. Creation time descending, then session ID for deterministic ties.

The Web app groups sessions by machine and project directory. Within a project,
pins come first, followed by the same user-input order. Project and machine
groups use their pinned state and newest member's ordering key, not live
activity. There is no fixed-order preference to configure.

Manual Codex history selection filters by **Project**. Git main checkouts and
linked worktrees share a verified project root; each history row still shows its
actual working directory. Imported sessions use that root for grouping on the
same machine, while their native thread IDs and execution directories remain
unchanged through resume. Successful manual imports also enable project-scoped passive
imports, as described in [Automatic Codex history import](#automatic-codex-history-import-for-enabled-projects).

Project identity comes from Git's common directory and worktree registrations,
not matching directory names. Deleted worktrees can be associated when their
exact paths remain registered in a repository discovered in the history scan.
Pruned, inaccessible, or otherwise unverified paths fall back to separate working
directories. History previews read bounded file headers and tails; older titles
or prompts in the middle of very large transcripts may not appear in previews.

The Hub persists the original user-message timestamp, including local CLI
input. Historical imports and duplicate/echoed messages do not acquire a fresh
ordering timestamp. Deletion or rewind does not rewind this monotonic clock.
An unattended session's new output is indicated as unread rather than moving
it ahead of conversations you have interacted with more recently.

The detailed API contract is documented in [REST — sessions](../api/client-contract/rest.md#sessions--list--detail)
and [SSE — keep-alive noise](../api/client-contract/sse.md#keep-alive-noise).

`updatedAt` remains the session activity clock used by timestamps, not the
ordering key. It is different from `activeAt`: `activeAt` is the CLI connection keep-alive
clock and does not, by itself, move a session in the list. A connected session
can therefore be idle; see [active is transport liveness, not agent health](../api/client-contract/sse.md#active-is-transport-liveness-not-agent-health).

When enabled in **Settings → Display**, the optional in-progress layout moves
active sessions into Working, Pending, Active, and Idle sections. Global and
project pins remain distinct from these sections. This optional layout still
moves rows between sections as their status changes, but orders rows within
each section by user input rather than ongoing output.

## Text search

The search field on the Web session list searches session metadata, including:

- the displayed title (name, summary, path, or ID fallback);
- worktree labels and paths;
- summary text;
- agent flavor and machine label; and
- the session ID.

Plain-text matching is case-insensitive and supports partial substrings. A
multi-word query uses AND semantics: every term must match at least one
searchable field. Queries containing `*` or `?` use wildcard matching, where
`*` matches any sequence and `?` matches one character.

Search results are ranked by relevance rather than by date alone. Title and
worktree matches are more prominent than summary, machine, path, or ID-only
matches; token-boundary matches and exact/contiguous title phrases receive
additional preference. When relevance is tied, the stable user-input order is used
as the tie-breaker. This means an older session with a distinctive title can
appear above a newer session that only matches a common path segment.

Search preserves the session-list structure: pinned rows remain contiguous and
project groups remain visible. Matching project groups open automatically, but
the preview limit still applies within an open group. Search does not apply a
relevance cutoff; use the group's batch reveal controls to show additional
matching rows.

## Filters and display settings

- **Sort and filter** in the list toolbar holds the rarely changed view
  choices: sort by last message (the default) or date created; **Active
  first** (on by default); and show all sessions, active only, or archived
  only. The currently open session stays visible. Choices are remembered
  locally, and a dot on the button marks a non-default view.
- **Machine** filters can be applied when more than one machine is present:
  chips under the toolbar on wide screens, a filter button in the toolbar on
  narrow ones. The selection is remembered locally in the browser and falls
  back to All when that machine is no longer available.
- **Unread** sessions need no filter. A collapsed project still lists its
  unread sessions under its header, and the preview limit never hides one.
  The toolbar shows **Mark all as read** with the unread count while any
  session is unread.
- **Session preview limit** controls how many rows are initially visible within
  each project group. Unread sessions, sessions with pending requests, and the
  selected session can remain visible; a project can reveal more rows in
  batches.
- **Session-list status** controls whether rows show the standard or detailed
  attention/status presentation.

Empty, inactive session stubs without conversation, an agent identity, or an
explicit title signal are not shown in the normal sidebar. Duplicate rows
representing the same underlying agent session are collapsed, with the live,
selected, pinned, or most recent row preferred as appropriate.

## Other Web session pickers

The other Web surfaces intentionally use related but different policies:

### Share-target picker

The `/share` picker snapshots the session list when it opens so live SSE
updates do not reshuffle the rows under the user's finger.

- With no query, it shows recent active sessions, sorted by `updatedAt` and
  capped by the session preview limit.
- With a text query, it searches all matching sessions,
  including inactive sessions, and keeps `updatedAt` descending order.
- It reuses the session metadata matching fields, but it does not apply the
  main sidebar's relevance ranking.

### `@` session suggestions

Composer `@` suggestions only include sessions with conversation content.
Active sessions appear first, followed by an inactive section that can be
collapsed or expanded. The browser remembers that choice. Each group shows up
to 20 matches, ordered by relevance and recency; names, directories, and
machine labels affect matching. Empty stubs are never mention targets, and
collapsing inactive sessions does not hide file suggestions.

### Automatic Codex history import for enabled projects

A successful **manual import** from the Codex session picker (`POST /api/codex/sync-session`)
opts that machine's project into passive imports. Opening the picker, starting a HAPI
session, or importing a different project does not enable it. Identity is
`namespace + machineId + projectRoot` (falling back to cwd for non-Git directories),
so registered worktrees share the same subscription without changing their actual cwd.

On the first Hub startup with this feature, projects represented by existing imported
sessions receive a **new enablement timestamp at startup**, not their historical import
dates. This baseline is stored once. Repeated manual imports and Hub restarts do not
move it. `GET /api/codex/auto-import-projects` returns the authenticated namespace's
subscriptions and `enabledAt` Unix milliseconds.

Every 30 seconds, the Hub asks online Runners for complete summaries. Only native main
sessions with `thread_source` equal to `user` or `agent_created_thread`, and a transcript
creation timestamp strictly after enablement, qualify. Missing/invalid timestamps and
other thread types are excluded; file modification times never establish newness.
Older history is not backfilled. An empty transcript is retried when it has content.
Runner disconnection or a failed transcript does not advance a watermark; reconnect
catches up eligible new sessions without a recent-N limit.

An automatic import takes one passive history snapshot. It does not resume the agent,
submit a task, or continuously mirror subsequent messages. Durable native-ID receipts
make rescans and restarts idempotent and survive deletion of the HAPI session. Explicit
manual re-import remains possible. The project remains enabled after deleting its last
imported session. Project subscriptions and receipts are additive SQLite tables and are
retained when rolling back to an older binary; no global sync script is involved.
