#!/usr/bin/env bun
/**
 * Mechanical auditor for a workspace MCP repo.
 *
 *   bun scripts/audit.ts <repo-path>        # or: node after a build
 *
 * Checks the MCP DELTA of the standard the `ki-mcp` skill codifies —
 * the `src/` layout, `main`/`bin`/`exports`, the shared utils helpers, config-injection
 * surface, tool naming, and the config-gated MCP coverage excludes. The COMMON toolchain
 * (aggregate/scoped audit wiring, direct code tools, tsconfig/biome, config-gated Vitest,
 * the `bun test` trap, .env, and the cli-chmod rule) is the `ki-engineering` layer — run audit.ts
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
// area is the criterion identifier (references/audit-rubric.md); ref is its reference-doc
// pointer (the standard the criterion enforces); file names the path a file-scoped finding
// concerns. ref/file are optional and ride into --json for the aggregate to render.
type Finding = { level: Level; area: string; msg: string; ref?: string; file?: string }
const ORDER: Level[] = ['FAIL', 'WARN', 'POLISH', 'ADVISORY', 'INFO', 'NA', 'PASS']
const ICON: Record<Level, string> = { FAIL: '❌', WARN: '⚠️', POLISH: '✨', ADVISORY: '🧭', INFO: 'ℹ️', NA: '🚫', PASS: '✅' }
const findings: Finding[] = []
const add = (level: Level, area: string, msg: string, ref?: string, file?: string) => findings.push({ level, area, msg, ref, file })

// The standard the MCP-delta criteria enforce; the judgment handoff points at the rubric.
const STD = 'references/workspace-mcp-standard.md'
const RUBRIC = 'references/audit-rubric.md'

const repo = process.argv[2]
if (!repo || !existsSync(repo)) {
  console.error('usage: audit.ts <repo-path>   (path must exist)')
  process.exit(2)
}
const at = (...p: string[]) => join(repo, ...p)
const has = (...p: string[]) => existsSync(at(...p))
function runCheck(area: string, label: string, cmd: string, file?: string) {
  try {
    execSync(cmd, { cwd: repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    add('PASS', area, `${label} exits 0`, STD, file)
  } catch (e: unknown) {
    const err = e as { stderr?: string; stdout?: string }
    const detail = (err.stderr ?? err.stdout ?? '').trim()
    add('FAIL', area, detail ? `${label} failed:\n  ${detail.split('\n').join('\n  ')}` : `${label} failed`, STD, file)
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
const TOML = (globalThis as unknown as { Bun: { TOML: { parse(text: string): unknown } } }).Bun.TOML
const parseToml = (text: string): { document: Record<string, unknown> | null; malformed: boolean } => {
  try {
    return { document: TOML.parse(text) as Record<string, unknown>, malformed: false }
  } catch {
    return { document: null, malformed: true }
  }
}
const asTable = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

// Applicability is declaration OR structure. A repo with neither is outside the
// MCP standard; stop before emitting layout/package failures. Either signal keeps
// the complete audit active so declared-but-incomplete repos cannot escape it.
const kiMcpText = read('.ki-config.toml')
const parsedKiMcp = parseToml(kiMcpText)
const kiMcpTable = asTable(parsedKiMcp.document?.['ki-mcp'])
const declaresKiMcp = kiMcpTable !== null
const hasMcpStructure = isDir('src', 'mcp-server')
if (!declaresKiMcp && !parsedKiMcp.malformed && !hasMcpStructure) {
  add('NA', 'KI-CONFIG', 'ki-mcp not applicable: no [ki-mcp] declaration or src/mcp-server/ structural marker', STD)
  emit(findings, repo, 'mcp', `MCP standards audit — ${basename(repo)}  (${repo})`, '')
}

// ── layout ──────────────────────────────────────────────────────────────────
for (const d of ['config', 'mcp-server', 'tools', 'main', 'utils']) {
  isDir('src', d) ? add('PASS', 'LAY-1', `src/${d}/ present`, STD, `src/${d}`) : add('FAIL', 'LAY-1', `src/${d}/ missing`, STD, `src/${d}`)
}
const hasCli = isDir('src', 'cli')
if (hasCli) {
  for (const f of ['cli.ts', 'index.ts']) {
    has('src', 'cli', f)
      ? add('PASS', 'LAY-1', `src/cli/${f} present`, STD, `src/cli/${f}`)
      : add('FAIL', 'LAY-1', `src/cli/ exists but src/cli/${f} missing`, STD, `src/cli/${f}`)
  }
}

// MCP-family root docs (the MCP delta). README/CLAUDE presence + LICENSE/.gitignore/
// .editorconfig are ki-repo's layers (CLAUDE.md is universal there);
// toolchain configs are audit.ts's. .ki-config.toml is repo's shared
// contract, but this skill reads its OWN [ki-mcp] opt-in table (checked near the
// end). The CLAUDE.md content
// contract (no drift) stays a judgment item. Here: ROADMAP + CONTRIBUTING + SECURITY present,
// CHANGELOG present AND non-empty.
has('ROADMAP.md') ? add('PASS', 'FILES', 'ROADMAP.md present', STD, 'ROADMAP.md') : add('WARN', 'FILES', 'no ROADMAP.md', STD, 'ROADMAP.md')
for (const f of ['CONTRIBUTING.md', 'SECURITY.md']) {
  has(f) ? add('PASS', 'FILES', `${f} present`, STD, f) : add('FAIL', 'FILES', `${f} missing`, STD, f)
}
if (!has('CHANGELOG.md')) add('FAIL', 'FILES', 'CHANGELOG.md missing', STD, 'CHANGELOG.md')
else
  read('CHANGELOG.md').trim()
    ? add('PASS', 'FILES', 'CHANGELOG.md present and non-empty', STD, 'CHANGELOG.md')
    : add('FAIL', 'FILES', 'CHANGELOG.md is an empty stub — add a release entry (e.g. 1.0.0) or remove it', STD, 'CHANGELOG.md')

// vitest config presence — located only so the MCP coverage-exclude check below can read it.
const vitestFile = [
  'vitest.config.ts',
  'vitest.config.js',
  'vitest.config.mts',
  'vitest.config.cts',
  'vitest.config.mjs',
  'vitest.config.cjs'
].find((f) => has(f))

// ── package.json ──────────────────────────────────────────────────────────────
let pkg: Record<string, unknown> = {}
try {
  pkg = JSON.parse(read('package.json'))
} catch {
  add('FAIL', 'PKG-1', 'package.json missing or unparseable', STD, 'package.json')
}
const scripts = (pkg.scripts ?? {}) as Record<string, string>
const name = String(pkg.name ?? basename(repo))

// ── CI delta: the smoke step. The common CI shape (mise-action + aggregate ki:audit +
// runner-neutral test) is engineering's, asserted by audit.ts; the MCP delta is the
// ki:test:smoke step appended after it.
if (scripts['ki:test:smoke'] && has('.github', 'workflows', 'ci.yml')) {
  read('.github', 'workflows', 'ci.yml').includes('bun run ki:test:smoke')
    ? add('PASS', 'CI-1', 'ci.yml runs ki:test:smoke (MCP delta, after the common gate)', STD, '.github/workflows/ci.yml')
    : add(
        'FAIL',
        'CI-1',
        'ci.yml must run "bun run ki:test:smoke" — the MCP delta, after the common engineering gate steps',
        STD,
        '.github/workflows/ci.yml'
      )
}
if (scripts['ki:test:smoke']) runCheck('CI-2', 'ki:test:smoke', 'bun run ki:test:smoke')

const eq = (area: string, key: string, actual: unknown, want: unknown) =>
  actual === want
    ? add('PASS', area, `${key} = ${JSON.stringify(want)}`, STD, 'package.json')
    : add('FAIL', area, `${key} should be ${JSON.stringify(want)}, got ${JSON.stringify(actual)}`, STD, 'package.json')

// MCP delta only — `type`/`packageManager`/`engines`/`files` are the common engineering layer.
eq('PKG-1', 'main', pkg.main, 'dist/mcp-server/index.js')

const bin = (pkg.bin ?? {}) as Record<string, string>
Object.values(bin).includes('dist/mcp-server/index.js')
  ? add('PASS', 'PKG-1', 'bin → dist/mcp-server/index.js', STD, 'package.json')
  : add('FAIL', 'PKG-1', 'bin must map to dist/mcp-server/index.js', STD, 'package.json')

const exp = (pkg.exports ?? {}) as Record<string, unknown>
for (const k of ['.', './config', './package.json']) {
  exp[k] !== undefined
    ? add('PASS', 'PKG-1', `exports has "${k}"`, STD, 'package.json')
    : add('FAIL', 'PKG-1', `exports missing "${k}"`, STD, 'package.json')
}

// MCP scripts: only the ki:server:mcp:* surface is MCP-specific. Aggregate/scoped audit
// wiring, lifecycle scripts, the `bun test` trap, NODE_ENV-in-dev, and the cli-chmod rule
// are the common engineering layer (audit.ts).
for (const k of ['ki:server:mcp:dev', 'ki:server:mcp:inspect', 'ki:server:mcp:start']) {
  scripts[k]
    ? add('PASS', 'SCR-1', `${k} present`, STD, 'package.json')
    : add('WARN', 'SCR-1', `MCP script "${k}" missing`, STD, 'package.json')
}
// ki:generate:client — the mcporter typed-client codegen, required for every MCP.
scripts['ki:generate:client']
  ? add('PASS', 'SCR-1', 'ki:generate:client present (mcporter typed-client codegen)', STD, 'package.json')
  : add('FAIL', 'SCR-1', 'MCP script "ki:generate:client" missing — the mcporter typed-client codegen', STD, 'package.json')
// Auth-server delta (dual-server MCPs, e.g. gmail/m365): when src/auth-server/ exists,
// the ki:server:auth:* pair drives it.
if (isDir('src', 'auth-server')) {
  for (const k of ['ki:server:auth:dev', 'ki:server:auth:start']) {
    scripts[k]
      ? add('PASS', 'SCR-1', `${k} present (auth-server delta)`, STD, 'package.json')
      : add('FAIL', 'SCR-1', `src/auth-server/ present but "${k}" missing (auth-server delta)`, STD, 'package.json')
  }
}
// Record/replay integration harness: ki:test:record / ki:test:replay travel as a pair.
{
  const rec = Boolean(scripts['ki:test:record'])
  const rep = Boolean(scripts['ki:test:replay'])
  if (rec !== rep)
    add('WARN', 'SCR-1', 'ki:test:record and ki:test:replay must be defined together (mcporter record/replay harness)', STD, 'package.json')
  else if (rec) add('PASS', 'SCR-1', 'ki:test:record + ki:test:replay present (integration harness)', STD, 'package.json')
}

// ── shared utils helpers ──────────────────────────────────────────────────────
for (const f of ['access-level.ts', 'annotations.ts', 'audit-log.ts']) {
  has('src', 'utils', f)
    ? add('PASS', 'UTIL-1', `utils/${f} present`, STD, `src/utils/${f}`)
    : add('FAIL', 'UTIL-1', `shared utils/${f} missing`, STD, `src/utils/${f}`)
}

// ── config/index.ts surface ───────────────────────────────────────────────────
const cfg = read('src', 'config', 'index.ts')
if (cfg) {
  ;/export\s+(async\s+)?function\s+loadConfig|export\s+const\s+loadConfig/.test(cfg)
    ? add('PASS', 'CFG-1', 'config exports loadConfig', STD, 'src/config/index.ts')
    : add('FAIL', 'CFG-1', 'config/index.ts does not export loadConfig', STD, 'src/config/index.ts')
  cfg.includes('process.loadEnvFile')
    ? add('PASS', 'CONFIG', 'loadConfig uses process.loadEnvFile (Node .env parity)', STD, 'src/config/index.ts')
    : add('WARN', 'CONFIG', 'config/index.ts has no process.loadEnvFile call', STD, 'src/config/index.ts')
  if (/loadEnvFile\(\s*[`'"]\.\.?\//.test(cfg))
    add(
      'WARN',
      'CONFIG',
      'loadEnvFile uses a cwd-relative path (./…) — resolve from import.meta.url; the launched `node dist/…` runs from an arbitrary cwd, not the package root',
      STD,
      'src/config/index.ts'
    )
  for (const sym of ['ACCESS_LEVELS', 'ACCESS_LEVEL_RANK', 'AuditLogMode']) {
    cfg.includes(sym)
      ? add('PASS', 'CFG-1', `config references ${sym}`, STD, 'src/config/index.ts')
      : add('WARN', 'CFG-1', `config missing ${sym}`, STD, 'src/config/index.ts')
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
  ? add('WARN', 'CONFIG', `process.env read outside config/ (verify each is intentional): ${offenders.join(', ')}`, STD)
  : add('PASS', 'CONFIG', 'no process.env reads outside config/', STD)

// ── MCP vitest coverage EXCLUDES ──────────────────────────────────────────────
// The 100% thresholds themselves are the common engineering layer (audit.ts);
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
    re.test(vc)
      ? add('PASS', 'TEST-1', `coverage excludes ${label}`, STD, vitestFile)
      : add('WARN', 'TEST-1', `coverage should exclude ${label}`, STD, vitestFile)
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
  add('PASS', 'TOOL-1', `registered tools (${toolNames.length}): ${toolNames.sort().join(', ')}`, STD)
  bad.length
    ? add('WARN', 'TOOL-1', `names not matching <app>_<resource>_<action> (or _<action> for metadata): ${bad.join(', ')}`, STD)
    : add('PASS', 'TOOL-1', 'all tool names look like <app>_<resource>_<action>', STD)
} else {
  add('WARN', 'TOOL-1', 'no registerTool(...) calls found — verify tool registration', STD)
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
      'TOOL-1',
      'tools return structuredContent but no outputSchema is declared — pair them (spec 2025-11-25) so clients can validate',
      STD
    )
  else if (usesStructured) add('PASS', 'TOOL-1', 'structuredContent paired with a declared outputSchema', STD)
  // Tools using jsonResult return structured JSON; they should also adopt outputSchema + structuredContent
  if (usesJsonResult && !declaresOutputSchema)
    add(
      'WARN',
      'TOOL-1',
      'tools use jsonResult (returning JSON) but declare no outputSchema — add outputSchema + structuredContent (spec 2025-11-25 SHOULD)',
      STD
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
          'TOOL-1',
          `registerTool order (${names.join(', ')}) is not alphabetical — verify it is intentionally stable`,
          STD,
          gf.replace(at(''), '')
        )
      } else {
        add('PASS', 'TOOL-1', `tool registration order is deterministic (${names.join(', ')})`, STD, gf.replace(at(''), ''))
      }
    }
  }
}

// ── .ki-config.toml [ki-mcp] opt-in marker ──────────────────────
// The shared file is ki-repo's contract, but this skill reads its OWN
// table: an MCP repo opts into the MCP standard by declaring [ki-mcp]
// (ki-repo's coverage cascade enforces the same presence across the org,
// from the MCP-SDK dependency signal). Validate-down — no per-repo keys defined yet.
const kiMcp = kiMcpText
if (!kiMcp) add('WARN', 'KI-CONFIG', '.ki-config.toml missing (ki-repo owns the contract)', STD, '.ki-config.toml')
else if (!kiMcpTable)
  add('WARN', 'KI-CONFIG', 'no [ki-mcp] table — add it to mark this repo as governed by the MCP standard', STD, '.ki-config.toml')
else {
  add('PASS', 'KI-CONFIG', '[ki-mcp] table present', STD, '.ki-config.toml')
  const KNOWN = new Set<string>([]) // no top-level options yet
  for (const key of Object.keys(kiMcpTable)) {
    KNOWN.has(key)
      ? add('PASS', 'KI-CONFIG', `known key ${key}`, STD, '.ki-config.toml')
      : add('WARN', 'KI-CONFIG', `unknown key under [ki-mcp]: ${key} (validate-down)`, STD, '.ki-config.toml')
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
      console.log('→ to address: run /ki-mcp CONFORM   (judgment criteria: references/audit-rubric.md)')
    if (report) console.log(`report → ${join(reportDir, `${concern}.{md,json}`)}`)
    console.log('')
  }
  process.exit(summary.fail ? 1 : 0)
}

add('INFO', 'SCOPE', 'MCP server delta only — compose with audit.ts (common toolchain) for full coverage', RUBRIC)
add('ADVISORY', 'JUDGMENT', 'mechanical layer only — apply the [J] criteria in references/audit-rubric.md by reading', RUBRIC)
emit(
  findings,
  repo,
  'mcp',
  `MCP standards audit — ${name}  (${repo})`,
  'MCP delta only — also run audit.ts (common toolchain) + the semantic pass in references/audit-rubric.md.'
)
