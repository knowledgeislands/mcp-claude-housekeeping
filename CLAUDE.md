# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

Two axes:

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

`mcp-local-agent-mode-sessions` is a stdio MCP server that codifies the daily Cowork local-agent-mode-sessions filesystem audit. Each step of the audit is a dedicated tool; the agent orchestrates the checks and writes the markdown report.

### Source Layout

The codebase is TypeScript with ES modules (`"type": "module"` in `package.json`). Source lives under `src/`; compiled JS is emitted to `dist/` by `npm run build`.

- `src/index.ts` - Entry point. Boots the MCP server and registers every tool.
- `src/config.ts` - Loads and validates `ROOT_PATH` and `HOUSEKEEPING_PATH` env vars.
- `src/utils.ts` - Path-traversal-safe resolver, `du -sk` wrapper, JSON helpers.
- `src/audit.ts` - Read-only audit checks (storage, obsolete sessions, artifacts, outputs, backups, memory spaces, plugins, project cache, debug) plus the destructive `artifactPrune`.
- `src/report.ts` - List/clean/write of audit reports in `HOUSEKEEPING_PATH`.
- `src/memory.ts` - Memory-space file operations for the consolidation pass.

### Available Tools

Two prefixes:

- **`sessions_audit_*`** — read-only. Each maps to one check from the daily audit prompt. Returns structured JSON the agent uses to assemble the report.
- **`sessions_cleaner_*`** — destructive. Pruning, deleting prior reports, writing today's report, and writing/deleting memory files.

| Tool                                   | Purpose                                                        |
| -------------------------------------- | -------------------------------------------------------------- |
| `sessions_audit_storage_summary`       | Check 1 — counts, total size, top 5 dirs, oldest/newest, flags |
| `sessions_audit_obsolete_sessions`     | Check 2 — sessions older than N days                           |
| `sessions_audit_artifact_health`       | Check 3 — artifacts.json per-entry with churn/stale/idle flags |
| `sessions_audit_obsolete_outputs`      | Check 5 — non-empty outputs/uploads in old sessions            |
| `sessions_audit_backup_summary`        | Check 6 — `.claude.json.backup.*` count/size                   |
| `sessions_audit_memory_spaces_summary` | Check 7 — per-space memory file counts + index hooks           |
| `sessions_audit_plugins_inventory`     | Check 8 — knowledge-work + rpm plugins with versions           |
| `sessions_audit_project_cache_status`  | Check 9 — `.project-cache/` last-sync dates                    |
| `sessions_audit_debug_info`            | Check 10 — `debug/` size + age                                 |
| `sessions_audit_memory_list`           | Memory consolidation phase 1 — list a space's memory files     |
| `sessions_audit_memory_read`           | Read a single memory file                                      |
| `sessions_audit_report_list`           | List existing audit reports in `HOUSEKEEPING_PATH`             |
| `sessions_cleaner_prune_artifacts`     | Check 4 — delete unstarred artifacts beyond top N              |
| `sessions_cleaner_clear_reports`       | Delete prior `cowork-audit-*.md` files                         |
| `sessions_cleaner_write_report`        | Write today's `cowork-audit-YYYY-MM-DD.md`                     |
| `sessions_cleaner_write_memory`        | Create/overwrite a memory file                                 |
| `sessions_cleaner_delete_memory`       | Retire a memory file (not MEMORY.md)                           |
| `sessions_cleaner_write_memory_index`  | Replace `MEMORY.md`                                            |

### Key Components

- **Path safety**: `resolveWithinRoot()` in `src/utils.ts` matches the helper in mcp-kb. Memory tools resolve against `ROOT_PATH/spaces/<id>/memory/`. Inputs that resolve outside their root are rejected with `Path escapes root`.
- **Disk usage**: `duBytes()` shells out to `du -sk` for speed (~1000 session dirs). Falls through to 0 if the path is missing.
- **Error shape**: Tool errors return `{ isError: true, content: [{ type: 'text', text }] }` via `errorResult()`. Successful tools return JSON via `jsonResult()`.
- **Transport**: `StdioServerTransport` from `@modelcontextprotocol/sdk`. Logs go to stderr (`console.error`) so they don't pollute the stdio MCP channel.

## Configuration

### Environment Variables

- `ROOT_PATH` (**required**) — the local-agent-mode-sessions inner directory that contains `local_*.json`, `artifacts.json`, `spaces/`, `rpm/`, etc. The server asserts on startup; missing it causes a hard exit.
- `HOUSEKEEPING_PATH` (**required**) — directory where audit reports are saved. Created if missing on first write.

### Boot-time Checks

- The server verifies `ROOT_PATH` is accessible (`fs.access`) before connecting the transport. If not accessible, it logs a hint and returns without crashing.

## Common Setup Issues

1. **Missing dependencies**: Run `npm install` first.
2. **`ROOT_PATH` not set**: Server aborts at startup. Set it in the Claude Desktop config `env` block (see README) or in your shell when running `dev:mcp`.
3. **Pointing at the wrong dir**: `ROOT_PATH` should be the inner UUID directory that contains `local_*.json` files, not the parent `~/Library/Application Support/Claude/local-agent-mode-sessions/` directory.

## Error Handling

- Path traversal: `Path escapes root: "<input>"`
- Missing memory dir: `Memory directory not found for space "<id>"`
- Missing memory file: `Memory file not found: "<name>" in space "<id>"`
- Bad date input on report write: `Invalid date "<value>" — expected YYYY-MM-DD`
- All other errors are surfaced as `Error <action>: <message>` via `errorResult()`.
