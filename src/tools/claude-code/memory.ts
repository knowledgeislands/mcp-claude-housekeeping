import type { Dirent } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { isNodeError, resolveWithinRoot } from '../../shared/utils.js'

const projectMemoryDir = (claudeRoot: string, project: string): string => {
  return resolveWithinRoot(path.join(claudeRoot, 'projects'), path.join(project, 'memory'))
}

const memoryFilePath = (claudeRoot: string, project: string, name: string): string => {
  if (!name.endsWith('.md')) throw new Error(`Memory file name must end with .md: "${name}"`)
  return resolveWithinRoot(projectMemoryDir(claudeRoot, project), name)
}

export const memoryList = async (claudeRoot: string, args: { project: string }) => {
  const dir = projectMemoryDir(claudeRoot, args.project)
  let entries: Dirent[]
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true })) as Dirent[]
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      throw new Error(`Memory directory not found for project "${args.project}"`)
    }
    throw err
  }
  const files: { name: string; bytes: number; modified: string }[] = []
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue
    const stat = await fs.stat(path.join(dir, e.name))
    files.push({ name: e.name, bytes: stat.size, modified: stat.mtime.toISOString() })
  }
  // Sort: MEMORY.md always first, then everything else alphabetically.
  // Done in two passes rather than via a sort comparator so branch coverage
  // doesn't depend on which orderings V8's TimSort happens to invoke.
  const memoryEntry = files.find((f) => f.name === 'MEMORY.md')
  const rest = files.filter((f) => f.name !== 'MEMORY.md').sort((a, b) => a.name.localeCompare(b.name))
  const sorted = memoryEntry ? [memoryEntry, ...rest] : rest
  files.length = 0
  files.push(...sorted)

  let index: string | null = null
  if (memoryEntry) {
    index = await fs.readFile(path.join(dir, 'MEMORY.md'), 'utf-8')
  }

  return { project: args.project, file_count: files.length, files, index }
}

export const memoryRead = async (claudeRoot: string, args: { project: string; name: string }) => {
  const p = memoryFilePath(claudeRoot, args.project, args.name)
  try {
    const content = await fs.readFile(p, 'utf-8')
    return { project: args.project, name: args.name, content }
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      throw new Error(`Memory file not found: "${args.name}" in project "${args.project}"`)
    }
    throw err
  }
}

export const memoryWrite = async (claudeRoot: string, args: { project: string; name: string; content: string }) => {
  const p = memoryFilePath(claudeRoot, args.project, args.name)
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, args.content, 'utf-8')
  return { project: args.project, name: args.name, bytes: Buffer.byteLength(args.content, 'utf-8') }
}

export const memoryDelete = async (claudeRoot: string, args: { project: string; name: string }) => {
  if (args.name === 'MEMORY.md') {
    throw new Error('Cannot delete MEMORY.md via memory_delete; use write_memory_index to replace its contents.')
  }
  const p = memoryFilePath(claudeRoot, args.project, args.name)
  try {
    await fs.unlink(p)
    return { project: args.project, name: args.name, deleted: true }
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      throw new Error(`Memory file not found: "${args.name}" in project "${args.project}"`)
    }
    throw err
  }
}

export const memoryIndexWrite = async (claudeRoot: string, args: { project: string; content: string }) => {
  const p = memoryFilePath(claudeRoot, args.project, 'MEMORY.md')
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, args.content, 'utf-8')
  return { project: args.project, bytes: Buffer.byteLength(args.content, 'utf-8') }
}
