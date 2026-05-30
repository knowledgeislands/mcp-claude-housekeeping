import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { CLAUDE_CODE_ROOT_PATH } from '../../config.js'
import { makeAccessGatedRegister } from '../../utils/access-level.js'
import { DESTRUCTIVE, DESTRUCTIVE_ONESHOT, READ_ONLY } from '../../utils/annotations.js'
import { errorResult, jsonResult } from '../../utils/utils.js'
import * as audit from './audit.js'
import * as memory from './memory.js'

// Claude Code encodes project source paths with `/` → `-` and `.` → `-`, so the
// subdir name is dash-delimited alphanumeric. Reject anything else before any
// path.join — defense in depth alongside resolveWithinRoot at the call sites.
const projectArg = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9._-]+$/, 'Project name must be alphanumeric/._- (no path separators or traversal).')
  .describe('Project directory name under ~/.claude/projects/ (the encoded path).')
const optionalProjectArg = projectArg.optional()

export const registerClaudeCodeTools = (server: McpServer): void => {
  const register = makeAccessGatedRegister(server)

  /* ================================================================ */
  /*  claude_code_* — read-only (annotations: READ_ONLY)               */
  /* ================================================================ */

  register(
    'claude_code_projects_list',
    {
      title: 'Claude Code Auditor: list projects',
      description: `List every project under ~/.claude/projects/ with session-file count, on-disk size, whether a memory/ subdir exists, and a best-effort decode of the encoded directory name back to the original filesystem path (with source_exists indicating whether that decoded path still resolves on disk). Sorted by bytes descending.`,
      inputSchema: z.object({}).strict(),
      annotations: READ_ONLY
    },
    async () => {
      try {
        return jsonResult(await audit.projectsList(CLAUDE_CODE_ROOT_PATH))
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
          flag_size_gb: z.number().default(2),
          flag_session_count: z.number().default(500),
          flag_orphan_count: z.number().default(5)
        })
        .strict(),
      annotations: READ_ONLY
    },
    async (args) => {
      try {
        return jsonResult(await audit.storageSummary(CLAUDE_CODE_ROOT_PATH, args))
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
          older_than_days: z.number().default(30),
          flag_count: z.number().default(50),
          flag_size_mb: z.number().default(500),
          project: optionalProjectArg
        })
        .strict(),
      annotations: READ_ONLY
    },
    async (args) => {
      try {
        return jsonResult(await audit.obsoleteSessions(CLAUDE_CODE_ROOT_PATH, args))
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
      annotations: READ_ONLY
    },
    async () => {
      try {
        return jsonResult(await audit.globalStatus(CLAUDE_CODE_ROOT_PATH))
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
      annotations: READ_ONLY
    },
    async (args) => {
      try {
        return jsonResult(await audit.sessionRead(CLAUDE_CODE_ROOT_PATH, args))
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
      annotations: READ_ONLY
    },
    async (args) => {
      try {
        return jsonResult(await memory.memoryList(CLAUDE_CODE_ROOT_PATH, args))
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
      annotations: READ_ONLY
    },
    async (args) => {
      try {
        return jsonResult(await memory.memoryRead(CLAUDE_CODE_ROOT_PATH, args))
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
          older_than_days: z.number().default(60),
          project: optionalProjectArg,
          dry_run: z.boolean().default(true).describe('Default true (preview only). Pass false to actually delete.')
        })
        .strict(),
      annotations: DESTRUCTIVE_ONESHOT
    },
    async (args) => {
      try {
        return jsonResult(await audit.sessionsPrune(CLAUDE_CODE_ROOT_PATH, args))
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
      annotations: DESTRUCTIVE_ONESHOT
    },
    async (args) => {
      try {
        return jsonResult(await audit.relocateProject(CLAUDE_CODE_ROOT_PATH, args))
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
      annotations: DESTRUCTIVE_ONESHOT
    },
    async (args) => {
      try {
        return jsonResult(await audit.pruneOrphanProjects(CLAUDE_CODE_ROOT_PATH, args))
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
          name: z.string().min(1).regex(/\.md$/, 'Memory file name must end with .md'),
          content: z.string()
        })
        .strict(),
      annotations: DESTRUCTIVE
    },
    async (args) => {
      try {
        return jsonResult(await memory.memoryWrite(CLAUDE_CODE_ROOT_PATH, args))
      } catch (err) {
        return errorResult('writing Claude Code memory file', err)
      }
    }
  )

  register(
    'claude_code_memory_delete',
    {
      title: 'Claude Code Cleaner: retire memory file',
      description: `Delete a memory file at ~/.claude/projects/<project>/memory/<name>. MEMORY.md cannot be deleted via this tool — use memory_index_write to replace it.`,
      inputSchema: z
        .object({
          project: projectArg,
          name: z.string().min(1).regex(/\.md$/, 'Memory file name must end with .md')
        })
        .strict(),
      annotations: DESTRUCTIVE_ONESHOT
    },
    async (args) => {
      try {
        return jsonResult(await memory.memoryDelete(CLAUDE_CODE_ROOT_PATH, args))
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
      annotations: DESTRUCTIVE
    },
    async (args) => {
      try {
        return jsonResult(await memory.memoryIndexWrite(CLAUDE_CODE_ROOT_PATH, args))
      } catch (err) {
        return errorResult('writing Claude Code MEMORY.md', err)
      }
    }
  )
}
