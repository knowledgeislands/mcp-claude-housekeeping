import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { HOUSEKEEPING_ROLES, type Role } from '../config.js'

export const roleFromToolName = (name: string): Role => {
  if (name.includes('_auditor_')) return 'auditor'
  if (name.includes('_cleaner_')) return 'cleaner'
  throw new Error(`Cannot determine role from tool name "${name}"; expected "_auditor_" or "_cleaner_" in the name.`)
}

type RegisterTool = McpServer['registerTool']

/**
 * Wraps `server.registerTool` so only tools whose inferred role
 * (`_auditor_` / `_cleaner_` in the name) is enabled in MCP_CLAUDE_HOUSEKEEPING_ROLES
 * are actually registered. Disabled tools are silently skipped.
 */
export const makeRoleGatedRegister = (server: McpServer): RegisterTool => {
  const proxied = new Proxy(server.registerTool.bind(server) as RegisterTool, {
    apply(target, thisArg, args: Parameters<RegisterTool>) {
      if (!HOUSEKEEPING_ROLES.has(roleFromToolName(args[0]))) return undefined as never
      return Reflect.apply(target, thisArg, args)
    }
  })
  return proxied
}
