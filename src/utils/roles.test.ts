import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DESTRUCTIVE, DESTRUCTIVE_ONESHOT, READ_ONLY } from './annotations.js'

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

describe('roleFromAnnotations', () => {
  it('maps READ_ONLY annotations to read', async () => {
    delete process.env.MCP_CLAUDE_HOUSEKEEPING_ROLES
    const { roleFromAnnotations } = await import('./roles.js')
    expect(roleFromAnnotations(READ_ONLY)).toBe('read')
  })

  it('maps DESTRUCTIVE annotations to write', async () => {
    delete process.env.MCP_CLAUDE_HOUSEKEEPING_ROLES
    const { roleFromAnnotations } = await import('./roles.js')
    expect(roleFromAnnotations(DESTRUCTIVE)).toBe('write')
  })

  it('maps DESTRUCTIVE_ONESHOT annotations to write', async () => {
    delete process.env.MCP_CLAUDE_HOUSEKEEPING_ROLES
    const { roleFromAnnotations } = await import('./roles.js')
    expect(roleFromAnnotations(DESTRUCTIVE_ONESHOT)).toBe('write')
  })

  it('defaults to write (fail-safe) when annotations are missing', async () => {
    delete process.env.MCP_CLAUDE_HOUSEKEEPING_ROLES
    const { roleFromAnnotations } = await import('./roles.js')
    expect(roleFromAnnotations(undefined)).toBe('write')
  })

  it('defaults to write when readOnlyHint is absent', async () => {
    delete process.env.MCP_CLAUDE_HOUSEKEEPING_ROLES
    const { roleFromAnnotations } = await import('./roles.js')
    expect(roleFromAnnotations({ title: 'something' })).toBe('write')
  })
})

describe('HOUSEKEEPING_ROLES (config.ts)', () => {
  it('falls back to read when ROLES is a non-empty string with no valid entries after splitting', async () => {
    // Covers the `requested.length === 0` branch — distinct from the
    // `raw === undefined || raw.trim() === ''` branch above it. Inputs like
    // `","` survive the trim() check but every comma-separated part is empty,
    // so after filter(s => s.length > 0) the list is empty.
    process.env.MCP_CLAUDE_HOUSEKEEPING_ROLES = ',,,'
    const { HOUSEKEEPING_ROLES } = await import('../config.js')
    expect(Array.from(HOUSEKEEPING_ROLES)).toEqual(['read'])
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
    process.env.MCP_CLAUDE_HOUSEKEEPING_ROLES = 'read'
    const { makeRoleGatedRegister } = await import('./roles.js')
    const { server, registered } = fakeServer()
    const register = makeRoleGatedRegister(server as unknown as Parameters<typeof makeRoleGatedRegister>[0])
    register('any_read_tool', { description: 'd', annotations: READ_ONLY }, (() => ({})) as never)
    expect(registered).toEqual(['any_read_tool'])
  })

  it('skips tools whose role is disabled', async () => {
    process.env.MCP_CLAUDE_HOUSEKEEPING_ROLES = 'read'
    const { makeRoleGatedRegister } = await import('./roles.js')
    const { server, registered } = fakeServer()
    const register = makeRoleGatedRegister(server as unknown as Parameters<typeof makeRoleGatedRegister>[0])
    register('a_write_tool', { description: 'd', annotations: DESTRUCTIVE }, (() => ({})) as never)
    register('a_read_tool', { description: 'd', annotations: READ_ONLY }, (() => ({})) as never)
    expect(registered).toEqual(['a_read_tool'])
  })

  it('registers both roles when both are enabled', async () => {
    process.env.MCP_CLAUDE_HOUSEKEEPING_ROLES = 'read,write'
    const { makeRoleGatedRegister } = await import('./roles.js')
    const { server, registered } = fakeServer()
    const register = makeRoleGatedRegister(server as unknown as Parameters<typeof makeRoleGatedRegister>[0])
    register('a_read_tool', { description: 'd', annotations: READ_ONLY }, (() => ({})) as never)
    register('a_write_tool', { description: 'd', annotations: DESTRUCTIVE }, (() => ({})) as never)
    expect(registered).toEqual(['a_read_tool', 'a_write_tool'])
  })

  it('treats an unannotated tool as write (fail-safe)', async () => {
    process.env.MCP_CLAUDE_HOUSEKEEPING_ROLES = 'read'
    const { makeRoleGatedRegister } = await import('./roles.js')
    const { server, registered } = fakeServer()
    const register = makeRoleGatedRegister(server as unknown as Parameters<typeof makeRoleGatedRegister>[0])
    register('unannotated_tool', { description: 'd' }, (() => ({})) as never)
    expect(registered).toEqual([])
  })
})
