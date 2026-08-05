---
id: MCP-CH-OPS-002
title: Add Claude cleanup tools
theme: operations
horizon: next
status: draft
blocks: []
blocked-by: []
baseline-ref: null
---

## Goal

Achieve the stated outcome: Add destructive cleanup tools for Claude Desktop sessions and outputs.

## Context

Add dry-run-first, access-gated prune tools for the existing Claude Desktop obsolete-session and obsolete-output audits.

## Boundary

Use the standard destructive annotations.

## Current state

Both audits exist and are read-only. `listObsolete()` in [src/main/claude-desktop/audit.ts](../../src/main/claude-desktop/audit.ts) selects `local_*.json` files in a workspace root older than `older_than_days` and reports each with its own size plus the size of the matching `local_*` sibling directory. `obsoleteOutputs()` in the same file walks each `local_*` directory, lists the files directly inside its `outputs/` and `uploads/` subdirs, and marks each finding `obsolete` based on the mtime of the corresponding `<session>.json` (falling back to the directory's own mtime).

They are surfaced as `claude_desktop_sessions_obsolete` and `claude_desktop_outputs_obsolete`, both registered with `READ_ONLY` in [src/tools/claude-desktop/index.ts](../../src/tools/claude-desktop/index.ts) and both aggregated across workspaces via the `aggregate()` helper.

Neither has a prune counterpart. The only destructive tools in the Claude Desktop group today are `claude_desktop_artifacts_prune`, `claude_desktop_reports_clear` and `claude_desktop_memory_delete` — confirmed against the registrations in `src/tools/claude-desktop/index.ts` and the `EXPECTED_TOOLS` list in [scripts/smoke.ts](../../scripts/smoke.ts). So an operator can see obsolete Claude Desktop sessions and outputs through this server but cannot act on them through it.

The sibling groups already have the equivalent: `claude_code_sessions_prune` (backed by `sessionsPrune` in `src/main/claude-code/audit.ts`) and `vscode_sessions_prune`. This is a gap in the Claude Desktop group specifically, not a missing capability pattern.

Every convention the work needs is already in place. `DESTRUCTIVE_ONESHOT` in [src/utils/annotations.ts](../../src/utils/annotations.ts) is the correct preset for prunes whose effect depends on current filesystem contents; `makeAccessGatedRegister()` derives the registration level from those annotations, so the tools stay hidden at the default `read` access level; `requireSingleWorkspace()` in the tools file forces an explicit `workspace` argument when more than one workspace is configured; and `claude_desktop_artifacts_prune` is the in-repo model for the `dry_run: boolean` default-`true` shape.

## Steps

- [ ] Add prune functions beside their audits in `src/main/claude-desktop/audit.ts`, taking the workspace root plus `{ older_than_days, dry_run }`, and reusing the same selection predicates the audits use so preview and effect cannot diverge.
- [ ] Declare and enforce the deletion patterns explicitly: session pruning removes only a matched `local_*.json` and its matching `local_*` directory; output pruning removes only files directly inside `<session>/outputs/` and `<session>/uploads/` and never the session directory itself.
- [ ] Register `claude_desktop_sessions_prune` and `claude_desktop_outputs_prune` with `DESTRUCTIVE_ONESHOT`, a `dry_run` default of `true`, `.strict()` schemas, and `requireSingleWorkspace()` rather than cross-workspace aggregation.
- [ ] Add tmpdir-backed tests covering the dry-run/no-mutation case, agreement between the audit's list and the prune's deletions, survival of non-matching filenames, and the age-cutoff boundary.
- [ ] Update `EXPECTED_TOOLS` in `scripts/smoke.ts` and the Available Tools table and workflow prose in the README so the wire surface, the docs, and the code stay in step.

## Files touched

- [src/main/claude-desktop/audit.ts](../../src/main/claude-desktop/audit.ts) — the two new prune functions alongside `listObsolete` and `obsoleteOutputs`
- [src/main/claude-desktop/audit.test.ts](../../src/main/claude-desktop/audit.test.ts) — prune behaviour, pattern scoping, and boundary fixtures
- [src/tools/claude-desktop/index.ts](../../src/tools/claude-desktop/index.ts) — registration in the destructive block
- [src/tools/claude-desktop/schemas.test.ts](../../src/tools/claude-desktop/schemas.test.ts) — annotation and `dry_run` default assertions
- [scripts/smoke.ts](../../scripts/smoke.ts) — `EXPECTED_TOOLS`
- [README.md](../../README.md) — Available Tools and the cleanup workflow section

## Verify

1. `bun run test`
2. `bun run test:coverage`
3. `bun run ki:test:smoke` — passes only once `EXPECTED_TOOLS` and the registered surface agree on both new names.
4. `ki repo audit --repo .`
5. Both tools are absent from `tools/list` at the default `read` access level and present at `destructive`.
6. With `dry_run` left at its default, a fixture workspace is byte-for-byte unchanged while the response still reports what would be removed.

## Dependencies / blocks

Nothing blocks this item and it blocks nothing; both frontmatter arrays are empty and that matches the code. The work sits entirely in the Claude Desktop group, while [MCP-CH-OPS-001](MCP-CH-OPS-001-make-orphan-detection-path-safe.md) changes the Claude Code group's orphan detection, and the two touch no shared implementation.

The one genuine coupling is conventional rather than mechanical: if OPS-001 introduces a new safety idiom for destructive tools, the tools added here should adopt it. That argues for taking OPS-001 first, but it does not block this item.

## Discussion

### Preview and effect must share one predicate

The main design constraint is that the prune must not re-derive its own notion of "obsolete". If the prune reimplements the mtime comparison or the filename match, the read-only audit an operator inspects and the destructive tool they then run can disagree, and the `dry_run` default stops being a meaningful safeguard. Factoring the selection out of `listObsolete` and `obsoleteOutputs` so both the audit and the prune call it is the shape to aim for.

### Open question: what output pruning should be allowed to target

`obsoleteOutputs()` already computes an `obsolete` flag per session, so the obvious rule is that output pruning only touches sessions that flag obsolete. The alternative — pruning `outputs/` and `uploads/` for a named session regardless of its age, on the grounds that generated artifacts are cheaper to lose than session records — is defensible but changes the tool from an age-driven prune into a targeted delete, with a different argument shape. This is undecided and should be settled before step 3.

### Sizing of the destructive surface

This adds two tools to a group that currently has three destructive ones, all hidden behind the default `read` access level. That is within the existing pattern rather than a step change, and no new environment knob or access tier is needed — the annotation-derived gate plus the `dry_run` default already provide the two required layers.
