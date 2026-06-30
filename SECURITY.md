# Security Policy

## Reporting a Vulnerability

If you find a security issue in `@knowledgeislands/mcp-claude-housekeeping`, **please do not file a public GitHub issue.** Instead, email the maintainer directly:

- **<kris@kris.me.uk>** — subject: `mcp-claude-housekeeping security`

Include:

- A description of the issue and the impact (e.g. "path traversal", "arbitrary file write outside a workspace").
- Steps to reproduce, ideally with a minimal proof-of-concept.
- The version of the package (`bun pm ls @knowledgeislands/mcp-claude-housekeeping`, or `npm ls ...` if installed via npm) and Node version.

You should expect an acknowledgement within 72 hours. We aim to triage, investigate, and ship a fix within 14 days for high-severity issues.

## Scope

`mcp-claude-housekeeping` is a stdio MCP server that exposes read-only audit checks and destructive housekeeping over a local Claude `local-agent-mode-sessions/` directory tree. It runs locally with the privileges of the user who launched it, and the security boundary is the discovered workspace root under the hardcoded `CLAUDE_DESKTOP_ROOT_PATH` (plus `CLAUDE_CODE_ROOT_PATH`, `VSCODE_WORKSPACE_STORAGE_ROOT_PATH`, and `MCP_CLAUDE_HOUSEKEEPING_PATH` for their respective tool groups and report writes).

In scope:

- Path containment in `src/utils/utils.ts` (`resolveWithinRoot`) — any input that resolves outside its workspace root (traversal, symlink escape, encoded separators, edge cases around trailing slashes).
- Memory-tool containment under `<workspace>/spaces/<space_id>/memory/`.
- Tool implementations under `src/main/{claude-desktop,claude-code,vscode}/` (with their thin registration wrappers under `src/tools/{claude-desktop,claude-code,vscode}/`) — including the destructive `write`-role operations (anything annotated `DESTRUCTIVE` or `DESTRUCTIVE_ONESHOT`).
- Config loading in `src/config/index.ts` (`loadConfig` — MCP_CLAUDE_HOUSEKEEPING_PATH required) and workspace discovery in `src/utils/utils.ts` (`discoverWorkspaces`).

Out of scope:

- Issues only reproducible against a forked or modified version.
- Vulnerabilities in upstream dependencies (please report those upstream; open an issue here only if this package exposes the flaw in a way the upstream project does not).
- Issues that require local OS-level access already higher-privileged than the user running the MCP server (e.g. an attacker who can already write files inside `CLAUDE_DESKTOP_ROOT_PATH` or replace the binary).
- Misconfiguration of `MCP_CLAUDE_HOUSEKEEPING_PATH` to a directory the user did not intend to expose.

## Supported Versions

Only the latest published `1.x` release receives security fixes. Older pre-release builds are not supported.

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |
| < 1.0   | :x:                |
