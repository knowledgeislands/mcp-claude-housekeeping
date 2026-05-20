import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DESTRUCTIVE, DESTRUCTIVE_ONESHOT, READ_ONLY } from './annotations.js'

let savedPath: string | undefined
let savedAccessLevel: string | undefined

beforeEach(() => {
  savedPath = process.env.MCP_CLAUDE_HOUSEKEEPING_PATH
  savedAccessLevel = process.env.MCP_CLAUDE_HOUSEKEEPING_ACCESS_LEVEL
  process.env.MCP_CLAUDE_HOUSEKEEPING_PATH = '/tmp/housekeeping'
  vi.resetModules()
})

afterEach(() => {
  if (savedPath === undefined) delete process.env.MCP_CLAUDE_HOUSEKEEPING_PATH
  else process.env.MCP_CLAUDE_HOUSEKEEPING_PATH = savedPath
  if (savedAccessLevel === undefined) delete process.env.MCP_CLAUDE_HOUSEKEEPING_ACCESS_LEVEL
  else process.env.MCP_CLAUDE_HOUSEKEEPING_ACCESS_LEVEL = savedAccessLevel
})

describe('levelFromAnnotations', () => {
  it('maps READ_ONLY annotations to read', async () => {
    const { levelFromAnnotations } = await import('./access-level.js')
    expect(levelFromAnnotations(READ_ONLY)).toBe('read')
  })

  it('maps DESTRUCTIVE annotations to destructive', async () => {
    const { levelFromAnnotations } = await import('./access-level.js')
    expect(levelFromAnnotations(DESTRUCTIVE)).toBe('destructive')
  })

  it('maps DESTRUCTIVE_ONESHOT annotations to destructive', async () => {
    const { levelFromAnnotations } = await import('./access-level.js')
    expect(levelFromAnnotations(DESTRUCTIVE_ONESHOT)).toBe('destructive')
  })

  it('maps explicit non-destructive write annotations to write', async () => {
    const { levelFromAnnotations } = await import('./access-level.js')
    expect(levelFromAnnotations({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false })).toBe('write')
  })

  it('defaults to destructive (fail-safe) when annotations are missing', async () => {
    const { levelFromAnnotations } = await import('./access-level.js')
    expect(levelFromAnnotations(undefined)).toBe('destructive')
  })

  it('defaults to destructive when readOnlyHint is absent', async () => {
    const { levelFromAnnotations } = await import('./access-level.js')
    expect(levelFromAnnotations({ title: 'something' })).toBe('destructive')
  })
})

describe('ACCESS_LEVEL (config.ts)', () => {
  it('defaults to read when MCP_CLAUDE_HOUSEKEEPING_ACCESS_LEVEL is unset', async () => {
    delete process.env.MCP_CLAUDE_HOUSEKEEPING_ACCESS_LEVEL
    const { ACCESS_LEVEL } = await import('../config.js')
    expect(ACCESS_LEVEL).toBe('read')
  })

  it('defaults to read when MCP_CLAUDE_HOUSEKEEPING_ACCESS_LEVEL is an empty/whitespace string', async () => {
    process.env.MCP_CLAUDE_HOUSEKEEPING_ACCESS_LEVEL = '   '
    const { ACCESS_LEVEL } = await import('../config.js')
    expect(ACCESS_LEVEL).toBe('read')
  })

  it('rejects unknown values', async () => {
    process.env.MCP_CLAUDE_HOUSEKEEPING_ACCESS_LEVEL = 'admin'
    await expect(import('../config.js')).rejects.toThrow(/Invalid MCP_CLAUDE_HOUSEKEEPING_ACCESS_LEVEL="admin"/)
  })
})

describe('makeAccessGatedRegister', () => {
  const fakeServer = () => {
    const registered: string[] = []
    return {
      server: { registerTool: vi.fn((name: string) => registered.push(name)) },
      registered
    }
  }

  it('registers only read-level tools by default (level=read)', async () => {
    delete process.env.MCP_CLAUDE_HOUSEKEEPING_ACCESS_LEVEL
    const { makeAccessGatedRegister } = await import('./access-level.js')
    const { server, registered } = fakeServer()
    const register = makeAccessGatedRegister(server as unknown as Parameters<typeof makeAccessGatedRegister>[0])
    register('a_read_tool', { description: 'd', annotations: READ_ONLY }, (() => ({})) as never)
    register('a_destructive_tool', { description: 'd', annotations: DESTRUCTIVE }, (() => ({})) as never)
    register('a_oneshot_tool', { description: 'd', annotations: DESTRUCTIVE_ONESHOT }, (() => ({})) as never)
    expect(registered).toEqual(['a_read_tool'])
  })

  it('registers read + non-destructive writes (but not destructive) when level=write', async () => {
    process.env.MCP_CLAUDE_HOUSEKEEPING_ACCESS_LEVEL = 'write'
    const { makeAccessGatedRegister } = await import('./access-level.js')
    const { server, registered } = fakeServer()
    const register = makeAccessGatedRegister(server as unknown as Parameters<typeof makeAccessGatedRegister>[0])
    const ADDITIVE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const
    register('a_read_tool', { description: 'd', annotations: READ_ONLY }, (() => ({})) as never)
    register('an_additive_tool', { description: 'd', annotations: ADDITIVE }, (() => ({})) as never)
    register('a_destructive_tool', { description: 'd', annotations: DESTRUCTIVE }, (() => ({})) as never)
    expect(registered).toEqual(['a_read_tool', 'an_additive_tool'])
  })

  it('registers every level when level=destructive', async () => {
    process.env.MCP_CLAUDE_HOUSEKEEPING_ACCESS_LEVEL = 'destructive'
    const { makeAccessGatedRegister } = await import('./access-level.js')
    const { server, registered } = fakeServer()
    const register = makeAccessGatedRegister(server as unknown as Parameters<typeof makeAccessGatedRegister>[0])
    register('a_read_tool', { description: 'd', annotations: READ_ONLY }, (() => ({})) as never)
    register('a_destructive_tool', { description: 'd', annotations: DESTRUCTIVE }, (() => ({})) as never)
    register('a_oneshot_tool', { description: 'd', annotations: DESTRUCTIVE_ONESHOT }, (() => ({})) as never)
    expect(registered).toEqual(['a_read_tool', 'a_destructive_tool', 'a_oneshot_tool'])
  })

  it('treats an unannotated tool as destructive (fail-safe — skipped under default level=read)', async () => {
    delete process.env.MCP_CLAUDE_HOUSEKEEPING_ACCESS_LEVEL
    const { makeAccessGatedRegister } = await import('./access-level.js')
    const { server, registered } = fakeServer()
    const register = makeAccessGatedRegister(server as unknown as Parameters<typeof makeAccessGatedRegister>[0])
    register('unannotated_tool', { description: 'd' }, (() => ({})) as never)
    expect(registered).toEqual([])
  })
})
