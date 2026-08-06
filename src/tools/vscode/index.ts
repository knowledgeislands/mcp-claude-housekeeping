import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { Config } from '../../config/index.js'
import * as audit from '../../main/vscode/audit.js'
import { DESTRUCTIVE_ONESHOT, READ_ONLY } from '../../utils/annotations.js'
import { errorResult, jsonResult } from '../../utils/utils.js'

// Hex-only — rejects "..", "/", and other traversal characters before any
// path.join. Defense in depth alongside resolveWithinRoot at the call sites.
const workspaceArg = z
  .string()
  .min(1)
  .regex(/^[0-9a-f]+$/i, 'Workspace id must be hex (no path separators or traversal).')
  .describe('VSCode workspaceStorage subdir id (hex).')
const optionalWorkspaceArg = workspaceArg.optional()
const sessionArg = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9._-]+\.jsonl?$/, 'Session name must be alphanumeric/._- and end with .json or .jsonl')

const vsWorkspacesListOutput = z.object({
  workspace_storage: z.string(),
  workspace_count: z.number(),
  workspaces: z.array(
    z.object({ id: z.string(), workspace_uri: z.string().nullable(), session_count: z.number(), bytes: z.number() })
  )
})
const vsStorageSummaryOutput = z.object({
  workspace_storage: z.string(),
  workspace_count: z.number(),
  session_count: z.number(),
  total_chat_bytes: z.number(),
  flags: z.array(z.string())
})
const vsObsoleteSessionsOutput = z.object({
  cutoff_date: z.string(),
  older_than_days: z.number(),
  obsolete_count: z.number(),
  total_bytes: z.number(),
  top_10_oldest: z.array(
    z.object({
      workspace: z.string(),
      session: z.string(),
      last_activity: z.string(),
      age_days: z.number(),
      bytes: z.number()
    })
  ),
  flags: z.array(z.string())
})
const vsSessionReadOutput = z.object({
  workspace: z.string(),
  session: z.string(),
  format: z.enum(['json', 'jsonl']),
  bytes: z.number(),
  total_lines: z.number(),
  lines: z.array(z.string())
})
const vsWorkspaceDeleteOutput = z.object({
  workspace: z.string(),
  dir: z.string(),
  bytes: z.number(),
  dry_run: z.boolean(),
  deleted: z.boolean()
})
const vsSessionsPruneOutput = z.object({
  cutoff_date: z.string(),
  older_than_days: z.number(),
  dry_run: z.boolean(),
  deleted_count: z.number(),
  total_bytes_freed: z.number(),
  deleted: z.array(z.object({ workspace: z.string(), session: z.string(), age_days: z.number(), bytes: z.number() }))
})

export const registerVscodeTools = (server: McpServer, cfg: Config): void => {
  const register = server.registerTool
  const rootPath = cfg.vscodeWorkspaceStorageRootPath

  register(
    'vscode_workspaces_list',
    {
      title: 'VSCode Auditor: list chat-session workspaces',
      description: `List every workspaceStorage/<id>/chatSessions/ entry with the original workspace URI (from workspace.json), session-file count, and size. Sorted by bytes descending.`,
      inputSchema: z.object({}).strict(),
      outputSchema: vsWorkspacesListOutput,
      annotations: READ_ONLY
    },
    async () => {
      try {
        return jsonResult(await audit.workspacesList(rootPath))
      } catch (err) {
        return errorResult('listing VSCode workspaces', err)
      }
    }
  )

  register(
    'vscode_storage_summary',
    {
      title: 'VSCode Auditor: chat-session storage summary',
      description: `Aggregate totals across every workspaceStorage/<id>/chatSessions/: workspace count, session count, total chat bytes. Flags large size or session counts.`,
      inputSchema: z
        .object({
          flag_size_gb: z.number().int().min(0).max(1_000_000).default(1),
          flag_session_count: z.number().int().min(0).max(10_000_000).default(500)
        })
        .strict(),
      outputSchema: vsStorageSummaryOutput,
      annotations: READ_ONLY
    },
    async (args) => {
      try {
        return jsonResult(await audit.storageSummary(rootPath, args))
      } catch (err) {
        return errorResult('summarising VSCode storage', err)
      }
    }
  )

  register(
    'vscode_sessions_obsolete',
    {
      title: 'VSCode Auditor: obsolete chat sessions',
      description: `Find chat session .json/.jsonl files older than older_than_days (default 30) across all workspaceStorage entries (or one if "workspace" is set). Returns the 10 oldest plus totals.`,
      inputSchema: z
        .object({
          older_than_days: z.number().int().min(0).max(36500).default(30),
          flag_count: z.number().int().min(0).max(10_000_000).default(50),
          flag_size_mb: z.number().int().min(0).max(10_000_000).default(100),
          workspace: optionalWorkspaceArg
        })
        .strict(),
      outputSchema: vsObsoleteSessionsOutput,
      annotations: READ_ONLY
    },
    async (args) => {
      try {
        return jsonResult(await audit.obsoleteSessions(rootPath, args))
      } catch (err) {
        return errorResult('finding obsolete VSCode sessions', err)
      }
    }
  )

  register(
    'vscode_session_read',
    {
      title: 'VSCode Auditor: read chat session (preview)',
      description: `Return the first or last N lines of a chat session at workspaceStorage/<workspace>/chatSessions/<session>. Handles both .json (single document, pretty-printed) and .jsonl (one record per line). Cap with max_lines.`,
      inputSchema: z
        .object({
          workspace: workspaceArg,
          session: sessionArg,
          max_lines: z.number().int().min(1).max(2000).default(50),
          tail: z.boolean().default(true)
        })
        .strict(),
      outputSchema: vsSessionReadOutput,
      annotations: READ_ONLY
    },
    async (args) => {
      try {
        return jsonResult(await audit.sessionRead(rootPath, args))
      } catch (err) {
        return errorResult('reading VSCode session', err)
      }
    }
  )

  register(
    'vscode_workspace_delete',
    {
      title: 'VSCode Cleaner: delete a workspaceStorage entry',
      description: `Delete an entire workspaceStorage/<workspace>/ subtree (chatSessions plus extension state). Use for orphaned workspaces whose source folder has been removed — run vscode_workspaces_list first to confirm. dry_run defaults to TRUE — pass dry_run=false to actually delete.`,
      inputSchema: z
        .object({
          workspace: workspaceArg,
          dry_run: z.boolean().default(true).describe('Default true (preview only). Pass false to actually delete.')
        })
        .strict(),
      outputSchema: vsWorkspaceDeleteOutput,
      annotations: DESTRUCTIVE_ONESHOT
    },
    async (args) => {
      try {
        return jsonResult(await audit.workspaceDelete(rootPath, args))
      } catch (err) {
        return errorResult('deleting VSCode workspace', err)
      }
    }
  )

  register(
    'vscode_sessions_prune',
    {
      title: 'VSCode Cleaner: prune obsolete chat sessions',
      description: `Delete every chat session .json/.jsonl older than older_than_days across all workspaceStorage entries (or the one named in "workspace"). dry_run defaults to TRUE — pass dry_run=false to actually delete.`,
      inputSchema: z
        .object({
          older_than_days: z.number().int().min(0).max(36500).default(60),
          workspace: optionalWorkspaceArg,
          dry_run: z.boolean().default(true).describe('Default true (preview only). Pass false to actually delete.')
        })
        .strict(),
      outputSchema: vsSessionsPruneOutput,
      annotations: DESTRUCTIVE_ONESHOT
    },
    async (args) => {
      try {
        return jsonResult(await audit.sessionsPrune(rootPath, args))
      } catch (err) {
        return errorResult('pruning VSCode sessions', err)
      }
    }
  )
}
