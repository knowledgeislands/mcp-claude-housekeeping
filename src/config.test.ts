/**
 * config.ts captures HOUSEKEEPING_PATH at module load time. Each test resets
 * modules and re-imports with a different env to cover both branches of
 * expandHome and the assert guard.
 */
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let saved: string | undefined

beforeEach(() => {
  saved = process.env.HOUSEKEEPING_PATH
  vi.resetModules()
})

afterEach(() => {
  if (saved === undefined) delete process.env.HOUSEKEEPING_PATH
  else process.env.HOUSEKEEPING_PATH = saved
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
