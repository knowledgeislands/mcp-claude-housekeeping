#!/usr/bin/env bun
/**
 * Mechanical CONFORM for the ki-engineering standard — fixes the subset of
 * audit.ts's findings that are unambiguous and reversible, leaving
 * everything that needs a human call as a printed manual TODO.
 *
 * Scope: a single target repo (default cwd), matching the house conform shape
 * (conform.ts, conform.ts) — `bun conform.ts .` /
 * `ki:engineering:conform`. Known-good defaults (canonical script bodies,
 * tsconfig/biome/knip field sets, required devDeps) are copied from
 * audit.ts rather than imported, so each script stays valid
 * standalone per the composition-only rule.
 *
 *   bun scripts/conform.ts [path]   # default: cwd
 *   --dry-run                                    # report the planned actions, mutate nothing
 *
 * Every invocation emits the canonical JSONL checker stream (minted code + ref + file):
 * each action becomes a typed finding on the shared ladder — file written/scaffolded or a
 * fix/tool run → POLISH, already-canonical → PASS, a tool that exited non-zero → FAIL,
 * a judgment/manual-TODO the write pass cannot make → ADVISORY. A single audit area
 * fans into several sections, and the toolchain write pass bundles biome + syncpack +
 * knip + deps — each emitted line cites ITS OWN criterion code (BIO-1 / SYNC-1 / KNIP-2 /
 * DEPS-1), regardless of the section where it originates. `--dry-run` governs
 * *writing* only.
 *
 * Fixes:
 *   - package.json: `type`, `packageManager`, `engines.node`, the exact
 *     the aggregate `ki:audit`/`ki:conform`/`ki:educate`/`ki:help` entrypoints + derived
 *     per-skill keys, `clean`, `prepare`, and running the write toolchain directly,
 *     missing toolchain devDependencies, and a missing/incomplete
 *     `lint-staged` block — all set/overwritten to the standard's exact value.
 *   - Scaffolds mise.toml / tsconfig.json / biome.json / knip.json when
 *     absent entirely, using the same known-good defaults audit.ts checks
 *     against. Never overwrites an existing file of these (field-level
 *     repair inside an existing file is judgment — the rubric's [J] half —
 *     not scripted here). `.prettierrc.json` is owned by ki-authoring
 *     (it backs that skill's own Markdown conform pass) — not this skill.
 *   - Appends a `[ki-engineering]` marker table to .ki-config.toml when the
 *     table is missing (mirrors conform.ts's own config-marker append).
 *
 * Deliberately NEVER touches (judgment → manual TODOs):
 *   - Ungoverned/extra package.json top-level keys (drift needs a human call
 *     on where the key actually belongs).
 *   - CI workflow (.github/workflows/ci.yml) content — authoring YAML by hand.
 *   - Monorepo-specific checks (per-workspace tsc, per-workspace vitest scoping) —
 *     repo-shape-specific, not a single mechanical fix.
 *   - Compiled-build / cli-chmod steps (build script body, tsconfig.build.json,
 *     files/dist, chmod targets) — depends on repo-specific src/ layout.
 *   - Anything env/secret-related (NODE_ENV leaks outside dev/inspect scripts,
 *     .env*.example authoring) — never auto-fixed; could mask a real leak.
 *   - Field-level repairs inside an EXISTING tsconfig/biome/knip file
 *     (only scaffolds when the file is missing entirely).
 *
 * Zero npm dependencies (bun + node stdlib only). Exit code is non-zero only on
 * an unrecoverable error (target dir not found / package.json unparseable);
 * findings/fixes never fail the run.
 */
import { execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type CheckerFinding,
  type CheckerLevel,
  checkerReporterExitCode,
  emitCheckerReporter,
  judgmentFindingsFromRubric
} from './vendored/ki-skills/checker-reporter.ts'

// Reference-doc pointers — same strings audit.ts cites, so a given criterion maps to
// the same (code, ref) in both files.
const STD = 'references/standards.md'
const RUBRIC = 'references/rubric.md'

// ── kept in lockstep with audit.ts ──
const REQUIRED_DEV = ['@biomejs/biome', 'knip', 'prettier', 'husky', 'lint-staged', 'markdownlint-cli2', 'syncpack', 'typescript']
// The aggregate entrypoints every governed repo exposes — identical everywhere, so
// canonical and added when missing. The per-tool ki:lint:*/ki:deps:*/ki:knip families
// and ki:verify are retired (TOOLCHAIN-001): the write tools run directly below.
const CANON: Record<string, string> = {
  'ki:audit': 'bun .ki-meta/bin/aggregate.ts audit',
  'ki:conform': 'bun .ki-meta/bin/aggregate.ts conform',
  'ki:educate': 'bun .ki-meta/bin/aggregate.ts educate',
  'ki:help': 'bun .ki-meta/bin/aggregate.ts help'
}
// Retired keys removed on sight (folded into ki:engineering:audit/conform + ki-authoring).
const RETIRED_KEY = (k: string): boolean =>
  /^ki:(lint|deps):/.test(k) || k === 'ki:knip' || k === 'ki:verify' || /^ki:[a-z-]+:lint$/.test(k)
const LATEST_DEV_VERSIONS: Record<string, string> = {
  '@biomejs/biome': '^1.9.4',
  knip: '^5.44.0',
  prettier: '^3.4.2',
  husky: '^9.1.7',
  'lint-staged': '^15.3.0',
  'markdownlint-cli2': '^0.15.0',
  syncpack: '^13.0.0',
  typescript: '^5.7.2'
}
const LINT_STAGED_DEFAULT = {
  '*.{ts,tsx,js,jsx,json}': ['bunx @biomejs/biome check --write --no-errors-on-unmatched'],
  '*.md': ['bunx prettier --write', 'bunx markdownlint-cli2']
}

const MISE_DEFAULT = `[tools]
node = "22"
bun = "1.3.0"
`
const TSCONFIG_DEFAULT = `{
  "compilerOptions": {
    "target": "es2024",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noEmit": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "noUnusedLocals": true
  },
  "include": ["src/**/*.ts"]
}
`
const BIOME_DEFAULT = `{
  "$schema": "https://biomejs.dev/schemas/1.9.4/schema.json",
  "files": {
    "includes": ["**", "!**/.ki-meta"]
  },
  "formatter": {
    "enabled": true,
    "lineWidth": 140,
    "indentWidth": 2
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "single",
      "semicolons": "asNeeded",
      "trailingCommas": "none"
    }
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "suspicious": { "noExplicitAny": "off" }
    }
  },
  "organizeImports": { "enabled": true }
}
`
const KNIP_DEFAULT = `{
  "$schema": "https://unpkg.com/knip@5/schema.json",
  "entry": ["src/index.ts"],
  "project": ["src/**/*.ts"]
}
`
const KI_CONFIG = '.ki-config.toml'
const KI_MARKER = `[ki-engineering]\n`

// ── collect-then-emit harness ─────────────────────────────────────────────────
// Each action records a mechanical finding. The local vendored reporter supplies
// the JSONL transport and turns the rubric's [J] items into advisory review prompts.
const findings: CheckerFinding[] = []
const rec = (level: CheckerLevel, code: string, message: string, ref?: string, file?: string): void =>
  void findings.push({ type: 'M', level, code, message, ref, file })

function localRubricPath(): string {
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const skillRoot = basename(scriptDir) === 'scripts' ? dirname(scriptDir) : scriptDir
  return join(skillRoot, 'references', 'rubric.md')
}

function finishConform(target: string): never {
  findings.push(...judgmentFindingsFromRubric(localRubricPath(), RUBRIC))
  emitCheckerReporter({ mode: 'conform', concern: 'engineering', target, findings })
  process.exit(checkerReporterExitCode(findings))
}

// ── entry ──
const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const target = resolve(argv.find((a) => !a.startsWith('-')) ?? '.')

// Status is represented by findings, not terminal prose. Keep these no-op calls
// until the mechanical procedure is split from its former narration.
const say = (_line: string): void => {}
const log = (_kind: 'fix' | 'write' | 'append' | 'skip' | 'run', _label: string): void => {}
const C = { cyan: '', dim: '' }
const paint = (_colour: string, text: string): string => text

if (!existsSync(target)) {
  rec('FAIL', 'SCOPE', 'conform target does not exist', STD, target)
  finishConform(target)
}
const pkgPath = join(target, 'package.json')
if (!existsSync(pkgPath)) {
  rec('NA', 'SCOPE', 'no package.json — not a TypeScript/Bun repo; the engineering standard does not apply', STD)
  finishConform(target)
}
let pkg: Record<string, unknown>
try {
  pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
} catch (e) {
  rec('FAIL', 'PKG-4', `package.json is unparseable: ${String((e as Error).message ?? e)}`, STD, 'package.json')
  finishConform(target)
}

let pkgChanged = false
const manualTodos: Array<{ code: string; msg: string }> = []

// ── package.json: core metadata fields ──
say(paint(C.cyan, 'package.json — metadata'))
{
  let any = false
  if (pkg.type !== 'module') {
    log('fix', `type: ${JSON.stringify(pkg.type)} → "module"`)
    rec('POLISH', 'PKG-1', `type set to "module"`, STD, 'package.json')
    pkg.type = 'module'
    pkgChanged = true
    any = true
  }
  if (!String(pkg.packageManager ?? '').startsWith('bun@')) {
    log('fix', `packageManager: ${JSON.stringify(pkg.packageManager)} → "bun@1.3.0"`)
    rec('POLISH', 'PKG-2', `packageManager set to "bun@1.3.0"`, STD, 'package.json')
    pkg.packageManager = 'bun@1.3.0'
    pkgChanged = true
    any = true
  }
  const engines = (pkg.engines ?? {}) as Record<string, string>
  const nodeOk = /^\s*>=\s*(\d+)/.test(engines.node ?? '') && Number((engines.node ?? '').match(/>=\s*(\d+)/)?.[1]) >= 22
  if (!nodeOk) {
    log('fix', `engines.node: ${JSON.stringify(engines.node)} → ">=22"`)
    rec('POLISH', 'PKG-3', `engines.node set to ">=22"`, STD, 'package.json')
    pkg.engines = { ...engines, node: '>=22' }
    pkgChanged = true
    any = true
  }
  if (!any) {
    say(`  ${paint(C.dim, 'nothing to fix')}`)
    rec('PASS', 'PKG-1', 'package.json metadata already conforms (type, packageManager, engines.node)', STD, 'package.json')
  }
}

// ── package.json: required toolchain devDependencies ──
say(`\n${paint(C.cyan, 'package.json — toolchain devDependencies')}`)
{
  const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>
  const missing = REQUIRED_DEV.filter((d) => !(d in devDeps))
  if (!missing.length) {
    say(`  ${paint(C.dim, 'nothing to fix')}`)
    rec('PASS', 'PKG-5', 'toolchain devDependencies already present', STD, 'package.json')
  } else {
    for (const d of missing) {
      log('fix', `devDependencies.${d} = "${LATEST_DEV_VERSIONS[d]}" (added — run \`bun install\` after)`)
      devDeps[d] = LATEST_DEV_VERSIONS[d] as string
    }
    rec('POLISH', 'PKG-5', `added missing toolchain devDependencies: ${missing.join(', ')} (run \`bun install\`)`, STD, 'package.json')
    pkg.devDependencies = devDeps
    pkgChanged = true
    manualTodos.push({ code: 'PKG-5', msg: 'run `bun install` to materialize newly added devDependencies' })
  }
}

// ── package.json: aggregate entrypoints + retired-key removal + derived per-skill keys ──
say(`\n${paint(C.cyan, 'package.json — aggregate entrypoints + per-skill keys')}`)
{
  const scripts = (pkg.scripts ?? {}) as Record<string, string>
  let any = false
  for (const [k, v] of Object.entries(CANON)) {
    if (scripts[k] !== v) {
      log('fix', scripts[k] ? `${k}: diverges from canonical → reset` : `${k}: missing → added`)
      rec('POLISH', 'SCR-2', scripts[k] ? `${k} reset to canonical entrypoint` : `${k} added (aggregate entrypoint)`, STD, 'package.json')
      scripts[k] = v
      any = true
    }
  }
  // Strip retired keys (ki:lint:* / ki:deps:* / ki:knip / ki:verify / ki:<skill>:lint).
  for (const k of Object.keys(scripts).filter(RETIRED_KEY)) {
    log('fix', `${k}: retired → removed (folded into ki:engineering:audit/conform + ki-authoring)`)
    rec('POLISH', 'SCR-3', `retired key ${k} removed (folded into ki:engineering:audit/conform + ki-authoring)`, STD, 'package.json')
    delete scripts[k]
    any = true
  }
  // Derived per-skill keys for every vendored skill in .ki-meta (offline-safe).
  const metaCheckers = join(target, '.ki-meta', 'checkers')
  if (existsSync(metaCheckers)) {
    for (const skill of readdirSync(metaCheckers).filter((d) => statSync(join(metaCheckers, d)).isDirectory())) {
      const suffix = skill.replace(/^ki-/, '')
      for (const mode of ['audit', 'conform'] as const) {
        if (!existsSync(join(metaCheckers, skill, 'scripts', `${mode}.ts`))) continue
        const key = `ki:${suffix}:${mode}`
        const val = `bun .ki-meta/checkers/${skill}/scripts/${mode}.ts .`
        if (scripts[key] !== val) {
          log('fix', scripts[key] ? `${key}: repointed → vendored ${skill}/scripts/${mode}.ts` : `${key}: missing → added`)
          rec(
            'POLISH',
            'SCR-4',
            scripts[key]
              ? `${key} repointed to vendored ${skill}/scripts/${mode}.ts`
              : `${key} added (vendored ${skill}/scripts/${mode}.ts)`,
            STD,
            'package.json'
          )
          scripts[key] = val
          any = true
        }
      }
    }
  }
  if (!scripts.clean?.includes('node_modules')) {
    log('fix', `clean: ${JSON.stringify(scripts.clean)} → "rm -rf dist node_modules"`)
    rec('POLISH', 'SCR-5', `clean set to "rm -rf dist node_modules"`, STD, 'package.json')
    scripts.clean = 'rm -rf dist node_modules'
    any = true
  }
  if (scripts.prepare !== 'husky') {
    log('fix', `prepare: ${JSON.stringify(scripts.prepare)} → "husky"`)
    rec('POLISH', 'SCR-5', `prepare set to "husky"`, STD, 'package.json')
    scripts.prepare = 'husky'
    any = true
  }
  if (any) {
    pkg.scripts = scripts
    pkgChanged = true
  } else {
    say(`  ${paint(C.dim, 'nothing to fix')}`)
    rec('PASS', 'SCR-2', 'aggregate entrypoints, per-skill keys, clean & prepare already conform', STD, 'package.json')
  }
}

// ── package.json: lint-staged block ──
say(`\n${paint(C.cyan, 'package.json — lint-staged')}`)
{
  const lintStaged = pkg['lint-staged']
  const ls = lintStaged && typeof lintStaged === 'object' ? JSON.stringify(lintStaged) : ''
  const ok = ls.includes('@biomejs/biome') && ls.includes('prettier') && ls.includes('markdownlint')
  if (ok) {
    say(`  ${paint(C.dim, 'nothing to fix')}`)
    rec('PASS', 'PKG-6', 'lint-staged block already fans out correctly', STD, 'package.json')
  } else {
    log('fix', lintStaged ? 'lint-staged: incomplete → reset to standard fan-out' : 'lint-staged: missing → added')
    rec(
      'POLISH',
      'PKG-6',
      lintStaged ? 'lint-staged reset to standard fan-out' : 'lint-staged added (standard fan-out)',
      STD,
      'package.json'
    )
    pkg['lint-staged'] = LINT_STAGED_DEFAULT
    pkgChanged = true
  }
}

if (pkgChanged && !dryRun) {
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
}

// ── scaffold: mise.toml / tsconfig.json / biome.json / knip.json ──
say(`\n${paint(C.cyan, 'toolchain config files (scaffold only if absent)')}`)
function scaffold(name: string, path: string, content: string, code: string): void {
  if (existsSync(path)) {
    log('skip', `${name} already present — not touched (field-level repair is judgment)`)
    rec('PASS', code, `${name} already present (field-level repair is judgment)`, STD, name)
    return
  }
  log('write', `${name} (known-good default)`)
  rec('POLISH', code, `${name} scaffolded (known-good default)`, STD, name)
  if (!dryRun) writeFileSync(path, content)
}
scaffold('mise.toml', join(target, 'mise.toml'), MISE_DEFAULT, 'MISE-1')
scaffold('tsconfig.json', join(target, 'tsconfig.json'), TSCONFIG_DEFAULT, 'TSC-2')
scaffold('biome.json', join(target, 'biome.json'), BIOME_DEFAULT, 'BIO-2')
const hasKnip = existsSync(join(target, 'knip.json')) || existsSync(join(target, 'knip.jsonc')) || existsSync(join(target, 'knip.ts'))
if (hasKnip) {
  log('skip', 'knip config already present — not touched')
  rec('PASS', 'KNIP-1', 'knip config already present', STD, 'knip.json')
} else scaffold('knip.json', join(target, 'knip.json'), KNIP_DEFAULT, 'KNIP-1')

// ── .ki-config.toml [ki-engineering] marker ──
say(`\n${paint(C.cyan, '.ki-config.toml — [ki-engineering] marker')}`)
{
  const kiPath = join(target, KI_CONFIG)
  const kiText = existsSync(kiPath) ? readFileSync(kiPath, 'utf8') : ''
  if (/^\[ki-engineering\]/m.test(kiText)) {
    say(`  ${paint(C.dim, 'nothing to fix')}`)
    rec('PASS', 'TOML-1', '[ki-engineering] table already present', STD, KI_CONFIG)
  } else {
    log('append', `${KI_CONFIG} [ki-engineering] marker table`)
    rec('POLISH', 'TOML-1', `${KI_CONFIG} [ki-engineering] marker table appended`, STD, KI_CONFIG)
    if (!dryRun) {
      writeFileSync(kiPath, kiText ? `${kiText.replace(/\n*$/, '\n\n')}${KI_MARKER}` : KI_MARKER)
    }
  }
}

// ── run the write toolchain (conform = lint WITH fixing) ──
// The tools live INSIDE this conform now (TOOLCHAIN-001): Biome check --write + format
// --write, syncpack format, knip --fix, and a dependency refresh. Best-effort — a tool
// exiting non-zero (e.g. residual manual lint) is reported, never fatal. Each step cites
// its OWN criterion code, not a single section code (rubric: BIO-1 / SYNC-1 / KNIP-2 / DEPS-1).
say(`\n${paint(C.cyan, 'toolchain write pass (biome · syncpack · knip · deps)')}`)
{
  const steps: Array<[string, string, string]> = [
    ['biome check --write', 'bunx @biomejs/biome check --write --unsafe', 'BIO-1'],
    ['biome format --write', 'bunx @biomejs/biome format --write', 'BIO-1'],
    ['syncpack format', 'bunx syncpack format', 'SYNC-1'],
    ['knip --fix', 'bunx knip --fix --no-config-hints', 'KNIP-2'],
    ['bun update --latest', 'bun update --latest', 'DEPS-1']
  ]
  for (const [label, cmd, code] of steps) {
    if (dryRun) {
      log('run', `${label} (skipped — dry run)`)
      rec('ADVISORY', code, `${label} would run (dry run — no writes)`, STD)
      continue
    }
    try {
      execSync(cmd, { cwd: target, stdio: 'pipe' })
      log('fix', label)
      rec('POLISH', code, `${label} ran`, STD)
    } catch (err) {
      const detail = err instanceof Error && 'stderr' in err ? String((err as { stderr?: Buffer }).stderr ?? '').trim() : ''
      log(
        'skip',
        `${label} — exited non-zero (residual manual work; re-run ki:engineering:audit)${detail ? `: ${detail.split('\n')[0]}` : ''}`
      )
      rec(
        'FAIL',
        code,
        `${label} exited non-zero — residual manual work; re-run ki:engineering:audit${detail ? ` (${detail.split('\n')[0]})` : ''}`,
        STD
      )
    }
  }
  // 'bun update --latest' can exit non-zero partway through, leaving bun.lock with
  // unresolved "latest" placeholders — always follow with a plain install to reconcile.
  if (dryRun) {
    log('run', 'bun install (skipped — dry run)')
    rec('ADVISORY', 'DEPS-1', 'bun install (lockfile reconcile) would run (dry run — no writes)', STD)
  } else {
    try {
      execSync('bun install', { cwd: target, stdio: 'pipe' })
      log('fix', 'bun install (lockfile reconcile)')
      rec('POLISH', 'DEPS-1', 'bun install (lockfile reconcile) ran', STD)
    } catch (err) {
      const detail = err instanceof Error && 'stderr' in err ? String((err as { stderr?: Buffer }).stderr ?? '').trim() : ''
      log('skip', `bun install (lockfile reconcile) — exited non-zero${detail ? `: ${detail.split('\n')[0]}` : ''}`)
      rec(
        'FAIL',
        'DEPS-1',
        `bun install (lockfile reconcile) exited non-zero — residual manual work; re-run ki:engineering:audit${detail ? ` (${detail.split('\n')[0]})` : ''}`,
        STD
      )
    }
  }
}

// ── judgment items — never guessed, always surfaced ──
say(`\n${paint(C.cyan, 'manual TODOs (judgment — not scripted)')}`)
const ALLOWED_KEYS = new Set<string>([
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
  'type',
  'packageManager',
  'engines',
  'scripts',
  'devDependencies',
  'dependencies',
  'workspaces',
  'lint-staged',
  'main',
  'bin',
  'exports',
  'files'
])
const unknownKeys = Object.keys(pkg).filter((k) => !ALLOWED_KEYS.has(k))
if (unknownKeys.length)
  manualTodos.push({ code: 'PKG-4', msg: `ungoverned package.json key(s): ${unknownKeys.join(', ')} — assign an owning skill or remove` })
manualTodos.push({
  code: 'CI-1',
  msg: 'CI workflow content — .github/workflows/ci.yml must be authored/edited by hand (mise-action install, no hardcoded version, "bun run ki:audit && bun run test" gate)'
})
manualTodos.push({
  code: 'TEST-4',
  msg: 'monorepo-specific checks (§0) — per-workspace tsc and per-workspace vitest scoping need a human call on repo shape'
})
manualTodos.push({
  code: 'BUILD-1',
  msg: "compiled-build / cli-chmod steps — build script body, tsconfig.build.json shape, files/dist, and the exact chmod target(s) depend on this repo's src/ layout"
})
manualTodos.push({
  code: 'ENV-2',
  msg: 'env / secret-related findings — NODE_ENV leaks outside dev/inspect scripts and .env*.example authoring are never auto-fixed (could mask a real leak)'
})
manualTodos.push({
  code: 'TSC-2',
  msg: 'field-level repairs inside an EXISTING tsconfig.json / biome.json / knip.json — only scaffolded when the file was missing entirely; existing-file drift is judgment'
})
for (const todo of manualTodos) {
  say(`  - ${todo.msg}`)
  rec('ADVISORY', todo.code, todo.msg, RUBRIC)
}

say(
  `\n${paint(C.dim, 'mechanical layer applied — re-run `bun scripts/audit.ts .` (or `ki:engineering:audit`) to confirm findings clear.')}`
)
finishConform(target)
