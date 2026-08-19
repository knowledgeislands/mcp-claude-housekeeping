---
id: MCP-CH-FND-003
area: FND
title: Schema Claude Desktop outputs
theme: foundation-tooling
horizon: now
status: ready
blocks: []
blocked_by: []
baseline_ref: null
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

- [ ] Inventory every `jsonResult()` return shape in `src/tools/claude-desktop/index.ts`, grouping identical stable envelopes without widening any field beyond observed output.
- [ ] Add source-local strict Zod output schemas to the Claude Desktop registrations, following the established Claude Code and VS Code MCP pattern.
- [ ] Add observable MCP tests for representative successful and error envelopes, preserving tool names, input schemas, annotations, and effects.
- [ ] Run the focused MCP audit and full repository gate; update the public tool reference only if schema exposure changes generated documentation.

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

## Discussion

The repair should make the existing response contracts explicit rather than merely suppressing the audit signal. The number and shape of schemas must come from the actual registrations, not a generic catch-all schema.
