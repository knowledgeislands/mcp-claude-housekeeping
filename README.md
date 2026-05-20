# mcp-claude-housekeeping

[![CI](https://github.com/knowledgeislands/mcp-claude-housekeeping/actions/workflows/ci.yml/badge.svg)](https://github.com/knowledgeislands/mcp-claude-housekeeping/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/@knowledgeislands/mcp-claude-housekeeping.svg)](https://www.npmjs.com/package/@knowledgeislands/mcp-claude-housekeeping) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

An MCP (Model Context Protocol) server for housekeeping the three filesystem areas where Claude apps accumulate state on macOS: **Claude Desktop / Cowork sessions**, **Claude Code** (`~/.claude/`), and **VSCode chat sessions**. Each audit step is a dedicated tool; the agent orchestrates the checks and writes a markdown report.

## Features

- **Codified audits across three storage areas** — 38 tools spanning Cowork local-agent-mode-sessions (the daily `cowork-filesystem-audit`), `~/.claude/` Claude Code state, and VSCode `workspaceStorage/<id>/chatSessions/`.
- **Access-level gated tools** — every tool maps to one of `read`, `write`, or `destructive`. Set `MCP_CLAUDE_HOUSEKEEPING_ACCESS_LEVEL` to the maximum level you want exposed; defaults to `read` only. Levels nest. The level is derived from each tool's MCP annotations (`readOnlyHint` / `destructiveHint`), not its name. (Housekeeping ships only `read` and `destructive` tools today — no `write` tier.)
- **Workspace auto-discovery** (Cowork only) — walks `~/Library/Application Support/Claude/local-agent-mode-sessions/<account>/<workspace>/` and aggregates results across every discovered workspace.
- **Path-safe** — every path is validated against its configured root; memory operations are also confined to their `memory/` subdir.
- **No network, no auth** — pure local filesystem over MCP stdio.

**Quality:** 260 tests; 100% line and function coverage (statement/branch hover ~99.8% as the suite evolves).

## Available Tools

Tools follow the convention `<app>_<resource>_<action>`. Each tool's access level (`read` or `destructive` today) is derived from its MCP annotations (`readOnlyHint` / `destructiveHint`).

### `claude_desktop_*` — read-only (`read` level)

| Tool                                   | Purpose                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------- |
| `claude_desktop_storage_summary`       | Counts, total disk usage, JSON total, top 5 largest dirs, oldest/newest, flags. |
| `claude_desktop_sessions_obsolete`     | Sessions older than N days; oldest 10 with combined size, flags.                |
| `claude_desktop_artifacts_health`      | Per-artifact metadata + flags (high churn, stale, unstarred + idle).            |
| `claude_desktop_outputs_obsolete`      | Non-empty `outputs/`/`uploads/` in sessions older than N days.                  |
| `claude_desktop_backups_summary`       | `.claude.json.backup.*` count, size, dates with thresholds.                     |
| `claude_desktop_memory_spaces_summary` | Per-space memory file counts + first 10 lines of `MEMORY.md`.                   |
| `claude_desktop_plugins_inventory`     | Knowledge-work + rpm plugins with versions/dates.                               |
| `claude_desktop_project_cache_status`  | `.project-cache/` entries with last-sync dates.                                 |
| `claude_desktop_debug_info`            | `debug/` size, entry count, oldest entry age.                                   |
| `claude_desktop_memory_list`           | List `.md` files + `MEMORY.md` content for one space.                           |
| `claude_desktop_memory_read`           | Read one memory file.                                                           |
| `claude_desktop_reports_list`          | List existing `cowork-audit-*.md` reports in `MCP_CLAUDE_HOUSEKEEPING_PATH`.    |
| `claude_desktop_workspaces_list`       | List discovered `<account>/<workspace>` workspace ids.                          |

### `claude_desktop_*` — destructive (`destructive` level)

| Tool                                | Purpose                                                                 |
| ----------------------------------- | ----------------------------------------------------------------------- |
| `claude_desktop_artifacts_prune`    | Delete unstarred artifacts beyond top N (default 5) by `lastUpdated`.   |
| `claude_desktop_reports_clear`      | Delete every `cowork-audit-*.md` from `MCP_CLAUDE_HOUSEKEEPING_PATH`.   |
| `claude_desktop_report_write`       | Save `cowork-audit-YYYY-MM-DD.md` to `MCP_CLAUDE_HOUSEKEEPING_PATH`.    |
| `claude_desktop_memory_write`       | Create/overwrite a memory file in `spaces/<space_id>/memory/<name>.md`. |
| `claude_desktop_memory_delete`      | Retire a memory file (cannot delete `MEMORY.md`).                       |
| `claude_desktop_memory_index_write` | Replace `MEMORY.md` for a space.                                        |
| `claude_desktop_session_rename`     | Set the sidebar `title` on a session record (≤80 chars, emoji ok).†     |

† Auto-picks the most-recently-active session when `session_id` is omitted — Cowork agents share one MCP server, so the server cannot infer the calling session from execution context. Pass `session_id` (bare UUID) to disambiguate when multiple sessions are active concurrently.

### `claude_code_*` — read-only (`read` level)

| Tool                            | Purpose                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------- |
| `claude_code_projects_list`     | Projects with session counts, bytes, decoded source path, orphan flag.                            |
| `claude_code_storage_summary`   | Aggregate counts + flags; surfaces orphan-project totals.                                         |
| `claude_code_sessions_obsolete` | Sessions older than N days (with sidecar dir bytes).                                              |
| `claude_code_global_status`     | `history.jsonl`, `settings.cleanupPeriodDays`, `.last-cleanup`, top-level dirs, freshness signal. |
| `claude_code_session_read`      | Preview head/tail of a session JSONL.                                                             |
| `claude_code_memory_list`       | List memory files in `<project>/memory/`.                                                         |
| `claude_code_memory_read`       | Read one memory file.                                                                             |

### `claude_code_*` — destructive (`destructive` level)

| Tool                                | Purpose                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| `claude_code_sessions_prune`        | Delete sessions older than N days (+ sidecar dirs), with `dry_run`.                  |
| `claude_code_project_relocate`      | Rename a project subdir to match a new source path (fixes `/resume` after a rename). |
| `claude_code_orphan_projects_prune` | Delete project subdirs whose decoded source path no longer exists.                   |
| `claude_code_memory_write`          | Create/overwrite a memory file.                                                      |
| `claude_code_memory_delete`         | Retire a memory file.                                                                |
| `claude_code_memory_index_write`    | Replace `MEMORY.md`.                                                                 |

### `vscode_*` — read-only (`read` level)

| Tool                       | Purpose                                                          |
| -------------------------- | ---------------------------------------------------------------- |
| `vscode_workspaces_list`   | List workspaceStorage entries with chat-session counts and URIs. |
| `vscode_storage_summary`   | Aggregate workspace/session counts + size flags.                 |
| `vscode_sessions_obsolete` | Chat sessions older than N days.                                 |
| `vscode_session_read`      | Preview head/tail of a `.json`/`.jsonl` chat session.            |

### `vscode_*` — destructive (`destructive` level)

| Tool                      | Purpose                                            |
| ------------------------- | -------------------------------------------------- |
| `vscode_workspace_delete` | Delete an entire `workspaceStorage/<id>/` subtree. |
| `vscode_sessions_prune`   | Delete chat sessions older than N days.            |

### Daily Audit — Tool Choreography

A typical `cowork-filesystem-audit` run uses the tools in this order:

1. `claude_desktop_reports_clear` — clear yesterday's report.
2. `claude_desktop_storage_summary` … `claude_desktop_debug_info` — run all read-only checks (parallelisable).
3. `claude_desktop_artifacts_prune` — prune unstarred artifacts past top 5.
4. `claude_desktop_memory_spaces_summary` — pick the space to consolidate.
5. `claude_desktop_memory_list` + `claude_desktop_memory_read` — review memories.
6. `claude_desktop_memory_write` / `memory_delete` / `memory_index_write` — consolidate.
7. `claude_desktop_report_write` — save today's `cowork-audit-YYYY-MM-DD.md`.

## Quick Start

1. **Install dependencies**: `bun install`.
2. **Build**: `bun run build`.
3. **Configure Claude Desktop** with `dist/mcp-server/index.js` and `MCP_CLAUDE_HOUSEKEEPING_PATH` (see [Configuration](#configuration)). The sessions root, Claude Code state, and VSCode chat storage are all read from their standard macOS locations under your home dir — no configuration needed.
4. **Restart Claude Desktop** — the `claude_desktop_*`, `claude_code_*`, and `vscode_*` tools should appear.

## Example Conversations

Concrete asks you might make of Claude with this server connected.

**Run today's audit:**

> "Run the daily cowork filesystem audit and write today's report."

Claude clears yesterday's report via `claude_desktop_reports_clear`, runs every read-only check in parallel (storage summary, obsolete sessions, artifact health, backups, memory spaces, plugins, cache, debug info), then writes `cowork-audit-YYYY-MM-DD.md` to `MCP_CLAUDE_HOUSEKEEPING_PATH` via `claude_desktop_report_write`. See the full ordering under [Daily Audit — Tool Choreography](#daily-audit--tool-choreography).

**Audit before cleaning:**

> "Show me sessions older than 30 days and tell me which ones still have non-empty outputs or uploads."

Claude calls `claude_desktop_sessions_obsolete` followed by `claude_desktop_outputs_obsolete` — both read-only — so you see the picture before any destructive action. No data is modified.

**Consolidate a memory space:**

> "Pick the memory space with the most files and show me its MEMORY.md plus the first few memory files before we consolidate."

Claude uses `claude_desktop_memory_spaces_summary` to find the candidate, then `claude_desktop_memory_list` + `claude_desktop_memory_read` to surface the actual content for review. Writes (`memory_write`, `memory_delete`, `memory_index_write`) only happen after you approve the plan.

**Prune accumulated artifacts:**

> "Free some disk — drop unstarred artifacts beyond the top 5 most recently updated."

Claude calls `claude_desktop_artifacts_prune` (destructive; requires `MCP_CLAUDE_HOUSEKEEPING_ACCESS_LEVEL=destructive`). Starred artifacts are always preserved and the top N most recent are kept regardless of star status.

## Installation

### Prerequisites

- [Bun](https://bun.sh) 1.3 or higher — used for dependency install and dev scripts
- Node.js 22.0.0 or higher (see `.node-version`) — used to run the compiled `dist/` output under Claude Desktop
- `du` (BSD/GNU) — used for fast disk-usage measurement; standard on macOS/Linux

### Install Dependencies

```bash
bun install
```

## Configuration

### Environment Variables

| Name | Required | Description |
| --- | --- | --- |
| `MCP_CLAUDE_HOUSEKEEPING_PATH` | yes | Absolute path or `~/...` to the directory where audit reports are written. |
| `MCP_CLAUDE_HOUSEKEEPING_ACCESS_LEVEL` | no | Maximum tool access level to register. One of: `read` (default — read-only tools only, least privilege), `write` (reserved — no such tools today), `destructive` (adds prune/relocate/delete). Levels nest. Each tool's level is derived from its MCP annotations (`readOnlyHint: true` → `read`; `destructiveHint: true` → `destructive`; missing annotations → `destructive` fail-safe); a tool registers when its derived level ≤ the configured level. The `dry_run: true` default on destructive tools controls _effect_; the gate controls _visibility_. Unknown values abort startup. |
| `MCP_CLAUDE_HOUSEKEEPING_AUDIT_LOG` | no | Audit-log scope. One of `off`, `writes` (default — record only non-read tool calls), `all` (record every invocation). |
| `MCP_CLAUDE_HOUSEKEEPING_AUDIT_LOG_PATH` | no | Path to the JSONL audit log. Default `<MCP_CLAUDE_HOUSEKEEPING_PATH>/audit/audit.jsonl`. |
| `MCP_CLAUDE_HOUSEKEEPING_AUDIT_LOG_MAX_BYTES` | no | Size-based rotation threshold in bytes. Default `10485760` (10 MiB). Set to `0` to disable rotation. |
| `MCP_CLAUDE_HOUSEKEEPING_AUDIT_LOG_KEEP` | no | Number of rotated audit-log files to retain. Default `5`. |
| `NODE_ENV` | no | Dev convention. `server:mcp:dev`/`server:mcp:inspect` set this to `development`, which makes [`src/config.ts`](./src/config.ts) load `.env.development` from the CWD. Unset under Claude Desktop, so `.env*` files are ignored in production. |

The sessions root (`~/Library/Application Support/Claude/local-agent-mode-sessions`), Claude Code root (`~/.claude`), and VSCode workspaceStorage (`~/Library/Application Support/Code/User/workspaceStorage`) are hardcoded in [`src/config.ts`](./src/config.ts) and are not user-configurable.

### Claude Desktop Configuration

Run `bun run build` first so `dist/mcp-server/index.js` exists, then add to your Claude Desktop config:

```json
{
  "mcpServers": {
    "mcp-claude-housekeeping": {
      "command": "node",
      "args": ["/path/to/mcp-claude-housekeeping/dist/mcp-server/index.js"],
      "env": {
        "MCP_CLAUDE_HOUSEKEEPING_PATH": "/Users/you/Documents/Claude/Projects/Claude Housekeeping"
      }
    }
  }
}
```

A starter is in [`claude-config-sample.json`](./claude-config-sample.json).

### Running From Source (Dev)

Copy [`.env.example`](./.env.example) to `.env.development` and fill in `MCP_CLAUDE_HOUSEKEEPING_PATH`. The `server:mcp:dev` and `server:mcp:inspect` scripts run with `NODE_ENV=development`, which causes Bun to auto-load `.env.development` from the CWD (and is also picked up by [`src/config.ts`](./src/config.ts)'s `process.loadEnvFile` call when run under Node). Claude Desktop does not set `NODE_ENV`, so the file is ignored in production; `MCP_CLAUDE_HOUSEKEEPING_PATH` must come from the Claude Desktop config `env` block.

```bash
cp .env.example .env.development
# edit .env.development, then:
bun run server:mcp:dev
```

You can also pass the vars inline if you'd rather skip `.env.development`:

```bash
MCP_CLAUDE_HOUSEKEEPING_PATH=~/Documents/Claude/Projects/Claude\ Housekeeping \
  bun run server:mcp:dev
```

### Workspaces

The server walks `~/Library/Application Support/Claude/local-agent-mode-sessions/<account_uuid>/<workspace_uuid>/` and discovers each workspace by looking for marker files (`.claude.json`, `artifacts.json`, `spaces.json`, `cowork_settings.json`, or `local_*.json`). Read-only audit tools aggregate results across every discovered workspace under a `workspaces` array; destructive-level tools and the memory list/read tools accept an optional `workspace` arg (`"<account>/<workspace>"`) and require it explicitly when more than one workspace is present.

Use `claude_desktop_workspaces_list` to see the discovered ids. If the sessions root itself contains the marker files, it is treated as a single workspace with id `.` (back-compat with hard-coded inner-UUID configs).

## Development

```bash
bun run server:mcp:dev      # bun --watch (NODE_ENV=development)
bun run server:mcp:start    # build then run from dist/ under node
bun run server:mcp:inspect  # MCP Inspector against TS source (NODE_ENV=development)
bun run test           # vitest (use `bun run`, not `bun test`, since `bun test` invokes Bun's own runner)
bun run lint:types     # tsc --noEmit
bun run lint:check     # Biome lint + format check
bun run lint:fix       # Biome auto-fix (uses --unsafe)
bun run lint:md        # prettier + markdownlint for *.md
```

## Security Model

- All paths are validated against the discovered workspace root (or, for memory tools, against `<workspace>/spaces/<space_id>/memory/`). Inputs resolving outside their root are rejected with `Path escapes root: "<input>"`.
- Every destructive tool (any annotated `DESTRUCTIVE` or `DESTRUCTIVE_ONESHOT`) carries `destructiveHint: true` so MCP clients can prompt before invoking them; the access-level gate at startup uses the same annotations (`readOnlyHint` / `destructiveHint`) to decide whether to register the tool at all under the configured `MCP_CLAUDE_HOUSEKEEPING_ACCESS_LEVEL`.
- The server has no network access and performs no authentication. Trust is delegated entirely to the local OS user running it.

## Directory Structure

```text
├── claude-config-sample.json   # Example Claude Desktop config
├── package.json
├── tsconfig.json               # Base TS config
├── tsconfig.build.json         # Build config (emits to dist/)
├── .env.example                # Template for MCP_CLAUDE_HOUSEKEEPING_PATH (copy to .env.development)
├── src/
│   ├── mcp-server/index.ts     # MCP server entry — registers every tool
│   ├── config.ts               # Env var loading
│   ├── utils.ts                # Path safety, du wrapper, JSON helpers
│   ├── audit.ts                # 10 read-only checks + artifactPrune
│   ├── report.ts               # Report list/clean/write
│   └── memory.ts               # Memory list/read/write/delete/index_write
└── dist/                       # Build output (gitignored, created by `bun run build`)
    └── mcp-server/index.js     # Compiled entry point used by Claude Desktop
```

## Troubleshooting

**`MCP_CLAUDE_HOUSEKEEPING_PATH environment variable must be set`**

Set it in the Claude Desktop config `env` block, or as a shell variable for `server:mcp:dev`. This is the only required env var; all target roots are hardcoded to their standard macOS locations.

**Boot-time `CLAUDE_DESKTOP_ROOT_PATH: not accessible`**

`~/Library/Application Support/Claude/local-agent-mode-sessions` doesn't exist on this machine, so all `claude_desktop_*` tools will return errors. The server still starts — `claude_code_*` and `vscode_*` tools work independently.

**Audit returns `workspace_count: 0`**

No `<account>/<workspace>/` workspaces were discovered. Check the boot-time stderr — it logs each discovered workspace id. If empty, list `~/Library/Application Support/Claude/local-agent-mode-sessions` and confirm it contains directories two levels deep with `.claude.json` / `artifacts.json` / `local_*.json`.

**Tool returns `Path escapes root`**

The requested path resolves outside its allowed root. Use names without leading `..` or absolute paths.

## Extending the Server

Add a new tool by registering it in [`src/mcp-server/index.ts`](./src/mcp-server/index.ts) via `server.registerTool(...)`. Follow the existing pattern:

1. Validate inputs with a strict zod schema (`.strict()` to reject extras).
2. Set MCP annotations honestly (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`).
3. Take a `workspaceRoot` (or use `aggregate`/`requireSingleWorkspace`) so the tool composes with multi-workspace discovery.
4. Run any path inputs through `resolveWithinRoot(workspaceRoot, ...)` before touching the filesystem.
5. Return errors via `errorResult(...)` so the client sees `isError: true`.
