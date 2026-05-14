/**
 * Append-only JSONL audit log for tool invocations.
 *
 * Scope is controlled by MCP_CLAUDE_HOUSEKEEPING_AUDIT_LOG: `off` (no logging),
 * `writes` (default — `_cleaner_` tools only), or `all` (every tool).
 * Path is configurable via MCP_CLAUDE_HOUSEKEEPING_AUDIT_LOG_PATH; defaults to
 * `<MCP_CLAUDE_HOUSEKEEPING_PATH>/audit/audit.jsonl`.
 *
 * Failures to write the audit line are swallowed (stderr only) — a broken log
 * must never prevent a tool call from completing.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { AUDIT_LOG_MODE, AUDIT_LOG_PATH } from '../config.js'

export interface AuditEvent {
  ts: string
  server: string
  tool: string
  role: 'auditor' | 'cleaner'
  ok: boolean
  duration_ms: number
  error?: string
  args: unknown
}

const SERVER_NAME = 'mcp-claude-housekeeping'
const MAX_ARG_CHARS = 4096

const sanitizeArgs = (args: unknown): unknown => {
  // Top-level redaction: drop bulky string fields that would bloat the log
  // (memory `content`, audit `content`). Then JSON-stringify and truncate as
  // a final safety net for anything else surprisingly large.
  let safe: unknown = args
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    const copy: Record<string, unknown> = { ...(args as Record<string, unknown>) }
    if (typeof copy.content === 'string') {
      copy.content = `[redacted ${Buffer.byteLength(copy.content, 'utf-8')}B]`
    }
    safe = copy
  }
  const serialized = JSON.stringify(safe)
  if (serialized.length > MAX_ARG_CHARS) {
    return { _truncated: true, preview: serialized.slice(0, MAX_ARG_CHARS) }
  }
  return safe
}

// Once per process, chmod the log to 0o600 after the first successful append
// — covers logs created before this safeguard existed (which would otherwise
// keep 0o644). `appendFile`'s `mode` option only applies on creation.
let chmodEnsured = false

export const appendAuditEvent = async (event: AuditEvent): Promise<void> => {
  try {
    await fs.mkdir(path.dirname(AUDIT_LOG_PATH), { recursive: true })
    await fs.appendFile(AUDIT_LOG_PATH, `${JSON.stringify(event)}\n`, { encoding: 'utf-8', mode: 0o600 })
    if (!chmodEnsured) {
      try {
        await fs.chmod(AUDIT_LOG_PATH, 0o600)
      } catch {
        // best-effort — log may have been rotated/removed between write and chmod
      }
      chmodEnsured = true
    }
  } catch (err) {
    console.error(`[audit-log] failed to write: ${err instanceof Error ? err.message : String(err)}`)
  }
}

type ToolCallback = (...callbackArgs: unknown[]) => unknown | Promise<unknown>

/**
 * Wrap a tool callback so each invocation appends an audit event. Cleaner
 * tools are always logged; auditor tools only when AUDIT_LOG_ALL is set.
 */
export const withAuditLog = (toolName: string, role: 'auditor' | 'cleaner', callback: ToolCallback): ToolCallback => {
  if (AUDIT_LOG_MODE === 'off') return callback
  if (role === 'auditor' && AUDIT_LOG_MODE !== 'all') return callback
  return async (...callbackArgs: unknown[]) => {
    const start = Date.now()
    const args = callbackArgs[0]
    try {
      const result = await callback(...callbackArgs)
      const isError = typeof result === 'object' && result !== null && (result as { isError?: boolean }).isError === true
      const errText = isError ? extractErrorText(result) : undefined
      void appendAuditEvent({
        ts: new Date().toISOString(),
        server: SERVER_NAME,
        tool: toolName,
        role,
        ok: !isError,
        duration_ms: Date.now() - start,
        error: errText,
        args: sanitizeArgs(args)
      })
      return result
    } catch (err) {
      void appendAuditEvent({
        ts: new Date().toISOString(),
        server: SERVER_NAME,
        tool: toolName,
        role,
        ok: false,
        duration_ms: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
        args: sanitizeArgs(args)
      })
      throw err
    }
  }
}

const extractErrorText = (result: unknown): string | undefined => {
  const content = (result as { content?: { type: string; text: string }[] }).content
  if (!Array.isArray(content)) return undefined
  const first = content.find((c) => c.type === 'text')
  return first?.text
}
