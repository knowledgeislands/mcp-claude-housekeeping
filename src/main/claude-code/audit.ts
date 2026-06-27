import type { Dirent } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {
  assertRealPathWithinRoot,
  daysAgo,
  duBytes,
  isNodeError,
  pathExists,
  readJsonIfExists,
  resolveWithinRoot
} from '../../utils/utils.js'

const DAY_MS = 1000 * 60 * 60 * 24

/**
 * Decode a Claude Code project directory name back to a candidate filesystem
 * path. The encoding `s/\//-/g` (with `.` also rendered as `-`) is lossy, so
 * this is best-effort: `-Users-foo-dev-proj` → `/Users/foo/dev/proj`.
 *
 * Returns `{ decoded, exists }` where `exists` reflects an `fs.access` check —
 * useful for spotting projects whose source repo has moved or been deleted.
 */
export const decodeProjectDir = async (encoded: string): Promise<{ decoded: string; exists: boolean }> => {
  const decoded = `/${encoded.replace(/^-+/, '').replace(/-/g, '/')}`
  const exists = await pathExists(decoded)
  return { decoded, exists }
}

/**
 * Encode an absolute filesystem path the way Claude Code names project dirs
 * under `~/.claude/projects/`. Matches the doc: `s/[\/.]/-/g`. The leading
 * slash becomes a leading dash. Caller must pass an absolute path.
 */
export const encodeProjectPath = (absolutePath: string): string => {
  if (!absolutePath.startsWith('/')) {
    throw new Error(`encodeProjectPath requires an absolute path; got "${absolutePath}"`)
  }
  return absolutePath.replace(/[/.]/g, '-')
}

export interface ClaudeCodeProject {
  /** Directory name under `projects/` (encoded path). */
  id: string
  /** Absolute path to the project dir. */
  dir: string
  /** Best-effort decoded original filesystem path. */
  decoded_path: string
  /** Whether the decoded path currently exists on disk. */
  source_exists: boolean
  /** Names of `<uuid>.jsonl` session files in this project. */
  session_files: string[]
  /** Whether a `memory/` subdir exists. */
  has_memory: boolean
}

const isUuidJsonl = (name: string): boolean => /^[0-9a-f-]{36}\.jsonl$/i.test(name)

/**
 * List every project under `<claudeRoot>/projects/` with session-file counts
 * and best-effort source-path resolution.
 */
export const discoverProjects = async (claudeRoot: string): Promise<ClaudeCodeProject[]> => {
  const projectsDir = path.join(claudeRoot, 'projects')
  let entries: Dirent[]
  try {
    entries = (await fs.readdir(projectsDir, { withFileTypes: true })) as Dirent[]
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return []
    throw err
  }

  const projects: ClaudeCodeProject[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const dir = path.join(projectsDir, e.name)
    const inner = await fs.readdir(dir, { withFileTypes: true })
    const sessionFiles = inner.filter((i) => i.isFile() && isUuidJsonl(i.name)).map((i) => i.name)
    const hasMemory = inner.some((i) => i.isDirectory() && i.name === 'memory')
    const { decoded, exists } = await decodeProjectDir(e.name)
    projects.push({
      id: e.name,
      dir,
      decoded_path: decoded,
      source_exists: exists,
      session_files: sessionFiles,
      has_memory: hasMemory
    })
  }
  projects.sort((a, b) => a.id.localeCompare(b.id))
  return projects
}

/* ==================== projects list ==================== */

export const projectsList = async (claudeRoot: string) => {
  const projects = await discoverProjects(claudeRoot)
  const items = await Promise.all(
    projects.map(async (p) => {
      const bytes = await duBytes(p.dir)
      return {
        id: p.id,
        decoded_path: p.decoded_path,
        source_exists: p.source_exists,
        session_count: p.session_files.length,
        has_memory: p.has_memory,
        bytes
      }
    })
  )
  items.sort((a, b) => b.bytes - a.bytes)
  return {
    projects_dir: path.join(claudeRoot, 'projects'),
    project_count: items.length,
    projects: items
  }
}

/* ==================== storage summary ==================== */

export const storageSummary = async (
  claudeRoot: string,
  args: { flag_size_gb: number; flag_session_count: number; flag_orphan_count: number }
) => {
  const projects = await discoverProjects(claudeRoot)
  const totalSessions = projects.reduce((sum, p) => sum + p.session_files.length, 0)
  const orphanCount = projects.filter((p) => !p.source_exists).length
  const totalBytes = await duBytes(claudeRoot)
  const projectsBytes = await duBytes(path.join(claudeRoot, 'projects'))

  const flagSizeBytes = args.flag_size_gb * 1024 * 1024 * 1024
  const flags: string[] = []
  if (totalBytes > flagSizeBytes) flags.push(`total_size_exceeds_${args.flag_size_gb}gb`)
  if (totalSessions > args.flag_session_count) flags.push(`session_count_exceeds_${args.flag_session_count}`)
  if (orphanCount > args.flag_orphan_count) flags.push(`orphan_projects_exceed_${args.flag_orphan_count}`)

  return {
    claude_root: claudeRoot,
    project_count: projects.length,
    session_count: totalSessions,
    orphan_project_count: orphanCount,
    total_bytes: totalBytes,
    projects_bytes: projectsBytes,
    flags
  }
}

/* ==================== obsolete sessions ==================== */

const statMtime = async (file: string): Promise<number | null> => {
  try {
    const stat = await fs.stat(file)
    return stat.mtime.getTime()
    /* v8 ignore start -- file was just listed by readdir; stat only fails here if it vanishes mid-call. */
  } catch {
    return null
  }
  /* v8 ignore stop */
}

export const obsoleteSessions = async (
  claudeRoot: string,
  args: { older_than_days: number; flag_count: number; flag_size_mb: number; project?: string }
) => {
  const cutoff = Date.now() - args.older_than_days * DAY_MS
  const projects = await discoverProjects(claudeRoot)
  const target = args.project ? projects.filter((p) => p.id === args.project) : projects

  const obsolete: { project: string; session: string; mtime: number; bytes: number }[] = []
  for (const p of target) {
    for (const name of p.session_files) {
      const file = path.join(p.dir, name)
      const mtime = await statMtime(file)
      if (mtime === null || mtime >= cutoff) continue
      const stat = await fs.stat(file)
      // Also include the matching `<uuid>/` sidecar dir if it exists.
      const uuid = name.replace(/\.jsonl$/, '')
      const sidecar = path.join(p.dir, uuid)
      const sidecarBytes = (await pathExists(sidecar)) ? await duBytes(sidecar) : 0
      obsolete.push({ project: p.id, session: name, mtime, bytes: stat.size + sidecarBytes })
    }
  }

  obsolete.sort((a, b) => a.mtime - b.mtime)
  const totalBytes = obsolete.reduce((s, o) => s + o.bytes, 0)
  const top10 = obsolete.slice(0, 10).map((o) => ({
    project: o.project,
    session: o.session,
    last_activity: new Date(o.mtime).toISOString(),
    age_days: daysAgo(o.mtime),
    bytes: o.bytes
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
    top_10_oldest: top10,
    flags
  }
}

/* ==================== global status ==================== */

interface ClaudeSettings {
  cleanupPeriodDays?: number
  [key: string]: unknown
}

const HISTORY_FILE = 'history.jsonl'
const SETTINGS_FILE = 'settings.json'
const LAST_CLEANUP_FILE = '.last-cleanup'

export const globalStatus = async (claudeRoot: string) => {
  const historyPath = path.join(claudeRoot, HISTORY_FILE)
  const settingsPath = path.join(claudeRoot, SETTINGS_FILE)
  const lastCleanupPath = path.join(claudeRoot, LAST_CLEANUP_FILE)

  let historyInfo: { exists: boolean; bytes: number; modified: string | null; lines?: number } = {
    exists: false,
    bytes: 0,
    modified: null
  }
  if (await pathExists(historyPath)) {
    const stat = await fs.stat(historyPath)
    const content = await fs.readFile(historyPath, 'utf-8')
    const lines = content === '' ? 0 : content.split('\n').filter((l) => l.trim().length > 0).length
    historyInfo = { exists: true, bytes: stat.size, modified: stat.mtime.toISOString(), lines }
  }

  const settings = await readJsonIfExists<ClaudeSettings>(settingsPath)

  let lastCleanup: string | null = null
  if (await pathExists(lastCleanupPath)) {
    try {
      lastCleanup = (await fs.readFile(lastCleanupPath, 'utf-8')).trim()
    } catch {
      lastCleanup = null
    }
  }

  // Top-level dir overview — what else lives at ~/.claude
  let topLevel: { name: string; bytes: number; modified: string | null }[] = []
  try {
    const entries = (await fs.readdir(claudeRoot, { withFileTypes: true })) as Dirent[]
    topLevel = await Promise.all(
      entries
        .filter((e) => e.isDirectory())
        .map(async (e) => {
          const p = path.join(claudeRoot, e.name)
          const [bytes, mtime] = await Promise.all([duBytes(p), statMtime(p)])
          /* v8 ignore next -- statMtime only returns null on a mid-call race (see its v8 ignore); the null branch is paired-defensive. */
          return { name: e.name, bytes, modified: mtime ? new Date(mtime).toISOString() : null }
        })
    )
    topLevel.sort((a, b) => b.bytes - a.bytes)
    /* v8 ignore start -- defensive: every earlier read on claudeRoot must have succeeded for control flow to get here, so a failure at this readdir requires a mid-call permission change or unlink. */
  } catch {
    topLevel = []
  }
  /* v8 ignore stop */

  // Freshness — useful for detecting a wipe / fresh-init of ~/.claude.
  // If every dir's mtime is very recent and history/settings are absent,
  // the tree was likely just (re)initialized.
  /* v8 ignore next -- t.modified is only null on a mid-call race (see statMtime v8 ignore); the null branch is paired-defensive. */
  const mtimes = topLevel.map((t) => (t.modified ? Date.parse(t.modified) : null)).filter((t): t is number => t !== null)
  const oldestMtime = mtimes.length > 0 ? Math.min(...mtimes) : null
  const oldestAgeHours = oldestMtime !== null ? Math.round(((Date.now() - oldestMtime) / (1000 * 60 * 60)) * 10) / 10 : null
  const looksFreshlyInitialized = !historyInfo.exists && settings === null && oldestAgeHours !== null && oldestAgeHours < 24

  return {
    claude_root: claudeRoot,
    history: historyInfo,
    settings: {
      exists: settings !== null,
      cleanup_period_days: settings?.cleanupPeriodDays ?? null
    },
    last_cleanup: lastCleanup,
    top_level_dirs: topLevel,
    freshness: {
      oldest_top_level_age_hours: oldestAgeHours,
      looks_freshly_initialized: looksFreshlyInitialized
    }
  }
}

/* ==================== session read (preview) ==================== */

export const sessionRead = async (claudeRoot: string, args: { project: string; session: string; max_lines: number; tail: boolean }) => {
  if (!/^[0-9a-f-]{36}\.jsonl$/i.test(args.session)) {
    throw new Error(`Session name must be "<uuid>.jsonl"`)
  }
  const projectDir = resolveWithinRoot(path.join(claudeRoot, 'projects'), args.project)
  const file = resolveWithinRoot(projectDir, args.session)
  await assertRealPathWithinRoot(claudeRoot, file)
  const stat = await fs.stat(file)
  const raw = await fs.readFile(file, 'utf-8')
  const lines = raw.split('\n').filter((l) => l.length > 0)
  const picked = args.tail ? lines.slice(-args.max_lines) : lines.slice(0, args.max_lines)
  return {
    project: args.project,
    session: args.session,
    bytes: stat.size,
    line_count: lines.length,
    lines: picked
  }
}

/* ==================== sessions prune ==================== */

export const sessionsPrune = async (claudeRoot: string, args: { older_than_days: number; project?: string; dry_run: boolean }) => {
  const cutoff = Date.now() - args.older_than_days * DAY_MS
  const projects = await discoverProjects(claudeRoot)
  const target = args.project ? projects.filter((p) => p.id === args.project) : projects

  const deleted: { project: string; session: string; age_days: number; bytes: number; sidecar_deleted: boolean }[] = []
  for (const p of target) {
    for (const name of p.session_files) {
      const file = path.join(p.dir, name)
      const mtime = await statMtime(file)
      if (mtime === null || mtime >= cutoff) continue
      const stat = await fs.stat(file)
      const uuid = name.replace(/\.jsonl$/, '')
      const sidecar = path.join(p.dir, uuid)
      const sidecarExists = await pathExists(sidecar)
      const sidecarBytes = sidecarExists ? await duBytes(sidecar) : 0
      if (!args.dry_run) {
        await fs.unlink(file)
        if (sidecarExists) await fs.rm(sidecar, { recursive: true, force: true })
      }
      deleted.push({
        project: p.id,
        session: name,
        age_days: daysAgo(mtime),
        bytes: stat.size + sidecarBytes,
        sidecar_deleted: sidecarExists
      })
    }
  }

  return {
    cutoff_date: new Date(cutoff).toISOString(),
    older_than_days: args.older_than_days,
    dry_run: args.dry_run,
    deleted_count: deleted.length,
    total_bytes_freed: deleted.reduce((s, d) => s + d.bytes, 0),
    deleted
  }
}

/* ==================== relocate project ==================== */

/**
 * Rename an existing project subdir under `<claudeRoot>/projects/` so it
 * matches the encoding of `new_path`. Use this after renaming or moving the
 * project's source folder on disk so `/resume` keeps finding the history.
 *
 * Rejects if the destination dir already exists (would clobber existing
 * sessions) or if `new_path` doesn't currently exist on disk (likely typo).
 */
export const relocateProject = async (claudeRoot: string, args: { project: string; new_path: string; dry_run: boolean }) => {
  const projectsDir = path.join(claudeRoot, 'projects')
  const fromDir = resolveWithinRoot(projectsDir, args.project)
  await assertRealPathWithinRoot(claudeRoot, fromDir)
  if (!(await pathExists(fromDir))) {
    throw new Error(`Project dir not found: "${args.project}"`)
  }

  const newPathAbs = path.resolve(args.new_path)
  if (!(await pathExists(newPathAbs))) {
    throw new Error(`new_path does not exist on disk: "${args.new_path}" — refusing to relocate to a path that won't resolve`)
  }

  const newId = encodeProjectPath(newPathAbs)
  const toDir = path.join(projectsDir, newId)
  await assertRealPathWithinRoot(claudeRoot, toDir)

  if (newId === args.project) {
    return {
      project: args.project,
      new_id: newId,
      new_path: newPathAbs,
      dry_run: args.dry_run,
      moved: false,
      reason: 'already-encoded-to-this-id'
    }
  }

  if (await pathExists(toDir)) {
    throw new Error(`Destination project dir already exists: "${newId}" — refusing to overwrite. Merge or remove it first.`)
  }

  if (!args.dry_run) {
    await fs.rename(fromDir, toDir)
  }

  return {
    project: args.project,
    new_id: newId,
    new_path: newPathAbs,
    dry_run: args.dry_run,
    moved: !args.dry_run
  }
}

/* ==================== prune orphan projects ==================== */

/**
 * Delete project subdirs whose decoded source path no longer exists on disk.
 * Skips projects with `has_memory: true` unless `include_with_memory` is set
 * (memory is the most expensive thing to lose by accident).
 */
export const pruneOrphanProjects = async (claudeRoot: string, args: { dry_run: boolean; include_with_memory: boolean }) => {
  const projects = await discoverProjects(claudeRoot)
  const orphans = projects.filter((p) => !p.source_exists)
  const targets = args.include_with_memory ? orphans : orphans.filter((p) => !p.has_memory)
  const skipped = args.include_with_memory
    ? []
    : orphans.filter((p) => p.has_memory).map((p) => ({ id: p.id, decoded_path: p.decoded_path, reason: 'has_memory' }))

  const deleted: { id: string; decoded_path: string; session_count: number; bytes: number }[] = []
  for (const p of targets) {
    const bytes = await duBytes(p.dir)
    if (!args.dry_run) {
      await fs.rm(p.dir, { recursive: true, force: true })
    }
    deleted.push({ id: p.id, decoded_path: p.decoded_path, session_count: p.session_files.length, bytes })
  }

  return {
    dry_run: args.dry_run,
    include_with_memory: args.include_with_memory,
    orphan_count: orphans.length,
    deleted_count: deleted.length,
    total_bytes_freed: deleted.reduce((s, d) => s + d.bytes, 0),
    deleted,
    skipped
  }
}
