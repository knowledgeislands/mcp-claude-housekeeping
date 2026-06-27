// @ts-nocheck
// Generated on 2026-06-27T20:37:56.096Z by @knowledgeislands/mcp-claude-housekeeping@1.0.0
// Server: kit-mcp-claude-housekeeping
// Source: /Users/krisbrown/.mcporter/mcporter.json
// Transport: STDIO /Users/krisbrown/.local/share/mise/installs/node/lts/bin/node /Users/krisbrown/kis/knowledgeislands/mcp-claude-housekeeping/dist/mcp-server/index.js

import { createRuntime, createServerProxy, wrapCallResult } from 'mcporter'
import type { KitMcpClaudeHousekeepingTools } from './types.d'

type RuntimeInstance = Awaited<ReturnType<typeof createRuntime>>
export type KitMcpClaudeHousekeepingClient = KitMcpClaudeHousekeepingTools & { close(): Promise<void> }

export interface CreateClientOptions {
  runtime?: RuntimeInstance
  configPath?: string
  rootDir?: string
}

export async function createKitMcpClaudeHousekeepingClient(options: CreateClientOptions = {}): Promise<KitMcpClaudeHousekeepingClient> {
  const runtime =
    options.runtime ??
    (await createRuntime({
      configPath: options.configPath,
      rootDir: options.rootDir
    }))
  const ownsRuntime = !options.runtime
  const proxy = createServerProxy(runtime, 'kit-mcp-claude-housekeeping')
  const client: KitMcpClaudeHousekeepingClient = {
    async claude_desktop_storage_summary(params: Parameters<KitMcpClaudeHousekeepingTools['claude_desktop_storage_summary']>[0]) {
      const tool = proxy.claudeDesktopStorageSummary as (
        args: Parameters<KitMcpClaudeHousekeepingTools['claude_desktop_storage_summary']>[0]
      ) => Promise<unknown>
      const raw = await tool(params)
      return wrapCallResult(raw).callResult
    },

    async claude_desktop_sessions_obsolete(params: Parameters<KitMcpClaudeHousekeepingTools['claude_desktop_sessions_obsolete']>[0]) {
      const tool = proxy.claudeDesktopSessionsObsolete as (
        args: Parameters<KitMcpClaudeHousekeepingTools['claude_desktop_sessions_obsolete']>[0]
      ) => Promise<unknown>
      const raw = await tool(params)
      return wrapCallResult(raw).callResult
    },

    async claude_desktop_artifacts_health(params: Parameters<KitMcpClaudeHousekeepingTools['claude_desktop_artifacts_health']>[0]) {
      const tool = proxy.claudeDesktopArtifactsHealth as (
        args: Parameters<KitMcpClaudeHousekeepingTools['claude_desktop_artifacts_health']>[0]
      ) => Promise<unknown>
      const raw = await tool(params)
      return wrapCallResult(raw).callResult
    },

    async claude_desktop_outputs_obsolete(params: Parameters<KitMcpClaudeHousekeepingTools['claude_desktop_outputs_obsolete']>[0]) {
      const tool = proxy.claudeDesktopOutputsObsolete as (
        args: Parameters<KitMcpClaudeHousekeepingTools['claude_desktop_outputs_obsolete']>[0]
      ) => Promise<unknown>
      const raw = await tool(params)
      return wrapCallResult(raw).callResult
    },

    async claude_desktop_backups_summary(params: Parameters<KitMcpClaudeHousekeepingTools['claude_desktop_backups_summary']>[0]) {
      const tool = proxy.claudeDesktopBackupsSummary as (
        args: Parameters<KitMcpClaudeHousekeepingTools['claude_desktop_backups_summary']>[0]
      ) => Promise<unknown>
      const raw = await tool(params)
      return wrapCallResult(raw).callResult
    },

    async claude_desktop_memory_spaces_summary(
      params: Parameters<KitMcpClaudeHousekeepingTools['claude_desktop_memory_spaces_summary']>[0]
    ) {
      const tool = proxy.claudeDesktopMemorySpacesSummary as (
        args: Parameters<KitMcpClaudeHousekeepingTools['claude_desktop_memory_spaces_summary']>[0]
      ) => Promise<unknown>
      const raw = await tool(params)
      return wrapCallResult(raw).callResult
    },

    async claude_desktop_plugins_inventory(params: Parameters<KitMcpClaudeHousekeepingTools['claude_desktop_plugins_inventory']>[0]) {
      const tool = proxy.claudeDesktopPluginsInventory as (
        args: Parameters<KitMcpClaudeHousekeepingTools['claude_desktop_plugins_inventory']>[0]
      ) => Promise<unknown>
      const raw = await tool(params)
      return wrapCallResult(raw).callResult
    },

    async claude_desktop_project_cache_status(params: Parameters<KitMcpClaudeHousekeepingTools['claude_desktop_project_cache_status']>[0]) {
      const tool = proxy.claudeDesktopProjectCacheStatus as (
        args: Parameters<KitMcpClaudeHousekeepingTools['claude_desktop_project_cache_status']>[0]
      ) => Promise<unknown>
      const raw = await tool(params)
      return wrapCallResult(raw).callResult
    },

    async claude_desktop_debug_info(params: Parameters<KitMcpClaudeHousekeepingTools['claude_desktop_debug_info']>[0]) {
      const tool = proxy.claudeDesktopDebugInfo as (
        args: Parameters<KitMcpClaudeHousekeepingTools['claude_desktop_debug_info']>[0]
      ) => Promise<unknown>
      const raw = await tool(params)
      return wrapCallResult(raw).callResult
    },

    async claude_desktop_workspaces_list(params: Parameters<KitMcpClaudeHousekeepingTools['claude_desktop_workspaces_list']>[0]) {
      const tool = proxy.claudeDesktopWorkspacesList as (
        args: Parameters<KitMcpClaudeHousekeepingTools['claude_desktop_workspaces_list']>[0]
      ) => Promise<unknown>
      const raw = await tool(params)
      return wrapCallResult(raw).callResult
    },

    async claude_desktop_memory_list(params: Parameters<KitMcpClaudeHousekeepingTools['claude_desktop_memory_list']>[0]) {
      const tool = proxy.claudeDesktopMemoryList as (
        args: Parameters<KitMcpClaudeHousekeepingTools['claude_desktop_memory_list']>[0]
      ) => Promise<unknown>
      const raw = await tool(params)
      return wrapCallResult(raw).callResult
    },

    async claude_desktop_memory_read(params: Parameters<KitMcpClaudeHousekeepingTools['claude_desktop_memory_read']>[0]) {
      const tool = proxy.claudeDesktopMemoryRead as (
        args: Parameters<KitMcpClaudeHousekeepingTools['claude_desktop_memory_read']>[0]
      ) => Promise<unknown>
      const raw = await tool(params)
      return wrapCallResult(raw).callResult
    },

    async claude_desktop_reports_list(params: Parameters<KitMcpClaudeHousekeepingTools['claude_desktop_reports_list']>[0]) {
      const tool = proxy.claudeDesktopReportsList as (
        args: Parameters<KitMcpClaudeHousekeepingTools['claude_desktop_reports_list']>[0]
      ) => Promise<unknown>
      const raw = await tool(params)
      return wrapCallResult(raw).callResult
    },

    async claude_code_projects_list(params: Parameters<KitMcpClaudeHousekeepingTools['claude_code_projects_list']>[0]) {
      const tool = proxy.claudeCodeProjectsList as (
        args: Parameters<KitMcpClaudeHousekeepingTools['claude_code_projects_list']>[0]
      ) => Promise<unknown>
      const raw = await tool(params)
      return wrapCallResult(raw).callResult
    },

    async claude_code_storage_summary(params: Parameters<KitMcpClaudeHousekeepingTools['claude_code_storage_summary']>[0]) {
      const tool = proxy.claudeCodeStorageSummary as (
        args: Parameters<KitMcpClaudeHousekeepingTools['claude_code_storage_summary']>[0]
      ) => Promise<unknown>
      const raw = await tool(params)
      return wrapCallResult(raw).callResult
    },

    async claude_code_sessions_obsolete(params: Parameters<KitMcpClaudeHousekeepingTools['claude_code_sessions_obsolete']>[0]) {
      const tool = proxy.claudeCodeSessionsObsolete as (
        args: Parameters<KitMcpClaudeHousekeepingTools['claude_code_sessions_obsolete']>[0]
      ) => Promise<unknown>
      const raw = await tool(params)
      return wrapCallResult(raw).callResult
    },

    async claude_code_global_status(params: Parameters<KitMcpClaudeHousekeepingTools['claude_code_global_status']>[0]) {
      const tool = proxy.claudeCodeGlobalStatus as (
        args: Parameters<KitMcpClaudeHousekeepingTools['claude_code_global_status']>[0]
      ) => Promise<unknown>
      const raw = await tool(params)
      return wrapCallResult(raw).callResult
    },

    async claude_code_session_read(params: Parameters<KitMcpClaudeHousekeepingTools['claude_code_session_read']>[0]) {
      const tool = proxy.claudeCodeSessionRead as (
        args: Parameters<KitMcpClaudeHousekeepingTools['claude_code_session_read']>[0]
      ) => Promise<unknown>
      const raw = await tool(params)
      return wrapCallResult(raw).callResult
    },

    async claude_code_memory_list(params: Parameters<KitMcpClaudeHousekeepingTools['claude_code_memory_list']>[0]) {
      const tool = proxy.claudeCodeMemoryList as (
        args: Parameters<KitMcpClaudeHousekeepingTools['claude_code_memory_list']>[0]
      ) => Promise<unknown>
      const raw = await tool(params)
      return wrapCallResult(raw).callResult
    },

    async claude_code_memory_read(params: Parameters<KitMcpClaudeHousekeepingTools['claude_code_memory_read']>[0]) {
      const tool = proxy.claudeCodeMemoryRead as (
        args: Parameters<KitMcpClaudeHousekeepingTools['claude_code_memory_read']>[0]
      ) => Promise<unknown>
      const raw = await tool(params)
      return wrapCallResult(raw).callResult
    },

    async vscode_workspaces_list(params: Parameters<KitMcpClaudeHousekeepingTools['vscode_workspaces_list']>[0]) {
      const tool = proxy.vscodeWorkspacesList as (
        args: Parameters<KitMcpClaudeHousekeepingTools['vscode_workspaces_list']>[0]
      ) => Promise<unknown>
      const raw = await tool(params)
      return wrapCallResult(raw).callResult
    },

    async vscode_storage_summary(params: Parameters<KitMcpClaudeHousekeepingTools['vscode_storage_summary']>[0]) {
      const tool = proxy.vscodeStorageSummary as (
        args: Parameters<KitMcpClaudeHousekeepingTools['vscode_storage_summary']>[0]
      ) => Promise<unknown>
      const raw = await tool(params)
      return wrapCallResult(raw).callResult
    },

    async vscode_sessions_obsolete(params: Parameters<KitMcpClaudeHousekeepingTools['vscode_sessions_obsolete']>[0]) {
      const tool = proxy.vscodeSessionsObsolete as (
        args: Parameters<KitMcpClaudeHousekeepingTools['vscode_sessions_obsolete']>[0]
      ) => Promise<unknown>
      const raw = await tool(params)
      return wrapCallResult(raw).callResult
    },

    async vscode_session_read(params: Parameters<KitMcpClaudeHousekeepingTools['vscode_session_read']>[0]) {
      const tool = proxy.vscodeSessionRead as (
        args: Parameters<KitMcpClaudeHousekeepingTools['vscode_session_read']>[0]
      ) => Promise<unknown>
      const raw = await tool(params)
      return wrapCallResult(raw).callResult
    },

    async close() {
      if (ownsRuntime) {
        await runtime.close('kit-mcp-claude-housekeeping').catch(() => {})
      }
    }
  }
  return client
}
