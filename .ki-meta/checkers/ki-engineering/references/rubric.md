# Audit rubric — the common engineering layer

Line-by-line criteria for auditing a Knowledge Islands TS/Bun repo against [the engineering standard](standards.md). Each is tagged **[M] mechanical** (enforced by [`../scripts/audit.ts`](../scripts/audit.ts) — capture its output, don't re-derive) or **[J] judgment** (assess by reading). Run the checker first, then apply the judgment items. Severity: **FAIL** (ship-stopper) · **WARN** (should-fix divergence) · **POLISH** (minor / cosmetic) — the shared ladder, defined in `ki-engineering`'s [`enforcement-framework.md`](enforcement-framework.md) §2.

Each criterion carries a **stable code** (`PKG-*`, `MISE-*`, `CI-*`, `SCR-*`, `DEPS-*`, `TSC-*`, `BIO-*`, `SYNC-*`, `KNIP-*`, `GEN-*`, `TEST-*`, `BUILD-*`, `ENV-*`, `TOML-*`, `BUN-*`). `audit.ts` and `conform.ts` stamp every finding with its code plus a `(standards.md)` reference pointer, so a finding cites the exact criterion it enforces. Codes are append-only — never renumber or reuse. `[M]` codes appear in the checker; `[J]` codes are judgment-only and live here alone.

Capability conditionals only apply when the repo has the marker (tests / compiled build / env / CLI); a repo without the capability is not graded on it, and the checker reports it as N/A, not a failure.

## Contents

- [Core — package.json & toolchain pinning (§1)](#core--packagejson--toolchain-pinning-1)
- [Core — governed script surface (§2)](#core--governed-script-surface-2)
- [Core — Bun vs Node (§3)](#core--bun-vs-node-3)
- [Core — tsconfig.json (§4)](#core--tsconfigjson-4)
- [Core — biome.json & prettier config (§5)](#core--biomejson--prettier-config-5)
- [Capability: tests (§6)](#capability-tests-6--marker-a-bare-test-script-or-recognised-root-vitestconfig)
- [Capability: compiled build & CLI (§7)](#capability-compiled-build--cli-7--marker-tsconfigbuildjson-or-a-tsc-build)
- [Capability: env config (§8)](#capability-env-config-8--marker-envexample-or-processloadenvfile)
- [Core — .ki-config.toml (§9)](#core--ki-configtoml-9)
- [Reporting](#reporting)

## Core — package.json & toolchain pinning (§1)

- [ ] **PKG-1** [M] WARN — `"type": "module"`.
- [ ] **PKG-2** [M] WARN — `"packageManager"` starts with `bun@` (pinned patch).
- [ ] **PKG-3** [M] WARN — `"engines.node"` floor is `>= 22`.
- [ ] **PKG-4** [M] FAIL — **coverage manifest (exhaustive)**: every top-level `package.json` key is in the manifest (§1) — `name`, `version`, `description`, `author`, `license`, `private`, `repository`, `homepage`, `bugs`, `keywords`, `type`, `packageManager`, `engines`, `scripts`, `devDependencies`, `dependencies`, `workspaces`, `lint-staged`, `main`, `bin`, `exports`, `files`. An unknown key is drift. (Also the code for an unparseable `package.json`.)
- [ ] **PKG-5** [M] FAIL — toolchain `devDependencies` present: `@biomejs/biome`, `knip`, `prettier`, `husky`, `lint-staged`, `markdownlint-cli2`, `syncpack`, `typescript` (the tools the engineering and authoring modes invoke — declared, not implied). `depcheck` / `node-jq` are gone (replaced by knip).
- [ ] **PKG-6** [M] FAIL/WARN — `lint-staged` block present (FAIL if missing) and fans out to `@biomejs/biome` on code + `prettier` + `markdownlint-cli2 --no-globs` on staged Markdown only (WARN otherwise).
- [ ] **MISE-1** [M] WARN — a root `mise.toml` pins both `node` and `bun` under `[tools]`.
- [ ] **MISE-2** [M] WARN — the `mise.toml` `bun` version **equals** the `packageManager` Bun version (the drift pair).
- [ ] **MISE-3** [M] POLISH — no legacy single-tool pin file (`.node-version`, `.nvmrc`, `.bun-version`) lingers beside `mise.toml` (warn).
- [ ] **CI-1** [M] WARN — where the repo has `.github/workflows/ci.yml`, it installs the toolchain via `jdx/mise-action` and hardcodes no `bun-version:` / `node-version:`.
- [ ] **CI-2** [M] FAIL/WARN — that `ci.yml` runs the exact aggregate read-only gate `bun run ki:audit`, followed by the exact `bun run test` command when the repo exposes tests (missing or misordered gate → FAIL), and no longer references the retired `ki:verify` (WARN; ADR-KI-HARNESS-TOOLCHAIN-001). `ki:audit` fans out over the vendored per-skill audits (engineering's code toolchain + authoring's Markdown gate).

## Core — governed script surface (§2)

> **TOOLCHAIN-001 note.** The per-tool `ki:lint:*` / `ki:deps:*` / `ki:knip` families and `ki:verify` are **retired** — the tools now run **directly inside** `ki:engineering:audit`/`conform` (Biome, tsc, syncpack, knip; see BIO-1 / TSC-1 / SYNC-1 / KNIP-2 below), and the repo exposes only the two aggregate entrypoints. Those retired keys are now flagged as drift (SCR-3), not required.

- [ ] **SCR-1** [M] FAIL — **the `ki:` naming law (exhaustive)**: every `scripts` entry is one of the six bare lifecycle idioms (`build`, `prepare`, `test`, `test:coverage`, `test:watch`, `clean`) **or** carries the `ki:` prefix. A bare non-idiom name is drift.
- [ ] **SCR-2** [M] FAIL — both aggregate entrypoints are present: `ki:audit` (read-only gate) and `ki:conform` (write pass), each fanning out over the vendored per-skill modes in `.ki-meta`.
- [ ] **SCR-3** [M] FAIL — no retired keys linger: the `ki:lint:*` / `ki:deps:*` / `ki:knip` families, `ki:verify`, and any per-skill `ki:<skill>:lint` are folded into `ki:engineering:audit`/`conform` + the aggregate `ki:audit` (TOOLCHAIN-001) — their presence is drift.
- [ ] **SCR-4** [M] FAIL — every checker payload vendored into `.ki-meta/checkers/<skill>/` is reachable by the derived keys `ki:<suffix>:audit` / `ki:<suffix>:conform` (suffix = skill dir minus `ki-`).
- [ ] **SCR-5** [M] FAIL/WARN — `clean` removes `node_modules` (FAIL otherwise) and `prepare` = `husky` (WARN otherwise); `clean` also removes `dist` where the repo builds.
- [ ] **SCR-7** [M] FAIL — a repo with tests exposes the runner-neutral bare `test` idiom. Compiled repos expose bare `build`; neither lifecycle command is appended to the canonical aggregate entrypoints.
- [ ] **BIO-1** [M] FAIL — `bunx @biomejs/biome check` exits clean (the read-only Biome pass, run directly by `ki:engineering:audit`).
- [ ] **TSC-1** [M] FAIL — the type-check exits clean: `tsc --noEmit` at the root, or per-workspace `tsc --noEmit -p <ws>/tsconfig.json` when `package.json` declares a `workspaces` array (each listed workspace must have a `tsconfig.json`).
- [ ] **SYNC-1** [M] FAIL — `bunx syncpack format --check` exits clean (dependency-range / package.json field ordering).
- [ ] **KNIP-2** [M] FAIL — `bunx knip` exits clean (the dependency + dead-code gate, run directly by `ki:engineering:audit`).
- [ ] **DEPS-1** [M] ADVISORY — `bun outdated` reports no available updates; if any, review and run `bun run ki:engineering:conform`.
- [ ] **SCR-8** [J] POLISH — repo-specific scripts beyond the aggregate/scoped governance surface are fine when an owning skill governs them; the checker must not flag them. Confirm none shadow a governed entrypoint with a divergent definition.

## Core — Bun vs Node (§3)

- [ ] **SCR-6** [M] FAIL — **no script value contains `bun test`**: it bypasses the governed package script and invokes Bun's runner; use `bun run test`.
- [ ] **BUN-1** [J] WARN — where the repo loads `.env`, `loadConfig` (or equivalent) calls `process.loadEnvFile()` in a try/catch for Node parity.

## Core — tsconfig.json (§4)

- [ ] **TSC-2** [M] FAIL — `tsconfig.json` present and carries the universal invariants (`strict`, `module`/`moduleResolution` nodenext, `noEmit`, `isolatedModules`, `esModuleInterop`, `skipLibCheck`). The richer shared base (es2024 target/lib, the `noUnused*`/`noImplicit*`/`noFallthrough*` family, `verbatimModuleSyntax`) is graded under the compiled-build profile as BUILD-3.
- [ ] **TSC-3** [J] WARN — no per-repo loosening of `strict` or the `noUnused*`/`noImplicit*` flags.

## Core — biome.json & prettier config (§5)

- [ ] **BIO-2** [M] FAIL/WARN — `biome.json` present (FAIL if missing) and matches the shared config field-set (formatter 2-space / lineWidth 140; JS single quotes, `semicolons: asNeeded`, no trailing commas; `preset: recommended` with `noExplicitAny: off`; `organizeImports: on`) — each mismatched field is a WARN.
- [ ] **KNIP-1** [M] FAIL — `knip.json` present (per-repo entry points + ignores; backs the knip check — KNIP-2 — inside `ki:engineering:audit`). See §5.
- [ ] **GEN-1** [M] FAIL/NA — when a known generated/vendored surface exists (`.ki-meta/`, `src/generated/`, `.claude/skills/`, `.claude/agents/`, `.agents/skills/`), it has matching Biome, knip, and Markdown exclusions. No such surface → N/A. `ki-authoring` owns the Markdown configuration; this criterion checks that it agrees with the engineering exclusions.
- [ ] _(prettier)_ — `.prettierrc.json` is **owned by `ki-authoring`** (it backs that skill's own Markdown conform pass), so its presence/shape (`proseWrap: never`, `printWidth: 140`, `semi: false`, `singleQuote: true`, `trailingComma: none`, `*.md` override) is graded there — not by this checker (SHAPE-16 ownership split).

## Capability: tests (§6) — marker: a bare `test` script or recognised root `vitest.config.*`

> Executable helper scripts (`scripts/`, eval harnesses, a skill's bundled `audit-*.ts` / `lint-*.ts` checkers) are tooling, not shipped `src/` — Vitest coverage is scoped to source and never governs them. They may expose standalone self-tests through the bare `test` idiom without carrying `vitest.config.*`; the Vitest key-shape and 100% thresholds then do not apply. (§6)

- [ ] **TEST-1** [M] INFO/WARN/FAIL — every test-capable repo exposes a bare `test` script. A runner-neutral bare test without `vitest.config.*` is INFO and the Vitest rules below do not apply. A recognised root `vitest.config.*` opts the repo into the Vitest profile: `test` = `vitest run`; `test:coverage` = `vitest run --coverage`; `test:watch` = `vitest` (missing companion script → WARN, wrong value → FAIL). No test capability is N/A.
- [ ] **TEST-2** [M] FAIL — under the Vitest profile, coverage thresholds are **100%** on all four metrics (lines/functions/branches/statements).
- [ ] **TEST-3** [M] WARN — under the Vitest profile, coverage `exclude` drops `src/**/*.test.ts`. (The _additional_ excludes are artifact-specific — not graded here; the artifact skill grades them.)
- [ ] **TEST-4** [M] WARN — under the Vitest profile, the **monorepo exception (§0)** applies: when `package.json` declares a `workspaces` array, `include`/`exclude` and `reportsDirectory` are workspace-scoped (e.g. `include: ['site/scripts/**/*.test.ts']`, `reportsDirectory: 'site/coverage'`) rather than the flat `src/**` / root `coverage/`.
- [ ] **TEST-5** [M] FAIL — under the Vitest profile, `bun run test:coverage` exits clean when that companion script is present (the suite passes and meets the thresholds).
- [ ] **TEST-6** [J] WARN — under the Vitest profile, tests are co-located with the source they cover (`src/**/*.test.ts` in the flat shape; under the owning workspace, e.g. `site/scripts/**/*.test.ts`, in a monorepo) and actually reach the 100% bar.

## Capability: compiled build & CLI (§7) — marker: `tsconfig.build.json` or a `tsc` build

- [ ] **BUILD-1** [M] FAIL — `build` = `tsc -p tsconfig.build.json` (optionally `&& chmod …`); `files` includes `dist`. **Monorepo exception (§0):** in a `workspaces` repo the compiled output and its `files`/`clean`/`.gitignore` references are workspace-scoped (`site/dist`), not a root `dist/`. (Also the code for the N/A when the repo has no compiled build.)
- [ ] **BUILD-2** [M] WARN — `tsconfig.build.json` extends the base and sets `noEmit:false`, `declaration` + `declarationMap`, `outDir`/`rootDir`, `allowImportingTsExtensions:false`, `noUncheckedIndexedAccess:true`, excludes `**/*.test.ts`.
- [ ] **BUILD-3** [M] WARN — the richer shared `tsconfig.json` base is set (target es2024, `verbatimModuleSyntax`, `noUnusedLocals`) — graded under the compiled-build profile, WARN not FAIL.
- [ ] **BUILD-4** [M] FAIL/WARN — **CLI chmod rule**: `build` chmods `dist/cli/cli.js` **iff** `src/cli/` exists; it chmods **no other path** (in particular not a server/mcp-server bin). No dangling chmod (FAIL), no missing chmod (WARN).

## Capability: env config (§8) — marker: `.env*.example` or `process.loadEnvFile`

- [ ] **ENV-1** [M] WARN — a committed `.env*.example` template exists. (Also the code for the N/A when the repo has no env capability.)
- [ ] **ENV-2** [M] FAIL — `NODE_ENV=development` appears only in dev/inspect scripts, never in `start`/`build`/`test`.
- [ ] **ENV-3** [J] WARN — real `.env.*` (non-`.example`) is gitignored; the loader has the Node parity call.
- [ ] **ENV-4** [J] WARN — any script resolving a config/data/cache/state directory honours the matching `$XDG_*` env var, falling back to the spec default only when unset (standards.md's XDG Base Directory paths subsection). A hardcoded `~/.config`/`~/.local/share`/etc with no env-var check is the finding.

## Core — `.ki-config.toml` (§9)

- [ ] **TOML-1** [M] WARN — a `[ki-engineering]` table is present (the selector for this layer).
- [ ] **TOML-2** [M] WARN — every key under it is one the checker knows (validate-down); an unknown key is drift.

## Reporting

Produce findings grouped by severity, each row `severity · file:line-or-field · what · fix`. Lead with any **FAIL** (a `bun test`, a sub-100% coverage threshold). Close with a one-line verdict (compliant / minor drift / blockers) and name the **artifact-skill audit that must also run** for the repo to be fully clean (e.g. "+ `audit.ts` for the MCP delta").
