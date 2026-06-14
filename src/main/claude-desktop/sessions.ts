import type { Dirent } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { assertRealPathWithinRoot, isNodeError, resolveWithinRoot } from '../../utils/utils.js'

// Bare lower-case UUID; rejects any character that could become a path segment.
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SESSION_JSON_RE = /^local_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/

export const SESSION_NAME_MAX = 80

const sessionJsonPath = (workspaceRoot: string, sessionId: string): string => {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error(`Invalid session id "${sessionId}" (expected lower-case UUID)`)
  }
  return resolveWithinRoot(workspaceRoot, `local_${sessionId}.json`)
}

interface CandidateSession {
  sessionId: string
  mtime: number
  lastActivityAt: number | null
}

const collectSessions = async (workspaceRoot: string): Promise<CandidateSession[]> => {
  let entries: Dirent[]
  try {
    entries = (await fs.readdir(workspaceRoot, { withFileTypes: true })) as Dirent[]
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return []
    throw err
  }
  const out: CandidateSession[] = []
  for (const e of entries) {
    if (!e.isFile()) continue
    const m = SESSION_JSON_RE.exec(e.name)
    if (!m) continue
    const sessionId = m[1] as string
    const p = path.join(workspaceRoot, e.name)
    const stat = await fs.stat(p)
    let lastActivityAt: number | null = null
    try {
      const parsed = JSON.parse(await fs.readFile(p, 'utf-8')) as { lastActivityAt?: unknown }
      if (typeof parsed.lastActivityAt === 'number') lastActivityAt = parsed.lastActivityAt
    } catch {
      // Unparseable record — fall back to mtime alone.
    }
    out.push({ sessionId, mtime: stat.mtime.getTime(), lastActivityAt })
  }
  return out
}

// Auto-pick heuristic: the active session is the one whose record was touched
// most recently. Prefer the in-file `lastActivityAt` (set by Cowork at each
// turn) over mtime so a stray external touch doesn't win.
const pickMostRecentSession = async (workspaceRoot: string): Promise<string> => {
  const sessions = await collectSessions(workspaceRoot)
  if (sessions.length === 0) {
    throw new Error('No local_*.json sessions found in the target workspace')
  }
  sessions.sort((a, b) => (b.lastActivityAt ?? b.mtime) - (a.lastActivityAt ?? a.mtime))
  return (sessions[0] as CandidateSession).sessionId
}

const validateName = (name: string): void => {
  if (name.length === 0) throw new Error('Session name must not be empty')
  if (name.length > SESSION_NAME_MAX) {
    throw new Error(`Session name too long (${name.length} chars, max ${SESSION_NAME_MAX})`)
  }
  // Reject ASCII control characters (incl. newline/tab) but allow non-ASCII (emoji safe).
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) {
      throw new Error('Session name must not contain control characters')
    }
  }
}

export const sessionRename = async (
  workspaceRoot: string,
  args: { session_id?: string; name: string; dry_run: boolean }
): Promise<{ session_id: string; previous_title: string | null; new_title: string; auto_selected: boolean; dry_run: boolean; renamed: boolean }> => {
  validateName(args.name)
  const autoSelected = args.session_id === undefined
  const sessionId = args.session_id ?? (await pickMostRecentSession(workspaceRoot))
  const p = sessionJsonPath(workspaceRoot, sessionId)
  await assertRealPathWithinRoot(workspaceRoot, p)

  let raw: string
  try {
    raw = await fs.readFile(p, 'utf-8')
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      throw new Error(`Session record not found: local_${sessionId}.json`)
    }
    throw err
  }
  const record = JSON.parse(raw) as Record<string, unknown>
  const previous = typeof record.title === 'string' ? record.title : null

  // dry_run previews the selected session and what the title would become,
  // without touching the record — matching the repo's other mutating tools.
  if (args.dry_run) {
    return {
      session_id: sessionId,
      previous_title: previous,
      new_title: args.name,
      auto_selected: autoSelected,
      dry_run: true,
      renamed: false
    }
  }

  record.title = args.name

  // Atomic replace: write to a sibling temp file and rename. Keeps the same
  // directory (rename is atomic on the same filesystem) so Cowork's own
  // writers either see the old record or the new one, never a half-written
  // partial.
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`
  await fs.writeFile(tmp, JSON.stringify(record, null, 2), 'utf-8')
  try {
    await fs.rename(tmp, p)
  } catch (err) {
    await fs.rm(tmp, { force: true })
    throw err
  }

  return {
    session_id: sessionId,
    previous_title: previous,
    new_title: args.name,
    auto_selected: autoSelected,
    dry_run: false,
    renamed: true
  }
}
