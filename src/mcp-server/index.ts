#!/usr/bin/env node

/**
 * mcp-housekeeping-claude
 *
 * Local stdio MCP server with three tool groups, each registered via a small
 * `register<group>Tools(server, cfg)` function and implemented under src/main/:
 *
 *   claude_desktop_*  Cowork local-agent-mode-sessions audit + cleanup.
 *   claude_code_*     ~/.claude/ projects, sessions, memory, and global state.
 *   vscode_*          VSCode workspaceStorage/<id>/chatSessions/ inventory.
 *
 * Configuration is loaded once here via loadConfig() and threaded into each
 * register function (see src/config/index.ts). All target roots are derived
 * from the current user's home directory and are not user-configurable.
 *
 *   MCP_HOUSEKEEPING_CLAUDE_PATH (env var, REQUIRED) — where audit reports are saved.
 */

import * as fs from 'node:fs/promises'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import pkg from '../../package.json' with { type: 'json' }
import { loadConfig } from '../config/index.js'
import { registerClaudeCodeTools, registerClaudeDesktopTools, registerVscodeTools } from '../tools/index.js'
import { makeAccessGatedRegister } from '../utils/access-level.js'
import { discoverWorkspaces } from '../utils/utils.js'

const config = loadConfig()

console.error(`mcp-housekeeping-claude starting...`)
console.error(`  MCP_HOUSEKEEPING_CLAUDE_ACCESS_LEVEL=${config.accessLevel}`)
console.error(`  CLAUDE_DESKTOP_ROOT_PATH=${config.claudeDesktopRootPath}`)
console.error(`  MCP_HOUSEKEEPING_CLAUDE_PATH=${config.housekeepingPath}`)
console.error(`  CLAUDE_CODE_ROOT_PATH=${config.claudeCodeRootPath}`)
console.error(`  VSCODE_WORKSPACE_STORAGE_ROOT_PATH=${config.vscodeWorkspaceStorageRootPath}`)
console.error(
  `  MCP_HOUSEKEEPING_CLAUDE_AUDIT_LOG=${config.auditLogMode}${config.auditLogMode === 'off' ? '' : ` (path: ${config.auditLogPath})`}`
)

const server = new McpServer({
  name: 'mcp-housekeeping-claude',
  version: pkg.version
})
server.registerTool = makeAccessGatedRegister(server, config.accessLevel, {
  mode: config.auditLogMode,
  path: config.auditLogPath,
  maxBytes: config.auditLogMaxBytes,
  keep: config.auditLogKeep
})

registerClaudeDesktopTools(server, config)
registerClaudeCodeTools(server, config)
registerVscodeTools(server, config)

const reportAccessibility = async (label: string, p: string): Promise<void> => {
  try {
    await fs.access(p)
    console.error(`  ${label}: ok (${p})`)
  } catch {
    console.error(`  ${label}: not accessible (${p}) — tools targeting it will return errors until it exists`)
  }
}

const main = async (): Promise<void> => {
  await reportAccessibility('CLAUDE_DESKTOP_ROOT_PATH', config.claudeDesktopRootPath)
  try {
    const ws = await discoverWorkspaces(config.claudeDesktopRootPath)
    console.error(`  discovered ${ws.length} sessions workspace(s):${ws.length === 0 ? ' (none)' : ''}`)
    for (const w of ws) console.error(`    - ${w.id}`)
  } catch (err) {
    console.error(`  workspace discovery failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  await reportAccessibility('CLAUDE_CODE_ROOT_PATH', config.claudeCodeRootPath)
  await reportAccessibility('VSCODE_WORKSPACE_STORAGE_ROOT_PATH', config.vscodeWorkspaceStorageRootPath)

  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`mcp-housekeeping-claude ready`)
}

main().catch((err) => {
  console.error('mcp-housekeeping-claude fatal:', err)
  process.exit(1)
})
