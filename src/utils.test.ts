import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { daysAgo, duBytes, duEntries, errorResult, formatBytes, isNodeError, jsonResult, pathExists, readJsonIfExists, resolveWithinRoot } from './utils.js'

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

describe('errorResult / jsonResult', () => {
  it('errorResult returns the MCP error shape', () => {
    expect(errorResult('boom')).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'boom' }]
    })
  })

  it('jsonResult serialises a payload', () => {
    const r = jsonResult({ x: 1 })
    expect(JSON.parse(r.content[0].text)).toEqual({ x: 1 })
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
})
