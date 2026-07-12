#!/usr/bin/env bun
/**
 * Mechanical auditor for the COMMON engineering layer of a Knowledge Islands
 * TypeScript/Bun repo.
 *
 *   bun scripts/audit.ts <repo-path>      # or: node after a build
 *
 * Checks the shared toolchain the `ki-engineering` skill codifies —
 * package.json metadata, the mise.toml toolchain pin (node + bun, bun matched to
 * packageManager, CI via mise-action) + the aggregate ki:audit/ki:conform entrypoints, the
 * `bun test` trap, tsconfig.json + biome.json, and the capability conditionals
 * (tests, compiled build + the cli-chmod rule, env) that fire only when the repo opts in.
 * It is deliberately PERMISSIVE about additive repo-specific scripts, and it does
 * NOT judge anything artifact-specific (an MCP's coverage-excludes, bin, tool
 * surface) — that is the artifact skill's checker (e.g. audit.ts), run after
 * this one. See references/audit-rubric.md for the judgment half.
 *
 * Output is grouped pass/warn/fail; exit code is non-zero iff any FAIL.
 * No dependencies — Node/Bun builtins only; no cross-skill imports.
 */
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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
  console.error('usage: audit.ts <repo-path>   (path must exist)')
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

// Applicability gate: ki-engineering governs the TypeScript/Bun toolchain. A repo with
// no package.json is not a TS/Bun repo — the same signal ki-repo's coverage cascade uses
// to detect engineering — so every check below is inapplicable. Emit a single NA and stop,
// rather than a wall of FAILs. Bootstrap vendors this checker into every repo via the
// ki-repo → ki-engineering implies edge, including non-code repos (dotfiles, KB, tap).
if (!has('package.json')) {
  add('NA', 'scope', 'no package.json — not a TypeScript/Bun repo; the engineering standard does not apply')
  emit(findings, repo, 'engineering', `Engineering standard audit — ${basename(repo)}  (${repo})`, '')
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
// CI installs the toolchain from mise.toml and runs the aggregate read-only gate —
// `bun run ki:audit` — which fans out over every vendored per-skill audit in
// .ki-meta (engineering's audit runs the code toolchain below; authoring's runs the
// Markdown gate). `bun run test` follows for the repo's self-tests. ki:verify is
// retired: ki:audit IS the gate now (ADR-KI-HARNESS-TOOLCHAIN-001).
if (has('.github', 'workflows', 'ci.yml')) {
  const ci = read('.github', 'workflows', 'ci.yml')
  const usesMise = /mise-action/.test(ci)
  usesMise
    ? add('PASS', 'ci', 'ci.yml installs the toolchain via jdx/mise-action')
    : add('FAIL', 'ci', 'ci.yml must install the toolchain via jdx/mise-action (reads mise.toml)')
  const hard = ci.match(/\b(bun|node)-version\s*:/)
  if (hard) add('FAIL', 'ci', `ci.yml hardcodes ${hard[1]}-version — remove it; the version comes from mise.toml`)
  ci.includes('bun run ki:audit')
    ? add('PASS', 'ci', 'ci.yml runs the aggregate gate "bun run ki:audit"')
    : add('FAIL', 'ci', 'ci.yml must run "bun run ki:audit" — the aggregate read-only gate (ki:verify is retired)')
  if (/\bki:verify\b/.test(ci)) add('WARN', 'ci', 'ci.yml still references ki:verify — retired; run "bun run ki:audit && bun run test"')
} else {
  add('NA', 'ci', 'no .github/workflows/ci.yml — not applicable')
}

// Repo shape — flat vs monorepo (§0). A flat repo is one root TS project (`tsc --noEmit`);
// a monorepo declares its packages in the standard Bun `workspaces` array in package.json
// (e.g. ["site", "ingress"]), whose per-package tsconfigs can carry incompatible
// `types`/`lib`, so it is type-checked per package rather than once at the root.
const workspaces = Array.isArray(pkg.workspaces) ? (pkg.workspaces as string[]).filter((w) => typeof w === 'string') : []

// ── core: the read-only toolchain, run directly (audit = lint WITHOUT fixing) ──
// ki:engineering:audit runs ALL the read-only checks itself — the tools live INSIDE this
// script, not behind individual ki:lint:* / ki:deps:* / ki:knip keys (those are retired,
// TOOLCHAIN-001). Biome check + the type-check + syncpack's format check + knip. The
// Markdown gate is ki-authoring's audit (prettier --check + markdownlint), run as a
// sibling in the aggregate — not repeated here.
runCheck('lint', 'biome check', 'bunx @biomejs/biome check')
if (workspaces.length) {
  const noTsconfig = workspaces.filter((p) => !read(`${p}/tsconfig.json`))
  if (noTsconfig.length) add('FAIL', 'lint', `workspaces names dir(s) without a tsconfig.json: ${noTsconfig.join(', ')}`)
  for (const ws of workspaces.filter((p) => read(`${p}/tsconfig.json`)))
    runCheck('lint', `tsc ${ws}`, `tsc --noEmit -p ${ws}/tsconfig.json`)
} else {
  runCheck('lint', 'tsc --noEmit', 'tsc --noEmit')
}
runCheck('package', 'syncpack format (check)', 'bunx syncpack format --check')
runCheck('knip', 'knip', 'bunx knip --no-config-hints')

// ── core: the aggregate entrypoints + retired-key drift ───────────────────────
// Every governed repo exposes the two aggregate entrypoints that fan out over the
// vendored per-skill modes in .ki-meta: ki:audit (read-only gate) and ki:conform (write
// pass), plus ki:init/ki:help. The per-tool ki:lint:*/ki:deps:*/ki:knip families,
// ki:verify, and any per-skill ki:<x>:lint are retired — flag them as drift.
for (const [key, label] of [
  ['ki:audit', 'aggregate read-only gate'],
  ['ki:conform', 'aggregate write pass']
] as const)
  scripts[key] ? add('PASS', 'scripts', `${key} present (${label})`) : add('FAIL', 'scripts', `script "${key}" missing (${label})`)
const retired = Object.keys(scripts).filter(
  (k) => /^ki:(lint|deps):/.test(k) || k === 'ki:knip' || k === 'ki:verify' || /^ki:[a-z-]+:lint$/.test(k)
)
retired.length
  ? add(
      'FAIL',
      'scripts',
      `retired script key(s): ${retired.join(', ')} — the ki:lint:* / ki:deps:* / ki:knip families, ki:verify, and ki:<skill>:lint are folded into ki:engineering:audit/conform, ki-authoring, and the aggregate ki:audit (TOOLCHAIN-001)`
    )
  : add('PASS', 'scripts', 'no retired ki:lint:* / ki:deps:* / ki:verify keys')

// ── core: per-skill audit/conform key coverage (derived + enforced) ───────────
// Every skill vendored into .ki-meta/skills/<skill>/ must be reachable by the DERIVED
// keys ki:<suffix>:audit / ki:<suffix>:conform (suffix = skill dir minus ki-). This is
// the mechanical half of "every vendored mode has a package.json entry". Reads .ki-meta
// only (offline-safe); ki-bootstrap is never vendored so it is not required here.
if (isDir('.ki-meta', 'skills')) {
  const metaSkills = at('.ki-meta', 'skills')
  for (const skill of readdirSync(metaSkills).filter((d) => statSync(join(metaSkills, d)).isDirectory())) {
    const suffix = skill.replace(/^ki-/, '')
    for (const mode of ['audit', 'conform'] as const) {
      if (!existsSync(join(metaSkills, skill, `${mode}.ts`))) continue
      const key = `ki:${suffix}:${mode}`
      scripts[key]
        ? add('PASS', 'scripts', `${key} wired to vendored ${skill}/${mode}.ts`)
        : add('FAIL', 'scripts', `missing script "${key}" for vendored .ki-meta/skills/${skill}/${mode}.ts`)
    }
  }
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
      `${pkgRows.length} package${pkgRows.length === 1 ? '' : 's'} have updates available — run \`bun run ki:engineering:conform\`:\n  ${out}`
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

// ── core: .prettierrc.json (backs ki-authoring's Markdown gate) ──────────────────
const prettier = read('.prettierrc.json')
if (!prettier) add('FAIL', 'prettier', '.prettierrc.json missing (Prettier backs ki-authoring audit/conform)')
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

// ── core: knip.json (backs the knip check inside ki:engineering:audit) ────────────
// knip is run directly by ki:engineering:audit (dependency + dead-code hygiene);
// every repo carries a knip.json declaring its entry points (so the public surface
// isn't misread as dead code) and any intentional ignores.
has('knip.json') || has('knip.jsonc') || has('knip.ts')
  ? add('PASS', 'knip', 'knip.json present (entry points + ignores for the knip check in ki:engineering:audit)')
  : add('FAIL', 'knip', 'knip.json missing (config for knip — run by ki:engineering:audit/conform)')

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

// ── core: capability tails + the bare test idiom (§2) ─────────────────────────
// ki:audit / ki:conform are asserted above (the aggregate gate + write pass). A repo
// with tests exposes the bare `test` idiom (the whole *.test.ts suite), run in CI after
// ki:audit; a repo that produces a compiled build should fold `build` into its conform.
{
  const conform = scripts['ki:conform'] ?? ''
  if (hasTests && !scripts['test'])
    add('FAIL', 'scripts', 'repo has tests but no bare "test" script (the whole *.test.ts suite, run after ki:audit)')
  else if (hasTests) add('PASS', 'scripts', 'bare "test" idiom present')
  if (hasBuild && !conform.includes('build'))
    add('WARN', 'scripts', 'ki:conform should append " && bun run build" (compiled-build capability)')
}

// ── capability: tests ─────────────────────────────────────────────────────────
// Vitest is the recommended runner and the ONLY one the coverage rules below apply to,
// but it is not mandated: a repo may run its self-tests another way (the harness runs
// standalone *.test.ts checker scripts via the bare `test` idiom). The vitest key-shape +
// 100%-coverage checks fire only when a vitest.config.* is actually present.
if (vitestFile) {
  const wantTest: Record<string, string> = { test: 'vitest run', 'test:coverage': 'vitest run --coverage', 'test:watch': 'vitest' }
  for (const [k, v] of Object.entries(wantTest)) {
    if (!scripts[k]) add('WARN', 'tests', `test capability: script "${k}" missing (expected ${JSON.stringify(v)})`)
    else
      scripts[k] === v
        ? add('PASS', 'tests', `${k} = ${JSON.stringify(v)}`)
        : add('FAIL', 'tests', `${k} should be ${JSON.stringify(v)}, got ${JSON.stringify(scripts[k])}`)
  }
  {
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
    // sit under a declared workspace (mirrors the per-workspace tsc check above).
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
  }
  if (scripts['test:coverage']) runCheck('tests', 'test:coverage', 'bun run test:coverage')
} else if (scripts.test) {
  add('INFO', 'tests', 'non-vitest test runner (bare `test` idiom) — the vitest key-shape + coverage rules do not apply')
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
  const tally = `FAIL=${summary.fail} WARN=${summary.warn} POLISH=${summary.polish} PASS=${summary.pass} ADVISORY=${summary.advisory} NA=${summary.na}`
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
    if (summary.fail + summary.warn + summary.polish > 0)
      console.log('→ to address: run /ki-engineering CONFORM   (judgment criteria: references/audit-rubric.md)')
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
  'Common layer only — run the artifact skill audit too (e.g. audit.ts for an MCP repo).'
)
