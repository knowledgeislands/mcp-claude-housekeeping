import { describe, expect, it } from 'vitest'
import type { AccessLevel } from '../config/index.js'
import { levelFromAnnotations, makeAccessGatedRegister } from './access-level.js'
import { DESTRUCTIVE, DESTRUCTIVE_ONESHOT, READ_ONLY } from './annotations.js'
import type { AuditConfig } from './audit-log.js'

// Audit disabled so registration doesn't touch the filesystem.
const AUDIT_OFF: AuditConfig = { mode: 'off', path: '/dev/null', maxBytes: 0, keep: 0 }

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const

const makeStub = () => {
  const calls: string[] = []
  const stub = { registerTool: (name: string, _config: unknown, _handler: unknown) => calls.push(name) }
  return { calls, stub }
}

const gateAt = (accessLevel: AccessLevel) => {
  const { calls, stub } = makeStub()
  const gated = makeAccessGatedRegister(
    stub as unknown as Parameters<typeof makeAccessGatedRegister>[0],
    accessLevel,
    AUDIT_OFF
  )
  gated('a_read_tool', { description: 'd', annotations: READ_ONLY } as never, (() => ({})) as never)
  gated('an_additive_tool', { description: 'd', annotations: WRITE } as never, (() => ({})) as never)
  gated('a_destructive_tool', { description: 'd', annotations: DESTRUCTIVE } as never, (() => ({})) as never)
  gated('a_oneshot_tool', { description: 'd', annotations: DESTRUCTIVE_ONESHOT } as never, (() => ({})) as never)
  return calls
}

describe('levelFromAnnotations', () => {
  it('maps READ_ONLY annotations to read', () => {
    expect(levelFromAnnotations(READ_ONLY)).toBe('read')
  })

  it('maps DESTRUCTIVE annotations to destructive', () => {
    expect(levelFromAnnotations(DESTRUCTIVE)).toBe('destructive')
  })

  it('maps DESTRUCTIVE_ONESHOT annotations to destructive', () => {
    expect(levelFromAnnotations(DESTRUCTIVE_ONESHOT)).toBe('destructive')
  })

  it('maps explicit non-destructive write annotations to write', () => {
    expect(levelFromAnnotations(WRITE)).toBe('write')
  })

  it('defaults to destructive (fail-safe) when annotations are missing', () => {
    expect(levelFromAnnotations(undefined)).toBe('destructive')
  })

  it('defaults to destructive when readOnlyHint is absent', () => {
    expect(levelFromAnnotations({ title: 'something' })).toBe('destructive')
  })
})

describe('makeAccessGatedRegister', () => {
  it('registers only read-level tools by default (gate=read)', () => {
    expect(gateAt('read')).toEqual(['a_read_tool'])
  })

  it('registers read + non-destructive writes (but not destructive) when gate=write', () => {
    expect(gateAt('write')).toEqual(['a_read_tool', 'an_additive_tool'])
  })

  it('registers every level when gate=destructive', () => {
    expect(gateAt('destructive')).toEqual(['a_read_tool', 'an_additive_tool', 'a_destructive_tool', 'a_oneshot_tool'])
  })

  it('treats an unannotated tool as destructive (fail-safe — skipped under default gate=read)', () => {
    const { calls, stub } = makeStub()
    const gated = makeAccessGatedRegister(
      stub as unknown as Parameters<typeof makeAccessGatedRegister>[0],
      'read',
      AUDIT_OFF
    )
    gated('unannotated_tool', { description: 'd' } as never, (() => ({})) as never)
    expect(calls).toEqual([])
  })
})
