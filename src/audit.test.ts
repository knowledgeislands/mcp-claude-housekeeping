import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { artifactHealth, artifactPrune, backupSummary, debugInfo, listObsolete, memorySpacesSummary, obsoleteOutputs, pluginsInventory, projectCacheStatus, storageSummary } from './audit.js'
import { ROOT_PATH } from './config.js'

const DAY_MS = 24 * 60 * 60 * 1000

const setMtime = async (p: string, when: Date) => {
  await fs.utimes(p, when, when)
}

beforeAll(async () => {
  await fs.mkdir(ROOT_PATH, { recursive: true })
})

afterAll(async () => {
  await fs.rm(ROOT_PATH, { recursive: true, force: true })
})

beforeEach(async () => {
  // Wipe between tests for isolation
  const entries = await fs.readdir(ROOT_PATH).catch(() => [])
  await Promise.all(entries.map((e) => fs.rm(path.join(ROOT_PATH, e), { recursive: true, force: true })))
})

afterEach(async () => {
  const entries = await fs.readdir(ROOT_PATH).catch(() => [])
  await Promise.all(entries.map((e) => fs.rm(path.join(ROOT_PATH, e), { recursive: true, force: true })))
})

describe('storageSummary', () => {
  it('counts sessions, computes totals, returns oldest/newest', async () => {
    await fs.writeFile(path.join(ROOT_PATH, 'local_a.json'), JSON.stringify({ id: 'a' }))
    await fs.mkdir(path.join(ROOT_PATH, 'local_a'))
    await fs.writeFile(path.join(ROOT_PATH, 'local_a', 'audit.jsonl'), 'x'.repeat(1000))
    await fs.writeFile(path.join(ROOT_PATH, 'local_b.json'), JSON.stringify({ id: 'b' }))
    await fs.mkdir(path.join(ROOT_PATH, 'local_b'))

    const result = await storageSummary({ flag_size_gb: 999, flag_session_count: 10 })
    expect(result.session_count).toBe(2)
    expect(result.session_json_count).toBe(2)
    expect(result.json_total_bytes).toBeGreaterThan(0)
    expect(result.oldest_session_json).not.toBeNull()
    expect(result.newest_session_json).not.toBeNull()
    expect(result.flags).toEqual([])
  })

  it('flags when thresholds are breached', async () => {
    await fs.writeFile(path.join(ROOT_PATH, 'local_a.json'), '{}')
    await fs.mkdir(path.join(ROOT_PATH, 'local_a'))
    const result = await storageSummary({ flag_size_gb: 0, flag_session_count: 0 })
    expect(result.flags).toContain('total_size_exceeds_0gb')
    expect(result.flags).toContain('session_count_exceeds_0')
  })
})

describe('listObsolete', () => {
  it('returns sessions older than the cutoff', async () => {
    const oldFile = path.join(ROOT_PATH, 'local_old.json')
    const newFile = path.join(ROOT_PATH, 'local_new.json')
    await fs.writeFile(oldFile, '{}')
    await fs.writeFile(newFile, '{}')
    await fs.mkdir(path.join(ROOT_PATH, 'local_old'))
    await fs.mkdir(path.join(ROOT_PATH, 'local_new'))
    await setMtime(oldFile, new Date(Date.now() - 60 * DAY_MS))

    const result = await listObsolete({ older_than_days: 30, flag_count: 999, flag_size_mb: 999 })
    expect(result.obsolete_count).toBe(1)
    expect(result.top_10_oldest[0].name).toBe('local_old')
    expect(result.flags).toEqual([])
  })

  it('flags when thresholds are exceeded', async () => {
    const oldFile = path.join(ROOT_PATH, 'local_old.json')
    await fs.writeFile(oldFile, '{}')
    await setMtime(oldFile, new Date(Date.now() - 60 * DAY_MS))
    const result = await listObsolete({ older_than_days: 30, flag_count: 0, flag_size_mb: 0 })
    expect(result.flags).toContain('obsolete_count_exceeds_0')
  })
})

describe('artifactHealth', () => {
  it('returns per-artifact metadata and flags', async () => {
    const oneDay = 24 * 60 * 60 * 1000
    await fs.writeFile(
      path.join(ROOT_PATH, 'artifacts.json'),
      JSON.stringify([
        {
          id: 'fresh',
          name: 'Fresh',
          isStarred: true,
          versions: [1, 2],
          updatedAt: Date.now()
        },
        {
          id: 'stale',
          name: 'Stale',
          isStarred: false,
          versions: Array.from({ length: 25 }, (_, i) => i),
          updatedAt: Date.now() - 60 * oneDay
        }
      ])
    )

    const result = await artifactHealth({ flag_versions: 20, flag_stale_days: 30, flag_unstarred_idle_days: 14 })
    expect(result.total).toBe(2)
    expect(result.starred).toBe(1)
    const stale = result.items.find((i) => i.id === 'stale')
    expect(stale?.flags).toContain('high_churn_versions>20')
    expect(stale?.flags).toContain('stale>30d')
    expect(stale?.flags).toContain('unstarred_idle>14d')
  })

  it('returns empty when artifacts.json is missing', async () => {
    const result = await artifactHealth({ flag_versions: 20, flag_stale_days: 30, flag_unstarred_idle_days: 14 })
    expect(result.total).toBe(0)
  })
})

describe('artifactPrune', () => {
  it('keeps the top N most-recent unstarred and deletes the rest', async () => {
    const now = Date.now()
    await fs.writeFile(
      path.join(ROOT_PATH, 'artifacts.json'),
      JSON.stringify([
        { id: 'starred', name: 'Star', isStarred: true, updatedAt: now - 100 },
        { id: 'a', name: 'A', isStarred: false, updatedAt: now - 1 },
        { id: 'b', name: 'B', isStarred: false, updatedAt: now - 2 },
        { id: 'c', name: 'C', isStarred: false, updatedAt: now - 3 }
      ])
    )
    await fs.mkdir(path.join(ROOT_PATH, 'artifacts'))
    await fs.writeFile(path.join(ROOT_PATH, 'artifacts', 'cache_c.json'), '{}')

    const result = await artifactPrune({ keep: 2, dry_run: false })
    expect(result.deleted_count).toBe(1)
    expect(result.deleted[0].id).toBe('c')
    expect(result.deleted[0].cache_file_deleted).toBe(true)

    const remaining = JSON.parse(await fs.readFile(path.join(ROOT_PATH, 'artifacts.json'), 'utf-8'))
    expect(remaining.map((a: { id: string }) => a.id).sort()).toEqual(['a', 'b', 'starred'])
  })

  it('is a no-op when below the keep count', async () => {
    await fs.writeFile(path.join(ROOT_PATH, 'artifacts.json'), JSON.stringify([{ id: 'a', name: 'A', isStarred: false, updatedAt: 1 }]))
    const result = await artifactPrune({ keep: 5, dry_run: false })
    expect(result.deleted).toEqual([])
  })

  it('does not modify files in dry_run mode', async () => {
    await fs.writeFile(path.join(ROOT_PATH, 'artifacts.json'), JSON.stringify([{ id: 'x', name: 'X', isStarred: false, updatedAt: 1 }]))
    const result = await artifactPrune({ keep: 0, dry_run: true })
    expect(result.deleted_count).toBe(1)
    const onDisk = JSON.parse(await fs.readFile(path.join(ROOT_PATH, 'artifacts.json'), 'utf-8'))
    expect(onDisk).toHaveLength(1)
  })
})

describe('obsoleteOutputs', () => {
  it('reports session dirs with non-empty outputs/uploads', async () => {
    const sessionDir = path.join(ROOT_PATH, 'local_x')
    await fs.mkdir(path.join(sessionDir, 'outputs'), { recursive: true })
    await fs.writeFile(path.join(sessionDir, 'outputs', 'a.csv'), 'data')
    await fs.writeFile(path.join(ROOT_PATH, 'local_x.json'), '{}')
    await setMtime(path.join(ROOT_PATH, 'local_x.json'), new Date(Date.now() - 30 * DAY_MS))

    const result = await obsoleteOutputs({ older_than_days: 14 })
    expect(result.sessions_with_artifacts).toBe(1)
    expect(result.findings[0].outputs.map((f) => f.name)).toEqual(['a.csv'])
    expect(result.findings[0].obsolete).toBe(true)
  })
})

describe('backupSummary', () => {
  it('counts and sums .claude.json.backup files', async () => {
    await fs.writeFile(path.join(ROOT_PATH, '.claude.json.backup.1'), 'a'.repeat(100))
    await fs.mkdir(path.join(ROOT_PATH, 'backups'))
    await fs.writeFile(path.join(ROOT_PATH, 'backups', '.claude.json.backup.2'), 'b'.repeat(200))

    const result = await backupSummary({ flag_count: 10, flag_size_mb: 5 })
    expect(result.count).toBe(2)
    expect(result.total_bytes).toBe(300)
    expect(result.flags).toEqual([])
  })

  it('flags excessive count and size', async () => {
    await fs.writeFile(path.join(ROOT_PATH, '.claude.json.backup.1'), 'a')
    const result = await backupSummary({ flag_count: 0, flag_size_mb: 0 })
    expect(result.flags).toContain('backup_count_exceeds_0')
  })
})

describe('memorySpacesSummary', () => {
  it('lists spaces, file counts, and the index hook', async () => {
    const spaceDir = path.join(ROOT_PATH, 'spaces', 'space-1')
    await fs.mkdir(path.join(spaceDir, 'memory'), { recursive: true })
    await fs.writeFile(path.join(spaceDir, 'memory', 'a.md'), 'a')
    await fs.writeFile(path.join(spaceDir, 'memory', 'MEMORY.md'), '- entry one\n- entry two')

    const result = await memorySpacesSummary({ flag_files: 20 })
    expect(result.spaces_dir_exists).toBe(true)
    expect(result.spaces).toHaveLength(1)
    expect(result.spaces[0].memory_file_count).toBe(2)
    expect(result.spaces[0].index_hook).toContain('entry one')
  })

  it('reports spaces_dir_exists=false when there are no spaces', async () => {
    const result = await memorySpacesSummary({ flag_files: 20 })
    expect(result.spaces_dir_exists).toBe(false)
  })

  it('flags empty and bloated spaces', async () => {
    await fs.mkdir(path.join(ROOT_PATH, 'spaces', 'empty'), { recursive: true })
    const bloatedDir = path.join(ROOT_PATH, 'spaces', 'bloated', 'memory')
    await fs.mkdir(bloatedDir, { recursive: true })
    for (let i = 0; i < 3; i++) await fs.writeFile(path.join(bloatedDir, `f${i}.md`), 'x')
    const result = await memorySpacesSummary({ flag_files: 2 })
    const empty = result.spaces.find((s) => s.space_id === 'empty')
    const bloated = result.spaces.find((s) => s.space_id === 'bloated')
    expect(empty?.flags).toContain('completely_empty')
    expect(bloated?.flags).toContain('memory_files_exceed_2')
  })
})

describe('pluginsInventory', () => {
  it('aggregates installed_plugins.json and rpm/manifest.json', async () => {
    await fs.mkdir(path.join(ROOT_PATH, 'cowork_plugins'), { recursive: true })
    await fs.writeFile(
      path.join(ROOT_PATH, 'cowork_plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          'foo@kw': [{ scope: 'user', installPath: '/x', version: '1.0.0', installedAt: '2026-01-01T00:00:00Z', lastUpdated: '2026-01-01T00:00:00Z' }]
        }
      })
    )
    await fs.mkdir(path.join(ROOT_PATH, 'rpm'), { recursive: true })
    await fs.writeFile(path.join(ROOT_PATH, 'rpm', 'manifest.json'), JSON.stringify({ plugins: [{ id: 'p1', name: 'plugin-1', updatedAt: '2026-04-01T00:00:00Z' }] }))

    const result = await pluginsInventory()
    expect(result.knowledge_work).toHaveLength(1)
    expect(result.rpm).toHaveLength(1)
  })
})

describe('projectCacheStatus', () => {
  it('reports cache entries and flags stale ones', async () => {
    const recent = path.join(ROOT_PATH, '.project-cache', 'recent')
    const stale = path.join(ROOT_PATH, '.project-cache', 'stale')
    await fs.mkdir(recent, { recursive: true })
    await fs.mkdir(stale, { recursive: true })
    await fs.writeFile(path.join(recent, 'metadata.json'), JSON.stringify({ name: 'Recent', synced_at: new Date().toISOString() }))
    await fs.writeFile(path.join(stale, 'metadata.json'), JSON.stringify({ name: 'Stale', synced_at: new Date(Date.now() - 30 * DAY_MS).toISOString() }))

    const result = await projectCacheStatus({ stale_days: 14 })
    expect(result.projects).toHaveLength(2)
    const staleEntry = result.projects.find((p) => p.uuid === 'stale')
    expect(staleEntry?.flags).toContain('not_synced>14d')
  })

  it('returns cache_dir_exists=false when no .project-cache', async () => {
    const result = await projectCacheStatus({ stale_days: 14 })
    expect(result.cache_dir_exists).toBe(false)
  })
})

describe('debugInfo', () => {
  it('reports debug dir size, count, and oldest age', async () => {
    await fs.mkdir(path.join(ROOT_PATH, 'debug'))
    const file = path.join(ROOT_PATH, 'debug', 'a.txt')
    await fs.writeFile(file, 'x'.repeat(100))
    await setMtime(file, new Date(Date.now() - 10 * DAY_MS))

    const result = await debugInfo({ flag_size_mb: 1, flag_age_days: 7 })
    expect(result.exists).toBe(true)
    expect(result.entry_count).toBe(1)
    expect(result.oldest_entry_age_days).toBeGreaterThanOrEqual(10)
    expect(result.flags).toContain('debug_age_exceeds_7d')
  })

  it('reports exists=false when there is no debug dir', async () => {
    const result = await debugInfo({ flag_size_mb: 10, flag_age_days: 7 })
    expect(result.exists).toBe(false)
  })
})
