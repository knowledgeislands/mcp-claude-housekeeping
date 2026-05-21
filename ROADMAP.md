# Roadmap

Forward-looking plans only. Shipped features live in [README.md](./README.md); release history lives in the git log.

## Next Up

## Future Advanced Capabilities

## Tooling

- Close remaining coverage gap to satisfy the 100% vitest threshold (currently 99.4% lines / 98.7% branches). Mostly defensive arms in [src/tools/claude-desktop/sessions.ts](./src/tools/claude-desktop/sessions.ts) and [src/utils/audit-log.ts](./src/utils/audit-log.ts) — either tests or `/* v8 ignore */` markers (kb-fs and m365 ship the same pattern for the audit-log TOCTOU arm).
- Smoke test (`bun run test:smoke`) — boot the built server and verify the wire-level tool surface matches in-process registration. mcp-gmail has the reference implementation (`scripts/smoke.ts` + CI step); housekeeping lacks both.
