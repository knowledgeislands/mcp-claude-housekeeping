# Repo-config audit rubric

The line-by-line checkable criteria behind [the standard](standards.md). Each is tagged **[M] mechanical** (the bundled [`../scripts/audit.ts`](../scripts/audit.ts) enforces it) or **[J] judgment** (a reader assesses it). Every **[M]** item carries a stable `PREFIX-N` code (per `ki-skills`' SHAPE-9 + the checker-contract); the checker emits that code as each finding's `area`, and [`../scripts/conform.ts`](../scripts/conform.ts) uses the same code for its twin action. Judgment **[J]** items are applied by reading; where a `[J]` item pairs with a mechanical counterpart it is still surfaced by `conform.ts` as an `ADVISORY` finding, carrying its own code so it is traceable independently. Each criterion cites the standard layer it verifies.

A criterion's tag is a contract with the script: if you find yourself eyeballing an **[M]** check, run the auditor instead; a **[J]** check that becomes deterministic should move into the script and flip to **[M]**.

Every **[M]** finding here is also auto-fixable: `conform.ts` applies the matching `gh` call or local scaffold directly (`--dry-run` to preview). The **[J]** findings (README/LICENSE content, description text/visibility, whether a `[ki-repo.checks]` override is warranted) are printed as manual TODOs, never guessed.

Where one atomic `conform.ts` action satisfies several fine-grained audit checks (e.g. squash-only + auto-delete-branch, or secret-scanning + push-protection), the checks are bundled under one code from the start — `audit.ts` and `conform.ts` both cite the bundle's parent code, not one per fine check.

## Layer 1 — repo files (presence on the default branch, via the GitHub git-tree API)

- **readme [M]** `` `FILES-1` `` `README.md` present. (standard: Layer 1)
- **license-file [M]** `` `FILES-1` `` `LICENSE` (or `LICENSE.md`) present. FAIL for all repos — its text is the declared license (default MIT), or proprietary copyright text if `license` is `UNLICENSED`. (Layer 1)
- **gitignore [M]** `` `FILES-1` `` `.gitignore` present. (Layer 1)
- **editorconfig [M]** `` `FILES-1` `` `.editorconfig` present. (Layer 1)
- **claude-md [M]** `` `FILES-1` `` `CLAUDE.md` present — the always-loaded anchor for any repo-specific gate or convention (skills rubric SHAPE-7). (Layer 1)
- **ki-config [M]** `` `FILES-1` `` `.ki-config.toml` present with an exact `[ki-repo]` root marker (and read for `visibility` + the `[…checks]` override table). A dotted sub-table such as `[ki-repo.checks]` alone does not satisfy the root marker. EDUCATE and CONFORM append the canonical root block when absent without rewriting existing bytes. (Layer 1)
- **ki-meta [M, warn]** `` `FILES-2` `` the derived `.ki-meta/` subdirs are **gitignored, not committed** — warn if any `.ki-meta/audits/` or `.ki-meta/conform/` path appears in the tree. Presence of `.ki-meta/` is not required; the namespace itself is left un-ignored. (standard: Layer 1 — `.ki-meta/`)
- **authoring-baseline / self-check [M]** `` `FILES-3` `` once `.ki-config.toml` confirms a repo is a ki-repo, it must (a) declare an exact bare `[ki-authoring]` root explicitly — the authoring standard is a declared foundation, not an injected universal (ADR-KI-HARNESS-SKILLS-006) — and (b) carry a self-check runner (`.ki-meta/bin/aggregate.ts` or `.ki-meta/bin/ki-audit`) so `./.ki-meta/bin/ki-audit` works with zero skills installed (ADR-007). Either gap FAILs. EDUCATE and CONFORM repair a missing marker append-only; direct `ki-repo` EDUCATE and bootstrap `--seed ki-repo` then vendor both foundations and the runner in the same run. Existing config bytes remain an exact prefix, dry-run writes nothing, and repeat repair is byte-identical. (Layer 1)

## Layer 2 — core GitHub settings (repos on github.com)

- **default-branch [M]** `` `GH-1` `` default branch is `main`. (Layer 2)
- **license [M]** `` `GH-2` `` live GitHub license matches the declared `[ki-repo]` `license` SPDX id (default MIT); a proprietary declaration expects no recognised OSI license. Decoupled from visibility. (Layer 2)
- **package-license [M]** `` `GH-2` `` _(when package.json exists)_ `package.json` `"license"` matches the declared `license` id (`"UNLICENSED"` for a proprietary declaration). FAIL on any mismatch — bundled with `license` since both check the same declared value from two sources. (Layer 2)
- **package-metadata [M]** `` `PKG-1` `` _(when package.json exists)_ the manifest identity/metadata keys: non-empty `name`, semver `version`, an `author`, a `repository` url referencing the repo, `private` matching visibility, and (WARN-only) `bugs`/`homepage`/`keywords`. (Layer 2 — package.json identity & metadata)
- **description [M]** `` `GH-3` `` description is non-empty. (Layer 2)
- **description-sync [M]** `` `GH-3` `` the GitHub description equals the repo's `package.json` `description` (its in-repo source of truth), where a package.json description exists. (Layer 2)
- **merge [M]** `` `MERGE-1` `` squash only — merge-commit off, rebase off. (Layer 2)
- **delete-branch [M]** `` `MERGE-1` `` auto-delete head branch on merge is on — bundled with `merge`: one atomic `gh repo edit` call sets both. (Layer 2)
- **issues [M, override↓ on]** `` `TOGGLE-1` `` Issues enabled. (Layer 2)
- **wiki [M, override↓ on]** `` `TOGGLE-1` `` Wiki disabled. (Layer 2)
- **projects [M, override↓ on]** `` `TOGGLE-1` `` Projects disabled — bundled with `issues`/`wiki` as the repo-feature-toggle group. (Layer 2)
- **visibility [M]** `` `VIS-1` `` live GitHub visibility matches the value **declared** in `.ki-config.toml` (`visibility = "public" | "private"`); missing/invalid declaration → fail. (standard: Visibility)
- **topics [M, override↓ on]** `` `TOPICS-1` `` _(public)_ carries the standard topic set. (Layer 2)
- **branch-protection [M, override↓ off]** `` `BP-1` `` `main` requires a PR, the `build` check, and linear history. **Off by default** (`main` open) — runs only when a repo sets `branch-protection = true`. (standard: Per-repo overrides)

## Layer 3 — deeper GitHub

- **dependabot-alerts [M]** `` `DEP-1` `` Dependabot alerts on. (Layer 3)
- **dependabot-updates [M]** `` `DEP-1` `` Dependabot security updates on. (Layer 3)
- **update-branch [M]** `` `DEP-1` `` `allow_update_branch` on ("Always suggest updating pull request branches") — keeps a PR, Dependabot's included, current with the base before merge; bundled with the two Dependabot checks as the Dependabot/PR-freshness group. (Layer 3)
- **secret-scanning [M, override↓ on]** `` `SEC-1` `` _(public)_ secret scanning on. (Layer 3; private out of scope — plan-limited)
- **push-protection [M, override↓ on]** `` `SEC-1` `` _(public)_ secret-scanning push protection on — bundled with `secret-scanning`: one atomic `gh api` PATCH sets both. (Layer 3)
- **actions [M, WARN]** `` `ACT-1` `` `allowed_actions` is `all`; anything else WARNs rather than fails (tightening is a deliberate per-repo choice). (Layer 3)

**override↓** marks an **overridable** check: its org default (`on`/`off`) lives in the script's `CHECK_DEFAULTS`, and a repo flips it for itself with a boolean under `[ki-repo.checks]` (`true` = enforce, `false` = don't). Every other check is bedrock — not overridable. An active override prints as a `note`, never a failure; a redundant override (one that just restates the org default) prints a `note` advising it be dropped; a `[…checks]` key that names no overridable check (nor a `coverage-<skill>`, below) **WARNs** — `` `CHECKS-1` ``. (standard: Per-repo overrides)

## Coverage cascade (gated on the `.ki-config.toml` marker)

- **coverage [M, gated]** `` `COV-1` `` Once `.ki-config.toml` confirms the repo is a ki-repo, every governance skill whose applicability is **detected** in the repo must declare its opt-in `[ki-<skill>]` table; a detected artifact with no table WARNs, and a declared table with no matching artifact WARNs as possibly stale. Signals → tables: `package.json` → engineering, `Pillars/`+`Resources/` → kb, `Streams/` → streams, `eleventy.config.*` → website, `wrangler.*` → website-cloudflare, `@modelcontextprotocol/sdk` dep → mcp, `.claude-plugin/marketplace.json` → plugins, `proposals/`+`specifications/`+`schemas/` → specifications, `skills/*/SKILL.md` → skills, `agents/**/*.md` → agents, `.chezmoiroot`/`.chezmoidata/`/root-level `dot_*`/`private_*`/`executable_*` file → dotfiles-chezmoi. **Gated**: a repo with no `.ki-config.toml` is never coverage-checked (it takes the `FILES-1` FAIL), so a lookalike is not falsely flagged. This is `repo`'s one cross-table read — **presence only**, never another skill's keys. Silence one signal with `coverage-<skill> = false` under `[ki-repo.checks]` (e.g. `coverage-website = false`). (standard: Coverage cascade)
- **repo-structure cardinality [M]** `` `STRUCT-1` `` A ki-repo declares **at most one** repo-structure table — `[ki-harness]`, `[ki-kb]`, `[ki-website]`, `[ki-mcp]`, `[ki-plugins]`, `[ki-specifications]`, `[ki-tools]`, `[ki-homebrew-tap]`, `[ki-dotfiles-chezmoi]` — since exactly one skill governs a repo's on-disk shape ([ADR-KI-HARNESS-SKILLS-006](../../../../docs/decisions/ADR-KI-HARNESS-SKILLS-006-skill-taxonomy-and-implication-graph.md)); declaring more than one FAILs. Implied family members (`ki-website-cloudflare`, `ki-kb-streams`) are not distinct structures and are excluded. Bedrock — not overridable. (standard: Coverage cascade)
- **repo-structure presence [M, override↓]** `` `STRUCT-2` `` A ki-repo declaring **zero** repo-structure tables WARNs, prompting a pick from the same set as `STRUCT-1` — most repos have exactly one structural identity, and a silent zero tends to mean nobody declared it rather than that none applies. Overridable: set `structure = false` under `[ki-repo.checks]` for a repo that genuinely has none (e.g. a dotfiles/config repo not otherwise structured). (standard: Coverage cascade)

## Vendor integrity & access (local disk / `gh` reachability)

- **vendor-integrity [M]** `` `VENDOR-1` `` a repo carrying `.ki-meta/` also carries `.ki-meta/manifest.json`, and every manifest-listed vendored file's sha256 matches what's on disk (ADR-KI-HARNESS-006) — offline, no network required. Missing manifest is a migration WARN; a missing or mismatched file is FAIL. (standard: vendor-integrity)
- **capability-complete [M]** `` `CAPABILITY-COMPLETE` `` every declared `ki-*` root has regular, manifest-listed local payloads for EDUCATE (`.ki-meta/educators/<skill>/educate.ts`), AUDIT, and CONFORM (`.ki-meta/checkers/<skill>/scripts/{audit,conform}.ts`). The check reads only table presence, never another skill's settings; it is offline-safe and FAILs a missing, unsafe, or incomplete capability set. Process skills and the bootstrap chain-starter stay globally installed and must not be declared. Repair the governance source and re-run `./.ki-meta/bin/ki-educate`, or remove the non-governance table. (standard: capability publication)
- **access [M]** `` `ACCESS-1` `` the repo is reachable — `gh` is authenticated and the nameWithOwner resolves — and, when reachable, is not archived (an archived repo skips remaining checks with a WARN rather than cascading FAILs). Unreachable/unauthenticated is reported NA, not FAIL, so an offline or unauthenticated run doesn't manufacture false drift. (standard: Layer 2 preconditions)
- **target-runtimes [M, warn]** `` `RUNTIMES-1` `` if `[ki-repo]` declares `target_runtimes`, every entry is a runtime the bootstrap linkers recognise (`claude-code`, `codex`), and the list is non-empty. An unknown name has no discovery path — the linker would silently install nothing for it — and an empty list would target no runtime at all; either WARNs. The key is **absent-safe**: omitting it takes the `["claude-code"]` default, which is not flagged. Local `.ki-config.toml` read, offline-safe (beside vendor-integrity); like `VENDOR-1` it is detect-only — the intended runtime can't be guessed, so there is no `conform.ts` twin. (standard: `[ki-repo]` table — `target_runtimes`)

- **LINK-1 [J]** Repository-local command links, when deliberately selected for local development, are made only by `link-repository-commands.ts --development` from an active harness checkout. Normal user installation and repository bootstrap use regular-file copies. The command must remain self-contained under `ki-repo/scripts/`, with no imports that step outside its owning skill. (standard: Repository-local development links)

## Judgment (not deterministic — apply by reading)

- **FILES-J1 [J]** — README and license content: `README.md` and `LICENSE` content is accurate and current for the repo — presence is `FILES-1`; content is irreducible judgment. (Layer 1)
- **DESCFIT-1 [J]** — Description fit: the description actually _describes the repo's purpose_ — readable, accurate, one sentence. The script checks non-emptiness and sync with `package.json` (`GH-3`); whether it _fits the purpose_ is the irreducible judgment left here. (Layer 2)
- **RUNTIMES-J1 [J]** — Runtime orientation split: when `target_runtimes` names a runtime other than `claude-code`, root orientation should live in a literal `AGENTS.md` with `CLAUDE.md` `@AGENTS.md`-importing it, rather than restating orientation in both files or leaving `CLAUDE.md` as the only copy a non-Claude-Code runtime can't read. Judgment, not mechanical — a repo may have a legitimate reason to skip the split (e.g. it targets `codex` only nominally and has no real Codex sessions). (standard: `[ki-repo]` table — `target_runtimes`)
- **OVR-J1 [J]** — Override rationale: each boolean under `[ki-repo.checks]` flips an overridable check for that repo (the script prints it as a `note`, citing that check's own code). **[J]** part: confirm each override is a genuine, warranted per-repo decision (e.g. a public repo that deliberately keeps a Wiki, or one that protects `main`), not a way to wave off real drift. (standard: Per-repo overrides)
- **SYNC-1 [J]** — Standard synchronisation: this rubric, [the standard](standards.md), and the script's constants agree. When the standard moves, all three move together (REFRESH).
