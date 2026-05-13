import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let savedPath: string | undefined
let savedRoles: string | undefined

beforeEach(() => {
  savedPath = process.env.HOUSEKEEPING_PATH
  savedRoles = process.env.HOUSEKEEPING_ROLES
  process.env.HOUSEKEEPING_PATH = '/tmp/housekeeping'
  vi.resetModules()
})

afterEach(() => {
  if (savedPath === undefined) delete process.env.HOUSEKEEPING_PATH
  else process.env.HOUSEKEEPING_PATH = savedPath
  if (savedRoles === undefined) delete process.env.HOUSEKEEPING_ROLES
  else process.env.HOUSEKEEPING_ROLES = savedRoles
})

describe('roleFromToolName', () => {
  it('extracts auditor from a name containing _auditor_', async () => {
    delete process.env.HOUSEKEEPING_ROLES
    const { roleFromToolName } = await import('./roles.js')
    expect(roleFromToolName('claude_desktop_auditor_storage_summary')).toBe('auditor')
  })

  it('extracts cleaner from a name containing _cleaner_', async () => {
    delete process.env.HOUSEKEEPING_ROLES
    const { roleFromToolName } = await import('./roles.js')
    expect(roleFromToolName('claude_code_cleaner_prune_sessions')).toBe('cleaner')
  })

  it('throws when no role segment is present', async () => {
    delete process.env.HOUSEKEEPING_ROLES
    const { roleFromToolName } = await import('./roles.js')
    expect(() => roleFromToolName('something_else')).toThrow(/Cannot determine role from tool name/)
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
    process.env.HOUSEKEEPING_ROLES = 'auditor'
    const { makeRoleGatedRegister } = await import('./roles.js')
    const { server, registered } = fakeServer()
    const register = makeRoleGatedRegister(server as unknown as Parameters<typeof makeRoleGatedRegister>[0])
    register('claude_desktop_auditor_x', { description: 'd' }, (() => ({})) as never)
    expect(registered).toEqual(['claude_desktop_auditor_x'])
  })

  it('skips tools whose role is disabled', async () => {
    process.env.HOUSEKEEPING_ROLES = 'auditor'
    const { makeRoleGatedRegister } = await import('./roles.js')
    const { server, registered } = fakeServer()
    const register = makeRoleGatedRegister(server as unknown as Parameters<typeof makeRoleGatedRegister>[0])
    register('claude_desktop_cleaner_x', { description: 'd' }, (() => ({})) as never)
    register('claude_desktop_auditor_y', { description: 'd' }, (() => ({})) as never)
    expect(registered).toEqual(['claude_desktop_auditor_y'])
  })

  it('registers both roles when both are enabled', async () => {
    process.env.HOUSEKEEPING_ROLES = 'auditor,cleaner'
    const { makeRoleGatedRegister } = await import('./roles.js')
    const { server, registered } = fakeServer()
    const register = makeRoleGatedRegister(server as unknown as Parameters<typeof makeRoleGatedRegister>[0])
    register('claude_desktop_auditor_x', { description: 'd' }, (() => ({})) as never)
    register('claude_desktop_cleaner_y', { description: 'd' }, (() => ({})) as never)
    expect(registered).toEqual(['claude_desktop_auditor_x', 'claude_desktop_cleaner_y'])
  })
})
