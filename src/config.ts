import { strict as assert } from 'node:assert'
import * as os from 'node:os'
import * as path from 'node:path'

const expandHome = (p: string): string => {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p
}

try {
  process.loadEnvFile(`./.env.${process.env.NODE_ENV}`)
} catch {
  // no .env present — that's fine
}

assert(process.env.MCP_CLAUDE_HOUSEKEEPING_PATH, 'MCP_CLAUDE_HOUSEKEEPING_PATH environment variable must be set')

export const HOUSEKEEPING_PATH: string = path.resolve(expandHome(process.env.MCP_CLAUDE_HOUSEKEEPING_PATH))

export type Role = 'read' | 'write'
export const ALL_ROLES: readonly Role[] = ['read', 'write'] as const

const parseRoles = (raw: string | undefined): Set<Role> => {
  if (raw === undefined || raw.trim() === '') return new Set(['read'])
  const requested = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (requested.length === 0) return new Set(['read'])
  const invalid = requested.filter((r): r is string => !(ALL_ROLES as readonly string[]).includes(r))
  if (invalid.length > 0) {
    throw new Error(`Invalid MCP_CLAUDE_HOUSEKEEPING_ROLES entries: ${invalid.join(', ')}. Allowed: ${ALL_ROLES.join(', ')}`)
  }
  return new Set(requested as Role[])
}

export const HOUSEKEEPING_ROLES: ReadonlySet<Role> = parseRoles(process.env.MCP_CLAUDE_HOUSEKEEPING_ROLES)

// Cowork sessions, Claude Code state, and VSCode chat sessions all live in
// known locations under the current user's home directory; they are not
// user-configurable.
export const CLAUDE_DESKTOP_ROOT_PATH: string = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions')
export const CLAUDE_CODE_ROOT_PATH: string = path.join(os.homedir(), '.claude')
export const VSCODE_WORKSPACE_STORAGE_ROOT_PATH: string = path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage')

export const AUDIT_LOG_PATH: string = path.resolve(expandHome(process.env.MCP_CLAUDE_HOUSEKEEPING_AUDIT_LOG_PATH ?? path.join(HOUSEKEEPING_PATH, 'audit', 'audit.jsonl')))

/**
 * Scope of tool invocations to record. Default `writes` logs `write`-role
 * tools only (anything whose annotations are not `readOnlyHint: true`); `all`
 * adds `read`-role tools; `off` disables logging entirely (the audit-log wrapper
 * short-circuits and never opens the file).
 */
export type AuditLogMode = 'off' | 'writes' | 'all'

const parseAuditLogMode = (raw: string | undefined): AuditLogMode => {
  const v = raw?.trim().toLowerCase()
  if (v === undefined || v === '') return 'writes'
  if (v === 'off' || v === 'writes' || v === 'all') return v
  throw new Error(`Invalid MCP_CLAUDE_HOUSEKEEPING_AUDIT_LOG="${raw}" — expected one of: off, writes, all.`)
}

export const AUDIT_LOG_MODE: AuditLogMode = parseAuditLogMode(process.env.MCP_CLAUDE_HOUSEKEEPING_AUDIT_LOG)

/**
 * Size-based rotation for the audit log. After each append, if `audit.jsonl`
 * exceeds `AUDIT_LOG_MAX_BYTES`, it's renamed to `audit.jsonl.1` and older
 * rotations shift up. The oldest beyond `AUDIT_LOG_KEEP` is dropped. Set
 * `AUDIT_LOG_MAX_BYTES=0` to disable rotation entirely (file grows forever).
 */
const parseNonNegativeInt = (raw: string | undefined, fallback: number, varName: string): number => {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid ${varName}="${raw}" — expected a non-negative integer.`)
  }
  return n
}
export const AUDIT_LOG_MAX_BYTES: number = parseNonNegativeInt(process.env.MCP_CLAUDE_HOUSEKEEPING_AUDIT_LOG_MAX_BYTES, 10 * 1024 * 1024, 'MCP_CLAUDE_HOUSEKEEPING_AUDIT_LOG_MAX_BYTES')
export const AUDIT_LOG_KEEP: number = parseNonNegativeInt(process.env.MCP_CLAUDE_HOUSEKEEPING_AUDIT_LOG_KEEP, 5, 'MCP_CLAUDE_HOUSEKEEPING_AUDIT_LOG_KEEP')
