# Audit Rubric

Line-by-line pass/fail items for auditing a workspace MCP against the [Workspace MCP Standard](standards.md). Run [`../scripts/audit.ts`](../scripts/audit.ts) for the mechanical items (marked **[M]**), then judge the rest by reading the code.

Every **[M]** item carries a stable `PREFIX-N` code (per `ki-skills`' SHAPE-9 + the checker-contract); the checker emits that code as each finding's `area`, and `conform.ts` uses the same code for its twin action. Judgment **[J]** items are applied by reading and are not emitted, so they carry no code. Severity uses the shared ladder, defined in `ki-engineering`'s [`enforcement-framework.md`](../../../foundations/ki-engineering/references/enforcement-framework.md) §2: **FAIL** (security invariant breach or gate bypass — ship-stopper), **WARN** (layout / naming / tooling divergence), **POLISH** (docs / consistency).

Applicability: `[ki-mcp]` or `src/mcp-server/` activates the complete audit. With neither, **`KI-CONFIG` [M]** emits exactly one `NA` and stops; a declaration or structural marker must never suppress the existing findings below. ([standard](standards.md#applicability))

- **KI-CONFIG [M]** — Applicability gate: without `[ki-mcp]` or `src/mcp-server/`, emit exactly one `NA` finding and stop. ([standard](standards.md#applicability))

## Contents

- [Layout & layers](#layout--layers)
- [Config injection](#config-injection)
- [Tool naming & surface](#tool-naming--surface)
- [Access-level gate](#access-level-gate)
- [Audit logging](#audit-logging)
- [Security invariants](#security-invariants)
- [Spec conformance — tool results & metadata](#spec-conformance--tool-results--metadata-standard-12)
- [OAuth security — auth-server repos only](#oauth-security--auth-server-repos-only-mcp-gsuite-mcp-m365-standard-13)
- [Bun vs Node](#bun-vs-node)
- [package.json](#packagejson)
- [tsconfig / vitest / biome](#tsconfig--vitest--biome)
- [.env.example & env](#envexample--env)
- [Docs](#docs)
- [Longevity & staleness](#longevity--staleness-mirrors-ki-skills-rubric-long-1)
- [Reporting](#reporting)

## Layout & layers

- [ ] [M] WARN — `LAY-1`: `src/` has `config/`, `mcp-server/`, `tools/`, `main/`, `utils/`. (references/standards.md)
- [ ] [M] WARN — `LAY-1`: `cli/` present ⇒ has both `cli.ts` and `index.ts`. (references/standards.md)
- [ ] [J] WARN — `tools/<group>/index.ts` is thin: zod-validate → call `main/` → envelope. No FS/network/git/logic in a tool handler.
- [ ] [J] WARN — all real logic lives in `main/`, grouped by concern, each with `index.ts`.
- [ ] [J] FAIL — `main/`/`utils/` have **no `console.*`** (return data; printing is CLI/stderr only). `api`-style layers assert no `console.log` in tests.
- [ ] [J] WARN — `cli.ts` holds only arg-parsing + printing; the library it calls (`main/`) is the single source of truth, shared with `tools/`.
- [ ] [J] WARN — no logic that exists _only_ in a tool handler or _only_ in `cli.ts`.

## Config injection

- [ ] [J] FAIL — `loadConfig(env?)` is the only reader of env; **no module-level config singleton**; no top-level `process.env` access outside `config/index.ts`. (`grep -rn "process.env" src --include=*.ts | grep -v config/`)
- [ ] [J] FAIL — every `main/`/`utils/` entry point takes config (or its slice) as the **first argument**; nothing reaches for ambient state.
- [ ] [M] WARN — `CFG-1`: `config/index.ts` exports `AccessLevel`, `ACCESS_LEVELS`, `ACCESS_LEVEL_RANK`, `AuditLogMode`, `loadConfig`. (references/standards.md)
- [ ] [J] WARN — `Config` has `accessLevel`, `auditLogMode`, `auditLogPath`, `auditLogMaxBytes`, `auditLogKeep` + domain fields.
- [ ] [J] WARN — tests build a literal `Config`; none call `loadConfig()` or mutate env.

## Tool naming & surface

- [ ] [M] WARN — `TOOL-1`: every registered tool matches `<app>_<resource>_<action>` with the repo's `<app>` prefix. (`grep -rn registerTool src/tools`) (references/standards.md)
- [ ] [J] WARN — plural resource for collection ops, singular for single-item ops.
- [ ] [J] POLISH — CLI verbs mirror the tool names/resources.
- [ ] [J] POLISH — README tool catalog lists every registered tool with I/O shape.

## Access-level gate

- [ ] [J] FAIL — `mcp-server` sets `server.registerTool = makeAccessGatedRegister(...)`; nothing registers a tool bypassing the proxy.
- [ ] [J] FAIL — every tool sets `annotations` to a preset from `utils/annotations.ts` (no unannotated/partially-annotated tools).
- [ ] [J] FAIL — destructive & non-idempotent tools default `dry_run: true`, mutate only when explicitly `false`.
- [ ] [J] WARN — default `MCP_<APP>_ACCESS_LEVEL` is `read` (allowed exception: `kb-notion-mirror` defaults to `write` — do not flag).

## Audit logging

- [ ] [M] WARN — `UTIL-1`: `utils/audit-log.ts` exports `AuditConfig`, `appendAuditEvent`, `withAuditLog`. (references/standards.md)
- [ ] [J] FAIL — no secret (token/PAT/Bearer) is ever written to the audit log or surfaced in an error; only ids/arg-shapes/status.
- [ ] [J] FAIL — tool boundary returns errors via `errorResult` (not `throw`) so the audit wrapper sees the `isError` envelope.

## Security invariants

- [ ] [J] FAIL — every user path runs through the two-layer guard (lexical + realpath) before any `fs.*`/`execFile`/URL call, against the **full** root set.
- [ ] [J] FAIL — cached/prior-result paths are re-validated against live config.
- [ ] [J] FAIL — subprocess via `execFile`(argv), never a shell string; git carries `--no-optional-locks`.
- [ ] [J] FAIL — subprocess calls are timeout- and `maxBuffer`-bounded; network git sets `GIT_TERMINAL_PROMPT=0`. No unbounded spawn.
- [ ] [J] FAIL — directory walks are depth-limited and prune hidden dirs/`node_modules`.
- [ ] [J] FAIL — identifier inputs (names, urls, ids, path segments) use tightened regex schemas rejecting leading `-`, `..`, separators — not bare `z.string()`.
- [ ] [J] FAIL — risky multi-state options are enums, not booleans.
- [ ] [J] WARN — all zod schemas `.strict()` with bounded numerics / length caps.
- [ ] [J] WARN — batch tools aggregate per-item failures into `errors[]` (no crash).
- [ ] [J] WARN — tools sanitize untrusted output before returning it (spec: "Servers MUST sanitize tool outputs"); e.g. m365's `html-sanitizer.ts`. Rate-limiting is a spec MUST but low-priority for local stdio servers — note, don't block.

## Spec conformance — tool results & metadata (standard §12)

- [ ] [J] FAIL — tool boundary returns errors as `isError: true` envelopes via `errorResult`, never `throw` (spec 2025-11-25: validation/API/logic errors are Tool Execution Errors, not protocol errors; a throw also bypasses the audit wrapper). Same item as audit-logging below — verify once.
- [ ] [M] WARN — `TOOL-1`: any tool returning `structuredContent` also declares a matching `outputSchema` at registration (paired, ideally derived from one zod schema via `zod-to-json-schema`). A `jsonResult` emitting `structuredContent` with no declared schema is a WARN finding. (references/standards.md)
- [ ] [M] WARN — `TOOL-1`: any repo whose tools return structured JSON (via `jsonResult` or otherwise) but has zero `outputSchema` declarations anywhere in `src/tools/` is a WARN finding — structured-output adoption is a house SHOULD (spec 2025-11-25), not optional. (references/standards.md)
- [ ] [M] WARN — `TOOL-1`: tool registration order within each `tools/<group>/index.ts` is stable and deterministic (e.g. alphabetical by tool name or consistent CRUD order). Nondeterministic ordering hurts prompt-cache hit rates. (references/standards.md)
- [ ] [J] POLISH — optional spec metadata (`icons`, `title`, `execution.taskSupport`) is per-repo opt-in, not required — do **not** flag its absence.

## OAuth security — auth-server repos only: mcp-gsuite, mcp-m365 (standard §13)

Skip this whole section for the filesystem/subprocess repos.

- [ ] [J] FAIL — no token passthrough: server never accepts/forwards a caller-supplied token; it uses tokens issued to itself for the downstream API.
- [ ] [J] FAIL — auth-code flow uses PKCE and a cryptographically random, server-stored, single-use `state` validated by exact match at the callback.
- [ ] [J] FAIL — `redirect_uri` validated by exact string match (loopback), not prefix/wildcard.
- [ ] [J] FAIL — tokens stored with restrictive perms outside any served root; never logged; redacted from audit log + errors.
- [ ] [J] WARN — least-privilege scopes (only what shipped tools need); SSRF discipline on fetched URLs (HTTPS, host-pinned, no redirect to internal/loopback IPs).
- [ ] [J] WARN — _Remote resource-server role only — N/A to today's stdio repos; skip unless a server is deployed as a remote HTTP resource server._ RFC 8707 `resource` parameter bound into the token `aud`, and `aud` validated against the server's canonical URI before a token is accepted. (AUTH 2025-11-25; standard §13 item 7)
- [ ] [J] WARN — _Authorization-server role only — N/A to today's stdio repos; skip unless a workspace component acts as an MCP authorization server._ Client ID Metadata Documents — AS declares `client_id_metadata_document_supported: true` and handles URL-formatted `client_id` (HTTPS fetch, exact `client_id` match, `redirect_uris` validation, SSRF mitigations). (AUTH 2025-11-25, SHOULD; standard §13 item 8)

> **Common toolchain → `ki-engineering`.** The four sections below cover only the **MCP delta**. The generic toolchain — aggregate/scoped audit wiring, direct code-tool checks, the `bun test` trap, `tsconfig`/`biome`, config-gated Vitest, the `.env*.example` template, and the build/cli-chmod rule — is the common engineering layer; **run `ki:engineering:audit` first** for it. A repo is fully clean only when both audits pass.

## Bun vs Node

- [ ] — the `bun test` trap, `process.loadEnvFile()` parity, and `NODE_ENV`-only-in-dev are the **common engineering layer** (run `ki:engineering:audit`); not re-checked here. MCP consequence: production ignores `.env.*`, so config comes from the client's `env` block.

## package.json

- [ ] [M] WARN — `PKG-1`: `main:dist/mcp-server/index.js`; `bin.mcp-<name>` → `dist/mcp-server/index.js` (+ CLI/auth bin where applicable). (references/standards.md)
- [ ] [M] WARN — `PKG-1`: `exports` has `.`, `./config`, `./package.json` + one per reusable `main/<concern>`. (references/standards.md)
- [ ] [M] WARN — `SCR-1`: `ki:server:mcp:dev` / `ki:server:mcp:inspect` / `ki:server:mcp:start` present. (references/standards.md)
- [ ] [M] FAIL — `SCR-1`: `ki:generate:client` script present (the mcporter typed-client codegen — required for every MCP). (references/standards.md)
- [ ] [M] FAIL — `SCR-1`: where `src/auth-server/` exists, the `ki:server:auth:dev` / `ki:server:auth:start` pair is present (the OAuth delta). (references/standards.md)
- [ ] [M] WARN — `SCR-1`: `ki:test:record` and `ki:test:replay` are defined together, or neither (the mcporter record/replay harness). (references/standards.md)
- [ ] [M] WARN — `CI-1`: where the repo has a `ki:test:smoke` harness, `.github/workflows/ci.yml` includes `bun run ki:test:smoke` alongside the common aggregate `ki:audit` and runner-neutral `test` gate. The common CI shape is `ki-engineering`'s (`ki:engineering:audit`); the smoke step is the MCP delta. (references/standards.md)
- [ ] [M] FAIL — `CI-2`: where a `ki:test:smoke` script is defined, `bun run ki:test:smoke` runs green (the smoke harness executes, not merely wired into CI). (references/standards.md)
- [ ] [J] WARN — `src/generated/client.ts` is committed and not stale (the `ki:generate:client` presence itself is `[M]` above). `conform.ts` regenerates it automatically whenever the script is defined (no daemon needed — `mcporter emit-ts` spawns its own ephemeral process), so staleness should only surface between a tool-surface change and the next CONFORM run. If `conform.ts` reports the regen failed (server not registered, `dist/` stale), fix that first, then re-run `bun run ki:generate:client` by hand. The `<server-name>` argument in the script must match a registered mcporter instance — verify with `mcporter list`.
- [ ] — `type`/`packageManager`/`engines`/`files`, aggregate/scoped audit wiring, lifecycle scripts, and the build/cli-chmod rule are the **common engineering layer** (`ki:engineering:audit`); not re-checked here.

## tsconfig / vitest / biome

- [ ] [M] WARN — `TEST-1`: when the repository carries `vitest.config.*`, coverage `exclude` covers the MCP wiring layers: `mcp-server/index.ts`, `tools/**/index.ts`, `utils/annotations.ts`, `src/generated/**`, and any printing/pure-data module (`cli/cli.ts`, `auth-server/**`). Without a Vitest config this criterion is not applicable. (references/standards.md)
- [ ] — `tsconfig.json` / `tsconfig.build.json` / `biome.json` shape and, when configured, the Vitest 100% thresholds are the **common engineering layer** (`ki:engineering:audit`); not re-checked here.

## .env.example & env

- [ ] [M] WARN — `ENV-1`: `.env.example` uses the `MCP_<APP>_*` prefix and carries the shared access-level + audit-log block. (references/standards.md)
- [ ] — the committed `.env*.example` template, gitignored real `.env.*`, and the `process.loadEnvFile` parity call are the **common engineering layer** (`ki:engineering:audit`).

## Docs

- [ ] [M] WARN — `DOC-1`: `ROADMAP.md` present. (roadmap-md)
- [ ] [M] WARN — `DOC-1`: `CONTRIBUTING.md` and `SECURITY.md` present; `CHANGELOG.md` present **and non-empty** (an empty stub is a finding) — the MCP-family root docs. `README`, `LICENSE`, `.gitignore`, `.editorconfig`, `.ki-config.toml`, and now `CLAUDE.md` (FAIL) are `ki-repo`'s layers, not re-checked here.
- [ ] [J] WARN — `CLAUDE.md` is **not drifted**: every layer/path/concept it names still exists in the code (catch renamed/moved layers).
- [ ] [J] POLISH — README install/config/client-setup steps are current.

## Longevity & staleness (mirrors `ki-skills` rubric LONG-1)

A server installed and left running drifts from the world around it; the audit checks it can't rot silently.

- [ ] [J] WARN — volatile external facts the code depends on (the MCP spec version/date it targets, upstream API/SDK versions, third-party URLs, model IDs) are not scattered hard-coded literals: each is either resolved at runtime or pinned in **one** refreshable place (`config/`, `CLAUDE.md`, or `package.json`) so a bump is a single known edit, not a hunt.
- [ ] [J] POLISH — the repo's `CLAUDE.md`/`README.md` names the spec version it conforms to, so a reviewer can tell at a glance whether it predates a spec move.
- [ ] [J] POLISH — this audit itself is run against a **current** standard: if a finding cites a spec MUST, the skill's Mode REFRESH + [`sources.md`](sources.md) confirm the spec hasn't moved since the standard's `last reviewed` date. Don't green-light a repo against a stale spec.

## Reporting

Produce a findings table grouped by severity, each row: `severity · file:line · what · fix`. Close with: (a) any intentional, documented divergences you chose **not** to flag, and (b) a one-line verdict (compliant / minor drift / blockers).
