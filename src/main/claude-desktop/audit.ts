import type { Dirent } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { assertRealPathWithinRoot, daysAgo, duBytes, isNodeError, pathExists, readJsonIfExists, resolveWithinRoot } from '../../utils/utils.js'

const DAY_MS = 1000 * 60 * 60 * 24

/* ==================== Check 1: storage summary ==================== */

export const storageSummary = async (workspaceRoot: string, args: { flag_size_gb: number; flag_session_count: number }) => {
  const entries = await fs.readdir(workspaceRoot, { withFileTypes: true })
  const sessionDirs = entries.filter((e) => e.isDirectory() && e.name.startsWith('local_'))
  const sessionJsonNames = entries.filter((e) => e.isFile() && /^local_.*\.json$/.test(e.name)).map((e) => e.name)

  const totalBytes = await duBytes(workspaceRoot)

  let jsonTotalBytes = 0
  let oldest: { name: string; mtime: number } | null = null
  let newest: { name: string; mtime: number } | null = null
  for (const name of sessionJsonNames) {
    const stat = await fs.stat(path.join(workspaceRoot, name))
    jsonTotalBytes += stat.size
    const m = stat.mtime.getTime()
    if (!oldest || m < oldest.mtime) oldest = { name, mtime: m }
    if (!newest || m > newest.mtime) newest = { name, mtime: m }
  }

  const sessionEntries = await Promise.all(sessionDirs.map(async (e) => ({ name: e.name, bytes: await duBytes(path.join(workspaceRoot, e.name)) })))
  sessionEntries.sort((a, b) => b.bytes - a.bytes)
  const top5 = sessionEntries.slice(0, 5)

  const flagSizeBytes = args.flag_size_gb * 1024 * 1024 * 1024
  const flags: string[] = []
  if (totalBytes > flagSizeBytes) flags.push(`total_size_exceeds_${args.flag_size_gb}gb`)
  if (sessionDirs.length > args.flag_session_count) flags.push(`session_count_exceeds_${args.flag_session_count}`)

  return {
    session_count: sessionDirs.length,
    session_json_count: sessionJsonNames.length,
    total_bytes: totalBytes,
    json_total_bytes: jsonTotalBytes,
    oldest_session_json: oldest ? { name: oldest.name, date: new Date(oldest.mtime).toISOString() } : null,
    newest_session_json: newest ? { name: newest.name, date: new Date(newest.mtime).toISOString() } : null,
    top_5_largest_session_dirs: top5.map((e) => ({ name: e.name, bytes: e.bytes })),
    flags
  }
}

/* ==================== Check 2: obsolete sessions ==================== */

export const listObsolete = async (workspaceRoot: string, args: { older_than_days: number; flag_count: number; flag_size_mb: number }) => {
  const cutoff = Date.now() - args.older_than_days * DAY_MS
  const entries = await fs.readdir(workspaceRoot, { withFileTypes: true })
  const sessionJsons = entries.filter((e) => e.isFile() && /^local_.*\.json$/.test(e.name)).map((e) => e.name)

  const obsolete: { name: string; mtime: number; dir_bytes: number; json_bytes: number }[] = []
  for (const name of sessionJsons) {
    const stat = await fs.stat(path.join(workspaceRoot, name))
    if (stat.mtime.getTime() < cutoff) {
      const dirName = name.replace(/\.json$/, '')
      const dirBytes = (await pathExists(path.join(workspaceRoot, dirName))) ? await duBytes(path.join(workspaceRoot, dirName)) : 0
      obsolete.push({
        name: dirName,
        mtime: stat.mtime.getTime(),
        dir_bytes: dirBytes,
        json_bytes: stat.size
      })
    }
  }

  obsolete.sort((a, b) => a.mtime - b.mtime)
  const totalBytes = obsolete.reduce((sum, o) => sum + o.dir_bytes + o.json_bytes, 0)
  const top10Oldest = obsolete.slice(0, 10).map((o) => ({
    name: o.name,
    last_activity: new Date(o.mtime).toISOString(),
    age_days: daysAgo(o.mtime),
    bytes: o.dir_bytes + o.json_bytes
  }))

  const flagSizeBytes = args.flag_size_mb * 1024 * 1024
  const flags: string[] = []
  if (obsolete.length > args.flag_count) flags.push(`obsolete_count_exceeds_${args.flag_count}`)
  if (totalBytes > flagSizeBytes) flags.push(`obsolete_size_exceeds_${args.flag_size_mb}mb`)

  return {
    cutoff_date: new Date(cutoff).toISOString(),
    older_than_days: args.older_than_days,
    obsolete_count: obsolete.length,
    total_bytes: totalBytes,
    top_10_oldest: top10Oldest,
    flags
  }
}

/* ==================== Check 3: artifact health ==================== */

interface ArtifactRecord {
  id: string
  name: string
  isStarred: boolean
  description?: string
  versions?: number[]
  updatedAt?: number
  createdAt?: number
  mcpTools?: string[]
}

export const artifactHealth = async (workspaceRoot: string, args: { flag_versions: number; flag_stale_days: number; flag_unstarred_idle_days: number }) => {
  const artifactsPath = path.join(workspaceRoot, 'artifacts.json')
  const artifacts = (await readJsonIfExists<ArtifactRecord[]>(artifactsPath)) ?? []

  const items = artifacts.map((a) => {
    const versionCount = a.versions?.length ?? 0
    const updatedAt = a.updatedAt ?? a.createdAt ?? 0
    const ageDays = updatedAt ? daysAgo(updatedAt) : null
    const flags: string[] = []
    if (versionCount > args.flag_versions) flags.push(`high_churn_versions>${args.flag_versions}`)
    if (ageDays !== null && ageDays > args.flag_stale_days) flags.push(`stale>${args.flag_stale_days}d`)
    if (!a.isStarred && ageDays !== null && ageDays > args.flag_unstarred_idle_days) flags.push(`unstarred_idle>${args.flag_unstarred_idle_days}d`)
    return {
      id: a.id,
      name: a.name,
      starred: !!a.isStarred,
      version_count: versionCount,
      last_updated: updatedAt ? new Date(updatedAt).toISOString() : null,
      age_days: ageDays,
      mcp_tools: a.mcpTools ?? [],
      flags
    }
  })

  return {
    total: items.length,
    starred: items.filter((i) => i.starred).length,
    items
  }
}

/* ==================== Check 4: artifact prune ==================== */

/**
 * Delete (or, in dry-run, probe) the cache file for one artifact id, but only
 * after the two-layer path guard confirms it really resolves inside the
 * artifacts dir. The id is untrusted (it comes from artifacts.json), so a
 * crafted value such as "../../foo" must never be allowed to unlink outside
 * the artifacts dir. Returns whether a cache file was deleted (or, in dry-run,
 * whether one exists); a containment failure or missing artifacts dir yields
 * false without touching the filesystem.
 */
const pruneCacheFile = async (artifactsDir: string, id: string, dryRun: boolean): Promise<boolean> => {
  let cachePath: string
  try {
    cachePath = resolveWithinRoot(artifactsDir, `cache_${id}.json`)
    await assertRealPathWithinRoot(artifactsDir, cachePath)
  } catch {
    return false
  }
  if (dryRun) {
    return pathExists(cachePath)
  }
  try {
    await fs.unlink(cachePath)
    return true
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return false
    throw err
  }
}

export const artifactPrune = async (workspaceRoot: string, args: { keep: number; dry_run: boolean }) => {
  const artifactsPath = path.join(workspaceRoot, 'artifacts.json')
  const artifacts = (await readJsonIfExists<ArtifactRecord[]>(artifactsPath)) ?? []
  const unstarred = artifacts.filter((a) => !a.isStarred)
  unstarred.sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))
  const toDelete = unstarred.slice(args.keep)

  const deleted: { id: string; name: string; last_updated: string | null; version_count: number; cache_file_deleted: boolean }[] = []

  if (toDelete.length === 0) {
    return { kept: unstarred.length, deleted: [], dry_run: args.dry_run, note: `No unstarred artifacts beyond top ${args.keep}; nothing to prune.` }
  }

  const idsToDelete = new Set(toDelete.map((a) => a.id))
  const remaining = artifacts.filter((a) => !idsToDelete.has(a.id))

  // The cache file lives at <workspaceRoot>/artifacts/cache_<id>.json. The `id`
  // comes from untrusted artifacts.json, so a crafted value (e.g. "../..") could
  // build a path that escapes the artifacts dir. Run the repo's two-layer guard
  // (lexical resolveWithinRoot + symlink-aware assertRealPathWithinRoot) against
  // the artifacts dir before any unlink; on escape, skip the unlink for that
  // entry rather than touching anything outside the artifacts dir.
  const artifactsDir = path.join(workspaceRoot, 'artifacts')

  for (const a of toDelete) {
    const cacheDeleted = await pruneCacheFile(artifactsDir, a.id, args.dry_run)
    deleted.push({
      id: a.id,
      name: a.name,
      last_updated: a.updatedAt ? new Date(a.updatedAt).toISOString() : null,
      version_count: a.versions?.length ?? 0,
      cache_file_deleted: cacheDeleted
    })
  }

  if (!args.dry_run) {
    await fs.writeFile(artifactsPath, `${JSON.stringify(remaining, null, 2)}\n`, 'utf-8')
  }

  return {
    kept: remaining.length,
    deleted_count: deleted.length,
    deleted,
    dry_run: args.dry_run
  }
}

/* ==================== Check 5: obsolete outputs/uploads ==================== */

export const obsoleteOutputs = async (workspaceRoot: string, args: { older_than_days: number }) => {
  const cutoff = Date.now() - args.older_than_days * DAY_MS
  const entries = await fs.readdir(workspaceRoot, { withFileTypes: true })
  const sessionDirs = entries.filter((e) => e.isDirectory() && e.name.startsWith('local_')).map((e) => e.name)

  const findings: {
    session: string
    session_age_days: number | null
    obsolete: boolean
    outputs: { name: string; bytes: number }[]
    uploads: { name: string; bytes: number }[]
  }[] = []

  for (const name of sessionDirs) {
    let sessionMtime: number | null = null
    try {
      const stat = await fs.stat(path.join(workspaceRoot, `${name}.json`))
      sessionMtime = stat.mtime.getTime()
    } catch {
      // missing .json — fall back to dir mtime
      try {
        const stat = await fs.stat(path.join(workspaceRoot, name))
        sessionMtime = stat.mtime.getTime()
        /* v8 ignore start -- session dir was just listed by readdir; a stat failure here only happens if it's removed mid-call. */
      } catch {
        sessionMtime = null
      }
      /* v8 ignore stop */
    }

    const outputs = await listFilesWithSize(path.join(workspaceRoot, name, 'outputs'))
    const uploads = await listFilesWithSize(path.join(workspaceRoot, name, 'uploads'))
    if (outputs.length === 0 && uploads.length === 0) continue

    /* v8 ignore next 2 -- sessionMtime is only null on a mid-call race (see its v8 ignore); the null branches are paired-defensive. */
    const ageDays = sessionMtime !== null ? daysAgo(sessionMtime) : null
    const obsolete = sessionMtime !== null && sessionMtime < cutoff
    findings.push({
      session: name,
      session_age_days: ageDays,
      obsolete,
      outputs,
      uploads
    })
  }

  /* v8 ignore next -- session_age_days is only null when sessionMtime is null (see its v8 ignore); the ?? 0 fallback is paired-defensive. */
  findings.sort((a, b) => (b.session_age_days ?? 0) - (a.session_age_days ?? 0))
  return {
    older_than_days: args.older_than_days,
    sessions_with_artifacts: findings.length,
    obsolete_count: findings.filter((f) => f.obsolete).length,
    findings
  }
}

const listFilesWithSize = async (dir: string): Promise<{ name: string; bytes: number }[]> => {
  let entries: Dirent[]
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true })) as Dirent[]
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return []
    throw err
  }
  const out: { name: string; bytes: number }[] = []
  for (const e of entries) {
    if (!e.isFile()) continue
    const stat = await fs.stat(path.join(dir, e.name))
    out.push({ name: e.name, bytes: stat.size })
  }
  return out
}

/* ==================== Check 6: backup file accumulation ==================== */

export const backupSummary = async (workspaceRoot: string, args: { flag_count: number; flag_size_mb: number }) => {
  const candidates: string[] = []
  // Look in workspaceRoot and workspaceRoot/backups for `.claude.json.backup.*`
  for (const dir of [workspaceRoot, path.join(workspaceRoot, 'backups')]) {
    try {
      const entries = await fs.readdir(dir)
      for (const name of entries) {
        if (name.startsWith('.claude.json.backup')) candidates.push(path.join(dir, name))
      }
    } catch (err) {
      if (!(isNodeError(err) && err.code === 'ENOENT')) throw err
    }
  }

  const items = await Promise.all(
    candidates.map(async (p) => {
      const stat = await fs.stat(p)
      return {
        path: path.relative(workspaceRoot, p),
        bytes: stat.size,
        modified: stat.mtime.toISOString()
      }
    })
  )
  items.sort((a, b) => a.modified.localeCompare(b.modified))
  const totalBytes = items.reduce((sum, i) => sum + i.bytes, 0)

  const flagSizeBytes = args.flag_size_mb * 1024 * 1024
  const flags: string[] = []
  if (items.length > args.flag_count) flags.push(`backup_count_exceeds_${args.flag_count}`)
  if (totalBytes > flagSizeBytes) flags.push(`backup_size_exceeds_${args.flag_size_mb}mb`)

  return {
    count: items.length,
    total_bytes: totalBytes,
    items,
    flags
  }
}

/* ==================== Check 7: memory spaces ==================== */

export const memorySpacesSummary = async (workspaceRoot: string, args: { flag_files: number }) => {
  const spacesDir = path.join(workspaceRoot, 'spaces')
  let entries: Dirent[]
  try {
    entries = (await fs.readdir(spacesDir, { withFileTypes: true })) as Dirent[]
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return { spaces_dir_exists: false, spaces: [] }
    throw err
  }

  const spaces = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const spaceId = e.name
    const memoryDir = path.join(spacesDir, spaceId, 'memory')
    let memoryFiles: string[] = []
    let memoryDirExists = true
    try {
      const memEntries = await fs.readdir(memoryDir, { withFileTypes: true })
      memoryFiles = memEntries.filter((f) => f.isFile() && f.name.endsWith('.md')).map((f) => f.name)
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        memoryDirExists = false
      } else {
        throw err
      }
    }

    let indexHook: string | null = null
    if (memoryFiles.includes('MEMORY.md')) {
      try {
        const raw = await fs.readFile(path.join(memoryDir, 'MEMORY.md'), 'utf-8')
        indexHook = raw.trim().split('\n').slice(0, 10).join('\n')
      } catch {
        indexHook = null
      }
    }

    const otherEntries = await fs.readdir(path.join(spacesDir, spaceId))
    const flags: string[] = []
    if (memoryFiles.length === 0 && otherEntries.length === 0) flags.push('completely_empty')
    if (memoryFiles.length === 0 && memoryDirExists) flags.push('memory_empty')
    if (memoryFiles.length > args.flag_files) flags.push(`memory_files_exceed_${args.flag_files}`)

    spaces.push({
      space_id: spaceId,
      memory_dir_exists: memoryDirExists,
      memory_file_count: memoryFiles.length,
      memory_files: memoryFiles,
      index_hook: indexHook,
      other_entries: otherEntries.filter((n) => n !== 'memory'),
      flags
    })
  }

  return { spaces_dir_exists: true, spaces }
}

/* ==================== Check 8: plugin inventory ==================== */

interface InstalledPluginEntry {
  scope: string
  installPath: string
  version: string
  installedAt: string
  lastUpdated: string
  gitCommitSha?: string
}

interface InstalledPluginsFile {
  version: number
  plugins: Record<string, InstalledPluginEntry[]>
}

interface RpmManifest {
  lastUpdated?: number
  plugins?: { id: string; name: string; updatedAt: string; marketplaceName?: string; installedBy?: string }[]
}

export const pluginsInventory = async (workspaceRoot: string) => {
  const installedPath = path.join(workspaceRoot, 'cowork_plugins', 'installed_plugins.json')
  const rpmManifestPath = path.join(workspaceRoot, 'rpm', 'manifest.json')
  const installedFile = await readJsonIfExists<InstalledPluginsFile>(installedPath)
  const rpmFile = await readJsonIfExists<RpmManifest>(rpmManifestPath)

  const knowledgeWork: { plugin: string; version: string; installed_at: string; last_updated: string; install_age_days: number }[] = []
  if (installedFile?.plugins) {
    for (const [pluginKey, entries] of Object.entries(installedFile.plugins)) {
      for (const e of entries) {
        knowledgeWork.push({
          plugin: pluginKey,
          version: e.version,
          installed_at: e.installedAt,
          last_updated: e.lastUpdated,
          install_age_days: daysAgo(new Date(e.installedAt))
        })
      }
    }
    knowledgeWork.sort((a, b) => b.install_age_days - a.install_age_days)
  }

  const rpm: { id: string; name: string; updated_at: string; marketplace?: string; installed_by?: string }[] = []
  if (rpmFile?.plugins) {
    for (const p of rpmFile.plugins) {
      rpm.push({
        id: p.id,
        name: p.name,
        updated_at: p.updatedAt,
        marketplace: p.marketplaceName,
        installed_by: p.installedBy
      })
    }
  }

  // Flag oldest knowledge-work install if its install_age_days is significantly > median
  const flags: string[] = []
  if (knowledgeWork.length >= 3) {
    const ages = knowledgeWork.map((p) => p.install_age_days).sort((a, b) => a - b)
    const median = ages[Math.floor(ages.length / 2)]
    const oldest = knowledgeWork[0]
    if (oldest && median !== undefined && oldest.install_age_days > median + 30) {
      flags.push(`stale_install:${oldest.plugin} (${oldest.install_age_days}d vs median ${median}d)`)
    }
  }

  return {
    knowledge_work: knowledgeWork,
    rpm,
    flags
  }
}

/* ==================== Check 9: project cache ==================== */

interface ProjectCacheMetadata {
  uuid?: string
  name?: string
  description?: string
  synced_at?: string
}

export const projectCacheStatus = async (workspaceRoot: string, args: { stale_days: number }) => {
  const cacheDir = path.join(workspaceRoot, '.project-cache')
  let entries: Dirent[]
  try {
    entries = (await fs.readdir(cacheDir, { withFileTypes: true })) as Dirent[]
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return { cache_dir_exists: false, projects: [] }
    throw err
  }

  const projects: { uuid: string; name: string | null; synced_at: string | null; sync_age_days: number | null; flags: string[] }[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const meta = (await readJsonIfExists<ProjectCacheMetadata>(path.join(cacheDir, e.name, 'metadata.json'))) ?? {}
    const ageDays = meta.synced_at ? daysAgo(new Date(meta.synced_at)) : null
    const flags: string[] = []
    if (ageDays !== null && ageDays > args.stale_days) flags.push(`not_synced>${args.stale_days}d`)
    projects.push({
      uuid: e.name,
      name: meta.name ?? null,
      synced_at: meta.synced_at ?? null,
      sync_age_days: ageDays,
      flags
    })
  }

  return { cache_dir_exists: true, projects }
}

/* ==================== Check 10: stale debug data ==================== */

export const debugInfo = async (workspaceRoot: string, args: { flag_size_mb: number; flag_age_days: number }) => {
  const debugDir = path.join(workspaceRoot, 'debug')
  if (!(await pathExists(debugDir))) {
    return { exists: false, bytes: 0, entry_count: 0, oldest_entry_age_days: null, flags: [] }
  }

  const bytes = await duBytes(debugDir)
  const entries = await fs.readdir(debugDir, { withFileTypes: true })
  let oldest: number | null = null
  for (const e of entries) {
    const stat = await fs.stat(path.join(debugDir, e.name))
    const m = stat.mtime.getTime()
    if (oldest === null || m < oldest) oldest = m
  }
  const oldestAgeDays = oldest !== null ? daysAgo(oldest) : null

  const flagSizeBytes = args.flag_size_mb * 1024 * 1024
  const flags: string[] = []
  if (bytes > flagSizeBytes) flags.push(`debug_size_exceeds_${args.flag_size_mb}mb`)
  if (oldestAgeDays !== null && oldestAgeDays > args.flag_age_days) flags.push(`debug_age_exceeds_${args.flag_age_days}d`)

  return {
    exists: true,
    bytes,
    entry_count: entries.length,
    oldest_entry_age_days: oldestAgeDays,
    flags
  }
}
