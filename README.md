# mcp-claude-housekeeping

[![CI](https://github.com/knowledgeislands/mcp-claude-housekeeping/actions/workflows/ci.yml/badge.svg)](https://github.com/knowledgeislands/mcp-claude-housekeeping/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/@knowledgeislands/mcp-claude-housekeeping.svg)](https://www.npmjs.com/package/@knowledgeislands/mcp-claude-housekeeping) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

An MCP (Model Context Protocol) server that codifies the daily Cowork local-agent-mode-sessions filesystem audit. Each step of the audit is a dedicated tool; the agent orchestrates the checks and writes a markdown report.

## Features

- **Codified audit** — 10 read-only checks plus a memory-consolidation pass, matching the existing `cowork-filesystem-audit` scheduled task one-for-one.
- **Two clear groups** — `claude_desktop_auditor_*` are read-only; `claude_desktop_cleaner_*` are destructive (pruning, writing, deleting).
- **Workspace auto-discovery** — walks `~/Library/Application Support/Claude/local-agent-mode-sessions/<account>/<workspace>/` and aggregates results across every discovered workspace.
- **Path-safe** — every path is validated against the discovered workspace root; memory operations are also confined to `spaces/<space_id>/memory/`.
- **No network, no auth** — pure local filesystem over MCP stdio.

## Available Tools

### `claude_desktop_auditor_*` — read-only checks

| Tool                                           | Purpose                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------- |
| `claude_desktop_auditor_storage_summary`       | Counts, total disk usage, JSON total, top 5 largest dirs, oldest/newest, flags. |
| `claude_desktop_auditor_obsolete_sessions`     | Sessions older than N days; oldest 10 with combined size, flags.                |
| `claude_desktop_auditor_artifact_health`       | Per-artifact metadata + flags (high churn, stale, unstarred + idle).            |
| `claude_desktop_auditor_obsolete_outputs`      | Non-empty `outputs/`/`uploads/` in sessions older than N days.                  |
| `claude_desktop_auditor_backup_summary`        | `.claude.json.backup.*` count, size, dates with thresholds.                     |
| `claude_desktop_auditor_memory_spaces_summary` | Per-space memory file counts + first 10 lines of `MEMORY.md`.                   |
| `claude_desktop_auditor_plugins_inventory`     | Knowledge-work + rpm plugins with versions/dates.                               |
| `claude_desktop_auditor_project_cache_status`  | `.project-cache/` entries with last-sync dates.                                 |
| `claude_desktop_auditor_debug_info`            | `debug/` size, entry count, oldest entry age.                                   |
| `claude_desktop_auditor_memory_list`           | List `.md` files + `MEMORY.md` content for one space.                           |
| `claude_desktop_auditor_memory_read`           | Read one memory file.                                                           |
| `claude_desktop_auditor_reports_list`          | List existing `cowork-audit-*.md` reports in `HOUSEKEEPING_PATH`.               |
| `claude_desktop_auditor_workspaces_list`       | List discovered `<account>/<workspace>` workspace ids.                          |

### `claude_desktop_cleaner_*` — destructive

| Tool                                        | Purpose                                                                 |
| ------------------------------------------- | ----------------------------------------------------------------------- |
| `claude_desktop_cleaner_prune_artifacts`    | Delete unstarred artifacts beyond top N (default 5) by `lastUpdated`.   |
| `claude_desktop_cleaner_clear_reports`      | Delete every `cowork-audit-*.md` from `HOUSEKEEPING_PATH`.              |
| `claude_desktop_cleaner_write_report`       | Save `cowork-audit-YYYY-MM-DD.md` to `HOUSEKEEPING_PATH`.               |
| `claude_desktop_cleaner_write_memory`       | Create/overwrite a memory file in `spaces/<space_id>/memory/<name>.md`. |
| `claude_desktop_cleaner_delete_memory`      | Retire a memory file (cannot delete `MEMORY.md`).                       |
| `claude_desktop_cleaner_write_memory_index` | Replace `MEMORY.md` for a space.                                        |

### Daily Audit — Tool Choreography

A typical `cowork-filesystem-audit` run uses the tools in this order:

1. `claude_desktop_cleaner_clear_reports` — clear yesterday's report.
2. `claude_desktop_auditor_storage_summary` … `claude_desktop_auditor_debug_info` — run all read-only checks (parallelisable).
3. `claude_desktop_cleaner_prune_artifacts` — prune unstarred artifacts past top 5.
4. `claude_desktop_auditor_memory_spaces_summary` — pick the space to consolidate.
5. `claude_desktop_auditor_memory_list` + `claude_desktop_auditor_memory_read` — review memories.
6. `claude_desktop_cleaner_write_memory` / `delete_memory` / `write_memory_index` — consolidate.
7. `claude_desktop_cleaner_write_report` — save today's `cowork-audit-YYYY-MM-DD.md`.

## Quick Start

1. **Install dependencies**: `npm install`.
2. **Build**: `npm run build`.
3. **Configure Claude Desktop** with `dist/mcp-server/index.js` and `HOUSEKEEPING_PATH` (see [Configuration](#configuration)). The sessions root, Claude Code state, and VSCode chat storage are all read from their standard macOS locations under your home dir — no configuration needed.
4. **Restart Claude Desktop** — the `claude_desktop_auditor_*` and `claude_desktop_cleaner_*` tools should appear.

## Installation

### Prerequisites

- Node.js 22.0.0 or higher (see `.node-version`)
- npm
- `du` (BSD/GNU) — used for fast disk-usage measurement; standard on macOS/Linux

### Install Dependencies

```bash
npm install
```

## Configuration

### Environment Variables

| Name | Required | Description |
| --- | --- | --- |
| `HOUSEKEEPING_PATH` | yes | Absolute path or `~/...` to the directory where audit reports are written. |
| `NODE_ENV` | no | Dev convention. `dev:mcp`/`inspect` set this to `development`, which makes [`src/config.ts`](./src/config.ts) load `.env.development` from the CWD. Unset under Claude Desktop, so `.env*` files are ignored in production. |

The sessions root (`~/Library/Application Support/Claude/local-agent-mode-sessions`), Claude Code root (`~/.claude`), and VSCode workspaceStorage (`~/Library/Application Support/Code/User/workspaceStorage`) are hardcoded in [`src/config.ts`](./src/config.ts) and are not user-configurable.

### Claude Desktop Configuration

Run `npm run build` first so `dist/mcp-server/index.js` exists, then add to your Claude Desktop config:

```json
{
  "mcpServers": {
    "mcp-claude-housekeeping": {
      "command": "node",
      "args": ["/path/to/mcp-claude-housekeeping/dist/mcp-server/index.js"],
      "env": {
        "HOUSEKEEPING_PATH": "/Users/you/Documents/Claude/Projects/Claude Housekeeping"
      }
    }
  }
}
```

A starter is in [`claude-config-sample.json`](./claude-config-sample.json).

### Running From Source (Dev)

Copy [`.env.example`](./.env.example) to `.env.development` and fill in `HOUSEKEEPING_PATH`. The `dev:mcp` and `inspect` npm scripts run with `NODE_ENV=development`, and [`src/config.ts`](./src/config.ts) calls `process.loadEnvFile('./.env.${NODE_ENV}')` at startup — so it picks up `.env.development` from the CWD automatically. Claude Desktop does not set `NODE_ENV`, so the file is ignored in production; `HOUSEKEEPING_PATH` must come from the Claude Desktop config `env` block.

```bash
cp .env.example .env.development
# edit .env.development, then:
npm run dev:mcp
```

You can also pass the vars inline if you'd rather skip `.env.development`:

```bash
HOUSEKEEPING_PATH=~/Documents/Claude/Projects/Claude\ Housekeeping \
  npm run dev:mcp
```

### Workspaces

The server walks `~/Library/Application Support/Claude/local-agent-mode-sessions/<account_uuid>/<workspace_uuid>/` and discovers each workspace by looking for marker files (`.claude.json`, `artifacts.json`, `spaces.json`, `cowork_settings.json`, or `local_*.json`). Read-only audit tools aggregate results across every discovered workspace under a `workspaces` array; destructive cleaner tools and the memory list/read tools accept an optional `workspace` arg (`"<account>/<workspace>"`) and require it explicitly when more than one workspace is present.

Use `claude_desktop_auditor_workspaces_list` to see the discovered ids. If the sessions root itself contains the marker files, it is treated as a single workspace with id `.` (back-compat with hard-coded inner-UUID configs).

## Development

```bash
npm run dev:mcp        # tsx watch mode (NODE_ENV=development)
npm run start:mcp      # build then run from dist/
npm run inspect        # MCP Inspector against TS source (NODE_ENV=development)
npm test               # vitest
npm run typecheck      # tsc --noEmit
npm run lint:check     # Biome lint + format check
npm run lint:fix       # Biome auto-fix (uses --unsafe)
npm run lint:md        # prettier + markdownlint for *.md
```

## Security Model

- All paths are validated against the discovered workspace root (or, for memory tools, against `<workspace>/spaces/<space_id>/memory/`). Inputs resolving outside their root are rejected with `Path escapes root: "<input>"`.
- `claude_desktop_cleaner_*` tools are flagged with `destructiveHint: true` so MCP clients can prompt before invoking them.
- The server has no network access and performs no authentication. Trust is delegated entirely to the local OS user running it.

## Directory Structure

```text
├── claude-config-sample.json   # Example Claude Desktop config
├── package.json
├── tsconfig.json               # Base TS config
├── tsconfig.build.json         # Build config (emits to dist/)
├── .env.example                # Template for HOUSEKEEPING_PATH (copy to .env.development)
├── src/
│   ├── mcp-server/index.ts     # MCP server entry — registers every tool
│   ├── config.ts               # Env var loading
│   ├── utils.ts                # Path safety, du wrapper, JSON helpers
│   ├── audit.ts                # 10 read-only checks + artifactPrune
│   ├── report.ts               # Report list/clean/write
│   └── memory.ts               # Memory list/read/write/delete/index_write
└── dist/                       # Build output (gitignored, created by `npm run build`)
    └── mcp-server/index.js     # Compiled entry point used by Claude Desktop
```

## Troubleshooting

**`HOUSEKEEPING_PATH environment variable must be set`**

Set it in the Claude Desktop config `env` block, or as a shell variable for `dev:mcp`. This is the only required env var; all target roots are hardcoded to their standard macOS locations.

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
