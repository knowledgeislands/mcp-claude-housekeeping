---
id: MCP-CH-OPS-001
title: Make orphan detection path-safe
theme: operations
horizon: next
status: open
blocks: []
blocked-by: []
baseline-ref: null
---

## Context

Resolve the true project path from the `cwd` field in session `.jsonl` files rather than decoding the ambiguous Claude project-directory slug.

## Boundary

If no readable `cwd` is available, treat the project as unverifiable and skip it; never delete it.
