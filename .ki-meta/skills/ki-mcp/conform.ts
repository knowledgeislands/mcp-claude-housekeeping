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
 * Every invocation emits the canonical checker-reporter JSONL stream. `--dry-run`
 * governs writing only; findings retain the same criteria as their audit twins.
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
 *   - Vitest coverage excludes (mcp-server/index.ts, tools/**, etc.) — when the repo
 *     carries vitest.config.*, edit that file by hand.
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
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type CheckerFinding,
  checkerReporterExitCode,
  emitCheckerReporter,
  judgmentFindingsFromRubric
} from './vendored/ki-skills/checker-reporter.ts'

// ── kept in lockstep with audit.ts ──
const MAIN_LITERAL = 'dist/mcp-server/index.js'
const EXPORTS_KEYS: Record<string, unknown> = {
  '.': { types: './dist/index.d.ts', default: `./${MAIN_LITERAL}` },
  './config': { types: './dist/config/index.d.ts', default: './dist/config/index.js' },
  './package.json': './package.json'
}

// The standard the MCP-delta criteria enforce; the judgment handoff points at the rubric.
const STD = 'references/standards.md'
const RUBRIC = 'references/rubric.md'

const KI_CONFIG = '.ki-config.toml'
const KI_SECTION = 'ki-mcp'
const KI_MARKER = `\n[${KI_SECTION}]\n`

type Level = 'FAIL' | 'WARN' | 'POLISH' | 'ADVISORY' | 'INFO' | 'NA' | 'PASS'
const LOCAL_RUBRIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'references', 'rubric.md')

async function main() {
  const argv = process.argv.slice(2)
  const dryRun = argv.includes('--dry-run')
  const target = resolve(argv.find((a) => !a.startsWith('-')) ?? '.')

  const findings: CheckerFinding[] = []
  const rec = (level: Level, code: string, message: string, ref?: string, file?: string): void => {
    findings.push({ type: 'M', level, code, message, ...(ref ? { ref } : {}), ...(file ? { file } : {}) })
  }

  const pkgPath = join(target, 'package.json')
  if (!existsSync(pkgPath)) {
    rec('FAIL', 'PKG-1', 'Package manifest is absent.', STD, 'package.json')
    findings.push(...judgmentFindingsFromRubric(LOCAL_RUBRIC, RUBRIC))
    emitCheckerReporter({ mode: 'conform', concern: 'mcp', target, findings })
    process.exit(checkerReporterExitCode(findings))
    return
  }

  let pkgText: string
  let pkg: Record<string, unknown>
  try {
    pkgText = readFileSync(pkgPath, 'utf8')
    pkg = JSON.parse(pkgText)
  } catch {
    rec('FAIL', 'PKG-1', 'Package manifest cannot be parsed as JSON.', STD, 'package.json')
    findings.push(...judgmentFindingsFromRubric(LOCAL_RUBRIC, RUBRIC))
    emitCheckerReporter({ mode: 'conform', concern: 'mcp', target, findings })
    process.exit(checkerReporterExitCode(findings))
    return
  }

  let pkgChanged = false

  // ── a) main ──
  if (pkg.main !== MAIN_LITERAL) {
    rec('POLISH', 'PKG-1', `main ${dryRun ? 'would be set' : 'set'} to ${MAIN_LITERAL}`, STD, 'package.json')
    pkg.main = MAIN_LITERAL
    pkgChanged = true
  } else {
    rec('PASS', 'PKG-1', `main already ${MAIN_LITERAL}`, STD, 'package.json')
  }

  // ── b) bin ──
  const bin = (pkg.bin ?? {}) as Record<string, string>
  const alreadyBin = Object.values(bin).includes(MAIN_LITERAL)
  if (!alreadyBin) {
    const keys = Object.keys(bin)
    const binKey = keys.length === 1 ? keys[0] : String(pkg.name ?? 'mcp-server').replace(/^@[^/]+\//, '')
    rec('POLISH', 'PKG-1', `bin["${binKey}"] ${dryRun ? 'would map' : 'mapped'} to ${MAIN_LITERAL}`, STD, 'package.json')
    bin[binKey as string] = MAIN_LITERAL
    pkg.bin = bin
    pkgChanged = true
  } else {
    rec('PASS', 'PKG-1', `bin already maps to ${MAIN_LITERAL}`, STD, 'package.json')
  }

  // ── c) exports ──
  const exp = (pkg.exports ?? {}) as Record<string, unknown>
  let expChanged = false
  for (const k of Object.keys(EXPORTS_KEYS)) {
    if (exp[k] === undefined) {
      rec('POLISH', 'PKG-1', `exports["${k}"] ${dryRun ? 'would be added' : 'added'}`, STD, 'package.json')
      exp[k] = EXPORTS_KEYS[k]
      expChanged = true
    } else {
      rec('PASS', 'PKG-1', `exports["${k}"] already present`, STD, 'package.json')
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
  // ── d) typed client (ki:generate:client) ──
  const scripts = (pkg.scripts ?? {}) as Record<string, string>
  if (!scripts['ki:generate:client']) {
    rec(
      'ADVISORY',
      'SCR-1',
      'no ki:generate:client script — defining one is a manual TODO (copy from a sibling package.json)',
      STD,
      'package.json'
    )
  } else if (dryRun) {
    rec('NA', 'SCR-1', 'ki:generate:client present — would run `bun run ki:generate:client` (dry run — not executed)', STD, 'package.json')
  } else {
    try {
      execSync('bun run ki:generate:client', { cwd: target, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
      rec(
        'POLISH',
        'SCR-1',
        'ran `bun run ki:generate:client` — src/generated/{client.ts,types.d.ts} regenerated',
        STD,
        'src/generated/client.ts'
      )
    } catch (e) {
      const err = e as { stderr?: string; stdout?: string }
      const detail = (err.stderr ?? err.stdout ?? String(e)).trim().split('\n')[0]
      rec(
        'FAIL',
        'SCR-1',
        `ki:generate:client failed — regenerate by hand once fixed (verify \`dist/\` is built and the server is registered — \`mcporter list\`): ${detail}`,
        STD,
        'src/generated/client.ts'
      )
    }
  }

  // ── e) [ki-mcp] config marker ──
  const kiPath = join(target, KI_CONFIG)
  const kiText = existsSync(kiPath) ? readFileSync(kiPath, 'utf8') : null
  if (kiText === null) {
    rec('ADVISORY', 'KI-CONFIG', `${KI_CONFIG} missing entirely — ki-repo owns the contract; run its EDUCATE/CONFORM first`, STD, KI_CONFIG)
  } else if (/^\[ki-mcp\]/m.test(kiText)) {
    rec('PASS', 'KI-CONFIG', `[${KI_SECTION}] table already present`, STD, KI_CONFIG)
  } else {
    rec('POLISH', 'KI-CONFIG', `[${KI_SECTION}] marker table ${dryRun ? 'would be appended' : 'appended'}`, STD, KI_CONFIG)
    if (!dryRun) {
      const sep = kiText.endsWith('\n') ? '' : '\n'
      writeFileSync(kiPath, `${kiText}${sep}${KI_MARKER}`)
    }
  }

  // ── mechanical work left for an operator ────────────────────────────────────
  const vitestFile = [
    'vitest.config.ts',
    'vitest.config.js',
    'vitest.config.mts',
    'vitest.config.cts',
    'vitest.config.mjs',
    'vitest.config.cjs'
  ].find((file) => existsSync(join(target, file)))
  const judgment: [string, string, string?][] = [
    [
      'LAY-1',
      'src/config, src/mcp-server, src/tools, src/main, src/utils presence/shape — scaffold by hand or copy from the closest healthy sibling MCP repo (audit "LAY-1" area)',
      'src'
    ],
    [
      'SCR-1',
      'MCP-specific npm scripts (ki:server:mcp:dev/inspect/start, ki:generate:client, ki:server:auth:* for dual-server MCPs, ki:test:record+ki:test:replay pair) — copy from a sibling package.json (audit "SCR-1" area)',
      'package.json'
    ],
    ...(vitestFile
      ? ([
          [
            'TEST-1',
            `coverage excludes for mcp-server/index.ts, tools/**/index.ts, utils/annotations.ts, src/generated/** — edit ${vitestFile} by hand (audit "TEST-1" area)`,
            vitestFile
          ]
        ] as [string, string, string?][])
      : []),
    [
      'CFG-1',
      'config/index.ts surface: loadConfig export, process.loadEnvFile call (resolved from import.meta.url, not cwd-relative), ACCESS_LEVELS/ACCESS_LEVEL_RANK/AuditLogMode references — authoring judgment (audit "CFG-1" area)',
      'src/config/index.ts'
    ],
    [
      'TOOL-1',
      'tool naming: <app>_<resource>_<action> (or _<action> for metadata) — renaming a registered tool is a breaking change for MCP clients; never auto-renamed (audit "TOOL-1" area)',
      undefined
    ]
  ]
  for (const [area, msg, file] of judgment) rec('ADVISORY', area, msg, STD, file)
  findings.push(...judgmentFindingsFromRubric(LOCAL_RUBRIC, RUBRIC))
  emitCheckerReporter({ mode: 'conform', concern: 'mcp', target, findings })
  process.exitCode = checkerReporterExitCode(findings)
}

main().catch((err) => {
  const target = resolve('.')
  const findings: CheckerFinding[] = [
    { type: 'M', level: 'FAIL', code: 'PKG-1', message: `Checker could not complete: ${String(err)}`, ref: STD }
  ]
  findings.push(...judgmentFindingsFromRubric(LOCAL_RUBRIC, RUBRIC))
  emitCheckerReporter({ mode: 'conform', concern: 'mcp', target, findings })
  process.exit(checkerReporterExitCode(findings))
})
