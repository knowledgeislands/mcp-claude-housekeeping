# CLAUDE.md

Guidance for Claude Code when working in this repo. The user-facing tool surface, install/config, and example workflows live in [README.md](./README.md); this file covers what Claude needs to know that isn't in README and isn't derivable from one grep.

## Bun vs Node

This project uses Bun (≥ 1.3) for install and dev scripts, but the compiled `dist/` runs under Node (≥ 22) — that's what Claude Desktop launches.

- `bun run test` (NOT `bun test` — the latter invokes Bun's own runner instead of vitest).
- Bun auto-loads `.env.${NODE_ENV}` from the CWD; Node needs the explicit `process.loadEnvFile()` call inside `loadConfig()` in [src/config/index.ts](./src/config/index.ts). The try/catch swallows the `TypeError` Bun raises (no `process.loadEnvFile`), so the same code works under both.
- `NODE_ENV` is set to `development` only by `ki:server:mcp:dev` and `ki:server:mcp:inspect`. Claude Desktop doesn't set it, so `.env.*` is ignored in production — `MCP_CLAUDE_HOUSEKEEPING_PATH` must come from the Claude Desktop config `env` block.

Run `bun run` with no args for the full script list.

## Architecture Invariants

### Project layout & config injection (the workspace MCP shape)

This is the canonical layout we roll out across the MCPs:

- **[src/config/index.ts](./src/config/index.ts)** — `loadConfig(env?) → Config`. Reads env (optionally hydrated from `.env.${NODE_ENV}`) into a plain `Config` value. **There is no module-level config singleton — nothing reads env at import time.** `Config` carries `housekeepingPath`, `accessLevel`, the three derived target roots (`claudeCodeRootPath`, `claudeDesktopRootPath`, `vscodeWorkspaceStorageRootPath`), and the audit-log knobs (`auditLogMode`/`auditLogPath`/`auditLogMaxBytes`/`auditLogKeep`). Exported types/constants (`AccessLevel`, `ACCESS_LEVELS`, `ACCESS_LEVEL_RANK`, `AuditLogMode`) live here too.
- **[src/mcp-server/index.ts](./src/mcp-server/index.ts)** — the stdio MCP wrapper. Calls `loadConfig()` once, builds the `AuditConfig` slice, sets `server.registerTool = makeAccessGatedRegister(server, config.accessLevel, audit)`, and threads `config` into each `register<group>Tools(server, config)`. Keeps the startup logging.
- **[src/tools/](./src/tools/)** — MCP tool definitions only. Thin: validate args, call a `main/` function (passing the relevant `cfg` slice as the first arg), map result/throw to an MCP envelope via `jsonResult` / `errorResult`. Excluded from coverage.
- **[src/main/](./src/main/)** — the real implementation, usable outside the MCP server (e.g. from a script). Grouped by concern: `main/claude-code/`, `main/claude-desktop/`, `main/vscode/`. Every `main` entry point takes the config it needs as its **first argument** — a root path (`projectsList(claudeRoot)`, `storageSummary(root, args)`) or `housekeepingPath` (`reportWrite(housekeepingPath, args)`). No hidden state. Tests are co-located.
- **[src/utils/](./src/utils/)** — cross-MCP reusable helpers; keep in sync with sibling repos. These take the **specific config primitive** they need (`makeAccessGatedRegister(server, accessLevel, audit)`, `withAuditLog(audit, name, level, cb)`, `resolveWithinRoot(root, …)`), not the whole `Config`, so they stay MCP-agnostic. `utils.ts` holds the generic FS/format helpers and `discoverWorkspaces(root)`.

To use the code from a script: `const cfg = loadConfig(); await projectsList(cfg.claudeCodeRootPath)`.

### Naming convention

Tool names follow `<app>_<resource>_<action>` (snake_case). `<app>` ∈ {`claude_desktop`, `claude_code`, `vscode`}. `<resource>` is plural for collection ops, singular for single-item ops. `<action>` is a verb or view (`list`, `read`, `write`, `delete`, `prune`, `relocate`, `summary`, `status`, `health`, `inventory`, `clear`, `obsolete`).

### Access-level gate — driven by annotations, not names

[src/utils/access-level.ts](./src/utils/access-level.ts) `makeAccessGatedRegister()` decides at startup whether to register each tool, based on `config.annotations`:

- `readOnlyHint: true` → `read`
- `destructiveHint: true` → `destructive`
- explicit `readOnlyHint: false` AND `destructiveHint: false` → `write` (non-destructive mutation; reserved — no such tools today)
- anything else (unannotated / partially annotated) → `destructive` (fail-safe)

A tool registers when its derived level is at or below `MCP_CLAUDE_HOUSEKEEPING_ACCESS_LEVEL` (default: `read`). Levels nest: `read` registers only readers; `write` adds non-destructive mutations; `destructive` adds prune/relocate/delete. New tools MUST set `annotations` to one of the presets in [src/utils/annotations.ts](./src/utils/annotations.ts): `READ_ONLY`, `DESTRUCTIVE`, or `DESTRUCTIVE_ONESHOT`. Do not bypass the proxy. The gate controls _visibility_; the `dry_run: true` default on destructive tools controls _effect_ — both layers are required.

### Workspace discovery (Cowork only)

`CLAUDE_DESKTOP_ROOT_PATH` is walked at every tool invocation. A directory is a workspace if it contains any of `.claude.json`, `artifacts.json`, `spaces.json`, `cowork_settings.json`, or `local_*.json`. If the root itself has those marker files, it's treated as a single workspace with id `.` (back-compat with hard-coded inner-UUID configs). The other two roots (Claude Code, VSCode) discover their children differently and never aggregate.

## Security Requirements

Every access level touches files anywhere under four configured roots. New tools and changes to existing tools MUST preserve every invariant below.

1. **Path containment at every `path.join(<root>, <user-input>)` site.** Wrap with `resolveWithinRoot()` (lexical guard) AND `assertRealPathWithinRoot()` (symlink-aware) from [src/utils/utils.ts](./src/utils/utils.ts). Both apply to `args.workspace`, `args.project`, `args.session`, memory `args.name`, and any new identifier that becomes a path segment.
2. **Tighten input schemas, not just call sites.** Identifier inputs that become path segments must have a regex constraint excluding `/`, `\`, and `..`. Existing patterns: `workspaceArg` (hex), `projectArg` (alphanumeric/`._-`), `sessionArg` (alphanumeric/`._-` + `.json[l]` suffix), memory `name` (must end `.md`). Bare `z.string().min(1)` is not acceptable for path-segment inputs.
3. **Destructive tools require `dry_run` default `true`.** Every tool registered at the `destructive` level (i.e. deleting or renaming files) must expose `dry_run: boolean`, default to preview, and only mutate when explicitly disabled. The `DESTRUCTIVE_ONESHOT` annotation is required on tools whose effect depends on current FS contents (prune, relocate, delete).
4. **Batch deletes are scoped by filename pattern, never wildcard.** Report cleanup matches `cowork-audit-*.md`; session pruning matches `*.jsonl` (Claude Code) or `*.json[l]` (VSCode). New batch-delete tools must declare and test their pattern — never `fs.rm` arbitrary entries the user named.
5. **Access-level gate is the registration boundary, keyed off annotations.** See [Access-level gate](#access-level-gate--driven-by-annotations-not-names) above.
6. **No shell-string interpolation.** `du` is invoked via `spawn('du', ['-sk', target])` — argv form. New tools that shell out must use `execFile` or `spawn` with an argv array.
7. **Zod schemas are `.strict()`.** Already true everywhere; new schemas must continue this.
8. **Tests MUST NOT touch the real root paths.** `Config.claudeCodeRootPath`, `Config.claudeDesktopRootPath`, and `Config.vscodeWorkspaceStorageRootPath` resolve to live user directories (`~/.claude/`, the Cowork sessions dir, VSCode `workspaceStorage`). Test files MUST NOT call `loadConfig()` and feed its derived roots into a `main/` function. Instead, define a per-suite tmpdir, e.g. `const CLAUDE_CODE_ROOT = path.join(os.tmpdir(), 'mcp-housekeeping-<group>-<file>-tests')`, and pass that as the first arg to the function under test. Because `main/` functions take their root (or `housekeepingPath`) as an injected first argument, this is the natural calling convention — there is no env to mutate. A regression here destroyed real `~/.claude/projects/` history once — don't do it again.

Traversal-rejection tests live in [src/main/vscode/audit.test.ts](./src/main/vscode/audit.test.ts). Parallel coverage for `claudeCode.sessionRead` / `relocateProject` is a follow-up.

## Tool registration call sites

Each `<app>` group registers its tools in `src/tools/<app>/index.ts` (thin wiring) and implements them in `src/main/<app>/`. To survey the surface, `grep "register(" src/tools/*/index.ts`. README's [Available Tools](./README.md#available-tools) tabulates them with purposes.
