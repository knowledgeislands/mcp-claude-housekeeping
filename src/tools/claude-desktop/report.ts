import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { HOUSEKEEPING_PATH } from '../../config.js'
import { isNodeError } from '../../shared/utils.js'

const REPORT_PATTERN = /^cowork-audit-.*\.md$/

export const reportList = async () => {
  let entries: string[]
  try {
    entries = await fs.readdir(HOUSEKEEPING_PATH)
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      return { housekeeping_dir: HOUSEKEEPING_PATH, exists: false, reports: [] }
    }
    throw err
  }
  const matches = entries.filter((e) => REPORT_PATTERN.test(e))
  const reports = await Promise.all(
    matches.map(async (name) => {
      const stat = await fs.stat(path.join(HOUSEKEEPING_PATH, name))
      return { name, bytes: stat.size, modified: stat.mtime.toISOString() }
    })
  )
  reports.sort((a, b) => b.modified.localeCompare(a.modified))
  return { housekeeping_dir: HOUSEKEEPING_PATH, exists: true, reports }
}

export const reportClean = async () => {
  let entries: string[]
  try {
    entries = await fs.readdir(HOUSEKEEPING_PATH)
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      return { housekeeping_dir: HOUSEKEEPING_PATH, deleted: [], note: 'Housekeeping directory does not yet exist; nothing to clean.' }
    }
    throw err
  }
  const matches = entries.filter((e) => REPORT_PATTERN.test(e))
  for (const name of matches) {
    await fs.unlink(path.join(HOUSEKEEPING_PATH, name))
  }
  return { housekeeping_dir: HOUSEKEEPING_PATH, deleted: matches }
}

export const reportWrite = async (args: { content: string; date?: string }) => {
  const date = args.date ?? new Date().toISOString().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid date "${date}" — expected YYYY-MM-DD`)
  }
  await fs.mkdir(HOUSEKEEPING_PATH, { recursive: true })
  const filename = `cowork-audit-${date}.md`
  const fullPath = path.join(HOUSEKEEPING_PATH, filename)
  await fs.writeFile(fullPath, args.content, 'utf-8')
  return {
    path: fullPath,
    bytes: Buffer.byteLength(args.content, 'utf-8'),
    filename
  }
}
