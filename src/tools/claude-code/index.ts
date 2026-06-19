import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { Config } from '../../config/index.js'
import * as audit from '../../main/claude-code/audit.js'
import * as memory from '../../main/claude-code/memory.js'
import { DESTRUCTIVE, DESTRUCTIVE_ONESHOT, READ_ONLY } from '../../utils/annotations.js'
import { errorResult, jsonResult } from '../../utils/utils.js'

// Claude Code encodes project source paths with `/` → `-` and `.` → `-`, so the
// subdir name is dash-delimited alphanumeric. Reject anything else before any
// path.join — defense in depth alongside resolveWithinRoot at the call sites.
const projectArg = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9._-]+$/, 'Project name must be alphanumeric/._- (no path separators or traversal).')
  .describe('Project directory name under ~/.claude/projects/ (the encoded path).')
const optionalProjectArg = projectArg.optional()

// A memory file name becomes a path segment under <project>/memory/. It must end
// in .md and, like projectArg, reject path separators, traversal (..), and a
// leading "-". Defense in depth alongside resolveWithinRoot at the call sites.
export const memoryFileNameArg = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9._-]+\.md$/, 'Memory file name must be alphanumeric/._- and end with .md (no path separators or traversal).')
  .refine((s) => !s.startsWith('-') && !s.includes('..'), 'Memory file name must not start with "-" or contain "..".')

const ccProjectsListOutput = z.object({
  projects_dir: z.string(),
  project_count: z.number(),
  projects: z.array(z.object({ id: z.string(), decoded_path: z.string(), source_exists: z.boolean(), session_count: z.number(), has_memory: z.boolean(), bytes: z.number() }))
})
const ccStorageSummaryOutput = z.object({
  claude_root: z.string(),
  project_count: z.number(),
  session_count: z.number(),
  orphan_project_count: z.number(),
  total_bytes: z.number(),
  projects_bytes: z.number(),
  flags: z.array(z.string())
})
const ccObsoleteSessionsOutput = z.object({
  cutoff_date: z.string(),
  older_than_days: z.number(),
  obsolete_count: z.number(),
  total_bytes: z.number(),
  top_10_oldest: z.array(z.object({ project: z.string(), session: z.string(), last_activity: z.string(), age_days: z.number(), bytes: z.number() })),
  flags: z.array(z.string())
})
const ccGlobalStatusOutput = z.object({
  claude_root: z.string(),
  history: z.object({ exists: z.boolean(), bytes: z.number(), modified: z.string().nullable(), lines: z.number().optional() }),
  settings: z.object({ exists: z.boolean(), cleanup_period_days: z.number().nullable() }),
  last_cleanup: z.string().nullable(),
  top_level_dirs: z.array(z.object({ name: z.string(), bytes: z.number(), modified: z.string().nullable() })),
  freshness: z.object({ oldest_top_level_age_hours: z.number().nullable(), looks_freshly_initialized: z.boolean() })
})
const ccSessionReadOutput = z.object({
  project: z.string(),
  session: z.string(),
  bytes: z.number(),
  line_count: z.number(),
  lines: z.array(z.string())
})
const ccMemoryListOutput = z.object({
  project: z.string(),
  file_count: z.number(),
  files: z.array(z.object({ name: z.string(), bytes: z.number(), modified: z.string() })),
  index: z.string().nullable()
})
const ccMemoryReadOutput = z.object({
  project: z.string(),
  name: z.string(),
  content: z.string()
})
const ccSessionsPruneOutput = z.object({
  cutoff_date: z.string(),
  older_than_days: z.number(),
  dry_run: z.boolean(),
  deleted_count: z.number(),
  total_bytes_freed: z.number(),
  deleted: z.array(z.object({ project: z.string(), session: z.string(), age_days: z.number(), bytes: z.number(), sidecar_deleted: z.boolean() }))
})
const ccProjectRelocateOutput = z.object({
  project: z.string(),
  new_id: z.string(),
  new_path: z.string(),
  dry_run: z.boolean(),
  moved: z.boolean(),
  reason: z.string().optional()
})
const ccOrphanProjectsPruneOutput = z.object({
  dry_run: z.boolean(),
  include_with_memory: z.boolean(),
  orphan_count: z.number(),
  deleted_count: z.number(),
  total_bytes_freed: z.number(),
  deleted: z.array(z.object({ id: z.string(), decoded_path: z.string(), session_count: z.number(), bytes: z.number() })),
  skipped: z.array(z.object({ id: z.string(), decoded_path: z.string(), reason: z.string() }))
})
const ccMemoryWriteOutput = z.object({
  project: z.string(),
  name: z.string(),
  bytes: z.number()
})
const ccMemoryDeleteOutput = z.object({
  project: z.string(),
  name: z.string(),
  dry_run: z.boolean(),
  deleted: z.boolean(),
  bytes: z.number()
})
const ccMemoryIndexWriteOutput = z.object({
  project: z.string(),
  bytes: z.number()
})

export const registerClaudeCodeTools = (server: McpServer, cfg: Config): void => {
  const register = server.registerTool
  const claudeCodeRootPath = cfg.claudeCodeRootPath

  /* ================================================================ */
  /*  claude_code_* — read-only (annotations: READ_ONLY)               */
  /* ================================================================ */

  register(
    'claude_code_projects_list',
    {
      title: 'Claude Code Auditor: list projects',
      description: `List every project under ~/.claude/projects/ with session-file count, on-disk size, whether a memory/ subdir exists, and a best-effort decode of the encoded directory name back to the original filesystem path (with source_exists indicating whether that decoded path still resolves on disk). Sorted by bytes descending.`,
      inputSchema: z.object({}).strict(),
      outputSchema: ccProjectsListOutput,
      annotations: READ_ONLY
    },
    async () => {
      try {
        return jsonResult(await audit.projectsList(claudeCodeRootPath))
      } catch (err) {
        return errorResult('listing Claude Code projects', err)
      }
    }
  )

  register(
    'claude_code_storage_summary',
    {
      title: 'Claude Code Auditor: storage summary',
      description: `Aggregate stats across ~/.claude: total bytes, projects bytes, project count, session count, orphan-project count (projects whose decoded source path no longer exists). Flags large total size, high session count, or many orphans.`,
      inputSchema: z
        .object({
          flag_size_gb: z.number().int().min(0).max(1_000_000).default(2),
          flag_session_count: z.number().int().min(0).max(10_000_000).default(500),
          flag_orphan_count: z.number().int().min(0).max(10_000_000).default(5)
        })
        .strict(),
      outputSchema: ccStorageSummaryOutput,
      annotations: READ_ONLY
    },
    async (args) => {
      try {
        return jsonResult(await audit.storageSummary(claudeCodeRootPath, args))
      } catch (err) {
        return errorResult('summarising Claude Code storage', err)
      }
    }
  )

  register(
    'claude_code_sessions_obsolete',
    {
      title: 'Claude Code Auditor: obsolete sessions',
      description: `Find session .jsonl files (and any matching <uuid>/ sidecar dirs) older than older_than_days (default 30) across all projects (or one project if "project" is set). Returns the 10 oldest plus totals; flags counts or sizes that exceed thresholds.`,
      inputSchema: z
        .object({
          older_than_days: z.number().int().min(0).max(36500).default(30),
          flag_count: z.number().int().min(0).max(10_000_000).default(50),
          flag_size_mb: z.number().int().min(0).max(10_000_000).default(500),
          project: optionalProjectArg
        })
        .strict(),
      outputSchema: ccObsoleteSessionsOutput,
      annotations: READ_ONLY
    },
    async (args) => {
      try {
        return jsonResult(await audit.obsoleteSessions(claudeCodeRootPath, args))
      } catch (err) {
        return errorResult('finding obsolete Claude Code sessions', err)
      }
    }
  )

  register(
    'claude_code_global_status',
    {
      title: 'Claude Code Auditor: global status',
      description: `Report ~/.claude top-level state: history.jsonl size+mtime+line count if present, settings.json existence and cleanupPeriodDays, .last-cleanup contents, plus a sorted list of every top-level dir with its bytes (so bloated subtrees like file-history/ or plugins/ are visible).`,
      inputSchema: z.object({}).strict(),
      outputSchema: ccGlobalStatusOutput,
      annotations: READ_ONLY
    },
    async () => {
      try {
        return jsonResult(await audit.globalStatus(claudeCodeRootPath))
      } catch (err) {
        return errorResult('reading Claude Code global status', err)
      }
    }
  )

  register(
    'claude_code_session_read',
    {
      title: 'Claude Code Auditor: read session JSONL (preview)',
      description: `Return the first or last N lines of a session JSONL at ~/.claude/projects/<project>/<session>. Use tail=true to peek the most recent turns. Cap with max_lines to keep responses small — full files can be megabytes.`,
      inputSchema: z
        .object({
          project: projectArg,
          session: z
            .string()
            .min(1)
            .regex(/^[0-9a-f-]{36}\.jsonl$/i, 'Session name must be a UUID with .jsonl extension'),
          max_lines: z.number().int().min(1).max(2000).default(50),
          tail: z.boolean().default(true).describe('If true, return the last N lines; if false, the first N.')
        })
        .strict(),
      outputSchema: ccSessionReadOutput,
      annotations: READ_ONLY
    },
    async (args) => {
      try {
        return jsonResult(await audit.sessionRead(claudeCodeRootPath, args))
      } catch (err) {
        return errorResult('reading Claude Code session', err)
      }
    }
  )

  register(
    'claude_code_memory_list',
    {
      title: 'Claude Code Auditor: list memory files',
      description: `List .md files in ~/.claude/projects/<project>/memory/ with size and modified date, plus the full content of MEMORY.md if present.`,
      inputSchema: z.object({ project: projectArg }).strict(),
      outputSchema: ccMemoryListOutput,
      annotations: READ_ONLY
    },
    async (args) => {
      try {
        return jsonResult(await memory.memoryList(claudeCodeRootPath, args))
      } catch (err) {
        return errorResult('listing Claude Code memory files', err)
      }
    }
  )

  register(
    'claude_code_memory_read',
    {
      title: 'Claude Code Auditor: read memory file',
      description: `Read the contents of a single memory file at ~/.claude/projects/<project>/memory/<name>.`,
      inputSchema: z
        .object({
          project: projectArg,
          name: z.string().min(1).regex(/\.md$/, 'Memory file name must end with .md')
        })
        .strict(),
      outputSchema: ccMemoryReadOutput,
      annotations: READ_ONLY
    },
    async (args) => {
      try {
        return jsonResult(await memory.memoryRead(claudeCodeRootPath, args))
      } catch (err) {
        return errorResult('reading Claude Code memory file', err)
      }
    }
  )

  /* ================================================================ */
  /*  claude_code_* — destructive (annotations: DESTRUCTIVE*)          */
  /* ================================================================ */

  register(
    'claude_code_sessions_prune',
    {
      title: 'Claude Code Cleaner: prune obsolete sessions',
      description: `Delete every <uuid>.jsonl session (and matching <uuid>/ sidecar dir if any) older than older_than_days across all projects (or the one named in "project"). dry_run defaults to TRUE — pass dry_run=false to actually delete. Returns a list of deletions with bytes freed.`,
      inputSchema: z
        .object({
          older_than_days: z.number().int().min(0).max(36500).default(60),
          project: optionalProjectArg,
          dry_run: z.boolean().default(true).describe('Default true (preview only). Pass false to actually delete.')
        })
        .strict(),
      outputSchema: ccSessionsPruneOutput,
      annotations: DESTRUCTIVE_ONESHOT
    },
    async (args) => {
      try {
        return jsonResult(await audit.sessionsPrune(claudeCodeRootPath, args))
      } catch (err) {
        return errorResult('pruning Claude Code sessions', err)
      }
    }
  )

  register(
    'claude_code_project_relocate',
    {
      title: 'Claude Code Cleaner: relocate project subdir',
      description: `Rename a project subdir under ~/.claude/projects/ to match the encoding of "new_path". Use after renaming or moving the project source folder so /resume keeps finding the session history. Rejects if the destination encoded name already exists or new_path doesn't resolve on disk. dry_run defaults to TRUE — pass dry_run=false to actually rename.`,
      inputSchema: z
        .object({
          project: projectArg,
          new_path: z.string().min(1).describe('Absolute filesystem path of the renamed/moved project source dir.'),
          dry_run: z.boolean().default(true).describe('Default true (preview only). Pass false to actually rename.')
        })
        .strict(),
      outputSchema: ccProjectRelocateOutput,
      annotations: DESTRUCTIVE_ONESHOT
    },
    async (args) => {
      try {
        return jsonResult(await audit.relocateProject(claudeCodeRootPath, args))
      } catch (err) {
        return errorResult('relocating Claude Code project', err)
      }
    }
  )

  register(
    'claude_code_orphan_projects_prune',
    {
      title: 'Claude Code Cleaner: prune orphan project subdirs',
      description: `Delete project subdirs whose decoded source path no longer exists on disk. By default, skips orphans that contain a memory/ subdir (the most expensive thing to lose by accident); set include_with_memory=true to clear those too. dry_run defaults to TRUE — pass dry_run=false to actually delete. Run claude_code_projects_list first to confirm what's being targeted — and consider claude_code_project_relocate for any orphans that are really renames.`,
      inputSchema: z
        .object({
          dry_run: z.boolean().default(true).describe('Default true (preview only). Pass false to actually delete.'),
          include_with_memory: z.boolean().default(false)
        })
        .strict(),
      outputSchema: ccOrphanProjectsPruneOutput,
      annotations: DESTRUCTIVE_ONESHOT
    },
    async (args) => {
      try {
        return jsonResult(await audit.pruneOrphanProjects(claudeCodeRootPath, args))
      } catch (err) {
        return errorResult('pruning orphan Claude Code projects', err)
      }
    }
  )

  register(
    'claude_code_memory_write',
    {
      title: 'Claude Code Cleaner: write/update memory file',
      description: `Create or overwrite a memory file at ~/.claude/projects/<project>/memory/<name>.`,
      inputSchema: z
        .object({
          project: projectArg,
          name: memoryFileNameArg,
          content: z.string()
        })
        .strict(),
      outputSchema: ccMemoryWriteOutput,
      annotations: DESTRUCTIVE
    },
    async (args) => {
      try {
        return jsonResult(await memory.memoryWrite(claudeCodeRootPath, args))
      } catch (err) {
        return errorResult('writing Claude Code memory file', err)
      }
    }
  )

  register(
    'claude_code_memory_delete',
    {
      title: 'Claude Code Cleaner: retire memory file',
      description: `Delete a memory file at ~/.claude/projects/<project>/memory/<name>. MEMORY.md cannot be deleted via this tool — use memory_index_write to replace it. dry_run defaults to TRUE — pass dry_run=false to actually delete.`,
      inputSchema: z
        .object({
          project: projectArg,
          name: memoryFileNameArg,
          dry_run: z.boolean().default(true).describe('Default true (preview only). Pass false to actually delete.')
        })
        .strict(),
      outputSchema: ccMemoryDeleteOutput,
      annotations: DESTRUCTIVE_ONESHOT
    },
    async (args) => {
      try {
        return jsonResult(await memory.memoryDelete(claudeCodeRootPath, args))
      } catch (err) {
        return errorResult('deleting Claude Code memory file', err)
      }
    }
  )

  register(
    'claude_code_memory_index_write',
    {
      title: 'Claude Code Cleaner: replace MEMORY.md',
      description: `Replace the contents of ~/.claude/projects/<project>/memory/MEMORY.md.`,
      inputSchema: z.object({ project: projectArg, content: z.string() }).strict(),
      outputSchema: ccMemoryIndexWriteOutput,
      annotations: DESTRUCTIVE
    },
    async (args) => {
      try {
        return jsonResult(await memory.memoryIndexWrite(claudeCodeRootPath, args))
      } catch (err) {
        return errorResult('writing Claude Code MEMORY.md', err)
      }
    }
  )
}
