---
id: MCP-CH-FND-003
area: FND
title: Schema Claude Desktop outputs
theme: foundation-tooling
horizon: now
status: awaiting-review
blocks: []
blocked_by: []
baseline_ref: 949474965f3500bfefd237443203a08bf875b85d
---

## Goal

Give the Claude Desktop MCP tool group explicit output schemas for its structured result envelopes.

## Context

The shared `TOOL-1` evidence correction now scopes result evidence to `src/tools/**`. Fleet re-audits cleared false positives in the other MCP repositories, leaving one genuine warning: `src/tools/claude-desktop/index.ts` returns `jsonResult()` without a source-local `outputSchema`.

## Boundary

Do not change tool names, annotations, input schemas, filesystem behaviour, or registration ownership. Define the existing result envelopes precisely; do not suppress the audit finding.

## Current state

The Claude Desktop module registers its own tools and already uses strict input schemas. Unlike the sibling Claude Code and VS Code tool modules, it supplies no `outputSchema` declarations despite returning structured MCP envelopes.

## Steps

- [x] Inventory every `jsonResult()` return shape in `src/tools/claude-desktop/index.ts`, grouping identical stable envelopes without widening any field beyond observed output.
- [x] Add source-local strict Zod output schemas to the Claude Desktop registrations, following the established Claude Code and VS Code MCP pattern.
- [x] Add observable MCP tests for representative successful and error envelopes, preserving tool names, input schemas, annotations, and effects.
- [x] Run the focused MCP audit and full repository gate; update the public tool reference only if schema exposure changes generated documentation.

## Files touched

- `src/tools/claude-desktop/index.ts` — output-schema declarations beside the existing registrations.
- Claude Desktop MCP contract tests — representative success and error envelopes.
- `README.md` only if generated or manually maintained tool reference changes.
- This roadmap record.

## Verify

- `ki repo audit --repo .` clears `TOOL-1` without introducing new MCP findings.
- The repository's existing typecheck, lint, test, and build gates pass.

## Dependencies / blocks

None.

## Documentation impact

### Decision Records

No decision record is expected; the schemas formalise an existing public boundary.

### Specifications

Update tool specifications only if they name output envelopes that change during the inventory.

### Guides

No guide change is expected; the source-local output-schema convention is already established in sibling modules.

### Roadmap

No follow-on work is known. This replaces the original ownership diagnosis now resolved by `KI-HARNESS-FND-016`.

## Review

### Delivered

All 20 Claude Desktop tools now declare source-local strict Zod output schemas for their existing structured result envelopes. Tool names, annotations, input schemas, filesystem behaviour, and registration ownership are unchanged. The immutable baseline is `949474965f3500bfefd237443203a08bf875b85d`; the implementation commit is `5d450f88b6c09e6de460d8ed5890a6ca22339c95`.

### Summary of changes

`src/tools/claude-desktop/index.ts` now models the ten aggregate workspace reports and ten direct results, sharing only stable primitives and the common aggregate wrapper. Nested objects are strict, and artifact pruning retains its two observed response variants instead of widening them into one optional-field catch-all. `src/tools/claude-desktop/schemas.test.ts` proves all registrations expose schemas, rejects extra top-level and nested fields, validates a successful handler result, and preserves the existing MCP error envelope. The README remains unchanged because its tool reference does not enumerate output envelopes.

### Verification

`bunx vitest run src/tools/claude-desktop/schemas.test.ts` passes 9 tests. `bunx tsc --noEmit` and `bun run build` pass. `bun run test` passes 310 tests across 15 files. `bun run test:coverage` retains 100% statements (1105/1105), branches (548/548), functions (178/178), and lines (947/947). `ki repo audit --repo .` clears `TOOL-1` and reports `FAIL=0` with one pre-existing authoring warning.

### Outstanding concerns

The repository's `.rumdl.toml` remains behind the current authoring template and produces the audit's sole warning. It predates this item, does not affect the TypeScript or MCP contract, and should be handled as a separate authoring-conformance change rather than folded into this bounded implementation.

### Post-change review

The schemas describe observed return shapes without introducing a generic record or changing runtime results. Registration-level tests cover the public tool boundary, while the full suite and coverage gates protect the underlying handlers. The work meets the stated goal and is ready for acceptance.

### Mini recap

Claude Desktop now exposes the same explicit result-contract discipline as the sibling Claude Code and VS Code modules. The genuine `TOOL-1` warning is resolved; only unrelated authoring-template drift remains.

## Discussion

The repair should make the existing response contracts explicit rather than merely suppressing the audit signal. The number and shape of schemas must come from the actual registrations, not a generic catch-all schema.
