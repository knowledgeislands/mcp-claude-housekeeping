#!/usr/bin/env node
// End-to-end smoke test: boot the built server over stdio MCP, list its tools,
// and assert the surface matches what the registration tests expect. Catches
// drift between code and the *wire* contract (registration tests cover the
// in-process registration call pattern; this covers the actual protocol round-trip).
//
// Run via `bun run test:smoke` (builds dist/ first). Runs in CI without real
// secrets: the server only needs MCP_CLAUDE_HOUSEKEEPING_PATH to point at an
// existing dir, so we hand it the OS temp dir and crank the access level up to
// `destructive` so every gated tool shows up.

import { tmpdir } from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

// Single source of truth for the tool surface — kept in sync with the
// per-group registration tests. If you add a tool, update both.
const EXPECTED_TOOLS = [
  // claude-code
  'claude_code_projects_list',
  'claude_code_storage_summary',
  'claude_code_sessions_obsolete',
  'claude_code_global_status',
  'claude_code_session_read',
  'claude_code_memory_list',
  'claude_code_memory_read',
  'claude_code_sessions_prune',
  'claude_code_project_relocate',
  'claude_code_orphan_projects_prune',
  'claude_code_memory_write',
  'claude_code_memory_delete',
  'claude_code_memory_index_write',
  // claude-desktop
  'claude_desktop_storage_summary',
  'claude_desktop_sessions_obsolete',
  'claude_desktop_artifacts_health',
  'claude_desktop_outputs_obsolete',
  'claude_desktop_backups_summary',
  'claude_desktop_memory_spaces_summary',
  'claude_desktop_plugins_inventory',
  'claude_desktop_project_cache_status',
  'claude_desktop_debug_info',
  'claude_desktop_workspaces_list',
  'claude_desktop_memory_list',
  'claude_desktop_memory_read',
  'claude_desktop_reports_list',
  'claude_desktop_artifacts_prune',
  'claude_desktop_reports_clear',
  'claude_desktop_report_write',
  'claude_desktop_memory_write',
  'claude_desktop_memory_delete',
  'claude_desktop_memory_index_write',
  'claude_desktop_session_rename',
  // vscode
  'vscode_workspaces_list',
  'vscode_storage_summary',
  'vscode_sessions_obsolete',
  'vscode_session_read',
  'vscode_workspace_delete',
  'vscode_sessions_prune'
] as const

const die = (msg: string, detail?: unknown): never => {
  console.error(`✗ smoke failed: ${msg}`)
  if (detail !== undefined) console.error(detail)
  process.exit(1)
}

const main = async (): Promise<void> => {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/mcp-server/index.js'],
    // Raise the access level to `destructive` so the smoke test sees the full
    // surface; the server's default (read only) would otherwise hide every
    // mutating tool. Point the required HOUSEKEEPING_PATH at the OS temp dir so
    // config validation passes without touching real Claude data.
    env: {
      ...(process.env as Record<string, string>),
      MCP_CLAUDE_HOUSEKEEPING_ACCESS_LEVEL: 'destructive',
      MCP_CLAUDE_HOUSEKEEPING_PATH: tmpdir(),
      MCP_CLAUDE_HOUSEKEEPING_AUDIT_LOG: 'off'
    }
  })
  const client = new Client({ name: 'mcp-claude-housekeeping-smoke', version: '0.0.0' }, { capabilities: {} })

  await client.connect(transport)

  try {
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).sort()
    const expected = [...EXPECTED_TOOLS].sort()

    // Diff with clear messages so CI logs are actionable.
    const missing = expected.filter((n) => !names.includes(n))
    const extra = names.filter((n) => !expected.includes(n as (typeof EXPECTED_TOOLS)[number]))
    if (missing.length || extra.length) {
      die('tool surface mismatch', { missing, extra, actualCount: names.length, expectedCount: expected.length })
    }

    // Sanity: every tool advertises an inputSchema object.
    const missingSchema = tools.filter((t) => !t.inputSchema || typeof t.inputSchema !== 'object').map((t) => t.name)
    if (missingSchema.length) die('tools missing inputSchema', missingSchema)

    console.error(`✓ smoke passed: ${names.length} tools listed, all schemas present`)
  } finally {
    await client.close()
  }
}

main().catch((err) => die('uncaught', err))
