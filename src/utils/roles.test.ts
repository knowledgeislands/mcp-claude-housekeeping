import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let savedPath: string | undefined
let savedRoles: string | undefined

beforeEach(() => {
  savedPath = process.env.MCP_CLAUDE_HOUSEKEEPING_PATH
  savedRoles = process.env.MCP_CLAUDE_HOUSEKEEPING_ROLES
  process.env.MCP_CLAUDE_HOUSEKEEPING_PATH = '/tmp/housekeeping'
  vi.resetModules()
})

afterEach(() => {
  if (savedPath === undefined) delete process.env.MCP_CLAUDE_HOUSEKEEPING_PATH
  else process.env.MCP_CLAUDE_HOUSEKEEPING_PATH = savedPath
  if (savedRoles === undefined) delete process.env.MCP_CLAUDE_HOUSEKEEPING_ROLES
  else process.env.MCP_CLAUDE_HOUSEKEEPING_ROLES = savedRoles
})

describe('roleFromToolName', () => {
  it('extracts auditor from a name containing _auditor_', async () => {
    delete process.env.MCP_CLAUDE_HOUSEKEEPING_ROLES
    const { roleFromToolName } = await import('./roles.js')
    expect(roleFromToolName('claude_desktop_auditor_storage_summary')).toBe('auditor')
  })

  it('extracts cleaner from a name containing _cleaner_', async () => {
    delete process.env.MCP_CLAUDE_HOUSEKEEPING_ROLES
    const { roleFromToolName } = await import('./roles.js')
    expect(roleFromToolName('claude_code_cleaner_prune_sessions')).toBe('cleaner')
  })

  it('throws when no role segment is present', async () => {
    delete process.env.MCP_CLAUDE_HOUSEKEEPING_ROLES
    const { roleFromToolName } = await import('./roles.js')
    expect(() => roleFromToolName('something_else')).toThrow(/Cannot determine role from tool name/)
  })
})

describe('HOUSEKEEPING_ROLES (config.ts)', () => {
  it('falls back to auditor when ROLES is a non-empty string with no valid entries after splitting', async () => {
    // Covers the `requested.length === 0` branch — distinct from the
    // `raw === undefined || raw.trim() === ''` branch above it. Inputs like
    // `","` survive the trim() check but every comma-separated part is empty,
    // so after filter(s => s.length > 0) the list is empty.
    process.env.MCP_CLAUDE_HOUSEKEEPING_ROLES = ',,,'
    const { HOUSEKEEPING_ROLES } = await import('../config.js')
    expect(Array.from(HOUSEKEEPING_ROLES)).toEqual(['auditor'])
  })
})

describe('makeRoleGatedRegister', () => {
  const fakeServer = () => {
    const registered: string[] = []
    return {
      server: { registerTool: vi.fn((name: string) => registered.push(name)) },
      registered
    }
  }

  it('registers tools whose role is enabled', async () => {
    process.env.MCP_CLAUDE_HOUSEKEEPING_ROLES = 'auditor'
    const { makeRoleGatedRegister } = await import('./roles.js')
    const { server, registered } = fakeServer()
    const register = makeRoleGatedRegister(server as unknown as Parameters<typeof makeRoleGatedRegister>[0])
    register('claude_desktop_auditor_x', { description: 'd' }, (() => ({})) as never)
    expect(registered).toEqual(['claude_desktop_auditor_x'])
  })

  it('skips tools whose role is disabled', async () => {
    process.env.MCP_CLAUDE_HOUSEKEEPING_ROLES = 'auditor'
    const { makeRoleGatedRegister } = await import('./roles.js')
    const { server, registered } = fakeServer()
    const register = makeRoleGatedRegister(server as unknown as Parameters<typeof makeRoleGatedRegister>[0])
    register('claude_desktop_cleaner_x', { description: 'd' }, (() => ({})) as never)
    register('claude_desktop_auditor_y', { description: 'd' }, (() => ({})) as never)
    expect(registered).toEqual(['claude_desktop_auditor_y'])
  })

  it('registers both roles when both are enabled', async () => {
    process.env.MCP_CLAUDE_HOUSEKEEPING_ROLES = 'auditor,cleaner'
    const { makeRoleGatedRegister } = await import('./roles.js')
    const { server, registered } = fakeServer()
    const register = makeRoleGatedRegister(server as unknown as Parameters<typeof makeRoleGatedRegister>[0])
    register('claude_desktop_auditor_x', { description: 'd' }, (() => ({})) as never)
    register('claude_desktop_cleaner_y', { description: 'd' }, (() => ({})) as never)
    expect(registered).toEqual(['claude_desktop_auditor_x', 'claude_desktop_cleaner_y'])
  })
})
