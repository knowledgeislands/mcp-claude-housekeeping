import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { CLAUDE_DESKTOP_ROOT_PATH } from '../../config.js'
import { DESTRUCTIVE, DESTRUCTIVE_ONESHOT, READ_ONLY } from '../../utils/annotations.js'
import { makeRoleGatedRegister } from '../../utils/roles.js'
import { discoverWorkspaces, errorResult, jsonResult, type Workspace } from '../../utils/utils.js'
import * as audit from './audit.js'
import * as memory from './memory.js'
import * as report from './report.js'

const targetWorkspaces = async (workspaceFilter?: string): Promise<Workspace[]> => {
  const all = await discoverWorkspaces(CLAUDE_DESKTOP_ROOT_PATH)
  if (workspaceFilter) {
    const found = all.find((w) => w.id === workspaceFilter)
    if (!found) {
      const available = all.map((w) => w.id).join(', ') || '(none)'
      throw new Error(`Unknown workspace "${workspaceFilter}". Available: ${available}`)
    }
    return [found]
  }
  return all
}

const requireSingleWorkspace = async (workspaceFilter?: string): Promise<Workspace> => {
  const all = await discoverWorkspaces(CLAUDE_DESKTOP_ROOT_PATH)
  if (workspaceFilter) {
    const found = all.find((w) => w.id === workspaceFilter)
    if (!found) {
      const available = all.map((w) => w.id).join(', ') || '(none)'
      throw new Error(`Unknown workspace "${workspaceFilter}". Available: ${available}`)
    }
    return found
  }
  if (all.length === 0) throw new Error(`No workspaces found under CLAUDE_DESKTOP_ROOT_PATH=${CLAUDE_DESKTOP_ROOT_PATH}`)
  if (all.length > 1) {
    const ids = all.map((w) => w.id).join(', ')
    throw new Error(`${all.length} workspaces found; specify "workspace" to pick one: ${ids}`)
  }
  return all[0]
}

const aggregate = async <T>(workspaceFilter: string | undefined, fn: (root: string) => Promise<T>) => {
  const targets = await targetWorkspaces(workspaceFilter)
  const workspaces = await Promise.all(
    targets.map(async (w) => {
      const result = await fn(w.root)
      return { workspace: w.id, ...result } as { workspace: string } & T
    })
  )
  return { root_path: CLAUDE_DESKTOP_ROOT_PATH, workspace_count: workspaces.length, workspaces }
}

const workspaceArg = z.string().optional().describe('Filter to a single workspace by id ("<account>/<workspace>"); omit to run across all.')

export const registerClaudeDesktopTools = (server: McpServer): void => {
  const register = makeRoleGatedRegister(server)

  /* ================================================================ */
  /*  claude_desktop_auditor_* — read-only checks                     */
  /* ================================================================ */

  register(
    'claude_desktop_auditor_storage_summary',
    {
      title: 'Claude Desktop Auditor: session storage summary',
      description: `Audit check 1. For each workspace, count local_* session dirs and JSON files, compute total disk usage and total session-JSON size, find the 5 largest session dirs, and the date of the oldest and newest session JSON. Flag if total size exceeds flag_size_gb (default 2 GB) or session count exceeds flag_session_count (default 1000).`,
      inputSchema: z
        .object({
          flag_size_gb: z.number().default(2).describe('Threshold in GB for flagging total root size.'),
          flag_session_count: z.number().default(1000).describe('Threshold for flagging session count.'),
          workspace: workspaceArg
        })
        .strict(),
      annotations: READ_ONLY
    },
    async ({ workspace, ...args }) => {
      try {
        return jsonResult(await aggregate(workspace, (root) => audit.storageSummary(root, args)))
      } catch (err) {
        return errorResult(`Error in storage_summary: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  )

  register(
    'claude_desktop_auditor_obsolete_sessions',
    {
      title: 'Claude Desktop Auditor: obsolete sessions',
      description: `Audit check 2. Identify sessions whose .json mtime is older than older_than_days (default 30), with their dir+json sizes summed. Returns the 10 oldest by date plus totals per workspace. Flags if obsolete count exceeds flag_count (default 50) or combined size exceeds flag_size_mb (default 500).`,
      inputSchema: z
        .object({
          older_than_days: z.number().default(30),
          flag_count: z.number().default(50),
          flag_size_mb: z.number().default(500),
          workspace: workspaceArg
        })
        .strict(),
      annotations: READ_ONLY
    },
    async ({ workspace, ...args }) => {
      try {
        return jsonResult(await aggregate(workspace, (root) => audit.listObsolete(root, args)))
      } catch (err) {
        return errorResult(`Error in obsolete_sessions: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  )

  register(
    'claude_desktop_auditor_artifact_health',
    {
      title: 'Claude Desktop Auditor: artifact health',
      description: `Audit check 3. Read each workspace's artifacts.json and report each artifact's name, starred status, version count, last-updated date and MCP tools used. Flag artifacts with >flag_versions versions (default 20), not updated in >flag_stale_days days (default 30), or unstarred and not updated in >flag_unstarred_idle_days days (default 14).`,
      inputSchema: z
        .object({
          flag_versions: z.number().default(20),
          flag_stale_days: z.number().default(30),
          flag_unstarred_idle_days: z.number().default(14),
          workspace: workspaceArg
        })
        .strict(),
      annotations: READ_ONLY
    },
    async ({ workspace, ...args }) => {
      try {
        return jsonResult(await aggregate(workspace, (root) => audit.artifactHealth(root, args)))
      } catch (err) {
        return errorResult(`Error in artifact_health: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  )

  register(
    'claude_desktop_auditor_obsolete_outputs',
    {
      title: 'Claude Desktop Auditor: obsolete outputs/uploads',
      description: `Audit check 5. For each local_* session dir in each workspace, list non-empty outputs/ or uploads/ subdirs with file names and sizes. Flag findings whose session is older than older_than_days (default 14).`,
      inputSchema: z
        .object({
          older_than_days: z.number().default(14),
          workspace: workspaceArg
        })
        .strict(),
      annotations: READ_ONLY
    },
    async ({ workspace, ...args }) => {
      try {
        return jsonResult(await aggregate(workspace, (root) => audit.obsoleteOutputs(root, args)))
      } catch (err) {
        return errorResult(`Error in obsolete_outputs: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  )

  register(
    'claude_desktop_auditor_backup_summary',
    {
      title: 'Claude Desktop Auditor: backup file accumulation',
      description: `Audit check 6. Find all .claude.json.backup.* files in each workspace and its backups/ subdir, count them, list dates, sum size. Flag if count exceeds flag_count (default 10) or total size exceeds flag_size_mb (default 5).`,
      inputSchema: z
        .object({
          flag_count: z.number().default(10),
          flag_size_mb: z.number().default(5),
          workspace: workspaceArg
        })
        .strict(),
      annotations: READ_ONLY
    },
    async ({ workspace, ...args }) => {
      try {
        return jsonResult(await aggregate(workspace, (root) => audit.backupSummary(root, args)))
      } catch (err) {
        return errorResult(`Error in backup_summary: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  )

  register(
    'claude_desktop_auditor_memory_spaces_summary',
    {
      title: 'Claude Desktop Auditor: memory spaces summary',
      description: `Audit check 7. List directories under each workspace's spaces/, count .md files in each space's memory/ subdir, return the first 10 lines of MEMORY.md as the index hook. Flag empty spaces (memory_empty / completely_empty) and bloated ones (memory_files > flag_files, default 20).`,
      inputSchema: z
        .object({
          flag_files: z.number().default(20),
          workspace: workspaceArg
        })
        .strict(),
      annotations: READ_ONLY
    },
    async ({ workspace, ...args }) => {
      try {
        return jsonResult(await aggregate(workspace, (root) => audit.memorySpacesSummary(root, args)))
      } catch (err) {
        return errorResult(`Error in memory_spaces_summary: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  )

  register(
    'claude_desktop_auditor_plugins_inventory',
    {
      title: 'Claude Desktop Auditor: plugin inventory',
      description: `Audit check 8. List installed knowledge-work plugins from each workspace's cowork_plugins/installed_plugins.json (with version, installedAt, lastUpdated, age) and rpm/manifest.json plugins (with name, updatedAt). Flags any knowledge-work install whose age is significantly older than the median (>30d above median).`,
      inputSchema: z.object({ workspace: workspaceArg }).strict(),
      annotations: READ_ONLY
    },
    async ({ workspace }) => {
      try {
        return jsonResult(await aggregate(workspace, (root) => audit.pluginsInventory(root)))
      } catch (err) {
        return errorResult(`Error in plugins_inventory: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  )

  register(
    'claude_desktop_auditor_project_cache_status',
    {
      title: 'Claude Desktop Auditor: project cache status',
      description: `Audit check 9. List entries in each workspace's .project-cache/, read each metadata.json (name, synced_at). Flag any not synced in >stale_days days (default 14).`,
      inputSchema: z
        .object({
          stale_days: z.number().default(14),
          workspace: workspaceArg
        })
        .strict(),
      annotations: READ_ONLY
    },
    async ({ workspace, ...args }) => {
      try {
        return jsonResult(await aggregate(workspace, (root) => audit.projectCacheStatus(root, args)))
      } catch (err) {
        return errorResult(`Error in project_cache_status: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  )

  register(
    'claude_desktop_auditor_debug_info',
    {
      title: 'Claude Desktop Auditor: stale debug data',
      description: `Audit check 10. Report each workspace's debug/ size, entry count and oldest-entry age. Flag if size exceeds flag_size_mb (default 10) or oldest entry is older than flag_age_days (default 7).`,
      inputSchema: z
        .object({
          flag_size_mb: z.number().default(10),
          flag_age_days: z.number().default(7),
          workspace: workspaceArg
        })
        .strict(),
      annotations: READ_ONLY
    },
    async ({ workspace, ...args }) => {
      try {
        return jsonResult(await aggregate(workspace, (root) => audit.debugInfo(root, args)))
      } catch (err) {
        return errorResult(`Error in debug_info: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  )

  register(
    'claude_desktop_auditor_workspaces_list',
    {
      title: 'Claude Desktop Auditor: list discovered workspaces',
      description: `List the workspace ids ("<account>/<workspace>") and absolute roots discovered under CLAUDE_DESKTOP_ROOT_PATH. Use the ids when targeting a specific workspace via the optional "workspace" arg on other tools.`,
      inputSchema: z.object({}).strict(),
      annotations: READ_ONLY
    },
    async () => {
      try {
        const ws = await discoverWorkspaces(CLAUDE_DESKTOP_ROOT_PATH)
        return jsonResult({ root_path: CLAUDE_DESKTOP_ROOT_PATH, workspace_count: ws.length, workspaces: ws })
      } catch (err) {
        return errorResult(`Error in workspaces_list: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  )

  register(
    'claude_desktop_auditor_memory_list',
    {
      title: 'Claude Desktop Auditor: list memory files in a space',
      description: `Phase 1 of memory consolidation. List .md files in <workspace>/spaces/<space_id>/memory/ with size and modified date, plus the full content of MEMORY.md (the index) if present. The "workspace" arg is required when more than one workspace is configured.`,
      inputSchema: z
        .object({
          space_id: z.string().min(1).describe('Space directory name (under spaces/).'),
          workspace: workspaceArg
        })
        .strict(),
      annotations: READ_ONLY
    },
    async ({ workspace, ...args }) => {
      try {
        const w = await requireSingleWorkspace(workspace)
        return jsonResult({ workspace: w.id, ...(await memory.memoryList(w.root, args)) })
      } catch (err) {
        return errorResult(`Error in memory_list: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  )

  register(
    'claude_desktop_auditor_memory_read',
    {
      title: 'Claude Desktop Auditor: read a memory file',
      description: `Read the contents of a single memory file at <workspace>/spaces/<space_id>/memory/<name>. Use this to inspect a memory before deciding whether to keep, merge or retire it. The "workspace" arg is required when more than one workspace is configured.`,
      inputSchema: z
        .object({
          space_id: z.string().min(1),
          name: z.string().min(1).regex(/\.md$/, 'Memory file name must end with .md'),
          workspace: workspaceArg
        })
        .strict(),
      annotations: READ_ONLY
    },
    async ({ workspace, ...args }) => {
      try {
        const w = await requireSingleWorkspace(workspace)
        return jsonResult({ workspace: w.id, ...(await memory.memoryRead(w.root, args)) })
      } catch (err) {
        return errorResult(`Error in memory_read: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  )

  register(
    'claude_desktop_auditor_reports_list',
    {
      title: 'Claude Desktop Auditor: list existing audit reports',
      description: `List cowork-audit-*.md files currently in MCP_CLAUDE_HOUSEKEEPING_PATH with size and modified date, sorted newest first. Useful for confirming yesterday's report exists before cleaning, or showing a history.`,
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
  /*  claude_desktop_cleaner_* — destructive operations                */
  /* ================================================================ */

  register(
    'claude_desktop_cleaner_prune_artifacts',
    {
      title: 'Claude Desktop Cleaner: prune unstarred artifacts',
      description: `Audit check 4. Sort UNSTARRED artifacts by lastUpdated descending; keep the top N (default 5) most recent and delete the rest. Pruning removes the entry from artifacts.json AND deletes the matching artifacts/cache_<id>.json file if it exists. Starred artifacts are never pruned. dry_run defaults to TRUE — pass dry_run=false to actually delete. The "workspace" arg is required when more than one workspace is configured. Returns a deletion log per workspace.`,
      inputSchema: z
        .object({
          keep: z.number().default(5).describe('Number of unstarred artifacts to retain.'),
          dry_run: z.boolean().default(true).describe('Default true (preview only). Pass false to actually delete.'),
          workspace: workspaceArg
        })
        .strict(),
      annotations: DESTRUCTIVE_ONESHOT
    },
    async ({ workspace, ...args }) => {
      try {
        const w = await requireSingleWorkspace(workspace)
        return jsonResult({ workspace: w.id, ...(await audit.artifactPrune(w.root, args)) })
      } catch (err) {
        return errorResult(`Error in prune_artifacts: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  )

  register(
    'claude_desktop_cleaner_clear_reports',
    {
      title: 'Claude Desktop Cleaner: delete prior audit reports',
      description: `Step 0 of the daily audit. Delete every cowork-audit-*.md file in MCP_CLAUDE_HOUSEKEEPING_PATH so only today's report is retained. Returns the list of deleted filenames.`,
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

  register(
    'claude_desktop_cleaner_write_report',
    {
      title: "Claude Desktop Cleaner: write today's audit report",
      description: `Save the completed audit markdown to MCP_CLAUDE_HOUSEKEEPING_PATH/cowork-audit-YYYY-MM-DD.md. The date defaults to today (UTC). Creates the housekeeping directory if it does not exist. Returns the absolute path written.`,
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

  register(
    'claude_desktop_cleaner_write_memory',
    {
      title: 'Claude Desktop Cleaner: write/update a memory file',
      description: `Create or overwrite a single memory file at <workspace>/spaces/<space_id>/memory/<name>. Use this when consolidating overlapping memories, sharpening a durable note, or updating relative dates to absolute. The "workspace" arg is required when more than one workspace is configured.`,
      inputSchema: z
        .object({
          space_id: z.string().min(1),
          name: z.string().min(1).regex(/\.md$/, 'Memory file name must end with .md'),
          content: z.string().describe('Full markdown content (frontmatter + body).'),
          workspace: workspaceArg
        })
        .strict(),
      annotations: DESTRUCTIVE
    },
    async ({ workspace, ...args }) => {
      try {
        const w = await requireSingleWorkspace(workspace)
        return jsonResult({ workspace: w.id, ...(await memory.memoryWrite(w.root, args)) })
      } catch (err) {
        return errorResult(`Error in write_memory: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  )

  register(
    'claude_desktop_cleaner_delete_memory',
    {
      title: 'Claude Desktop Cleaner: retire a memory file',
      description: `Delete a single memory file at <workspace>/spaces/<space_id>/memory/<name>. MEMORY.md cannot be deleted via this tool; use write_memory_index to replace it instead. The "workspace" arg is required when more than one workspace is configured.`,
      inputSchema: z
        .object({
          space_id: z.string().min(1),
          name: z.string().min(1).regex(/\.md$/, 'Memory file name must end with .md'),
          workspace: workspaceArg
        })
        .strict(),
      annotations: DESTRUCTIVE_ONESHOT
    },
    async ({ workspace, ...args }) => {
      try {
        const w = await requireSingleWorkspace(workspace)
        return jsonResult({ workspace: w.id, ...(await memory.memoryDelete(w.root, args)) })
      } catch (err) {
        return errorResult(`Error in delete_memory: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  )

  register(
    'claude_desktop_cleaner_write_memory_index',
    {
      title: 'Claude Desktop Cleaner: replace MEMORY.md index',
      description: `Phase 3 of memory consolidation. Replace the contents of <workspace>/spaces/<space_id>/memory/MEMORY.md. Keep the index under 200 lines, one line per entry, format \`- [Title](file.md) — one-line hook\`. The "workspace" arg is required when more than one workspace is configured.`,
      inputSchema: z
        .object({
          space_id: z.string().min(1),
          content: z.string().describe('New MEMORY.md content.'),
          workspace: workspaceArg
        })
        .strict(),
      annotations: DESTRUCTIVE
    },
    async ({ workspace, ...args }) => {
      try {
        const w = await requireSingleWorkspace(workspace)
        return jsonResult({ workspace: w.id, ...(await memory.memoryIndexWrite(w.root, args)) })
      } catch (err) {
        return errorResult(`Error in write_memory_index: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  )
}
