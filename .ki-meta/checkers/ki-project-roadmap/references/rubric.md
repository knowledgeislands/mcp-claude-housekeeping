# Project roadmap audit rubric

The checker applies `[M]` criteria. A reviewer applies `[J]` criteria after the checker.

## Scope and profile

- **SCOPE-1 [M]** KB repositories use `ki-kb-streams`; project-roadmap artifacts in a KB FAIL. A KB without them reports NA. ([standard](standards.md#scope))
- **PROFILE-1 [M]** A non-KB repository has a root `ROADMAP.md`; `docs/roadmap/` selects thematic profile, otherwise simple. Missing roots or incomplete thematic structure FAIL. ([standard](standards.md#simple-profile))
- **PROFILE-2 [J]** Simple remains appropriate only while the work is understandable without theme isolation or execution plans. ([standard](standards.md#expansion-boundary))

## Roadmaps and items

- **ROAD-1 [M]** Every authored roadmap has one H1 and the five horizons exactly once, in canonical order. ([standard](standards.md#horizons))
- **ROAD-2 [J]** Items sit in honest horizons; Waiting-for items name their external condition; speculative Future work says `(candidate)`. ([standard](standards.md#horizons))
- **ROAD-3 [J]** Roadmaps are open-only and contain finite work rather than continuous practice. ([standard](standards.md#horizons))
- **ROAD-4 [M]** Every horizon heading is followed immediately by its exact canonical blurb; CONFORM inserts a missing blurb without removing existing authored content. ([standard](standards.md#horizons))
- **ROAD-5 [J]** Horizon placement and transitions meet the readiness contract: Future work has minimum outcome-and-boundary scope before Soon; Soon work has actionable scope, understood dependencies, and start readiness before Next; Waiting work moves only after its named condition changes; only Blocking or Next work receives a plan. CONFORM never chooses or performs these moves. ([standard](standards.md#promotion-and-readiness))
- **THEME-1 [M]** Theme directories are lowercase kebab-case, contain `ROADMAP.md`, and thematic items are `###` headings under a horizon. ([standard](standards.md#thematic-profile))
- **THEME-2 [M]** Every theme roadmap declares exactly one unquoted uppercase `code`, unique across the repository; plan ids in that theme begin with that stable code. ([standard](standards.md#thematic-profile))
- **THEME-4 [J]** Themes are coherent workstreams, neither catch-alls nor one-item bureaucracy. ([standard](standards.md#expansion-boundary))
- **THEME-3 [M]** A theme roadmap contains at least one item. CONFORM prunes only an otherwise scaffold-only empty theme, retaining `docs/roadmap/README.md` and every repository `README.md`. ([standard](standards.md#thematic-profile))
- **ITEM-1 [M]** Each thematic item has one unique qualified `<theme>/<item-slug>` locator. Duplicate derived locators FAIL. ([standard](standards.md#thematic-profile))
- **PROJ-1 [M]** The thematic root `ROADMAP.md` exactly matches the generated linked portfolio and repeats no item prose. ([standard](standards.md#thematic-profile))

## Plans

- **PLAN-1 [M]** Plans use `docs/roadmap/<theme>/plans/<THEME>-<NNN>-<slug>.md`, use their theme's stable code plus a serial beginning at `001`, and carry required frontmatter; filename and id agree. ([format](plan-format.md#placement))
- **PLAN-2 [M]** `roadmap:` is a qualified locator in the same theme and resolves to a `Blocking` or `Next` item. ([format](plan-format.md#frontmatter))
- **PLAN-3 [M]** Dependencies use canonical `<THEME>-<NNN>` plan identifiers, exist, are reverse-consistent, and are acyclic. An in-progress plan has no non-done blocker. ([standard](standards.md#plan-discipline))
- **PLAN-4 [J]** In-progress plans have concrete Steps, checkable Verify, honest Current state, and minimal Files touched. ([standard](standards.md#plan-discipline))
- **PLAN-5 [J]** In-progress status reflects live work; stale plans are advanced, returned to open, or removed. ([standard](standards.md#plan-discipline))
- **INDEX-1 [M]** `docs/roadmap/README.md` exactly matches the generated theme index, list-based active-plan sections, and dependency graph. ([standard](standards.md#thematic-profile))

## Safe mechanics

- **SAFE-1 [M]** CONFORM and EDUCATE refuse symlink output paths, support dry-run, avoid clobbering authored files, and write generated files atomically. ([standard](standards.md#expansion-boundary))
- **EXPAND-1 [J]** EXPAND conserves every open item exactly once and preserves its horizon and prose. ([standard](standards.md#expansion-boundary))
