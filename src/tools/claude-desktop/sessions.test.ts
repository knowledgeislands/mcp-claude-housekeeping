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

    const result = await sessionRename(ROOT, { session_id: UUID_A, name: 'kit-legal · inbound scan · 2026-05-20' })
    expect(result.session_id).toBe(UUID_A)
    expect(result.previous_title).toBe('old title')
    expect(result.new_title).toBe('kit-legal · inbound scan · 2026-05-20')
    expect(result.auto_selected).toBe(false)

    const after = JSON.parse(await fs.readFile(p, 'utf-8'))
    expect(after.title).toBe('kit-legal · inbound scan · 2026-05-20')
    expect(after.sessionId).toBe(`local_${UUID_A}`)
    expect(after.processName).toBe('clever-quirky-gauss')
    expect(after.lastActivityAt).toBe(1)
  })

  it('reports previous_title=null when the field was absent', async () => {
    await writeSession(UUID_A, { sessionId: `local_${UUID_A}` })
    const result = await sessionRename(ROOT, { session_id: UUID_A, name: 'first label' })
    expect(result.previous_title).toBeNull()
    expect(result.new_title).toBe('first label')
  })

  it('accepts emoji in the name', async () => {
    await writeSession(UUID_A, {})
    const result = await sessionRename(ROOT, { session_id: UUID_A, name: '🦊 fox-trot · planning' })
    expect(result.new_title).toBe('🦊 fox-trot · planning')
  })

  it('auto-selects the session with the most recent lastActivityAt when session_id is omitted', async () => {
    await writeSession(UUID_A, { lastActivityAt: 100 })
    await writeSession(UUID_B, { lastActivityAt: 300 })
    await writeSession(UUID_C, { lastActivityAt: 200 })

    const result = await sessionRename(ROOT, { name: 'auto-picked' })
    expect(result.session_id).toBe(UUID_B)
    expect(result.auto_selected).toBe(true)
  })

  it('auto-select falls back to mtime when lastActivityAt is missing or non-numeric', async () => {
    const long = new Date(Date.now() - 10_000_000)
    await writeSession(UUID_A, { lastActivityAt: 'nope' }, long)
    await writeSession(UUID_B, {}, new Date())

    const result = await sessionRename(ROOT, { name: 'fallback' })
    expect(result.session_id).toBe(UUID_B)
  })

  it('throws when no sessions exist and session_id is omitted', async () => {
    await expect(sessionRename(ROOT, { name: 'nothing' })).rejects.toThrow(/No local_\*\.json sessions/)
  })

  it('throws when the named session does not exist', async () => {
    await expect(sessionRename(ROOT, { session_id: UUID_A, name: 'x' })).rejects.toThrow(/Session record not found/)
  })

  it('rejects an empty name', async () => {
    await writeSession(UUID_A, {})
    await expect(sessionRename(ROOT, { session_id: UUID_A, name: '' })).rejects.toThrow(/must not be empty/)
  })

  it('rejects names longer than 80 chars', async () => {
    await writeSession(UUID_A, {})
    await expect(sessionRename(ROOT, { session_id: UUID_A, name: 'x'.repeat(81) })).rejects.toThrow(/too long/)
  })

  it('rejects control characters (newline)', async () => {
    await writeSession(UUID_A, {})
    await expect(sessionRename(ROOT, { session_id: UUID_A, name: 'line1\nline2' })).rejects.toThrow(/control characters/)
  })

  it('rejects an invalid session_id (uppercase, missing dashes, traversal)', async () => {
    await expect(sessionRename(ROOT, { session_id: '../escape', name: 'x' })).rejects.toThrow(/Invalid session id/)
    await expect(sessionRename(ROOT, { session_id: UUID_A.toUpperCase(), name: 'x' })).rejects.toThrow(/Invalid session id/)
    await expect(sessionRename(ROOT, { session_id: `local_${UUID_A}`, name: 'x' })).rejects.toThrow(/Invalid session id/)
  })

  it('does not leave a .tmp file behind on success', async () => {
    await writeSession(UUID_A, {})
    await sessionRename(ROOT, { session_id: UUID_A, name: 'clean' })
    const entries = await fs.readdir(ROOT)
    expect(entries.some((e) => e.includes('.tmp-'))).toBe(false)
  })
})
