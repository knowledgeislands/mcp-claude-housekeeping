import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sessionRename } from './sessions.js'

const ROOT = path.join(os.tmpdir(), 'mcp-housekeeping-session-rename-tests')

const UUID_A = '0006747e-b6a4-46e8-8e2f-c435398c9235'
const UUID_B = '00c442c0-b5cc-4f60-af28-3f3985c1ee5b'
const UUID_C = '00d5bc01-5005-4822-950b-27bd48cece72'

const writeSession = async (uuid: string, body: Record<string, unknown>, mtime?: Date): Promise<string> => {
  const p = path.join(ROOT, `local_${uuid}.json`)
  await fs.writeFile(p, JSON.stringify(body, null, 2), 'utf-8')
  if (mtime) await fs.utimes(p, mtime, mtime)
  return p
}

// Most tests exercise the actual rename (write path); default dry_run to false.
// Dedicated tests below pass dry_run: true to exercise the preview path.
const rename = (root: string, args: { session_id?: string; name: string; dry_run?: boolean }) => sessionRename(root, { dry_run: false, ...args })

beforeAll(async () => {
  await fs.mkdir(ROOT, { recursive: true })
})

afterAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true })
})

beforeEach(async () => {
  const entries = await fs.readdir(ROOT).catch(() => [])
  await Promise.all(entries.map((e) => fs.rm(path.join(ROOT, e), { recursive: true, force: true })))
})

describe('sessionRename', () => {
  it('updates the title of the named session and preserves other fields', async () => {
    const p = await writeSession(UUID_A, {
      sessionId: `local_${UUID_A}`,
      title: 'old title',
      processName: 'clever-quirky-gauss',
      lastActivityAt: 1
    })

    const result = await rename(ROOT, { session_id: UUID_A, name: 'kit-legal · inbound scan · 2026-05-20' })
    expect(result.session_id).toBe(UUID_A)
    expect(result.previous_title).toBe('old title')
    expect(result.new_title).toBe('kit-legal · inbound scan · 2026-05-20')
    expect(result.auto_selected).toBe(false)
    expect(result.dry_run).toBe(false)
    expect(result.renamed).toBe(true)

    const after = JSON.parse(await fs.readFile(p, 'utf-8'))
    expect(after.title).toBe('kit-legal · inbound scan · 2026-05-20')
    expect(after.sessionId).toBe(`local_${UUID_A}`)
    expect(after.processName).toBe('clever-quirky-gauss')
    expect(after.lastActivityAt).toBe(1)
  })

  it('reports previous_title=null when the field was absent', async () => {
    await writeSession(UUID_A, { sessionId: `local_${UUID_A}` })
    const result = await rename(ROOT, { session_id: UUID_A, name: 'first label' })
    expect(result.previous_title).toBeNull()
    expect(result.new_title).toBe('first label')
  })

  it('accepts emoji in the name', async () => {
    await writeSession(UUID_A, {})
    const result = await rename(ROOT, { session_id: UUID_A, name: '🦊 fox-trot · planning' })
    expect(result.new_title).toBe('🦊 fox-trot · planning')
  })

  it('auto-selects the session with the most recent lastActivityAt when session_id is omitted', async () => {
    await writeSession(UUID_A, { lastActivityAt: 100 })
    await writeSession(UUID_B, { lastActivityAt: 300 })
    await writeSession(UUID_C, { lastActivityAt: 200 })

    const result = await rename(ROOT, { name: 'auto-picked' })
    expect(result.session_id).toBe(UUID_B)
    expect(result.auto_selected).toBe(true)
  })

  it('auto-select falls back to mtime when lastActivityAt is missing or non-numeric', async () => {
    const long = new Date(Date.now() - 10_000_000)
    await writeSession(UUID_A, { lastActivityAt: 'nope' }, long)
    await writeSession(UUID_B, {}, new Date())

    const result = await rename(ROOT, { name: 'fallback' })
    expect(result.session_id).toBe(UUID_B)
  })

  it('throws when no sessions exist and session_id is omitted', async () => {
    await expect(rename(ROOT, { name: 'nothing' })).rejects.toThrow(/No local_\*\.json sessions/)
  })

  it('throws when the named session does not exist', async () => {
    await expect(rename(ROOT, { session_id: UUID_A, name: 'x' })).rejects.toThrow(/Session record not found/)
  })

  it('rejects an empty name', async () => {
    await writeSession(UUID_A, {})
    await expect(rename(ROOT, { session_id: UUID_A, name: '' })).rejects.toThrow(/must not be empty/)
  })

  it('rejects names longer than 80 chars', async () => {
    await writeSession(UUID_A, {})
    await expect(rename(ROOT, { session_id: UUID_A, name: 'x'.repeat(81) })).rejects.toThrow(/too long/)
  })

  it('rejects control characters (newline)', async () => {
    await writeSession(UUID_A, {})
    await expect(rename(ROOT, { session_id: UUID_A, name: 'line1\nline2' })).rejects.toThrow(/control characters/)
  })

  it('rejects an invalid session_id (uppercase, missing dashes, traversal)', async () => {
    await expect(rename(ROOT, { session_id: '../escape', name: 'x' })).rejects.toThrow(/Invalid session id/)
    await expect(rename(ROOT, { session_id: UUID_A.toUpperCase(), name: 'x' })).rejects.toThrow(/Invalid session id/)
    await expect(rename(ROOT, { session_id: `local_${UUID_A}`, name: 'x' })).rejects.toThrow(/Invalid session id/)
  })

  it('does not leave a .tmp file behind on success', async () => {
    await writeSession(UUID_A, {})
    await rename(ROOT, { session_id: UUID_A, name: 'clean' })
    const entries = await fs.readdir(ROOT)
    expect(entries.some((e) => e.includes('.tmp-'))).toBe(false)
  })

  it('auto-select ignores non-file entries and non-matching file names', async () => {
    // A subdirectory and an unrelated file must both be skipped by collectSessions.
    await fs.mkdir(path.join(ROOT, 'subdir'), { recursive: true })
    await fs.writeFile(path.join(ROOT, 'not-a-session.json'), '{}', 'utf-8')
    await writeSession(UUID_A, { lastActivityAt: 5 })

    const result = await rename(ROOT, { name: 'picked' })
    expect(result.session_id).toBe(UUID_A)
    expect(result.auto_selected).toBe(true)
  })

  it('treats a missing workspace dir as no sessions when auto-selecting', async () => {
    const missing = path.join(ROOT, 'does-not-exist')
    await expect(rename(missing, { name: 'x' })).rejects.toThrow(/No local_\*\.json sessions/)
  })

  it('rethrows a non-ENOENT readdir error while collecting sessions (EACCES via chmod 0)', async () => {
    const blocked = path.join(ROOT, 'blocked-workspace')
    await fs.mkdir(blocked, { recursive: true })
    await fs.chmod(blocked, 0o000)
    try {
      await expect(rename(blocked, { name: 'x' })).rejects.toThrow(/EACCES|permission/i)
    } finally {
      await fs.chmod(blocked, 0o755)
    }
  })

  it('rethrows a non-ENOENT readFile error (session path is a directory → EISDIR)', async () => {
    // Make local_<uuid>.json a *directory* so readFile fails with EISDIR/EPERM
    // rather than ENOENT, exercising the rethrow branch.
    await fs.mkdir(path.join(ROOT, `local_${UUID_A}.json`), { recursive: true })
    await expect(rename(ROOT, { session_id: UUID_A, name: 'x' })).rejects.toThrow(/EISDIR|EPERM|illegal operation|is a directory/i)
  })

  it('dry_run previews the rename without writing the record', async () => {
    const p = await writeSession(UUID_A, { sessionId: `local_${UUID_A}`, title: 'old title', lastActivityAt: 1 })
    const result = await sessionRename(ROOT, { session_id: UUID_A, name: 'preview label', dry_run: true })
    expect(result.dry_run).toBe(true)
    expect(result.renamed).toBe(false)
    expect(result.previous_title).toBe('old title')
    expect(result.new_title).toBe('preview label')
    expect(result.auto_selected).toBe(false)
    // The record on disk is untouched.
    const after = JSON.parse(await fs.readFile(p, 'utf-8'))
    expect(after.title).toBe('old title')
  })

  it('dry_run still auto-selects the most-recently-active session and validates the name', async () => {
    await writeSession(UUID_A, { lastActivityAt: 100 })
    await writeSession(UUID_B, { lastActivityAt: 300 })
    const result = await sessionRename(ROOT, { name: 'auto preview', dry_run: true })
    expect(result.session_id).toBe(UUID_B)
    expect(result.auto_selected).toBe(true)
    expect(result.dry_run).toBe(true)
    expect(result.renamed).toBe(false)
    // Invalid names are rejected before the dry_run short-circuit, too.
    await expect(sessionRename(ROOT, { session_id: UUID_A, name: '', dry_run: true })).rejects.toThrow(/must not be empty/)
  })
})
