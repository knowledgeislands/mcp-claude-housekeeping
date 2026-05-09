#!/usr/bin/env node

/**
 * mcp-local-agent-mode-sessions
 *
 * Local stdio MCP server that codifies the Cowork local-agent-mode-sessions
 * filesystem audit. Tool surface:
 *
 *   sessions_audit_*    Read-only checks (audit + read-only report/memory).
 *   sessions_cleaner_*  Destructive operations (prune, delete, write).
 *
 * Configuration (environment variables):
 *   ROOT_PATH           Absolute or ~ path to the local-agent-mode-sessions root.
 *   HOUSEKEEPING_PATH   Absolute or ~ path to the directory where audit reports
 *                       are written (e.g. the Claude Housekeeping project folder).
 */

import * as fs from 'node:fs/promises'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import * as audit from './audit.js'
import { HOUSEKEEPING_PATH, ROOT_PATH } from './config.js'
import * as memory from './memory.js'
import * as report from './report.js'
import { errorResult, jsonResult } from './utils.js'

console.error(`mcp-local-agent-mode-sessions starting...`)
console.error(`  ROOT_PATH=${ROOT_PATH}`)
console.error(`  HOUSEKEEPING_PATH=${HOUSEKEEPING_PATH}`)

const server = new McpServer({
  name: 'mcp-local-agent-mode-sessions',
  version: '1.0.0'
})

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const
const DESTRUCTIVE_ONESHOT = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const

/* ================================================================ */
/*  sessions_audit_* — read-only checks                             */
/* ================================================================ */

server.registerTool(
  'sessions_audit_storage_summary',
  {
    title: 'Audit: session storage summary',
    description: `Audit check 1. Count local_* session dirs and JSON files in ROOT_PATH, compute total disk usage and total session-JSON size, find the 5 largest session dirs, and the date of the oldest and newest session JSON. Flag if total size exceeds flag_size_gb (default 2 GB) or session count exceeds flag_session_count (default 1000).`,
    inputSchema: z
      .object({
        flag_size_gb: z.number().default(2).describe('Threshold in GB for flagging total root size.'),
        flag_session_count: z.number().default(1000).describe('Threshold for flagging session count.')
      })
      .strict(),
    annotations: READ_ONLY
  },
  async (args) => {
    try {
      return jsonResult(await audit.storageSummary(args))
    } catch (err) {
      return errorResult(`Error in storage_summary: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
)

server.registerTool(
  'sessions_audit_obsolete_sessions',
  {
    title: 'Audit: obsolete sessions',
    description: `Audit check 2. Identify sessions whose .json mtime is older than older_than_days (default 30), with their dir+json sizes summed. Returns the 10 oldest by date plus totals. Flags if obsolete count exceeds flag_count (default 50) or combined size exceeds flag_size_mb (default 500).`,
    inputSchema: z
      .object({
        older_than_days: z.number().default(30),
        flag_count: z.number().default(50),
        flag_size_mb: z.number().default(500)
      })
      .strict(),
    annotations: READ_ONLY
  },
  async (args) => {
    try {
      return jsonResult(await audit.listObsolete(args))
    } catch (err) {
      return errorResult(`Error in obsolete_sessions: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
)

server.registerTool(
  'sessions_audit_artifact_health',
  {
    title: 'Audit: artifact health',
    description: `Audit check 3. Read artifacts.json and report each artifact's name, starred status, version count, last-updated date and MCP tools used. Flag artifacts with >flag_versions versions (default 20), not updated in >flag_stale_days days (default 30), or unstarred and not updated in >flag_unstarred_idle_days days (default 14).`,
    inputSchema: z
      .object({
        flag_versions: z.number().default(20),
        flag_stale_days: z.number().default(30),
        flag_unstarred_idle_days: z.number().default(14)
      })
      .strict(),
    annotations: READ_ONLY
  },
  async (args) => {
    try {
      return jsonResult(await audit.artifactHealth(args))
    } catch (err) {
      return errorResult(`Error in artifact_health: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
)

server.registerTool(
  'sessions_audit_obsolete_outputs',
  {
    title: 'Audit: obsolete outputs/uploads',
    description: `Audit check 5. For each local_* session dir, list non-empty outputs/ or uploads/ subdirs with file names and sizes. Flag findings whose session is older than older_than_days (default 14).`,
    inputSchema: z
      .object({
        older_than_days: z.number().default(14)
      })
      .strict(),
    annotations: READ_ONLY
  },
  async (args) => {
    try {
      return jsonResult(await audit.obsoleteOutputs(args))
    } catch (err) {
      return errorResult(`Error in obsolete_outputs: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
)

server.registerTool(
  'sessions_audit_backup_summary',
  {
    title: 'Audit: backup file accumulation',
    description: `Audit check 6. Find all .claude.json.backup.* files in ROOT_PATH and ROOT_PATH/backups, count them, list dates, sum size. Flag if count exceeds flag_count (default 10) or total size exceeds flag_size_mb (default 5).`,
    inputSchema: z
      .object({
        flag_count: z.number().default(10),
        flag_size_mb: z.number().default(5)
      })
      .strict(),
    annotations: READ_ONLY
  },
  async (args) => {
    try {
      return jsonResult(await audit.backupSummary(args))
    } catch (err) {
      return errorResult(`Error in backup_summary: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
)

server.registerTool(
  'sessions_audit_memory_spaces_summary',
  {
    title: 'Audit: memory spaces summary',
    description: `Audit check 7. List directories under spaces/, count .md files in each space's memory/ subdir, return the first 10 lines of MEMORY.md as the index hook. Flag empty spaces (memory_empty / completely_empty) and bloated ones (memory_files > flag_files, default 20).`,
    inputSchema: z
      .object({
        flag_files: z.number().default(20)
      })
      .strict(),
    annotations: READ_ONLY
  },
  async (args) => {
    try {
      return jsonResult(await audit.memorySpacesSummary(args))
    } catch (err) {
      return errorResult(`Error in memory_spaces_summary: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
)

server.registerTool(
  'sessions_audit_plugins_inventory',
  {
    title: 'Audit: plugin inventory',
    description: `Audit check 8. List installed knowledge-work plugins from cowork_plugins/installed_plugins.json (with version, installedAt, lastUpdated, age) and rpm/manifest.json plugins (with name, updatedAt). Flags any knowledge-work install whose age is significantly older than the median (>30d above median).`,
    inputSchema: z.object({}).strict(),
    annotations: READ_ONLY
  },
  async () => {
    try {
      return jsonResult(await audit.pluginsInventory())
    } catch (err) {
      return errorResult(`Error in plugins_inventory: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
)

server.registerTool(
  'sessions_audit_project_cache_status',
  {
    title: 'Audit: project cache status',
    description: `Audit check 9. List entries in .project-cache/, read each metadata.json (name, synced_at). Flag any not synced in >stale_days days (default 14).`,
    inputSchema: z
      .object({
        stale_days: z.number().default(14)
      })
      .strict(),
    annotations: READ_ONLY
  },
  async (args) => {
    try {
      return jsonResult(await audit.projectCacheStatus(args))
    } catch (err) {
      return errorResult(`Error in project_cache_status: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
)

server.registerTool(
  'sessions_audit_debug_info',
  {
    title: 'Audit: stale debug data',
    description: `Audit check 10. Report debug/ size, entry count and oldest-entry age. Flag if size exceeds flag_size_mb (default 10) or oldest entry is older than flag_age_days (default 7).`,
    inputSchema: z
      .object({
        flag_size_mb: z.number().default(10),
        flag_age_days: z.number().default(7)
      })
      .strict(),
    annotations: READ_ONLY
  },
  async (args) => {
    try {
      return jsonResult(await audit.debugInfo(args))
    } catch (err) {
      return errorResult(`Error in debug_info: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
)

server.registerTool(
  'sessions_audit_memory_list',
  {
    title: 'Audit: list memory files in a space',
    description: `Phase 1 of memory consolidation. List .md files in spaces/<space_id>/memory/ with size and modified date, plus the full content of MEMORY.md (the index) if present.`,
    inputSchema: z
      .object({
        space_id: z.string().min(1).describe('Space directory name (under spaces/).')
      })
      .strict(),
    annotations: READ_ONLY
  },
  async (args) => {
    try {
      return jsonResult(await memory.memoryList(args))
    } catch (err) {
      return errorResult(`Error in memory_list: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
)

server.registerTool(
  'sessions_audit_memory_read',
  {
    title: 'Audit: read a memory file',
    description: `Read the contents of a single memory file at spaces/<space_id>/memory/<name>. Use this to inspect a memory before deciding whether to keep, merge or retire it.`,
    inputSchema: z
      .object({
        space_id: z.string().min(1),
        name: z.string().min(1).regex(/\.md$/, 'Memory file name must end with .md')
      })
      .strict(),
    annotations: READ_ONLY
  },
  async (args: { space_id: string; name: string }) => {
    try {
      return jsonResult(await memory.memoryRead(args))
    } catch (err) {
      return errorResult(`Error in memory_read: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
)

server.registerTool(
  'sessions_audit_report_list',
  {
    title: 'Audit: list existing audit reports',
    description: `List cowork-audit-*.md files currently in HOUSEKEEPING_PATH with size and modified date, sorted newest first. Useful for confirming yesterday's report exists before cleaning, or showing a history.`,
    inputSchema: z.object({}).strict(),
    annotations: READ_ONLY
  },
  async () => {
    try {
      return jsonResult(await report.reportList())
    } catch (err) {
      return errorResult(`Error in report_list: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
)

/* ================================================================ */
/*  sessions_cleaner_* — destructive operations                     */
/* ================================================================ */

server.registerTool(
  'sessions_cleaner_prune_artifacts',
  {
    title: 'Cleaner: prune unstarred artifacts',
    description: `Audit check 4. Sort UNSTARRED artifacts by lastUpdated descending; keep the top N (default 5) most recent and delete the rest. Pruning removes the entry from artifacts.json AND deletes the matching artifacts/cache_<id>.json file if it exists. Starred artifacts are never pruned. Set dry_run=true to preview without writing. Returns a deletion log.`,
    inputSchema: z
      .object({
        keep: z.number().default(5).describe('Number of unstarred artifacts to retain.'),
        dry_run: z.boolean().default(false).describe('Preview deletions without modifying files.')
      })
      .strict(),
    annotations: DESTRUCTIVE_ONESHOT
  },
  async (args) => {
    try {
      return jsonResult(await audit.artifactPrune(args))
    } catch (err) {
      return errorResult(`Error in prune_artifacts: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
)

server.registerTool(
  'sessions_cleaner_clear_reports',
  {
    title: 'Cleaner: delete prior audit reports',
    description: `Step 0 of the daily audit. Delete every cowork-audit-*.md file in HOUSEKEEPING_PATH so only today's report is retained. Returns the list of deleted filenames.`,
    inputSchema: z.object({}).strict(),
    annotations: DESTRUCTIVE
  },
  async () => {
    try {
      return jsonResult(await report.reportClean())
    } catch (err) {
      return errorResult(`Error in clear_reports: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
)

server.registerTool(
  'sessions_cleaner_write_report',
  {
    title: "Cleaner: write today's audit report",
    description: `Save the completed audit markdown to HOUSEKEEPING_PATH/cowork-audit-YYYY-MM-DD.md. The date defaults to today (UTC). Creates the housekeeping directory if it does not exist. Returns the absolute path written.`,
    inputSchema: z
      .object({
        content: z.string().describe('Full markdown content of the audit report.'),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe('YYYY-MM-DD; defaults to today (UTC).')
      })
      .strict(),
    annotations: DESTRUCTIVE
  },
  async (args) => {
    try {
      return jsonResult(await report.reportWrite(args))
    } catch (err) {
      return errorResult(`Error in write_report: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
)

server.registerTool(
  'sessions_cleaner_write_memory',
  {
    title: 'Cleaner: write/update a memory file',
    description: `Create or overwrite a single memory file at spaces/<space_id>/memory/<name>. Use this when consolidating overlapping memories, sharpening a durable note, or updating relative dates to absolute.`,
    inputSchema: z
      .object({
        space_id: z.string().min(1),
        name: z.string().min(1).regex(/\.md$/, 'Memory file name must end with .md'),
        content: z.string().describe('Full markdown content (frontmatter + body).')
      })
      .strict(),
    annotations: DESTRUCTIVE
  },
  async (args) => {
    try {
      return jsonResult(await memory.memoryWrite(args))
    } catch (err) {
      return errorResult(`Error in write_memory: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
)

server.registerTool(
  'sessions_cleaner_delete_memory',
  {
    title: 'Cleaner: retire a memory file',
    description: `Delete a single memory file at spaces/<space_id>/memory/<name>. MEMORY.md cannot be deleted via this tool; use write_memory_index to replace it instead.`,
    inputSchema: z
      .object({
        space_id: z.string().min(1),
        name: z.string().min(1).regex(/\.md$/, 'Memory file name must end with .md')
      })
      .strict(),
    annotations: DESTRUCTIVE_ONESHOT
  },
  async (args) => {
    try {
      return jsonResult(await memory.memoryDelete(args))
    } catch (err) {
      return errorResult(`Error in delete_memory: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
)

server.registerTool(
  'sessions_cleaner_write_memory_index',
  {
    title: 'Cleaner: replace MEMORY.md index',
    description: `Phase 3 of memory consolidation. Replace the contents of spaces/<space_id>/memory/MEMORY.md. Keep the index under 200 lines, one line per entry, format \`- [Title](file.md) — one-line hook\`.`,
    inputSchema: z
      .object({
        space_id: z.string().min(1),
        content: z.string().describe('New MEMORY.md content.')
      })
      .strict(),
    annotations: DESTRUCTIVE
  },
  async (args) => {
    try {
      return jsonResult(await memory.memoryIndexWrite(args))
    } catch (err) {
      return errorResult(`Error in write_memory_index: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
)

/* ================================================================ */
/*  Boot                                                            */
/* ================================================================ */

const main = async (): Promise<void> => {
  try {
    await fs.access(ROOT_PATH)
  } catch {
    console.error(`mcp-local-agent-mode-sessions: ROOT_PATH not accessible: ${ROOT_PATH}\nSet ROOT_PATH to the local-agent-mode-sessions inner directory and restart.`)
    return
  }

  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`mcp-local-agent-mode-sessions ready`)
}

main().catch((err) => {
  console.error('mcp-local-agent-mode-sessions fatal:', err)
  process.exit(1)
})
