/**
 * Configuration loading. `loadConfig()` reads the environment (optionally
 * hydrated from the package's `.env*` files) into a plain `Config` value that is
 * passed explicitly into tool registration and main calls — so the same code
 * runs as an MCP server or from a standalone script. There is NO module-level
 * config singleton: nothing here is read at import time.
 */
import { strict as assert } from 'node:assert'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const expandHome = (p: string): string => {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p
}

/**
 * Package root, resolved from this module's own URL — NOT `process.cwd()`,
 * which is wherever the MCP host happened to launch `node dist/mcp-server/...`
 * from. Both layouts put this file two levels below the root
 * (`dist/config/index.js` and `src/config/index.ts`), so `../..` is correct
 * whether built or run from source.
 */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Hydrate `process.env` from the package's `.env*` files, mirroring the set and
 * precedence Bun auto-loads (highest first: `.env.local`, then
 * `.env.${NODE_ENV}` if NODE_ENV is set, then `.env`). `process.loadEnvFile`
 * never overwrites a key already present in `process.env`, so loading
 * highest-precedence first means earlier files win — and any value injected by
 * the host (e.g. the MCP client's `env` block) beats every file. Missing files
 * are skipped silently; under Bun this is largely redundant with its own
 * auto-load, which is fine.
 */
const hydrateEnvFromFiles = (): void => {
  const files = ['.env.local']
  if (process.env.NODE_ENV) files.push(`.env.${process.env.NODE_ENV}`)
  files.push('.env')
  for (const file of files) {
    try {
      process.loadEnvFile(path.join(PACKAGE_ROOT, file))
    } catch {
      // File absent or unreadable — skip; the value may come from the host env.
    }
  }
}

/**
 * Single ordinal access level. Each level implies all lower ones:
 *   `read`        — only readOnly tools registered.
 *   `write`       — readOnly + non-destructive mutations (none today, reserved
 *                   for future additive housekeeping tools).
 *   `destructive` — everything, including prune / relocate / delete.
 *
 * The gate uses ACCESS_LEVEL_RANK for ordinal comparison; a tool registers when
 * its derived level ≤ the configured level. `dry_run` defaults remain the
 * second line of defence inside each destructive tool's handler — the gate
 * controls *which* tools the model can see; `dry_run` controls whether a
 * visible tool actually mutates on first invocation.
 */
export type AccessLevel = 'read' | 'write' | 'destructive'
export const ACCESS_LEVELS: readonly AccessLevel[] = ['read', 'write', 'destructive'] as const
export const ACCESS_LEVEL_RANK: Record<AccessLevel, number> = { read: 1, write: 2, destructive: 3 }

/**
 * Scope of tool invocations to record. Default `writes` logs any tool whose
 * derived level is not `read` (i.e. `write` or `destructive`); `all` adds
 * `read` too; `off` disables logging entirely (the audit-log wrapper
 * short-circuits and never opens the file).
 */
export type AuditLogMode = 'off' | 'writes' | 'all'

export interface Config {
  /** Where audit reports are saved (MCP_CLAUDE_HOUSEKEEPING_PATH; required). */
  housekeepingPath: string
  accessLevel: AccessLevel
  /** Cowork local-agent-mode-sessions root (derived from home; not user-configurable). */
  claudeDesktopRootPath: string
  /** Claude Code `~/.claude` root (derived from home; not user-configurable). */
  claudeCodeRootPath: string
  /** VSCode workspaceStorage root (derived from home; not user-configurable). */
  vscodeWorkspaceStorageRootPath: string
  auditLogMode: AuditLogMode
  auditLogPath: string
  auditLogMaxBytes: number
  auditLogKeep: number
}

const parseAccessLevel = (raw: string | undefined): AccessLevel => {
  const v = raw?.trim()
  if (v === undefined || v === '') return 'read'
  if ((ACCESS_LEVELS as readonly string[]).includes(v)) return v as AccessLevel
  throw new Error(`Invalid MCP_CLAUDE_HOUSEKEEPING_ACCESS_LEVEL="${raw}". Allowed: ${ACCESS_LEVELS.join(', ')}`)
}

const parseAuditLogMode = (raw: string | undefined): AuditLogMode => {
  const v = raw?.trim().toLowerCase()
  if (v === undefined || v === '') return 'writes'
  if (v === 'off' || v === 'writes' || v === 'all') return v
  throw new Error(`Invalid MCP_CLAUDE_HOUSEKEEPING_AUDIT_LOG="${raw}" — expected one of: off, writes, all.`)
}

/**
 * Size-based rotation for the audit log. After each append, if `audit.jsonl`
 * exceeds `auditLogMaxBytes`, it's renamed to `audit.jsonl.1` and older
 * rotations shift up. The oldest beyond `auditLogKeep` is dropped. Set
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

/**
 * Load configuration from `env` (defaults to `process.env`, after attempting to
 * hydrate it from the package's `.env*` files). Throws if
 * MCP_CLAUDE_HOUSEKEEPING_PATH is missing or a typed var is invalid.
 */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  hydrateEnvFromFiles()

  assert(env.MCP_CLAUDE_HOUSEKEEPING_PATH, 'MCP_CLAUDE_HOUSEKEEPING_PATH environment variable must be set')
  const housekeepingPath = path.resolve(expandHome(env.MCP_CLAUDE_HOUSEKEEPING_PATH))

  return {
    housekeepingPath,
    accessLevel: parseAccessLevel(env.MCP_CLAUDE_HOUSEKEEPING_ACCESS_LEVEL),
    // Cowork sessions, Claude Code state, and VSCode chat sessions all live in
    // known locations under the current user's home directory; they are not
    // user-configurable.
    claudeDesktopRootPath: path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions'),
    claudeCodeRootPath: path.join(os.homedir(), '.claude'),
    vscodeWorkspaceStorageRootPath: path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage'),
    auditLogMode: parseAuditLogMode(env.MCP_CLAUDE_HOUSEKEEPING_AUDIT_LOG),
    auditLogPath: path.resolve(expandHome(env.MCP_CLAUDE_HOUSEKEEPING_AUDIT_LOG_PATH ?? path.join(housekeepingPath, 'audit', 'audit.jsonl'))),
    auditLogMaxBytes: parseNonNegativeInt(env.MCP_CLAUDE_HOUSEKEEPING_AUDIT_LOG_MAX_BYTES, 10 * 1024 * 1024, 'MCP_CLAUDE_HOUSEKEEPING_AUDIT_LOG_MAX_BYTES'),
    auditLogKeep: parseNonNegativeInt(env.MCP_CLAUDE_HOUSEKEEPING_AUDIT_LOG_KEEP, 5, 'MCP_CLAUDE_HOUSEKEEPING_AUDIT_LOG_KEEP')
  }
}
