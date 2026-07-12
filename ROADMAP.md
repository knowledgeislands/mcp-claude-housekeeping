# Roadmap

Forward-looking plans only. Shipped features live in [README.md](./README.md); release history lives in the git log.

## Next Up

- **Bug: orphan detection trusts ambiguous slug decoding.** `claude_code_orphan_projects_prune` (and the orphan flag in `claude_code_projects_list`) reconstructs a project's source path by decoding every `-` in the `~/.claude/projects/` dir name back to `/`, but the slug also flattens `.`, spaces, and literal `-`, so live projects are misidentified as orphans — a 2026-07-11 dry run flagged 12 dirs of which 7 were live (including `~/.claude` itself, `dev/hnr/hnr-backend`, and `kis/kit-personal/kit-pkb`); a non-dry run would have deleted their session history. Fix: resolve the true path from the `cwd` field inside the project's session `.jsonl` files, and treat a project with no readable `cwd` as unverifiable → skip, never delete.
- **Gap: no destructive tools for Claude Desktop sessions and outputs.** The desktop surface has read-side audits (`claude_desktop_sessions_obsolete`, `claude_desktop_outputs_obsolete`) but no paired `claude_desktop_sessions_prune` / `claude_desktop_outputs_prune`, so flagged findings (1,136 obsolete sessions ≈ 4.18 GB on the 2026-07-11 audit) are only cleanable via the Desktop app UI. Add both, `dry_run`-first, with the standard destructive annotations and access-level gating.

## Future Advanced Capabilities

## Tooling

- Close remaining coverage gap to satisfy the 100% vitest threshold (currently 99.4% lines / 98.7% branches). Mostly defensive arms in [src/main/claude-desktop/sessions.ts](./src/main/claude-desktop/sessions.ts) and [src/utils/audit-log.ts](./src/utils/audit-log.ts) — either tests or `/* v8 ignore */` markers (kb-fs and m365 ship the same pattern for the audit-log TOCTOU arm).
- Smoke test (`bun run ki:test:smoke`) — boot the built server and verify the wire-level tool surface matches in-process registration. mcp-gmail has the reference implementation (`scripts/smoke.ts` + CI step); housekeeping lacks both.
