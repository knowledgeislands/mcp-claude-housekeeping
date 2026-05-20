import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { discoverWorkspaces, obsoleteSessions, sessionRead, sessionsPrune, storageSummary, workspaceDelete, workspacesList } from './audit.js'

// Tests must NEVER touch the real VSCode workspaceStorage. Shadow the config
// import with a per-suite tmpdir.
const VSCODE_WORKSPACE_STORAGE_ROOT_PATH = path.join(os.tmpdir(), 'mcp-housekeeping-vscode-audit-tests')

const DAY_MS = 24 * 60 * 60 * 1000

const setMtime = async (p: string, when: Date) => {
  await fs.utimes(p, when, when)
}

const writeChatSession = async (workspace: string, filename: string, content: string, mtime: Date, workspaceUri?: string) => {
  const wsDir = path.join(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, workspace)
  const chatDir = path.join(wsDir, 'chatSessions')
  await fs.mkdir(chatDir, { recursive: true })
  if (workspaceUri) {
    await fs.writeFile(path.join(wsDir, 'workspace.json'), JSON.stringify({ workspace: workspaceUri }))
  }
  const file = path.join(chatDir, filename)
  await fs.writeFile(file, content)
  await setMtime(file, mtime)
  return file
}

beforeAll(async () => {
  await fs.mkdir(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, { recursive: true })
})

afterAll(async () => {
  await fs.rm(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, { recursive: true, force: true })
})

beforeEach(async () => {
  await fs.rm(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, { recursive: true, force: true })
  await fs.mkdir(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, { recursive: true })
})

describe('discoverWorkspaces (vscode)', () => {
  it('returns empty when storage root is empty', async () => {
    expect(await discoverWorkspaces(VSCODE_WORKSPACE_STORAGE_ROOT_PATH)).toEqual([])
  })

  it('returns empty when storage root does not exist', async () => {
    await fs.rm(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, { recursive: true, force: true })
    expect(await discoverWorkspaces(VSCODE_WORKSPACE_STORAGE_ROOT_PATH)).toEqual([])
  })

  it('skips workspaceStorage subdirs without chatSessions/', async () => {
    const wsDir = path.join(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, 'abc123')
    await fs.mkdir(wsDir, { recursive: true })
    await fs.writeFile(path.join(wsDir, 'state.vscdb'), '')
    expect(await discoverWorkspaces(VSCODE_WORKSPACE_STORAGE_ROOT_PATH)).toEqual([])
  })

  it('discovers workspaces and their session files + workspace.json uri', async () => {
    await writeChatSession('hex-1', 'a.json', '{}', new Date(), 'file:///Users/foo/proj-1')
    await writeChatSession('hex-1', 'b.jsonl', '{}\n', new Date())
    await writeChatSession('hex-2', 'c.jsonl', '{}\n', new Date())

    const r = await discoverWorkspaces(VSCODE_WORKSPACE_STORAGE_ROOT_PATH)
    expect(r.map((w) => w.id)).toEqual(['hex-1', 'hex-2'])
    expect(r[0]?.workspace_uri).toBe('file:///Users/foo/proj-1')
    expect(r[0]?.session_files).toHaveLength(2)
  })

  it('ignores non-.json(l) files in chatSessions', async () => {
    await writeChatSession('hex-x', 'a.json', '{}', new Date())
    await fs.writeFile(path.join(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, 'hex-x', 'chatSessions', 'notes.txt'), 'x')
    const r = await discoverWorkspaces(VSCODE_WORKSPACE_STORAGE_ROOT_PATH)
    expect(r[0]?.session_files).toEqual(['a.json'])
  })

  it('falls back to workspace.json `folder` when `workspace` is absent', async () => {
    const wsDir = path.join(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, 'hex-folder')
    const chatDir = path.join(wsDir, 'chatSessions')
    await fs.mkdir(chatDir, { recursive: true })
    await fs.writeFile(path.join(chatDir, 'a.jsonl'), '{}\n')
    await fs.writeFile(path.join(wsDir, 'workspace.json'), JSON.stringify({ folder: 'file:///Users/foo/single-folder' }))
    const r = await discoverWorkspaces(VSCODE_WORKSPACE_STORAGE_ROOT_PATH)
    expect(r[0]?.workspace_uri).toBe('file:///Users/foo/single-folder')
  })

  it('reports workspace_uri=null when workspace.json has neither workspace nor folder', async () => {
    const wsDir = path.join(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, 'hex-empty')
    const chatDir = path.join(wsDir, 'chatSessions')
    await fs.mkdir(chatDir, { recursive: true })
    await fs.writeFile(path.join(chatDir, 'a.jsonl'), '{}\n')
    await fs.writeFile(path.join(wsDir, 'workspace.json'), JSON.stringify({ something: 'else' }))
    const r = await discoverWorkspaces(VSCODE_WORKSPACE_STORAGE_ROOT_PATH)
    expect(r[0]?.workspace_uri).toBeNull()
  })
})

describe('workspacesList (vscode)', () => {
  it('returns sorted workspaces by bytes desc', async () => {
    await writeChatSession('small', 'a.json', '{}', new Date())
    await writeChatSession('big', 'a.jsonl', 'x'.repeat(8192), new Date())
    const r = await workspacesList(VSCODE_WORKSPACE_STORAGE_ROOT_PATH)
    expect(r.workspaces[0]?.id).toBe('big')
  })
})

describe('storageSummary (vscode) — flag branches', () => {
  it('flags total_chat_size_exceeds when bytes exceed the gb threshold', async () => {
    await writeChatSession('hex-1', 'a.jsonl', '{}\n', new Date())
    const r = await storageSummary(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, { flag_size_gb: 0, flag_session_count: 999 })
    expect(r.flags).toContain('total_chat_size_exceeds_0gb')
  })

  it('flags session_count_exceeds when count exceeds the threshold', async () => {
    await writeChatSession('hex-1', 'a.jsonl', '{}\n', new Date())
    await writeChatSession('hex-1', 'b.jsonl', '{}\n', new Date())
    const r = await storageSummary(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, { flag_size_gb: 999, flag_session_count: 0 })
    expect(r.flags).toContain('session_count_exceeds_0')
  })
})

describe('discoverWorkspaces extra branches (vscode)', () => {
  it('skips non-directory entries in the workspace storage root', async () => {
    await writeChatSession('hex-real', 'a.jsonl', '{}\n', new Date())
    await fs.writeFile(path.join(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, 'stray.txt'), 'not a workspace dir')
    const r = await discoverWorkspaces(VSCODE_WORKSPACE_STORAGE_ROOT_PATH)
    expect(r.map((w) => w.id)).toEqual(['hex-real'])
  })

  it('skips workspace dirs whose chatSessions readdir returns ENOENT (caught silently)', async () => {
    // pathExists returns true (we mkdir chatSessions), then we rm it just
    // before the inner readdir — testing race-condition-like ENOENT swallowing
    // is hard, so cover the catch's ENOENT branch by removing chatSessions
    // between pathExists and readdir is not portable. Instead: simulate via
    // a symlinked chatSessions that resolves to a non-existent target.
    const wsDir = path.join(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, 'hex-broken-link')
    await fs.mkdir(wsDir, { recursive: true })
    await fs.symlink('/tmp/__definitely_does_not_exist_for_vscode_test__', path.join(wsDir, 'chatSessions'))
    // pathExists returns false for broken symlink → the workspace is skipped entirely.
    const r = await discoverWorkspaces(VSCODE_WORKSPACE_STORAGE_ROOT_PATH)
    expect(r.map((w) => w.id)).not.toContain('hex-broken-link')
  })
})

describe('storageSummary (vscode)', () => {
  it('aggregates counts + flags', async () => {
    await writeChatSession('hex-1', 'a.json', '{}', new Date())
    await writeChatSession('hex-1', 'b.jsonl', '{}\n', new Date())
    const r = await storageSummary(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, { flag_size_gb: 100, flag_session_count: 1 })
    expect(r.session_count).toBe(2)
    expect(r.flags).toContain('session_count_exceeds_1')
  })
})

describe('obsoleteSessions (vscode) — flag branches', () => {
  it('flags obsolete_count_exceeds when count is over threshold', async () => {
    const oldDate = new Date(Date.now() - 90 * DAY_MS)
    await writeChatSession('hex-1', 'a.jsonl', '{}\n', oldDate)
    const r = await obsoleteSessions(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, { older_than_days: 60, flag_count: 0, flag_size_mb: 999 })
    expect(r.flags).toContain('obsolete_count_exceeds_0')
  })

  it('flags obsolete_size_exceeds when bytes are over threshold', async () => {
    const oldDate = new Date(Date.now() - 90 * DAY_MS)
    await writeChatSession('hex-1', 'a.jsonl', 'x'.repeat(2048), oldDate)
    const r = await obsoleteSessions(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, { older_than_days: 60, flag_count: 999, flag_size_mb: 0 })
    expect(r.flags).toContain('obsolete_size_exceeds_0mb')
  })
})

describe('obsoleteSessions (vscode) sort callback', () => {
  it('sorts multiple obsolete sessions ascending by mtime', async () => {
    const older = new Date(Date.now() - 90 * DAY_MS)
    const newer = new Date(Date.now() - 65 * DAY_MS)
    await writeChatSession('hex-1', 'older.jsonl', '{}\n', older)
    await writeChatSession('hex-1', 'newer.jsonl', '{}\n', newer)
    const r = await obsoleteSessions(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, { older_than_days: 60, flag_count: 999, flag_size_mb: 999 })
    expect(r.top_10_oldest[0]?.session).toBe('older.jsonl')
    expect(r.top_10_oldest[1]?.session).toBe('newer.jsonl')
  })
})

describe('obsoleteSessions (vscode)', () => {
  it('returns sessions older than the cutoff', async () => {
    const oldDate = new Date(Date.now() - 45 * DAY_MS)
    const recent = new Date()
    await writeChatSession('hex-1', 'old.jsonl', '{}\n', oldDate)
    await writeChatSession('hex-1', 'new.jsonl', '{}\n', recent)
    const r = await obsoleteSessions(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, { older_than_days: 30, flag_count: 100, flag_size_mb: 100 })
    expect(r.obsolete_count).toBe(1)
    expect(r.top_10_oldest[0]?.session).toBe('old.jsonl')
  })

  it('honours the workspace filter', async () => {
    const oldDate = new Date(Date.now() - 45 * DAY_MS)
    await writeChatSession('hex-1', 'a.jsonl', '{}\n', oldDate)
    await writeChatSession('hex-2', 'b.jsonl', '{}\n', oldDate)
    const r = await obsoleteSessions(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, { older_than_days: 30, flag_count: 100, flag_size_mb: 100, workspace: 'hex-1' })
    expect(r.obsolete_count).toBe(1)
  })
})

describe('sessionRead (vscode)', () => {
  it('reads last N lines of a jsonl file', async () => {
    const content = ['{"i":0}', '{"i":1}', '{"i":2}', '{"i":3}'].join('\n')
    await writeChatSession('hex-1', 'a.jsonl', content, new Date())
    const r = await sessionRead(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, { workspace: 'hex-1', session: 'a.jsonl', max_lines: 2, tail: true })
    expect(r.format).toBe('jsonl')
    expect(r.lines).toEqual(['{"i":2}', '{"i":3}'])
  })

  it('pretty-prints a single .json document', async () => {
    await writeChatSession('hex-1', 'a.json', JSON.stringify({ a: 1, b: 2 }), new Date())
    const r = await sessionRead(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, { workspace: 'hex-1', session: 'a.json', max_lines: 100, tail: false })
    expect(r.format).toBe('json')
    expect(r.lines.join('\n')).toContain('"a": 1')
  })

  it('honours tail=true for a single .json document (returns the last N lines of the pretty-printed output)', async () => {
    // Pretty-printed will be 4 lines: '{', '  "a": 1,', '  "b": 2', '}'
    await writeChatSession('hex-1', 'a.json', JSON.stringify({ a: 1, b: 2 }), new Date())
    const r = await sessionRead(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, { workspace: 'hex-1', session: 'a.json', max_lines: 2, tail: true })
    expect(r.format).toBe('json')
    expect(r.lines).toEqual(['  "b": 2', '}'])
  })

  it('honours tail=false for a .jsonl session (returns the first N lines)', async () => {
    const content = ['{"i":0}', '{"i":1}', '{"i":2}', '{"i":3}'].join('\n')
    await writeChatSession('hex-1', 'a.jsonl', content, new Date())
    const r = await sessionRead(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, { workspace: 'hex-1', session: 'a.jsonl', max_lines: 2, tail: false })
    expect(r.format).toBe('jsonl')
    expect(r.lines).toEqual(['{"i":0}', '{"i":1}'])
  })

  it('rejects bad extension', async () => {
    await expect(sessionRead(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, { workspace: 'hex-1', session: 'a.txt', max_lines: 5, tail: true })).rejects.toThrow(/must end with/)
  })
})

describe('sessionsPrune (vscode)', () => {
  it('dry_run lists but does not delete', async () => {
    const oldDate = new Date(Date.now() - 90 * DAY_MS)
    await writeChatSession('hex-1', 'old.jsonl', '{}\n', oldDate)
    const r = await sessionsPrune(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, { older_than_days: 60, dry_run: true })
    expect(r.deleted_count).toBe(1)
    const stat = await fs.stat(path.join(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, 'hex-1', 'chatSessions', 'old.jsonl'))
    expect(stat.isFile()).toBe(true)
  })

  it('deletes old sessions for real', async () => {
    const oldDate = new Date(Date.now() - 90 * DAY_MS)
    await writeChatSession('hex-1', 'old.jsonl', '{}\n', oldDate)
    const r = await sessionsPrune(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, { older_than_days: 60, dry_run: false })
    expect(r.deleted_count).toBe(1)
    await expect(fs.access(path.join(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, 'hex-1', 'chatSessions', 'old.jsonl'))).rejects.toThrow()
  })

  it('leaves recent sessions alone', async () => {
    await writeChatSession('hex-1', 'recent.jsonl', '{}\n', new Date())
    const r = await sessionsPrune(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, { older_than_days: 60, dry_run: false })
    expect(r.deleted_count).toBe(0)
  })

  it('honours the workspace filter', async () => {
    const oldDate = new Date(Date.now() - 90 * DAY_MS)
    await writeChatSession('hex-keep', 'a.jsonl', '{}\n', oldDate)
    await writeChatSession('hex-target', 'b.jsonl', '{}\n', oldDate)
    const r = await sessionsPrune(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, { older_than_days: 60, workspace: 'hex-target', dry_run: false })
    expect(r.deleted_count).toBe(1)
    expect(r.deleted[0]?.workspace).toBe('hex-target')
    // Other workspace's session is still on disk.
    const kept = await fs.stat(path.join(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, 'hex-keep', 'chatSessions', 'a.jsonl'))
    expect(kept.isFile()).toBe(true)
  })
})

describe('workspaceDelete', () => {
  it('removes the entire workspaceStorage/<id>/ subtree', async () => {
    await writeChatSession('hex-1', 'a.jsonl', '{}\n', new Date(), 'file:///some/path')
    const r = await workspaceDelete(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, { workspace: 'hex-1', dry_run: false })
    expect(r.deleted).toBe(true)
    await expect(fs.access(path.join(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, 'hex-1'))).rejects.toThrow()
  })

  it('dry_run reports what would be deleted without removing', async () => {
    await writeChatSession('hex-1', 'a.jsonl', '{}\n', new Date())
    const r = await workspaceDelete(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, { workspace: 'hex-1', dry_run: true })
    expect(r.deleted).toBe(false)
    expect(r.bytes).toBeGreaterThan(0)
    const stat = await fs.stat(path.join(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, 'hex-1'))
    expect(stat.isDirectory()).toBe(true)
  })

  it('throws when the workspace does not exist', async () => {
    await expect(workspaceDelete(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, { workspace: 'nope', dry_run: false })).rejects.toThrow(/not found/)
  })

  it('rejects path-traversal attempts in the workspace id', async () => {
    // `..` segments resolve outside the root and are rejected with a Path-escape error.
    await expect(workspaceDelete(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, { workspace: '../escape', dry_run: false })).rejects.toThrow(/Path escapes root/)
    await expect(workspaceDelete(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, { workspace: '../../etc', dry_run: true })).rejects.toThrow(/Path escapes root/)
    // Absolute-style input is neutralized (leading "/" stripped → treated as relative-to-root),
    // so it lands inside the root and falls through to the not-found branch. Still safe — it
    // cannot delete files outside the storage root.
    await expect(workspaceDelete(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, { workspace: '/etc/passwd', dry_run: true })).rejects.toThrow(/not found/)
  })
})

describe('discoverWorkspaces error paths (vscode)', () => {
  it('rethrows top-level readdir errors that are not ENOENT (EACCES via chmod 0)', async () => {
    const blockedRoot = path.join(path.dirname(VSCODE_WORKSPACE_STORAGE_ROOT_PATH), 'vscode-blocked-storage')
    await fs.mkdir(blockedRoot, { recursive: true })
    await fs.chmod(blockedRoot, 0o000)
    try {
      await expect(discoverWorkspaces(blockedRoot)).rejects.toThrow(/EACCES|permission/i)
    } finally {
      await fs.chmod(blockedRoot, 0o755)
      await fs.rm(blockedRoot, { recursive: true, force: true })
    }
  })

  it('rethrows chatSessions readdir errors that are not ENOENT (EACCES via chmod 0)', async () => {
    const wsId = 'hex-blocked-chat'
    const chatDir = path.join(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, wsId, 'chatSessions')
    await fs.mkdir(chatDir, { recursive: true })
    await fs.writeFile(path.join(chatDir, 'a.jsonl'), '{}\n')
    await fs.chmod(chatDir, 0o000)
    try {
      await expect(discoverWorkspaces(VSCODE_WORKSPACE_STORAGE_ROOT_PATH)).rejects.toThrow(/EACCES|permission/i)
    } finally {
      await fs.chmod(chatDir, 0o755)
    }
  })
})
