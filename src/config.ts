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

export type Role = 'auditor' | 'cleaner'
export const ALL_ROLES: readonly Role[] = ['auditor', 'cleaner'] as const

const parseRoles = (raw: string | undefined): Set<Role> => {
  if (raw === undefined || raw.trim() === '') return new Set(['auditor'])
  const requested = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (requested.length === 0) return new Set(['auditor'])
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
