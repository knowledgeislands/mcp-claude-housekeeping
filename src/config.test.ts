/**
 * config.ts captures env vars at module load time. Each test resets modules and
 * re-imports with a different env to cover the load-time branches.
 */
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let savedPath: string | undefined
let savedRoles: string | undefined

beforeEach(() => {
  savedPath = process.env.HOUSEKEEPING_PATH
  savedRoles = process.env.HOUSEKEEPING_ROLES
  vi.resetModules()
})

afterEach(() => {
  if (savedPath === undefined) delete process.env.HOUSEKEEPING_PATH
  else process.env.HOUSEKEEPING_PATH = savedPath
  if (savedRoles === undefined) delete process.env.HOUSEKEEPING_ROLES
  else process.env.HOUSEKEEPING_ROLES = savedRoles
})

describe('HOUSEKEEPING_PATH', () => {
  it('expands a leading ~/ to the user home directory', async () => {
    process.env.HOUSEKEEPING_PATH = '~/some-housekeeping'
    const { HOUSEKEEPING_PATH } = await import('./config.js')
    expect(HOUSEKEEPING_PATH).toBe(path.resolve(path.join(os.homedir(), 'some-housekeeping')))
  })

  it('leaves an absolute path unchanged', async () => {
    process.env.HOUSEKEEPING_PATH = '/tmp/explicit-housekeeping'
    const { HOUSEKEEPING_PATH } = await import('./config.js')
    expect(HOUSEKEEPING_PATH).toBe('/tmp/explicit-housekeeping')
  })

  it('throws when HOUSEKEEPING_PATH is unset', async () => {
    delete process.env.HOUSEKEEPING_PATH
    await expect(import('./config.js')).rejects.toThrow(/HOUSEKEEPING_PATH environment variable must be set/)
  })
})

describe('HOUSEKEEPING_ROLES', () => {
  beforeEach(() => {
    process.env.HOUSEKEEPING_PATH = '/tmp/housekeeping'
  })

  it('defaults to auditor only when unset', async () => {
    delete process.env.HOUSEKEEPING_ROLES
    const { HOUSEKEEPING_ROLES } = await import('./config.js')
    expect([...HOUSEKEEPING_ROLES]).toEqual(['auditor'])
  })

  it('defaults to auditor only when empty', async () => {
    process.env.HOUSEKEEPING_ROLES = '   '
    const { HOUSEKEEPING_ROLES } = await import('./config.js')
    expect([...HOUSEKEEPING_ROLES]).toEqual(['auditor'])
  })

  it('accepts a single role', async () => {
    process.env.HOUSEKEEPING_ROLES = 'cleaner'
    const { HOUSEKEEPING_ROLES } = await import('./config.js')
    expect(HOUSEKEEPING_ROLES.has('cleaner')).toBe(true)
    expect(HOUSEKEEPING_ROLES.has('auditor')).toBe(false)
  })

  it('accepts both roles with whitespace', async () => {
    process.env.HOUSEKEEPING_ROLES = ' auditor , cleaner '
    const { HOUSEKEEPING_ROLES } = await import('./config.js')
    expect([...HOUSEKEEPING_ROLES].sort()).toEqual(['auditor', 'cleaner'])
  })

  it('throws on an unknown role', async () => {
    process.env.HOUSEKEEPING_ROLES = 'auditor,observer'
    await expect(import('./config.js')).rejects.toThrow(/Invalid HOUSEKEEPING_ROLES entries: observer/)
  })
})
