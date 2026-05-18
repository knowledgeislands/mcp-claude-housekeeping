import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { HOUSEKEEPING_ROLES, type Role } from '../config.js'
import { withAuditLog } from './audit-log.js'

/**
 * Map a tool's MCP annotations to a housekeeping role.
 *
 * Fail-safe: anything not explicitly marked `readOnlyHint: true` is treated as
 * `write`. Forgetting to annotate a new destructive tool then defaults it to
 * the more-restricted role rather than silently bypassing the write gate.
 */
export const roleFromAnnotations = (annotations: ToolAnnotations | undefined): Role => {
  if (annotations?.readOnlyHint === true) return 'read'
  return 'write'
}

type RegisterTool = McpServer['registerTool']

/**
 * Wraps `server.registerTool` so only tools whose role (derived from
 * `config.annotations.readOnlyHint`) is enabled in MCP_CLAUDE_HOUSEKEEPING_ROLES
 * are actually registered. Disabled tools are silently skipped. Each registered
 * tool's callback is wrapped with the audit logger.
 */
// We can't get usable parameter types out of the overloaded generic `RegisterTool`
// signature — `Parameters<RegisterTool>` collapses to `never` for overloads —
// so the Proxy validates the two fields it needs (name, annotations) structurally
// and treats the rest opaquely.
interface RegisterToolConfig {
  annotations?: ToolAnnotations
}
type ToolCallback = (...callbackArgs: unknown[]) => unknown | Promise<unknown>
type RegisterToolArgs = [name: string, config: RegisterToolConfig, callback: ToolCallback]

export const makeRoleGatedRegister = (server: McpServer): RegisterTool => {
  const proxied = new Proxy(server.registerTool.bind(server) as RegisterTool, {
    apply(target, thisArg, args: RegisterToolArgs) {
      const [name, config, callback] = args
      const role = roleFromAnnotations(config.annotations)
      if (!HOUSEKEEPING_ROLES.has(role)) return undefined as never
      const wrappedArgs: RegisterToolArgs = [name, config, withAuditLog(name, role, callback)]
      return Reflect.apply(target, thisArg, wrappedArgs)
    }
  })
  return proxied
}
