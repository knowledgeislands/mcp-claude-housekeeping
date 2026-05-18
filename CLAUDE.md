# CLAUDE.md

Guidance for Claude Code when working in this repo. The user-facing tool surface, install/config, and example workflows live in [README.md](./README.md); this file covers what Claude needs to know that isn't in README and isn't derivable from one grep.

## Bun vs Node

This project uses Bun (≥ 1.3) for install and dev scripts, but the compiled `dist/` runs under Node (≥ 22) — that's what Claude Desktop launches.

- `bun run test` (NOT `bun test` — the latter invokes Bun's own runner instead of vitest).
- Bun auto-loads `.env.${NODE_ENV}` from the CWD; Node needs the explicit `process.loadEnvFile()` call in [src/config.ts](./src/config.ts). The try/catch swallows the `TypeError` Bun raises (no `process.loadEnvFile`), so the same code works under both.
- `NODE_ENV` is set to `development` only by `server:mcp:dev` and `server:mcp:inspect`. Claude Desktop doesn't set it, so `.env.*` is ignored in production — `MCP_CLAUDE_HOUSEKEEPING_PATH` must come from the Claude Desktop config `env` block.

Run `bun run` with no args for the full script list.

## Architecture Invariants

### Naming convention

Tool names follow `<app>_<resource>_<action>` (snake_case). `<app>` ∈ {`claude_desktop`, `claude_code`, `vscode`}. `<resource>` is plural for collection ops, singular for single-item ops. `<action>` is a verb or view (`list`, `read`, `write`, `delete`, `prune`, `relocate`, `summary`, `status`, `health`, `inventory`, `clear`, `obsolete`).

### Role gate — driven by annotations, not names

[src/utils/roles.ts](./src/utils/roles.ts) `makeRoleGatedRegister()` decides at startup whether to register each tool, based on `config.annotations.readOnlyHint`:

- `readOnlyHint: true` → `read` role
- anything else → `write` role (fail-safe; an unannotated tool is treated as destructive)

Only tools whose role is in `MCP_CLAUDE_HOUSEKEEPING_ROLES` (default: `read`) are registered. New tools MUST set `annotations` to one of the presets in [src/utils/annotations.ts](./src/utils/annotations.ts): `READ_ONLY`, `DESTRUCTIVE`, or `DESTRUCTIVE_ONESHOT`. Do not bypass the proxy.

### Workspace discovery (Cowork only)

`CLAUDE_DESKTOP_ROOT_PATH` is walked at every tool invocation. A directory is a workspace if it contains any of `.claude.json`, `artifacts.json`, `spaces.json`, `cowork_settings.json`, or `local_*.json`. If the root itself has those marker files, it's treated as a single workspace with id `.` (back-compat with hard-coded inner-UUID configs). The other two roots (Claude Code, VSCode) discover their children differently and never aggregate.

## Security Requirements

Both `read` and `write` roles touch files anywhere under four configured roots. New tools and changes to existing tools MUST preserve every invariant below.

1. **Path containment at every `path.join(<root>, <user-input>)` site.** Wrap with `resolveWithinRoot()` (lexical guard) AND `assertRealPathWithinRoot()` (symlink-aware) from [src/utils/utils.ts](./src/utils/utils.ts). Both apply to `args.workspace`, `args.project`, `args.session`, memory `args.name`, and any new identifier that becomes a path segment.
2. **Tighten input schemas, not just call sites.** Identifier inputs that become path segments must have a regex constraint excluding `/`, `\`, and `..`. Existing patterns: `workspaceArg` (hex), `projectArg` (alphanumeric/`._-`), `sessionArg` (alphanumeric/`._-` + `.json[l]` suffix), memory `name` (must end `.md`). Bare `z.string().min(1)` is not acceptable for path-segment inputs.
3. **Destructive tools require `dry_run` default `true`.** Every `write`-role tool that deletes or renames files must expose `dry_run: boolean`, default to preview, and only mutate when explicitly disabled. The `DESTRUCTIVE_ONESHOT` annotation is required on tools whose effect depends on current FS contents (prune, relocate, delete).
4. **Batch deletes are scoped by filename pattern, never wildcard.** Report cleanup matches `cowork-audit-*.md`; session pruning matches `*.jsonl` (Claude Code) or `*.json[l]` (VSCode). New batch-delete tools must declare and test their pattern — never `fs.rm` arbitrary entries the user named.
5. **Role gate is the registration boundary, keyed off annotations.** See [Role gate](#role-gate--driven-by-annotations-not-names) above.
6. **No shell-string interpolation.** `du` is invoked via `spawn('du', ['-sk', target])` — argv form. New tools that shell out must use `execFile` or `spawn` with an argv array.
7. **Zod schemas are `.strict()`.** Already true everywhere; new schemas must continue this.

Traversal-rejection tests live in [src/tools/vscode/audit.test.ts](./src/tools/vscode/audit.test.ts). Parallel coverage for `claudeCode.sessionRead` / `relocateProject` is a follow-up.

## Tool registration call sites

Each `<app>` group registers its tools in `src/tools/<app>/index.ts`. To survey the surface, `grep "register(" src/tools/*/index.ts`. README's [Available Tools](./README.md#available-tools) tabulates them with purposes.
