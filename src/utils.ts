import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

/**
 * Resolve a relative path against a root directory and reject any traversal
 * outside that root. Mirrors the safety pattern from mcp-kb.
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

export const errorResult = (message: string) => {
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: message }]
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
