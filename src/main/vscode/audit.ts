import type { Dirent } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { assertRealPathWithinRoot, daysAgo, duBytes, isNodeError, pathExists, readJsonIfExists, resolveWithinRoot } from '../../utils/utils.js'

const DAY_MS = 1000 * 60 * 60 * 24

interface VscodeWorkspaceJson {
  workspace?: string
  folder?: string
}

export interface VscodeWorkspace {
  /** workspaceStorage subdir name (hex id). */
  id: string
  /** Absolute path to the workspaceStorage subdir. */
  dir: string
  /** Original workspace URI from workspace.json (if present). */
  workspace_uri: string | null
  /** Absolute path to the chatSessions/ subdir. */
  chat_sessions_dir: string
  /** Session file names (`.json` or `.jsonl`). */
  session_files: string[]
}

const isSessionFile = (name: string): boolean => /\.jsonl?$/.test(name)

export const discoverWorkspaces = async (storageRoot: string): Promise<VscodeWorkspace[]> => {
  let entries: Dirent[]
  try {
    entries = (await fs.readdir(storageRoot, { withFileTypes: true })) as Dirent[]
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return []
    throw err
  }

  const workspaces: VscodeWorkspace[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const dir = path.join(storageRoot, e.name)
    const chatDir = path.join(dir, 'chatSessions')
    if (!(await pathExists(chatDir))) continue

    let sessionFiles: string[] = []
    try {
      const inner = await fs.readdir(chatDir, { withFileTypes: true })
      sessionFiles = inner.filter((i) => i.isFile() && isSessionFile(i.name)).map((i) => i.name)
    } catch (err) {
      /* v8 ignore next -- chatDir was confirmed by pathExists; ENOENT here would require a mid-call removal, leaving only the EACCES rethrow branch reachable in practice. */
      if (!(isNodeError(err) && err.code === 'ENOENT')) throw err
    }

    const workspaceJson = await readJsonIfExists<VscodeWorkspaceJson>(path.join(dir, 'workspace.json'))
    const uri = workspaceJson?.workspace ?? workspaceJson?.folder ?? null

    workspaces.push({
      id: e.name,
      dir,
      workspace_uri: uri,
      chat_sessions_dir: chatDir,
      session_files: sessionFiles
    })
  }
  workspaces.sort((a, b) => a.id.localeCompare(b.id))
  return workspaces
}

/* ==================== workspaces list ==================== */

export const workspacesList = async (storageRoot: string) => {
  const workspaces = await discoverWorkspaces(storageRoot)
  const items = await Promise.all(
    workspaces.map(async (w) => {
      const bytes = await duBytes(w.chat_sessions_dir)
      return {
        id: w.id,
        workspace_uri: w.workspace_uri,
        session_count: w.session_files.length,
        bytes
      }
    })
  )
  items.sort((a, b) => b.bytes - a.bytes)
  return {
    workspace_storage: storageRoot,
    workspace_count: items.length,
    workspaces: items
  }
}

/* ==================== storage summary ==================== */

export const storageSummary = async (storageRoot: string, args: { flag_size_gb: number; flag_session_count: number }) => {
  const workspaces = await discoverWorkspaces(storageRoot)
  const totalSessions = workspaces.reduce((s, w) => s + w.session_files.length, 0)
  const chatBytesPerWorkspace = await Promise.all(workspaces.map((w) => duBytes(w.chat_sessions_dir)))
  const totalBytes = chatBytesPerWorkspace.reduce((s, b) => s + b, 0)

  const flagSizeBytes = args.flag_size_gb * 1024 * 1024 * 1024
  const flags: string[] = []
  if (totalBytes > flagSizeBytes) flags.push(`total_chat_size_exceeds_${args.flag_size_gb}gb`)
  if (totalSessions > args.flag_session_count) flags.push(`session_count_exceeds_${args.flag_session_count}`)

  return {
    workspace_storage: storageRoot,
    workspace_count: workspaces.length,
    session_count: totalSessions,
    total_chat_bytes: totalBytes,
    flags
  }
}

/* ==================== obsolete sessions ==================== */

const statMtime = async (file: string): Promise<number | null> => {
  try {
    const stat = await fs.stat(file)
    return stat.mtime.getTime()
    /* v8 ignore start -- file was just listed by readdir; stat only fails here if the file vanishes mid-call. */
  } catch {
    return null
  }
  /* v8 ignore stop */
}

export const obsoleteSessions = async (
  storageRoot: string,
  args: { older_than_days: number; flag_count: number; flag_size_mb: number; workspace?: string }
) => {
  const cutoff = Date.now() - args.older_than_days * DAY_MS
  const workspaces = await discoverWorkspaces(storageRoot)
  const target = args.workspace ? workspaces.filter((w) => w.id === args.workspace) : workspaces

  const obsolete: { workspace: string; session: string; mtime: number; bytes: number }[] = []
  for (const w of target) {
    for (const name of w.session_files) {
      const file = path.join(w.chat_sessions_dir, name)
      const mtime = await statMtime(file)
      if (mtime === null || mtime >= cutoff) continue
      const stat = await fs.stat(file)
      obsolete.push({ workspace: w.id, session: name, mtime, bytes: stat.size })
    }
  }

  obsolete.sort((a, b) => a.mtime - b.mtime)
  const totalBytes = obsolete.reduce((s, o) => s + o.bytes, 0)
  const top10 = obsolete.slice(0, 10).map((o) => ({
    workspace: o.workspace,
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

/* ==================== session read ==================== */

export const sessionRead = async (storageRoot: string, args: { workspace: string; session: string; max_lines: number; tail: boolean }) => {
  if (!isSessionFile(args.session)) {
    throw new Error(`Session name must end with .json or .jsonl`)
  }
  const workspaceDir = resolveWithinRoot(storageRoot, args.workspace)
  const file = resolveWithinRoot(workspaceDir, path.join('chatSessions', args.session))
  await assertRealPathWithinRoot(storageRoot, file)
  const stat = await fs.stat(file)
  const raw = await fs.readFile(file, 'utf-8')

  if (args.session.endsWith('.json')) {
    // Single-document JSON: return the parsed object (truncated to max_lines lines when stringified).
    const pretty = JSON.stringify(JSON.parse(raw), null, 2).split('\n')
    const picked = args.tail ? pretty.slice(-args.max_lines) : pretty.slice(0, args.max_lines)
    return {
      workspace: args.workspace,
      session: args.session,
      format: 'json' as const,
      bytes: stat.size,
      total_lines: pretty.length,
      lines: picked
    }
  }

  const lines = raw.split('\n').filter((l) => l.length > 0)
  const picked = args.tail ? lines.slice(-args.max_lines) : lines.slice(0, args.max_lines)
  return {
    workspace: args.workspace,
    session: args.session,
    format: 'jsonl' as const,
    bytes: stat.size,
    total_lines: lines.length,
    lines: picked
  }
}

/* ==================== sessions prune ==================== */

/* ==================== workspace delete ==================== */

/**
 * Delete an entire workspaceStorage/<id>/ entry. Useful for clearing out
 * orphaned workspaces (e.g. after a project folder is removed). The
 * `workspace_uri` field can be empty even on live workspaces, so this tool
 * does not infer orphan status — call from a caller that has confirmed it.
 */
export const workspaceDelete = async (storageRoot: string, args: { workspace: string; dry_run: boolean }) => {
  const dir = resolveWithinRoot(storageRoot, args.workspace)
  await assertRealPathWithinRoot(storageRoot, dir)
  if (!(await pathExists(dir))) {
    throw new Error(`Workspace not found: "${args.workspace}"`)
  }
  const bytes = await duBytes(dir)
  if (!args.dry_run) {
    await fs.rm(dir, { recursive: true, force: true })
  }
  return {
    workspace: args.workspace,
    dir,
    bytes,
    dry_run: args.dry_run,
    deleted: !args.dry_run
  }
}

export const sessionsPrune = async (storageRoot: string, args: { older_than_days: number; workspace?: string; dry_run: boolean }) => {
  const cutoff = Date.now() - args.older_than_days * DAY_MS
  const workspaces = await discoverWorkspaces(storageRoot)
  const target = args.workspace ? workspaces.filter((w) => w.id === args.workspace) : workspaces

  const deleted: { workspace: string; session: string; age_days: number; bytes: number }[] = []
  for (const w of target) {
    for (const name of w.session_files) {
      const file = path.join(w.chat_sessions_dir, name)
      const mtime = await statMtime(file)
      if (mtime === null || mtime >= cutoff) continue
      const stat = await fs.stat(file)
      if (!args.dry_run) await fs.unlink(file)
      deleted.push({ workspace: w.id, session: name, age_days: daysAgo(mtime), bytes: stat.size })
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
