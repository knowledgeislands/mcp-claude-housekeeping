import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { VSCODE_WORKSPACE_STORAGE_ROOT_PATH } from '../config.js'
import { DESTRUCTIVE_ONESHOT, READ_ONLY } from '../shared/annotations.js'
import { errorResult, jsonResult } from '../shared/utils.js'
import * as audit from './audit.js'

const workspaceArg = z.string().min(1).describe('VSCode workspaceStorage subdir id (hex).')
const optionalWorkspaceArg = workspaceArg.optional()
const sessionArg = z
  .string()
  .min(1)
  .regex(/\.jsonl?$/, 'Session name must end with .json or .jsonl')

export const registerVscodeTools = (server: McpServer): void => {
  server.registerTool(
    'vscode_auditor_workspaces_list',
    {
      title: 'VSCode Auditor: list chat-session workspaces',
      description: `List every workspaceStorage/<id>/chatSessions/ entry with the original workspace URI (from workspace.json), session-file count, and size. Sorted by bytes descending.`,
      inputSchema: z.object({}).strict(),
      annotations: READ_ONLY
    },
    async () => {
      try {
        return jsonResult(await audit.workspacesList(VSCODE_WORKSPACE_STORAGE_ROOT_PATH))
      } catch (err) {
        return errorResult(`Error in vscode workspaces_list: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  )

  server.registerTool(
    'vscode_auditor_storage_summary',
    {
      title: 'VSCode Auditor: chat-session storage summary',
      description: `Aggregate totals across every workspaceStorage/<id>/chatSessions/: workspace count, session count, total chat bytes. Flags large size or session counts.`,
      inputSchema: z
        .object({
          flag_size_gb: z.number().default(1),
          flag_session_count: z.number().default(500)
        })
        .strict(),
      annotations: READ_ONLY
    },
    async (args) => {
      try {
        return jsonResult(await audit.storageSummary(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, args))
      } catch (err) {
        return errorResult(`Error in vscode storage_summary: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  )

  server.registerTool(
    'vscode_auditor_obsolete_sessions',
    {
      title: 'VSCode Auditor: obsolete chat sessions',
      description: `Find chat session .json/.jsonl files older than older_than_days (default 30) across all workspaceStorage entries (or one if "workspace" is set). Returns the 10 oldest plus totals.`,
      inputSchema: z
        .object({
          older_than_days: z.number().default(30),
          flag_count: z.number().default(50),
          flag_size_mb: z.number().default(100),
          workspace: optionalWorkspaceArg
        })
        .strict(),
      annotations: READ_ONLY
    },
    async (args) => {
      try {
        return jsonResult(await audit.obsoleteSessions(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, args))
      } catch (err) {
        return errorResult(`Error in vscode obsolete_sessions: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  )

  server.registerTool(
    'vscode_auditor_session_read',
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
      annotations: READ_ONLY
    },
    async (args) => {
      try {
        return jsonResult(await audit.sessionRead(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, args))
      } catch (err) {
        return errorResult(`Error in vscode session_read: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  )

  server.registerTool(
    'vscode_cleaner_delete_workspace',
    {
      title: 'VSCode Cleaner: delete a workspaceStorage entry',
      description: `Delete an entire workspaceStorage/<workspace>/ subtree (chatSessions plus extension state). Use for orphaned workspaces whose source folder has been removed — run vscode_auditor_workspaces_list first to confirm. dry_run defaults to TRUE — pass dry_run=false to actually delete.`,
      inputSchema: z
        .object({
          workspace: workspaceArg,
          dry_run: z.boolean().default(true).describe('Default true (preview only). Pass false to actually delete.')
        })
        .strict(),
      annotations: DESTRUCTIVE_ONESHOT
    },
    async (args) => {
      try {
        return jsonResult(await audit.workspaceDelete(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, args))
      } catch (err) {
        return errorResult(`Error in vscode delete_workspace: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  )

  server.registerTool(
    'vscode_cleaner_prune_sessions',
    {
      title: 'VSCode Cleaner: prune obsolete chat sessions',
      description: `Delete every chat session .json/.jsonl older than older_than_days across all workspaceStorage entries (or the one named in "workspace"). dry_run defaults to TRUE — pass dry_run=false to actually delete.`,
      inputSchema: z
        .object({
          older_than_days: z.number().default(60),
          workspace: optionalWorkspaceArg,
          dry_run: z.boolean().default(true).describe('Default true (preview only). Pass false to actually delete.')
        })
        .strict(),
      annotations: DESTRUCTIVE_ONESHOT
    },
    async (args) => {
      try {
        return jsonResult(await audit.sessionsPrune(VSCODE_WORKSPACE_STORAGE_ROOT_PATH, args))
      } catch (err) {
        return errorResult(`Error in vscode prune_sessions: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  )
}
