# mcp-local-agent-mode-sessions

[![CI](https://github.com/knowledgeislands/mcp-local-agent-mode-sessions/actions/workflows/ci.yml/badge.svg)](https://github.com/knowledgeislands/mcp-local-agent-mode-sessions/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@knowledgeislands/mcp-local-agent-mode-sessions.svg)](https://www.npmjs.com/package/@knowledgeislands/mcp-local-agent-mode-sessions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A small MCP (Model Context Protocol) server that codifies the daily Cowork local-agent-mode-sessions filesystem audit. Each step of the audit is a dedicated tool; the agent orchestrates the checks and writes a markdown report.

## Features

- **Codified audit** — 10 read-only checks plus a memory-consolidation pass, matching the existing `cowork-filesystem-audit` scheduled task one-for-one.
- **Two clear groups** — `sessions_audit_*` are read-only; `sessions_cleaner_*` are destructive (pruning, writing, deleting).
- **Path-safe** — every path is validated against `ROOT_PATH`; memory file operations are also confined to `spaces/<space_id>/memory/`.
- **No network, no auth** — pure local filesystem over MCP stdio.

## Available Tools

### `sessions_audit_*` — read-only checks

| Tool                                   | Purpose                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------ |
| `sessions_audit_storage_summary`       | Counts, total disk usage, JSON total, top 5 largest dirs, oldest/newest, flags |
| `sessions_audit_obsolete_sessions`     | Sessions older than N days; oldest 10 with combined size, flags                |
| `sessions_audit_artifact_health`       | Per-artifact metadata + flags (high churn, stale, unstarred+idle)              |
| `sessions_audit_obsolete_outputs`      | Non-empty `outputs/`/`uploads/` in sessions older than N days                  |
| `sessions_audit_backup_summary`        | `.claude.json.backup.*` count, size, dates with thresholds                     |
| `sessions_audit_memory_spaces_summary` | Per-space memory file counts + first 10 lines of MEMORY.md                     |
| `sessions_audit_plugins_inventory`     | Knowledge-work + rpm plugins with versions/dates                               |
| `sessions_audit_project_cache_status`  | `.project-cache/` entries with last-sync dates                                 |
| `sessions_audit_debug_info`            | `debug/` size, entry count, oldest entry age                                   |
| `sessions_audit_memory_list`           | List `.md` files + MEMORY.md content for one space                             |
| `sessions_audit_memory_read`           | Read one memory file                                                           |
| `sessions_audit_report_list`           | List existing `cowork-audit-*.md` reports in `HOUSEKEEPING_PATH`               |

### `sessions_cleaner_*` — destructive

| Tool                                  | Purpose                                                                |
| ------------------------------------- | ---------------------------------------------------------------------- |
| `sessions_cleaner_prune_artifacts`    | Delete unstarred artifacts beyond top N (default 5) by `lastUpdated`   |
| `sessions_cleaner_clear_reports`      | Delete every `cowork-audit-*.md` from `HOUSEKEEPING_PATH`              |
| `sessions_cleaner_write_report`       | Save `cowork-audit-YYYY-MM-DD.md` to `HOUSEKEEPING_PATH`               |
| `sessions_cleaner_write_memory`       | Create/overwrite a memory file in `spaces/<space_id>/memory/<name>.md` |
| `sessions_cleaner_delete_memory`      | Retire a memory file (cannot delete `MEMORY.md`)                       |
| `sessions_cleaner_write_memory_index` | Replace `MEMORY.md` for a space                                        |

## Daily Audit — Tool Choreography

A typical `cowork-filesystem-audit` run uses the tools in this order:

1. `sessions_cleaner_clear_reports` — clear yesterday's report
2. `sessions_audit_storage_summary` … `sessions_audit_debug_info` — run all read-only checks (parallelisable)
3. `sessions_cleaner_prune_artifacts` — prune unstarred artifacts past top 5
4. `sessions_audit_memory_spaces_summary` — pick the space to consolidate
5. `sessions_audit_memory_list` + `sessions_audit_memory_read` — review memories
6. `sessions_cleaner_write_memory` / `delete_memory` / `write_memory_index` — consolidate
7. `sessions_cleaner_write_report` — save today's `cowork-audit-YYYY-MM-DD.md`

## Directory Structure

```text
├── claude-config-sample.json   # Example Claude Desktop config
├── package.json
├── tsconfig.json               # Base TS config
├── tsconfig.build.json         # Build config (emits to dist/)
├── .env.example                # Template for ROOT_PATH + HOUSEKEEPING_PATH
├── src/
│   ├── index.ts                # MCP server entry — registers every tool
│   ├── config.ts               # Env var loading
│   ├── utils.ts                # Path safety, du wrapper, JSON helpers
│   ├── audit.ts                # 10 read-only checks + artifactPrune
│   ├── report.ts               # report list/clean/write
│   └── memory.ts               # memory list/read/write/delete/index_write
└── dist/                       # Build output (gitignored, created by `npm run build`)
    └── index.js                # Compiled entry point used by Claude Desktop
```

## Quick Start

1. **Install dependencies**: `npm install`
2. **Identify your sessions root** — the inner UUID directory that contains `local_*.json`, `artifacts.json`, `spaces/`, `rpm/`, etc. On macOS, this is the second-level UUID under `~/Library/Application Support/Claude/local-agent-mode-sessions/`.
3. **Configure Claude Desktop** with `dist/index.js` and both env vars (see [Configuration](#configuration)).
4. **Build**: `npm run build`
5. **Restart Claude Desktop** — the `sessions_audit_*` and `sessions_cleaner_*` tools should appear.

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

| Name                | Required | Description                                                                |
| ------------------- | -------- | -------------------------------------------------------------------------- |
| `ROOT_PATH`         | yes      | Absolute path or `~/...` to the local-agent-mode-sessions inner directory. |
| `HOUSEKEEPING_PATH` | yes      | Absolute path or `~/...` to the directory where audit reports are written. |

### Claude Desktop Configuration

Run `npm run build` first so `dist/index.js` exists, then add to your Claude Desktop config:

```json
{
  "mcpServers": {
    "mcp-local-agent-mode-sessions": {
      "command": "node",
      "args": ["/path/to/mcp-local-agent-mode-sessions/dist/index.js"],
      "env": {
        "ROOT_PATH": "/Users/you/Library/Application Support/Claude/local-agent-mode-sessions/<account-uuid>/<workspace-uuid>",
        "HOUSEKEEPING_PATH": "/Users/you/Documents/Claude/Projects/Claude Housekeeping"
      }
    }
  }
}
```

A starter is in [`claude-config-sample.json`](./claude-config-sample.json).

### Running From Source (Dev)

```bash
ROOT_PATH=~/Library/Application\ Support/Claude/local-agent-mode-sessions/<a>/<w> \
HOUSEKEEPING_PATH=~/Documents/Claude/Projects/Claude\ Housekeeping \
  npm run dev:mcp
```

## Development

```bash
npm run dev:mcp        # tsx watch mode
npm run start:mcp      # build then run from dist/
npm run inspect        # MCP Inspector against TS source
npm test               # vitest
npm run typecheck      # tsc --noEmit
npm run lint:check     # Biome lint + format check
npm run lint:fix       # Biome auto-fix (uses --unsafe)
npm run lint:md        # prettier + markdownlint for *.md
```

## Security Model

- All paths are validated against `ROOT_PATH` (or, for memory tools, against `ROOT_PATH/spaces/<space_id>/memory/`). Inputs resolving outside their root are rejected with `Path escapes root: "<input>"`.
- The server has no network access and performs no authentication. Trust is delegated entirely to the local OS user running it.
- `sessions_cleaner_*` tools are flagged with `destructiveHint: true` so MCP clients can prompt before invoking them.

## Troubleshooting

**`ROOT_PATH environment variable must be set`**

Set it in the Claude Desktop config `env` block, or as a shell variable for `dev:mcp`. It must point to the **inner** UUID directory, not the top-level `local-agent-mode-sessions/` parent.

**`ROOT_PATH not accessible: <path>`**

The path doesn't exist or isn't readable. Verify, and check that `~` was expanded as you expected (the server expands a leading `~/` itself).

**Tool returns `Path escapes root`**

The requested path resolves outside its allowed root. Use names without leading `..` or absolute paths.
