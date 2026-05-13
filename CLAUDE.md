# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

Two ways to run the server:

- **From source (fast iteration, tsx watch)**: `dev:mcp`
- **From compiled `dist/` (what Claude Desktop runs)**: `start:mcp` (auto-rebuilds via `prestart:mcp`)

Scripts:

- `npm install` - **ALWAYS run first** to install dependencies
- `npm run dev:mcp` - Run the MCP server from TS source in tsx watch mode
- `npm run start:mcp` - Build and run the MCP server from compiled `dist/`
- `npm run build` - Compile TS to JS in `dist/` (uses `tsconfig.build.json`, excludes tests)
- `npm run typecheck` - Type-check without emitting (`tsc --noEmit`)
- `npm run inspect` - Use MCP Inspector to test the server interactively (runs TS via tsx)
- `npm test` - Run vitest tests (use `npm run test:watch` for watch mode)
- `npm run lint:check` - Lint and format-check TS/JS/JSON with Biome
- `npm run lint:fix` - Auto-fix Biome lint findings (with `--unsafe`) and apply formatting
- `npm run format` - Apply Biome formatting only (no lint)
- `npm run lint:md` - Format and lint markdown files (prettier + markdownlint; Biome doesn't format markdown yet)
- `npm run lint:package` - Format `package.json` with syncpack
- `npm run lint:deps:missing` - Add missing dependencies detected by depcheck
- `npm run lint:deps:unused` - Remove unused devDependencies detected by depcheck
- `npm run update:libs` - Check for outdated packages with npm-check-updates
- `npm run clean` - Remove `dist/` and `node_modules/`

## Architecture Overview

`mcp-claude-housekeeping` is a stdio MCP server that codifies the daily Cowork local-agent-mode-sessions filesystem audit. Each step of the audit is a dedicated tool; the agent orchestrates the checks and writes the markdown report.

`CLAUDE_DESKTOP_ROOT_PATH` is hardcoded to `~/Library/Application Support/Claude/local-agent-mode-sessions` (the Claude Desktop location on macOS) and is not user-configurable. At each tool invocation the server discovers every `<account_uuid>/<workspace_uuid>/` workspace beneath it (any directory containing `.claude.json`, `artifacts.json`, `spaces.json`, `cowork_settings.json`, or a `local_*.json` file) and runs the requested check across all of them. If `CLAUDE_DESKTOP_ROOT_PATH` itself contains those marker files, it is treated as a single workspace (back-compat with hard-coded inner-UUID configs).

### Source Layout

The codebase is TypeScript with ES modules (`"type": "module"` in `package.json`). Source lives under `src/`; compiled JS is emitted to `dist/` by `npm run build`.

- `src/mcp-server/index.ts` - Entry point. Boots the MCP server, runs workspace discovery on each call, registers every tool, and aggregates per-workspace results.
- `src/config.ts` - Hardcoded paths to `CLAUDE_DESKTOP_ROOT_PATH`, `CLAUDE_CODE_ROOT_PATH`, and `VSCODE_WORKSPACE_STORAGE_ROOT_PATH` under the current user's home dir, plus loads `HOUSEKEEPING_PATH` from the env (the only configurable value).
- `src/shared/utils.ts` - Path-traversal-safe resolver, `du -sk` wrapper, JSON helpers, `discoverWorkspaces()`.
- `src/shared/annotations.ts` - MCP tool annotation presets (`READ_ONLY`, `DESTRUCTIVE`, `DESTRUCTIVE_ONESHOT`).
- `src/claude-desktop/{audit,report,memory,tools}.ts` - The Cowork `local-agent-mode-sessions/` checks, report writing, memory-space ops, and the tool registrations exposed under the `claude_desktop_*` prefix.
- `src/claude-code/{audit,memory,tools}.ts` - The `~/.claude/` checks (projects, sessions, memory, global state, relocate/prune-orphans) and their `claude_code_*` tool registrations.
- `src/vscode/{audit,tools}.ts` - VSCode `workspaceStorage/<id>/chatSessions/` inspection plus the `vscode_*` tools.

### Available Tools

Tools are grouped first by **state repository** they target, then by **role**:

- **`auditor`** — read-only inventory and inspection.
- **`cleaner`** — destructive: writes, deletes, prunes, relocates.

State repositories:

| Prefix             | Targets                                                                       |
| ------------------ | ----------------------------------------------------------------------------- |
| `claude_desktop_*` | `~/Library/Application Support/Claude/local-agent-mode-sessions/` (Cowork)    |
| `claude_code_*`    | `~/.claude/` (Claude Code CLI / IDE extension state)                          |
| `vscode_*`         | `~/Library/Application Support/Code/User/workspaceStorage/<id>/chatSessions/` |

#### `claude_desktop_*` — Cowork sessions

| Tool                                           | Purpose                                                        |
| ---------------------------------------------- | -------------------------------------------------------------- |
| `claude_desktop_auditor_storage_summary`       | Check 1 — counts, total size, top 5 dirs, oldest/newest, flags |
| `claude_desktop_auditor_obsolete_sessions`     | Check 2 — sessions older than N days                           |
| `claude_desktop_auditor_artifact_health`       | Check 3 — artifacts.json per-entry with churn/stale/idle flags |
| `claude_desktop_auditor_obsolete_outputs`      | Check 5 — non-empty outputs/uploads in old sessions            |
| `claude_desktop_auditor_backup_summary`        | Check 6 — `.claude.json.backup.*` count/size                   |
| `claude_desktop_auditor_memory_spaces_summary` | Check 7 — per-space memory file counts + index hooks           |
| `claude_desktop_auditor_plugins_inventory`     | Check 8 — knowledge-work + rpm plugins with versions           |
| `claude_desktop_auditor_project_cache_status`  | Check 9 — `.project-cache/` last-sync dates                    |
| `claude_desktop_auditor_debug_info`            | Check 10 — `debug/` size + age                                 |
| `claude_desktop_auditor_memory_list`           | Memory consolidation phase 1 — list a space's memory files     |
| `claude_desktop_auditor_memory_read`           | Read a single memory file                                      |
| `claude_desktop_auditor_reports_list`          | List existing audit reports in `HOUSEKEEPING_PATH`             |
| `claude_desktop_auditor_workspaces_list`       | List discovered `<account>/<workspace>` workspace ids          |
| `claude_desktop_cleaner_prune_artifacts`       | Check 4 — delete unstarred artifacts beyond top N              |
| `claude_desktop_cleaner_clear_reports`         | Delete prior `cowork-audit-*.md` files                         |
| `claude_desktop_cleaner_write_report`          | Write today's `cowork-audit-YYYY-MM-DD.md`                     |
| `claude_desktop_cleaner_write_memory`          | Create/overwrite a memory file                                 |
| `claude_desktop_cleaner_delete_memory`         | Retire a memory file (not MEMORY.md)                           |
| `claude_desktop_cleaner_write_memory_index`    | Replace `MEMORY.md`                                            |

#### `claude_code_*` — `~/.claude/`

| Tool | Purpose |
| --- | --- |
| `claude_code_auditor_projects_list` | List projects with session counts, bytes, decoded source path, orphan flag |
| `claude_code_auditor_storage_summary` | Aggregate counts + flags; surfaces orphan-project totals |
| `claude_code_auditor_obsolete_sessions` | Sessions older than N days (with sidecar dir bytes) |
| `claude_code_auditor_global_status` | `history.jsonl`, `settings.cleanupPeriodDays`, `.last-cleanup`, top-level dirs, freshness signal |
| `claude_code_auditor_session_read` | Preview head/tail of a session JSONL |
| `claude_code_auditor_memory_list` | List memory files in `<project>/memory/` |
| `claude_code_auditor_memory_read` | Read one memory file |
| `claude_code_cleaner_prune_sessions` | Delete sessions older than N days (+ sidecar dirs), with dry_run |
| `claude_code_cleaner_relocate_project` | Rename a project subdir to match a new source path (fixes `/resume` after a folder rename) |
| `claude_code_cleaner_prune_orphan_projects` | Delete project subdirs whose decoded source path no longer exists |
| `claude_code_cleaner_write_memory` | Create/overwrite a memory file |
| `claude_code_cleaner_delete_memory` | Retire a memory file |
| `claude_code_cleaner_write_memory_index` | Replace `MEMORY.md` |

#### `vscode_*` — VSCode chat sessions

| Tool                               | Purpose                                                         |
| ---------------------------------- | --------------------------------------------------------------- |
| `vscode_auditor_workspaces_list`   | List workspaceStorage entries with chat-session counts and URIs |
| `vscode_auditor_storage_summary`   | Aggregate workspace/session counts + size flags                 |
| `vscode_auditor_obsolete_sessions` | Chat sessions older than N days                                 |
| `vscode_auditor_session_read`      | Preview head/tail of a `.json`/`.jsonl` chat session            |
| `vscode_cleaner_delete_workspace`  | Delete an entire `workspaceStorage/<id>/` subtree               |
| `vscode_cleaner_prune_sessions`    | Delete chat sessions older than N days                          |

### Roadmap

- **`*_backup_*` group per state repo** — `backup_create` (snapshot to `<HOUSEKEEPING_PATH>/backups/<repo>/<ts>/`), `backup_list`, `backup_delete`, and a destructive `cleaner_backup_restore`. Motivated by the recovery scenario where the entire `~/.claude/` tree was wiped without warning — once `claude_code_auditor_global_status.freshness.looks_freshly_initialized` flags a wipe, a recent backup is the only path to recovery.

### Key Components

- **Path safety**: `resolveWithinRoot()` in `src/shared/utils.ts` matches the helper in mcp-kb. Memory tools resolve against `ROOT_PATH/spaces/<id>/memory/`. Inputs that resolve outside their root are rejected with `Path escapes root`.
- **Disk usage**: `duBytes()` shells out to `du -sk` for speed (~1000 session dirs). Falls through to 0 if the path is missing.
- **Error shape**: Tool errors return `{ isError: true, content: [{ type: 'text', text }] }` via `errorResult()`. Successful tools return JSON via `jsonResult()`.
- **Transport**: `StdioServerTransport` from `@modelcontextprotocol/sdk`. Logs go to stderr (`console.error`) so they don't pollute the stdio MCP channel.

## Configuration

### Environment Variables

- `HOUSEKEEPING_PATH` (**required**) — directory where audit reports are saved. Created if missing on first write.

`CLAUDE_DESKTOP_ROOT_PATH`, `CLAUDE_CODE_ROOT_PATH`, and `VSCODE_WORKSPACE_STORAGE_ROOT_PATH` are hardcoded in [`src/config.ts`](./src/config.ts) to their standard locations under the current user's home dir; they are not user-configurable.

Convention: `src/config.ts` calls `process.loadEnvFile('./.env.${NODE_ENV}')` at startup (try/caught so a missing file is harmless). The `dev:mcp` and `inspect` npm scripts set `NODE_ENV=development`, so they pick up `.env.development` from the CWD. Claude Desktop does not set `NODE_ENV`, so the load attempts `./.env.undefined`, which doesn't exist and is silently ignored — `HOUSEKEEPING_PATH` comes from the Claude Desktop config `env` block in production.

### Boot-time Checks

- The server logs accessibility for `CLAUDE_DESKTOP_ROOT_PATH`, `CLAUDE_CODE_ROOT_PATH`, and `VSCODE_WORKSPACE_STORAGE_ROOT_PATH` and the count + ids of the workspaces it discovered before connecting the transport. Inaccessible roots are logged as warnings and the server still starts; tools targeting a missing root will return errors.

## Common Setup Issues

1. **Missing dependencies**: Run `npm install` first.
2. **No workspaces discovered**: At boot the server logs `discovered N sessions workspace(s)`; if it shows `0`, `~/Library/Application Support/Claude/local-agent-mode-sessions` doesn't exist or has no `<account>/<workspace>/` children with marker files. Use `claude_desktop_auditor_workspaces_list` to inspect what was found.

## Error Handling

- Path traversal: `Path escapes root: "<input>"`
- Missing memory dir: `Memory directory not found for space "<id>"`
- Missing memory file: `Memory file not found: "<name>" in space "<id>"`
- Bad date input on report write: `Invalid date "<value>" — expected YYYY-MM-DD`
- All other errors are surfaced as `Error <action>: <message>` via `errorResult()`.
