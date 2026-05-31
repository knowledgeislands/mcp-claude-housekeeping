import type { Dirent } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { assertRealPathWithinRoot, isNodeError, resolveWithinRoot } from '../../utils/utils.js'

const memoryDir = (workspaceRoot: string, spaceId: string): string => {
  return resolveWithinRoot(path.join(workspaceRoot, 'spaces'), path.join(spaceId, 'memory'))
}

const memoryFilePath = (workspaceRoot: string, spaceId: string, name: string): string => {
  if (!name.endsWith('.md')) throw new Error(`Memory file name must end with .md: "${name}"`)
  return resolveWithinRoot(memoryDir(workspaceRoot, spaceId), name)
}

export const memoryList = async (workspaceRoot: string, args: { space_id: string }) => {
  const dir = memoryDir(workspaceRoot, args.space_id)
  await assertRealPathWithinRoot(workspaceRoot, dir)
  let entries: Dirent[]
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true })) as Dirent[]
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      throw new Error(`Memory directory not found for space "${args.space_id}"`)
    }
    throw err
  }
  const files: { name: string; bytes: number; modified: string }[] = []
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue
    const stat = await fs.stat(path.join(dir, e.name))
    files.push({ name: e.name, bytes: stat.size, modified: stat.mtime.toISOString() })
  }
  files.sort((a, b) => a.name.localeCompare(b.name))

  let index: string | null = null
  if (files.find((f) => f.name === 'MEMORY.md')) {
    index = await fs.readFile(path.join(dir, 'MEMORY.md'), 'utf-8')
  }

  return {
    space_id: args.space_id,
    file_count: files.length,
    files,
    index
  }
}

export const memoryRead = async (workspaceRoot: string, args: { space_id: string; name: string }) => {
  const p = memoryFilePath(workspaceRoot, args.space_id, args.name)
  await assertRealPathWithinRoot(workspaceRoot, p)
  try {
    const content = await fs.readFile(p, 'utf-8')
    return { space_id: args.space_id, name: args.name, content }
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      throw new Error(`Memory file not found: "${args.name}" in space "${args.space_id}"`)
    }
    throw err
  }
}

export const memoryWrite = async (workspaceRoot: string, args: { space_id: string; name: string; content: string }) => {
  const p = memoryFilePath(workspaceRoot, args.space_id, args.name)
  await assertRealPathWithinRoot(workspaceRoot, p)
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, args.content, 'utf-8')
  return {
    space_id: args.space_id,
    name: args.name,
    bytes: Buffer.byteLength(args.content, 'utf-8')
  }
}

export const memoryDelete = async (workspaceRoot: string, args: { space_id: string; name: string; dry_run: boolean }) => {
  if (args.name === 'MEMORY.md') {
    throw new Error('Cannot delete MEMORY.md via memory_delete; use memory_index_write to replace its contents.')
  }
  const p = memoryFilePath(workspaceRoot, args.space_id, args.name)
  await assertRealPathWithinRoot(workspaceRoot, p)
  let bytes: number
  try {
    bytes = (await fs.stat(p)).size
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      throw new Error(`Memory file not found: "${args.name}" in space "${args.space_id}"`)
    }
    throw err
  }
  if (args.dry_run) {
    return { space_id: args.space_id, name: args.name, dry_run: true, deleted: false, bytes }
  }
  await fs.unlink(p)
  return { space_id: args.space_id, name: args.name, dry_run: false, deleted: true, bytes }
}

export const memoryIndexWrite = async (workspaceRoot: string, args: { space_id: string; content: string }) => {
  const p = memoryFilePath(workspaceRoot, args.space_id, 'MEMORY.md')
  await assertRealPathWithinRoot(workspaceRoot, p)
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, args.content, 'utf-8')
  return {
    space_id: args.space_id,
    bytes: Buffer.byteLength(args.content, 'utf-8')
  }
}
