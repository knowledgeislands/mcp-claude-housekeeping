import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ROOT_PATH } from './config.js'
import { memoryDelete, memoryIndexWrite, memoryList, memoryRead, memoryWrite } from './memory.js'

const SPACE_ID = 'test-space'
const SPACE_DIR = path.join(ROOT_PATH, 'spaces', SPACE_ID)
const MEMORY_DIR = path.join(SPACE_DIR, 'memory')

beforeAll(async () => {
  await fs.mkdir(MEMORY_DIR, { recursive: true })
})

afterAll(async () => {
  await fs.rm(ROOT_PATH, { recursive: true, force: true })
})

beforeEach(async () => {
  // Wipe just this space's memory dir between tests for isolation
  await fs.rm(MEMORY_DIR, { recursive: true, force: true })
  await fs.mkdir(MEMORY_DIR, { recursive: true })
})

describe('memoryWrite + memoryRead', () => {
  it('writes a memory file and reads it back', async () => {
    const writeRes = await memoryWrite({ space_id: SPACE_ID, name: 'feedback_test.md', content: '# hello' })
    expect(writeRes.bytes).toBe(7)

    const readRes = await memoryRead({ space_id: SPACE_ID, name: 'feedback_test.md' })
    expect(readRes.content).toBe('# hello')
  })

  it('overwrites an existing file', async () => {
    await memoryWrite({ space_id: SPACE_ID, name: 'over.md', content: 'first' })
    await memoryWrite({ space_id: SPACE_ID, name: 'over.md', content: 'second' })
    const r = await memoryRead({ space_id: SPACE_ID, name: 'over.md' })
    expect(r.content).toBe('second')
  })

  it('rejects names without .md extension', async () => {
    await expect(memoryWrite({ space_id: SPACE_ID, name: 'bad', content: 'x' })).rejects.toThrow(/must end with .md/)
  })

  it('rejects path traversal in the name', async () => {
    await expect(memoryWrite({ space_id: SPACE_ID, name: '../escape.md', content: 'x' })).rejects.toThrow(/Path escapes root/)
  })

  it('rejects path traversal in the space_id', async () => {
    await expect(memoryWrite({ space_id: '../other', name: 'a.md', content: 'x' })).rejects.toThrow(/Path escapes root/)
  })
})

describe('memoryRead error paths', () => {
  it('throws when the file does not exist', async () => {
    await expect(memoryRead({ space_id: SPACE_ID, name: 'missing.md' })).rejects.toThrow(/Memory file not found/)
  })
})

describe('memoryDelete', () => {
  it('deletes an existing memory file', async () => {
    await memoryWrite({ space_id: SPACE_ID, name: 'tmp.md', content: 'x' })
    const result = await memoryDelete({ space_id: SPACE_ID, name: 'tmp.md' })
    expect(result.deleted).toBe(true)
    await expect(memoryRead({ space_id: SPACE_ID, name: 'tmp.md' })).rejects.toThrow(/Memory file not found/)
  })

  it('refuses to delete MEMORY.md', async () => {
    await expect(memoryDelete({ space_id: SPACE_ID, name: 'MEMORY.md' })).rejects.toThrow(/Cannot delete MEMORY.md/)
  })

  it('throws on a missing file', async () => {
    await expect(memoryDelete({ space_id: SPACE_ID, name: 'nope.md' })).rejects.toThrow(/Memory file not found/)
  })
})

describe('memoryList', () => {
  it('throws when the memory dir does not exist for the space', async () => {
    await expect(memoryList({ space_id: 'never-created' })).rejects.toThrow(/Memory directory not found/)
  })

  it('lists .md files alphabetically with size + modified', async () => {
    await memoryWrite({ space_id: SPACE_ID, name: 'b.md', content: 'b' })
    await memoryWrite({ space_id: SPACE_ID, name: 'a.md', content: 'a' })
    const r = await memoryList({ space_id: SPACE_ID })
    expect(r.files.map((f) => f.name)).toEqual(['a.md', 'b.md'])
    expect(r.file_count).toBe(2)
    expect(r.index).toBeNull()
  })

  it('returns the MEMORY.md content as the index when present', async () => {
    await memoryIndexWrite({ space_id: SPACE_ID, content: '- [Test](test.md) — entry' })
    const r = await memoryList({ space_id: SPACE_ID })
    expect(r.index).toBe('- [Test](test.md) — entry')
  })

  it('skips non-.md entries', async () => {
    await memoryWrite({ space_id: SPACE_ID, name: 'a.md', content: 'a' })
    await fs.writeFile(path.join(MEMORY_DIR, 'note.txt'), 'ignored')
    const r = await memoryList({ space_id: SPACE_ID })
    expect(r.files.map((f) => f.name)).toEqual(['a.md'])
  })
})

describe('memoryIndexWrite', () => {
  it('writes MEMORY.md', async () => {
    const r = await memoryIndexWrite({ space_id: SPACE_ID, content: 'index content' })
    expect(r.bytes).toBe('index content'.length)
    const onDisk = await fs.readFile(path.join(MEMORY_DIR, 'MEMORY.md'), 'utf-8')
    expect(onDisk).toBe('index content')
  })

  it('overwrites existing MEMORY.md', async () => {
    await memoryIndexWrite({ space_id: SPACE_ID, content: 'first' })
    await memoryIndexWrite({ space_id: SPACE_ID, content: 'second' })
    const onDisk = await fs.readFile(path.join(MEMORY_DIR, 'MEMORY.md'), 'utf-8')
    expect(onDisk).toBe('second')
  })
})
