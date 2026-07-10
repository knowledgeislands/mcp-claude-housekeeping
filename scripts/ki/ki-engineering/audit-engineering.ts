#!/usr/bin/env bun
/**
 * Mechanical auditor for the COMMON engineering layer of a Knowledge Islands
 * TypeScript/Bun repo.
 *
 *   bun scripts/audit-engineering.ts <repo-path>      # or: node after a build
 *
 * Checks the shared toolchain the `ki-engineering` skill codifies —
 * package.json metadata, the mise.toml toolchain pin (node + bun, bun matched to
 * packageManager, CI via mise-action) + the ki:lint:* / ki:deps:* script families, the
 * `bun test` trap, tsconfig.json + biome.json, and the capability conditionals
 * (tests, compiled build + the cli-chmod rule, env) that fire only when the repo opts in.
 * It is deliberately PERMISSIVE about additive repo-specific scripts, and it does
 * NOT judge anything artifact-specific (an MCP's coverage-excludes, bin, tool
 * surface) — that is the artifact skill's checker (e.g. audit-mcp.ts), run after
 * this one. See references/audit-rubric.md for the judgment half.
 *
 * Output is grouped pass/warn/fail; exit code is non-zero iff any FAIL.
 * No dependencies — Node/Bun builtins only; no cross-skill imports.
 */
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

// Unified severity ladder — shared by every KI checker (enforcement-framework §2).
type Level = 'FAIL' | 'WARN' | 'POLISH' | 'ADVISORY' | 'INFO' | 'NA' | 'PASS'
type Finding = { level: Level; area: string; msg: string }
const ORDER: Level[] = ['FAIL', 'WARN', 'POLISH', 'ADVISORY', 'INFO', 'NA', 'PASS']
const ICON: Record<Level, string> = { FAIL: '❌', WARN: '⚠️ ', POLISH: '✨', ADVISORY: '🧭', INFO: 'ℹ️ ', NA: '⊘', PASS: '✅' }
const findings: Finding[] = []
const add = (level: Level, area: string, msg: string) => findings.push({ level, area, msg })

const repo = process.argv[2]
if (!repo || !existsSync(repo)) {
  console.error('usage: audit-engineering.ts <repo-path>   (path must exist)')
  process.exit(2)
}
const at = (...p: string[]) => join(repo, ...p)
function runCheck(area: string, label: string, cmd: string) {
  try {
    execSync(cmd, { cwd: repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    add('PASS', area, `${label} exits 0`)
  } catch (e: unknown) {
    const err = e as { stderr?: string; stdout?: string }
    const detail = (err.stderr ?? err.stdout ?? '').trim()
    add('FAIL', area, detail ? `${label} failed:\n  ${detail.split('\n').join('\n  ')}` : `${label} failed`)
  }
}
const has = (...p: string[]) => existsSync(at(...p))
const isDir = (...p: string[]) => has(...p) && statSync(at(...p)).isDirectory()
const read = (...p: string[]): string => {
  try {
    return readFileSync(at(...p), 'utf8')
  } catch {
    return ''
  }
}

let pkg: Record<string, unknown> = {}
try {
  pkg = JSON.parse(read('package.json'))
} catch {
  add('FAIL', 'package', 'package.json missing or unparseable')
}
const scripts = (pkg.scripts ?? {}) as Record<string, string>
const name = String(pkg.name ?? basename(repo))

// ── core: package.json metadata ───────────────────────────────────────────────
pkg.type === 'module'
  ? add('PASS', 'package', 'type = "module"')
  : add('FAIL', 'package', `type should be "module", got ${JSON.stringify(pkg.type)}`)
String(pkg.packageManager ?? '').startsWith('bun@')
  ? add('PASS', 'package', `packageManager = ${pkg.packageManager}`)
  : add('FAIL', 'package', `packageManager should be bun@…, got ${JSON.stringify(pkg.packageManager)}`)
const nodeEngine = String((pkg.engines as Record<string, string> | undefined)?.node ?? '')
const nodeOk = (() => {
  const m = nodeEngine.match(/>=\s*(\d+)/)
  return m ? Number(m[1]) >= 22 : false
})()
add(
  nodeOk ? 'PASS' : 'FAIL',
  'package',
  nodeOk ? `engines.node = ${nodeEngine}` : `engines.node should be >=22, got ${JSON.stringify(nodeEngine)}`
)

// ── core: the coverage manifest — package.json is a CLOSED top-level key set ───
// Every top-level key must be in the manifest (engineering-standard §1), each mapped
// to an owning skill. An unknown key is drift: it would be an element no rubric drives.
// This is the exhaustiveness half that makes "every element is governed" hold by
// construction — the per-key CONTENT rules live in the owning skill's checker.
const ALLOWED_KEYS = new Set<string>([
  // identity & metadata → ki-repo
  'name',
  'version',
  'description',
  'author',
  'license',
  'private',
  'repository',
  'homepage',
  'bugs',
  'keywords',
  // toolchain & structure → ki-engineering
  'type',
  'packageManager',
  'engines',
  'scripts',
  'devDependencies',
  'dependencies',
  'workspaces',
  'lint-staged',
  // published-artifact surface → the artifact skill (e.g. ki-mcp)
  'main',
  'bin',
  'exports',
  'files'
])
const unknownKeys = Object.keys(pkg).filter((k) => !ALLOWED_KEYS.has(k))
unknownKeys.length
  ? add(
      'FAIL',
      'package',
      `ungoverned package.json key(s): ${unknownKeys.join(', ')} — every top-level key must be in the coverage manifest (engineering-standard §1) and assigned an owner`
    )
  : add('PASS', 'package', 'all top-level keys are in the coverage manifest')

// ── core: lint-staged block + toolchain devDependencies (§1/§5) ───────────────
// The lint:* / deps:* / prepare families above invoke a fixed toolchain; assert that
// toolchain is actually declared, rather than left implied. lint-staged is the husky
// pre-commit fan-out — a governed key in the manifest, so it must be present and wired.
const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>
const REQUIRED_DEV = ['@biomejs/biome', 'knip', 'prettier', 'husky', 'lint-staged', 'markdownlint-cli2', 'syncpack', 'typescript']
const missingDev = REQUIRED_DEV.filter((d) => !(d in devDeps))
missingDev.length
  ? add(
      'FAIL',
      'package',
      `missing toolchain devDependencies: ${missingDev.join(', ')} (the lint:* / format / type toolchain the families invoke)`
    )
  : add(
      'PASS',
      'package',
      'toolchain devDependencies present (biome, prettier, husky, lint-staged, markdownlint-cli2, syncpack, typescript)'
    )
const lintStaged = pkg['lint-staged']
if (!lintStaged || typeof lintStaged !== 'object') {
  add('FAIL', 'package', 'lint-staged block missing (the husky pre-commit fan-out)')
} else {
  const ls = JSON.stringify(lintStaged)
  ls.includes('@biomejs/biome') && ls.includes('prettier') && ls.includes('markdownlint')
    ? add('PASS', 'package', 'lint-staged fans out to biome (code) + prettier/markdownlint (Markdown)')
    : add('WARN', 'package', 'lint-staged should run @biomejs/biome on code and prettier + markdownlint on *.md')
}

// ── core: mise.toml toolchain pin ─────────────────────────────────────────────
// Root mise.toml pins the actual node + bun (mise puts them on PATH on `cd`; CI
// installs them via jdx/mise-action). The pinned bun MUST equal packageManager's
// bun — the standing drift pair. node is pinned exactly here (engines is a floor).
const mise = read('mise.toml')
if (!mise) add('FAIL', 'mise', 'mise.toml missing (root toolchain pin: [tools] node + bun)')
else {
  const miseNode = mise.match(/^\s*node\s*=\s*["']([^"']+)["']/m)?.[1]
  const miseBun = mise.match(/^\s*bun\s*=\s*["']([^"']+)["']/m)?.[1]
  miseNode ? add('PASS', 'mise', `mise.toml pins node = ${miseNode}`) : add('FAIL', 'mise', 'mise.toml must pin node under [tools]')
  if (!miseBun) add('FAIL', 'mise', 'mise.toml must pin bun under [tools]')
  else {
    const pmBun = String(pkg.packageManager ?? '').match(/^bun@(.+)$/)?.[1]
    pmBun && pmBun !== miseBun
      ? add('FAIL', 'mise', `mise.toml bun (${miseBun}) must match packageManager bun (${pmBun})`)
      : add('PASS', 'mise', `mise.toml pins bun = ${miseBun}${pmBun ? ' (matches packageManager)' : ''}`)
  }
}
// legacy single-tool pin files shadow mise.toml — warn (redundant, can diverge)
const strayPins = ['.node-version', '.nvmrc', '.bun-version'].filter((f) => has(f))
strayPins.length
  ? add('WARN', 'mise', `legacy pin file(s) beside mise.toml: ${strayPins.join(', ')} — remove; mise.toml is the single toolchain pin`)
  : add('PASS', 'mise', 'no legacy pin files (.node-version / .nvmrc / .bun-version)')

// ── core (when the repo has CI): the common CI shape ──────────────────────────
// CI installs the toolchain from mise.toml and runs a SINGLE gate step — `bun run
// ki:verify` — which composes the read-only gate (ki:lint:check → ki:lint:types →
// ki:lint:md:check, + build/test:coverage tails). The Markdown gate inside it is
// load-bearing: ki:lint:md self-heals locally with --write, so only its --check twin
// in ki:verify stops prose-wrap drift reaching main. A ki:test:smoke step that follows
// in an MCP repo is the artifact delta — asserted by audit-mcp.ts, not here.
if (has('.github', 'workflows', 'ci.yml')) {
  const ci = read('.github', 'workflows', 'ci.yml')
  const usesMise = /mise-action/.test(ci)
  usesMise
    ? add('PASS', 'ci', 'ci.yml installs the toolchain via jdx/mise-action')
    : add('FAIL', 'ci', 'ci.yml must install the toolchain via jdx/mise-action (reads mise.toml)')
  const hard = ci.match(/\b(bun|node)-version\s*:/)
  if (hard) add('FAIL', 'ci', `ci.yml hardcodes ${hard[1]}-version — remove it; the version comes from mise.toml`)
  ci.includes('bun run ki:verify')
    ? add('PASS', 'ci', 'ci.yml runs the single gate step "bun run ki:verify"')
    : add('FAIL', 'ci', 'ci.yml must run "bun run ki:verify" — the single composed gate step (§1, §2)')
} else {
  add('NA', 'ci', 'no .github/workflows/ci.yml — not applicable')
}

// Structural execution checks — verify the actual commands pass, not just that they are declared.
// ki:lint:md:check is excluded: it is formatter-state-sensitive and fails on uncommitted edits.
if (scripts['ki:lint:check']) runCheck('lint', 'ki:lint:check', 'bun run ki:lint:check')
if (scripts['ki:lint:types']) runCheck('lint', 'ki:lint:types', 'bun run ki:lint:types')

// Repo shape — flat vs monorepo (§0). The canonical `ki:lint:types = "tsc --noEmit"`
// assumes one root TS project (the flat shape). A monorepo declares its packages in
// the standard Bun `workspaces` array in package.json (e.g. ["site", "ingress"]);
// their per-package tsconfigs can carry incompatible `types`/`lib`, so one root
// `tsc --noEmit` cannot type-check them all. When `workspaces` is present, `ki:lint:types`
// is validated as a per-package aggregate against that list instead of the literal.
const workspaces = Array.isArray(pkg.workspaces) ? (pkg.workspaces as string[]).filter((w) => typeof w === 'string') : []

// ── core: the required script families (exact-match) ──────────────────────────
const CANON: Record<string, string> = {
  'ki:lint:check': 'bunx @biomejs/biome check',
  'ki:lint:fix': 'bunx @biomejs/biome check --write --unsafe',
  'ki:lint:format': 'bunx @biomejs/biome format --write',
  'ki:lint:md': 'bunx prettier --write "**/*.md" --ignore-path .gitignore && bunx markdownlint-cli2',
  'ki:lint:md:check': 'bunx prettier --check "**/*.md" --ignore-path .gitignore && bunx markdownlint-cli2',
  'ki:lint:package': 'bunx syncpack format',
  'ki:lint:types': 'tsc --noEmit',
  'ki:deps:check': 'bunx knip --dependencies --no-config-hints',
  'ki:deps:fix': 'bunx knip --dependencies --fix --no-config-hints',
  'ki:deps:refresh': 'bun update --force',
  'ki:deps:update': 'bun update --latest && bun install',
  'ki:knip': 'bunx knip --no-config-hints'
}
for (const [k, v] of Object.entries(CANON)) {
  if (k === 'ki:lint:types' && workspaces.length) {
    // monorepo shape (workspaces in package.json): validate the per-package aggregate, not the single-root literal
    const lt = scripts['ki:lint:types'] ?? ''
    const noTsconfig = workspaces.filter((p) => !read(`${p}/tsconfig.json`))
    const uncovered = workspaces.filter((p) => !lt.includes(p))
    if (!lt) add('FAIL', 'scripts', 'script "ki:lint:types" missing (required ki:lint:* family)')
    else if (noTsconfig.length) add('FAIL', 'scripts', `workspaces names dir(s) without a tsconfig.json: ${noTsconfig.join(', ')}`)
    else if (uncovered.length)
      add('FAIL', 'scripts', `ki:lint:types must cover every workspace; not referenced: ${uncovered.join(', ')}\n        got:  ${lt}`)
    else add('PASS', 'scripts', `ki:lint:types aggregates workspaces [${workspaces.join(', ')}]`)
    continue
  }
  if (!scripts[k]) add('FAIL', 'scripts', `script "${k}" missing (required ${k.split(':').slice(0, 2).join(':')}:* family)`)
  else if (scripts[k] === v) add('PASS', 'scripts', `${k} matches canonical`)
  else add('FAIL', 'scripts', `${k} diverges from canonical\n        want: ${v}\n        got:  ${scripts[k]}`)
}
// clean (removes node_modules; may also remove dist) + prepare = husky
scripts.clean?.includes('node_modules')
  ? add('PASS', 'scripts', `clean = ${JSON.stringify(scripts.clean)}`)
  : add('FAIL', 'scripts', 'clean must remove node_modules (e.g. "rm -rf {dist,node_modules}")')
scripts.prepare === 'husky'
  ? add('PASS', 'scripts', 'prepare = "husky"')
  : add('WARN', 'scripts', `prepare should be "husky", got ${JSON.stringify(scripts.prepare)}`)

// ── core: the ki: naming law — every script is a bare idiom or ki:-prefixed ────
// engineering-standard §2: a script is valid iff it is one of the six universal
// lifecycle idioms OR carries the ki: prefix. A bare non-idiom name is drift — this
// is what keeps the script surface fully governed (every ki:* script is asserted by
// some KI skill; the artifact/governance skills own their ki:* deltas).
const BARE_IDIOMS = new Set<string>(['build', 'prepare', 'test', 'test:coverage', 'test:watch', 'clean'])
const offenders = Object.keys(scripts).filter((k) => !BARE_IDIOMS.has(k) && !k.startsWith('ki:'))
offenders.length
  ? add(
      'FAIL',
      'scripts',
      `ungoverned script name(s): ${offenders.join(', ')} — every script must be a bare lifecycle idiom (${[...BARE_IDIOMS].join(', ')}) or carry the ki: prefix (engineering-standard §2)`
    )
  : add('PASS', 'scripts', 'all scripts are bare idioms or ki:-prefixed (naming law)')

// ── advisory: dependency freshness (bun outdated) ────────────────────────────
try {
  const out = execSync('bun outdated', { cwd: repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  const pkgRows = out.split('\n').filter((l) => l.includes('│') && !l.includes('Package') && !l.includes('Current'))
  if (pkgRows.length === 0) {
    add('PASS', 'deps', 'all packages up to date (bun outdated)')
  } else {
    add(
      'ADVISORY',
      'deps',
      `${pkgRows.length} package${pkgRows.length === 1 ? '' : 's'} have updates available — run \`bun run ki:deps:update\`:\n  ${out}`
    )
  }
} catch {
  add('NA', 'deps', 'bun outdated unavailable — upgrade Bun to check dependency freshness')
}

// ── core: the `bun test` trap ─────────────────────────────────────────────────
const bunTest = Object.entries(scripts).filter(([, v]) => /\bbun test\b/.test(v))
bunTest.length
  ? add('FAIL', 'scripts', `uses "bun test" (Bun's runner, not vitest) in: ${bunTest.map(([k]) => k).join(', ')}`)
  : add('PASS', 'scripts', 'no "bun test" anywhere')

// ── core: tsconfig.json (universal invariants only; richer base is profiled) ──
// tsconfig may carry // comments (the website's does), so check by regex on text,
// not JSON.parse. Only the invariants ALL repos share are core; the fuller shared
// base (es2024, verbatimModuleSyntax, the noImplicit* family, vitest/globals types)
// is checked under the compiled-build capability below.
const ts = read('tsconfig.json')
if (!ts) add('FAIL', 'tsconfig', 'tsconfig.json missing')
else {
  const tsCore: [string, RegExp][] = [
    ['strict: true', /"strict"\s*:\s*true/],
    ['module: nodenext', /"module"\s*:\s*"nodenext"/i],
    ['moduleResolution: nodenext', /"moduleResolution"\s*:\s*"nodenext"/i],
    ['noEmit: true', /"noEmit"\s*:\s*true/],
    ['isolatedModules: true', /"isolatedModules"\s*:\s*true/],
    ['esModuleInterop: true', /"esModuleInterop"\s*:\s*true/],
    ['skipLibCheck: true', /"skipLibCheck"\s*:\s*true/]
  ]
  for (const [label, re] of tsCore)
    re.test(ts) ? add('PASS', 'tsconfig', label) : add('FAIL', 'tsconfig', `tsconfig.json missing universal invariant: ${label}`)
}

// ── core: biome.json (shared FIELDS, not byte-identical — files globs vary) ───
const biome = read('biome.json')
if (!biome) add('FAIL', 'biome', 'biome.json missing')
else {
  const fields: [string, RegExp][] = [
    ['formatter lineWidth 140', /"lineWidth"\s*:\s*140/],
    ['formatter indentWidth 2', /"indentWidth"\s*:\s*2/],
    ['js quoteStyle single', /"quoteStyle"\s*:\s*"single"/],
    ['js semicolons asNeeded', /"semicolons"\s*:\s*"asNeeded"/],
    ['js trailingCommas none', /"trailingCommas"\s*:\s*"none"/],
    ['linter preset recommended', /"recommended"|"preset"\s*:\s*"recommended"/],
    ['noExplicitAny off', /"noExplicitAny"\s*:\s*"off"/],
    ['organizeImports on', /"organizeImports"\s*:\s*"on"/]
  ]
  for (const [label, re] of fields) re.test(biome) ? add('PASS', 'biome', label) : add('WARN', 'biome', `biome.json: expected ${label}`)
}

// ── core: .prettierrc.json (backs ki:lint:md — Markdown only) ────────────────────
const prettier = read('.prettierrc.json')
if (!prettier) add('FAIL', 'prettier', '.prettierrc.json missing (Prettier backs ki:lint:md)')
else {
  const pfields: [string, RegExp][] = [
    ['proseWrap never', /"proseWrap"\s*:\s*"never"/],
    ['printWidth 140', /"printWidth"\s*:\s*140/],
    ['semi false', /"semi"\s*:\s*false/],
    ['singleQuote true', /"singleQuote"\s*:\s*true/],
    ['trailingComma none', /"trailingComma"\s*:\s*"none"/],
    ['*.md markdown override', /"parser"\s*:\s*"markdown"/]
  ]
  for (const [label, re] of pfields)
    re.test(prettier) ? add('PASS', 'prettier', label) : add('WARN', 'prettier', `.prettierrc.json: expected ${label}`)
}

// ── core: knip.json (backs ki:knip / ki:deps:* — dependency + dead-code hygiene) ──
// knip is the single tool behind ki:deps:check/fix and ki:knip (which gates ki:verify);
// every repo carries a knip.json declaring its entry points (so the public surface
// isn't misread as dead code) and any intentional ignores.
has('knip.json') || has('knip.jsonc') || has('knip.ts')
  ? add('PASS', 'knip', 'knip.json present (entry points + ignores for ki:knip / ki:deps:*)')
  : add('FAIL', 'knip', 'knip.json missing (config for knip — backs ki:knip and the ki:deps:* family)')

// ── capability detection ──────────────────────────────────────────────────────
const vitestFile = ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mts'].find((f) => has(f))
const hasTests = Boolean(vitestFile) || Boolean(scripts.test)
const buildScript = scripts.build ?? ''
const hasBuild = has('tsconfig.build.json') || /\btsc\b/.test(buildScript)
const hasCli = isDir('src', 'cli')
const envExample = ['.env.example', '.env.development.example'].find((f) => has(f))
const usesLoadEnv = (() => {
  const cfg = read('src', 'config', 'index.ts')
  return cfg.includes('process.loadEnvFile')
})()
const hasEnv = Boolean(envExample) || usesLoadEnv

// ── core: the unified conformance entrypoints (§2) ────────────────────────────
// ki:conform (write) composes ki:deps:refresh → ki:lint:package → ki:lint:format → ki:lint:fix →
// ki:lint:md (+ build/test tails); ki:verify (read-only) mirrors the CI gate: ki:lint:check
// → ki:lint:types → ki:lint:md:check (+ build/test:coverage tails). Both required everywhere.
{
  const conform = scripts['ki:conform'] ?? ''
  const verify = scripts['ki:verify'] ?? ''
  if (!conform) add('FAIL', 'scripts', 'script "ki:conform" missing (unified write-pass entrypoint, §2)')
  else {
    const wantConform = ['ki:deps:refresh', 'ki:lint:package', 'ki:lint:format', 'ki:lint:fix', 'ki:lint:md']
    const missing = wantConform.filter((s) => !conform.includes(s))
    missing.length
      ? add('WARN', 'scripts', `ki:conform should compose ${wantConform.join(' → ')}; not referenced: ${missing.join(', ')}`)
      : add('PASS', 'scripts', 'ki:conform composes the write families')
    if (hasBuild && !conform.includes('build'))
      add('WARN', 'scripts', 'ki:conform should append " && bun run build" (compiled-build capability)')
    if (hasTests && !/\btest\b/.test(conform)) add('WARN', 'scripts', 'ki:conform should append " && bun run test" (tests capability)')
  }
  if (!verify) add('FAIL', 'scripts', 'script "ki:verify" missing (unified read-only gate entrypoint, §2)')
  else {
    const wantVerify = ['ki:lint:check', 'ki:lint:types', 'ki:lint:md:check', 'ki:knip']
    const missing = wantVerify.filter((s) => !verify.includes(s))
    missing.length
      ? add('FAIL', 'scripts', `ki:verify must mirror the CI gate ${wantVerify.join(' → ')}; not referenced: ${missing.join(', ')}`)
      : add('PASS', 'scripts', 'ki:verify mirrors the CI gate')
    if (hasBuild && !verify.includes('build'))
      add('WARN', 'scripts', 'ki:verify should include "bun run build" (compiled-build capability)')
    if (hasTests && !verify.includes('test:coverage'))
      add('WARN', 'scripts', 'ki:verify should include "bun run test:coverage" (tests capability)')
  }
}

// ── capability: tests ─────────────────────────────────────────────────────────
if (hasTests) {
  const wantTest: Record<string, string> = { test: 'vitest run', 'test:coverage': 'vitest run --coverage', 'test:watch': 'vitest' }
  for (const [k, v] of Object.entries(wantTest)) {
    if (!scripts[k]) add('WARN', 'tests', `test capability: script "${k}" missing (expected ${JSON.stringify(v)})`)
    else
      scripts[k] === v
        ? add('PASS', 'tests', `${k} = ${JSON.stringify(v)}`)
        : add('FAIL', 'tests', `${k} should be ${JSON.stringify(v)}, got ${JSON.stringify(scripts[k])}`)
  }
  if (vitestFile) {
    const vc = read(vitestFile)
    const covOk = /lines:\s*100/.test(vc) && /branches:\s*100/.test(vc) && /functions:\s*100/.test(vc) && /statements:\s*100/.test(vc)
    add(
      covOk ? 'PASS' : 'FAIL',
      'tests',
      covOk
        ? 'coverage thresholds 100% on all four metrics'
        : 'coverage thresholds must be 100/100/100/100 (lines/functions/branches/statements)'
    )
    const excludesTest = /exclude\s*:/.test(vc) && /\*\*\/\*\.test\.ts/.test(vc)
    add(
      excludesTest ? 'PASS' : 'WARN',
      'tests',
      excludesTest
        ? 'coverage excludes src/**/*.test.ts'
        : 'coverage should exclude src/**/*.test.ts (other excludes are artifact-specific)'
    )
    // monorepo shape (§0): per-workspace artifacts and test globs are scoped to the owning
    // workspace dir, never the repo root. Check the vitest reportsDirectory and include globs
    // sit under a declared workspace (mirrors the ki:lint:types per-workspace check above).
    if (workspaces.length) {
      const underWs = (p: string) => workspaces.some((w) => p === w || p.startsWith(`${w}/`))
      const rd = vc.match(/reportsDirectory\s*:\s*['"]([^'"]+)['"]/)?.[1]
      add(
        rd && underWs(rd) ? 'PASS' : 'WARN',
        'tests',
        rd && underWs(rd)
          ? `monorepo: coverage reportsDirectory "${rd}" is under a workspace`
          : `monorepo (§0): set the vitest coverage reportsDirectory under the owning workspace (e.g. "site/coverage"), not the repo root — ${rd ? `got "${rd}"` : 'none set (defaults to root coverage/)'}`
      )
      const globs = [...vc.matchAll(/include\s*:\s*\[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]))
      const escaped = globs.filter((g) => !underWs(g))
      if (escaped.length)
        add(
          'WARN',
          'tests',
          `monorepo (§0): vitest include glob(s) not under a workspace dir: ${escaped.join(', ')} — scope tests/coverage to the owning workspace (e.g. site/scripts/**/*.test.ts)`
        )
    }
  } else {
    add('WARN', 'tests', 'a test script is present but no vitest.config.* — confirm the runner is vitest')
  }
  if (scripts['test:coverage']) runCheck('tests', 'test:coverage', 'bun run test:coverage')
} else {
  add('NA', 'tests', 'no test capability (no vitest.config / test script) — not applicable')
}

// ── capability: compiled build + the cli-chmod rule ───────────────────────────
if (hasBuild) {
  buildScript.startsWith('tsc -p tsconfig.build.json')
    ? add('PASS', 'build', 'build = tsc -p tsconfig.build.json')
    : add('FAIL', 'build', `build should start with "tsc -p tsconfig.build.json", got ${JSON.stringify(buildScript)}`)
  Array.isArray(pkg.files) && (pkg.files as string[]).includes('dist')
    ? add('PASS', 'build', 'files includes "dist"')
    : add('FAIL', 'build', 'files should include "dist"')
  // tsconfig.build.json shape
  const tb = read('tsconfig.build.json')
  if (!tb) add('FAIL', 'build', 'compiled build but tsconfig.build.json missing')
  else {
    const tbChecks: [string, RegExp][] = [
      ['extends ./tsconfig.json', /"extends"\s*:\s*"\.\/tsconfig\.json"/],
      ['noEmit: false', /"noEmit"\s*:\s*false/],
      ['declaration: true', /"declaration"\s*:\s*true/],
      ['outDir ./dist', /"outDir"\s*:\s*"\.\/dist"/],
      ['noUncheckedIndexedAccess: true', /"noUncheckedIndexedAccess"\s*:\s*true/],
      ['excludes **/*.test.ts', /\*\*\/\*\.test\.ts/]
    ]
    for (const [label, re] of tbChecks)
      re.test(tb) ? add('PASS', 'build', `tsconfig.build.json ${label}`) : add('WARN', 'build', `tsconfig.build.json: expected ${label}`)
  }
  // the richer shared base lives in the compiled-TS profile — WARN, not FAIL
  const tsBase: [string, RegExp][] = [
    ['target es2024', /"target"\s*:\s*"es2024"/i],
    ['verbatimModuleSyntax: true', /"verbatimModuleSyntax"\s*:\s*true/],
    ['noUnusedLocals: true', /"noUnusedLocals"\s*:\s*true/]
  ]
  for (const [label, re] of tsBase)
    re.test(ts)
      ? add('PASS', 'build', `tsconfig.json (shared base) ${label}`)
      : add('WARN', 'build', `tsconfig.json (shared base) should set ${label}`)
  // CLI chmod rule: build chmods EXACTLY dist/cli/cli.js iff src/cli/, and nothing else.
  const chmodTargets = [...buildScript.matchAll(/chmod\s+\+x\s+([^&|;]+)/g)].flatMap((m) => m[1].trim().split(/\s+/)).filter(Boolean)
  const allowed = hasCli ? ['dist/cli/cli.js'] : []
  const unexpected = chmodTargets.filter((t) => !allowed.includes(t))
  const missing = allowed.filter((t) => !chmodTargets.includes(t))
  if (unexpected.length)
    add(
      'FAIL',
      'build',
      `build chmods unexpected target(s): ${unexpected.join(', ')} — chmod only dist/cli/cli.js (iff src/cli/), never the server bin`
    )
  if (missing.length) add('WARN', 'build', `src/cli/ exists but build does not chmod +x ${missing.join(', ')}`)
  if (!unexpected.length && !missing.length)
    add('PASS', 'build', hasCli ? 'build chmods exactly dist/cli/cli.js' : 'build chmods nothing (no src/cli/) — correct')
} else {
  add('NA', 'build', 'no compiled-tsc build capability — not applicable')
}

// ── capability: env config ────────────────────────────────────────────────────
if (hasEnv) {
  envExample
    ? add('PASS', 'env', `${envExample} present`)
    : add('WARN', 'env', 'loads env (process.loadEnvFile) but no .env*.example template committed')
  // NODE_ENV=development must appear only in dev/inspect scripts
  const devKeys = (k: string) => /:(dev|inspect)\b/.test(k) || k.endsWith(':dev') || k.endsWith(':inspect')
  const leaks = Object.entries(scripts).filter(([k, v]) => v.includes('NODE_ENV=development') && !devKeys(k))
  leaks.length
    ? add('FAIL', 'env', `NODE_ENV=development outside a dev/inspect script: ${leaks.map(([k]) => k).join(', ')}`)
    : add('PASS', 'env', 'NODE_ENV=development only in dev/inspect scripts')
} else {
  add('NA', 'env', 'no env capability — not applicable')
}

// ── core: .ki-config.toml [ki-engineering] table ────────────────
const ki = read('.ki-config.toml')
if (!ki) add('WARN', 'ki-config', '.ki-config.toml missing (ki-repo owns the contract)')
else if (!/^\[ki-engineering\]/m.test(ki)) {
  add('WARN', 'ki-config', 'no [ki-engineering] table — add it to mark this repo as governed by the engineering standard')
} else {
  add('PASS', 'ki-config', '[ki-engineering] table present')
  // validate-down: the table is a conformance marker only — it carries no keys. Repo
  // shape (flat vs monorepo) is read from package.json `workspaces` (§0), a standard Bun
  // convention, not a bespoke key here. Any key directly under the table is drift.
  const body = ki.split(/^\[ki-engineering\]/m)[1]?.split(/^\[/m)[0] ?? ''
  const KNOWN = new Set<string>() // no keys defined; only a [ki-engineering.checks] sub-table is allowed
  for (const m of body.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=/gm)) {
    KNOWN.has(m[1])
      ? add('PASS', 'ki-config', `known key ${m[1]}`)
      : add('WARN', 'ki-config', `unknown key under [ki-engineering]: ${m[1]} (validate-down)`)
  }
}

// ── report ────────────────────────────────────────────────────────────────────
// Shared emit harness — copy verbatim across KI checkers (enforcement-framework §2/§5).
// Renders the painted table by default, JSON on `--json`, and writes the latest
// report under <target>/.ki-meta/audits/<concern>.{md,json} on `--report [dir]`.
function emit(items: Finding[], target: string, concern: string, title: string, footer: string): never {
  const argv = process.argv.slice(2)
  const json = argv.includes('--json')
  const ri = argv.indexOf('--report')
  const report = ri !== -1
  const reportDir = report && argv[ri + 1] && !argv[ri + 1].startsWith('-') ? argv[ri + 1] : join(target, '.ki-meta', 'audits')

  const n = (l: Level): number => items.filter((f) => f.level === l).length
  const summary = {
    fail: n('FAIL'),
    warn: n('WARN'),
    polish: n('POLISH'),
    advisory: n('ADVISORY'),
    info: n('INFO'),
    na: n('NA'),
    pass: n('PASS')
  }
  const tally = `${summary.fail} fail · ${summary.warn} warn · ${summary.polish} polish · ${summary.pass} pass  ·  ${summary.advisory} advisory · ${summary.na} n/a`
  const stamp = new Date().toISOString()

  if (report) {
    mkdirSync(reportDir, { recursive: true })
    const body = ORDER.flatMap((l) => {
      const rows = items.filter((f) => f.level === l)
      return rows.length ? ['', `## ${ICON[l]} ${l} (${rows.length})`, ...rows.map((r) => `- [${r.area}] ${r.msg}`)] : []
    })
    writeFileSync(join(reportDir, `${concern}.md`), [`# ${concern} audit — ${target}`, '', `_${stamp}_`, '', tally, ...body, ''].join('\n'))
    writeFileSync(
      join(reportDir, `${concern}.json`),
      `${JSON.stringify({ concern, target, generatedAt: stamp, summary, findings: items }, null, 2)}\n`
    )
  }

  if (json) {
    process.stdout.write(`${JSON.stringify({ concern, target, generatedAt: stamp, summary, findings: items }, null, 2)}\n`)
  } else {
    console.log(`\n${title}\n${'─'.repeat(60)}`)
    for (const l of ORDER) {
      const rows = items.filter((f) => f.level === l)
      if (!rows.length) continue
      console.log(`\n${ICON[l]} ${l} (${rows.length})`)
      for (const r of rows) console.log(`   [${r.area}] ${r.msg}`)
    }
    console.log(`\n${'─'.repeat(60)}\n${tally}`)
    if (footer) console.log(footer)
    if (report) console.log(`report → ${join(reportDir, `${concern}.{md,json}`)}`)
    console.log('')
  }
  process.exit(summary.fail ? 1 : 0)
}

add('INFO', 'scope', 'engineering common layer — compose with the artifact-skill audit for full coverage')
add('ADVISORY', 'judgment', 'mechanical layer only — apply the [J] criteria in references/audit-rubric.md by reading')

emit(
  findings,
  repo,
  'engineering',
  `Engineering standard audit — ${name}  (${repo})`,
  'Common layer only — run the artifact skill audit too (e.g. audit-mcp.ts for an MCP repo).'
)
