---
id: '001'
title: Adopt uniform governance modes and bootstrap
status: in-progress
roadmap: foundation-tooling/adopt-uniform-governance-modes-and-bootstrap
blocks: —
blocked-by: —
---

## Context

This MCP repository is an early matched follow-up in the harness's uniform-mode rollout. Its legacy aggregate audit delegates to removed project-local skill scripts. The harness coordinating plan `foundation-tooling/004` governs the fleet recipe; this plan governs this repository's package, bootstrap, and generated-payload migration.

## Current state

On 2026-07-16, the repository adopted the current five-skill governance baseline: `ki-authoring`, `ki-engineering`, `ki-mcp`, `ki-project-roadmap`, and `ki-repo`. The generated `.ki-meta/` payload now supplies the canonical aggregate commands; the historical checked-in `scripts/ki/` wrappers have been removed. `bun run ki:audit`, `bun run test` (307 passing tests), `bun run ki:test:smoke` (39 tools and schemas), and the bootstrap audit all pass.

## Steps

1. [x] Add the `ki-project-roadmap` coverage declaration and re-bootstrap from the current harness, publishing only the declared generated runtime payloads.
2. [x] Reconcile `package.json` and CI with the canonical generated aggregate and per-skill commands, preserving MCP-specific server, generator, and smoke-test commands.
3. [x] Run the focused bootstrap, project-roadmap, engineering, authoring, MCP, test, and aggregate gates; classify every failure as repository drift or a harness defect.
4. [ ] Commit the validated migration and report the observed recipe variant, if any, to the harness coordinating plan.

## Files touched

`.ki-config.toml`, `.ki-meta/`, `.markdownlint-cli2.jsonc`, `knip.json`, `package.json`, `.github/workflows/ci.yml`, retired `scripts/ki/` wrappers, `ROADMAP.md`, and `docs/roadmap/`.

## Verify

`bun run test`, the focused artifact audits, and `bun run ki:audit` pass; the thematic roadmap audit passes; the generated root roadmap and index are current; and no unrelated MCP source behaviour changes.

## Dependencies / blocks

This repository follows the validated `mcp-ki-kb-fs` pilot under harness plan `foundation-tooling/004`. It is unblocked by local state. A failure that shows the harness contract is incomplete returns to `ki-agentic-harness`; this repository does not invent a consumer-side workaround.
