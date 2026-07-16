#!/usr/bin/env bun
/**
 * Mechanical auditor for the Knowledge Islands repo standard.
 *
 *   bun scripts/audit.ts [tree-path]   # default: cwd — enumerate repos from a tree
 *   bun scripts/audit.ts --org <org>   # enumerate every repo in a GitHub org
 *
 * Everything is checked **against GitHub** (no working checkout needed): file
 * presence via the git-tree API, settings via `gh repo view`, security/Actions via
 * `gh api`. The tree path / `--org` only decide *which* repos to look at — local-tree
 * mode reads each dir's `origin` and audits the github.com ones under their real
 * GitHub identity; `--org` lists the org (and so catches repos not cloned locally).
 *
 * The standard has three layers (see references/repo-standard.md):
 *   1. FILES   — README, LICENSE, .gitignore, and .ki-config.toml
 *                (the repo's declared config), all present on the default branch.
 *                .ki-config.toml is also the GATE of the coverage cascade: once a
 *                repo is confirmed a ki-repo by carrying it, each other governance
 *                skill whose applicability is detectable in the repo (a Streams/
 *                zone, an eleventy.config, an MCP SDK dep, …) must DECLARE its
 *                `[ki-<skill>]` opt-in table — detected-but-undeclared
 *                WARNs. A non-ki-repo is never coverage-checked (no false positives).
 *   2. GITHUB  — default branch, license, squash-only + linear, auto-delete-branch,
 *                Issues on / Wiki+Projects off, non-empty description, visibility
 *                (matches the value DECLARED in .ki-config.toml — not the name),
 *                and (public) the standard topic set. `main` is open by default;
 *                branch protection is an overridable check (.ki-config.toml checks).
 *   3. DEEPER  — Dependabot alerts + security updates; "always suggest updating PR
 *                branches" (allow_update_branch); secret scanning + push protection
 *                (public); Actions allowed-actions = all.
 *
 * Each repo's `.ki-config.toml` declares its `visibility` and, in a
 * `[ki-repo.checks]` sub-table, per-repo overrides — one
 * boolean per overridable check (`true` = enforce, `false` = don't). A check it
 * omits takes the org default (CHECK_DEFAULTS), so a fully-conforming repo writes
 * no overrides; `branch-protection` defaults off, so `main` is open unless opted in.
 *
 * READ-ONLY: never mutates a repo. Bringing outliers into line is the skill's APPLY
 * mode. The one remaining judgment item the script can't make — does the description
 * actually match the repo's purpose — is left to the skill's AUDIT mode; that it is
 * SYNCED with package.json is now checked mechanically (description-sync).
 *
 * Requires `gh` authenticated against the org. No npm dependencies — Bun/Node only.
 * Exit code is non-zero if any repo has a FAIL.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// ── the standard (keep in sync with references/repo-standard.md) ──────
const DEFAULT_BRANCH = 'main'
// The declared license defaults to MIT when `[ki-repo] license` is unset. Decoupled
// from visibility (a private repo may be MIT; a public repo may be proprietary).
const DEFAULT_LICENSE = 'MIT'
const TOPICS = ['mcp', 'model-context-protocol', 'claude', 'typescript', 'bun']
const REQUIRED_CHECK = 'build'
const ALLOWED_ACTIONS = 'all'
// Reference-doc pointers carried on every finding (the cited-finding standard): STD is
// the standard each mechanical criterion verifies; RUBRIC is where the judgment criteria
// live. Kept identical to conform.ts so a given criterion cites the same (area, ref) in both.
const STD = 'references/repo-standard.md'
// Overridable checks and the org default for each — `true` = enforced by default.
// A repo overrides any of these per-repo in [ki-repo.checks];
// a check it omits takes the default here, so a fully-conforming repo writes none.
// (The other checks — file presence, default branch, license, description, merge,
// delete-branch, visibility, Dependabot — are bedrock: always enforced, no override.)
// `branch-protection` defaults OFF, so `main` is open unless a repo opts in.
const CHECK_DEFAULTS: Record<string, boolean> = {
  'branch-protection': false, // protect `main` (PR + build check + linear history)
  wiki: true, //                Wiki disabled
  projects: true, //            Projects disabled
  issues: true, //              Issues enabled
  topics: true, //              (public) carries the standard topic set
  'secret-scanning': true, //   (public) secret scanning on
  'push-protection': true, //   (public) secret-scanning push protection on
  structure: true //            declares at least one repo-structure table
}
const KI_CONFIG = '.ki-config.toml'
// Required root files. Each entry is one or more acceptable paths (first found wins).
const REQUIRED_FILES: [id: string, paths: string[]][] = [
  ['readme', ['README.md']],
  ['license-file', ['LICENSE', 'LICENSE.md']],
  ['gitignore', ['.gitignore']],
  ['claude-md', ['CLAUDE.md']],
  ['ki-config', [KI_CONFIG]]
]

const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m' }
const paint = (c: string, s: string): string => `${c}${s}${C.reset}`

// `note` is informational (a per-repo override in effect) — printed, never counted.
// Unified severity ladder — shared by every KI checker (enforcement-framework §2).
type Level = 'FAIL' | 'WARN' | 'POLISH' | 'ADVISORY' | 'INFO' | 'NA' | 'PASS'
const LADDER: Level[] = ['FAIL', 'WARN', 'POLISH', 'ADVISORY', 'INFO', 'NA', 'PASS']
const ICON: Record<Level, string> = { FAIL: '❌', WARN: '⚠️', POLISH: '✨', ADVISORY: '🧭', INFO: 'ℹ️', NA: '🚫', PASS: '✅' }
// Cited-finding shape: `area` is the rubric code (references/audit-rubric.md), `ref` the
// reference-doc pointer (defaults to the standard STD; the rare judgment finding overrides
// it), `file` the in-repo path a file-scoped finding concerns. Arg order (area, msg, file?,
// ref?) puts the often-set `file` before the usually-defaulted `ref`, so most call sites
// stay two-arg. Matches ki-authoring's Finding shape.
type Finding = { level: Level; area: string; msg: string; ref?: string; file?: string }
const mk = () => {
  const f: Finding[] = []
  const push =
    (level: Level) =>
    (area: string, msg: string, file?: string, ref: string = STD): void =>
      void f.push({ level, area, msg, ref, file })
  return {
    f,
    fail: push('FAIL'),
    warn: push('WARN'),
    note: push('INFO'),
    na: push('NA'),
    advisory: push('ADVISORY'),
    polish: push('POLISH')
  }
}

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
}
// gh authentication is a precondition for every GitHub-touching check. In CI there is
// no token (the workflow runs this gate for its offline vendor-integrity value only —
// see ci.yml), so an unauthenticated `gh` must degrade the GitHub checks to a skip, not
// hard-FAIL. Cached: `gh auth status` is one process, and auth does not change mid-run.
let ghAuthedCache: boolean | null = null
function ghAuthed(): boolean {
  if (ghAuthedCache === null) {
    try {
      execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' })
      ghAuthedCache = true
    } catch {
      ghAuthedCache = false
    }
  }
  return ghAuthedCache
}
const ghOk = (apiPath: string): boolean => {
  try {
    gh(['api', apiPath])
    return true
  } catch {
    return false
  }
}
const ghJSON = (apiPath: string): unknown => JSON.parse(gh(['api', apiPath]))
// File content as raw text, or null on 404.
const ghRaw = (nwo: string, path: string): string | null => {
  try {
    return gh(['api', `repos/${nwo}/contents/${path}`, '-H', 'Accept: application/vnd.github.raw'])
  } catch {
    return null
  }
}
// Set of the repo's root-level paths (one call), for presence checks.
function rootPaths(nwo: string, branch: string): Set<string> {
  try {
    const t = ghJSON(`repos/${nwo}/git/trees/${branch}`) as { tree?: { path: string }[] }
    return new Set((t.tree ?? []).map((e) => e.path))
  } catch {
    return new Set()
  }
}

const topicNames = (t: unknown): string[] =>
  Array.isArray(t) ? t.map((x) => (typeof x === 'string' ? x : (x?.name ?? x?.topic?.name))).filter(Boolean) : []

// The repo's parsed package.json (or null if absent / unparseable), fetched once
// and reused for the description-sync check and the MCP-dependency coverage signal.
type Pkg = {
  name?: unknown
  version?: unknown
  description?: unknown
  author?: unknown
  license?: unknown
  private?: unknown
  repository?: unknown
  homepage?: unknown
  bugs?: unknown
  keywords?: unknown
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}
function readPkg(nwo: string, files: Set<string>): Pkg | null {
  if (!files.has('package.json')) return null
  const text = ghRaw(nwo, 'package.json')
  if (text == null) return null
  try {
    return JSON.parse(text) as Pkg
  } catch {
    return null
  }
}
// package.json `description` (the in-repo source of truth the GitHub description must
// be SYNCED with), or null when there is none / it isn't a non-empty string.
const pkgDescription = (pkg: Pkg | null): string | null =>
  typeof pkg?.description === 'string' && pkg.description.trim() ? pkg.description.trim() : null
// Does package.json declare `name` among its dependencies or devDependencies?
const pkgHasDep = (pkg: Pkg | null, name: string): boolean => Boolean(pkg?.dependencies?.[name] ?? pkg?.devDependencies?.[name])

// The repo's full tree (recursive) as a set of paths, for the coverage signals that
// look below the root (`site/wrangler.jsonc`, `skills/*/SKILL.md`, `agents/**/*.md`).
// One API call; empty set on error or truncation. `rootPaths` stays the top-level
// view the file-presence checks use.
function treePaths(nwo: string, branch: string): Set<string> {
  try {
    const t = ghJSON(`repos/${nwo}/git/trees/${branch}?recursive=1`) as { tree?: { path: string }[] }
    return new Set((t.tree ?? []).map((e) => e.path))
  } catch {
    return new Set()
  }
}

// `.ki-config.toml` is a shared per-repo file; each skill reads its own [table].
// This skill owns the [ki-repo] table. The default block
// (written by `--init`) is the authoritative key list — authoring a repo emits it.
const KI_SECTION = 'ki-repo'
const KI_REPO_DEFAULT = `[${KI_SECTION}]
visibility = "private"   # "public" | "private" — must match the repo's actual GitHub visibility
license = "MIT"          # SPDX id the LICENSE, package.json, and GitHub must match; default MIT. Use "UNLICENSED" for proprietary. Pick one at https://choosealicense.com/

# Per-repo check overrides — true = enforce, false = don't. Omit any check to take
# the org default; a repo that fully conforms needs nothing here.
# [${KI_SECTION}.checks]
# branch-protection = true   # default off — protect \`main\` on this repo
# wiki = false               # default on  — allow this repo's Wiki
`

const KI_AUTHORING_DEFAULT = `# The authoring standard (Markdown/TOML house style) is baseline — every KI repo is
# governed by it. Declared explicitly, not assumed; its presence is the compliance marker.
[ki-authoring]
`
const KI_DEFAULT = `${KI_REPO_DEFAULT}\n${KI_AUTHORING_DEFAULT}`

// Parse the owned table with Bun's TOML parser so quoted table keys, comments,
// and multiline strings cannot be mistaken for schema. Returns null when the
// document is invalid or has no object-valued [ki-repo] table.
type KiConfig = { visibility?: string; license?: string; checks: Record<string, boolean> }
const CHECKS_SECTION = `${KI_SECTION}.checks`
const TOML = (globalThis as unknown as { Bun: { TOML: { parse(text: string): unknown } } }).Bun.TOML
function parseKiConfig(text: string): KiConfig | null {
  let document: Record<string, unknown>
  try {
    document = TOML.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
  const value = document[KI_SECTION]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const table = value as Record<string, unknown>
  const out: KiConfig = { checks: {} }
  if (typeof table.visibility === 'string') out.visibility = table.visibility
  if (typeof table.license === 'string') out.license = table.license
  if (table.checks && typeof table.checks === 'object' && !Array.isArray(table.checks)) {
    for (const [key, check] of Object.entries(table.checks as Record<string, unknown>)) {
      if (typeof check === 'boolean') out.checks[key] = check
    }
  }
  return out
}

type Repo = {
  nameWithOwner: string
  visibility: 'PUBLIC' | 'PRIVATE'
  isArchived: boolean
  defaultBranchRef: { name: string } | null
  mergeCommitAllowed: boolean
  squashMergeAllowed: boolean
  rebaseMergeAllowed: boolean
  deleteBranchOnMerge: boolean
  hasIssuesEnabled: boolean
  hasProjectsEnabled: boolean
  hasWikiEnabled: boolean
  repositoryTopics: unknown
  licenseInfo: { key: string } | null
  description: string
}
const REPO_FIELDS =
  'nameWithOwner,visibility,isArchived,defaultBranchRef,mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed,deleteBranchOnMerge,hasIssuesEnabled,hasProjectsEnabled,hasWikiEnabled,repositoryTopics,licenseInfo,description'

// ── coverage cascade ──────────────────────────────────────────────────────────
// Once the gate confirms a repo is a ki-repo (it carries .ki-config.toml), each
// other governance skill whose APPLICABILITY is detectable from the repo must be
// DECLARED — its `[ki-<skill>]` opt-in table present. This is the
// single registry of {skill → detection signal → opt-in table}. `repo` reads only
// table PRESENCE here (validate-down still owns table CONTENTS); a detected-but-
// undeclared signal WARNs, a declared-but-undetected table WARNs as possibly stale.
// `authoring` is baseline (every KI repo) and so is not a *detected* coverage signal —
// it is checked directly as a required declaration above (authoring-baseline), not here.
const WRANGLER = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml']
const ELEVENTY = ['eleventy.config.ts', 'eleventy.config.js', 'eleventy.config.cjs', 'eleventy.config.mjs']
type Signals = { root: Set<string>; tree: Set<string>; pkg: Pkg | null }
const COVERAGE: { skill: string; table: string; artifact: string; detect: (s: Signals) => boolean }[] = [
  { skill: 'engineering', table: 'ki-engineering', artifact: 'package.json', detect: (s) => s.root.has('package.json') },
  {
    skill: 'kb',
    table: 'ki-kb',
    artifact: 'KB zones (Pillars/ + Resources/)',
    detect: (s) => s.root.has('Pillars') && s.root.has('Resources')
  },
  { skill: 'streams', table: 'ki-kb-streams', artifact: 'Streams/ zone', detect: (s) => s.root.has('Streams') },
  {
    skill: 'website',
    table: 'ki-website',
    artifact: 'eleventy.config.*',
    detect: (s) => ELEVENTY.some((f) => s.root.has(f)) || [...s.tree].some((p) => ELEVENTY.some((f) => p.endsWith(`/${f}`)))
  },
  {
    skill: 'website-cloudflare',
    table: 'ki-website-cloudflare',
    artifact: 'wrangler config',
    detect: (s) => WRANGLER.some((f) => s.root.has(f)) || [...s.tree].some((p) => WRANGLER.some((f) => p.endsWith(`/${f}`)))
  },
  {
    skill: 'mcp',
    table: 'ki-mcp',
    artifact: '@modelcontextprotocol/sdk dependency',
    detect: (s) => pkgHasDep(s.pkg, '@modelcontextprotocol/sdk')
  },
  {
    skill: 'plugins',
    table: 'ki-plugins',
    artifact: '.claude-plugin/marketplace.json',
    detect: (s) => s.tree.has('.claude-plugin/marketplace.json') || [...s.tree].some((p) => p.endsWith('/.claude-plugin/marketplace.json'))
  },
  {
    skill: 'tools',
    table: 'ki-tools',
    artifact: 'install.sh + bin/<exe>',
    detect: (s) => s.root.has('install.sh') && [...s.tree].some((p) => /^bin\/[^/]+$/.test(p))
  },
  {
    skill: 'homebrew-tap',
    table: 'ki-homebrew-tap',
    artifact: 'Formula/*.rb',
    detect: (s) => [...s.tree].some((p) => /^Formula\/[^/]+\.rb$/.test(p))
  },
  {
    skill: 'skills',
    table: 'ki-skills',
    artifact: 'skills/**/SKILL.md',
    detect: (s) => [...s.tree].some((p) => /^skills\/.+\/SKILL\.md$/.test(p))
  },
  {
    skill: 'agents',
    table: 'ki-agents',
    artifact: 'agents/**/*.md',
    detect: (s) => [...s.tree].some((p) => /^agents\/.+\.md$/.test(p) && !/(^|\/)README\.md$/i.test(p))
  }
]
const COVERAGE_SKILLS = new Set(COVERAGE.map((c) => c.skill))
// The repo-structure skills — exactly one governs a repo's on-disk shape, so their
// `[ki-<skill>]` tables are mutually exclusive (ADR-KI-HARNESS-SKILLS-006). Implied
// family members (ki-website-cloudflare under website, ki-kb-streams under kb) are not
// distinct structures and are excluded from the count.
const REPO_STRUCTURE_TABLES = [
  'ki-harness',
  'ki-kb',
  'ki-website',
  'ki-mcp',
  'ki-plugins',
  'ki-tools',
  'ki-homebrew-tap',
  'ki-dotfiles-chezmoi'
]
type MultilineDelimiter = '"""' | "'''"
function tripleClose(line: string, delimiter: MultilineDelimiter, from: number): number {
  let at = line.indexOf(delimiter, from)
  while (at !== -1) {
    const backslashes = line.slice(0, at).match(/\\+$/)?.[0].length ?? 0
    if (delimiter === "'''" || backslashes % 2 === 0) return at
    at = line.indexOf(delimiter, at + delimiter.length)
  }
  return -1
}

function declaredTables(text: string): Array<{ root: string; exact: boolean }> {
  const tables: Array<{ root: string; exact: boolean }> = []
  let multiline: MultilineDelimiter | null = null
  for (const raw of text.split(/\r?\n/)) {
    if (multiline) {
      if (tripleClose(raw, multiline, 0) !== -1) multiline = null
      continue
    }
    let code = ''
    let quote: '"' | "'" | null = null
    let escaped = false
    for (let i = 0; i < raw.length; i++) {
      const delimiter = raw.startsWith('"""', i) ? '"""' : raw.startsWith("'''", i) ? "'''" : null
      if (!quote && delimiter) {
        if (tripleClose(raw, delimiter, i + delimiter.length) === -1) multiline = delimiter
        break
      }
      const char = raw[i] as string
      if (!quote && char === '#') break
      code += char
      if (quote === '"') {
        if (!escaped && char === '"') quote = null
        escaped = !escaped && char === '\\'
      } else if (quote === "'") {
        if (char === "'") quote = null
      } else if (char === '"' || char === "'") {
        quote = char
        escaped = false
      }
    }
    const match = code.trim().match(/^\[\s*(?:"([^"\\]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*(\.|\])/)
    const root = match?.[1] ?? match?.[2] ?? match?.[3]
    if (root) tables.push({ root, exact: match?.[4] === ']' })
  }
  return tables
}

const declaresTable = (kiText: string, table: string): boolean => declaredTables(kiText).some(({ root }) => root === table)
const declaresRootTable = (kiText: string, table: string): boolean =>
  declaredTables(kiText).some(({ root, exact }) => root === table && exact)

function auditRepo(r: Repo, files: Set<string>, ki: KiConfig | null, kiText: string | null, signals: Signals): Finding[] {
  const { f, fail, warn, note } = mk()
  const pkgDesc = pkgDescription(signals.pkg)
  if (r.isArchived) {
    warn('ACCESS-1', 'repo is archived — skipping remaining checks')
    return f
  }

  // ── layer 1: files (presence on the default branch) ── FILES-1
  for (const [, paths] of REQUIRED_FILES) {
    if (!paths.some((p) => files.has(p))) fail('FILES-1', `no ${paths.join(' / ')}`, paths[0])
  }
  // ── layer 1: baseline governance + self-check capability (gated on the ki-repo marker) ── FILES-3
  // A confirmed ki-repo (carries .ki-config.toml) must (a) declare the baseline
  // authoring standard explicitly — it is no longer an implicit universal (ADR-006) —
  // and (b) carry a self-check runner so `./.ki-meta/bin/ki-audit` works with zero skills
  // installed (ADR-007). A marker-only repo with neither runner is a FAIL.
  if (files.has(KI_CONFIG)) {
    if (!declaresRootTable(kiText ?? '', 'ki-authoring'))
      fail('FILES-3', `${KI_CONFIG} does not declare [ki-authoring] — the authoring standard is baseline (run --init)`, KI_CONFIG)
    const hasRunner = signals.tree.has('.ki-meta/bin/aggregate.ts') || signals.tree.has('.ki-meta/bin/ki-audit')
    if (!hasRunner)
      fail(
        'FILES-3',
        `${KI_CONFIG} present but no self-check runner (.ki-meta/bin/aggregate.ts or .ki-meta/bin/ki-audit) — re-bootstrap so the repo self-governs`,
        KI_CONFIG
      )
  }

  // ── layer 1: .ki-meta working area — derived audit/conform artifacts must be gitignored, not committed ── FILES-2
  // The .ki-meta/ namespace itself may hold tracked artifacts, but its derived subdirs (audits/, conform/)
  // are regenerated each run; finding them in the committed tree means .gitignore is missing the entry.
  const metaCommitted = [...files].filter((p) => p.startsWith('.ki-meta/audits/') || p.startsWith('.ki-meta/conform/'))
  if (metaCommitted.length)
    warn(
      'FILES-2',
      `${metaCommitted.length} derived .ki-meta artifact(s) committed (e.g. ${metaCommitted[0]}) — add \`.ki-meta/audits/\` and \`.ki-meta/conform/\` to .gitignore`,
      '.gitignore'
    )

  // ── layer 2: core GitHub ── GH-1
  if (r.defaultBranchRef?.name !== DEFAULT_BRANCH)
    fail('GH-1', `default branch is "${r.defaultBranchRef?.name ?? '?'}" (want ${DEFAULT_BRANCH})`)
  // License is the declared SPDX id from `[ki-repo] license` (default MIT), decoupled
  // from visibility. The live GitHub license and package.json "license" must match the
  // declared id. A proprietary declaration (`UNLICENSED`/`proprietary`/`none`) expects
  // no recognised OSI license on GitHub and `"UNLICENSED"` in package.json.
  const declaredLicense = ki?.license ?? DEFAULT_LICENSE
  const proprietary = /^(unlicensed|proprietary|none)$/i.test(declaredLicense)
  const declaredKey = declaredLicense.toLowerCase()
  const liveKey = r.licenseInfo?.key ?? null
  // GH-2: declared license, cross-checked against live GitHub + package.json
  if (proprietary) {
    if (liveKey && !['other', 'noassertion'].includes(liveKey))
      fail('GH-2', `${KI_CONFIG} declares a proprietary license but GitHub reports "${liveKey}"`)
  } else if (liveKey !== declaredKey) {
    fail('GH-2', `license is "${liveKey ?? 'none'}" (want ${declaredLicense} per ${KI_CONFIG})`)
  }
  if (signals.pkg != null) {
    const pkgLicense = typeof signals.pkg.license === 'string' ? signals.pkg.license : null
    const wantPkg = proprietary ? 'UNLICENSED' : declaredLicense
    if (pkgLicense !== wantPkg)
      fail(
        'GH-2',
        `package.json "license" is ${JSON.stringify(pkgLicense)} (want ${JSON.stringify(wantPkg)} per ${KI_CONFIG})`,
        'package.json'
      )
  }
  // ── layer 2: package.json identity & metadata (the repo skill's manifest keys) ── PKG-1
  // engineering's coverage manifest assigns the identity/metadata keys to this skill;
  // here we check their presence/format. The keys: name, version, description, author,
  // license (above, GH-2), private, repository, homepage, bugs, keywords.
  if (signals.pkg != null) {
    const p = signals.pkg
    const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0
    const urlOf = (v: unknown): string | null =>
      isStr(v) ? v : v && typeof v === 'object' ? ((v as { url?: unknown }).url as string) : null
    if (!isStr(p.name)) fail('PKG-1', 'package.json "name" missing', 'package.json')
    if (typeof p.version !== 'string' || !/^\d+\.\d+\.\d+/.test(p.version))
      fail('PKG-1', `package.json "version" must be semver, got ${JSON.stringify(p.version)}`, 'package.json')
    if (!isStr(p.author) && !(p.author != null && typeof p.author === 'object'))
      fail('PKG-1', 'package.json "author" missing', 'package.json')
    const repoUrl = urlOf(p.repository)
    if (!isStr(repoUrl)) fail('PKG-1', 'package.json "repository" missing a url', 'package.json')
    else if (!repoUrl.includes(r.nameWithOwner))
      warn('PKG-1', `package.json "repository" url should reference ${r.nameWithOwner}\n      got: ${repoUrl}`, 'package.json')
    if (r.visibility === 'PRIVATE' && p.private !== true)
      fail('PKG-1', 'private repo: package.json must set "private": true', 'package.json')
    if (r.visibility === 'PUBLIC' && p.private === true)
      fail('PKG-1', 'public repo: package.json must not set "private": true', 'package.json')
    if (!isStr(urlOf(p.bugs))) warn('PKG-1', 'package.json "bugs" should carry a url', 'package.json')
    if (!isStr(p.homepage)) warn('PKG-1', 'package.json "homepage" missing', 'package.json')
    if (!Array.isArray(p.keywords) || p.keywords.length === 0)
      warn('PKG-1', 'package.json "keywords" should be a non-empty array', 'package.json')
  }
  // GH-3: description present + synced with package.json
  if (!r.description?.trim()) fail('GH-3', 'description is empty')
  // description-sync: the GitHub description must equal the repo's package.json
  // description (the in-repo source of truth). Only checked when both exist — a
  // repo with no package.json description is exempt. (Whether the text matches the
  // repo's PURPOSE is still judgment — the skill's AUDIT mode, DESCFIT-1.)
  else if (pkgDesc != null && pkgDesc !== r.description.trim())
    fail(
      'GH-3',
      `GitHub description ≠ package.json description\n      github: ${JSON.stringify(r.description.trim())}\n      package.json: ${JSON.stringify(pkgDesc)}`
    )
  // MERGE-1: squash-only + auto-delete-branch (one atomic gh call in conform.ts)
  if (r.mergeCommitAllowed || r.rebaseMergeAllowed || !r.squashMergeAllowed)
    fail(
      'MERGE-1',
      `merge methods M/S/R = ${r.mergeCommitAllowed ? 'M' : '-'}/${r.squashMergeAllowed ? 'S' : '-'}/${r.rebaseMergeAllowed ? 'R' : '-'} (want -/S/-)`
    )
  if (!r.deleteBranchOnMerge) fail('MERGE-1', 'auto-delete head branch on merge is off')

  // VIS-1: visibility declared in .ki-config.toml, checked against live GitHub
  const declared = ki?.visibility?.toUpperCase()
  if (!ki) fail('VIS-1', `cannot verify visibility — ${KI_CONFIG} has no [${KI_SECTION}] table (run --init)`)
  else if (declared !== 'PUBLIC' && declared !== 'PRIVATE')
    fail('VIS-1', `${KI_CONFIG} does not declare a valid \`visibility\` (got ${JSON.stringify(ki.visibility)})`)
  else if (declared !== r.visibility) fail('VIS-1', `visibility is ${r.visibility} but ${KI_CONFIG} declares ${declared}`)

  // CHECKS-1 / COV-1 / BP-1 / TOGGLE-1 / TOPICS-1 / SEC-1: per-repo overrides — a check's
  // effective state is its [..checks] value, else the org default. Surface every active
  // override as a note (citing the overridden check's own code); advise dropping one that
  // merely restates the default; and WARN (CHECKS-1) a key that names no overridable check.
  // A `coverage-<skill>` key (default on) opts a repo out of one coverage signal (COV-1).
  const enforced = (id: string): boolean => ki?.checks[id] ?? CHECK_DEFAULTS[id] ?? true
  // Maps an overridable check id (CHECK_DEFAULTS key) to the rubric code that governs it,
  // so the note() below cites the SAME code the check itself fails/passes under.
  const AREA_FOR_CHECK: Record<string, string> = {
    'branch-protection': 'BP-1',
    wiki: 'TOGGLE-1',
    projects: 'TOGGLE-1',
    issues: 'TOGGLE-1',
    topics: 'TOPICS-1',
    'secret-scanning': 'SEC-1',
    'push-protection': 'SEC-1',
    structure: 'STRUCT-2'
  }
  for (const [id, v] of Object.entries(ki?.checks ?? {})) {
    if (id.startsWith('coverage-')) {
      const sk = id.slice('coverage-'.length)
      if (!COVERAGE_SKILLS.has(sk)) warn('CHECKS-1', `"${id}" names no coverage skill (one of: ${[...COVERAGE_SKILLS].join(', ')})`)
      else if (!v) note('COV-1', `override: ki-${sk} coverage not enforced for this repo`)
      else note('COV-1', `redundant: coverage-${sk} is enforced by default — can be dropped from [${CHECKS_SECTION}]`)
    } else if (!(id in CHECK_DEFAULTS))
      warn('CHECKS-1', `"${id}" is not an overridable check (overridable: ${Object.keys(CHECK_DEFAULTS).join(', ')}, or coverage-<skill>)`)
    else if (v !== CHECK_DEFAULTS[id])
      note(
        AREA_FOR_CHECK[id] ?? 'CHECKS-1',
        `override: ${v ? 'enforced' : 'not enforced'} for this repo (org default: ${CHECK_DEFAULTS[id] ? 'on' : 'off'})`
      )
    else
      note(
        AREA_FOR_CHECK[id] ?? 'CHECKS-1',
        `redundant: matches the org default (${v ? 'on' : 'off'}) — can be dropped from [${CHECKS_SECTION}]`
      )
  }

  // ── coverage cascade (gated on the ki-repo marker) ──
  // Only a confirmed ki-repo (.ki-config.toml present) is checked for declaring the
  // other governance skills that apply to it. A repo without the marker already
  // FAILed `ki-config` above and is NOT a ki-repo, so it is never told to opt in —
  // that would be a false positive on a plain git repo that merely looks similar.
  if (files.has(KI_CONFIG)) {
    const text = kiText ?? ''
    for (const c of COVERAGE) {
      if (!enforced(`coverage-${c.skill}`)) continue
      const declared = declaresTable(text, c.table)
      const detected = c.detect(signals)
      if (detected && !declared)
        warn(
          'COV-1',
          `looks governed by ki-${c.skill} (${c.artifact}) but declares no [${c.table}] — opt in, or set coverage-${c.skill} = false`
        )
      else if (declared && !detected) warn('COV-1', `declares [${c.table}] but no ${c.artifact} found — stale opt-in?`)
    }

    // ── repo-structure cardinality: exactly one structural identity per repo ── STRUCT-1/2
    // The repo-structure tables are mutually exclusive; declaring more than one is a
    // governance error (ADR-KI-HARNESS-SKILLS-006) — bedrock, not overridable. Zero is
    // WARNed (STRUCT-2, overridable via `structure = false`) rather than FAILed — a
    // dotfiles/config repo may genuinely carry no structure skill.
    const declaredStructure = REPO_STRUCTURE_TABLES.filter((t) => declaresTable(text, t))
    if (declaredStructure.length > 1)
      fail(
        'STRUCT-1',
        `declares ${declaredStructure.length} repo-structure tables (${declaredStructure.map((t) => `[${t}]`).join(', ')}) — a repo has exactly one structural identity; keep one`
      )
    else if (declaredStructure.length === 0 && enforced('structure'))
      warn(
        'STRUCT-2',
        'declares no repo-structure table — pick the one that matches its layout (ki-harness/ki-kb/ki-website/ki-mcp/ki-plugins/ki-tools/ki-homebrew-tap/ki-dotfiles-chezmoi), or set `structure = false` in [ki-repo.checks] if this repo genuinely has none'
      )
  }

  // TOGGLE-1: repo-feature toggles (Issues on, Wiki/Projects off)
  if (enforced('issues') && !r.hasIssuesEnabled) fail('TOGGLE-1', 'Issues are disabled')
  if (enforced('wiki') && r.hasWikiEnabled) fail('TOGGLE-1', 'Wiki is enabled (want off)')
  if (enforced('projects') && r.hasProjectsEnabled) fail('TOGGLE-1', 'Projects are enabled (want off)')

  // TOPICS-1
  if (r.visibility === 'PUBLIC' && enforced('topics')) {
    const missing = TOPICS.filter((t) => !new Set(topicNames(r.repositoryTopics)).has(t))
    if (missing.length) fail('TOPICS-1', `missing topics: ${missing.join(', ')}`)
  }

  // BP-1: branch-protection — default OFF — `main` is open unless this repo sets it true.
  if (enforced('branch-protection')) {
    let bp: {
      required_pull_request_reviews?: unknown
      required_status_checks?: { contexts?: string[]; checks?: { context: string }[] }
      required_linear_history?: { enabled?: boolean }
    } | null
    try {
      bp = ghJSON(`repos/${r.nameWithOwner}/branches/${DEFAULT_BRANCH}/protection`) as typeof bp
    } catch {
      bp = null
    }
    if (!bp) fail('BP-1', `no branch protection on ${DEFAULT_BRANCH}`)
    else {
      if (bp.required_pull_request_reviews == null) fail('BP-1', 'does not require a pull request')
      const presentChecks = bp.required_status_checks?.checks?.map((c) => c.context) ?? bp.required_status_checks?.contexts ?? []
      if (!presentChecks.includes(REQUIRED_CHECK)) fail('BP-1', `required checks omit "${REQUIRED_CHECK}"`)
      if (bp.required_linear_history?.enabled !== true) fail('BP-1', 'does not require linear history')
    }
  }

  // ── layer 3: deeper GitHub ── DEP-1: Dependabot alerts/updates + PR-branch freshness
  if (!ghOk(`repos/${r.nameWithOwner}/vulnerability-alerts`)) fail('DEP-1', 'Dependabot alerts are off')
  try {
    if ((ghJSON(`repos/${r.nameWithOwner}/automated-security-fixes`) as { enabled?: boolean }).enabled !== true)
      fail('DEP-1', 'Dependabot security updates are off')
  } catch {
    warn('DEP-1', 'could not read automated-security-fixes')
  }
  // "Always suggest updating pull request branches" — keeps PRs (Dependabot's included)
  // current with the base before merge, so a green PR is green against today's main.
  // REST-only: not exposed in the GraphQL `gh repo view` fields.
  try {
    if ((ghJSON(`repos/${r.nameWithOwner}`) as { allow_update_branch?: boolean }).allow_update_branch !== true)
      fail('DEP-1', 'allow_update_branch is off ("Always suggest updating pull request branches")')
  } catch {
    warn('DEP-1', 'could not read allow_update_branch')
  }
  // SEC-1: secret scanning + push protection (public) — one atomic conform.ts PATCH sets both.
  if (r.visibility === 'PUBLIC' && (enforced('secret-scanning') || enforced('push-protection'))) {
    try {
      const sa = (
        ghJSON(`repos/${r.nameWithOwner}`) as {
          security_and_analysis?: { secret_scanning?: { status?: string }; secret_scanning_push_protection?: { status?: string } }
        }
      ).security_and_analysis
      if (enforced('secret-scanning') && sa?.secret_scanning?.status !== 'enabled') fail('SEC-1', 'secret scanning is off')
      if (enforced('push-protection') && sa?.secret_scanning_push_protection?.status !== 'enabled')
        fail('SEC-1', 'secret-scanning push protection is off')
    } catch {
      warn('SEC-1', 'could not read security_and_analysis')
    }
  }
  // ACT-1
  try {
    const al = (ghJSON(`repos/${r.nameWithOwner}/actions/permissions`) as { allowed_actions?: string }).allowed_actions
    if (al && al !== ALLOWED_ACTIONS) warn('ACT-1', `allowed_actions is "${al}" (standard: ${ALLOWED_ACTIONS})`)
  } catch {
    /* not always readable */
  }
  return f
}

// ── vendor-integrity (ADR-KI-HARNESS-006) ─────────────────────────────────────
// Offline, local-disk check independent of the GitHub-based checks above: a
// bootstrapped repo's vendored `.ki-meta/skills/**` copies (+ the aggregate
// runner) must match the sha256 recorded in `.ki-meta/manifest.json` at vendor
// time. A mismatch means tampered or partially re-vendored files (FAIL). A repo
// that carries `.ki-meta/` but no manifest predates the manifest contract
// (migration WARN). Staleness against the remote harness ref is deliberately NOT
// checked here — that would require network access; this check stays usable with
// zero connectivity (ADR-KI-HARNESS-006's Consequences: "offline-safe").
function localIntegrityFindings(dir: string): Finding[] {
  const { f, fail, warn } = mk()
  const metaDir = join(dir, '.ki-meta')
  if (!existsSync(metaDir)) return f // no vendored surface — nothing to check
  const manifestPath = join(metaDir, 'manifest.json')
  if (!existsSync(manifestPath)) {
    warn('VENDOR-1', '.ki-meta/ present but no manifest.json — re-bootstrap (ki-init) to migrate to the manifest-based drift contract')
    return f
  }
  let manifest: { ref?: string; files?: Record<string, string> }
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    fail('VENDOR-1', '.ki-meta/manifest.json is not valid JSON')
    return f
  }
  const missing: string[] = []
  const mismatched: string[] = []
  for (const [rel, expected] of Object.entries(manifest.files ?? {})) {
    const abs = join(dir, rel)
    if (!existsSync(abs)) {
      missing.push(rel)
      continue
    }
    const actual = createHash('sha256').update(readFileSync(abs)).digest('hex')
    if (actual !== expected) mismatched.push(rel)
  }
  if (missing.length) fail('VENDOR-1', `manifest file(s) missing on disk: ${missing.join(', ')} — re-run ./.ki-meta/bin/ki-init to restore`)
  if (mismatched.length)
    fail(
      'VENDOR-1',
      `vendored file(s) do not match the manifest hash (tampered or partially re-vendored): ${mismatched.join(', ')} — re-run ./.ki-meta/bin/ki-init to restore`
    )
  return f
}

// The agent runtimes the bootstrap linkers know how to install for. A repo may
// declare a subset in `[ki-repo] target_runtimes`; anything outside this set has no
// discovery path, so the linker would silently do nothing for it (RUNTIMES-1).
const KNOWN_RUNTIMES = ['claude-code', 'codex']

// Parse `target_runtimes = ["a", "b"]` from the [ki-repo] table only (the documented
// home of the key — table-aware, unlike the bootstrap resolver's tolerant match).
// Returns null when the key is absent (the ["claude-code"] default applies, nothing to
// check), else the declared list (possibly empty).
function parseTargetRuntimes(text: string): string[] | null {
  let document: Record<string, unknown>
  try {
    document = TOML.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
  const table = document[KI_SECTION]
  if (!table || typeof table !== 'object' || Array.isArray(table)) return null
  const runtimes = (table as Record<string, unknown>).target_runtimes
  if (runtimes === undefined) return null
  if (!Array.isArray(runtimes)) return []
  return runtimes.filter((runtime): runtime is string => typeof runtime === 'string')
}

// RUNTIMES-1: validate `[ki-repo] target_runtimes` if declared. A pure local
// .ki-config.toml read — offline-safe, sits beside vendor-integrity. Absent key →
// default ["claude-code"], nothing to check. Every declared name must be a runtime the
// linkers recognise; an empty list would target nothing.
function localConfigFindings(dir: string): Finding[] {
  const { f, warn } = mk()
  const cfgPath = join(dir, KI_CONFIG)
  if (!existsSync(cfgPath)) return f
  const runtimes = parseTargetRuntimes(readFileSync(cfgPath, 'utf8'))
  if (runtimes === null) return f
  if (runtimes.length === 0) {
    warn(
      'RUNTIMES-1',
      `[${KI_SECTION}] target_runtimes is empty — the linkers would target no runtime; omit the key to default to ["claude-code"]`,
      KI_CONFIG
    )
    return f
  }
  const unknown = runtimes.filter((rt) => !KNOWN_RUNTIMES.includes(rt))
  if (unknown.length)
    warn(
      'RUNTIMES-1',
      `[${KI_SECTION}] target_runtimes names unknown runtime(s): ${unknown.join(', ')} (known: ${KNOWN_RUNTIMES.join(', ')})`,
      KI_CONFIG
    )
  return f
}

// ── discovery ────────────────────────────────────────────────────────────────
type Target = { label: string; nameWithOwner: string | null; dir?: string; note?: string }
const GH_REMOTE = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/
const gitOrigin = (dir: string): string | null => {
  try {
    return execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}
function repoDirsUnder(path: string): string[] {
  if (existsSync(join(path, '.git'))) return [path]
  return readdirSync(path, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
    .map((e) => join(path, e.name))
    .filter((d) => existsSync(join(d, '.git')))
    .sort()
}
function localTargets(path: string): Target[] {
  const abs = resolve(path)
  const dirs = repoDirsUnder(abs)
  if (dirs.length === 0) {
    console.error(paint(C.red, `no git repos found at ${abs}`))
    process.exit(2)
  }
  return dirs.map((dir) => {
    const label = dir.split('/').pop() ?? dir
    const m = gitOrigin(dir)?.match(GH_REMOTE)
    return m ? { label, nameWithOwner: `${m[1]}/${m[2]}`, dir } : { label, nameWithOwner: null, dir, note: 'origin not on github.com' }
  })
}
function orgTargets(org: string): Target[] {
  const repos: { nameWithOwner: string }[] = JSON.parse(gh(['repo', 'list', org, '--limit', '200', '--json', 'nameWithOwner']))
  return repos.map((r) => ({ label: r.nameWithOwner, nameWithOwner: r.nameWithOwner })).sort((a, b) => a.label.localeCompare(b.label))
}

// ── run ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
// `--init` prints the default [ki-repo] block for a new repo's
// .ki-config.toml (authoring creates the keys; the author edits the values).
if (argv.includes('--init')) {
  process.stdout.write(KI_DEFAULT)
  process.exit(0)
}
const orgIdx = argv.indexOf('--org')
let targets: Target[]
let scope: string
try {
  if (orgIdx !== -1) {
    const org = argv[orgIdx + 1]
    if (!org) {
      console.error('usage: audit.ts --org <org>')
      process.exit(2)
    }
    scope = `org ${org}`
    targets = orgTargets(org)
  } else {
    const path = argv.find((a) => !a.startsWith('-')) ?? '.'
    scope = `tree ${resolve(path)}`
    targets = localTargets(path)
  }
} catch (e) {
  console.error(paint(C.red, 'failed to enumerate repos — is gh installed and authenticated? (gh auth status)'))
  console.error(String((e as Error).message ?? e).split('\n')[0])
  process.exit(2)
}

// Output flags + unified-ladder aggregation across every audited repo (enforcement-framework §2/§5).
const jsonOut = process.argv.slice(2).includes('--json')
const reportOut = process.argv.slice(2).includes('--report')
const reportTarget = resolve('.')
const reportDir = join(reportTarget, '.ki-meta', 'audits')
const all: { level: Level; area: string; msg: string; ref?: string; file?: string }[] = []
// Fold the repo identity into `file` for the aggregate/JSON: `area` stays the bare rubric
// code (so it reads as a rubric code, not `nwo:code`), and the nwo — plus any in-repo path
// the finding carried — disambiguates findings across a multi-repo sweep.
const scoped = (nwo: string, f: Finding): string => `${nwo}${f.file ? `/${f.file}` : ''}`
// Shared human render for a per-repo finding line (mirrors the report/JSON builder).
const line = (colored: string, f: Finding): string =>
  `  ${colored} ${paint(C.dim, `[${f.area}]`)}${f.file ? ` ${f.file}` : ''} ${f.msg}${f.ref ? paint(C.dim, ` (${f.ref})`) : ''}`

if (!jsonOut) {
  console.log(paint(C.dim, `scope: ${scope}`))
  console.log(
    paint(
      C.dim,
      `standard: files(README,LICENSE,.gitignore,${KI_CONFIG}) · github(main,license,squash-only,del-branch,update-branch,issues,no-wiki/projects,desc,visibility) · public+(topics) · deeper(dependabot;secret-scanning;actions=all) · coverage[ki-repo→](${COVERAGE.map((c) => c.skill).join(',')}) · overridable via [..checks]: ${Object.keys(CHECK_DEFAULTS).join(',')},coverage-<skill>`
    )
  )
}

let totalFails = 0
let totalWarns = 0
let ghSkipped = 0
for (const t of targets) {
  // Offline, local-disk vendor-integrity check — independent of GitHub reachability,
  // so it still runs for a target with no github.com origin (or none at all).
  const localFindings = t.dir ? [...localIntegrityFindings(t.dir), ...localConfigFindings(t.dir)] : []
  if (!t.nameWithOwner) {
    ghSkipped++
    all.push({ level: 'NA', area: 'access', msg: t.note ?? '', file: t.label })
    for (const x of localFindings) all.push({ level: x.level, area: x.area, msg: x.msg, ref: x.ref, file: scoped(t.label, x) })
    totalFails += localFindings.filter((x) => x.level === 'FAIL').length
    totalWarns += localFindings.filter((x) => x.level === 'WARN').length
    if (!jsonOut) {
      console.log(`\n${paint(C.dim, 'NA')}  ${paint(C.cyan, t.label)} ${paint(C.dim, `— ${t.note}`)}`)
      for (const x of localFindings) console.log(line(paint(x.level === 'FAIL' ? C.red : C.yellow, x.level.toLowerCase()), x))
    }
    continue
  }
  // gh unauthenticated (typically CI): every GitHub-touching check is impossible, so skip
  // them as NA rather than emitting a spurious access-FAIL. The offline vendor-integrity
  // findings above still count — that is the value this gate carries in CI (see ci.yml).
  if (!ghAuthed()) {
    ghSkipped++
    const note = `${t.nameWithOwner}: gh not authenticated — GitHub checks skipped (gh auth login)`
    all.push({ level: 'NA', area: 'access', msg: note, file: t.nameWithOwner })
    for (const x of localFindings) all.push({ level: x.level, area: x.area, msg: x.msg, ref: x.ref, file: scoped(t.nameWithOwner, x) })
    totalFails += localFindings.filter((x) => x.level === 'FAIL').length
    totalWarns += localFindings.filter((x) => x.level === 'WARN').length
    if (!jsonOut) {
      console.log(`\n${paint(C.dim, 'NA')}  ${paint(C.cyan, t.nameWithOwner)} ${paint(C.dim, '— gh not authenticated')}`)
      for (const x of localFindings) console.log(line(paint(x.level === 'FAIL' ? C.red : C.yellow, x.level.toLowerCase()), x))
    }
    continue
  }
  let findings: Finding[]
  try {
    const r = JSON.parse(gh(['repo', 'view', t.nameWithOwner, '--json', REPO_FIELDS])) as Repo
    const branch = r.defaultBranchRef?.name ?? DEFAULT_BRANCH
    const files = rootPaths(t.nameWithOwner, branch)
    const kiText = files.has(KI_CONFIG) ? ghRaw(t.nameWithOwner, KI_CONFIG) : null
    const ki = kiText != null ? parseKiConfig(kiText) : null
    const signals: Signals = { root: files, tree: treePaths(t.nameWithOwner, branch), pkg: readPkg(t.nameWithOwner, files) }
    // overrides are applied inside auditRepo: a not-enforced check simply does not fail
    // and is reported as INFO. No post-filtering here.
    findings = [...auditRepo(r, files, ki, kiText, signals), ...localFindings]
  } catch {
    findings = [
      { level: 'FAIL', area: 'ACCESS-1', msg: `could not read ${t.nameWithOwner} via gh (missing repo or insufficient scope)` },
      ...localFindings
    ]
  }
  const fails = findings.filter((x) => x.level === 'FAIL')
  const warns = findings.filter((x) => x.level === 'WARN')
  const notes = findings.filter((x) => x.level === 'INFO')
  totalFails += fails.length
  totalWarns += warns.length
  for (const x of findings) all.push({ level: x.level, area: x.area, msg: x.msg, ref: x.ref, file: scoped(t.nameWithOwner, x) })
  if (!jsonOut) {
    const stamp = fails.length ? paint(C.red, 'FAIL') : warns.length ? paint(C.yellow, 'WARN') : paint(C.green, 'PASS')
    console.log(`\n${stamp}  ${paint(C.cyan, t.nameWithOwner)}`)
    for (const x of fails) console.log(line(paint(C.red, 'fail'), x))
    for (const x of warns) console.log(line(paint(C.yellow, 'warn'), x))
    for (const x of notes) console.log(line(paint(C.dim, 'info'), x))
    if (fails.length + warns.length === 0) console.log(paint(C.dim, '  conforms'))
  }
}

const summary = {
  fail: totalFails,
  warn: totalWarns,
  polish: all.filter((f) => f.level === 'POLISH').length,
  advisory: all.filter((f) => f.level === 'ADVISORY').length,
  info: all.filter((f) => f.level === 'INFO').length,
  na: all.filter((f) => f.level === 'NA').length,
  pass: all.filter((f) => f.level === 'PASS').length
}
const stampIso = new Date().toISOString()

if (reportOut) {
  mkdirSync(reportDir, { recursive: true })
  const body = LADDER.flatMap((l) => {
    const rows = all.filter((f) => f.level === l)
    return rows.length
      ? [
          '',
          `## ${ICON[l]} ${l} (${rows.length})`,
          ...rows.map((r) => `- [${r.area}]${r.file ? ` ${r.file}` : ''} ${r.msg}${r.ref ? ` (${r.ref})` : ''}`)
        ]
      : []
  })
  const tally = `${targets.length} repo(s) · FAIL=${summary.fail} WARN=${summary.warn} INFO=${summary.info} NA=${summary.na}`
  writeFileSync(join(reportDir, 'repo.md'), [`# repo audit — ${reportTarget}`, '', `_${stampIso}_`, '', tally, ...body, ''].join('\n'))
  writeFileSync(
    join(reportDir, 'repo.json'),
    `${JSON.stringify({ concern: 'repo', target: reportTarget, generatedAt: stampIso, summary, findings: all }, null, 2)}\n`
  )
}

if (jsonOut) {
  process.stdout.write(JSON.stringify({ concern: 'repo', target: reportTarget, generatedAt: stampIso, summary, findings: all }))
} else {
  console.log(
    `\n${paint(C.cyan, 'summary')}: ${targets.length} repo(s) · FAIL=${totalFails} WARN=${totalWarns}${ghSkipped ? paint(C.dim, ` · ${ghSkipped} skipped (no github.com origin or gh unauthenticated)`) : ''}`
  )
  if (reportOut) console.log(paint(C.dim, `report → ${join(reportDir, 'repo.{md,json}')}`))
  if (totalFails + totalWarns > 0) console.log('→ to address: run /ki-repo CONFORM   (judgment criteria: references/audit-rubric.md)')
  console.log(
    paint(
      C.dim,
      'mechanical checks only — the one remaining judgment item (does the description match the repo’s purpose) is the skill’s AUDIT mode.'
    )
  )
}
process.exit(totalFails > 0 ? 1 : 0)
