#!/usr/bin/env bun
/**
 * Mechanical CONFORM for the Knowledge Islands authoring conventions — the
 * thin write-pass twin of audit.ts's mechanical half.
 *
 *   bun scripts/conform.ts [path]   # default: cwd
 *   --dry-run                                  # check-mode only, write nothing
 *
 * Deliberately a THIN wrapper: it shells out to the exact same Prettier +
 * markdownlint-cli2 — the Markdown gate write pass (conform = lint WITH fixing) —
 * no bespoke fixers, no reinvented invocation. TOML has no formatter in the
 * toolchain (references/toml-config.md is judgment-only), so there is nothing
 * mechanical to conform there; the judgment layer (wide tables, link text,
 * TOML style) is out of scope for this script — see SKILL.md Mode CONFORM
 * step 1, which is a human/model task, not a mechanical one.
 *
 * Exit code is non-zero only on an unrecoverable error (target path missing);
 * never because Prettier/markdownlint reported changes or findings.
 */
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', red: '\x1b[31m', cyan: '\x1b[36m' }
const paint = (c: string, s: string): string => `${c}${s}${C.reset}`

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const target = argv.find((a) => !a.startsWith('-')) ?? '.'

if (!existsSync(target)) {
  console.error(paint(C.red, `${target}: no such path`))
  process.exit(2)
}

// The Markdown gate tools, run directly (ki:lint:md is retired, TOOLCHAIN-001) — write mode
// runs --write/--fix; dry-run runs the check-mode twins and reports only.
const PRETTIER = dryRun
  ? 'bunx prettier --check "**/*.md" --ignore-path .gitignore'
  : 'bunx prettier --write "**/*.md" --ignore-path .gitignore'
const MARKDOWNLINT = dryRun ? 'bunx markdownlint-cli2' : 'bunx markdownlint-cli2 --fix'
const cmd = `${PRETTIER} && ${MARKDOWNLINT}`

console.log(paint(C.dim, `target: ${target}${dryRun ? '   (dry run — check mode, no writes)' : ''}\n`))
console.log(`${paint(C.cyan, 'markdown')}`)
console.log(`  ${paint(C.dim, '$')} ${cmd}`)

try {
  const out = execSync(cmd, { cwd: target, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
  if (out.trim()) console.log(out.trim())
  console.log(`  ${paint(C.green, 'ok')}    Markdown ${dryRun ? 'already conforms' : 'conformed'} (Prettier + markdownlint-cli2)`)
} catch (e) {
  const out = ((e as { stdout?: string }).stdout ?? '').trim()
  const err = ((e as { stderr?: string }).stderr ?? '').trim()
  if (out) console.log(out)
  if (err) console.log(err)
  console.log(
    `  ${paint(dryRun ? C.red : C.red, dryRun ? 'diff' : 'fail')}  Markdown ${dryRun ? 'has findings — run without --dry-run to fix' : 'conform pass reported issues (see above)'}`
  )
}

console.log(`\n${paint(C.cyan, 'toml')}`)
console.log(
  `  ${paint(C.dim, 'skip')}  no TOML formatter in the toolchain — .ki-config.toml style is judgment-only (references/toml-config.md)`
)

console.log(
  `\n${paint(C.dim, 'mechanical layer applied — re-run `bun scripts/audit.ts ' + target + '` (or `ki:authoring:audit`) to confirm findings clear.')}`
)
console.log(paint(C.dim, 'Judgment criteria (wide tables, link text, TOML style) are not scripted — see SKILL.md Mode CONFORM step 1.'))
