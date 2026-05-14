#!/usr/bin/env node

/**
 * mcp-claude-housekeeping
 *
 * Local stdio MCP server with three tool groups, each implemented in its own
 * folder under src/ and registered via a small `register<group>Tools(server)`
 * function:
 *
 *   sessions_*       Cowork local-agent-mode-sessions audit + cleanup.
 *   claude_code_*    ~/.claude/ projects, sessions, memory, and global state.
 *   vscode_*         VSCode workspaceStorage/<id>/chatSessions/ inventory.
 *
 * Configuration:
 *   MCP_CLAUDE_HOUSEKEEPING_PATH (env var, REQUIRED) — where audit reports are saved.
 *   All target roots are derived from the current user's home directory and
 *   are not user-configurable; see src/config.ts.
 */

import * as fs from 'node:fs/promises'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CLAUDE_CODE_ROOT_PATH, CLAUDE_DESKTOP_ROOT_PATH, HOUSEKEEPING_PATH, HOUSEKEEPING_ROLES, VSCODE_WORKSPACE_STORAGE_ROOT_PATH } from '../config.js'
import { discoverWorkspaces } from '../shared/utils.js'
import { registerClaudeCodeTools, registerClaudeDesktopTools, registerVscodeTools } from '../tools/index.js'

console.error(`mcp-claude-housekeeping starting...`)
console.error(`  MCP_CLAUDE_HOUSEKEEPING_ROLES=${[...HOUSEKEEPING_ROLES].sort().join(',')}`)
console.error(`  CLAUDE_DESKTOP_ROOT_PATH=${CLAUDE_DESKTOP_ROOT_PATH}`)
console.error(`  MCP_CLAUDE_HOUSEKEEPING_PATH=${HOUSEKEEPING_PATH}`)
console.error(`  CLAUDE_CODE_ROOT_PATH=${CLAUDE_CODE_ROOT_PATH}`)
console.error(`  VSCODE_WORKSPACE_STORAGE_ROOT_PATH=${VSCODE_WORKSPACE_STORAGE_ROOT_PATH}`)

const server = new McpServer({
  name: 'mcp-claude-housekeeping',
  version: '1.0.0'
})

registerClaudeDesktopTools(server)
registerClaudeCodeTools(server)
registerVscodeTools(server)

const reportAccessibility = async (label: string, p: string): Promise<void> => {
  try {
    await fs.access(p)
    console.error(`  ${label}: ok (${p})`)
  } catch {
    console.error(`  ${label}: not accessible (${p}) — tools targeting it will return errors until it exists`)
  }
}

const main = async (): Promise<void> => {
  await reportAccessibility('CLAUDE_DESKTOP_ROOT_PATH', CLAUDE_DESKTOP_ROOT_PATH)
  try {
    const ws = await discoverWorkspaces(CLAUDE_DESKTOP_ROOT_PATH)
    console.error(`  discovered ${ws.length} sessions workspace(s):${ws.length === 0 ? ' (none)' : ''}`)
    for (const w of ws) console.error(`    - ${w.id}`)
  } catch (err) {
    console.error(`  workspace discovery failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  await reportAccessibility('CLAUDE_CODE_ROOT_PATH', CLAUDE_CODE_ROOT_PATH)
  await reportAccessibility('VSCODE_WORKSPACE_STORAGE_ROOT_PATH', VSCODE_WORKSPACE_STORAGE_ROOT_PATH)

  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`mcp-claude-housekeeping ready`)
}

main().catch((err) => {
  console.error('mcp-claude-housekeeping fatal:', err)
  process.exit(1)
})
