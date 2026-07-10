#!/usr/bin/env bun
/**
 * Mechanical CONFORM for the Knowledge Islands repo standard — the [M] half of
 * references/repo-standard.md's "Applying it" recipe, scripted so it needn't be
 * copy-pasted by hand per repo.
 *
 * Scope: a single target repo (default cwd), matching how ki-bootstrap scaffolds
 * `ki:repo:conform` (`bun .../conform-repo.ts .`) — not an org sweep like
 * audit-repo.ts's `--org`, since conforming mutates and should be reviewed per-repo.
 *
 *   bun scripts/conform-repo.ts [path]      # default: cwd
 *   --dry-run                                # print the plan, run nothing
 *
 * Applies, via `gh`:
 *   - Layer 2: merge method (squash-only), auto-delete-branch, Wiki/Projects off,
 *     Issues on, topics (public, standard set), branch protection (present-but-off
 *     by default; stripped unless the repo's [ki-repo.checks] opts branch-protection
 *     in, in which case the standard protection set is applied).
 *   - Layer 3: Dependabot alerts + security updates, allow_update_branch, secret
 *     scanning + push protection (public), Actions allowed_actions = all.
 * Scaffolds locally (only when absent, never overwritten):
 *   - .gitignore, .editorconfig — from this skill's own templates.
 *   - .ki-config.toml's [ki-repo] block — audit-repo.ts's `--init` template.
 *
 * Deliberately NEVER touches (judgment — printed as manual TODOs instead):
 *   - README.md content, LICENSE content.
 *   - The GitHub description text, and whether visibility is the right call.
 *   - Whether a [ki-repo.checks] override is warranted for this repo.
 *   - default-branch rename (destructive; a repo not on `main` needs a deliberate,
 *     reviewed rename, not a scripted one).
 *
 * Requires `gh` authenticated with repo-admin scope. No npm dependencies.
 * Exit code is non-zero only on an unrecoverable error (can't resolve nameWithOwner).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// ── the standard (kept in sync with audit-repo.ts / references/repo-standard.md) ──
const TOPICS = ['mcp', 'model-context-protocol', 'claude', 'typescript', 'bun']
const REQUIRED_CHECK = 'build'
const ALLOWED_ACTIONS = 'all'
const CHECK_DEFAULTS: Record<string, boolean> = {
  'branch-protection': false,
  wiki: true,
  projects: true,
  issues: true,
  topics: true,
  'secret-scanning': true,
  'push-protection': true
}
const KI_CONFIG = '.ki-config.toml'
const KI_SECTION = 'ki-repo'
const KI_DEFAULT = `[${KI_SECTION}]
visibility = "private"   # "public" | "private" — must match the repo's actual GitHub visibility

# Per-repo check overrides — true = enforce, false = don't. Omit any check to take
# the org default; a repo that fully conforms needs nothing here.
# [${KI_SECTION}.checks]
# branch-protection = true   # default off — protect \`main\` on this repo
# wiki = false               # default on  — allow this repo's Wiki
`
const GITIGNORE_DEFAULT = 'node_modules/\n.DS_Store\n.ki-meta/audits/\n.ki-meta/conform/\n'
const EDITORCONFIG_DEFAULT = `root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
trim_trailing_whitespace = true
indent_style = space
indent_size = 2
`

const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m' }
const paint = (c: string, s: string): string => `${c}${s}${C.reset}`

function gh(args: string[], dryRun: boolean, label: string): void {
  if (dryRun) {
    console.log(`  ${paint(C.dim, '$')} gh ${args.join(' ')}`)
    return
  }
  try {
    execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    console.log(`  ${paint(C.green, 'ok')}    ${label}`)
  } catch (e) {
    console.log(`  ${paint(C.red, 'fail')}  ${label} — ${String((e as Error).message ?? e).split('\n')[0]}`)
  }
}
const ghJSON = (apiPath: string): unknown => JSON.parse(execFileSync('gh', ['api', apiPath], { encoding: 'utf8' }))

// Same minimal parser as audit-repo.ts.
type KiConfig = { visibility?: string; checks: Record<string, boolean> }
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
    else if (section === CHECKS_SECTION && (val === 'true' || val === 'false')) out.checks[key] = val === 'true'
  }
  return seen ? out : null
}

function gitOrigin(dir: string): string | null {
  try {
    return execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}
const GH_REMOTE = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/

// ── entry ──
const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const target = resolve(argv.find((a) => !a.startsWith('-')) ?? '.')

const origin = gitOrigin(target)
const m = origin?.match(GH_REMOTE)
if (!m) {
  console.error(paint(C.red, `${target}: origin is not on github.com (${origin ?? 'no origin'}) — nothing to conform`))
  process.exit(1)
}
const nwo = `${m[1]}/${m[2]}`

const kiPath = join(target, KI_CONFIG)
const kiText = existsSync(kiPath) ? readFileSync(kiPath, 'utf8') : ''
const ki = kiText ? parseKiConfig(kiText) : null
const enforced = (id: string): boolean => ki?.checks[id] ?? CHECK_DEFAULTS[id] ?? true

let visibility: 'PUBLIC' | 'PRIVATE' | null = null
try {
  visibility = (ghJSON(`repos/${nwo}`) as { private?: boolean }).private ? 'PRIVATE' : 'PUBLIC'
} catch {
  console.error(paint(C.red, `could not read repos/${nwo} via gh — is gh authenticated? (gh auth status)`))
  process.exit(1)
}
const isPublic = visibility === 'PUBLIC'

console.log(paint(C.dim, `target: ${nwo}   ${isPublic ? 'public' : 'private'}${dryRun ? '   (dry run)' : ''}\n`))

// ── local file scaffolding (only when absent; never overwrite) ──
function scaffold(name: string, path: string, content: string): void {
  if (existsSync(path)) return
  console.log(`  ${paint(C.green, 'write')} ${name}`)
  if (!dryRun) writeFileSync(path, content)
}
scaffold('.gitignore', join(target, '.gitignore'), GITIGNORE_DEFAULT)
scaffold('.editorconfig', join(target, '.editorconfig'), EDITORCONFIG_DEFAULT)
if (!ki) {
  console.log(
    `  ${paint(C.green, 'append')} ${KI_CONFIG} [${KI_SECTION}] block (edit \`visibility\` to match — currently templated "private")`
  )
  if (!dryRun) writeFileSync(kiPath, kiText ? `${kiText.replace(/\n*$/, '\n\n')}${KI_DEFAULT}` : KI_DEFAULT)
}

// ── Layer 2: core GitHub settings ──
console.log(`\n${paint(C.cyan, 'layer 2 — core GitHub')}`)
gh(
  [
    'repo',
    'edit',
    nwo,
    '--enable-merge-commit=false',
    '--enable-rebase-merge=false',
    '--enable-squash-merge=true',
    '--delete-branch-on-merge=true'
  ],
  dryRun,
  'squash-only + auto-delete-branch'
)
if (enforced('wiki')) gh(['repo', 'edit', nwo, '--enable-wiki=false'], dryRun, 'Wiki off')
if (enforced('projects')) gh(['repo', 'edit', nwo, '--enable-projects=false'], dryRun, 'Projects off')
if (enforced('issues')) gh(['repo', 'edit', nwo, '--enable-issues=true'], dryRun, 'Issues on')

if (isPublic && enforced('topics')) {
  const args = ['repo', 'edit', nwo]
  for (const t of TOPICS) args.push('--add-topic', t)
  gh(args, dryRun, `topics: ${TOPICS.join(', ')}`)
}

if (enforced('branch-protection')) {
  const body = JSON.stringify({
    required_status_checks: { strict: true, checks: [{ context: REQUIRED_CHECK }] },
    enforce_admins: false,
    required_pull_request_reviews: { required_approving_review_count: 0 },
    restrictions: null,
    required_linear_history: true,
    allow_force_pushes: false,
    allow_deletions: false
  })
  if (dryRun) console.log(`  ${paint(C.dim, '$')} gh api -X PUT repos/${nwo}/branches/main/protection --input - <<< ${body}`)
  else {
    try {
      execFileSync('gh', ['api', '-X', 'PUT', `repos/${nwo}/branches/main/protection`, '--input', '-'], { input: body, encoding: 'utf8' })
      console.log(`  ${paint(C.green, 'ok')}    branch protection on main (opted in via [${CHECKS_SECTION}])`)
    } catch (e) {
      console.log(`  ${paint(C.red, 'fail')}  branch protection — ${String((e as Error).message ?? e).split('\n')[0]}`)
    }
  }
} else {
  gh(['api', '-X', 'DELETE', `repos/${nwo}/branches/main/protection`], dryRun, 'strip any leftover branch protection (default: off)')
}

// ── Layer 3: deeper GitHub ──
console.log(`\n${paint(C.cyan, 'layer 3 — deeper GitHub')}`)
gh(['api', '-X', 'PUT', `repos/${nwo}/vulnerability-alerts`], dryRun, 'Dependabot alerts on')
gh(['api', '-X', 'PUT', `repos/${nwo}/automated-security-fixes`], dryRun, 'Dependabot security updates on')
gh(['api', '-X', 'PATCH', `repos/${nwo}`, '-F', 'allow_update_branch=true'], dryRun, 'always-suggest-updating-PR-branches on')
if (isPublic && (enforced('secret-scanning') || enforced('push-protection'))) {
  const sa: Record<string, unknown> = {}
  if (enforced('secret-scanning')) sa.secret_scanning = { status: 'enabled' }
  if (enforced('push-protection')) sa.secret_scanning_push_protection = { status: 'enabled' }
  const body = JSON.stringify({ security_and_analysis: sa })
  if (dryRun) console.log(`  ${paint(C.dim, '$')} gh api -X PATCH repos/${nwo} --input - <<< ${body}`)
  else {
    try {
      execFileSync('gh', ['api', '-X', 'PATCH', `repos/${nwo}`, '--input', '-'], { input: body, encoding: 'utf8' })
      console.log(`  ${paint(C.green, 'ok')}    secret scanning / push protection`)
    } catch (e) {
      console.log(`  ${paint(C.red, 'fail')}  secret scanning / push protection — ${String((e as Error).message ?? e).split('\n')[0]}`)
    }
  }
}
gh(
  ['api', '-X', 'PUT', `repos/${nwo}/actions/permissions`, '-f', `allowed_actions=${ALLOWED_ACTIONS}`],
  dryRun,
  `Actions allowed_actions=${ALLOWED_ACTIONS}`
)

// ── judgment items — never guessed, always surfaced ──
console.log(`\n${paint(C.cyan, 'manual TODOs (judgment — not scripted)')}`)
console.log(`  - README.md content: is it accurate and current for ${nwo}?`)
console.log(`  - GitHub description text: does it actually describe the repo's purpose? (sync with package.json's "description" once set)`)
console.log(`  - [${CHECKS_SECTION}] overrides: does this repo genuinely need to diverge from an org default (e.g. branch-protection)?`)
console.log(
  `\n${paint(C.dim, 'mechanical layer applied — re-run `bun scripts/audit-repo.ts .` (or `ki:repo:audit`) to confirm findings clear.')}`
)
