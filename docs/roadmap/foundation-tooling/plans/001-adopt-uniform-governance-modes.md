---
id: '001'
title: Adopt uniform governance modes and bootstrap
status: open
roadmap: foundation-tooling/adopt-uniform-governance-modes-and-bootstrap
blocks: —
blocked-by: —
---

## Context

This MCP repository is an early matched follow-up in the harness's uniform-mode rollout. Its legacy aggregate audit delegates to removed project-local skill scripts. The harness coordinating plan `foundation-tooling/004` governs the fleet recipe; this plan governs this repository's package, bootstrap, and generated-payload migration.

## Current state

On 2026-07-16, the repository was clean on `main`, declared `ki-repo`, `ki-authoring`, `ki-engineering`, and `ki-mcp`, and carried the pre-rollout vendor reference `8240bc5629d40ca33f08f20d8141973b6984f93e`. Its `ki:audit` command still calls the historical `scripts/ki/aggregate.ts` and unavailable `.claude/skills/*/scripts` paths.

## Steps

1. Add the `ki-project-roadmap` coverage declaration and re-bootstrap from the current harness, publishing only the declared generated runtime payloads.
2. Reconcile `package.json` and CI with the canonical generated aggregate and per-skill commands, preserving MCP-specific server, generator, and smoke-test commands.
3. Run the focused bootstrap, project-roadmap, engineering, authoring, MCP, test, and aggregate gates; classify every failure as repository drift or a harness defect.
4. Commit the validated migration and report the observed recipe variant, if any, to the harness coordinating plan.

## Files touched

`.ki-config.toml`, `.ki-meta/`, generated project-local runtime payloads, `package.json`, `.github/workflows/ci.yml`, legacy `scripts/ki/` wrappers, `ROADMAP.md`, and `docs/roadmap/`.

## Verify

`bun run test`, the focused artifact audits, and `bun run ki:audit` pass; the thematic roadmap audit passes; the generated root roadmap and index are current; and no unrelated MCP source behaviour changes.

## Dependencies / blocks

This repository follows the validated `mcp-ki-kb-fs` pilot under harness plan `foundation-tooling/004`. It is unblocked by local state. A failure that shows the harness contract is incomplete returns to `ki-agentic-harness`; this repository does not invent a consumer-side workaround.
