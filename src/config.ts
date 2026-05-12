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

assert(process.env.HOUSEKEEPING_PATH, 'HOUSEKEEPING_PATH environment variable must be set')

export const HOUSEKEEPING_PATH: string = path.resolve(expandHome(process.env.HOUSEKEEPING_PATH))

// Cowork sessions, Claude Code state, and VSCode chat sessions all live in
// known locations under the current user's home directory; they are not
// user-configurable.
export const CLAUDE_DESKTOP_ROOT_PATH: string = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions')
export const CLAUDE_CODE_ROOT_PATH: string = path.join(os.homedir(), '.claude')
export const VSCODE_WORKSPACE_STORAGE_ROOT_PATH: string = path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage')
