/**
 * Coverage for fs error-path branches in utils.ts that are not provokable via
 * real filesystem operations on macOS. Uses vi.mock('node:fs/promises') to
 * inject errno codes that don't otherwise occur (EIO, EMFILE etc.).
 *
 * Kept in a separate file from utils.test.ts so the main test file can use the
 * real fs without mock interference.
 */
import type { Dirent } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type ReaddirImpl = (path: string, opts?: { withFileTypes?: boolean }) => Promise<unknown>

let readdirImpl: ReaddirImpl = async () => []

vi.mock('node:fs/promises', () => ({
  readdir: (...args: Parameters<ReaddirImpl>) => readdirImpl(...args),
  access: vi.fn(async () => {
    throw Object.assign(new Error('mock ENOENT'), { code: 'ENOENT' })
  })
}))

const makeErrnoError = (code: string): NodeJS.ErrnoException => {
  return Object.assign(new Error(`mocked ${code}`), { code }) as NodeJS.ErrnoException
}

const makeDirent = (name: string, isDir: boolean): Dirent => {
  return {
    name,
    isFile: () => !isDir,
    isDirectory: () => isDir,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    parentPath: '/',
    path: '/'
  } as Dirent
}

beforeEach(() => {
  readdirImpl = async () => []
})

describe('discoverWorkspaces rethrows per-account readdir errors that are not ENOENT/EACCES/EPERM', () => {
  it('propagates EIO from a per-account readdir', async () => {
    // Mock sequence:
    //  1. isWorkspaceDir(root) — readdir(root) returns [account-x]
    //     (no local_*.json match → returns false).
    //  2. Top-level readdir(root) returns [account-x] (dir).
    //  3. Per-account readdir(account-x) throws EIO → not in the allowed
    //     list (ENOENT/EACCES/EPERM) → rethrows.
    let callCount = 0
    readdirImpl = async (_p, opts) => {
      callCount += 1
      if (callCount === 3) throw makeErrnoError('EIO')
      // First call (isWorkspaceDir) — string return, no withFileTypes.
      if (!opts?.withFileTypes) return ['account-x']
      // Second call (top-level) — return one directory entry.
      return [makeDirent('account-x', true)]
    }

    const { discoverWorkspaces } = await import('./utils.js')
    await expect(discoverWorkspaces('/fake/root')).rejects.toThrow(/EIO/)
  })
})
