#!/usr/bin/env bun
/**
 * Mechanical CONFORM for the ki-mcp MCP-delta standard — fixes the subset of
 * audit.ts's findings that are unambiguous and reversible, leaving
 * everything that needs a human call (or a copy from a healthy sibling) as a
 * printed manual TODO.
 *
 * Scope: MCP delta only (package.json main/bin/exports literals + the
 * [ki-mcp] config marker). The common toolchain layer is ki-engineering's
 * CONFORM; src/ layout, MCP npm scripts, vitest excludes, config/index.ts
 * surface shape, and tool-naming are all judgment/copy-from-sibling work,
 * printed as manual TODOs here, never auto-fixed.
 *
 * Detection literals (dist/mcp-server/index.js, exports keys) are kept in
 * lockstep with audit.ts — copied rather than imported so each script
 * stays valid standalone (composition-only rule).
 *
 *   bun scripts/conform.ts [path]   # default: cwd
 *   --dry-run                            # print the plan, mutate nothing
 *
 * Fixes:
 *   - package.json `main` → 'dist/mcp-server/index.js' when missing/wrong.
 *   - package.json `bin` → adds/overwrites a bin entry pointing at
 *     'dist/mcp-server/index.js' (keyed off package name, or the existing
 *     single bin key if there is exactly one).
 *   - package.json `exports` → adds the missing '.', './config',
 *     './package.json' keys with conventional targets, without touching any
 *     keys already present.
 *   - .ki-config.toml: appends a `[ki-mcp]` marker table when absent, mirroring
 *     how conform.ts appends its own `[ki-repo]` marker.
 *   - Typed client: if `ki:generate:client` is already defined, runs it
 *     (`bun run ki:generate:client`) to regenerate `src/generated/client.ts` +
 *     `types.d.ts` against the current tool surface. Best-effort — it needs
 *     the server registered with mcporter and `dist/` already built (not the
 *     mcporter daemon; ki-mcp servers are ephemeral, so `mcporter emit-ts`
 *     spawns its own short-lived process). A failure is surfaced as a manual
 *     TODO, never fatal to the run.
 *
 * Deliberately NEVER touches (judgment → manual TODOs):
 *   - src/ layout (config/mcp-server/tools/main/utils presence) — scaffold by
 *     hand or copy from the closest healthy sibling.
 *   - Defining MCP-specific npm scripts in the first place (ki:server:mcp:*,
 *     ki:generate:client, ki:server:auth:*, ki:test:record/replay) — copy from
 *     a sibling package.json, don't invent. (Once `ki:generate:client` exists,
 *     CONFORM does run it — see Fixes above.)
 *   - vitest coverage excludes (mcp-server/index.ts, tools/**, etc.) — repo's
 *     own vitest.config.ts, edit by hand.
 *   - config/index.ts surface (loadConfig, process.loadEnvFile,
 *     ACCESS_LEVELS/ACCESS_LEVEL_RANK/AuditLogMode) — authoring judgment.
 *   - tool-naming conventions (<app>_<resource>_<action>) — renaming a
 *     registered tool is a breaking change for MCP clients; never auto-renamed.
 *
 * Zero npm dependencies (bun + node stdlib only). Exit code is non-zero only
 * on an unrecoverable error (package.json missing/unparseable); findings/
 * fixes never fail the run.
 */

import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// ── kept in lockstep with audit.ts ──
const MAIN_LITERAL = 'dist/mcp-server/index.js'
const EXPORTS_KEYS: Record<string, unknown> = {
  '.': { types: './dist/index.d.ts', default: `./${MAIN_LITERAL}` },
  './config': { types: './dist/config/index.d.ts', default: './dist/config/index.js' },
  './package.json': './package.json'
}

const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m' }
const paint = (c: string, s: string): string => `${c}${s}${C.reset}`

const KI_CONFIG = '.ki-config.toml'
const KI_SECTION = 'ki-mcp'
const KI_MARKER = `\n[${KI_SECTION}]\n`

async function main() {
  const argv = process.argv.slice(2)
  const dryRun = argv.includes('--dry-run')
  const target = resolve(argv.find((a) => !a.startsWith('-')) ?? '.')

  const pkgPath = join(target, 'package.json')
  if (!existsSync(pkgPath)) {
    console.error(paint(C.red, `package.json not found: ${pkgPath}`))
    process.exit(1)
    return
  }

  let pkgText: string
  let pkg: Record<string, unknown>
  try {
    pkgText = readFileSync(pkgPath, 'utf8')
    pkg = JSON.parse(pkgText)
  } catch (e) {
    console.error(paint(C.red, `package.json unparseable: ${String(e)}`))
    process.exit(1)
    return
  }

  console.log(paint(C.dim, `target: ${target}${dryRun ? '   (dry run)' : ''}\n`))

  let pkgChanged = false
  const manualTodos: string[] = []

  // ── a) main ──
  console.log(paint(C.cyan, 'package.json fields'))
  if (pkg.main !== MAIN_LITERAL) {
    console.log(`  ${paint(C.green, 'fix')}   main: ${JSON.stringify(pkg.main ?? undefined)} → ${JSON.stringify(MAIN_LITERAL)}`)
    pkg.main = MAIN_LITERAL
    pkgChanged = true
  } else {
    console.log(`  ${paint(C.dim, 'ok')}     main already ${MAIN_LITERAL}`)
  }

  // ── b) bin ──
  const bin = (pkg.bin ?? {}) as Record<string, string>
  const alreadyBin = Object.values(bin).includes(MAIN_LITERAL)
  if (!alreadyBin) {
    const keys = Object.keys(bin)
    const binKey = keys.length === 1 ? keys[0] : String(pkg.name ?? 'mcp-server').replace(/^@[^/]+\//, '')
    console.log(`  ${paint(C.green, 'fix')}   bin["${binKey}"] → ${MAIN_LITERAL}`)
    bin[binKey as string] = MAIN_LITERAL
    pkg.bin = bin
    pkgChanged = true
  } else {
    console.log(`  ${paint(C.dim, 'ok')}     bin already maps to ${MAIN_LITERAL}`)
  }

  // ── c) exports ──
  const exp = (pkg.exports ?? {}) as Record<string, unknown>
  let expChanged = false
  for (const k of Object.keys(EXPORTS_KEYS)) {
    if (exp[k] === undefined) {
      console.log(`  ${paint(C.green, 'fix')}   exports["${k}"] added`)
      exp[k] = EXPORTS_KEYS[k]
      expChanged = true
    } else {
      console.log(`  ${paint(C.dim, 'ok')}     exports["${k}"] already present`)
    }
  }
  if (expChanged) {
    pkg.exports = exp
    pkgChanged = true
  }

  if (pkgChanged && !dryRun) {
    // Preserve key order / trailing newline style as closely as reasonable —
    // JSON.stringify with 2-space indent matches the house package.json style.
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
  }
  if (!pkgChanged) console.log(`  ${paint(C.dim, 'nothing to fix')}`)

  // ── d) typed client (ki:generate:client) ──
  console.log(`\n${paint(C.cyan, 'typed client (ki:generate:client)')}`)
  const scripts = (pkg.scripts ?? {}) as Record<string, string>
  if (!scripts['ki:generate:client']) {
    console.log(`  ${paint(C.dim, 'skip')}   no ki:generate:client script (defining one is a manual TODO, see below)`)
  } else if (dryRun) {
    console.log(`  ${paint(C.dim, 'skip (dry run)')}   would run: bun run ki:generate:client`)
  } else {
    try {
      execSync('bun run ki:generate:client', { cwd: target, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
      console.log(`  ${paint(C.green, 'ran')}   bun run ki:generate:client — src/generated/{client.ts,types.d.ts} regenerated`)
    } catch (e) {
      const err = e as { stderr?: string; stdout?: string }
      const detail = (err.stderr ?? err.stdout ?? String(e)).trim().split('\n')[0]
      manualTodos.push(
        `ki:generate:client failed — regenerate by hand once fixed (verify \`dist/\` is built and the server is registered — \`mcporter list\`): ${detail}`
      )
      console.log(`  ${paint(C.red, 'failed')}  bun run ki:generate:client — see manual TODOs`)
    }
  }

  // ── e) [ki-mcp] config marker ──
  console.log(`\n${paint(C.cyan, `${KI_CONFIG} [${KI_SECTION}] marker`)}`)
  const kiPath = join(target, KI_CONFIG)
  const kiText = existsSync(kiPath) ? readFileSync(kiPath, 'utf8') : null
  if (kiText === null) {
    manualTodos.push(`${KI_CONFIG}: file missing entirely — ki-repo owns the contract; run its INIT/CONFORM first`)
    console.log(`  ${paint(C.dim, 'no .ki-config.toml — see manual TODOs')}`)
  } else if (/^\[ki-mcp\]/m.test(kiText)) {
    console.log(`  ${paint(C.dim, 'ok')}     [${KI_SECTION}] table already present`)
  } else {
    console.log(`  ${paint(C.green, 'fix')}   append [${KI_SECTION}] marker table`)
    if (!dryRun) {
      const sep = kiText.endsWith('\n') ? '' : '\n'
      writeFileSync(kiPath, `${kiText}${sep}${KI_MARKER}`)
    }
  }

  // ── judgment items — never guessed, always surfaced ──
  manualTodos.push(
    'layout: src/config, src/mcp-server, src/tools, src/main, src/utils presence/shape — scaffold by hand or copy from the closest healthy sibling MCP repo (audit.ts "layout" area)',
    'scripts: MCP-specific npm scripts (ki:server:mcp:dev/inspect/start, ki:generate:client, ki:server:auth:* for dual-server MCPs, ki:test:record+ki:test:replay pair) — copy from a sibling package.json (audit.ts "scripts" area)',
    'vitest: coverage excludes for mcp-server/index.ts, tools/**/index.ts, utils/annotations.ts, src/generated/** — edit vitest.config.ts by hand (audit.ts "vitest" area)',
    'config/index.ts surface: loadConfig export, process.loadEnvFile call (resolved from import.meta.url, not cwd-relative), ACCESS_LEVELS/ACCESS_LEVEL_RANK/AuditLogMode references — authoring judgment (audit.ts "config" area)',
    'tool naming: <app>_<resource>_<action> (or _<action> for metadata) — renaming a registered tool is a breaking change for MCP clients; never auto-renamed (audit.ts "tools" area)'
  )
  console.log(`\n${paint(C.cyan, 'manual TODOs (judgment — not scripted)')}`)
  for (const todo of manualTodos) console.log(`  - ${todo}`)
  console.log(
    `\n${paint(C.dim, 'mechanical layer applied — re-run `bun scripts/audit.ts <repo-path>` (or `ki:mcp:audit`) to confirm findings clear.')}`
  )
}

main().catch((err) => {
  console.error(`ERROR: ${String(err)}`)
  process.exit(1)
})
