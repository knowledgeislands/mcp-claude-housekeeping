#!/usr/bin/env bun
/**
 * Mechanical auditor for the Knowledge Islands repo standard.
 *
 *   bun scripts/audit-repo.ts [tree-path]   # default: cwd — enumerate repos from a tree
 *   bun scripts/audit-repo.ts --org <org>   # enumerate every repo in a GitHub org
 *
 * Everything is checked **against GitHub** (no working checkout needed): file
 * presence via the git-tree API, settings via `gh repo view`, security/Actions via
 * `gh api`. The tree path / `--org` only decide *which* repos to look at — local-tree
 * mode reads each dir's `origin` and audits the github.com ones under their real
 * GitHub identity; `--org` lists the org (and so catches repos not cloned locally).
 *
 * The standard has three layers (see references/repo-standard.md):
 *   1. FILES   — README, LICENSE, .gitignore, .editorconfig, and .ki-config.toml
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
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// ── the standard (keep in sync with references/repo-standard.md) ──────
const DEFAULT_BRANCH = 'main'
// The declared license defaults to MIT when `[ki-repo] license` is unset. Decoupled
// from visibility (a private repo may be MIT; a public repo may be proprietary).
const DEFAULT_LICENSE = 'MIT'
const TOPICS = ['mcp', 'model-context-protocol', 'claude', 'typescript', 'bun']
const REQUIRED_CHECK = 'build'
const ALLOWED_ACTIONS = 'all'
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
  'push-protection': true //    (public) secret-scanning push protection on
}
const KI_CONFIG = '.ki-config.toml'
// Required root files. Each entry is one or more acceptable paths (first found wins).
const REQUIRED_FILES: [check: string, paths: string[]][] = [
  ['readme', ['README.md']],
  ['license-file', ['LICENSE', 'LICENSE.md']],
  ['gitignore', ['.gitignore']],
  ['editorconfig', ['.editorconfig']],
  ['claude-md', ['CLAUDE.md']],
  ['ki-config', [KI_CONFIG]]
]

const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m' }
const paint = (c: string, s: string): string => `${c}${s}${C.reset}`

// `note` is informational (a per-repo override in effect) — printed, never counted.
// Unified severity ladder — shared by every KI checker (enforcement-framework §2).
type Level = 'FAIL' | 'WARN' | 'POLISH' | 'ADVISORY' | 'INFO' | 'NA' | 'PASS'
const LADDER: Level[] = ['FAIL', 'WARN', 'POLISH', 'ADVISORY', 'INFO', 'NA', 'PASS']
const ICON: Record<Level, string> = { FAIL: '❌', WARN: '⚠️ ', POLISH: '✨', ADVISORY: '🧭', INFO: 'ℹ️ ', NA: '⊘', PASS: '✅' }
type Finding = { level: Level; check: string; msg: string }
const mk = () => {
  const f: Finding[] = []
  const push =
    (level: Level) =>
    (check: string, msg: string): void =>
      void f.push({ level, check, msg })
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
const KI_DEFAULT = `[${KI_SECTION}]
visibility = "private"   # "public" | "private" — must match the repo's actual GitHub visibility
license = "MIT"          # SPDX id the LICENSE, package.json, and GitHub must match; default MIT. Use "UNLICENSED" for proprietary. Pick one at https://choosealicense.com/

# Per-repo check overrides — true = enforce, false = don't. Omit any check to take
# the org default; a repo that fully conforms needs nothing here.
# [${KI_SECTION}.checks]
# branch-protection = true   # default off — protect \`main\` on this repo
# wiki = false               # default on  — allow this repo's Wiki
`

// Minimal parser for the constrained schema: `[table]` headers (incl. the dotted
// `[...checks]` sub-table), flat `key = "string"` and `key = true|false` on a single
// line, `#` comments. NOT a full TOML parser. Returns this skill's config, or null
// if the file has no [ki-repo] table at all.
type KiConfig = { visibility?: string; license?: string; checks: Record<string, boolean> }
const CHECKS_SECTION = `${KI_SECTION}.checks`
function parseKiConfig(text: string): KiConfig | null {
  let section = ''
  let seen = false
  const out: KiConfig = { checks: {} }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    const header = line.match(/^\[(.+)\]$/)
    if (header) {
      section = (header[1] as string).trim()
      if (section === KI_SECTION || section === CHECKS_SECTION) seen = true
      continue
    }
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    const val = line.slice(eq + 1).trim()
    if (section === KI_SECTION && key === 'visibility') out.visibility = val.replace(/^["']|["']$/g, '')
    if (section === KI_SECTION && key === 'license') out.license = val.replace(/^["']|["']$/g, '')
    else if (section === CHECKS_SECTION && (val === 'true' || val === 'false')) out.checks[key] = val === 'true'
  }
  return seen ? out : null
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
// `authoring` is universal (every markdown repo) so it has no opt-in table.
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
    artifact: 'skills/*/SKILL.md',
    detect: (s) => [...s.tree].some((p) => /^skills\/[^/]+\/SKILL\.md$/.test(p))
  },
  {
    skill: 'agents',
    table: 'ki-agents',
    artifact: 'agents/**/*.md',
    detect: (s) => [...s.tree].some((p) => /^agents\/.+\.md$/.test(p) && !/(^|\/)README\.md$/i.test(p))
  }
]
const COVERAGE_SKILLS = new Set(COVERAGE.map((c) => c.skill))
// A `[ki-<skill>]` (or sub-table `[…​.x]`) header on its own line —
// anchored so a commented-out `# [..]` template line does not count as declared.
const declaresTable = (kiText: string, table: string): boolean => new RegExp(`^\\[${table}(\\]|\\.)`, 'm').test(kiText)

function auditRepo(r: Repo, files: Set<string>, ki: KiConfig | null, kiText: string | null, signals: Signals): Finding[] {
  const { f, fail, warn, note } = mk()
  const pkgDesc = pkgDescription(signals.pkg)
  if (r.isArchived) {
    warn('archived', 'repo is archived — skipping remaining checks')
    return f
  }

  // ── layer 1: files (presence on the default branch) ──
  for (const [check, paths] of REQUIRED_FILES) {
    if (!paths.some((p) => files.has(p))) fail(check, `no ${paths.join(' / ')}`)
  }
  // ── layer 1: .ki-meta working area — derived audit/conform artifacts must be gitignored, not committed ──
  // The .ki-meta/ namespace itself may hold tracked artifacts, but its derived subdirs (audits/, conform/)
  // are regenerated each run; finding them in the committed tree means .gitignore is missing the entry.
  const metaCommitted = [...files].filter((p) => p.startsWith('.ki-meta/audits/') || p.startsWith('.ki-meta/conform/'))
  if (metaCommitted.length)
    warn(
      'ki-meta',
      `${metaCommitted.length} derived .ki-meta artifact(s) committed (e.g. ${metaCommitted[0]}) — add \`.ki-meta/audits/\` and \`.ki-meta/conform/\` to .gitignore`
    )

  // ── layer 2: core GitHub ──
  if (r.defaultBranchRef?.name !== DEFAULT_BRANCH)
    fail('default-branch', `default branch is "${r.defaultBranchRef?.name ?? '?'}" (want ${DEFAULT_BRANCH})`)
  // License is the declared SPDX id from `[ki-repo] license` (default MIT), decoupled
  // from visibility. The live GitHub license and package.json "license" must match the
  // declared id. A proprietary declaration (`UNLICENSED`/`proprietary`/`none`) expects
  // no recognised OSI license on GitHub and `"UNLICENSED"` in package.json.
  const declaredLicense = ki?.license ?? DEFAULT_LICENSE
  const proprietary = /^(unlicensed|proprietary|none)$/i.test(declaredLicense)
  const declaredKey = declaredLicense.toLowerCase()
  const liveKey = r.licenseInfo?.key ?? null
  if (proprietary) {
    if (liveKey && !['other', 'noassertion'].includes(liveKey))
      fail('license', `${KI_CONFIG} declares a proprietary license but GitHub reports "${liveKey}"`)
  } else if (liveKey !== declaredKey) {
    fail('license', `license is "${liveKey ?? 'none'}" (want ${declaredLicense} per ${KI_CONFIG})`)
  }
  if (signals.pkg != null) {
    const pkgLicense = typeof signals.pkg.license === 'string' ? signals.pkg.license : null
    const wantPkg = proprietary ? 'UNLICENSED' : declaredLicense
    if (pkgLicense !== wantPkg)
      fail('package-license', `package.json "license" is ${JSON.stringify(pkgLicense)} (want ${JSON.stringify(wantPkg)} per ${KI_CONFIG})`)
  }
  // ── layer 2: package.json identity & metadata (the repo skill's manifest keys) ──
  // engineering's coverage manifest assigns the identity/metadata keys to this skill;
  // here we check their presence/format. The keys: name, version, description, author,
  // license (above), private, repository, homepage, bugs, keywords.
  if (signals.pkg != null) {
    const p = signals.pkg
    const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0
    const urlOf = (v: unknown): string | null =>
      isStr(v) ? v : v && typeof v === 'object' ? ((v as { url?: unknown }).url as string) : null
    if (!isStr(p.name)) fail('package-name', 'package.json "name" missing')
    if (typeof p.version !== 'string' || !/^\d+\.\d+\.\d+/.test(p.version))
      fail('package-version', `package.json "version" must be semver, got ${JSON.stringify(p.version)}`)
    if (!isStr(p.author) && !(p.author != null && typeof p.author === 'object')) fail('package-author', 'package.json "author" missing')
    const repoUrl = urlOf(p.repository)
    if (!isStr(repoUrl)) fail('package-repository', 'package.json "repository" missing a url')
    else if (!repoUrl.includes(r.nameWithOwner))
      warn('package-repository', `package.json "repository" url should reference ${r.nameWithOwner}\n      got: ${repoUrl}`)
    if (r.visibility === 'PRIVATE' && p.private !== true) fail('package-private', 'private repo: package.json must set "private": true')
    if (r.visibility === 'PUBLIC' && p.private === true) fail('package-private', 'public repo: package.json must not set "private": true')
    if (!isStr(urlOf(p.bugs))) warn('package-bugs', 'package.json "bugs" should carry a url')
    if (!isStr(p.homepage)) warn('package-homepage', 'package.json "homepage" missing')
    if (!Array.isArray(p.keywords) || p.keywords.length === 0)
      warn('package-keywords', 'package.json "keywords" should be a non-empty array')
  }
  if (!r.description?.trim()) fail('description', 'description is empty')
  // description-sync: the GitHub description must equal the repo's package.json
  // description (the in-repo source of truth). Only checked when both exist — a
  // repo with no package.json description is exempt. (Whether the text matches the
  // repo's PURPOSE is still judgment — the skill's AUDIT mode.)
  else if (pkgDesc != null && pkgDesc !== r.description.trim())
    fail(
      'description-sync',
      `GitHub description ≠ package.json description\n      github: ${JSON.stringify(r.description.trim())}\n      package.json: ${JSON.stringify(pkgDesc)}`
    )
  if (r.mergeCommitAllowed || r.rebaseMergeAllowed || !r.squashMergeAllowed)
    fail(
      'merge',
      `merge methods M/S/R = ${r.mergeCommitAllowed ? 'M' : '-'}/${r.squashMergeAllowed ? 'S' : '-'}/${r.rebaseMergeAllowed ? 'R' : '-'} (want -/S/-)`
    )
  if (!r.deleteBranchOnMerge) fail('delete-branch', 'auto-delete head branch on merge is off')

  // visibility: declared in .ki-config.toml, checked against live GitHub
  const declared = ki?.visibility?.toUpperCase()
  if (!ki) fail('visibility', `cannot verify visibility — ${KI_CONFIG} has no [${KI_SECTION}] table (run --init)`)
  else if (declared !== 'PUBLIC' && declared !== 'PRIVATE')
    fail('visibility', `${KI_CONFIG} does not declare a valid \`visibility\` (got ${JSON.stringify(ki.visibility)})`)
  else if (declared !== r.visibility) fail('visibility', `visibility is ${r.visibility} but ${KI_CONFIG} declares ${declared}`)

  // per-repo overrides: a check's effective state is its [..checks] value, else the
  // org default. Surface every active override as a note; advise dropping one that
  // merely restates the default; and WARN a key that names no overridable check.
  // A check's effective state is its [..checks] value, else the org default;
  // a `coverage-<skill>` key (default on) opts a repo out of one coverage signal.
  const enforced = (id: string): boolean => ki?.checks[id] ?? CHECK_DEFAULTS[id] ?? true
  for (const [id, v] of Object.entries(ki?.checks ?? {})) {
    if (id.startsWith('coverage-')) {
      const sk = id.slice('coverage-'.length)
      if (!COVERAGE_SKILLS.has(sk)) warn('checks', `"${id}" names no coverage skill (one of: ${[...COVERAGE_SKILLS].join(', ')})`)
      else if (!v) note(id, `override: ki-${sk} coverage not enforced for this repo`)
      else note(id, `redundant: coverage-${sk} is enforced by default — can be dropped from [${CHECKS_SECTION}]`)
    } else if (!(id in CHECK_DEFAULTS))
      warn('checks', `"${id}" is not an overridable check (overridable: ${Object.keys(CHECK_DEFAULTS).join(', ')}, or coverage-<skill>)`)
    else if (v !== CHECK_DEFAULTS[id])
      note(id, `override: ${v ? 'enforced' : 'not enforced'} for this repo (org default: ${CHECK_DEFAULTS[id] ? 'on' : 'off'})`)
    else note(id, `redundant: matches the org default (${v ? 'on' : 'off'}) — can be dropped from [${CHECKS_SECTION}]`)
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
          'coverage',
          `looks governed by ki-${c.skill} (${c.artifact}) but declares no [${c.table}] — opt in, or set coverage-${c.skill} = false`
        )
      else if (declared && !detected) warn('coverage', `declares [${c.table}] but no ${c.artifact} found — stale opt-in?`)
    }
  }

  if (enforced('issues') && !r.hasIssuesEnabled) fail('issues', 'Issues are disabled')
  if (enforced('wiki') && r.hasWikiEnabled) fail('wiki', 'Wiki is enabled (want off)')
  if (enforced('projects') && r.hasProjectsEnabled) fail('projects', 'Projects are enabled (want off)')

  if (r.visibility === 'PUBLIC' && enforced('topics')) {
    const missing = TOPICS.filter((t) => !new Set(topicNames(r.repositoryTopics)).has(t))
    if (missing.length) fail('topics', `missing topics: ${missing.join(', ')}`)
  }

  // branch-protection: default OFF — `main` is open unless this repo sets it true.
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
    if (!bp) fail('branch-protection', `no branch protection on ${DEFAULT_BRANCH}`)
    else {
      if (bp.required_pull_request_reviews == null) fail('branch-protection', 'does not require a pull request')
      const presentChecks = bp.required_status_checks?.checks?.map((c) => c.context) ?? bp.required_status_checks?.contexts ?? []
      if (!presentChecks.includes(REQUIRED_CHECK)) fail('branch-protection', `required checks omit "${REQUIRED_CHECK}"`)
      if (bp.required_linear_history?.enabled !== true) fail('branch-protection', 'does not require linear history')
    }
  }

  // ── layer 3: deeper GitHub ──
  if (!ghOk(`repos/${r.nameWithOwner}/vulnerability-alerts`)) fail('dependabot-alerts', 'Dependabot alerts are off')
  try {
    if ((ghJSON(`repos/${r.nameWithOwner}/automated-security-fixes`) as { enabled?: boolean }).enabled !== true)
      fail('dependabot-updates', 'Dependabot security updates are off')
  } catch {
    warn('dependabot-updates', 'could not read automated-security-fixes')
  }
  // "Always suggest updating pull request branches" — keeps PRs (Dependabot's included)
  // current with the base before merge, so a green PR is green against today's main.
  // REST-only: not exposed in the GraphQL `gh repo view` fields.
  try {
    if ((ghJSON(`repos/${r.nameWithOwner}`) as { allow_update_branch?: boolean }).allow_update_branch !== true)
      fail('update-branch', 'allow_update_branch is off ("Always suggest updating pull request branches")')
  } catch {
    warn('update-branch', 'could not read allow_update_branch')
  }
  if (r.visibility === 'PUBLIC' && (enforced('secret-scanning') || enforced('push-protection'))) {
    try {
      const sa = (
        ghJSON(`repos/${r.nameWithOwner}`) as {
          security_and_analysis?: { secret_scanning?: { status?: string }; secret_scanning_push_protection?: { status?: string } }
        }
      ).security_and_analysis
      if (enforced('secret-scanning') && sa?.secret_scanning?.status !== 'enabled') fail('secret-scanning', 'secret scanning is off')
      if (enforced('push-protection') && sa?.secret_scanning_push_protection?.status !== 'enabled')
        fail('push-protection', 'secret-scanning push protection is off')
    } catch {
      warn('secret-scanning', 'could not read security_and_analysis')
    }
  }
  try {
    const al = (ghJSON(`repos/${r.nameWithOwner}/actions/permissions`) as { allowed_actions?: string }).allowed_actions
    if (al && al !== ALLOWED_ACTIONS) warn('actions', `allowed_actions is "${al}" (standard: ${ALLOWED_ACTIONS})`)
  } catch {
    /* not always readable */
  }
  return f
}

// ── discovery ────────────────────────────────────────────────────────────────
type Target = { label: string; nameWithOwner: string | null; note?: string }
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
    return m ? { label, nameWithOwner: `${m[1]}/${m[2]}` } : { label, nameWithOwner: null, note: 'origin not on github.com' }
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
      console.error('usage: audit-repo.ts --org <org>')
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
const all: { level: Level; area: string; msg: string }[] = []

if (!jsonOut) {
  console.log(paint(C.dim, `scope: ${scope}`))
  console.log(
    paint(
      C.dim,
      `standard: files(README,LICENSE,.gitignore,.editorconfig,${KI_CONFIG}) · github(main,license,squash-only,del-branch,update-branch,issues,no-wiki/projects,desc,visibility) · public+(topics) · deeper(dependabot;secret-scanning;actions=all) · coverage[ki-repo→](${COVERAGE.map((c) => c.skill).join(',')}) · overridable via [..checks]: ${Object.keys(CHECK_DEFAULTS).join(',')},coverage-<skill>`
    )
  )
}

let totalFails = 0
let totalWarns = 0
let ghSkipped = 0
for (const t of targets) {
  if (!t.nameWithOwner) {
    ghSkipped++
    all.push({ level: 'NA', area: t.label, msg: t.note ?? '' })
    if (!jsonOut) console.log(`\n${paint(C.dim, 'NA')}  ${paint(C.cyan, t.label)} ${paint(C.dim, `— ${t.note}`)}`)
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
    findings = auditRepo(r, files, ki, kiText, signals)
  } catch {
    findings = [{ level: 'FAIL', check: 'access', msg: `could not read ${t.nameWithOwner} via gh (missing repo or insufficient scope)` }]
  }
  const fails = findings.filter((x) => x.level === 'FAIL')
  const warns = findings.filter((x) => x.level === 'WARN')
  const notes = findings.filter((x) => x.level === 'INFO')
  totalFails += fails.length
  totalWarns += warns.length
  for (const x of findings) all.push({ level: x.level, area: `${t.nameWithOwner}:${x.check}`, msg: x.msg })
  if (!jsonOut) {
    const stamp = fails.length ? paint(C.red, 'FAIL') : warns.length ? paint(C.yellow, 'WARN') : paint(C.green, 'PASS')
    console.log(`\n${stamp}  ${paint(C.cyan, t.nameWithOwner)}`)
    for (const x of fails) console.log(`  ${paint(C.red, 'fail')} ${paint(C.dim, `[${x.check}]`)} ${x.msg}`)
    for (const x of warns) console.log(`  ${paint(C.yellow, 'warn')} ${paint(C.dim, `[${x.check}]`)} ${x.msg}`)
    for (const x of notes) console.log(`  ${paint(C.dim, `info [${x.check}] ${x.msg}`)}`)
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
    return rows.length ? ['', `## ${ICON[l]} ${l} (${rows.length})`, ...rows.map((r) => `- [${r.area}] ${r.msg}`)] : []
  })
  const tally = `${targets.length} repo(s) · ${summary.fail} fail · ${summary.warn} warn · ${summary.info} info · ${summary.na} n/a`
  writeFileSync(join(reportDir, 'repo.md'), [`# repo audit — ${reportTarget}`, '', `_${stampIso}_`, '', tally, ...body, ''].join('\n'))
  writeFileSync(
    join(reportDir, 'repo.json'),
    `${JSON.stringify({ concern: 'repo', target: reportTarget, generatedAt: stampIso, summary, findings: all }, null, 2)}\n`
  )
}

if (jsonOut) {
  process.stdout.write(
    `${JSON.stringify({ concern: 'repo', target: reportTarget, generatedAt: stampIso, summary, findings: all }, null, 2)}\n`
  )
} else {
  console.log(
    `\n${paint(C.cyan, 'summary')}: ${targets.length} repo(s), ${paint(C.red, `${totalFails} fail`)}, ${paint(C.yellow, `${totalWarns} warn`)}${ghSkipped ? paint(C.dim, `, ${ghSkipped} not on github.com`) : ''}`
  )
  if (reportOut) console.log(paint(C.dim, `report → ${join(reportDir, 'repo.{md,json}')}`))
  console.log(
    paint(
      C.dim,
      'mechanical checks only — the one remaining judgment item (does the description match the repo’s purpose) is the skill’s AUDIT mode.'
    )
  )
}
process.exit(totalFails > 0 ? 1 : 0)
