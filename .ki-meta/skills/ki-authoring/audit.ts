#!/usr/bin/env bun
/**
 * Mechanical auditor for the Knowledge Islands authoring conventions.
 *
 *   bun scripts/audit.ts <repo-path>
 *
 * Mechanical half: invokes Prettier --check + markdownlint-cli2 directly — this IS the
 * Markdown gate (audit = lint without fixing), self-sufficient so it never depends on
 * package.json or ki-engineering. The old ki:lint:md:check key is retired (TOOLCHAIN-001).
 *
 * Judgment half: surfaces the [J] criteria from references/audit-rubric.md as
 * ADVISORY findings. These cannot be automated — a reader must assess them.
 * The script names each criterion and cites where to read the standard.
 *
 * TOML conventions are judgment-only (no TOML formatter runs in the toolchain).
 *
 * Output is grouped by severity; exit code is non-zero iff any FAIL.
 * No dependencies — Node/Bun builtins only; no cross-skill imports.
 */
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
const has = (...p: string[]) => existsSync(at(...p))
const read = (...p: string[]): string => {
  try {
    return readFileSync(at(...p), 'utf8')
  } catch {
    return ''
  }
}

// ── mechanical: run Prettier + markdownlint-cli2 directly ────────────────────
// Self-sufficient — no package.json / ki-engineering dependency. Mirrors the
// the read-only Markdown gate — the same tools ki:authoring:conform runs with --write.
const name = basename(repo)
const MD_CHECK_CMD = 'bunx prettier --check "**/*.md" --ignore-path .gitignore && bunx markdownlint-cli2 "**/*.md"'

try {
  execSync(MD_CHECK_CMD, { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8' })
  add('PASS', 'md-mech', 'Prettier + markdownlint clean (MD-mech)')
} catch (err) {
  const out = (err as { stdout?: string; stderr?: string }).stdout ?? ''
  const detail = out.trim().split('\n').slice(0, 8).join('\n    ')
  add('FAIL', 'md-mech', `Markdown mechanical check failed — run "bun run ki:authoring:conform" to fix (MD-mech)\n    ${detail}`)
}

// ── mechanical: .prettierrc.json printWidth ────────────────────────────────────
// The table-reshape judgment depends on this value; surface it so ADVISORY
// recipients know the threshold.
const prettier = read('.prettierrc.json')
let printWidth = 140
if (!prettier) {
  add('WARN', 'toolchain', '.prettierrc.json missing — cannot confirm printWidth for MD-table threshold')
} else {
  const m = prettier.match(/"printWidth"\s*:\s*(\d+)/)
  if (m) {
    printWidth = Number(m[1])
    add('PASS', 'toolchain', `.prettierrc.json printWidth = ${printWidth} (the MD-table reshape threshold)`)
  } else {
    add('WARN', 'toolchain', '.prettierrc.json has no printWidth — table-reshape threshold unknown')
  }

  // proseWrap is load-bearing for this skill's own conform: anything but "never"
  // means the Prettier pass conform shells out to actively hard-wraps prose,
  // contradicting references/markdown-authoring.md's line-wrapping convention.
  const pw = prettier.match(/"proseWrap"\s*:\s*"(\w+)"/)
  if (pw?.[1] === 'never') {
    add('PASS', 'toolchain', '.prettierrc.json proseWrap = "never" (required — conform hard-wraps prose otherwise)')
  } else {
    add(
      'FAIL',
      'toolchain',
      `.prettierrc.json proseWrap must be "never" (found ${pw ? `"${pw[1]}"` : 'unset'}) — ` +
        'conform will hard-wrap prose lines, contradicting the house Markdown convention'
    )
  }
}

// ── judgment surface: Markdown [J] criteria ────────────────────────────────────
// Each advisory names the criterion ID from references/audit-rubric.md and what
// to look for. They are informational prompts — a reviewer must assess them.

add(
  'ADVISORY',
  'md-table',
  `MD-table [J]: tables exceeding printWidth (${printWidth}) must be reshaped — descriptive matrix → subheadings or bullet list; ` +
    'genuinely tabular data with one long column → keep table, move that column to footnotes with a one-char marker. ' +
    '(references/markdown-authoring.md)'
)

add(
  'ADVISORY',
  'md-footnote',
  'MD-footnote [J]: footnotes use the marker series † ‡ § ¶ ‖ (then doubled), reset per table; ' +
    'a second series ※ ❡ ¤ ¥ where one table needs two. Each footnote separated by a blank line. ' +
    '(references/markdown-authoring.md)'
)

add(
  'ADVISORY',
  'md-link',
  "MD-link [J]: link text must be descriptive (words you'd skim for) beyond what MD059 enforces. " +
    'Use relative markdown links in house files (SKILL.md, repo docs) — wikilinks are correct only ' +
    'in KB note content and agent system prompts (scoped by ki-kb / ki-agents LINK-2). ' +
    'Angle-bracket form for paths with spaces. (references/markdown-authoring.md)'
)

add(
  'ADVISORY',
  'md-cell-prose',
  'MD-cell-prose [J]: table cells must not contain long descriptive prose — move prose to a footnote, ' +
    'leave only a brief label + marker in the cell. (references/markdown-authoring.md)'
)

// ── judgment surface: TOML [J] criteria ───────────────────────────────────────
// TOML has no formatter, so every TOML criterion is judgment.

const hasKiConfig = has('.ki-config.toml')
if (!hasKiConfig) {
  add('NA', 'toml', 'no .ki-config.toml in repo — TOML criteria not applicable')
} else {
  add(
    'ADVISORY',
    'toml-keys',
    'TOML-keys [J]: keys lowercase, snake_case for multi-word, named for the noun the value holds ' +
      '(e.g. "visibility" not "repo_visibility_setting"). (references/toml-config.md)'
  )
  add('ADVISORY', 'toml-values', 'TOML-values [J]: strings double-quoted; short lists inline ["a", "b"]. (references/toml-config.md)')
  add(
    'ADVISORY',
    'toml-tables',
    'TOML-tables [J]: one table per skill, named for the skill, with sub-tables nested under it. ' + '(references/toml-config.md)'
  )
  add('ADVISORY', 'toml-comments', 'TOML-comments [J]: non-obvious keys carry a # line above with their why. (references/toml-config.md)')
}

// ── judgment surface: sync criterion ──────────────────────────────────────────
add(
  'ADVISORY',
  'sync',
  'sync [J]: the convention references, audit-rubric.md, and sources.md must agree; when a convention moves, all three move together (Mode REFRESH).'
)

// ── report ────────────────────────────────────────────────────────────────────
// Shared emit harness — copy verbatim across KI checkers (enforcement-framework §2/§5).
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
      console.log('→ to address: run /ki-authoring CONFORM   (judgment criteria: references/audit-rubric.md)')
    if (report) console.log(`report → ${join(reportDir, `${concern}.{md,json}`)}`)
    console.log('')
  }
  process.exit(summary.fail ? 1 : 0)
}

add('INFO', 'scope', 'authoring conventions — Markdown mechanical gate + judgment criteria surface')
add(
  'ADVISORY',
  'judgment',
  'mechanical half only for Markdown; TOML and all [J] criteria require human review — see references/audit-rubric.md'
)

emit(
  findings,
  repo,
  'authoring',
  `Authoring conventions audit — ${name}  (${repo})`,
  'Judgment criteria ([J]) are surfaced as ADVISORY — a reviewer must assess them by reading the document.'
)
