import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('appendAuditEvent / withAuditLog', () => {
  const tmpDir = path.join(os.tmpdir(), 'audit-log-tests', `run-${process.pid}-${Date.now()}`)
  const logPath = path.join(tmpDir, 'audit.jsonl')

  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true })
    vi.resetModules()
    process.env.MCP_CLAUDE_HOUSEKEEPING_AUDIT_LOG_PATH = logPath
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
    delete process.env.MCP_CLAUDE_HOUSEKEEPING_AUDIT_LOG_PATH
    delete process.env.MCP_CLAUDE_HOUSEKEEPING_AUDIT_LOG
    delete process.env.MCP_CLAUDE_HOUSEKEEPING_AUDIT_LOG_MAX_BYTES
    delete process.env.MCP_CLAUDE_HOUSEKEEPING_AUDIT_LOG_KEEP
  })

  it('appends an event line for a cleaner tool', async () => {
    const { withAuditLog } = await import('./audit-log.js')
    const wrapped = withAuditLog('claude_code_cleaner_test', 'cleaner', async () => ({ content: [{ type: 'text', text: '{}' }] }))
    await wrapped({ name: 'memo.md' })
    // appendAuditEvent fires via void, so wait a tick
    await new Promise((r) => setTimeout(r, 20))
    const raw = await fs.readFile(logPath, 'utf-8')
    const event = JSON.parse(raw.trim())
    expect(event.tool).toBe('claude_code_cleaner_test')
    expect(event.role).toBe('cleaner')
    expect(event.ok).toBe(true)
    expect(event.args).toEqual({ name: 'memo.md' })
  })

  it('redacts large content fields', async () => {
    const { withAuditLog } = await import('./audit-log.js')
    const wrapped = withAuditLog('claude_code_cleaner_test', 'cleaner', async () => ({ content: [{ type: 'text', text: '{}' }] }))
    await wrapped({ name: 'memo.md', content: 'x'.repeat(5000) })
    await new Promise((r) => setTimeout(r, 20))
    const event = JSON.parse((await fs.readFile(logPath, 'utf-8')).trim())
    expect(event.args.content).toMatch(/^\[redacted \d+B\]$/)
  })

  it('records ok:false and error text when tool result is isError', async () => {
    const { withAuditLog } = await import('./audit-log.js')
    const wrapped = withAuditLog('claude_code_cleaner_test', 'cleaner', async () => ({ isError: true, content: [{ type: 'text', text: 'boom' }] }))
    await wrapped({})
    await new Promise((r) => setTimeout(r, 20))
    const event = JSON.parse((await fs.readFile(logPath, 'utf-8')).trim())
    expect(event.ok).toBe(false)
    expect(event.error).toBe('boom')
  })

  it('records ok:false when the handler throws', async () => {
    const { withAuditLog } = await import('./audit-log.js')
    const wrapped = withAuditLog('claude_code_cleaner_test', 'cleaner', async () => {
      throw new Error('kaboom')
    })
    await expect(wrapped({})).rejects.toThrow(/kaboom/)
    await new Promise((r) => setTimeout(r, 20))
    const event = JSON.parse((await fs.readFile(logPath, 'utf-8')).trim())
    expect(event.ok).toBe(false)
    expect(event.error).toBe('kaboom')
  })

  it('skips auditor tools by default (mode=writes)', async () => {
    const { withAuditLog } = await import('./audit-log.js')
    const handler = vi.fn(async () => ({ content: [{ type: 'text', text: '{}' }] }))
    const wrapped = withAuditLog('claude_code_auditor_test', 'auditor', handler)
    // When auditor logging is disabled, withAuditLog returns the handler verbatim.
    expect(wrapped).toBe(handler)
  })

  it('logs auditor tools when AUDIT_LOG=all', async () => {
    process.env.MCP_CLAUDE_HOUSEKEEPING_AUDIT_LOG = 'all'
    const { withAuditLog } = await import('./audit-log.js')
    const wrapped = withAuditLog('claude_code_auditor_test', 'auditor', async () => ({ content: [{ type: 'text', text: '{}' }] }))
    expect(wrapped).not.toBeUndefined()
    await wrapped({})
    await new Promise((r) => setTimeout(r, 20))
    const event = JSON.parse((await fs.readFile(logPath, 'utf-8')).trim())
    expect(event.role).toBe('auditor')
  })

  it('skips every tool — auditor and cleaner — when AUDIT_LOG=off', async () => {
    process.env.MCP_CLAUDE_HOUSEKEEPING_AUDIT_LOG = 'off'
    const { withAuditLog } = await import('./audit-log.js')
    const cleaner = vi.fn(async (_args: unknown) => ({ content: [{ type: 'text', text: '{}' }] }))
    const auditor = vi.fn(async (_args: unknown) => ({ content: [{ type: 'text', text: '{}' }] }))
    // Both return the original handler verbatim — no wrapping, no file I/O.
    expect(withAuditLog('claude_code_cleaner_test', 'cleaner', cleaner)).toBe(cleaner)
    expect(withAuditLog('claude_code_auditor_test', 'auditor', auditor)).toBe(auditor)
    await cleaner({})
    await new Promise((r) => setTimeout(r, 20))
    // No audit file should have been created.
    await expect(fs.access(logPath)).rejects.toThrow()
  })

  it('rejects unknown AUDIT_LOG values at config load', async () => {
    process.env.MCP_CLAUDE_HOUSEKEEPING_AUDIT_LOG = 'sometimes'
    await expect(import('./audit-log.js')).rejects.toThrow(/Invalid MCP_CLAUDE_HOUSEKEEPING_AUDIT_LOG/)
  })

  it('creates the audit log with mode 0o600 and chmods an existing 0o644 log down to 0o600', async () => {
    // Pre-create the log with the world-readable default so we exercise the
    // chmod path, not just the appendFile(mode) creation path.
    await fs.mkdir(path.dirname(logPath), { recursive: true })
    await fs.writeFile(logPath, '', { mode: 0o644 })
    expect(((await fs.stat(logPath)).mode & 0o777).toString(8)).toBe('644')

    const { withAuditLog } = await import('./audit-log.js')
    const wrapped = withAuditLog('claude_code_cleaner_test', 'cleaner', async () => ({ content: [{ type: 'text', text: '{}' }] }))
    await wrapped({ name: 'memo.md' })
    await new Promise((r) => setTimeout(r, 20))

    const mode = (await fs.stat(logPath)).mode & 0o777
    expect(mode.toString(8)).toBe('600')
  })

  it('rotates the log when it exceeds MAX_BYTES — keeping the last KEEP archives', async () => {
    // Tiny cap (200 bytes) so one append crosses it, and keep=2 so we exercise
    // both the shift (.1 → .2) and the drop (.2 oldest goes away).
    process.env.MCP_CLAUDE_HOUSEKEEPING_AUDIT_LOG_MAX_BYTES = '200'
    process.env.MCP_CLAUDE_HOUSEKEEPING_AUDIT_LOG_KEEP = '2'

    const { withAuditLog } = await import('./audit-log.js')
    const wrapped = withAuditLog('claude_code_cleaner_test', 'cleaner', async () => ({ content: [{ type: 'text', text: '{}' }] }))

    // Each call produces a ~250-byte event line, so every append rotates.
    await wrapped({ note: 'first', padding: 'x'.repeat(100) })
    await new Promise((r) => setTimeout(r, 20))
    await wrapped({ note: 'second', padding: 'y'.repeat(100) })
    await new Promise((r) => setTimeout(r, 20))
    await wrapped({ note: 'third', padding: 'z'.repeat(100) })
    await new Promise((r) => setTimeout(r, 20))

    // After three rotating appends:
    //   - audit.jsonl    holds nothing yet (or the next event if a fourth append fires)
    //   - audit.jsonl.1  holds the third event (most recent before live)
    //   - audit.jsonl.2  holds the second event
    //   - audit.jsonl.3  must NOT exist (would exceed keep=2)
    const r1 = await fs.readFile(`${logPath}.1`, 'utf-8')
    const r2 = await fs.readFile(`${logPath}.2`, 'utf-8')
    expect(r1).toMatch(/"note":"third"/)
    expect(r2).toMatch(/"note":"second"/)
    await expect(fs.access(`${logPath}.3`)).rejects.toThrow()
  })

  it('does not rotate when MAX_BYTES=0 (rotation disabled)', async () => {
    process.env.MCP_CLAUDE_HOUSEKEEPING_AUDIT_LOG_MAX_BYTES = '0'
    process.env.MCP_CLAUDE_HOUSEKEEPING_AUDIT_LOG_KEEP = '2'

    const { withAuditLog } = await import('./audit-log.js')
    const wrapped = withAuditLog('claude_code_cleaner_test', 'cleaner', async () => ({ content: [{ type: 'text', text: '{}' }] }))
    await wrapped({ note: 'a', padding: 'x'.repeat(500) })
    await wrapped({ note: 'b', padding: 'y'.repeat(500) })
    await new Promise((r) => setTimeout(r, 20))

    // Both lines should live in the same live file; no rotation files created.
    const live = await fs.readFile(logPath, 'utf-8')
    expect(live).toMatch(/"note":"a"/)
    expect(live).toMatch(/"note":"b"/)
    await expect(fs.access(`${logPath}.1`)).rejects.toThrow()
  })

  it('truncates without preserving history when KEEP=0', async () => {
    process.env.MCP_CLAUDE_HOUSEKEEPING_AUDIT_LOG_MAX_BYTES = '200'
    process.env.MCP_CLAUDE_HOUSEKEEPING_AUDIT_LOG_KEEP = '0'

    const { withAuditLog } = await import('./audit-log.js')
    const wrapped = withAuditLog('claude_code_cleaner_test', 'cleaner', async () => ({ content: [{ type: 'text', text: '{}' }] }))
    await wrapped({ note: 'first', padding: 'x'.repeat(100) })
    await wrapped({ note: 'second', padding: 'y'.repeat(100) })
    await new Promise((r) => setTimeout(r, 20))

    // KEEP=0 means rotation just unlinks the live file rather than archiving it.
    await expect(fs.access(`${logPath}.1`)).rejects.toThrow()
  })

  it('rejects an invalid MAX_BYTES value at config load', async () => {
    process.env.MCP_CLAUDE_HOUSEKEEPING_AUDIT_LOG_MAX_BYTES = '-5'
    await expect(import('./audit-log.js')).rejects.toThrow(/MCP_CLAUDE_HOUSEKEEPING_AUDIT_LOG_MAX_BYTES.*non-negative/)
  })
})
