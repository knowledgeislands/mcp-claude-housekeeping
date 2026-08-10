---
id: MCP-CH-OPS-001
area: OPS
title: Harden orphan detection
theme: operations
horizon: next
status: draft
blocks: []
blocked_by: []
baseline_ref: null
---

## Goal

Achieve the stated outcome: Make orphan detection path-safe.

## Context

Resolve the true project path from the `cwd` field in session `.jsonl` files rather than by decoding the ambiguous Claude project-directory slug.

## Boundary

If no readable `cwd` is available, treat the project as unverifiable and skip it; never delete it.

## Current state

Orphan status is derived entirely from the directory name. `decodeProjectDir()` in [src/main/claude-code/audit.ts](../../src/main/claude-code/audit.ts) reverses the slug with `/${encoded.replace(/^-+/, '').replace(/-/g, '/')}` and sets `source_exists` from a `pathExists()` check on the result.

That decode cannot be correct, because the forward encoding is lossy. `encodeProjectPath()` in the same file maps both `/` and `.` to `-` (`absolutePath.replace(/[/.]/g, '-')`), and a literal `-` already present in a path survives unchanged. So `/Users/foo/my-repo`, `/Users/foo/my.repo` and `/Users/foo/my/repo` all encode to the same slug, and the decode picks exactly one of them. Any project whose real path contains `.` or `-` decodes to a path that does not exist and is therefore reported as an orphan while its source is still on disk.

`discoverProjects()` is the single producer of `source_exists`, and three consumers act on it: `projectsList()` surfaces it per project, `storageSummary()` counts it into `orphan_project_count` and the `orphan_projects_exceed_*` flag, and `pruneOrphanProjects()` calls `fs.rm(p.dir, { recursive: true, force: true })` on every project with `!source_exists`. The only guard on that delete path today is the `has_memory` skip (overridable via `include_with_memory`) and the `dry_run: true` default. A false orphan that has no `memory/` subdir is deleted with its full session history.

Nothing in the codebase reads session file contents for a `cwd` field. `grep -rn cwd src` matches only a comment in [src/config/index.ts](../../src/config/index.ts) about not using `process.cwd()`. The authoritative source path is written into the session records on disk, but this server has never opened them for that purpose — `sessionRead()` is the only reader of `.jsonl` content and it returns raw lines for preview.

The path-containment helpers in [src/utils/utils.ts](../../src/utils/utils.ts) (`resolveWithinRoot()`, `assertRealPathWithinRoot()`) protect user-supplied identifiers that become path segments under a configured root. A `cwd` read out of a session file is a different kind of input — an absolute path from file content, pointing deliberately outside every configured root — and no validator for that shape exists today.

Existing coverage in [src/main/claude-code/audit.test.ts](../../src/main/claude-code/audit.test.ts) asserts orphan flagging and pruning against tmpdir fixtures whose paths round-trip cleanly (the non-orphan case uses `/tmp`). No fixture exercises a source path containing `.` or `-`, so the collision is invisible to the current suite.

## Steps

- [ ] Confirm the on-disk shape first: inspect real session `.jsonl` records to establish where `cwd` appears and how consistently, before fixing any parsing contract.
- [ ] Add a bounded `cwd` resolver in `src/main/claude-code/audit.ts` that reads a capped number of leading lines/bytes from a project's session files, extracts `cwd` from the first parseable record that carries it, and returns `null` on absent, unreadable, or unparseable input.
- [ ] Validate the recovered value before trusting it — absolute, no `..` segment — and only then existence-check it; an invalid or missing value must degrade to unverifiable, never to orphan.
- [ ] Rework `discoverProjects()` to report a three-valued source status (verified-present / verified-missing / unverifiable) alongside its provenance, keeping the decoded slug as a best-effort display value only, and propagate that through `projectsList()` and `storageSummary()`.
- [ ] Restrict `pruneOrphanProjects()` to verified-missing projects, retaining the `has_memory` skip and the `dry_run` default, and report unverifiable projects as explicitly skipped with a reason.
- [ ] Extend fixtures to cover a source path containing `.` and `-`, a project with no readable `cwd`, and a project whose `cwd` is readable but genuinely gone; update tool output schemas, descriptions, and README wording to match the new status vocabulary.

## Files touched

- [src/main/claude-code/audit.ts](../../src/main/claude-code/audit.ts) — `decodeProjectDir`, `discoverProjects`, `storageSummary`, `pruneOrphanProjects`, plus the new resolver
- [src/main/claude-code/audit.test.ts](../../src/main/claude-code/audit.test.ts) — collision, unverifiable, and verified-missing fixtures
- [src/tools/claude-code/index.ts](../../src/tools/claude-code/index.ts) — output schema fields and tool descriptions for `claude_code_projects_list`, `claude_code_storage_summary`, `claude_code_orphan_projects_prune`
- [src/tools/claude-code/schemas.test.ts](../../src/tools/claude-code/schemas.test.ts) — registration/schema assertions for the changed shapes
- [README.md](../../README.md) — the orphan rows in Available Tools
- [CLAUDE.md](../../CLAUDE.md) — Security Requirements, if a new content-derived-path validator is introduced

## Verify

1. `bun run test`
2. `bun run test:coverage`
3. `bun run ki:test:smoke`
4. `ki repo audit --repo .`
5. A fixture project whose real source path contains `.` and `-` is reported present, is excluded from `orphan_project_count`, and survives `pruneOrphanProjects` with `dry_run: false` and `include_with_memory: true`.
6. A fixture project with no readable `cwd` is reported unverifiable and is never deleted under any argument combination.

## Dependencies / blocks

Nothing blocks this item and it blocks nothing; both frontmatter arrays are empty and that reflects the code. The work is confined to the Claude Code group, whereas [MCP-CH-OPS-002](MCP-CH-OPS-002-add-destructive-cleanup-tools.md) adds tools to the Claude Desktop group; they share no call path beyond the generic helpers in `src/utils/`, so neither has to land first.

There is a judgment-level relationship worth stating without inventing a mechanical one: this item hardens an existing destructive tool against a false-positive delete, and OPS-002 adds new destructive tools. Doing this one first keeps the fleet's safety posture ahead of its destructive surface, but that is a sequencing preference, not a dependency.

## Discussion

### The collision is the whole problem

`s/[\/.]/-/g` is not injective, so no decoder can recover the original path from the slug alone — the ambiguity is in the encoding, not in the current implementation's cleverness. Any fix that stays inside the slug (heuristic re-expansion, trying candidate splits, checking which candidate exists) trades one guess for another. Reading `cwd` from the session records replaces guessing with the value the writer actually recorded, which is why the item is framed around that field rather than around a better decoder.

### Unverifiable must be its own state

Today `source_exists` is a boolean, and false doubles as both "the source is gone" and "we could not work out what the source was". Collapsing those is what makes the delete unsafe. The Boundary above resolves it in one direction only — unverifiable never gets deleted — which means the type has to carry three states, and the tool output has to say which one it is so an operator can tell a genuine orphan from a project the server could not read.

### Open question: cost and bounding of the read

Reading session content on every `projectsList` / `storageSummary` call is more expensive than the current `pathExists` on a decoded string, and project dirs can hold many large `.jsonl` files. The read must be bounded (first N lines or bytes, first file that yields a `cwd`), and it may want a cached or opt-in path for the pure-listing tools, but the right bound has not been chosen and should be settled against real file sizes during step 1.

### Uncertainty flagged

I have not verified the record shape of a session `.jsonl` line in this session — the repo's own code never reads `cwd`, so there is no in-repo evidence of where the field sits or whether every record carries it. Step 1 exists precisely to establish that before the parsing contract is fixed; if `cwd` turns out to be absent or inconsistent in practice, the fallback is the Boundary's unverifiable state, and the value of the item shrinks to "stop deleting on a guess" rather than "resolve the true path".
