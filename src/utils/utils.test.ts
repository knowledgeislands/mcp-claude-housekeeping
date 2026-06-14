import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  assertRealPathWithinRoot,
  daysAgo,
  discoverWorkspaces,
  duBytes,
  duEntries,
  errorResult,
  formatBytes,
  isNodeError,
  jsonResult,
  pathExists,
  readJsonIfExists,
  resolveWithinRoot
} from './utils.js'

describe('resolveWithinRoot', () => {
  const root = '/tmp/local-root'

  it('resolves a relative path inside the root', () => {
    expect(resolveWithinRoot(root, 'a/b.json')).toBe('/tmp/local-root/a/b.json')
  })

  it('strips a leading slash', () => {
    expect(resolveWithinRoot(root, '/a.json')).toBe('/tmp/local-root/a.json')
  })

  it('rejects ..-based traversal', () => {
    expect(() => resolveWithinRoot(root, '../escape')).toThrow(/Path escapes root/)
  })

  it('handles a root that already ends with /', () => {
    expect(resolveWithinRoot('/tmp/local-root/', 'a.json')).toBe('/tmp/local-root/a.json')
  })
})

describe('assertRealPathWithinRoot', () => {
  const tmpRoot = path.join(os.tmpdir(), 'housekeeping-utils-tests', `run-${process.pid}`)

  beforeAll(async () => {
    await fs.mkdir(tmpRoot, { recursive: true })
    await fs.mkdir(path.join(tmpRoot, 'inner'), { recursive: true })
    await fs.writeFile(path.join(tmpRoot, 'inner', 'leaf.md'), 'x', 'utf-8')
    await fs.mkdir(path.join(tmpRoot, '..', 'outside'), { recursive: true })
    await fs.writeFile(path.join(tmpRoot, '..', 'outside', 'secret.md'), 's', 'utf-8')
    try {
      await fs.symlink(path.join(tmpRoot, '..', 'outside'), path.join(tmpRoot, 'link-outside'))
    } catch {
      // already exists from a previous run
    }
  })

  afterAll(async () => {
    await fs.rm(path.join(tmpRoot, '..', 'outside'), { recursive: true, force: true })
    await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  it('accepts a path inside the root', async () => {
    await expect(assertRealPathWithinRoot(tmpRoot, path.join(tmpRoot, 'inner', 'leaf.md'))).resolves.toBeUndefined()
  })

  it('walks up to find the nearest existing ancestor for a yet-to-exist path', async () => {
    const futurePath = path.join(tmpRoot, 'inner', 'does-not-exist-yet', 'sub', 'new.md')
    await expect(assertRealPathWithinRoot(tmpRoot, futurePath)).resolves.toBeUndefined()
  })

  it('rejects a symlink that escapes the root', async () => {
    const escapingPath = path.join(tmpRoot, 'link-outside', 'secret.md')
    await expect(assertRealPathWithinRoot(tmpRoot, escapingPath)).rejects.toThrow(/Path escapes root/)
  })

  it('accepts the root itself', async () => {
    await expect(assertRealPathWithinRoot(tmpRoot, tmpRoot)).resolves.toBeUndefined()
  })
})

describe('errorResult / jsonResult', () => {
  it('errorResult returns the MCP error shape with action prefix', () => {
    expect(errorResult('doing the thing', new Error('boom'))).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'Error doing the thing: boom' }]
    })
  })

  it('errorResult stringifies non-Error values', () => {
    expect(errorResult('doing the thing', 'plain string')).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'Error doing the thing: plain string' }]
    })
  })

  it('jsonResult serialises a payload', () => {
    const r = jsonResult({ x: 1 })
    expect(JSON.parse(r.content[0]?.text ?? '')).toEqual({ x: 1 })
  })
})

describe('isNodeError', () => {
  it('detects ENOENT-style errors', () => {
    const err = Object.assign(new Error('not found'), { code: 'ENOENT' })
    expect(isNodeError(err)).toBe(true)
  })

  it('rejects plain errors and non-errors', () => {
    expect(isNodeError(new Error('plain'))).toBe(false)
    expect(isNodeError('string')).toBe(false)
    expect(isNodeError(null)).toBe(false)
  })
})

describe('formatBytes', () => {
  it('formats bytes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
  })

  it('formats kilobytes', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
  })

  it('formats megabytes', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
  })

  it('formats gigabytes', () => {
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2.00 GB')
  })
})

describe('daysAgo', () => {
  it('returns 0 for now', () => {
    expect(daysAgo(Date.now())).toBe(0)
  })

  it('returns a positive integer for past dates', () => {
    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000
    expect(daysAgo(tenDaysAgo)).toBe(10)
  })

  it('accepts Date objects', () => {
    const d = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
    expect(daysAgo(d)).toBe(5)
  })
})

describe('duBytes / duEntries / pathExists / readJsonIfExists', () => {
  let tmpRoot: string

  beforeAll(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'utils-test-'))
    await fs.writeFile(path.join(tmpRoot, 'small.txt'), 'a'.repeat(100))
    await fs.mkdir(path.join(tmpRoot, 'sub'))
    // Write enough content to spill across multiple disk blocks so `du -sk`
    // reports a measurably larger size than the small file.
    await fs.writeFile(path.join(tmpRoot, 'sub', 'inner.txt'), 'b'.repeat(64 * 1024))
    await fs.writeFile(path.join(tmpRoot, 'data.json'), JSON.stringify({ hello: 'world' }))
  })

  afterAll(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  it('duBytes returns a positive byte count for a real directory', async () => {
    const bytes = await duBytes(tmpRoot)
    expect(bytes).toBeGreaterThan(0)
  })

  it('duBytes returns 0 for a missing path', async () => {
    expect(await duBytes(path.join(tmpRoot, 'does-not-exist'))).toBe(0)
  })

  it('duEntries lists direct children sorted by size descending', async () => {
    const entries = await duEntries(tmpRoot)
    expect(entries.map((e) => e.name)).toContain('sub')
    expect(entries.map((e) => e.name)).toContain('small.txt')
    // sub should be larger than small.txt
    const sub = entries.find((e) => e.name === 'sub')
    const small = entries.find((e) => e.name === 'small.txt')
    expect(sub?.bytes).toBeGreaterThan(small?.bytes ?? Number.MAX_SAFE_INTEGER)
  })

  it('duEntries returns empty array for a missing dir', async () => {
    expect(await duEntries(path.join(tmpRoot, 'missing'))).toEqual([])
  })

  it('duEntries includes hidden entries when includeHidden is true', async () => {
    const hiddenRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'utils-hidden-'))
    try {
      await fs.writeFile(path.join(hiddenRoot, '.hidden'), 'x')
      await fs.writeFile(path.join(hiddenRoot, 'visible'), 'x')
      const withHidden = await duEntries(hiddenRoot, true)
      expect(withHidden.map((e) => e.name).sort()).toEqual(['.hidden', 'visible'])
      const withoutHidden = await duEntries(hiddenRoot)
      expect(withoutHidden.map((e) => e.name)).toEqual(['visible'])
    } finally {
      await fs.rm(hiddenRoot, { recursive: true, force: true })
    }
  })

  it('duBytes rejects with a timeout error when du outlives the time bound', async () => {
    // Build a tree with enough entries that `du` cannot finish within a 1ms
    // bound; Node sends SIGKILL and runDuSk rejects with a timeout message.
    const bigRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'utils-dutimeout-'))
    try {
      for (let i = 0; i < 200; i++) {
        const sub = path.join(bigRoot, `d${i}`)
        await fs.mkdir(sub, { recursive: true })
        await fs.writeFile(path.join(sub, 'f.txt'), 'x'.repeat(512))
      }
      await expect(duBytes(bigRoot, 1)).rejects.toThrow(/du timed out after 1ms/)
    } finally {
      await fs.rm(bigRoot, { recursive: true, force: true })
    }
  })

  it('pathExists returns true for an existing path, false otherwise', async () => {
    expect(await pathExists(tmpRoot)).toBe(true)
    expect(await pathExists(path.join(tmpRoot, 'nope'))).toBe(false)
  })

  it('readJsonIfExists parses a JSON file', async () => {
    const content = await readJsonIfExists<{ hello: string }>(path.join(tmpRoot, 'data.json'))
    expect(content).toEqual({ hello: 'world' })
  })

  it('readJsonIfExists returns null for a missing file', async () => {
    expect(await readJsonIfExists(path.join(tmpRoot, 'missing.json'))).toBeNull()
  })

  it('readJsonIfExists rethrows non-ENOENT errors (e.g. EISDIR)', async () => {
    // Pass a directory to readFile — produces EISDIR, which is not ENOENT
    // and so should propagate rather than be swallowed.
    await expect(readJsonIfExists(tmpRoot)).rejects.toThrow()
  })

  it('duEntries rethrows non-ENOENT readdir errors (e.g. ENOTDIR)', async () => {
    // Pointing duEntries at a regular file produces ENOTDIR, which is not
    // ENOENT and so should propagate.
    await expect(duEntries(path.join(tmpRoot, 'small.txt'))).rejects.toThrow()
  })

  it('duBytes returns 0 for a missing path even when du writes to stderr', async () => {
    // Sanity-check the "No such file" stderr branch — same observable
    // behaviour as the missing-path test above, but exercises the stderr
    // reader rather than just the close handler.
    const missing = path.join(tmpRoot, 'definitely', 'not', 'here')
    expect(await duBytes(missing)).toBe(0)
  })
})

describe('discoverWorkspaces', () => {
  let root: string

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'workspaces-test-'))
  })

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('returns an empty list when nothing is present', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'workspaces-empty-'))
    try {
      expect(await discoverWorkspaces(empty)).toEqual([])
    } finally {
      await fs.rm(empty, { recursive: true, force: true })
    }
  })

  it('returns an empty list when the root does not exist', async () => {
    expect(await discoverWorkspaces(path.join(root, 'never-created'))).toEqual([])
  })

  it('treats the root itself as a single workspace when it contains marker files', async () => {
    const single = await fs.mkdtemp(path.join(os.tmpdir(), 'workspaces-single-'))
    try {
      await fs.writeFile(path.join(single, '.claude.json'), '{}')
      const ws = await discoverWorkspaces(single)
      expect(ws).toHaveLength(1)
      expect(ws[0]?.id).toBe('.')
      expect(ws[0]?.root).toBe(single)
    } finally {
      await fs.rm(single, { recursive: true, force: true })
    }
  })

  it('discovers multiple <account>/<workspace> dirs and skips non-workspace siblings', async () => {
    const accountA = path.join(root, 'account-a')
    const accountB = path.join(root, 'account-b')
    const workspaceA1 = path.join(accountA, 'ws-1')
    const workspaceA2 = path.join(accountA, 'ws-2')
    const workspaceB1 = path.join(accountB, 'ws-3')
    await fs.mkdir(workspaceA1, { recursive: true })
    await fs.mkdir(workspaceA2, { recursive: true })
    await fs.mkdir(workspaceB1, { recursive: true })
    await fs.writeFile(path.join(workspaceA1, 'artifacts.json'), '[]')
    await fs.writeFile(path.join(workspaceA2, 'local_abc.json'), '{}')
    await fs.writeFile(path.join(workspaceB1, '.claude.json'), '{}')

    // skills-plugin/<x>/<y>/ has only plugin.json — should be ignored
    const plugin = path.join(root, 'skills-plugin', 'plugin-uuid', 'version-uuid')
    await fs.mkdir(plugin, { recursive: true })
    await fs.writeFile(path.join(plugin, 'plugin.json'), '{}')

    // A loose file at root (not a directory) — exercises the !isDirectory()
    // skip branch at level 1.
    await fs.writeFile(path.join(root, 'loose-file.txt'), 'not an account', 'utf-8')
    // A loose file inside an account dir — exercises the !isDirectory() skip
    // branch at level 2.
    await fs.writeFile(path.join(accountA, 'loose-inner.txt'), 'not a workspace', 'utf-8')

    const ws = await discoverWorkspaces(root)
    expect(ws.map((w) => w.id)).toEqual(['account-a/ws-1', 'account-a/ws-2', 'account-b/ws-3'])
    expect(ws[0]?.root).toBe(workspaceA1)
  })
})

describe('discoverWorkspaces / isWorkspaceDir error propagation', () => {
  // chmod 0 on a directory provokes EACCES on readdir; passing a regular
  // file as `root` provokes ENOTDIR. Both exercise rethrow branches.
  const tmpBase = path.join(os.tmpdir(), 'discover-ws-perm', `run-${process.pid}-${Date.now()}`)

  beforeAll(async () => {
    await fs.mkdir(tmpBase, { recursive: true })
  })

  afterAll(async () => {
    try {
      await fs.chmod(tmpBase, 0o755)
      for (const entry of await fs.readdir(tmpBase)) {
        try {
          await fs.chmod(path.join(tmpBase, entry), 0o755)
        } catch {
          // best-effort
        }
      }
    } catch {
      // best-effort
    }
    await fs.rm(tmpBase, { recursive: true, force: true })
  })

  it('discoverWorkspaces rethrows isWorkspaceDir readdir errors that are not ENOENT/ENOTDIR (EACCES on root)', async () => {
    const root = path.join(tmpBase, 'isws-root-eacces')
    await fs.mkdir(root, { recursive: true })
    await fs.chmod(root, 0o000)
    try {
      await expect(discoverWorkspaces(root)).rejects.toThrow(/EACCES|permission/i)
    } finally {
      await fs.chmod(root, 0o755)
    }
  })

  it('discoverWorkspaces rethrows top-level readdir errors that are not ENOENT (ENOTDIR when root is a file)', async () => {
    const fakeRoot = path.join(tmpBase, 'a-regular-file')
    await fs.writeFile(fakeRoot, 'i am a file, not a directory', 'utf-8')
    // isWorkspaceDir(file): pathExists checks return false (since file/marker
    // doesn't exist), readdir(file) throws ENOTDIR → handled, returns false.
    // Top-level readdir(file) throws ENOTDIR → not ENOENT → rethrows.
    await expect(discoverWorkspaces(fakeRoot)).rejects.toThrow(/ENOTDIR|not a directory/i)
  })

  it('discoverWorkspaces skips an account dir when its readdir fails with EACCES', async () => {
    const root = path.join(tmpBase, 'eacces-account')
    const blocked = path.join(root, 'account-blocked')
    const okAccount = path.join(root, 'account-ok')
    const okWorkspace = path.join(okAccount, 'ws-1')
    await fs.mkdir(blocked, { recursive: true })
    await fs.mkdir(okWorkspace, { recursive: true })
    await fs.writeFile(path.join(okWorkspace, '.claude.json'), '{}')
    await fs.chmod(blocked, 0o000)
    try {
      const ws = await discoverWorkspaces(root)
      expect(ws.map((w) => w.id)).toEqual(['account-ok/ws-1'])
    } finally {
      await fs.chmod(blocked, 0o755)
    }
  })
})

describe('duBytes error path', () => {
  const tmpBase = path.join(os.tmpdir(), 'du-error', `run-${process.pid}-${Date.now()}`)

  beforeAll(async () => {
    await fs.mkdir(tmpBase, { recursive: true })
  })

  afterAll(async () => {
    try {
      await fs.chmod(tmpBase, 0o755)
      for (const entry of await fs.readdir(tmpBase)) {
        try {
          await fs.chmod(path.join(tmpBase, entry), 0o755)
        } catch {
          // best-effort
        }
      }
    } catch {
      // best-effort
    }
    await fs.rm(tmpBase, { recursive: true, force: true })
  })

  it('rejects with the stderr message when `du` exits non-zero and stderr is not a "No such file" error', async () => {
    // chmod 0 on a subdir, then point du at that subdir — du exits non-zero
    // with "Permission denied" on stderr, which is not "No such file", so
    // duBytes' runDuSk rejects with `du failed (...)`.
    const blocked = path.join(tmpBase, 'blocked')
    await fs.mkdir(blocked, { recursive: true })
    await fs.writeFile(path.join(blocked, 'file.txt'), 'x', 'utf-8')
    await fs.chmod(blocked, 0o000)
    try {
      await expect(duBytes(path.join(blocked, 'file.txt'))).rejects.toThrow(/du failed/)
    } finally {
      await fs.chmod(blocked, 0o755)
    }
  })
})
