import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { Config } from '../../config/index.js'
import * as audit from '../../main/claude-desktop/audit.js'
import * as memory from '../../main/claude-desktop/memory.js'
import * as report from '../../main/claude-desktop/report.js'
import * as sessions from '../../main/claude-desktop/sessions.js'
import { DESTRUCTIVE, DESTRUCTIVE_ONESHOT, READ_ONLY } from '../../utils/annotations.js'
import { discoverWorkspaces, errorResult, jsonResult, type Workspace } from '../../utils/utils.js'

const targetWorkspaces = async (rootPath: string, workspaceFilter?: string): Promise<Workspace[]> => {
  const all = await discoverWorkspaces(rootPath)
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

const requireSingleWorkspace = async (rootPath: string, workspaceFilter?: string): Promise<Workspace> => {
  const all = await discoverWorkspaces(rootPath)
  if (workspaceFilter) {
    const found = all.find((w) => w.id === workspaceFilter)
    if (!found) {
      const available = all.map((w) => w.id).join(', ') || '(none)'
      throw new Error(`Unknown workspace "${workspaceFilter}". Available: ${available}`)
    }
    return found
  }
  if (all.length > 1) {
    const ids = all.map((w) => w.id).join(', ')
    throw new Error(`${all.length} workspaces found; specify "workspace" to pick one: ${ids}`)
  }
  const [only] = all
  if (!only) throw new Error(`No workspaces found under CLAUDE_DESKTOP_ROOT_PATH=${rootPath}`)
  return only
}

const aggregate = async <T>(
  rootPath: string,
  workspaceFilter: string | undefined,
  fn: (root: string) => Promise<T>
) => {
  const targets = await targetWorkspaces(rootPath, workspaceFilter)
  const workspaces = await Promise.all(
    targets.map(async (w) => {
      const result = await fn(w.root)
      return { workspace: w.id, ...result } as { workspace: string } & T
    })
  )
  return { root_path: rootPath, workspace_count: workspaces.length, workspaces }
}

const workspaceArg = z
  .string()
  .optional()
  .describe('Filter to a single workspace by id ("<account>/<workspace>"); omit to run across all.')

// A memory space id becomes a path segment under spaces/. Reject anything that
// could escape that dir: path separators, traversal (..), and a leading "-".
// Defense in depth alongside resolveWithinRoot at the call sites.
export const spaceIdArg = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9._-]+$/, 'space_id must be alphanumeric/._- (no path separators or traversal).')
  .refine((s) => s !== '.' && s !== '..' && !s.startsWith('-'), 'space_id must not be ".", ".." or start with "-".')
  .describe('Space directory name (under spaces/).')

// A memory file name becomes a path segment under <space>/memory/. It must end
// in .md and, like spaceIdArg, must not contain separators or traversal.
export const memoryFileNameArg = z
  .string()
  .min(1)
  .max(255)
  .regex(
    /^[A-Za-z0-9._-]+\.md$/,
    'Memory file name must be alphanumeric/._- and end with .md (no path separators or traversal).'
  )
  .refine((s) => !s.startsWith('-') && !s.includes('..'), 'Memory file name must not start with "-" or contain "..".')

const countOutput = z.number().int().nonnegative()
const fileSizeOutput = z.object({ name: z.string(), bytes: countOutput }).strict()
const datedFileSizeOutput = fileSizeOutput.extend({ modified: z.string() }).strict()
const workspaceResultOutput = <T extends z.ZodRawShape>(shape: T) =>
  z
    .object({
      root_path: z.string(),
      workspace_count: countOutput,
      workspaces: z.array(z.object({ workspace: z.string(), ...shape }).strict())
    })
    .strict()

const storageSummaryOutput = workspaceResultOutput({
  session_count: countOutput,
  session_json_count: countOutput,
  total_bytes: countOutput,
  json_total_bytes: countOutput,
  oldest_session_json: z.object({ name: z.string(), date: z.string() }).strict().nullable(),
  newest_session_json: z.object({ name: z.string(), date: z.string() }).strict().nullable(),
  top_5_largest_session_dirs: z.array(fileSizeOutput),
  flags: z.array(z.string())
})
const obsoleteSessionsOutput = workspaceResultOutput({
  cutoff_date: z.string(),
  older_than_days: countOutput,
  obsolete_count: countOutput,
  total_bytes: countOutput,
  top_10_oldest: z.array(
    z
      .object({
        name: z.string(),
        last_activity: z.string(),
        age_days: countOutput,
        bytes: countOutput
      })
      .strict()
  ),
  flags: z.array(z.string())
})
const artifactHealthOutput = workspaceResultOutput({
  total: countOutput,
  starred: countOutput,
  items: z.array(
    z
      .object({
        id: z.string(),
        name: z.string(),
        starred: z.boolean(),
        version_count: countOutput,
        last_updated: z.string().nullable(),
        age_days: countOutput.nullable(),
        mcp_tools: z.array(z.string()),
        flags: z.array(z.string())
      })
      .strict()
  )
})
const obsoleteOutputsOutput = workspaceResultOutput({
  older_than_days: countOutput,
  sessions_with_artifacts: countOutput,
  obsolete_count: countOutput,
  findings: z.array(
    z
      .object({
        session: z.string(),
        session_age_days: countOutput.nullable(),
        obsolete: z.boolean(),
        outputs: z.array(fileSizeOutput),
        uploads: z.array(fileSizeOutput)
      })
      .strict()
  )
})
const backupSummaryOutput = workspaceResultOutput({
  count: countOutput,
  total_bytes: countOutput,
  items: z.array(z.object({ path: z.string(), bytes: countOutput, modified: z.string() }).strict()),
  flags: z.array(z.string())
})
const memorySpacesSummaryOutput = workspaceResultOutput({
  spaces_dir_exists: z.boolean(),
  spaces: z.array(
    z
      .object({
        space_id: z.string(),
        memory_dir_exists: z.boolean(),
        memory_file_count: countOutput,
        memory_files: z.array(z.string()),
        index_hook: z.string().nullable(),
        other_entries: z.array(z.string()),
        flags: z.array(z.string())
      })
      .strict()
  )
})
const pluginsInventoryOutput = workspaceResultOutput({
  knowledge_work: z.array(
    z
      .object({
        plugin: z.string(),
        version: z.string(),
        installed_at: z.string(),
        last_updated: z.string(),
        install_age_days: countOutput
      })
      .strict()
  ),
  rpm: z.array(
    z
      .object({
        id: z.string(),
        name: z.string(),
        updated_at: z.string(),
        marketplace: z.string().optional(),
        installed_by: z.string().optional()
      })
      .strict()
  ),
  flags: z.array(z.string())
})
const projectCacheStatusOutput = workspaceResultOutput({
  cache_dir_exists: z.boolean(),
  projects: z.array(
    z
      .object({
        uuid: z.string(),
        name: z.string().nullable(),
        synced_at: z.string().nullable(),
        sync_age_days: countOutput.nullable(),
        flags: z.array(z.string())
      })
      .strict()
  )
})
const debugInfoOutput = workspaceResultOutput({
  exists: z.boolean(),
  bytes: countOutput,
  entry_count: countOutput,
  oldest_entry_age_days: countOutput.nullable(),
  flags: z.array(z.string())
})
const workspacesListOutput = z
  .object({
    root_path: z.string(),
    workspace_count: countOutput,
    workspaces: z.array(z.object({ id: z.string(), root: z.string() }).strict())
  })
  .strict()
const memoryListOutput = z
  .object({
    workspace: z.string(),
    space_id: z.string(),
    file_count: countOutput,
    files: z.array(datedFileSizeOutput),
    index: z.string().nullable()
  })
  .strict()
const memoryReadOutput = z
  .object({ workspace: z.string(), space_id: z.string(), name: z.string(), content: z.string() })
  .strict()
const reportsListOutput = z
  .object({
    housekeeping_dir: z.string(),
    exists: z.boolean(),
    reports: z.array(datedFileSizeOutput)
  })
  .strict()
const prunedArtifactOutput = z
  .object({
    id: z.string(),
    name: z.string(),
    last_updated: z.string().nullable(),
    version_count: countOutput,
    cache_file_deleted: z.boolean()
  })
  .strict()
const artifactPruneOutput = z.union([
  z
    .object({
      workspace: z.string(),
      kept: countOutput,
      deleted: z.array(prunedArtifactOutput).length(0),
      dry_run: z.boolean(),
      note: z.string()
    })
    .strict(),
  z
    .object({
      workspace: z.string(),
      kept: countOutput,
      deleted_count: countOutput,
      deleted: z.array(prunedArtifactOutput),
      dry_run: z.boolean()
    })
    .strict()
])
const reportsClearOutput = z
  .object({
    housekeeping_dir: z.string(),
    deleted: z.array(z.string()),
    dry_run: z.boolean(),
    note: z.string().optional()
  })
  .strict()
const reportWriteOutput = z.object({ path: z.string(), bytes: countOutput, filename: z.string() }).strict()
const memoryWriteOutput = z
  .object({ workspace: z.string(), space_id: z.string(), name: z.string(), bytes: countOutput })
  .strict()
const memoryDeleteOutput = z
  .object({
    workspace: z.string(),
    space_id: z.string(),
    name: z.string(),
    dry_run: z.boolean(),
    deleted: z.boolean(),
    bytes: countOutput
  })
  .strict()
const memoryIndexWriteOutput = z.object({ workspace: z.string(), space_id: z.string(), bytes: countOutput }).strict()
const sessionRenameOutput = z
  .object({
    workspace: z.string(),
    session_id: z.string(),
    previous_title: z.string().nullable(),
    new_title: z.string(),
    auto_selected: z.boolean(),
    dry_run: z.boolean(),
    renamed: z.boolean()
  })
  .strict()

export const registerClaudeDesktopTools = (server: McpServer, cfg: Config): void => {
  const register = server.registerTool
  const rootPath = cfg.claudeDesktopRootPath
  const housekeepingPath = cfg.housekeepingPath

  /* ================================================================ */
  /*  claude_desktop_* — read-only (annotations: READ_ONLY)            */
  /* ================================================================ */

  register(
    'claude_desktop_storage_summary',
    {
      title: 'Claude Desktop Auditor: session storage summary',
      description: `Audit check 1. For each workspace, count local_* session dirs and JSON files, compute total disk usage and total session-JSON size, find the 5 largest session dirs, and the date of the oldest and newest session JSON. Flag if total size exceeds flag_size_gb (default 2 GB) or session count exceeds flag_session_count (default 1000).`,
      inputSchema: z
        .object({
          flag_size_gb: z
            .number()
            .int()
            .min(0)
            .max(1_000_000)
            .default(2)
            .describe('Threshold in GB for flagging total root size.'),
          flag_session_count: z
            .number()
            .int()
            .min(0)
            .max(10_000_000)
            .default(1000)
            .describe('Threshold for flagging session count.'),
          workspace: workspaceArg
        })
        .strict(),
      outputSchema: storageSummaryOutput,
      annotations: READ_ONLY
    },
    async ({ workspace, ...args }) => {
      try {
        return jsonResult(await aggregate(rootPath, workspace, (root) => audit.storageSummary(root, args)))
      } catch (err) {
        return errorResult('summarising Claude Desktop storage', err)
      }
    }
  )

  register(
    'claude_desktop_sessions_obsolete',
    {
      title: 'Claude Desktop Auditor: obsolete sessions',
      description: `Audit check 2. Identify sessions whose .json mtime is older than older_than_days (default 30), with their dir+json sizes summed. Returns the 10 oldest by date plus totals per workspace. Flags if obsolete count exceeds flag_count (default 50) or combined size exceeds flag_size_mb (default 500).`,
      inputSchema: z
        .object({
          older_than_days: z.number().int().min(0).max(36500).default(30),
          flag_count: z.number().int().min(0).max(10_000_000).default(50),
          flag_size_mb: z.number().int().min(0).max(10_000_000).default(500),
          workspace: workspaceArg
        })
        .strict(),
      outputSchema: obsoleteSessionsOutput,
      annotations: READ_ONLY
    },
    async ({ workspace, ...args }) => {
      try {
        return jsonResult(await aggregate(rootPath, workspace, (root) => audit.listObsolete(root, args)))
      } catch (err) {
        return errorResult('finding obsolete Claude Desktop sessions', err)
      }
    }
  )

  register(
    'claude_desktop_artifacts_health',
    {
      title: 'Claude Desktop Auditor: artifact health',
      description: `Audit check 3. Read each workspace's artifacts.json and report each artifact's name, starred status, version count, last-updated date and MCP tools used. Flag artifacts with >flag_versions versions (default 20), not updated in >flag_stale_days days (default 30), or unstarred and not updated in >flag_unstarred_idle_days days (default 14).`,
      inputSchema: z
        .object({
          flag_versions: z.number().int().min(0).max(10_000_000).default(20),
          flag_stale_days: z.number().int().min(0).max(36500).default(30),
          flag_unstarred_idle_days: z.number().int().min(0).max(36500).default(14),
          workspace: workspaceArg
        })
        .strict(),
      outputSchema: artifactHealthOutput,
      annotations: READ_ONLY
    },
    async ({ workspace, ...args }) => {
      try {
        return jsonResult(await aggregate(rootPath, workspace, (root) => audit.artifactHealth(root, args)))
      } catch (err) {
        return errorResult('checking Claude Desktop artifact health', err)
      }
    }
  )

  register(
    'claude_desktop_outputs_obsolete',
    {
      title: 'Claude Desktop Auditor: obsolete outputs/uploads',
      description: `Audit check 5. For each local_* session dir in each workspace, list non-empty outputs/ or uploads/ subdirs with file names and sizes. Flag findings whose session is older than older_than_days (default 14).`,
      inputSchema: z
        .object({
          older_than_days: z.number().int().min(0).max(36500).default(14),
          workspace: workspaceArg
        })
        .strict(),
      outputSchema: obsoleteOutputsOutput,
      annotations: READ_ONLY
    },
    async ({ workspace, ...args }) => {
      try {
        return jsonResult(await aggregate(rootPath, workspace, (root) => audit.obsoleteOutputs(root, args)))
      } catch (err) {
        return errorResult('finding obsolete Claude Desktop outputs', err)
      }
    }
  )

  register(
    'claude_desktop_backups_summary',
    {
      title: 'Claude Desktop Auditor: backup file accumulation',
      description: `Audit check 6. Find all .claude.json.backup.* files in each workspace and its backups/ subdir, count them, list dates, sum size. Flag if count exceeds flag_count (default 10) or total size exceeds flag_size_mb (default 5).`,
      inputSchema: z
        .object({
          flag_count: z.number().int().min(0).max(10_000_000).default(10),
          flag_size_mb: z.number().int().min(0).max(10_000_000).default(5),
          workspace: workspaceArg
        })
        .strict(),
      outputSchema: backupSummaryOutput,
      annotations: READ_ONLY
    },
    async ({ workspace, ...args }) => {
      try {
        return jsonResult(await aggregate(rootPath, workspace, (root) => audit.backupSummary(root, args)))
      } catch (err) {
        return errorResult('summarising Claude Desktop backups', err)
      }
    }
  )

  register(
    'claude_desktop_memory_spaces_summary',
    {
      title: 'Claude Desktop Auditor: memory spaces summary',
      description: `Audit check 7. List directories under each workspace's spaces/, count .md files in each space's memory/ subdir, return the first 10 lines of MEMORY.md as the index hook. Flag empty spaces (memory_empty / completely_empty) and bloated ones (memory_files > flag_files, default 20).`,
      inputSchema: z
        .object({
          flag_files: z.number().int().min(0).max(10_000_000).default(20),
          workspace: workspaceArg
        })
        .strict(),
      outputSchema: memorySpacesSummaryOutput,
      annotations: READ_ONLY
    },
    async ({ workspace, ...args }) => {
      try {
        return jsonResult(await aggregate(rootPath, workspace, (root) => audit.memorySpacesSummary(root, args)))
      } catch (err) {
        return errorResult('summarising Claude Desktop memory spaces', err)
      }
    }
  )

  register(
    'claude_desktop_plugins_inventory',
    {
      title: 'Claude Desktop Auditor: plugin inventory',
      description: `Audit check 8. List installed knowledge-work plugins from each workspace's cowork_plugins/installed_plugins.json (with version, installedAt, lastUpdated, age) and rpm/manifest.json plugins (with name, updatedAt). Flags any knowledge-work install whose age is significantly older than the median (>30d above median).`,
      inputSchema: z.object({ workspace: workspaceArg }).strict(),
      outputSchema: pluginsInventoryOutput,
      annotations: READ_ONLY
    },
    async ({ workspace }) => {
      try {
        return jsonResult(await aggregate(rootPath, workspace, (root) => audit.pluginsInventory(root)))
      } catch (err) {
        return errorResult('inventorying Claude Desktop plugins', err)
      }
    }
  )

  register(
    'claude_desktop_project_cache_status',
    {
      title: 'Claude Desktop Auditor: project cache status',
      description: `Audit check 9. List entries in each workspace's .project-cache/, read each metadata.json (name, synced_at). Flag any not synced in >stale_days days (default 14).`,
      inputSchema: z
        .object({
          stale_days: z.number().int().min(0).max(36500).default(14),
          workspace: workspaceArg
        })
        .strict(),
      outputSchema: projectCacheStatusOutput,
      annotations: READ_ONLY
    },
    async ({ workspace, ...args }) => {
      try {
        return jsonResult(await aggregate(rootPath, workspace, (root) => audit.projectCacheStatus(root, args)))
      } catch (err) {
        return errorResult('reading Claude Desktop project cache status', err)
      }
    }
  )

  register(
    'claude_desktop_debug_info',
    {
      title: 'Claude Desktop Auditor: stale debug data',
      description: `Audit check 10. Report each workspace's debug/ size, entry count and oldest-entry age. Flag if size exceeds flag_size_mb (default 10) or oldest entry is older than flag_age_days (default 7).`,
      inputSchema: z
        .object({
          flag_size_mb: z.number().int().min(0).max(10_000_000).default(10),
          flag_age_days: z.number().int().min(0).max(36500).default(7),
          workspace: workspaceArg
        })
        .strict(),
      outputSchema: debugInfoOutput,
      annotations: READ_ONLY
    },
    async ({ workspace, ...args }) => {
      try {
        return jsonResult(await aggregate(rootPath, workspace, (root) => audit.debugInfo(root, args)))
      } catch (err) {
        return errorResult('reading Claude Desktop debug info', err)
      }
    }
  )

  register(
    'claude_desktop_workspaces_list',
    {
      title: 'Claude Desktop Auditor: list discovered workspaces',
      description: `List the workspace ids ("<account>/<workspace>") and absolute roots discovered under rootPath. Use the ids when targeting a specific workspace via the optional "workspace" arg on other tools.`,
      inputSchema: z.object({}).strict(),
      outputSchema: workspacesListOutput,
      annotations: READ_ONLY
    },
    async () => {
      try {
        const ws = await discoverWorkspaces(rootPath)
        return jsonResult({ root_path: rootPath, workspace_count: ws.length, workspaces: ws })
      } catch (err) {
        return errorResult('listing Claude Desktop workspaces', err)
      }
    }
  )

  register(
    'claude_desktop_memory_list',
    {
      title: 'Claude Desktop Auditor: list memory files in a space',
      description: `Phase 1 of memory consolidation. List .md files in <workspace>/spaces/<space_id>/memory/ with size and modified date, plus the full content of MEMORY.md (the index) if present. The "workspace" arg is required when more than one workspace is configured.`,
      inputSchema: z
        .object({
          space_id: spaceIdArg,
          workspace: workspaceArg
        })
        .strict(),
      outputSchema: memoryListOutput,
      annotations: READ_ONLY
    },
    async ({ workspace, ...args }) => {
      try {
        const w = await requireSingleWorkspace(rootPath, workspace)
        return jsonResult({ workspace: w.id, ...(await memory.memoryList(w.root, args)) })
      } catch (err) {
        return errorResult('listing Claude Desktop memory files', err)
      }
    }
  )

  register(
    'claude_desktop_memory_read',
    {
      title: 'Claude Desktop Auditor: read a memory file',
      description: `Read the contents of a single memory file at <workspace>/spaces/<space_id>/memory/<name>. Use this to inspect a memory before deciding whether to keep, merge or retire it. The "workspace" arg is required when more than one workspace is configured.`,
      inputSchema: z
        .object({
          space_id: spaceIdArg,
          name: memoryFileNameArg,
          workspace: workspaceArg
        })
        .strict(),
      outputSchema: memoryReadOutput,
      annotations: READ_ONLY
    },
    async ({ workspace, ...args }) => {
      try {
        const w = await requireSingleWorkspace(rootPath, workspace)
        return jsonResult({ workspace: w.id, ...(await memory.memoryRead(w.root, args)) })
      } catch (err) {
        return errorResult('reading Claude Desktop memory file', err)
      }
    }
  )

  register(
    'claude_desktop_reports_list',
    {
      title: 'Claude Desktop Auditor: list existing audit reports',
      description: `List cowork-audit-*.md files currently in MCP_HOUSEKEEPING_CLAUDE_PATH with size and modified date, sorted newest first. Useful for confirming yesterday's report exists before cleaning, or showing a history.`,
      inputSchema: z.object({}).strict(),
      outputSchema: reportsListOutput,
      annotations: READ_ONLY
    },
    async () => {
      try {
        return jsonResult(await report.reportList(housekeepingPath))
      } catch (err) {
        return errorResult('listing Claude Desktop reports', err)
      }
    }
  )

  /* ================================================================ */
  /*  claude_desktop_* — destructive (annotations: DESTRUCTIVE*)       */
  /* ================================================================ */

  register(
    'claude_desktop_artifacts_prune',
    {
      title: 'Claude Desktop Cleaner: prune unstarred artifacts',
      description: `Audit check 4. Sort UNSTARRED artifacts by lastUpdated descending; keep the top N (default 5) most recent and delete the rest. Pruning removes the entry from artifacts.json AND deletes the matching artifacts/cache_<id>.json file if it exists. Starred artifacts are never pruned. dry_run defaults to TRUE — pass dry_run=false to actually delete. The "workspace" arg is required when more than one workspace is configured. Returns a deletion log per workspace.`,
      inputSchema: z
        .object({
          keep: z.number().int().min(0).max(10_000_000).default(5).describe('Number of unstarred artifacts to retain.'),
          dry_run: z.boolean().default(true).describe('Default true (preview only). Pass false to actually delete.'),
          workspace: workspaceArg
        })
        .strict(),
      outputSchema: artifactPruneOutput,
      annotations: DESTRUCTIVE_ONESHOT
    },
    async ({ workspace, ...args }) => {
      try {
        const w = await requireSingleWorkspace(rootPath, workspace)
        return jsonResult({ workspace: w.id, ...(await audit.artifactPrune(w.root, args)) })
      } catch (err) {
        return errorResult('pruning Claude Desktop artifacts', err)
      }
    }
  )

  register(
    'claude_desktop_reports_clear',
    {
      title: 'Claude Desktop Cleaner: delete prior audit reports',
      description: `Step 0 of the daily audit. Delete every cowork-audit-*.md file in MCP_HOUSEKEEPING_CLAUDE_PATH so only today's report is retained. dry_run defaults to TRUE — it lists the files that would be deleted without removing them; pass dry_run=false to actually delete. Returns the list of (deleted or matched) filenames.`,
      inputSchema: z
        .object({
          dry_run: z.boolean().default(true).describe('Default true (preview only). Pass false to actually delete.')
        })
        .strict(),
      outputSchema: reportsClearOutput,
      annotations: DESTRUCTIVE
    },
    async (args) => {
      try {
        return jsonResult(await report.reportClean(housekeepingPath, args))
      } catch (err) {
        return errorResult('clearing Claude Desktop reports', err)
      }
    }
  )

  register(
    'claude_desktop_report_write',
    {
      title: "Claude Desktop Cleaner: write today's audit report",
      description: `Save the completed audit markdown to MCP_HOUSEKEEPING_CLAUDE_PATH/cowork-audit-YYYY-MM-DD.md. The date defaults to today (UTC). Creates the housekeeping directory if it does not exist. Returns the absolute path written.`,
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
      outputSchema: reportWriteOutput,
      annotations: DESTRUCTIVE
    },
    async (args) => {
      try {
        return jsonResult(await report.reportWrite(housekeepingPath, args))
      } catch (err) {
        return errorResult('writing Claude Desktop report', err)
      }
    }
  )

  register(
    'claude_desktop_memory_write',
    {
      title: 'Claude Desktop Cleaner: write/update a memory file',
      description: `Create or overwrite a single memory file at <workspace>/spaces/<space_id>/memory/<name>. Use this when consolidating overlapping memories, sharpening a durable note, or updating relative dates to absolute. The "workspace" arg is required when more than one workspace is configured.`,
      inputSchema: z
        .object({
          space_id: spaceIdArg,
          name: memoryFileNameArg,
          content: z.string().describe('Full markdown content (frontmatter + body).'),
          workspace: workspaceArg
        })
        .strict(),
      outputSchema: memoryWriteOutput,
      annotations: DESTRUCTIVE
    },
    async ({ workspace, ...args }) => {
      try {
        const w = await requireSingleWorkspace(rootPath, workspace)
        return jsonResult({ workspace: w.id, ...(await memory.memoryWrite(w.root, args)) })
      } catch (err) {
        return errorResult('writing Claude Desktop memory file', err)
      }
    }
  )

  register(
    'claude_desktop_memory_delete',
    {
      title: 'Claude Desktop Cleaner: retire a memory file',
      description: `Delete a single memory file at <workspace>/spaces/<space_id>/memory/<name>. MEMORY.md cannot be deleted via this tool; use memory_index_write to replace it instead. dry_run defaults to TRUE — pass dry_run=false to actually delete. The "workspace" arg is required when more than one workspace is configured.`,
      inputSchema: z
        .object({
          space_id: spaceIdArg,
          name: memoryFileNameArg,
          dry_run: z.boolean().default(true).describe('Default true (preview only). Pass false to actually delete.'),
          workspace: workspaceArg
        })
        .strict(),
      outputSchema: memoryDeleteOutput,
      annotations: DESTRUCTIVE_ONESHOT
    },
    async ({ workspace, ...args }) => {
      try {
        const w = await requireSingleWorkspace(rootPath, workspace)
        return jsonResult({ workspace: w.id, ...(await memory.memoryDelete(w.root, args)) })
      } catch (err) {
        return errorResult('deleting Claude Desktop memory file', err)
      }
    }
  )

  register(
    'claude_desktop_memory_index_write',
    {
      title: 'Claude Desktop Cleaner: replace MEMORY.md index',
      description: `Phase 3 of memory consolidation. Replace the contents of <workspace>/spaces/<space_id>/memory/MEMORY.md. Keep the index under 200 lines, one line per entry, format \`- [Title](file.md) — one-line hook\`. The "workspace" arg is required when more than one workspace is configured.`,
      inputSchema: z
        .object({
          space_id: spaceIdArg,
          content: z.string().describe('New MEMORY.md content.'),
          workspace: workspaceArg
        })
        .strict(),
      outputSchema: memoryIndexWriteOutput,
      annotations: DESTRUCTIVE
    },
    async ({ workspace, ...args }) => {
      try {
        const w = await requireSingleWorkspace(rootPath, workspace)
        return jsonResult({ workspace: w.id, ...(await memory.memoryIndexWrite(w.root, args)) })
      } catch (err) {
        return errorResult('writing Claude Desktop MEMORY.md', err)
      }
    }
  )

  register(
    'claude_desktop_session_rename',
    {
      title: 'Claude Desktop Cleaner: set the current session label',
      description: `Set the sidebar label (the \`title\` field of <workspace>/local_<session-id>.json) so the active Cowork session is recognisable in the list. Call once the session's purpose is clear — e.g. "kit-legal · inbound scan · 2026-05-20". Maximum 80 characters; emoji are allowed; control characters are rejected. If "session_id" is omitted, targets the most-recently-active session in the workspace (by lastActivityAt, falling back to file mtime) — Cowork agents share one MCP server process so the server cannot infer the calling session; the most-recent heuristic is correct when only one session is actively writing. Pass session_id explicitly to disambiguate. dry_run defaults to TRUE — it previews the selected session and the new label without writing; pass dry_run=false to actually rename. The "workspace" arg is required when more than one workspace is configured. The Cowork sidebar may not refresh until next reload.`,
      inputSchema: z
        .object({
          name: z
            .string()
            .min(1)
            .max(sessions.SESSION_NAME_MAX)
            .describe('Desired session label (≤80 chars, emoji ok).'),
          session_id: z
            .string()
            .regex(
              /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
              'session_id must be a lower-case UUID with no "local_" prefix.'
            )
            .optional()
            .describe('Bare UUID of the target session; omit to auto-select the most-recently-active one.'),
          dry_run: z.boolean().default(true).describe('Default true (preview only). Pass false to actually rename.'),
          workspace: workspaceArg
        })
        .strict(),
      outputSchema: sessionRenameOutput,
      annotations: DESTRUCTIVE
    },
    async ({ workspace, ...args }) => {
      try {
        const w = await requireSingleWorkspace(rootPath, workspace)
        return jsonResult({ workspace: w.id, ...(await sessions.sessionRename(w.root, args)) })
      } catch (err) {
        return errorResult('renaming Claude Desktop session', err)
      }
    }
  )
}
