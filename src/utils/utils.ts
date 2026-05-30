import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

/**
 * Lexical guard: resolve a relative path against a root and reject any
 * traversal that escapes the root (handles "..", absolute-style inputs, etc).
 *
 * This is a fast, FS-free check. Pair with assertRealPathWithinRoot for
 * symlink-aware verification before touching the filesystem.
 */
export const resolveWithinRoot = (root: string, relativePath: string): string => {
  const cleaned = relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
  const resolved = path.resolve(root, cleaned)
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new Error(`Path escapes root: "${relativePath}"`)
  }
  return resolved
}

/**
 * Physical guard: resolve symlinks and verify the target really lives inside
 * the root. Catches symlink-based escapes that the lexical check cannot see.
 *
 * For paths that don't exist yet (e.g. a new write target), realpaths the
 * deepest existing ancestor — that ancestor must be inside the realpath of
 * the root.
 */
export const assertRealPathWithinRoot = async (root: string, absPath: string): Promise<void> => {
  const realRoot = await fs.realpath(root)

  let probe = absPath
  while (probe !== path.dirname(probe)) {
    try {
      await fs.access(probe)
      break
    } catch {
      probe = path.dirname(probe)
    }
  }
  const realProbe = await fs.realpath(probe)

  // fs.realpath always strips a trailing separator, so realRoot never ends
  // with one — concatenate unconditionally.
  const realRootWithSep = realRoot + path.sep
  if (realProbe !== realRoot && !realProbe.startsWith(realRootWithSep)) {
    throw new Error(`Path escapes root: "${path.relative(root, absPath)}"`)
  }
}

export const errMessage = (err: unknown): string => {
  return err instanceof Error ? err.message : String(err)
}

export const errorResult = (action: string, error: unknown) => {
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: `Error ${action}: ${errMessage(error)}` }]
  }
}

export const jsonResult = (payload: unknown) => {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }]
  }
}

export const isNodeError = (err: unknown): err is NodeJS.ErrnoException => {
  return err instanceof Error && 'code' in err
}

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export const daysAgo = (date: Date | number): number => {
  const t = typeof date === 'number' ? date : date.getTime()
  return Math.floor((Date.now() - t) / (1000 * 60 * 60 * 24))
}

/**
 * Run `du -sk <target>` and return size in bytes. Returns 0 if the path
 * is missing. Falls back to a JS walk only if `du` is unavailable.
 */
export const duBytes = async (target: string): Promise<number> => {
  const kb = await runDuSk(target)
  return kb * 1024
}

const runDuSk = async (target: string): Promise<number> => {
  return new Promise((resolve, reject) => {
    const proc = spawn('du', ['-sk', target])
    let out = ''
    let err = ''
    proc.stdout.on('data', (chunk) => {
      out += chunk.toString()
    })
    proc.stderr.on('data', (chunk) => {
      err += chunk.toString()
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0 && !out) {
        if (err.includes('No such file')) {
          resolve(0)
          return
        }
        reject(new Error(`du failed (${code}): ${err.trim()}`))
        return
      }
      const match = out.split(/\s+/)[0]
      const kb = Number(match)
      /* v8 ignore next -- du always emits a finite size on success; the fallback is purely defensive against unparseable output. */
      resolve(Number.isFinite(kb) ? kb : 0)
    })
  })
}

export interface SizedEntry {
  name: string
  bytes: number
}

/**
 * du -sk for each direct entry in `dir`, sorted descending by size.
 * Excludes hidden entries unless includeHidden is true.
 */
export const duEntries = async (dir: string, includeHidden = false): Promise<SizedEntry[]> => {
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return []
    throw err
  }
  const filtered = includeHidden ? entries : entries.filter((e) => !e.startsWith('.'))
  const results = await Promise.all(
    filtered.map(async (name) => ({
      name,
      bytes: await duBytes(path.join(dir, name))
    }))
  )
  results.sort((a, b) => b.bytes - a.bytes)
  return results
}

export const pathExists = async (p: string): Promise<boolean> => {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

export const readJsonIfExists = async <T = unknown>(p: string): Promise<T | null> => {
  try {
    const raw = await fs.readFile(p, 'utf-8')
    return JSON.parse(raw) as T
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return null
    throw err
  }
}

export interface Workspace {
  id: string
  root: string
}

const WORKSPACE_MARKERS = ['.claude.json', 'artifacts.json', 'spaces.json', 'cowork_settings.json']

const isWorkspaceDir = async (dir: string): Promise<boolean> => {
  for (const marker of WORKSPACE_MARKERS) {
    if (await pathExists(path.join(dir, marker))) return true
  }
  try {
    const entries = await fs.readdir(dir)
    if (entries.some((e) => /^local_.*\.json$/.test(e))) return true
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return false
    if (isNodeError(err) && err.code === 'ENOTDIR') return false
    throw err
  }
  return false
}

/**
 * Discover Cowork workspace directories under `root`.
 *
 * Layout: `<root>/<account_uuid>/<workspace_uuid>/` where the workspace dir
 * contains `.claude.json`, `artifacts.json`, `spaces.json`, `cowork_settings.json`,
 * or `local_*.json`. If `root` itself looks like a workspace, return it as a single
 * workspace with id `.` (back-compat with hard-coded inner-UUID configs).
 */
export const discoverWorkspaces = async (root: string): Promise<Workspace[]> => {
  if (await isWorkspaceDir(root)) return [{ id: '.', root }]

  const workspaces: Workspace[] = []
  let level1: import('node:fs').Dirent[]
  try {
    level1 = (await fs.readdir(root, { withFileTypes: true })) as import('node:fs').Dirent[]
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return []
    throw err
  }
  for (const a of level1) {
    if (!a.isDirectory()) continue
    const accountDir = path.join(root, a.name)
    let level2: import('node:fs').Dirent[]
    try {
      level2 = (await fs.readdir(accountDir, { withFileTypes: true })) as import('node:fs').Dirent[]
    } catch (err) {
      if (isNodeError(err) && (err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'EPERM')) continue
      throw err
    }
    for (const w of level2) {
      if (!w.isDirectory()) continue
      const workspaceDir = path.join(accountDir, w.name)
      if (await isWorkspaceDir(workspaceDir)) {
        workspaces.push({ id: `${a.name}/${w.name}`, root: workspaceDir })
      }
    }
  }
  workspaces.sort((a, b) => a.id.localeCompare(b.id))
  return workspaces
}
