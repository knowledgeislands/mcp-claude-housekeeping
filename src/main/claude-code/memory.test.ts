import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { memoryDelete, memoryIndexWrite, memoryList, memoryRead, memoryWrite } from './memory.js'

// Tests must NEVER touch the real ~/.claude/. Shadow the config import with a
// per-suite tmpdir.
const CLAUDE_CODE_ROOT_PATH = path.join(os.tmpdir(), 'mcp-housekeeping-claude-code-memory-tests')

const PROJECT = '-Users-foo-mem'
const PROJECT_DIR = path.join(CLAUDE_CODE_ROOT_PATH, 'projects', PROJECT)
const MEMORY_DIR = path.join(PROJECT_DIR, 'memory')

beforeAll(async () => {
  await fs.mkdir(MEMORY_DIR, { recursive: true })
})

afterAll(async () => {
  await fs.rm(CLAUDE_CODE_ROOT_PATH, { recursive: true, force: true })
})

beforeEach(async () => {
  await fs.rm(MEMORY_DIR, { recursive: true, force: true })
  await fs.mkdir(MEMORY_DIR, { recursive: true })
})

describe('claude-code memoryWrite + memoryRead', () => {
  it('writes a memory file and reads it back', async () => {
    const w = await memoryWrite(CLAUDE_CODE_ROOT_PATH, { project: PROJECT, name: 'feedback.md', content: '# hi' })
    expect(w.bytes).toBe(4)
    const r = await memoryRead(CLAUDE_CODE_ROOT_PATH, { project: PROJECT, name: 'feedback.md' })
    expect(r.content).toBe('# hi')
  })

  it('rejects non-.md names', async () => {
    await expect(memoryWrite(CLAUDE_CODE_ROOT_PATH, { project: PROJECT, name: 'bad', content: 'x' })).rejects.toThrow(/must end with .md/)
  })

  it('rejects path traversal in name', async () => {
    await expect(memoryWrite(CLAUDE_CODE_ROOT_PATH, { project: PROJECT, name: '../escape.md', content: 'x' })).rejects.toThrow(
      /Path escapes root/
    )
  })

  it('rejects path traversal in project', async () => {
    await expect(memoryWrite(CLAUDE_CODE_ROOT_PATH, { project: '../other', name: 'a.md', content: 'x' })).rejects.toThrow(
      /Path escapes root/
    )
  })
})

describe('claude-code memoryDelete', () => {
  it('deletes an existing file when dry_run is false', async () => {
    await memoryWrite(CLAUDE_CODE_ROOT_PATH, { project: PROJECT, name: 'tmp.md', content: 'x' })
    const r = await memoryDelete(CLAUDE_CODE_ROOT_PATH, { project: PROJECT, name: 'tmp.md', dry_run: false })
    expect(r).toMatchObject({ deleted: true, dry_run: false, bytes: 1 })
    await expect(memoryRead(CLAUDE_CODE_ROOT_PATH, { project: PROJECT, name: 'tmp.md' })).rejects.toThrow(/not found/)
  })

  it('previews without deleting when dry_run is true', async () => {
    await memoryWrite(CLAUDE_CODE_ROOT_PATH, { project: PROJECT, name: 'keep.md', content: 'abc' })
    const r = await memoryDelete(CLAUDE_CODE_ROOT_PATH, { project: PROJECT, name: 'keep.md', dry_run: true })
    expect(r).toMatchObject({ deleted: false, dry_run: true, bytes: 3 })
    // File must still be readable — preview only.
    const back = await memoryRead(CLAUDE_CODE_ROOT_PATH, { project: PROJECT, name: 'keep.md' })
    expect(back.content).toBe('abc')
  })

  it('refuses to delete MEMORY.md', async () => {
    await expect(memoryDelete(CLAUDE_CODE_ROOT_PATH, { project: PROJECT, name: 'MEMORY.md', dry_run: false })).rejects.toThrow(
      /Cannot delete MEMORY.md/
    )
  })

  it('throws on missing file', async () => {
    await expect(memoryDelete(CLAUDE_CODE_ROOT_PATH, { project: PROJECT, name: 'nope.md', dry_run: false })).rejects.toThrow(/not found/)
  })
})

describe('claude-code memoryList', () => {
  it('throws when memory dir does not exist', async () => {
    await expect(memoryList(CLAUDE_CODE_ROOT_PATH, { project: 'never-created' })).rejects.toThrow(/Memory directory not found/)
  })

  it('lists .md files alphabetically + returns MEMORY.md index', async () => {
    await memoryWrite(CLAUDE_CODE_ROOT_PATH, { project: PROJECT, name: 'b.md', content: 'b' })
    await memoryWrite(CLAUDE_CODE_ROOT_PATH, { project: PROJECT, name: 'a.md', content: 'a' })
    await memoryIndexWrite(CLAUDE_CODE_ROOT_PATH, { project: PROJECT, content: '- [a](a.md)' })
    const r = await memoryList(CLAUDE_CODE_ROOT_PATH, { project: PROJECT })
    expect(r.files.map((f) => f.name)).toEqual(['MEMORY.md', 'a.md', 'b.md'])
    expect(r.index).toBe('- [a](a.md)')
  })

  it('sorts MEMORY.md to the top regardless of where it appears in readdir order', async () => {
    // Write enough files that the sort comparator visits both directions of
    // the "a is MEMORY.md" / "b is MEMORY.md" branches.
    await memoryWrite(CLAUDE_CODE_ROOT_PATH, { project: PROJECT, name: 'c.md', content: 'c' })
    await memoryWrite(CLAUDE_CODE_ROOT_PATH, { project: PROJECT, name: 'd.md', content: 'd' })
    await memoryWrite(CLAUDE_CODE_ROOT_PATH, { project: PROJECT, name: 'a.md', content: 'a' })
    await memoryIndexWrite(CLAUDE_CODE_ROOT_PATH, { project: PROJECT, content: 'idx' })
    await memoryWrite(CLAUDE_CODE_ROOT_PATH, { project: PROJECT, name: 'b.md', content: 'b' })
    const r = await memoryList(CLAUDE_CODE_ROOT_PATH, { project: PROJECT })
    expect(r.files.map((f) => f.name)).toEqual(['MEMORY.md', 'a.md', 'b.md', 'c.md', 'd.md'])
  })

  it('skips non-.md files and subdirectories, returns null index when MEMORY.md is absent', async () => {
    // .md file (kept)
    await memoryWrite(CLAUDE_CODE_ROOT_PATH, { project: PROJECT, name: 'kept.md', content: 'k' })
    // non-.md file (filtered by `!e.name.endsWith('.md')`)
    await fs.writeFile(path.join(MEMORY_DIR, 'note.txt'), 'ignored')
    // subdirectory (filtered by `!e.isFile()`)
    await fs.mkdir(path.join(MEMORY_DIR, 'subdir'), { recursive: true })
    const r = await memoryList(CLAUDE_CODE_ROOT_PATH, { project: PROJECT })
    expect(r.files.map((f) => f.name)).toEqual(['kept.md'])
    expect(r.index).toBeNull()
  })
})

describe('claude-code memoryIndexWrite', () => {
  it('writes MEMORY.md and overwrites', async () => {
    await memoryIndexWrite(CLAUDE_CODE_ROOT_PATH, { project: PROJECT, content: 'first' })
    await memoryIndexWrite(CLAUDE_CODE_ROOT_PATH, { project: PROJECT, content: 'second' })
    const onDisk = await fs.readFile(path.join(MEMORY_DIR, 'MEMORY.md'), 'utf-8')
    expect(onDisk).toBe('second')
  })
})

describe('claude-code memory error-path rethrows (non-ENOENT)', () => {
  it('memoryList rethrows readdir errors other than ENOENT (EACCES via chmod 0)', async () => {
    const blockedProject = '-Users-foo-blocked'
    const blockedDir = path.join(CLAUDE_CODE_ROOT_PATH, 'projects', blockedProject, 'memory')
    await fs.mkdir(blockedDir, { recursive: true })
    await fs.chmod(blockedDir, 0o000)
    try {
      await expect(memoryList(CLAUDE_CODE_ROOT_PATH, { project: blockedProject })).rejects.toThrow(/EACCES|permission/i)
    } finally {
      await fs.chmod(blockedDir, 0o755)
      await fs.rm(path.dirname(blockedDir), { recursive: true, force: true })
    }
  })

  it('memoryRead rethrows readFile errors other than ENOENT (EISDIR when target is a directory)', async () => {
    // Create a *directory* named feedback.md — reading it as a file gives EISDIR.
    await fs.mkdir(path.join(MEMORY_DIR, 'feedback.md'), { recursive: true })
    await expect(memoryRead(CLAUDE_CODE_ROOT_PATH, { project: PROJECT, name: 'feedback.md' })).rejects.toThrow(/EISDIR|is a directory/i)
  })

  it('memoryDelete rethrows unlink errors other than ENOENT (EISDIR when target is a directory)', async () => {
    // Create a *directory* named gone.md — unlink on a directory gives EPERM or EISDIR.
    await fs.mkdir(path.join(MEMORY_DIR, 'gone.md'), { recursive: true })
    await expect(memoryDelete(CLAUDE_CODE_ROOT_PATH, { project: PROJECT, name: 'gone.md', dry_run: false })).rejects.toThrow(
      /EISDIR|EPERM|is a directory|operation not permitted/i
    )
  })

  it('memoryDelete rethrows stat errors other than ENOENT (EACCES via chmod 0 on the parent dir)', async () => {
    const blockedProject = '-Users-foo-del-blocked'
    const blockedDir = path.join(CLAUDE_CODE_ROOT_PATH, 'projects', blockedProject, 'memory')
    await fs.mkdir(blockedDir, { recursive: true })
    await fs.writeFile(path.join(blockedDir, 'locked.md'), 'x')
    await fs.chmod(blockedDir, 0o000)
    try {
      await expect(memoryDelete(CLAUDE_CODE_ROOT_PATH, { project: blockedProject, name: 'locked.md', dry_run: true })).rejects.toThrow(
        /EACCES|permission/i
      )
    } finally {
      await fs.chmod(blockedDir, 0o755)
      await fs.rm(path.dirname(blockedDir), { recursive: true, force: true })
    }
  })
})
