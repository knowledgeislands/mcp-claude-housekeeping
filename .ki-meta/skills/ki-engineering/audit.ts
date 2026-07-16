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
 * Each finding carries a minted rubric code (PKG-*, MISE-*, SCR-*, …), a
 * reference-doc pointer (`ref`), and — when file-scoped — the path it concerns
 * (`file`); all three ride into `--json` so the aggregate renders a cited finding.
 * The one-to-one code↔criterion map is references/audit-rubric.md.
 *
 * Output is grouped pass/warn/fail; exit code is non-zero iff any FAIL.
 * No dependencies — Node/Bun builtins only; no cross-skill imports.
 */
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

// Unified severity ladder — shared by every KI checker (enforcement-framework §2).
// area is the minted rubric code (references/audit-rubric.md); ref is its
// reference-doc pointer; file names the path a file-scoped finding concerns.
// ref/file are optional and ride into --json for the aggregate to render.
type Level = 'FAIL' | 'WARN' | 'POLISH' | 'ADVISORY' | 'INFO' | 'NA' | 'PASS'
type Finding = { level: Level; area: string; msg: string; ref?: string; file?: string }
const ORDER: Level[] = ['FAIL', 'WARN', 'POLISH', 'ADVISORY', 'INFO', 'NA', 'PASS']
const ICON: Record<Level, string> = { FAIL: '❌', WARN: '⚠️', POLISH: '✨', ADVISORY: '🧭', INFO: 'ℹ️', NA: '🚫', PASS: '✅' }
const findings: Finding[] = []
const add = (level: Level, area: string, msg: string, ref?: string, file?: string) => findings.push({ level, area, msg, ref, file })

// Reference-doc pointers — the substantive standard (cited by every minted code) and
// the rubric that maps code↔criterion (cited by the judgment/scope handoff).
const STD = 'references/engineering-standard.md'
const RUBRIC = 'references/audit-rubric.md'

const repo = process.argv[2]
if (!repo || !existsSync(repo)) {
  console.error('usage: audit.ts <repo-path>   (path must exist)')
  process.exit(2)
}
const at = (...p: string[]) => join(repo, ...p)
function runCheck(area: string, label: string, cmd: string, ref?: string, file?: string) {
  try {
    execSync(cmd, { cwd: repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    add('PASS', area, `${label} exits 0`, ref, file)
  } catch (e: unknown) {
    const err = e as { stderr?: string; stdout?: string }
    const detail = (err.stderr ?? err.stdout ?? '').trim()
    add('FAIL', area, detail ? `${label} failed:\n  ${detail.split('\n').join('\n  ')}` : `${label} failed`, ref, file)
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
  add('FAIL', 'PKG-4', 'package.json missing or unparseable', STD, 'package.json')
}
const scripts = (pkg.scripts ?? {}) as Record<string, string>
const name = String(pkg.name ?? basename(repo))

// ── core: package.json metadata ───────────────────────────────────────────────
pkg.type === 'module'
  ? add('PASS', 'PKG-1', 'type = "module"', STD, 'package.json')
  : add('FAIL', 'PKG-1', `type should be "module", got ${JSON.stringify(pkg.type)}`, STD, 'package.json')
String(pkg.packageManager ?? '').startsWith('bun@')
  ? add('PASS', 'PKG-2', `packageManager = ${pkg.packageManager}`, STD, 'package.json')
  : add('FAIL', 'PKG-2', `packageManager should be bun@…, got ${JSON.stringify(pkg.packageManager)}`, STD, 'package.json')
const nodeEngine = String((pkg.engines as Record<string, string> | undefined)?.node ?? '')
const nodeOk = (() => {
  const m = nodeEngine.match(/>=\s*(\d+)/)
  return m ? Number(m[1]) >= 22 : false
})()
add(
  nodeOk ? 'PASS' : 'FAIL',
  'PKG-3',
  nodeOk ? `engines.node = ${nodeEngine}` : `engines.node should be >=22, got ${JSON.stringify(nodeEngine)}`,
  STD,
  'package.json'
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
      'PKG-4',
      `ungoverned package.json key(s): ${unknownKeys.join(', ')} — every top-level key must be in the coverage manifest (engineering-standard §1) and assigned an owner`,
      STD,
      'package.json'
    )
  : add('PASS', 'PKG-4', 'all top-level keys are in the coverage manifest', STD, 'package.json')

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
      'PKG-5',
      `missing toolchain devDependencies: ${missingDev.join(', ')} (the code and authoring tools the governance modes invoke)`,
      STD,
      'package.json'
    )
  : add(
      'PASS',
      'PKG-5',
      'toolchain devDependencies present (biome, prettier, husky, lint-staged, markdownlint-cli2, syncpack, typescript)',
      STD,
      'package.json'
    )
const lintStaged = pkg['lint-staged']
if (!lintStaged || typeof lintStaged !== 'object') {
  add('FAIL', 'PKG-6', 'lint-staged block missing (the husky pre-commit fan-out)', STD, 'package.json')
} else {
  const ls = JSON.stringify(lintStaged)
  ls.includes('@biomejs/biome') && ls.includes('prettier') && ls.includes('markdownlint')
    ? add('PASS', 'PKG-6', 'lint-staged fans out to biome (code) + prettier/markdownlint (Markdown)', STD, 'package.json')
    : add('WARN', 'PKG-6', 'lint-staged should run @biomejs/biome on code and prettier + markdownlint on *.md', STD, 'package.json')
}

// ── core: mise.toml toolchain pin ─────────────────────────────────────────────
// Root mise.toml pins the actual node + bun (mise puts them on PATH on `cd`; CI
// installs them via jdx/mise-action). The pinned bun MUST equal packageManager's
// bun — the standing drift pair. node is pinned exactly here (engines is a floor).
const mise = read('mise.toml')
if (!mise) add('FAIL', 'MISE-1', 'mise.toml missing (root toolchain pin: [tools] node + bun)', STD, 'mise.toml')
else {
  const miseNode = mise.match(/^\s*node\s*=\s*["']([^"']+)["']/m)?.[1]
  const miseBun = mise.match(/^\s*bun\s*=\s*["']([^"']+)["']/m)?.[1]
  miseNode
    ? add('PASS', 'MISE-1', `mise.toml pins node = ${miseNode}`, STD, 'mise.toml')
    : add('FAIL', 'MISE-1', 'mise.toml must pin node under [tools]', STD, 'mise.toml')
  if (!miseBun) add('FAIL', 'MISE-1', 'mise.toml must pin bun under [tools]', STD, 'mise.toml')
  else {
    const pmBun = String(pkg.packageManager ?? '').match(/^bun@(.+)$/)?.[1]
    pmBun && pmBun !== miseBun
      ? add('FAIL', 'MISE-2', `mise.toml bun (${miseBun}) must match packageManager bun (${pmBun})`, STD, 'mise.toml')
      : add('PASS', 'MISE-2', `mise.toml pins bun = ${miseBun}${pmBun ? ' (matches packageManager)' : ''}`, STD, 'mise.toml')
  }
}
// legacy single-tool pin files shadow mise.toml — warn (redundant, can diverge)
const strayPins = ['.node-version', '.nvmrc', '.bun-version'].filter((f) => has(f))
strayPins.length
  ? add(
      'WARN',
      'MISE-3',
      `legacy pin file(s) beside mise.toml: ${strayPins.join(', ')} — remove; mise.toml is the single toolchain pin`,
      STD
    )
  : add('PASS', 'MISE-3', 'no legacy pin files (.node-version / .nvmrc / .bun-version)', STD)

// ── core (when the repo has CI): the common CI shape ──────────────────────────
// CI installs the toolchain from mise.toml and runs the aggregate read-only gate —
// `bun run ki:audit` — which fans out over every vendored per-skill audit in
// .ki-meta (engineering's audit runs the code toolchain below; authoring's runs the
// Markdown gate). `bun run test` follows for the repo's self-tests. ki:verify is
// retired: ki:audit IS the gate now (ADR-KI-HARNESS-TOOLCHAIN-001).
if (has('.github', 'workflows', 'ci.yml')) {
  const ci = read('.github', 'workflows', 'ci.yml')
  const commandIndex = (script: string): number => {
    const escaped = script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const command = new RegExp(
      `(?:^[ \\t]*(?:-[ \\t]*)?(?:run:[ \\t]*)?|&&[ \\t]*|\\|\\|[ \\t]*|;[ \\t]*)(["']?)bun[ \\t]+run[ \\t]+${escaped}[ \\t]*\\1(?=[ \\t]*(?:&&|\\|\\||;|#|\\r?$))`,
      'm'
    )
    return ci.search(command)
  }
  const usesMise = /mise-action/.test(ci)
  usesMise
    ? add('PASS', 'CI-1', 'ci.yml installs the toolchain via jdx/mise-action', STD, '.github/workflows/ci.yml')
    : add('FAIL', 'CI-1', 'ci.yml must install the toolchain via jdx/mise-action (reads mise.toml)', STD, '.github/workflows/ci.yml')
  const hard = ci.match(/\b(bun|node)-version\s*:/)
  if (hard)
    add(
      'FAIL',
      'CI-1',
      `ci.yml hardcodes ${hard[1]}-version — remove it; the version comes from mise.toml`,
      STD,
      '.github/workflows/ci.yml'
    )
  const auditIndex = commandIndex('ki:audit')
  auditIndex >= 0
    ? add('PASS', 'CI-2', 'ci.yml runs the aggregate gate "bun run ki:audit"', STD, '.github/workflows/ci.yml')
    : add(
        'FAIL',
        'CI-2',
        'ci.yml must run "bun run ki:audit" — the aggregate read-only gate (ki:verify is retired)',
        STD,
        '.github/workflows/ci.yml'
      )
  if (scripts.test) {
    const testIndex = commandIndex('test')
    if (testIndex < 0)
      add(
        'FAIL',
        'CI-2',
        'ci.yml must run the exact command "bun run test" after ki:audit when package.json exposes tests',
        STD,
        '.github/workflows/ci.yml'
      )
    else if (auditIndex >= 0 && auditIndex < testIndex)
      add('PASS', 'CI-2', 'ci.yml runs the repository self-test suite "bun run test" after ki:audit', STD, '.github/workflows/ci.yml')
    else add('FAIL', 'CI-2', 'ci.yml must run "bun run ki:audit" before "bun run test"', STD, '.github/workflows/ci.yml')
  }
  if (/\bki:verify\b/.test(ci))
    add(
      'WARN',
      'CI-2',
      'ci.yml still references ki:verify — retired; run "bun run ki:audit && bun run test"',
      STD,
      '.github/workflows/ci.yml'
    )
} else {
  add('NA', 'CI-1', 'no .github/workflows/ci.yml — not applicable', STD)
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
runCheck('BIO-1', 'biome check', 'bunx @biomejs/biome check', STD)
if (workspaces.length) {
  const noTsconfig = workspaces.filter((p) => !read(`${p}/tsconfig.json`))
  if (noTsconfig.length) add('FAIL', 'TSC-1', `workspaces names dir(s) without a tsconfig.json: ${noTsconfig.join(', ')}`, STD)
  for (const ws of workspaces.filter((p) => read(`${p}/tsconfig.json`)))
    runCheck('TSC-1', `tsc ${ws}`, `tsc --noEmit -p ${ws}/tsconfig.json`, STD)
} else {
  runCheck('TSC-1', 'tsc --noEmit', 'tsc --noEmit', STD)
}
runCheck('SYNC-1', 'syncpack format (check)', 'bunx syncpack format --check', STD)
runCheck('KNIP-2', 'knip', 'bunx knip --no-config-hints', STD)

// ── core: the aggregate entrypoints + retired-key drift ───────────────────────
// Every governed repo exposes the two aggregate entrypoints that fan out over the
// vendored per-skill modes in .ki-meta: ki:audit (read-only gate) and ki:conform (write
// pass), plus ki:init/ki:help. The per-tool ki:lint:*/ki:deps:*/ki:knip families,
// ki:verify, and any per-skill ki:<x>:lint are retired — flag them as drift.
for (const [key, label] of [
  ['ki:audit', 'aggregate read-only gate'],
  ['ki:conform', 'aggregate write pass']
] as const)
  scripts[key]
    ? add('PASS', 'SCR-2', `${key} present (${label})`, STD, 'package.json')
    : add('FAIL', 'SCR-2', `script "${key}" missing (${label})`, STD, 'package.json')
const retired = Object.keys(scripts).filter(
  (k) => /^ki:(lint|deps):/.test(k) || k === 'ki:knip' || k === 'ki:verify' || /^ki:[a-z-]+:lint$/.test(k)
)
retired.length
  ? add(
      'FAIL',
      'SCR-3',
      `retired script key(s): ${retired.join(', ')} — the ki:lint:* / ki:deps:* / ki:knip families, ki:verify, and ki:<skill>:lint are folded into ki:engineering:audit/conform, ki-authoring, and the aggregate ki:audit (TOOLCHAIN-001)`,
      STD,
      'package.json'
    )
  : add('PASS', 'SCR-3', 'no retired ki:lint:* / ki:deps:* / ki:verify keys', STD, 'package.json')

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
        ? add('PASS', 'SCR-4', `${key} wired to vendored ${skill}/${mode}.ts`, STD, 'package.json')
        : add('FAIL', 'SCR-4', `missing script "${key}" for vendored .ki-meta/skills/${skill}/${mode}.ts`, STD, 'package.json')
    }
  }
}
// clean (removes node_modules; may also remove dist) + prepare = husky
scripts.clean?.includes('node_modules')
  ? add('PASS', 'SCR-5', `clean = ${JSON.stringify(scripts.clean)}`, STD, 'package.json')
  : add('FAIL', 'SCR-5', 'clean must remove node_modules (e.g. "rm -rf {dist,node_modules}")', STD, 'package.json')
scripts.prepare === 'husky'
  ? add('PASS', 'SCR-5', 'prepare = "husky"', STD, 'package.json')
  : add('WARN', 'SCR-5', `prepare should be "husky", got ${JSON.stringify(scripts.prepare)}`, STD, 'package.json')

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
      'SCR-1',
      `ungoverned script name(s): ${offenders.join(', ')} — every script must be a bare lifecycle idiom (${[...BARE_IDIOMS].join(', ')}) or carry the ki: prefix (engineering-standard §2)`,
      STD,
      'package.json'
    )
  : add('PASS', 'SCR-1', 'all scripts are bare idioms or ki:-prefixed (naming law)', STD, 'package.json')

// ── advisory: dependency freshness (bun outdated) ────────────────────────────
try {
  const out = execSync('bun outdated', { cwd: repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  const pkgRows = out.split('\n').filter((l) => l.includes('│') && !l.includes('Package') && !l.includes('Current'))
  if (pkgRows.length === 0) {
    add('PASS', 'DEPS-1', 'all packages up to date (bun outdated)', STD)
  } else {
    add(
      'ADVISORY',
      'DEPS-1',
      `${pkgRows.length} package${pkgRows.length === 1 ? '' : 's'} have updates available — run \`bun run ki:engineering:conform\`:\n  ${out}`,
      STD
    )
  }
} catch {
  add('NA', 'DEPS-1', 'bun outdated unavailable — upgrade Bun to check dependency freshness', STD)
}

// ── core: the `bun test` trap ─────────────────────────────────────────────────
const bunTest = Object.entries(scripts).filter(([, v]) => /\bbun test\b/.test(v))
bunTest.length
  ? add('FAIL', 'SCR-6', `uses "bun test" (Bun's runner, not vitest) in: ${bunTest.map(([k]) => k).join(', ')}`, STD, 'package.json')
  : add('PASS', 'SCR-6', 'no "bun test" anywhere', STD, 'package.json')

// ── core: tsconfig.json (universal invariants only; richer base is profiled) ──
// tsconfig may carry // comments (the website's does), so check by regex on text,
// not JSON.parse. Only the invariants ALL repos share are core; the fuller shared
// base (es2024, verbatimModuleSyntax, the noImplicit* family, and config-gated
// vitest/globals types) is checked under the compiled-build capability below.
const ts = read('tsconfig.json')
if (!ts) add('FAIL', 'TSC-2', 'tsconfig.json missing', STD, 'tsconfig.json')
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
    re.test(ts)
      ? add('PASS', 'TSC-2', label, STD, 'tsconfig.json')
      : add('FAIL', 'TSC-2', `tsconfig.json missing universal invariant: ${label}`, STD, 'tsconfig.json')
}

// ── core: biome.json (shared FIELDS, not byte-identical — files globs vary) ───
const biome = read('biome.json')
if (!biome) add('FAIL', 'BIO-2', 'biome.json missing', STD, 'biome.json')
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
  for (const [label, re] of fields)
    re.test(biome)
      ? add('PASS', 'BIO-2', label, STD, 'biome.json')
      : add('WARN', 'BIO-2', `biome.json: expected ${label}`, STD, 'biome.json')
}

// .prettierrc.json content is owned and audited by ki-authoring (it backs that
// skill's own Markdown conform pass) — not checked here (SHAPE-16 ownership split).

// ── core: knip.json (backs the knip check inside ki:engineering:audit) ────────────
// knip is run directly by ki:engineering:audit (dependency + dead-code hygiene);
// every repo carries a knip.json declaring its entry points (so the public surface
// isn't misread as dead code) and any intentional ignores.
has('knip.json') || has('knip.jsonc') || has('knip.ts')
  ? add('PASS', 'KNIP-1', 'knip.json present (entry points + ignores for the knip check in ki:engineering:audit)', STD, 'knip.json')
  : add('FAIL', 'KNIP-1', 'knip.json missing (config for knip — run by ki:engineering:audit/conform)', STD, 'knip.json')

// ── capability detection ──────────────────────────────────────────────────────
const vitestFile = [
  'vitest.config.ts',
  'vitest.config.js',
  'vitest.config.mts',
  'vitest.config.cts',
  'vitest.config.mjs',
  'vitest.config.cjs'
].find((f) => has(f))
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
// ki:audit. Compiled builds remain the separate bare `build` lifecycle command.
if (hasTests && !scripts.test)
  add('FAIL', 'SCR-7', 'repo has tests but no bare "test" script (the whole *.test.ts suite, run after ki:audit)', STD, 'package.json')
else if (hasTests) add('PASS', 'SCR-7', 'bare "test" idiom present', STD, 'package.json')

// ── capability: tests ─────────────────────────────────────────────────────────
// Vitest is the recommended runner and the ONLY one the coverage rules below apply to,
// but it is not mandated: a repo may run its self-tests another way (the harness runs
// standalone *.test.ts checker scripts via the bare `test` idiom). The vitest key-shape +
// 100%-coverage checks fire only when a vitest.config.* is actually present.
if (vitestFile) {
  const wantTest: Record<string, string> = { test: 'vitest run', 'test:coverage': 'vitest run --coverage', 'test:watch': 'vitest' }
  for (const [k, v] of Object.entries(wantTest)) {
    if (!scripts[k]) add('WARN', 'TEST-1', `test capability: script "${k}" missing (expected ${JSON.stringify(v)})`, STD, 'package.json')
    else
      scripts[k] === v
        ? add('PASS', 'TEST-1', `${k} = ${JSON.stringify(v)}`, STD, 'package.json')
        : add('FAIL', 'TEST-1', `${k} should be ${JSON.stringify(v)}, got ${JSON.stringify(scripts[k])}`, STD, 'package.json')
  }
  {
    const vc = read(vitestFile)
    const objectAt = (source: string, open: number): string | undefined => {
      if (source[open] !== '{') return undefined
      let depth = 0
      let quote = ''
      let escapedChar = false
      let lineComment = false
      let blockComment = false
      for (let i = open; i < source.length; i += 1) {
        const char = source[i]
        const next = source[i + 1]
        if (lineComment) {
          if (char === '\n') lineComment = false
          continue
        }
        if (blockComment) {
          if (char === '*' && next === '/') {
            blockComment = false
            i += 1
          }
          continue
        }
        if (quote) {
          if (escapedChar) escapedChar = false
          else if (char === '\\') escapedChar = true
          else if (char === quote) quote = ''
          continue
        }
        if (char === '/' && next === '/') {
          lineComment = true
          i += 1
          continue
        }
        if (char === '/' && next === '*') {
          blockComment = true
          i += 1
          continue
        }
        if (char === '"' || char === "'" || char === '`') {
          quote = char
          continue
        }
        if (char === '{') depth += 1
        if (char === '}') {
          depth -= 1
          if (depth === 0) return source.slice(open, i + 1)
        }
      }
      return undefined
    }
    const maskNonCode = (source: string): string => {
      const masked = source.split('')
      let quote = ''
      let escapedChar = false
      let lineComment = false
      let blockComment = false
      for (let i = 0; i < source.length; i += 1) {
        const char = source[i]
        const next = source[i + 1]
        if (lineComment) {
          if (char === '\n') lineComment = false
          else masked[i] = ' '
          continue
        }
        if (blockComment) {
          masked[i] = ' '
          if (char === '*' && next === '/') {
            masked[i + 1] = ' '
            blockComment = false
            i += 1
          }
          continue
        }
        if (quote) {
          masked[i] = ' '
          if (escapedChar) escapedChar = false
          else if (char === '\\') escapedChar = true
          else if (char === quote) quote = ''
          continue
        }
        if (char === '/' && next === '/') {
          masked[i] = ' '
          masked[i + 1] = ' '
          lineComment = true
          i += 1
          continue
        }
        if (char === '/' && next === '*') {
          masked[i] = ' '
          masked[i + 1] = ' '
          blockComment = true
          i += 1
          continue
        }
        if (char === '"' || char === "'" || char === '`') {
          masked[i] = ' '
          quote = char
        }
      }
      return masked.join('')
    }
    const exportedConfig = (source: string): string | undefined => {
      const code = maskNonCode(source)
      const starts = [
        /\bexport\s+default\s+(?:defineConfig\s*\(\s*)?\{/m.exec(code),
        /\bmodule\.exports\s*=\s*(?:defineConfig\s*\(\s*)?\{/m.exec(code)
      ].filter((match): match is RegExpExecArray => Boolean(match))
      const start = starts.sort((a, b) => a.index - b.index)[0]
      if (!start) return undefined
      return objectAt(source, start.index + start[0].lastIndexOf('{'))
    }
    const directPropertyMatch = (
      source: string,
      property: string,
      valuePattern: string
    ): { index: number; match: RegExpExecArray } | undefined => {
      if (!source.startsWith('{')) return undefined
      const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const propertyStart = new RegExp(`^(?:["']${escaped}["']|${escaped})\\s*:\\s*${valuePattern}`)
      let depth = 0
      let quote = ''
      let escapedChar = false
      let lineComment = false
      let blockComment = false
      let expectsProperty = false
      for (let i = 0; i < source.length; i += 1) {
        const char = source[i]
        const next = source[i + 1]
        if (lineComment) {
          if (char === '\n') lineComment = false
          continue
        }
        if (blockComment) {
          if (char === '*' && next === '/') {
            blockComment = false
            i += 1
          }
          continue
        }
        if (quote) {
          if (escapedChar) escapedChar = false
          else if (char === '\\') escapedChar = true
          else if (char === quote) quote = ''
          continue
        }
        if (char === '/' && next === '/') {
          lineComment = true
          i += 1
          continue
        }
        if (char === '/' && next === '*') {
          blockComment = true
          i += 1
          continue
        }
        if (depth === 1 && expectsProperty && !/\s/.test(char)) {
          const match = propertyStart.exec(source.slice(i))
          if (match) return { index: i, match }
          expectsProperty = false
        }
        if (char === '"' || char === "'" || char === '`') {
          quote = char
          continue
        }
        if (char === '{') {
          depth += 1
          if (depth === 1) expectsProperty = true
          continue
        }
        if (char === '}') {
          depth -= 1
          continue
        }
        if (depth === 1 && char === ',') expectsProperty = true
      }
      return undefined
    }
    const directObjectProperty = (source: string, property: string): string | undefined => {
      const found = directPropertyMatch(source, property, '\\{')
      return found ? objectAt(source, found.index + found.match[0].lastIndexOf('{')) : undefined
    }
    const rootConfig = exportedConfig(vc)
    const testConfig = rootConfig ? directObjectProperty(rootConfig, 'test') : undefined
    const coverage = testConfig ? directObjectProperty(testConfig, 'coverage') : undefined
    const thresholds = coverage ? directObjectProperty(coverage, 'thresholds') : undefined
    const exactHundred = (metric: string): boolean => {
      if (!thresholds) return false
      return Boolean(directPropertyMatch(thresholds, metric, '100(?=\\s*[,}])'))
    }
    const covOk = ['lines', 'branches', 'functions', 'statements'].every(exactHundred)
    add(
      covOk ? 'PASS' : 'FAIL',
      'TEST-2',
      covOk
        ? 'coverage thresholds 100% on all four metrics'
        : 'coverage thresholds must be 100/100/100/100 (lines/functions/branches/statements)',
      STD,
      vitestFile
    )
    const excludesTest = /exclude\s*:/.test(vc) && /\*\*\/\*\.test\.ts/.test(vc)
    add(
      excludesTest ? 'PASS' : 'WARN',
      'TEST-3',
      excludesTest
        ? 'coverage excludes src/**/*.test.ts'
        : 'coverage should exclude src/**/*.test.ts (other excludes are artifact-specific)',
      STD,
      vitestFile
    )
    // monorepo shape (§0): per-workspace artifacts and test globs are scoped to the owning
    // workspace dir, never the repo root. Check the vitest reportsDirectory and include globs
    // sit under a declared workspace (mirrors the per-workspace tsc check above).
    if (workspaces.length) {
      const underWs = (p: string) => workspaces.some((w) => p === w || p.startsWith(`${w}/`))
      const rd = vc.match(/reportsDirectory\s*:\s*['"]([^'"]+)['"]/)?.[1]
      add(
        rd && underWs(rd) ? 'PASS' : 'WARN',
        'TEST-4',
        rd && underWs(rd)
          ? `monorepo: coverage reportsDirectory "${rd}" is under a workspace`
          : `monorepo (§0): set the vitest coverage reportsDirectory under the owning workspace (e.g. "site/coverage"), not the repo root — ${rd ? `got "${rd}"` : 'none set (defaults to root coverage/)'}`,
        STD,
        vitestFile
      )
      const globs = [...vc.matchAll(/include\s*:\s*\[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]))
      const escaped = globs.filter((g) => !underWs(g))
      if (escaped.length)
        add(
          'WARN',
          'TEST-4',
          `monorepo (§0): vitest include glob(s) not under a workspace dir: ${escaped.join(', ')} — scope tests/coverage to the owning workspace (e.g. site/scripts/**/*.test.ts)`,
          STD,
          vitestFile
        )
    }
  }
  if (scripts['test:coverage']) runCheck('TEST-5', 'test:coverage', 'bun run test:coverage', STD)
} else if (scripts.test) {
  add(
    'INFO',
    'TEST-1',
    'non-vitest test runner (bare `test` idiom) — the vitest key-shape + coverage rules do not apply',
    STD,
    'package.json'
  )
} else {
  add('NA', 'TEST-1', 'no test capability (no vitest.config / test script) — not applicable', STD)
}

// ── capability: compiled build + the cli-chmod rule ───────────────────────────
if (hasBuild) {
  buildScript.startsWith('tsc -p tsconfig.build.json')
    ? add('PASS', 'BUILD-1', 'build = tsc -p tsconfig.build.json', STD, 'package.json')
    : add(
        'FAIL',
        'BUILD-1',
        `build should start with "tsc -p tsconfig.build.json", got ${JSON.stringify(buildScript)}`,
        STD,
        'package.json'
      )
  Array.isArray(pkg.files) && (pkg.files as string[]).includes('dist')
    ? add('PASS', 'BUILD-1', 'files includes "dist"', STD, 'package.json')
    : add('FAIL', 'BUILD-1', 'files should include "dist"', STD, 'package.json')
  // tsconfig.build.json shape
  const tb = read('tsconfig.build.json')
  if (!tb) add('FAIL', 'BUILD-2', 'compiled build but tsconfig.build.json missing', STD, 'tsconfig.build.json')
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
      re.test(tb)
        ? add('PASS', 'BUILD-2', `tsconfig.build.json ${label}`, STD, 'tsconfig.build.json')
        : add('WARN', 'BUILD-2', `tsconfig.build.json: expected ${label}`, STD, 'tsconfig.build.json')
  }
  // the richer shared base lives in the compiled-TS profile — WARN, not FAIL
  const tsBase: [string, RegExp][] = [
    ['target es2024', /"target"\s*:\s*"es2024"/i],
    ['verbatimModuleSyntax: true', /"verbatimModuleSyntax"\s*:\s*true/],
    ['noUnusedLocals: true', /"noUnusedLocals"\s*:\s*true/]
  ]
  for (const [label, re] of tsBase)
    re.test(ts)
      ? add('PASS', 'BUILD-3', `tsconfig.json (shared base) ${label}`, STD, 'tsconfig.json')
      : add('WARN', 'BUILD-3', `tsconfig.json (shared base) should set ${label}`, STD, 'tsconfig.json')
  // CLI chmod rule: build chmods EXACTLY dist/cli/cli.js iff src/cli/, and nothing else.
  const chmodTargets = [...buildScript.matchAll(/chmod\s+\+x\s+([^&|;]+)/g)].flatMap((m) => m[1].trim().split(/\s+/)).filter(Boolean)
  const allowed = hasCli ? ['dist/cli/cli.js'] : []
  const unexpected = chmodTargets.filter((t) => !allowed.includes(t))
  const missing = allowed.filter((t) => !chmodTargets.includes(t))
  if (unexpected.length)
    add(
      'FAIL',
      'BUILD-4',
      `build chmods unexpected target(s): ${unexpected.join(', ')} — chmod only dist/cli/cli.js (iff src/cli/), never the server bin`,
      STD,
      'package.json'
    )
  if (missing.length) add('WARN', 'BUILD-4', `src/cli/ exists but build does not chmod +x ${missing.join(', ')}`, STD, 'package.json')
  if (!unexpected.length && !missing.length)
    add(
      'PASS',
      'BUILD-4',
      hasCli ? 'build chmods exactly dist/cli/cli.js' : 'build chmods nothing (no src/cli/) — correct',
      STD,
      'package.json'
    )
} else {
  add('NA', 'BUILD-1', 'no compiled-tsc build capability — not applicable', STD)
}

// ── capability: env config ────────────────────────────────────────────────────
if (hasEnv) {
  envExample
    ? add('PASS', 'ENV-1', `${envExample} present`, STD, envExample)
    : add('WARN', 'ENV-1', 'loads env (process.loadEnvFile) but no .env*.example template committed', STD)
  // NODE_ENV=development must appear only in dev/inspect scripts
  const devKeys = (k: string) => /:(dev|inspect)\b/.test(k) || k.endsWith(':dev') || k.endsWith(':inspect')
  const leaks = Object.entries(scripts).filter(([k, v]) => v.includes('NODE_ENV=development') && !devKeys(k))
  leaks.length
    ? add('FAIL', 'ENV-2', `NODE_ENV=development outside a dev/inspect script: ${leaks.map(([k]) => k).join(', ')}`, STD, 'package.json')
    : add('PASS', 'ENV-2', 'NODE_ENV=development only in dev/inspect scripts', STD, 'package.json')
} else {
  add('NA', 'ENV-1', 'no env capability — not applicable', STD)
}

// ── core: .ki-config.toml [ki-engineering] table ────────────────
const ki = read('.ki-config.toml')
if (!ki) add('WARN', 'TOML-1', '.ki-config.toml missing (ki-repo owns the contract)', STD, '.ki-config.toml')
else if (!/^\[ki-engineering\]/m.test(ki)) {
  add(
    'WARN',
    'TOML-1',
    'no [ki-engineering] table — add it to mark this repo as governed by the engineering standard',
    STD,
    '.ki-config.toml'
  )
} else {
  add('PASS', 'TOML-1', '[ki-engineering] table present', STD, '.ki-config.toml')
  // validate-down: the table is a conformance marker only — it carries no keys. Repo
  // shape (flat vs monorepo) is read from package.json `workspaces` (§0), a standard Bun
  // convention, not a bespoke key here. Any key directly under the table is drift.
  const body = ki.split(/^\[ki-engineering\]/m)[1]?.split(/^\[/m)[0] ?? ''
  const KNOWN = new Set<string>() // no keys defined; only a [ki-engineering.checks] sub-table is allowed
  for (const m of body.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=/gm)) {
    KNOWN.has(m[1])
      ? add('PASS', 'TOML-2', `known key ${m[1]}`, STD, '.ki-config.toml')
      : add('WARN', 'TOML-2', `unknown key under [ki-engineering]: ${m[1]} (validate-down)`, STD, '.ki-config.toml')
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
      return rows.length
        ? [
            '',
            `## ${ICON[l]} ${l} (${rows.length})`,
            ...rows.map((r) => `- [${r.area}]${r.file ? ` ${r.file}` : ''} ${r.msg}${r.ref ? ` (${r.ref})` : ''}`)
          ]
        : []
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
      for (const r of rows) console.log(`   [${r.area}]${r.file ? ` ${r.file}` : ''} ${r.msg}${r.ref ? ` (${r.ref})` : ''}`)
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
add('ADVISORY', 'judgment', 'mechanical layer only — apply the [J] criteria in references/audit-rubric.md by reading', RUBRIC)

emit(
  findings,
  repo,
  'engineering',
  `Engineering standard audit — ${name}  (${repo})`,
  'Common layer only — run the artifact skill audit too (e.g. audit.ts for an MCP repo).'
)
