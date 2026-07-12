#!/usr/bin/env bun
/**
 * Mechanical CONFORM for the ki-engineering standard — fixes the subset of
 * audit.ts's findings that are unambiguous and reversible, leaving
 * everything that needs a human call as a printed manual TODO.
 *
 * Scope: a single target repo (default cwd), matching the house conform shape
 * (conform.ts, conform.ts) — `bun conform.ts .` /
 * `ki:engineering:conform`. Known-good defaults (canonical script bodies,
 * tsconfig/biome/prettier/knip field sets, required devDeps) are copied from
 * audit.ts rather than imported, so each script stays valid
 * standalone per the composition-only rule.
 *
 *   bun scripts/conform.ts [path]   # default: cwd
 *   --dry-run                                    # print the plan, mutate nothing
 *
 * Fixes:
 *   - package.json: `type`, `packageManager`, `engines.node`, the exact
 *     the aggregate `ki:audit`/`ki:conform`/`ki:init`/`ki:help` entrypoints + derived
 *     per-skill keys, `clean`, `prepare`, and running the write toolchain directly,
 *     missing toolchain devDependencies, and a missing/incomplete
 *     `lint-staged` block — all set/overwritten to the standard's exact value.
 *   - Scaffolds mise.toml / tsconfig.json / biome.json / .prettierrc.json /
 *     knip.json when absent entirely, using the same known-good defaults
 *     audit.ts checks against. Never overwrites an existing file
 *     of these (field-level repair inside an existing file is judgment — the
 *     rubric's [J] half — not scripted here).
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
 *   - Field-level repairs inside an EXISTING tsconfig/biome/prettier/knip file
 *     (only scaffolds when the file is missing entirely).
 *
 * Zero npm dependencies (bun + node stdlib only). Exit code is non-zero only on
 * an unrecoverable error (target dir not found / package.json unparseable);
 * findings/fixes never fail the run.
 */
import { execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m' }
const paint = (c: string, s: string): string => `${c}${s}${C.reset}`

// ── kept in lockstep with audit.ts ──
const REQUIRED_DEV = ['@biomejs/biome', 'knip', 'prettier', 'husky', 'lint-staged', 'markdownlint-cli2', 'syncpack', 'typescript']
// The aggregate entrypoints every governed repo exposes — identical everywhere, so
// canonical and added when missing. The per-tool ki:lint:*/ki:deps:*/ki:knip families
// and ki:verify are retired (TOOLCHAIN-001): the write tools run directly below.
const CANON: Record<string, string> = {
  'ki:audit': 'bun .ki-meta/bin/aggregate.ts audit',
  'ki:conform': 'bun .ki-meta/bin/aggregate.ts conform',
  'ki:init': 'bun .ki-meta/bin/aggregate.ts init',
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
const PRETTIER_DEFAULT = `{
  "proseWrap": "never",
  "printWidth": 140,
  "semi": false,
  "singleQuote": true,
  "trailingComma": "none",
  "overrides": [
    {
      "files": "*.md",
      "options": { "parser": "markdown" }
    }
  ]
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

function log(kind: 'fix' | 'write' | 'append' | 'skip' | 'run', label: string) {
  const tag = kind === 'skip' ? paint(C.dim, 'skip') : paint(C.green, kind)
  console.log(`  ${tag}   ${label}`)
}

// ── entry ──
const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const target = resolve(argv.find((a) => !a.startsWith('-')) ?? '.')

if (!existsSync(target)) {
  console.error(paint(C.red, `${target}: not found`))
  process.exit(1)
}
const pkgPath = join(target, 'package.json')
if (!existsSync(pkgPath)) {
  console.error(paint(C.red, `${target}: no package.json — not a TypeScript/Bun repo, nothing to conform`))
  process.exit(1)
}
let pkg: Record<string, unknown>
try {
  pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
} catch (e) {
  console.error(paint(C.red, `${pkgPath}: unparseable — ${String((e as Error).message ?? e)}`))
  process.exit(1)
}

console.log(paint(C.dim, `target: ${basename(target)}   (${target})${dryRun ? '   (dry run)' : ''}\n`))

let pkgChanged = false
const manualTodos: string[] = []

// ── package.json: core metadata fields ──
console.log(paint(C.cyan, 'package.json — metadata'))
{
  let any = false
  if (pkg.type !== 'module') {
    log('fix', `type: ${JSON.stringify(pkg.type)} → "module"`)
    pkg.type = 'module'
    pkgChanged = true
    any = true
  }
  if (!String(pkg.packageManager ?? '').startsWith('bun@')) {
    log('fix', `packageManager: ${JSON.stringify(pkg.packageManager)} → "bun@1.3.0"`)
    pkg.packageManager = 'bun@1.3.0'
    pkgChanged = true
    any = true
  }
  const engines = (pkg.engines ?? {}) as Record<string, string>
  const nodeOk = /^\s*>=\s*(\d+)/.test(engines.node ?? '') && Number((engines.node ?? '').match(/>=\s*(\d+)/)?.[1]) >= 22
  if (!nodeOk) {
    log('fix', `engines.node: ${JSON.stringify(engines.node)} → ">=22"`)
    pkg.engines = { ...engines, node: '>=22' }
    pkgChanged = true
    any = true
  }
  if (!any) console.log(`  ${paint(C.dim, 'nothing to fix')}`)
}

// ── package.json: required toolchain devDependencies ──
console.log(`\n${paint(C.cyan, 'package.json — toolchain devDependencies')}`)
{
  const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>
  const missing = REQUIRED_DEV.filter((d) => !(d in devDeps))
  if (!missing.length) {
    console.log(`  ${paint(C.dim, 'nothing to fix')}`)
  } else {
    for (const d of missing) {
      log('fix', `devDependencies.${d} = "${LATEST_DEV_VERSIONS[d]}" (added — run \`bun install\` after)`)
      devDeps[d] = LATEST_DEV_VERSIONS[d] as string
    }
    pkg.devDependencies = devDeps
    pkgChanged = true
    manualTodos.push('run `bun install` to materialize newly added devDependencies')
  }
}

// ── package.json: aggregate entrypoints + retired-key removal + derived per-skill keys ──
console.log(`\n${paint(C.cyan, 'package.json — aggregate entrypoints + per-skill keys')}`)
{
  const scripts = (pkg.scripts ?? {}) as Record<string, string>
  let any = false
  for (const [k, v] of Object.entries(CANON)) {
    if (scripts[k] !== v) {
      log('fix', scripts[k] ? `${k}: diverges from canonical → reset` : `${k}: missing → added`)
      scripts[k] = v
      any = true
    }
  }
  // Strip retired keys (ki:lint:* / ki:deps:* / ki:knip / ki:verify / ki:<skill>:lint).
  for (const k of Object.keys(scripts).filter(RETIRED_KEY)) {
    log('fix', `${k}: retired → removed (folded into ki:engineering:audit/conform + ki-authoring)`)
    delete scripts[k]
    any = true
  }
  // Derived per-skill keys for every vendored skill in .ki-meta (offline-safe).
  const metaSkills = join(target, '.ki-meta', 'skills')
  if (existsSync(metaSkills)) {
    for (const skill of readdirSync(metaSkills).filter((d) => statSync(join(metaSkills, d)).isDirectory())) {
      const suffix = skill.replace(/^ki-/, '')
      for (const mode of ['audit', 'conform'] as const) {
        if (!existsSync(join(metaSkills, skill, `${mode}.ts`))) continue
        const key = `ki:${suffix}:${mode}`
        const val = `bun .ki-meta/skills/${skill}/${mode}.ts .`
        if (scripts[key] !== val) {
          log('fix', scripts[key] ? `${key}: repointed → vendored ${skill}/${mode}.ts` : `${key}: missing → added`)
          scripts[key] = val
          any = true
        }
      }
    }
  }
  if (!scripts.clean?.includes('node_modules')) {
    log('fix', `clean: ${JSON.stringify(scripts.clean)} → "rm -rf dist node_modules"`)
    scripts.clean = 'rm -rf dist node_modules'
    any = true
  }
  if (scripts.prepare !== 'husky') {
    log('fix', `prepare: ${JSON.stringify(scripts.prepare)} → "husky"`)
    scripts.prepare = 'husky'
    any = true
  }
  if (any) {
    pkg.scripts = scripts
    pkgChanged = true
  } else {
    console.log(`  ${paint(C.dim, 'nothing to fix')}`)
  }
}

// ── package.json: lint-staged block ──
console.log(`\n${paint(C.cyan, 'package.json — lint-staged')}`)
{
  const lintStaged = pkg['lint-staged']
  const ls = lintStaged && typeof lintStaged === 'object' ? JSON.stringify(lintStaged) : ''
  const ok = ls.includes('@biomejs/biome') && ls.includes('prettier') && ls.includes('markdownlint')
  if (ok) {
    console.log(`  ${paint(C.dim, 'nothing to fix')}`)
  } else {
    log('fix', lintStaged ? 'lint-staged: incomplete → reset to standard fan-out' : 'lint-staged: missing → added')
    pkg['lint-staged'] = LINT_STAGED_DEFAULT
    pkgChanged = true
  }
}

if (pkgChanged && !dryRun) {
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
}

// ── scaffold: mise.toml / tsconfig.json / biome.json / .prettierrc.json / knip.json ──
console.log(`\n${paint(C.cyan, 'toolchain config files (scaffold only if absent)')}`)
function scaffold(name: string, path: string, content: string): void {
  if (existsSync(path)) {
    log('skip', `${name} already present — not touched (field-level repair is judgment)`)
    return
  }
  log('write', `${name} (known-good default)`)
  if (!dryRun) writeFileSync(path, content)
}
scaffold('mise.toml', join(target, 'mise.toml'), MISE_DEFAULT)
scaffold('tsconfig.json', join(target, 'tsconfig.json'), TSCONFIG_DEFAULT)
scaffold('biome.json', join(target, 'biome.json'), BIOME_DEFAULT)
scaffold('.prettierrc.json', join(target, '.prettierrc.json'), PRETTIER_DEFAULT)
const hasKnip = existsSync(join(target, 'knip.json')) || existsSync(join(target, 'knip.jsonc')) || existsSync(join(target, 'knip.ts'))
if (hasKnip) log('skip', 'knip config already present — not touched')
else scaffold('knip.json', join(target, 'knip.json'), KNIP_DEFAULT)

// ── .ki-config.toml [ki-engineering] marker ──
console.log(`\n${paint(C.cyan, '.ki-config.toml — [ki-engineering] marker')}`)
{
  const kiPath = join(target, KI_CONFIG)
  const kiText = existsSync(kiPath) ? readFileSync(kiPath, 'utf8') : ''
  if (/^\[ki-engineering\]/m.test(kiText)) {
    console.log(`  ${paint(C.dim, 'nothing to fix')}`)
  } else {
    log('append', `${KI_CONFIG} [ki-engineering] marker table`)
    if (!dryRun) {
      writeFileSync(kiPath, kiText ? `${kiText.replace(/\n*$/, '\n\n')}${KI_MARKER}` : KI_MARKER)
    }
  }
}

// ── run the write toolchain (conform = lint WITH fixing) ──
// The tools live INSIDE this conform now (TOOLCHAIN-001): Biome check --write + format
// --write, syncpack format, knip --fix, and a dependency refresh. Best-effort — a tool
// exiting non-zero (e.g. residual manual lint) is reported, never fatal.
console.log(`\n${paint(C.cyan, 'toolchain write pass (biome · syncpack · knip · deps)')}`)
{
  const steps: Array<[string, string]> = [
    ['biome check --write', 'bunx @biomejs/biome check --write --unsafe'],
    ['biome format --write', 'bunx @biomejs/biome format --write'],
    ['syncpack format', 'bunx syncpack format'],
    ['knip --fix', 'bunx knip --fix --no-config-hints'],
    ['bun update --latest', 'bun update --latest']
  ]
  for (const [label, cmd] of steps) {
    if (dryRun) {
      log('run', `${label} (skipped — dry run)`)
      continue
    }
    try {
      execSync(cmd, { cwd: target, stdio: 'ignore' })
      log('fix', label)
    } catch {
      log('skip', `${label} — exited non-zero (residual manual work; re-run ki:engineering:audit)`)
    }
  }
}

// ── judgment items — never guessed, always surfaced ──
console.log(`\n${paint(C.cyan, 'manual TODOs (judgment — not scripted)')}`)
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
  manualTodos.push(`ungoverned package.json key(s) [package]: ${unknownKeys.join(', ')} — assign an owning skill or remove`)
manualTodos.push(
  'CI workflow content [ci] — .github/workflows/ci.yml must be authored/edited by hand (mise-action install, no hardcoded version, "bun run ki:audit && bun run test" gate)'
)
manualTodos.push(
  'monorepo-specific checks [scripts/tests, §0] — per-workspace tsc and per-workspace vitest scoping need a human call on repo shape'
)
manualTodos.push(
  "compiled-build / cli-chmod steps [build] — build script body, tsconfig.build.json shape, files/dist, and the exact chmod target(s) depend on this repo's src/ layout"
)
manualTodos.push(
  'env / secret-related findings [env] — NODE_ENV leaks outside dev/inspect scripts and .env*.example authoring are never auto-fixed (could mask a real leak)'
)
manualTodos.push(
  'field-level repairs inside an EXISTING tsconfig.json / biome.json / .prettierrc.json / knip.json — only scaffolded when the file was missing entirely; existing-file drift is judgment'
)
for (const todo of manualTodos) console.log(`  - ${todo}`)

console.log(
  `\n${paint(C.dim, 'mechanical layer applied — re-run `bun scripts/audit.ts .` (or `ki:engineering:audit`) to confirm findings clear.')}`
)
