/**
 * Coverage for the atomic-rename failure branch in sessions.ts, which cleans up
 * the sibling temp file and rethrows. A real rename can't be forced to fail on
 * the same filesystem without races, so this file mocks node:fs/promises to
 * inject the error — kept separate from sessions.test.ts so that file keeps the
 * real fs.
 */
import { describe, expect, it, vi } from 'vitest'

const rename = vi.fn((..._args: unknown[]) => Promise.reject(new Error('not set')))
const rm = vi.fn((..._args: unknown[]) => Promise.resolve(undefined))
const writeFile = vi.fn((..._args: unknown[]) => Promise.resolve(undefined))
const readFile = vi.fn((..._args: unknown[]) => Promise.resolve(JSON.stringify({ title: 'old' })))

vi.mock('node:fs/promises', () => ({
  rename: (...args: unknown[]) => rename(...args),
  rm: (...args: unknown[]) => rm(...args),
  writeFile: (...args: unknown[]) => writeFile(...args),
  readFile: (...args: unknown[]) => readFile(...args),
  // realpath is used by assertRealPathWithinRoot — return the input so the
  // physical guard treats the path as already inside the root.
  realpath: (p: string) => Promise.resolve(p),
  access: vi.fn((..._args: unknown[]) => Promise.resolve(undefined))
}))

const UUID = '0006747e-b6a4-46e8-8e2f-c435398c9235'

describe('sessionRename rename-failure cleanup', () => {
  it('removes the temp file and rethrows when fs.rename fails', async () => {
    rename.mockRejectedValueOnce(Object.assign(new Error('rename failed'), { code: 'EXDEV' }))

    const { sessionRename } = await import('./sessions.js')
    await expect(sessionRename('/fake/workspace', { session_id: UUID, name: 'x' })).rejects.toThrow(/rename failed/)

    // The temp file written before the rename must have been cleaned up.
    expect(rm).toHaveBeenCalledTimes(1)
    const tmpArg = String(rm.mock.calls[0]?.[0] ?? '')
    expect(tmpArg).toMatch(/\.tmp-/)
  })
})
