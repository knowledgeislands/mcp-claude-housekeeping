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
    delete process.env.MCP_CLAUDE_HOUSEKEEPING_AUDIT_LOG_ALL
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

  it('skips auditor tools when AUDIT_LOG_ALL is unset', async () => {
    const { withAuditLog } = await import('./audit-log.js')
    const handler = vi.fn(async () => ({ content: [{ type: 'text', text: '{}' }] }))
    const wrapped = withAuditLog('claude_code_auditor_test', 'auditor', handler)
    // When auditor logging is disabled, withAuditLog returns the handler verbatim.
    expect(wrapped).toBe(handler)
  })

  it('logs auditor tools when AUDIT_LOG_ALL=1', async () => {
    process.env.MCP_CLAUDE_HOUSEKEEPING_AUDIT_LOG_ALL = '1'
    const { withAuditLog } = await import('./audit-log.js')
    const wrapped = withAuditLog('claude_code_auditor_test', 'auditor', async () => ({ content: [{ type: 'text', text: '{}' }] }))
    expect(wrapped).not.toBeUndefined()
    await wrapped({})
    await new Promise((r) => setTimeout(r, 20))
    const event = JSON.parse((await fs.readFile(logPath, 'utf-8')).trim())
    expect(event.role).toBe('auditor')
  })
})
