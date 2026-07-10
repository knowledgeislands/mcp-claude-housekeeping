#!/usr/bin/env bun
/**
 * Mechanical auditor for a workspace MCP repo.
 *
 *   bun scripts/audit-mcp.ts <repo-path>        # or: node after a build
 *
 * Checks the MCP DELTA of the standard the `ki-mcp` skill codifies —
 * the `src/` layout, `main`/`bin`/`exports`, the shared utils helpers, config-injection
 * surface, tool naming, and the MCP coverage-excludes. The COMMON toolchain (package.json
 * families, tsconfig/biome/vitest with 100% coverage, the `bun test` trap, .env, the
 * cli-chmod rule) is the `ki-engineering` layer — run audit-engineering.ts
 * first; it is not re-checked here. This script also does NOT judge tool-naming quality,
 * layer purity, or the security invariants — those need a human/agent read of the code
 * (see references/audit-rubric.md). Output is grouped pass/warn/fail; exit non-zero if any FAIL.
 *
 * No dependencies — Node/Bun builtins only.
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
  console.error('usage: audit-mcp.ts <repo-path>   (path must exist)')
  process.exit(2)
}
const at = (...p: string[]) => join(repo, ...p)
const has = (...p: string[]) => existsSync(at(...p))
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
const read = (...p: string[]): string => {
  try {
    return readFileSync(at(...p), 'utf8')
  } catch {
    return ''
  }
}
const isDir = (...p: string[]) => has(...p) && statSync(at(...p)).isDirectory()

// ── layout ──────────────────────────────────────────────────────────────────
for (const d of ['config', 'mcp-server', 'tools', 'main', 'utils']) {
  isDir('src', d) ? add('PASS', 'layout', `src/${d}/ present`) : add('FAIL', 'layout', `src/${d}/ missing`)
}
const hasCli = isDir('src', 'cli')
if (hasCli) {
  for (const f of ['cli.ts', 'index.ts']) {
    has('src', 'cli', f) ? add('PASS', 'layout', `src/cli/${f} present`) : add('FAIL', 'layout', `src/cli/ exists but src/cli/${f} missing`)
  }
}

// MCP-family root docs (the MCP delta). README/CLAUDE presence + LICENSE/.gitignore/
// .editorconfig are ki-repo's layers (CLAUDE.md is universal there);
// toolchain configs are audit-engineering.ts's. .ki-config.toml is repo's shared
// contract, but this skill reads its OWN [ki-mcp] opt-in table (checked near the
// end). The CLAUDE.md content
// contract (no drift) stays a judgment item. Here: ROADMAP + CONTRIBUTING + SECURITY present,
// CHANGELOG present AND non-empty.
has('ROADMAP.md') ? add('PASS', 'files', 'ROADMAP.md present') : add('WARN', 'files', 'no ROADMAP.md')
for (const f of ['CONTRIBUTING.md', 'SECURITY.md']) {
  has(f) ? add('PASS', 'files', `${f} present`) : add('FAIL', 'files', `${f} missing`)
}
if (!has('CHANGELOG.md')) add('FAIL', 'files', 'CHANGELOG.md missing')
else
  read('CHANGELOG.md').trim()
    ? add('PASS', 'files', 'CHANGELOG.md present and non-empty')
    : add('FAIL', 'files', 'CHANGELOG.md is an empty stub — add a release entry (e.g. 1.0.0) or remove it')

// vitest config presence — located only so the MCP coverage-exclude check below can read it.
const vitestFile = ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mts'].find((f) => has(f))

// ── package.json ──────────────────────────────────────────────────────────────
let pkg: Record<string, unknown> = {}
try {
  pkg = JSON.parse(read('package.json'))
} catch {
  add('FAIL', 'package', 'package.json missing or unparseable')
}
const scripts = (pkg.scripts ?? {}) as Record<string, string>
const name = String(pkg.name ?? basename(repo))

// ── CI delta: the smoke step. The common CI shape (mise-action + ki:lint:check / ki:lint:types /
// ki:lint:md:check + test:coverage) is engineering's, asserted by audit-engineering.ts; the MCP
// delta is the ki:test:smoke step appended after it.
if (scripts['ki:test:smoke'] && has('.github', 'workflows', 'ci.yml')) {
  read('.github', 'workflows', 'ci.yml').includes('bun run ki:test:smoke')
    ? add('PASS', 'ci', 'ci.yml runs ki:test:smoke (MCP delta, after the common gate)')
    : add('FAIL', 'ci', 'ci.yml must run "bun run ki:test:smoke" — the MCP delta, after the common engineering gate steps')
}
if (scripts['ki:test:smoke']) runCheck('smoke', 'ki:test:smoke', 'bun run ki:test:smoke')

const eq = (area: string, key: string, actual: unknown, want: unknown) =>
  actual === want
    ? add('PASS', area, `${key} = ${JSON.stringify(want)}`)
    : add('FAIL', area, `${key} should be ${JSON.stringify(want)}, got ${JSON.stringify(actual)}`)

// MCP delta only — `type`/`packageManager`/`engines`/`files` are the common engineering layer.
eq('package', 'main', pkg.main, 'dist/mcp-server/index.js')

const bin = (pkg.bin ?? {}) as Record<string, string>
Object.values(bin).includes('dist/mcp-server/index.js')
  ? add('PASS', 'package', 'bin → dist/mcp-server/index.js')
  : add('FAIL', 'package', 'bin must map to dist/mcp-server/index.js')

const exp = (pkg.exports ?? {}) as Record<string, unknown>
for (const k of ['.', './config', './package.json']) {
  exp[k] !== undefined ? add('PASS', 'package', `exports has "${k}"`) : add('FAIL', 'package', `exports missing "${k}"`)
}

// MCP scripts: only the ki:server:mcp:* surface is MCP-specific. The ki:lint:*/deps:*/build/clean/
// test* families, the `bun test` trap, NODE_ENV-in-dev, and the cli-chmod rule are the common
// engineering layer (audit-engineering.ts).
for (const k of ['ki:server:mcp:dev', 'ki:server:mcp:inspect', 'ki:server:mcp:start']) {
  scripts[k] ? add('PASS', 'scripts', `${k} present`) : add('WARN', 'scripts', `MCP script "${k}" missing`)
}
// ki:generate:client — the mcporter typed-client codegen, required for every MCP.
scripts['ki:generate:client']
  ? add('PASS', 'scripts', 'ki:generate:client present (mcporter typed-client codegen)')
  : add('FAIL', 'scripts', 'MCP script "ki:generate:client" missing — the mcporter typed-client codegen')
// Auth-server delta (dual-server MCPs, e.g. gmail/m365): when src/auth-server/ exists,
// the ki:server:auth:* pair drives it.
if (isDir('src', 'auth-server')) {
  for (const k of ['ki:server:auth:dev', 'ki:server:auth:start']) {
    scripts[k]
      ? add('PASS', 'scripts', `${k} present (auth-server delta)`)
      : add('FAIL', 'scripts', `src/auth-server/ present but "${k}" missing (auth-server delta)`)
  }
}
// Record/replay integration harness: ki:test:record / ki:test:replay travel as a pair.
{
  const rec = Boolean(scripts['ki:test:record'])
  const rep = Boolean(scripts['ki:test:replay'])
  if (rec !== rep) add('WARN', 'scripts', 'ki:test:record and ki:test:replay must be defined together (mcporter record/replay harness)')
  else if (rec) add('PASS', 'scripts', 'ki:test:record + ki:test:replay present (integration harness)')
}

// ── shared utils helpers ──────────────────────────────────────────────────────
for (const f of ['access-level.ts', 'annotations.ts', 'audit-log.ts']) {
  has('src', 'utils', f) ? add('PASS', 'utils', `utils/${f} present`) : add('FAIL', 'utils', `shared utils/${f} missing`)
}

// ── config/index.ts surface ───────────────────────────────────────────────────
const cfg = read('src', 'config', 'index.ts')
if (cfg) {
  ;/export\s+(async\s+)?function\s+loadConfig|export\s+const\s+loadConfig/.test(cfg)
    ? add('PASS', 'config', 'config exports loadConfig')
    : add('FAIL', 'config', 'config/index.ts does not export loadConfig')
  cfg.includes('process.loadEnvFile')
    ? add('PASS', 'config', 'loadConfig uses process.loadEnvFile (Node .env parity)')
    : add('WARN', 'config', 'config/index.ts has no process.loadEnvFile call')
  if (/loadEnvFile\(\s*[`'"]\.\.?\//.test(cfg))
    add(
      'WARN',
      'config',
      'loadEnvFile uses a cwd-relative path (./…) — resolve from import.meta.url; the launched `node dist/…` runs from an arbitrary cwd, not the package root'
    )
  for (const sym of ['ACCESS_LEVELS', 'ACCESS_LEVEL_RANK', 'AuditLogMode']) {
    cfg.includes(sym) ? add('PASS', 'config', `config references ${sym}`) : add('WARN', 'config', `config missing ${sym}`)
  }
}

// ── ambient env reads outside config/ ─────────────────────────────────────────
const offenders: string[] = []
const walk = (dir: string) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'config') continue
      walk(full)
    } else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
      const rel = full.replace(`${repo}/`, '')
      // Entry points bootstrap config from env by design (loadConfig / .env loading):
      // mcp-server is the stdio entry, and cli.ts loads its own .env for Node parity.
      // Both are documented env entry points — skip them like config/.
      if (rel.endsWith('mcp-server/index.ts') || rel.endsWith('cli/cli.ts')) continue
      // Flag a real per-key ambient read, but NOT: a comment that merely mentions
      // process.env; capturing the whole object as an injectable default param
      // (`env = process.env`); or spreading it into a child-process env
      // (`...process.env`). A tool/main fn that reads `process.env.KEY` or passes
      // `process.env` into a call still trips this (that caught the notion-mirror bug).
      const hit = readFileSync(full, 'utf8')
        .split('\n')
        .some((ln) => {
          const i = ln.indexOf('process.env')
          if (i === -1) return false
          const trimmed = ln.trimStart()
          if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return false
          if (ln.slice(0, i).includes('//')) return false // an inline `// … process.env` comment
          if (/(?:=\s*|\.\.\.)process\.env(?![\w.[])/.test(ln)) return false // whole-object capture / spread
          return true
        })
      if (hit) offenders.push(rel)
    }
  }
}
if (isDir('src')) walk(at('src'))
offenders.length
  ? add('WARN', 'config', `process.env read outside config/ (verify each is intentional): ${offenders.join(', ')}`)
  : add('PASS', 'config', 'no process.env reads outside config/')

// ── MCP vitest coverage EXCLUDES ──────────────────────────────────────────────
// The 100% thresholds themselves are the common engineering layer (audit-engineering.ts);
// WHICH wiring layers an MCP excludes is the MCP delta, checked here.
if (vitestFile) {
  const vc = read(vitestFile)
  // The thin tool layer must be excluded; accept any glob that covers it
  // (`tools/**/index.ts`, the broader `tools/**`, or the older `tools/*/index.ts`).
  const coverageExcludes: [string, RegExp][] = [
    ['mcp-server/index.ts', /mcp-server\/index\.ts/],
    ['tools/**/index.ts', /tools\/\*\*(?:\/index\.ts)?|tools\/\*\/index\.ts/],
    ['utils/annotations.ts', /utils\/annotations\.ts/],
    // Generated typed client carries no test obligation.
    ['src/generated/**', /generated\/\*\*/]
  ]
  for (const [label, re] of coverageExcludes) {
    re.test(vc) ? add('PASS', 'vitest', `coverage excludes ${label}`) : add('WARN', 'vitest', `coverage should exclude ${label}`)
  }
}

// ── registered tool names ─────────────────────────────────────────────────────
const toolNames: string[] = []
if (isDir('src', 'tools')) {
  const tw = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name)
      if (e.isDirectory()) tw(full)
      else if (e.name.endsWith('.ts')) {
        const src = readFileSync(full, 'utf8')
        // Tools register via `server.registerTool('name', …)` OR via a local alias
        // (`const register = server.registerTool` then `register('name', …)`). Learn the
        // file's alias idents, then match calls of registerTool or any of them.
        const callers = new Set(['registerTool'])
        for (const m of src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(?:[\w.]+\.)?registerTool\b/g)) callers.add(m[1])
        const callRe = new RegExp(`\\b(?:${[...callers].join('|')})\\(\\s*['"]([a-z0-9_]+)['"]`, 'g')
        for (const m of src.matchAll(callRe)) toolNames.push(m[1])
      }
    }
  }
  tw(at('src', 'tools'))
}
if (toolNames.length) {
  // <app>_<resource>_<action> is 3 segments; metadata/lifecycle tools may drop the
  // resource segment (m365_about, *_auth_start) → 2 segments is also valid. Require
  // ≥2 segments so those documented names don't false-WARN; flag only 1-segment names.
  const bad = toolNames.filter((n) => !/^[a-z0-9]+(_[a-z0-9]+){1,}$/.test(n))
  add('PASS', 'tools', `registered tools (${toolNames.length}): ${toolNames.sort().join(', ')}`)
  bad.length
    ? add('WARN', 'tools', `names not matching <app>_<resource>_<action> (or _<action> for metadata): ${bad.join(', ')}`)
    : add('PASS', 'tools', 'all tool names look like <app>_<resource>_<action>')
} else {
  add('WARN', 'tools', 'no registerTool(...) calls found — verify tool registration')
}

// ── structured output: outputSchema + structuredContent pairing (SHOULD, spec 2025-11-25) ──
if (isDir('src', 'tools')) {
  let usesStructured = false
  let usesJsonResult = false
  let declaresOutputSchema = false
  const sw = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name)
      if (e.isDirectory()) sw(full)
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
        const src = readFileSync(full, 'utf8')
        if (/\bstructuredContent\b/.test(src)) usesStructured = true
        if (/\bjsonResult\b/.test(src)) usesJsonResult = true
        if (/\boutputSchema\b/.test(src)) declaresOutputSchema = true
      }
    }
  }
  sw(at('src', 'tools'))
  if (usesStructured && !declaresOutputSchema)
    add(
      'WARN',
      'tools',
      'tools return structuredContent but no outputSchema is declared — pair them (spec 2025-11-25) so clients can validate'
    )
  else if (usesStructured) add('PASS', 'tools', 'structuredContent paired with a declared outputSchema')
  // Tools using jsonResult return structured JSON; they should also adopt outputSchema + structuredContent
  if (usesJsonResult && !declaresOutputSchema)
    add(
      'WARN',
      'tools',
      'tools use jsonResult (returning JSON) but declare no outputSchema — add outputSchema + structuredContent (spec 2025-11-25 SHOULD)'
    )
}

// ── deterministic tool registration order ──
// Check that registerTool calls within each tool-group index.ts appear in consistent (non-random)
// order. We approximate: flag if any group file has registerTool calls where names are NOT sorted
// (alphabetical) AND not in any other recognisable stable pattern. We just check that the names are
// consistent across at least two successive calls — a heuristic flag for obvious shuffles.
if (isDir('src', 'tools')) {
  const groupFiles: string[] = []
  for (const e of readdirSync(at('src', 'tools'), { withFileTypes: true })) {
    if (e.isDirectory()) {
      const idxPath = at('src', 'tools', e.name, 'index.ts')
      if (existsSync(idxPath)) groupFiles.push(idxPath)
    }
  }
  const registerRe = /server\.registerTool\(\s*['"]([^'"]+)['"]/g
  for (const gf of groupFiles) {
    const src = readFileSync(gf, 'utf8')
    const names: string[] = []
    for (const m of src.matchAll(registerRe)) names.push(m[1])
    if (names.length >= 2) {
      const sorted = [...names].sort()
      const reverseSorted = [...names].sort().reverse()
      if (JSON.stringify(names) !== JSON.stringify(sorted) && JSON.stringify(names) !== JSON.stringify(reverseSorted)) {
        // Not alphabetical either way — flag as potentially non-deterministic
        add(
          'ADVISORY',
          'tools',
          `${gf.replace(at(''), '')}: registerTool order (${names.join(', ')}) is not alphabetical — verify it is intentionally stable`
        )
      } else {
        add('PASS', 'tools', `${gf.replace(at(''), '')}: tool registration order is deterministic (${names.join(', ')})`)
      }
    }
  }
}

// ── .ki-config.toml [ki-mcp] opt-in marker ──────────────────────
// The shared file is ki-repo's contract, but this skill reads its OWN
// table: an MCP repo opts into the MCP standard by declaring [ki-mcp]
// (ki-repo's coverage cascade enforces the same presence across the org,
// from the MCP-SDK dependency signal). Validate-down — no per-repo keys defined yet.
const kiMcp = read('.ki-config.toml')
if (!kiMcp) add('WARN', 'ki-config', '.ki-config.toml missing (ki-repo owns the contract)')
else if (!/^\[ki-mcp\]/m.test(kiMcp))
  add('WARN', 'ki-config', 'no [ki-mcp] table — add it to mark this repo as governed by the MCP standard')
else {
  add('PASS', 'ki-config', '[ki-mcp] table present')
  const body = kiMcp.split(/^\[ki-mcp\]/m)[1]?.split(/^\[/m)[0] ?? ''
  const KNOWN = new Set<string>([]) // no top-level options yet
  for (const m of body.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=/gm)) {
    KNOWN.has(m[1] as string)
      ? add('PASS', 'ki-config', `known key ${m[1]}`)
      : add('WARN', 'ki-config', `unknown key under [ki-mcp]: ${m[1]} (validate-down)`)
  }
}

// ── report ────────────────────────────────────────────────────────────────────
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

add('INFO', 'scope', 'MCP server delta only — compose with audit-engineering.ts (common toolchain) for full coverage')
add('ADVISORY', 'judgment', 'mechanical layer only — apply the [J] criteria in references/audit-rubric.md by reading')
emit(
  findings,
  repo,
  'mcp',
  `MCP standards audit — ${name}  (${repo})`,
  'MCP delta only — also run audit-engineering.ts (common toolchain) + the semantic pass in references/audit-rubric.md.'
)
