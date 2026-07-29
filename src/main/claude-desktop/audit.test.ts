import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  artifactHealth,
  artifactPrune,
  backupSummary,
  debugInfo,
  listObsolete,
  memorySpacesSummary,
  obsoleteOutputs,
  pluginsInventory,
  projectCacheStatus,
  storageSummary
} from './audit.js'

const CLAUDE_DESKTOP_ROOT_PATH = path.join(os.tmpdir(), 'mcp-housekeeping-cowork-audit-tests')

const DAY_MS = 24 * 60 * 60 * 1000

const setMtime = async (p: string, when: Date) => {
  await fs.utimes(p, when, when)
}

beforeAll(async () => {
  await fs.mkdir(CLAUDE_DESKTOP_ROOT_PATH, { recursive: true })
})

afterAll(async () => {
  await fs.rm(CLAUDE_DESKTOP_ROOT_PATH, { recursive: true, force: true })
})

beforeEach(async () => {
  // Wipe between tests for isolation
  const entries = await fs.readdir(CLAUDE_DESKTOP_ROOT_PATH).catch(() => [])
  await Promise.all(entries.map((e) => fs.rm(path.join(CLAUDE_DESKTOP_ROOT_PATH, e), { recursive: true, force: true })))
})

afterEach(async () => {
  const entries = await fs.readdir(CLAUDE_DESKTOP_ROOT_PATH).catch(() => [])
  await Promise.all(entries.map((e) => fs.rm(path.join(CLAUDE_DESKTOP_ROOT_PATH, e), { recursive: true, force: true })))
})

describe('storageSummary', () => {
  it('counts sessions, computes totals, returns oldest/newest', async () => {
    await fs.writeFile(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'local_a.json'), JSON.stringify({ id: 'a' }))
    await fs.mkdir(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'local_a'))
    await fs.writeFile(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'local_a', 'audit.jsonl'), 'x'.repeat(1000))
    await fs.writeFile(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'local_b.json'), JSON.stringify({ id: 'b' }))
    await fs.mkdir(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'local_b'))

    const result = await storageSummary(CLAUDE_DESKTOP_ROOT_PATH, { flag_size_gb: 999, flag_session_count: 10 })
    expect(result.session_count).toBe(2)
    expect(result.session_json_count).toBe(2)
    expect(result.json_total_bytes).toBeGreaterThan(0)
    expect(result.oldest_session_json).not.toBeNull()
    expect(result.newest_session_json).not.toBeNull()
    expect(result.flags).toEqual([])
  })

  it('flags when thresholds are breached', async () => {
    await fs.writeFile(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'local_a.json'), '{}')
    await fs.mkdir(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'local_a'))
    const result = await storageSummary(CLAUDE_DESKTOP_ROOT_PATH, { flag_size_gb: 0, flag_session_count: 0 })
    expect(result.flags).toContain('total_size_exceeds_0gb')
    expect(result.flags).toContain('session_count_exceeds_0')
  })
})

describe('listObsolete', () => {
  it('returns sessions older than the cutoff', async () => {
    const oldFile = path.join(CLAUDE_DESKTOP_ROOT_PATH, 'local_old.json')
    const newFile = path.join(CLAUDE_DESKTOP_ROOT_PATH, 'local_new.json')
    await fs.writeFile(oldFile, '{}')
    await fs.writeFile(newFile, '{}')
    await fs.mkdir(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'local_old'))
    await fs.mkdir(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'local_new'))
    await setMtime(oldFile, new Date(Date.now() - 60 * DAY_MS))

    const result = await listObsolete(CLAUDE_DESKTOP_ROOT_PATH, { older_than_days: 30, flag_count: 999, flag_size_mb: 999 })
    expect(result.obsolete_count).toBe(1)
    expect(result.top_10_oldest[0]?.name).toBe('local_old')
    expect(result.flags).toEqual([])
  })

  it('flags when thresholds are exceeded', async () => {
    const oldFile = path.join(CLAUDE_DESKTOP_ROOT_PATH, 'local_old.json')
    await fs.writeFile(oldFile, '{}')
    await setMtime(oldFile, new Date(Date.now() - 60 * DAY_MS))
    const result = await listObsolete(CLAUDE_DESKTOP_ROOT_PATH, { older_than_days: 30, flag_count: 0, flag_size_mb: 0 })
    expect(result.flags).toContain('obsolete_count_exceeds_0')
  })
})

describe('artifactHealth', () => {
  it('returns per-artifact metadata and flags', async () => {
    const oneDay = 24 * 60 * 60 * 1000
    await fs.writeFile(
      path.join(CLAUDE_DESKTOP_ROOT_PATH, 'artifacts.json'),
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

    const result = await artifactHealth(CLAUDE_DESKTOP_ROOT_PATH, { flag_versions: 20, flag_stale_days: 30, flag_unstarred_idle_days: 14 })
    expect(result.total).toBe(2)
    expect(result.starred).toBe(1)
    const stale = result.items.find((i) => i.id === 'stale')
    expect(stale?.flags).toContain('high_churn_versions>20')
    expect(stale?.flags).toContain('stale>30d')
    expect(stale?.flags).toContain('unstarred_idle>14d')
  })

  it('returns empty when artifacts.json is missing', async () => {
    const result = await artifactHealth(CLAUDE_DESKTOP_ROOT_PATH, { flag_versions: 20, flag_stale_days: 30, flag_unstarred_idle_days: 14 })
    expect(result.total).toBe(0)
  })
})

describe('artifactPrune', () => {
  it('keeps the top N most-recent unstarred and deletes the rest', async () => {
    const now = Date.now()
    await fs.writeFile(
      path.join(CLAUDE_DESKTOP_ROOT_PATH, 'artifacts.json'),
      JSON.stringify([
        { id: 'starred', name: 'Star', isStarred: true, updatedAt: now - 100 },
        { id: 'a', name: 'A', isStarred: false, updatedAt: now - 1 },
        { id: 'b', name: 'B', isStarred: false, updatedAt: now - 2 },
        { id: 'c', name: 'C', isStarred: false, updatedAt: now - 3 }
      ])
    )
    await fs.mkdir(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'artifacts'))
    await fs.writeFile(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'artifacts', 'cache_c.json'), '{}')

    const result = await artifactPrune(CLAUDE_DESKTOP_ROOT_PATH, { keep: 2, dry_run: false })
    expect(result.deleted_count).toBe(1)
    expect(result.deleted[0]?.id).toBe('c')
    expect(result.deleted[0]?.cache_file_deleted).toBe(true)

    const remaining = JSON.parse(await fs.readFile(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'artifacts.json'), 'utf-8'))
    expect(remaining.map((a: { id: string }) => a.id).sort()).toEqual(['a', 'b', 'starred'])
  })

  it('is a no-op when below the keep count', async () => {
    await fs.writeFile(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'artifacts.json'), JSON.stringify([{ id: 'a', name: 'A', isStarred: false, updatedAt: 1 }]))
    const result = await artifactPrune(CLAUDE_DESKTOP_ROOT_PATH, { keep: 5, dry_run: false })
    expect(result.deleted).toEqual([])
  })

  it('does not modify files in dry_run mode', async () => {
    await fs.writeFile(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'artifacts.json'), JSON.stringify([{ id: 'x', name: 'X', isStarred: false, updatedAt: 1 }]))
    const result = await artifactPrune(CLAUDE_DESKTOP_ROOT_PATH, { keep: 0, dry_run: true })
    expect(result.deleted_count).toBe(1)
    const onDisk = JSON.parse(await fs.readFile(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'artifacts.json'), 'utf-8'))
    expect(onDisk).toHaveLength(1)
  })

  it('dry_run reports cache_file_deleted=true when a valid cache file exists, without deleting it', async () => {
    await fs.writeFile(
      path.join(CLAUDE_DESKTOP_ROOT_PATH, 'artifacts.json'),
      JSON.stringify([{ id: 'with-cache', name: 'WC', isStarred: false, updatedAt: 1 }])
    )
    const artifactsDir = path.join(CLAUDE_DESKTOP_ROOT_PATH, 'artifacts')
    await fs.mkdir(artifactsDir, { recursive: true })
    const cacheFile = path.join(artifactsDir, 'cache_with-cache.json')
    await fs.writeFile(cacheFile, '{}')
    const result = await artifactPrune(CLAUDE_DESKTOP_ROOT_PATH, { keep: 0, dry_run: true })
    expect(result.deleted[0]?.cache_file_deleted).toBe(true)
    // dry_run must not actually delete the cache file.
    await expect(fs.access(cacheFile)).resolves.toBeUndefined()
  })

  it('records cache_file_deleted=false when the cache file is missing (unlink ENOENT is swallowed)', async () => {
    // No cache_<id>.json file on disk — unlink throws ENOENT, which the
    // catch swallows so the prune still completes.
    await fs.writeFile(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'artifacts.json'), JSON.stringify([{ id: 'no-cache', name: 'NC', isStarred: false, updatedAt: 1 }]))
    await fs.mkdir(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'artifacts'), { recursive: true })
    const result = await artifactPrune(CLAUDE_DESKTOP_ROOT_PATH, { keep: 0, dry_run: false })
    expect(result.deleted_count).toBe(1)
    expect(result.deleted[0]?.cache_file_deleted).toBe(false)
  })

  it('a malicious artifact id cannot unlink a file outside the artifacts dir (two-layer guard)', async () => {
    // Plant a "secret" file outside the artifacts dir, at the workspace root.
    const victim = path.join(CLAUDE_DESKTOP_ROOT_PATH, 'do-not-delete.json')
    await fs.writeFile(victim, 'precious')
    await fs.mkdir(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'artifacts'), { recursive: true })
    // Craft an id whose cache path (cache_<id>.json) escapes the artifacts dir
    // and targets the victim file: artifacts/cache_../do-not-delete + ".json".
    await fs.writeFile(
      path.join(CLAUDE_DESKTOP_ROOT_PATH, 'artifacts.json'),
      JSON.stringify([{ id: '../do-not-delete', name: 'Evil', isStarred: false, updatedAt: 1 }])
    )

    const result = await artifactPrune(CLAUDE_DESKTOP_ROOT_PATH, { keep: 0, dry_run: false })
    // The entry is still pruned from artifacts.json, but no file was unlinked.
    expect(result.deleted_count).toBe(1)
    expect(result.deleted[0]?.cache_file_deleted).toBe(false)
    // The victim outside the artifacts dir must still exist.
    expect(await fs.readFile(victim, 'utf-8')).toBe('precious')
  })

  it('a malicious id is also blocked in dry_run (no escape, cache_file_deleted=false)', async () => {
    const victim = path.join(CLAUDE_DESKTOP_ROOT_PATH, 'do-not-delete.json')
    await fs.writeFile(victim, 'precious')
    await fs.mkdir(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'artifacts'), { recursive: true })
    await fs.writeFile(
      path.join(CLAUDE_DESKTOP_ROOT_PATH, 'artifacts.json'),
      JSON.stringify([{ id: '../do-not-delete', name: 'Evil', isStarred: false, updatedAt: 1 }])
    )

    const result = await artifactPrune(CLAUDE_DESKTOP_ROOT_PATH, { keep: 0, dry_run: true })
    expect(result.deleted_count).toBe(1)
    // Even though the victim exists, the guard rejects the escaping path before
    // pathExists is consulted, so it reports false rather than leaking existence.
    expect(result.deleted[0]?.cache_file_deleted).toBe(false)
    expect(await fs.readFile(victim, 'utf-8')).toBe('precious')
  })

  it('rethrows non-ENOENT unlink errors (EACCES when artifacts/ is chmod 0)', async () => {
    await fs.writeFile(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'artifacts.json'), JSON.stringify([{ id: 'blocked', name: 'B', isStarred: false, updatedAt: 1 }]))
    const artifactsDir = path.join(CLAUDE_DESKTOP_ROOT_PATH, 'artifacts')
    await fs.mkdir(artifactsDir, { recursive: true })
    await fs.writeFile(path.join(artifactsDir, 'cache_blocked.json'), '{}')
    await fs.chmod(artifactsDir, 0o500) // r-x but no write — unlink fails EACCES
    try {
      await expect(artifactPrune(CLAUDE_DESKTOP_ROOT_PATH, { keep: 0, dry_run: false })).rejects.toThrow(/EACCES|permission/i)
    } finally {
      await fs.chmod(artifactsDir, 0o755)
    }
  })
})

describe('obsoleteOutputs', () => {
  it('reports session dirs with non-empty outputs/uploads', async () => {
    const sessionDir = path.join(CLAUDE_DESKTOP_ROOT_PATH, 'local_x')
    await fs.mkdir(path.join(sessionDir, 'outputs'), { recursive: true })
    await fs.writeFile(path.join(sessionDir, 'outputs', 'a.csv'), 'data')
    await fs.writeFile(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'local_x.json'), '{}')
    await setMtime(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'local_x.json'), new Date(Date.now() - 30 * DAY_MS))

    const result = await obsoleteOutputs(CLAUDE_DESKTOP_ROOT_PATH, { older_than_days: 14 })
    expect(result.sessions_with_artifacts).toBe(1)
    expect(result.findings[0]?.outputs.map((f) => f.name)).toEqual(['a.csv'])
    expect(result.findings[0]?.obsolete).toBe(true)
  })

  it('falls back to session dir mtime when the <name>.json sidecar is missing', async () => {
    const sessionDir = path.join(CLAUDE_DESKTOP_ROOT_PATH, 'local_no_json')
    await fs.mkdir(path.join(sessionDir, 'outputs'), { recursive: true })
    await fs.writeFile(path.join(sessionDir, 'outputs', 'a.csv'), 'data')
    // Note: no local_no_json.json file at all — exercises the dir-mtime fallback.
    await setMtime(sessionDir, new Date(Date.now() - 30 * DAY_MS))
    const result = await obsoleteOutputs(CLAUDE_DESKTOP_ROOT_PATH, { older_than_days: 14 })
    const finding = result.findings.find((f) => f.session === 'local_no_json')
    expect(finding).toBeDefined()
    expect(finding?.obsolete).toBe(true)
    expect(finding?.session_age_days).toBeGreaterThanOrEqual(29)
  })

  it('rethrows when an outputs/uploads readdir fails with a non-ENOENT code (EACCES)', async () => {
    // listFilesWithSize is called for each session's outputs/uploads dir.
    // chmod 0 on outputs/ → readdir throws EACCES → not ENOENT → rethrows.
    const sessionDir = path.join(CLAUDE_DESKTOP_ROOT_PATH, 'local_blocked')
    const outputsDir = path.join(sessionDir, 'outputs')
    await fs.mkdir(outputsDir, { recursive: true })
    await fs.writeFile(path.join(outputsDir, 'a.csv'), 'data')
    await fs.writeFile(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'local_blocked.json'), '{}')
    await fs.chmod(outputsDir, 0o000)
    try {
      await expect(obsoleteOutputs(CLAUDE_DESKTOP_ROOT_PATH, { older_than_days: 14 })).rejects.toThrow(/EACCES|permission/i)
    } finally {
      await fs.chmod(outputsDir, 0o755)
    }
  })
})

describe('backupSummary', () => {
  it('counts and sums .claude.json.backup files', async () => {
    await fs.writeFile(path.join(CLAUDE_DESKTOP_ROOT_PATH, '.claude.json.backup.1'), 'a'.repeat(100))
    await fs.mkdir(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'backups'))
    await fs.writeFile(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'backups', '.claude.json.backup.2'), 'b'.repeat(200))

    const result = await backupSummary(CLAUDE_DESKTOP_ROOT_PATH, { flag_count: 10, flag_size_mb: 5 })
    expect(result.count).toBe(2)
    expect(result.total_bytes).toBe(300)
    expect(result.flags).toEqual([])
  })

  it('flags excessive count and size', async () => {
    await fs.writeFile(path.join(CLAUDE_DESKTOP_ROOT_PATH, '.claude.json.backup.1'), 'a')
    const result = await backupSummary(CLAUDE_DESKTOP_ROOT_PATH, { flag_count: 0, flag_size_mb: 0 })
    expect(result.flags).toContain('backup_count_exceeds_0')
  })
})

describe('memorySpacesSummary error paths', () => {
  it('rethrows non-ENOENT errors when reading the spaces dir (ENOTDIR)', async () => {
    // Place a regular file at <ROOT>/spaces so readdir produces ENOTDIR
    await fs.writeFile(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'spaces'), 'not-a-dir')
    await expect(memorySpacesSummary(CLAUDE_DESKTOP_ROOT_PATH, { flag_files: 20 })).rejects.toThrow()
  })

  it('rethrows non-ENOENT errors when reading a space memory dir (ENOTDIR)', async () => {
    const spaceDir = path.join(CLAUDE_DESKTOP_ROOT_PATH, 'spaces', 'broken')
    await fs.mkdir(spaceDir, { recursive: true })
    // memory is a regular file, not a directory
    await fs.writeFile(path.join(spaceDir, 'memory'), 'not-a-dir')
    await expect(memorySpacesSummary(CLAUDE_DESKTOP_ROOT_PATH, { flag_files: 20 })).rejects.toThrow()
  })
})

describe('memorySpacesSummary indexHook error path', () => {
  it('keeps indexHook null when MEMORY.md exists in listing but cannot be read', async () => {
    // Make MEMORY.md a directory — readdir lists it as a file-like entry
    // (since the parent code only checks names), but readFile throws EISDIR.
    const memoryDir = path.join(CLAUDE_DESKTOP_ROOT_PATH, 'spaces', 'unreadable-index', 'memory')
    await fs.mkdir(memoryDir, { recursive: true })
    // A real .md file so the listing isn't empty
    await fs.writeFile(path.join(memoryDir, 'note.md'), 'x')
    // MEMORY.md as a directory — fs.readdir sees it as an entry whose
    // isFile() is false, but the .md filter doesn't check isFile(). Actually
    // memorySpacesSummary filters by isFile() — so we need a real file that
    // can't be read. Use chmod 0 to make readFile throw.
    await fs.writeFile(path.join(memoryDir, 'MEMORY.md'), 'index content')
    await fs.chmod(path.join(memoryDir, 'MEMORY.md'), 0o000)
    try {
      const result = await memorySpacesSummary(CLAUDE_DESKTOP_ROOT_PATH, { flag_files: 20 })
      const target = result.spaces.find((s) => s.space_id === 'unreadable-index')
      expect(target).toBeDefined()
      expect(target?.index_hook).toBeNull()
    } finally {
      await fs.chmod(path.join(memoryDir, 'MEMORY.md'), 0o644)
    }
  })
})

describe('memorySpacesSummary', () => {
  it('lists spaces, file counts, and the index hook', async () => {
    const spaceDir = path.join(CLAUDE_DESKTOP_ROOT_PATH, 'spaces', 'space-1')
    await fs.mkdir(path.join(spaceDir, 'memory'), { recursive: true })
    await fs.writeFile(path.join(spaceDir, 'memory', 'a.md'), 'a')
    await fs.writeFile(path.join(spaceDir, 'memory', 'MEMORY.md'), '- entry one\n- entry two')

    const result = await memorySpacesSummary(CLAUDE_DESKTOP_ROOT_PATH, { flag_files: 20 })
    expect(result.spaces_dir_exists).toBe(true)
    expect(result.spaces).toHaveLength(1)
    expect(result.spaces[0]?.memory_file_count).toBe(2)
    expect(result.spaces[0]?.index_hook).toContain('entry one')
  })

  it('reports spaces_dir_exists=false when there are no spaces', async () => {
    const result = await memorySpacesSummary(CLAUDE_DESKTOP_ROOT_PATH, { flag_files: 20 })
    expect(result.spaces_dir_exists).toBe(false)
  })

  it('flags empty and bloated spaces', async () => {
    await fs.mkdir(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'spaces', 'empty'), { recursive: true })
    const bloatedDir = path.join(CLAUDE_DESKTOP_ROOT_PATH, 'spaces', 'bloated', 'memory')
    await fs.mkdir(bloatedDir, { recursive: true })
    for (let i = 0; i < 3; i++) await fs.writeFile(path.join(bloatedDir, `f${i}.md`), 'x')
    const result = await memorySpacesSummary(CLAUDE_DESKTOP_ROOT_PATH, { flag_files: 2 })
    const empty = result.spaces.find((s) => s.space_id === 'empty')
    const bloated = result.spaces.find((s) => s.space_id === 'bloated')
    expect(empty?.flags).toContain('completely_empty')
    expect(bloated?.flags).toContain('memory_files_exceed_2')
  })
})

describe('pluginsInventory', () => {
  it('flags a plugin whose install age is significantly above the median', async () => {
    const day = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString()
    await fs.mkdir(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'cowork_plugins'), { recursive: true })
    await fs.writeFile(
      path.join(CLAUDE_DESKTOP_ROOT_PATH, 'cowork_plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          ancient: [{ scope: 'user', installPath: '/x', version: '1.0', installedAt: day(200), lastUpdated: day(200) }],
          recent_a: [{ scope: 'user', installPath: '/y', version: '1.0', installedAt: day(5), lastUpdated: day(5) }],
          recent_b: [{ scope: 'user', installPath: '/z', version: '1.0', installedAt: day(2), lastUpdated: day(2) }]
        }
      })
    )
    const result = await pluginsInventory(CLAUDE_DESKTOP_ROOT_PATH)
    expect(result.flags.some((f) => f.startsWith('stale_install:ancient'))).toBe(true)
  })

  it('aggregates installed_plugins.json and rpm/manifest.json', async () => {
    await fs.mkdir(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'cowork_plugins'), { recursive: true })
    await fs.writeFile(
      path.join(CLAUDE_DESKTOP_ROOT_PATH, 'cowork_plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          'foo@kw': [{ scope: 'user', installPath: '/x', version: '1.0.0', installedAt: '2026-01-01T00:00:00Z', lastUpdated: '2026-01-01T00:00:00Z' }]
        }
      })
    )
    await fs.mkdir(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'rpm'), { recursive: true })
    await fs.writeFile(
      path.join(CLAUDE_DESKTOP_ROOT_PATH, 'rpm', 'manifest.json'),
      JSON.stringify({ plugins: [{ id: 'p1', name: 'plugin-1', updatedAt: '2026-04-01T00:00:00Z' }] })
    )

    const result = await pluginsInventory(CLAUDE_DESKTOP_ROOT_PATH)
    expect(result.knowledge_work).toHaveLength(1)
    expect(result.rpm).toHaveLength(1)
  })
})

describe('projectCacheStatus error paths', () => {
  it('rethrows non-ENOENT errors when reading .project-cache (ENOTDIR)', async () => {
    await fs.writeFile(path.join(CLAUDE_DESKTOP_ROOT_PATH, '.project-cache'), 'not-a-dir')
    await expect(projectCacheStatus(CLAUDE_DESKTOP_ROOT_PATH, { stale_days: 14 })).rejects.toThrow()
  })
})

describe('projectCacheStatus', () => {
  it('reports cache entries and flags stale ones', async () => {
    const recent = path.join(CLAUDE_DESKTOP_ROOT_PATH, '.project-cache', 'recent')
    const stale = path.join(CLAUDE_DESKTOP_ROOT_PATH, '.project-cache', 'stale')
    await fs.mkdir(recent, { recursive: true })
    await fs.mkdir(stale, { recursive: true })
    await fs.writeFile(path.join(recent, 'metadata.json'), JSON.stringify({ name: 'Recent', synced_at: new Date().toISOString() }))
    await fs.writeFile(path.join(stale, 'metadata.json'), JSON.stringify({ name: 'Stale', synced_at: new Date(Date.now() - 30 * DAY_MS).toISOString() }))

    const result = await projectCacheStatus(CLAUDE_DESKTOP_ROOT_PATH, { stale_days: 14 })
    expect(result.projects).toHaveLength(2)
    const staleEntry = result.projects.find((p) => p.uuid === 'stale')
    expect(staleEntry?.flags).toContain('not_synced>14d')
  })

  it('returns cache_dir_exists=false when no .project-cache', async () => {
    const result = await projectCacheStatus(CLAUDE_DESKTOP_ROOT_PATH, { stale_days: 14 })
    expect(result.cache_dir_exists).toBe(false)
  })
})

describe('debugInfo', () => {
  it('reports debug dir size, count, and oldest age', async () => {
    await fs.mkdir(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'debug'))
    const file = path.join(CLAUDE_DESKTOP_ROOT_PATH, 'debug', 'a.txt')
    await fs.writeFile(file, 'x'.repeat(100))
    await setMtime(file, new Date(Date.now() - 10 * DAY_MS))

    const result = await debugInfo(CLAUDE_DESKTOP_ROOT_PATH, { flag_size_mb: 1, flag_age_days: 7 })
    expect(result.exists).toBe(true)
    expect(result.entry_count).toBe(1)
    expect(result.oldest_entry_age_days).toBeGreaterThanOrEqual(10)
    expect(result.flags).toContain('debug_age_exceeds_7d')
  })

  it('reports exists=false when there is no debug dir', async () => {
    const result = await debugInfo(CLAUDE_DESKTOP_ROOT_PATH, { flag_size_mb: 10, flag_age_days: 7 })
    expect(result.exists).toBe(false)
  })

  it('flags debug_size_exceeds when bytes exceed the mb threshold', async () => {
    await fs.mkdir(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'debug'))
    await fs.writeFile(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'debug', 'a.txt'), 'x'.repeat(100))
    const result = await debugInfo(CLAUDE_DESKTOP_ROOT_PATH, { flag_size_mb: 0, flag_age_days: 365 })
    expect(result.flags).toContain('debug_size_exceeds_0mb')
  })

  it('reports oldest_entry_age_days=null when the debug dir exists but is empty', async () => {
    await fs.mkdir(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'debug'))
    const result = await debugInfo(CLAUDE_DESKTOP_ROOT_PATH, { flag_size_mb: 1, flag_age_days: 7 })
    expect(result.exists).toBe(true)
    expect(result.entry_count).toBe(0)
    expect(result.oldest_entry_age_days).toBeNull()
  })
})

describe('extra branch coverage for desktop audit', () => {
  it('storageSummary returns oldest=null and newest=null when there are no sessions', async () => {
    const result = await storageSummary(CLAUDE_DESKTOP_ROOT_PATH, { flag_size_gb: 999, flag_session_count: 999 })
    expect(result.session_count).toBe(0)
    expect(result.oldest_session_json).toBeNull()
    expect(result.newest_session_json).toBeNull()
  })

  it('listObsolete sorts multiple obsolete sessions ascending by mtime', async () => {
    const a = path.join(CLAUDE_DESKTOP_ROOT_PATH, 'local_older.json')
    const b = path.join(CLAUDE_DESKTOP_ROOT_PATH, 'local_newer.json')
    await fs.writeFile(a, '{}')
    await fs.writeFile(b, '{}')
    await fs.mkdir(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'local_older'))
    await fs.mkdir(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'local_newer'))
    await setMtime(a, new Date(Date.now() - 90 * DAY_MS))
    await setMtime(b, new Date(Date.now() - 45 * DAY_MS))
    const result = await listObsolete(CLAUDE_DESKTOP_ROOT_PATH, { older_than_days: 30, flag_count: 999, flag_size_mb: 999 })
    expect(result.obsolete_count).toBe(2)
    expect(result.top_10_oldest[0]?.name).toBe('local_older')
    expect(result.top_10_oldest[1]?.name).toBe('local_newer')
  })

  it('listObsolete flags obsolete_size_exceeds when bytes are over the mb threshold', async () => {
    const a = path.join(CLAUDE_DESKTOP_ROOT_PATH, 'local_big.json')
    await fs.writeFile(a, 'x'.repeat(2048))
    await fs.mkdir(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'local_big'))
    await setMtime(a, new Date(Date.now() - 60 * DAY_MS))
    const result = await listObsolete(CLAUDE_DESKTOP_ROOT_PATH, { older_than_days: 30, flag_count: 999, flag_size_mb: 0 })
    expect(result.flags).toContain('obsolete_size_exceeds_0mb')
  })

  it('artifactHealth: handles artifacts with no versions/no updatedAt (last_updated=null, age_days=null)', async () => {
    await fs.writeFile(
      path.join(CLAUDE_DESKTOP_ROOT_PATH, 'artifacts.json'),
      JSON.stringify([
        // No versions, no updatedAt/createdAt — exercises ?? 0 chains and null-branch returns.
        { id: 'bare', name: 'Bare', isStarred: false }
      ])
    )
    const result = await artifactHealth(CLAUDE_DESKTOP_ROOT_PATH, {
      flag_versions: 100,
      flag_stale_days: 999,
      flag_unstarred_idle_days: 999
    })
    const bare = result.items.find((i) => i.id === 'bare')
    expect(bare?.version_count).toBe(0)
    expect(bare?.last_updated).toBeNull()
    expect(bare?.age_days).toBeNull()
    expect(bare?.flags).toEqual([])
  })

  it('artifactHealth: uses createdAt when updatedAt is missing', async () => {
    const oneDay = 24 * 60 * 60 * 1000
    await fs.writeFile(
      path.join(CLAUDE_DESKTOP_ROOT_PATH, 'artifacts.json'),
      JSON.stringify([{ id: 'created-only', name: 'CO', isStarred: false, createdAt: Date.now() - 100 * oneDay }])
    )
    const result = await artifactHealth(CLAUDE_DESKTOP_ROOT_PATH, { flag_versions: 100, flag_stale_days: 30, flag_unstarred_idle_days: 30 })
    const co = result.items.find((i) => i.id === 'created-only')
    expect(co?.age_days).toBeGreaterThanOrEqual(99)
    expect(co?.flags).toContain('stale>30d')
    expect(co?.flags).toContain('unstarred_idle>30d')
  })

  it('artifactPrune sorts multiple unstarred artifacts by recency (sort callback both directions)', async () => {
    const now = Date.now()
    await fs.writeFile(
      path.join(CLAUDE_DESKTOP_ROOT_PATH, 'artifacts.json'),
      JSON.stringify([
        { id: 'older', name: 'O', isStarred: false, updatedAt: now - 100 },
        { id: 'newer', name: 'N', isStarred: false, updatedAt: now - 10 },
        { id: 'oldest', name: 'X', isStarred: false, createdAt: now - 1000 }
      ])
    )
    await fs.mkdir(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'artifacts'), { recursive: true })
    const result = await artifactPrune(CLAUDE_DESKTOP_ROOT_PATH, { keep: 1, dry_run: false })
    // 3 unstarred, keep 1 most-recent (newer) → deletes older and oldest
    expect(result.deleted_count).toBe(2)
    const ids = result.deleted.map((d) => d.id).sort()
    expect(ids).toEqual(['older', 'oldest'])
  })

  it('artifactPrune records last_updated=null when an artifact has no updatedAt', async () => {
    await fs.writeFile(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'artifacts.json'), JSON.stringify([{ id: 'no-ts', name: 'NT', isStarred: false }]))
    await fs.mkdir(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'artifacts'), { recursive: true })
    const result = await artifactPrune(CLAUDE_DESKTOP_ROOT_PATH, { keep: 0, dry_run: false })
    expect(result.deleted[0]?.last_updated).toBeNull()
  })

  it('artifactPrune handles a missing artifacts.json (?? [] fallback)', async () => {
    // No artifacts.json on disk → readJsonIfExists returns null → ?? [] kicks in.
    const result = await artifactPrune(CLAUDE_DESKTOP_ROOT_PATH, { keep: 5, dry_run: false })
    expect(result.deleted).toEqual([])
    expect((result as { kept?: number }).kept).toBe(0)
  })

  it('artifactPrune sort comparator handles all three ?? branches (updatedAt / createdAt / 0)', async () => {
    const now = Date.now()
    await fs.writeFile(
      path.join(CLAUDE_DESKTOP_ROOT_PATH, 'artifacts.json'),
      JSON.stringify([
        // Neither updatedAt nor createdAt FIRST in the array so that sort compares
        // it both as `a` and as `b` against later entries, hitting the `?? 0` fallback.
        { id: 'no-ts-prune', name: 'X', isStarred: false },
        // Has only createdAt — first ?? falls through to b.createdAt.
        { id: 'has-created', name: 'C', isStarred: false, createdAt: now - 200 },
        // Has updatedAt — `b.updatedAt ?? ...` takes left branch.
        { id: 'has-updated', name: 'U', isStarred: false, updatedAt: now - 100 },
        // Starred — filter false branch.
        { id: 'starred', name: 'S', isStarred: true, updatedAt: now },
        // Another no-ts so sort definitely does (a-without-ts, b-without-ts).
        { id: 'no-ts-2', name: 'Y', isStarred: false }
      ])
    )
    await fs.mkdir(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'artifacts'), { recursive: true })
    const result = await artifactPrune(CLAUDE_DESKTOP_ROOT_PATH, { keep: 1, dry_run: false })
    // 4 unstarred, keep 1 (most recent: has-updated) → deletes 3.
    expect(result.deleted_count).toBe(3)
  })

  it('obsoleteOutputs skips sessions whose outputs/uploads are both empty', async () => {
    const sessionDir = path.join(CLAUDE_DESKTOP_ROOT_PATH, 'local_empty')
    await fs.mkdir(path.join(sessionDir, 'outputs'), { recursive: true })
    await fs.mkdir(path.join(sessionDir, 'uploads'), { recursive: true })
    // Both outputs/ and uploads/ exist but are empty → session is skipped.
    await fs.writeFile(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'local_empty.json'), '{}')

    const result = await obsoleteOutputs(CLAUDE_DESKTOP_ROOT_PATH, { older_than_days: 14 })
    expect(result.findings.find((f) => f.session === 'local_empty')).toBeUndefined()
  })

  it('obsoleteOutputs sorts multiple findings by descending age', async () => {
    const oldDate = new Date(Date.now() - 90 * DAY_MS)
    const middleDate = new Date(Date.now() - 30 * DAY_MS)
    for (const [name, mtime] of [
      ['local_old', oldDate],
      ['local_middle', middleDate]
    ] as const) {
      const sessionDir = path.join(CLAUDE_DESKTOP_ROOT_PATH, name)
      await fs.mkdir(path.join(sessionDir, 'outputs'), { recursive: true })
      await fs.writeFile(path.join(sessionDir, 'outputs', 'a.csv'), 'data')
      const jsonPath = path.join(CLAUDE_DESKTOP_ROOT_PATH, `${name}.json`)
      await fs.writeFile(jsonPath, '{}')
      await setMtime(jsonPath, mtime)
    }
    const result = await obsoleteOutputs(CLAUDE_DESKTOP_ROOT_PATH, { older_than_days: 14 })
    expect(result.findings[0]?.session).toBe('local_old')
    expect(result.findings[1]?.session).toBe('local_middle')
  })

  it('listFilesWithSize skips subdirectories within outputs/', async () => {
    const sessionDir = path.join(CLAUDE_DESKTOP_ROOT_PATH, 'local_z')
    const outputsDir = path.join(sessionDir, 'outputs')
    await fs.mkdir(outputsDir, { recursive: true })
    await fs.writeFile(path.join(outputsDir, 'a.csv'), 'data')
    await fs.mkdir(path.join(outputsDir, 'subdir'), { recursive: true })
    await fs.writeFile(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'local_z.json'), '{}')
    await setMtime(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'local_z.json'), new Date(Date.now() - 30 * DAY_MS))
    const result = await obsoleteOutputs(CLAUDE_DESKTOP_ROOT_PATH, { older_than_days: 14 })
    const finding = result.findings.find((f) => f.session === 'local_z')
    expect(finding?.outputs.map((f) => f.name)).toEqual(['a.csv'])
  })

  it('memorySpacesSummary handles a missing MEMORY.md (no index hook) and swallows ENOENT for a missing memory dir', async () => {
    // space with no memory/ dir at all
    await fs.mkdir(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'spaces', 'no-memory'), { recursive: true })
    // space with memory/ but no MEMORY.md
    await fs.mkdir(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'spaces', 'has-memory', 'memory'), { recursive: true })
    await fs.writeFile(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'spaces', 'has-memory', 'memory', 'note.md'), 'note')
    const result = await memorySpacesSummary(CLAUDE_DESKTOP_ROOT_PATH, { flag_files: 20 })
    const noMem = result.spaces.find((s) => s.space_id === 'no-memory')
    expect(noMem?.memory_dir_exists).toBe(false)
    expect(noMem?.flags).toContain('completely_empty')
    const hasMem = result.spaces.find((s) => s.space_id === 'has-memory')
    expect(hasMem?.index_hook).toBeNull()
  })

  it('memorySpacesSummary skips file entries that are not directories under spaces/', async () => {
    await fs.mkdir(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'spaces'), { recursive: true })
    await fs.writeFile(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'spaces', 'stray.txt'), 'not a space')
    await fs.mkdir(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'spaces', 'real-space', 'memory'), { recursive: true })
    await fs.writeFile(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'spaces', 'real-space', 'memory', 'a.md'), 'a')
    const result = await memorySpacesSummary(CLAUDE_DESKTOP_ROOT_PATH, { flag_files: 20 })
    expect(result.spaces.map((s) => s.space_id)).toEqual(['real-space'])
  })

  it('pluginsInventory handles installed_plugins.json without a plugins field', async () => {
    await fs.mkdir(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'cowork_plugins'), { recursive: true })
    // installed_plugins.json without a `plugins` field — knowledgeWork loop is skipped.
    await fs.writeFile(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'cowork_plugins', 'installed_plugins.json'), JSON.stringify({ version: 2 }))
    const result = await pluginsInventory(CLAUDE_DESKTOP_ROOT_PATH)
    expect(result.knowledge_work).toEqual([])
  })

  it('pluginsInventory does not flag stale_install when ages are uniformly recent (3+ plugins)', async () => {
    const day = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString()
    await fs.mkdir(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'cowork_plugins'), { recursive: true })
    await fs.writeFile(
      path.join(CLAUDE_DESKTOP_ROOT_PATH, 'cowork_plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          a: [{ scope: 'user', installPath: '/x', version: '1.0', installedAt: day(5), lastUpdated: day(5) }],
          b: [{ scope: 'user', installPath: '/y', version: '1.0', installedAt: day(7), lastUpdated: day(7) }],
          c: [{ scope: 'user', installPath: '/z', version: '1.0', installedAt: day(10), lastUpdated: day(10) }]
        }
      })
    )
    const result = await pluginsInventory(CLAUDE_DESKTOP_ROOT_PATH)
    expect(result.flags.filter((f) => f.startsWith('stale_install:'))).toEqual([])
  })

  it('projectCacheStatus skips non-directory entries in .project-cache/', async () => {
    const cacheDir = path.join(CLAUDE_DESKTOP_ROOT_PATH, '.project-cache')
    await fs.mkdir(path.join(cacheDir, 'real-uuid'), { recursive: true })
    await fs.writeFile(path.join(cacheDir, 'real-uuid', 'metadata.json'), JSON.stringify({ name: 'Real', synced_at: new Date().toISOString() }))
    // A stray file at the top of .project-cache — must be skipped.
    await fs.writeFile(path.join(cacheDir, 'README.txt'), 'not a project')
    const result = await projectCacheStatus(CLAUDE_DESKTOP_ROOT_PATH, { stale_days: 14 })
    expect(result.projects.map((p) => p.uuid)).toEqual(['real-uuid'])
  })

  it('projectCacheStatus handles a metadata.json with no synced_at (sync_age_days=null)', async () => {
    const cacheDir = path.join(CLAUDE_DESKTOP_ROOT_PATH, '.project-cache')
    await fs.mkdir(path.join(cacheDir, 'no-sync'), { recursive: true })
    await fs.writeFile(path.join(cacheDir, 'no-sync', 'metadata.json'), JSON.stringify({ name: 'NoSync' }))
    const result = await projectCacheStatus(CLAUDE_DESKTOP_ROOT_PATH, { stale_days: 14 })
    const ns = result.projects.find((p) => p.uuid === 'no-sync')
    expect(ns?.synced_at).toBeNull()
    expect(ns?.sync_age_days).toBeNull()
    expect(ns?.flags).toEqual([])
  })

  it('projectCacheStatus falls back to {} when a project has no metadata.json', async () => {
    const cacheDir = path.join(CLAUDE_DESKTOP_ROOT_PATH, '.project-cache')
    await fs.mkdir(path.join(cacheDir, 'no-meta'), { recursive: true })
    // intentionally no metadata.json file inside no-meta
    const result = await projectCacheStatus(CLAUDE_DESKTOP_ROOT_PATH, { stale_days: 14 })
    const nm = result.projects.find((p) => p.uuid === 'no-meta')
    expect(nm).toBeDefined()
    expect(nm?.name).toBeNull()
    expect(nm?.synced_at).toBeNull()
    expect(nm?.sync_age_days).toBeNull()
  })

  it('projectCacheStatus reports name=null when metadata.json has no name field', async () => {
    const cacheDir = path.join(CLAUDE_DESKTOP_ROOT_PATH, '.project-cache')
    await fs.mkdir(path.join(cacheDir, 'no-name'), { recursive: true })
    await fs.writeFile(path.join(cacheDir, 'no-name', 'metadata.json'), JSON.stringify({ synced_at: new Date().toISOString() }))
    const result = await projectCacheStatus(CLAUDE_DESKTOP_ROOT_PATH, { stale_days: 14 })
    const nn = result.projects.find((p) => p.uuid === 'no-name')
    expect(nn?.name).toBeNull()
  })

  it('storageSummary updates oldest/newest correctly across multiple sessions', async () => {
    // Multiple .json files with distinct mtimes to ensure both `!oldest`/`m < oldest.mtime`
    // and `!newest`/`m > newest.mtime` branches are exercised.
    for (const [name, daysAgo] of [
      ['local_a.json', 90],
      ['local_b.json', 30],
      ['local_c.json', 60]
    ] as const) {
      const p = path.join(CLAUDE_DESKTOP_ROOT_PATH, name)
      await fs.writeFile(p, '{}')
      await setMtime(p, new Date(Date.now() - daysAgo * DAY_MS))
      await fs.mkdir(path.join(CLAUDE_DESKTOP_ROOT_PATH, name.replace(/\.json$/, '')))
    }
    const result = await storageSummary(CLAUDE_DESKTOP_ROOT_PATH, { flag_size_gb: 999, flag_session_count: 999 })
    expect(result.oldest_session_json?.name).toBe('local_a.json')
    expect(result.newest_session_json?.name).toBe('local_b.json')
  })

  it('memorySpacesSummary flags memory_files_exceed_<N> when the file count is over threshold', async () => {
    const memoryDir = path.join(CLAUDE_DESKTOP_ROOT_PATH, 'spaces', 'bloated', 'memory')
    await fs.mkdir(memoryDir, { recursive: true })
    for (const name of ['a.md', 'b.md', 'c.md', 'd.md']) {
      await fs.writeFile(path.join(memoryDir, name), 'x')
    }
    const result = await memorySpacesSummary(CLAUDE_DESKTOP_ROOT_PATH, { flag_files: 2 })
    const bloated = result.spaces.find((s) => s.space_id === 'bloated')
    expect(bloated?.flags).toContain('memory_files_exceed_2')
  })

  it('memorySpacesSummary flags memory_empty when memory/ exists but holds no .md files', async () => {
    const memoryDir = path.join(CLAUDE_DESKTOP_ROOT_PATH, 'spaces', 'mem-empty', 'memory')
    await fs.mkdir(memoryDir, { recursive: true })
    // memory dir exists but is empty (or has only non-.md files)
    await fs.writeFile(path.join(memoryDir, 'notes.txt'), 'not a memory file')
    const result = await memorySpacesSummary(CLAUDE_DESKTOP_ROOT_PATH, { flag_files: 20 })
    const target = result.spaces.find((s) => s.space_id === 'mem-empty')
    expect(target?.flags).toContain('memory_empty')
  })

  it('backupSummary recursively scans the backups/ subdir and tolerates a missing one', async () => {
    // Only top-level backup, no backups/ dir at all — exercises the
    // ENOENT-swallow path for the backups/ subdir readdir.
    await fs.writeFile(path.join(CLAUDE_DESKTOP_ROOT_PATH, '.claude.json.backup.99'), 'a'.repeat(50))
    const result = await backupSummary(CLAUDE_DESKTOP_ROOT_PATH, { flag_count: 10, flag_size_mb: 5 })
    expect(result.count).toBe(1)
    expect(result.total_bytes).toBe(50)
  })

  it('backupSummary rethrows non-ENOENT readdir errors (EACCES via chmod 0 on backups/)', async () => {
    await fs.writeFile(path.join(CLAUDE_DESKTOP_ROOT_PATH, '.claude.json.backup.1'), 'x')
    const backupsDir = path.join(CLAUDE_DESKTOP_ROOT_PATH, 'backups')
    await fs.mkdir(backupsDir, { recursive: true })
    await fs.chmod(backupsDir, 0o000)
    try {
      await expect(backupSummary(CLAUDE_DESKTOP_ROOT_PATH, { flag_count: 10, flag_size_mb: 5 })).rejects.toThrow(/EACCES|permission/i)
    } finally {
      await fs.chmod(backupsDir, 0o755)
    }
  })

  it('debugInfo correctly tracks the oldest entry mtime across multiple files', async () => {
    await fs.mkdir(path.join(CLAUDE_DESKTOP_ROOT_PATH, 'debug'))
    const a = path.join(CLAUDE_DESKTOP_ROOT_PATH, 'debug', 'a.txt')
    const b = path.join(CLAUDE_DESKTOP_ROOT_PATH, 'debug', 'b.txt')
    const c = path.join(CLAUDE_DESKTOP_ROOT_PATH, 'debug', 'c.txt')
    await fs.writeFile(a, 'x')
    await fs.writeFile(b, 'x')
    await fs.writeFile(c, 'x')
    await setMtime(a, new Date(Date.now() - 5 * DAY_MS))
    await setMtime(b, new Date(Date.now() - 20 * DAY_MS))
    await setMtime(c, new Date(Date.now() - 10 * DAY_MS))
    const result = await debugInfo(CLAUDE_DESKTOP_ROOT_PATH, { flag_size_mb: 100, flag_age_days: 100 })
    expect(result.oldest_entry_age_days).toBeGreaterThanOrEqual(19)
  })
})
