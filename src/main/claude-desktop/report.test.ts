import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { reportClean, reportList, reportWrite } from './report.js'

const HOUSEKEEPING_PATH = path.join(os.tmpdir(), 'mcp-housekeeping-report-tests')

beforeAll(async () => {
  await fs.mkdir(HOUSEKEEPING_PATH, { recursive: true })
})

afterAll(async () => {
  await fs.rm(HOUSEKEEPING_PATH, { recursive: true, force: true })
})

beforeEach(async () => {
  await fs.rm(HOUSEKEEPING_PATH, { recursive: true, force: true })
  await fs.mkdir(HOUSEKEEPING_PATH, { recursive: true })
})

describe('reportList', () => {
  it('returns an empty array for an empty housekeeping dir', async () => {
    const r = await reportList(HOUSEKEEPING_PATH)
    expect(r.exists).toBe(true)
    expect(r.reports).toEqual([])
  })

  it('returns reports newest-first', async () => {
    await fs.writeFile(path.join(HOUSEKEEPING_PATH, 'cowork-audit-2026-01-01.md'), 'old')
    // Force later mtime on the second file
    await new Promise((r) => setTimeout(r, 10))
    await fs.writeFile(path.join(HOUSEKEEPING_PATH, 'cowork-audit-2026-02-01.md'), 'new')
    const r = await reportList(HOUSEKEEPING_PATH)
    expect(r.reports[0]?.name).toBe('cowork-audit-2026-02-01.md')
    expect(r.reports[1]?.name).toBe('cowork-audit-2026-01-01.md')
  })

  it('skips non-matching files', async () => {
    await fs.writeFile(path.join(HOUSEKEEPING_PATH, 'cowork-audit-2026-03-01.md'), 'a')
    await fs.writeFile(path.join(HOUSEKEEPING_PATH, 'other.md'), 'ignored')
    const r = await reportList(HOUSEKEEPING_PATH)
    expect(r.reports.map((x) => x.name)).toEqual(['cowork-audit-2026-03-01.md'])
  })

  it('reports exists=false when the housekeeping dir does not exist', async () => {
    await fs.rm(HOUSEKEEPING_PATH, { recursive: true, force: true })
    const r = await reportList(HOUSEKEEPING_PATH)
    expect(r.exists).toBe(false)
    expect(r.reports).toEqual([])
  })

  it('rethrows non-ENOENT readdir errors (e.g. when housekeeping path is a regular file)', async () => {
    await fs.rm(HOUSEKEEPING_PATH, { recursive: true, force: true })
    await fs.writeFile(HOUSEKEEPING_PATH, 'not-a-dir')
    await expect(reportList(HOUSEKEEPING_PATH)).rejects.toThrow()
    // Restore for subsequent tests
    await fs.rm(HOUSEKEEPING_PATH, { force: true })
  })
})

describe('reportClean', () => {
  it('deletes only cowork-audit-*.md files', async () => {
    await fs.writeFile(path.join(HOUSEKEEPING_PATH, 'cowork-audit-2026-01-01.md'), 'a')
    await fs.writeFile(path.join(HOUSEKEEPING_PATH, 'cowork-audit-2026-02-01.md'), 'b')
    await fs.writeFile(path.join(HOUSEKEEPING_PATH, 'other.md'), 'keep')

    const r = await reportClean(HOUSEKEEPING_PATH, { dry_run: false })
    expect(r.deleted.sort()).toEqual(['cowork-audit-2026-01-01.md', 'cowork-audit-2026-02-01.md'])
    expect(r.dry_run).toBe(false)
    const remaining = await fs.readdir(HOUSEKEEPING_PATH)
    expect(remaining).toEqual(['other.md'])
  })

  it('dry_run lists the matching reports without deleting them', async () => {
    await fs.writeFile(path.join(HOUSEKEEPING_PATH, 'cowork-audit-2026-01-01.md'), 'a')
    await fs.writeFile(path.join(HOUSEKEEPING_PATH, 'cowork-audit-2026-02-01.md'), 'b')
    await fs.writeFile(path.join(HOUSEKEEPING_PATH, 'other.md'), 'keep')

    const r = await reportClean(HOUSEKEEPING_PATH, { dry_run: true })
    expect(r.deleted.sort()).toEqual(['cowork-audit-2026-01-01.md', 'cowork-audit-2026-02-01.md'])
    expect(r.dry_run).toBe(true)
    // Nothing actually removed.
    const remaining = (await fs.readdir(HOUSEKEEPING_PATH)).sort()
    expect(remaining).toEqual(['cowork-audit-2026-01-01.md', 'cowork-audit-2026-02-01.md', 'other.md'])
  })

  it('handles a missing housekeeping directory gracefully (and reports dry_run)', async () => {
    await fs.rm(HOUSEKEEPING_PATH, { recursive: true, force: true })
    const r = await reportClean(HOUSEKEEPING_PATH, { dry_run: true })
    expect(r.deleted).toEqual([])
    expect(r.dry_run).toBe(true)
    expect(r.note).toMatch(/does not yet exist/)
  })

  it('rethrows non-ENOENT readdir errors (e.g. when housekeeping path is a regular file)', async () => {
    await fs.rm(HOUSEKEEPING_PATH, { recursive: true, force: true })
    await fs.writeFile(HOUSEKEEPING_PATH, 'not-a-dir')
    await expect(reportClean(HOUSEKEEPING_PATH, { dry_run: false })).rejects.toThrow()
    await fs.rm(HOUSEKEEPING_PATH, { force: true })
  })
})

describe('reportWrite', () => {
  it('writes a report with a default (today) date', async () => {
    const r = await reportWrite(HOUSEKEEPING_PATH, { content: '# audit' })
    expect(r.filename).toMatch(/^cowork-audit-\d{4}-\d{2}-\d{2}\.md$/)
    expect(r.bytes).toBe(7)
    const onDisk = await fs.readFile(r.path, 'utf-8')
    expect(onDisk).toBe('# audit')
  })

  it('uses an explicit date when provided', async () => {
    const r = await reportWrite(HOUSEKEEPING_PATH, { content: '# audit', date: '2026-04-15' })
    expect(r.filename).toBe('cowork-audit-2026-04-15.md')
  })

  it('rejects an invalid date format', async () => {
    await expect(reportWrite(HOUSEKEEPING_PATH, { content: 'x', date: 'not-a-date' })).rejects.toThrow(/Invalid date/)
    await expect(reportWrite(HOUSEKEEPING_PATH, { content: 'x', date: '2026-4-15' })).rejects.toThrow(/Invalid date/)
  })

  it('creates the housekeeping directory when missing', async () => {
    await fs.rm(HOUSEKEEPING_PATH, { recursive: true, force: true })
    const r = await reportWrite(HOUSEKEEPING_PATH, { content: '# x', date: '2026-01-01' })
    const onDisk = await fs.readFile(r.path, 'utf-8')
    expect(onDisk).toBe('# x')
  })
})
