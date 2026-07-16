#!/usr/bin/env bun
/**
 * Mechanical CONFORM for the Knowledge Islands authoring conventions — the
 * write-pass twin of audit.ts's mechanical half.
 *
 *   bun scripts/conform.ts [path]   # default: cwd
 *   --dry-run                                  # check-mode only, write nothing
 *   --json                                     # emit the CHK-004 wrapper instead of prose
 *
 * Owns `.prettierrc.json` and `.editorconfig` wholly (SHAPE-16 `owns:` —
 * this skill backs its own Markdown conform pass with Prettier, so it is the
 * sole author of both files): scaffold-if-missing, and since neither file has
 * legitimate per-repo content, unconditionally overwrite on hash drift. Then
 * shells out to the exact same Prettier + markdownlint-cli2 the Markdown gate
 * write pass runs (conform = lint WITH fixing) — no bespoke fixers, no
 * reinvented invocation. TOML has no formatter in the toolchain
 * (references/toml-config.md is judgment-only), so there is nothing mechanical
 * to conform there; the judgment layer (wide tables, link text, TOML style)
 * is out of scope for this script — see SKILL.md Mode CONFORM step 1, which
 * is a human/model task, not a mechanical one.
 *
 * `--json` reports the same finding wrapper audit emits (CHK-004/010), so the
 * aggregate renders conform and audit identically: each action becomes a finding
 * on the shared ladder (file written/overwritten → POLISH, already-canonical →
 * PASS, gate still failing → FAIL, judgment handoff → always-on ADVISORY).
 * `--json` governs *reporting*; `--dry-run` governs *writing* — the two compose.
 *
 * Exit code is non-zero only on an unrecoverable error (target path missing);
 * never because Prettier/markdownlint reported changes or findings.
 */
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m' }
const paint = (c: string, s: string): string => `${c}${s}${C.reset}`

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const json = argv.includes('--json')
const target = argv.find((a) => !a.startsWith('-')) ?? '.'

if (!existsSync(target)) {
  console.error(paint(C.red, `${target}: no such path`))
  process.exit(2)
}

// Collect-then-emit harness (mirrors audit.ts). Each action records a finding; `say`
// prints the human line only when not in --json mode, so a direct run streams prose
// while the aggregate consumes the wrapper. area is the rubric code, ref its
// reference-doc pointer, file the path an action concerns (CHK-004/009/010).
type Level = 'FAIL' | 'WARN' | 'POLISH' | 'ADVISORY' | 'INFO' | 'NA' | 'PASS'
type Finding = { level: Level; area: string; msg: string; ref?: string; file?: string }
const findings: Finding[] = []
const rec = (level: Level, area: string, msg: string, ref?: string, file?: string) => findings.push({ level, area, msg, ref, file })
const say = (line: string): void => {
  if (!json) console.log(line)
}

// ── owns: .prettierrc.json / .editorconfig — scaffold + unconditional overwrite on drift ──
// House style, no legitimate per-repo variation — so unlike a scaffold-if-missing-only
// file, drift here is always corrected, not just flagged (see plan: SHAPE-16 `owns:`).
const sha256 = (content: string): string => createHash('sha256').update(content).digest('hex')

const PRETTIER_DEFAULT = `{
  "printWidth": 160,
  "tabWidth": 2,
  "useTabs": false,
  "semi": false,
  "singleQuote": true,
  "proseWrap": "never",
  "trailingComma": "none",
  "overrides": [
    {
      "files": "*.md",
      "options": {
        "parser": "markdown"
      }
    }
  ]
}
`

const EDITORCONFIG_DEFAULT = `root = true

[*]
indent_style = space
indent_size = 2
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = true
insert_final_newline = true

[*.md]
trim_trailing_whitespace = false
`

const MARKDOWNLINT_DEFAULT = `{
  // Base: enable all rules, then selectively adjust below.
  "config": {
    "default": true,

    // MD013 - line length: disabled. Prettier owns line length via printWidth / proseWrap.
    "MD013": false,

    // MD024 - duplicate headings: allow in sibling sections only.
    "MD024": { "siblings_only": true },

    // MD025 - single H1: ignore the frontmatter title field.
    "MD025": { "front_matter_title": "" },

    // MD033 - inline HTML: disabled. <br> is used in table cells and skills use angle-bracket placeholders.
    "MD033": false,

    // MD036 - bold as heading: disabled. Bold labels are used intentionally in skill bodies.
    "MD036": false
  },

  // Skill bodies, references, and repo docs are all markdown content.
  "globs": ["**/*.md"],

  // Never lint generated output, vendored/generated trees, or dependencies. The
  // \`.ki-meta/\` vendored checkers + rendered help snapshots and the \`.claude/\` generated
  // skill/agent symlinks are machine-generated (ADR-KI-HARNESS-TOOLCHAIN-005) — excluded
  // like dist/, so their formatting is never a finding.
  "ignores": ["dist/**", "node_modules/**", ".ki-meta/**", ".claude/**"]
}
`

function syncOwned(name: string, canonical: string): void {
  const path = join(target, name)
  if (!existsSync(path)) {
    rec('POLISH', 'OWNS', `${name} scaffolded from the house template (was missing)`, 'owns:', name)
    say(`  ${paint(C.green, 'write')} ${name} (was missing — scaffolded from house template)`)
    if (!dryRun) writeFileSync(path, canonical)
    return
  }
  const current = readFileSync(path, 'utf8')
  if (sha256(current) === sha256(canonical)) {
    rec('PASS', 'OWNS', `${name} already canonical`, 'owns:', name)
    say(`  ${paint(C.dim, 'ok')}    ${name} already canonical`)
    return
  }
  rec('POLISH', 'OWNS', `${name} drifted from the house template — ${dryRun ? 'would overwrite' : 'overwritten'}`, 'owns:', name)
  say(`  ${paint(C.yellow, 'update')} ${name} (drifted from house standard — overwritten)`)
  if (!dryRun) writeFileSync(path, canonical)
}

say(`${paint(C.cyan, 'owned files')}`)
syncOwned('.prettierrc.json', PRETTIER_DEFAULT)
syncOwned('.editorconfig', EDITORCONFIG_DEFAULT)
syncOwned('.markdownlint-cli2.jsonc', MARKDOWNLINT_DEFAULT)
say('')

// The Markdown gate tools, run directly (ki:lint:md is retired, TOOLCHAIN-001) — write mode
// runs --write/--fix; dry-run runs the check-mode twins and reports only.
// .ki-meta/ holds vendored/generated bootstrap artifacts — the harness owns their
// formatting, so the target repo's Markdown gate must not touch them. Prettier gets the
// exclusion inline; markdownlint's lives in the owned .markdownlint-cli2.jsonc (mirrors audit.ts).
const PRETTIER = dryRun
  ? 'bunx prettier --check "**/*.md" "!.ki-meta/**" --ignore-path .gitignore'
  : 'bunx prettier --write "**/*.md" "!.ki-meta/**" --ignore-path .gitignore'
const MARKDOWNLINT = dryRun ? 'bunx markdownlint-cli2' : 'bunx markdownlint-cli2 --fix'
const cmd = `${PRETTIER} && ${MARKDOWNLINT}`

say(paint(C.dim, `target: ${target}${dryRun ? '   (dry run — check mode, no writes)' : ''}\n`))
say(`${paint(C.cyan, 'markdown')}`)
say(`  ${paint(C.dim, '$')} ${cmd}`)

try {
  const out = execSync(cmd, { cwd: target, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
  if (out.trim()) say(out.trim())
  rec(
    'PASS',
    'MD-mech',
    `Markdown ${dryRun ? 'already conforms' : 'conformed'} (Prettier + markdownlint-cli2)`,
    'references/markdown-authoring.md'
  )
  say(`  ${paint(C.green, 'ok')}    Markdown ${dryRun ? 'already conforms' : 'conformed'} (Prettier + markdownlint-cli2)`)
} catch (e) {
  const out = ((e as { stdout?: string }).stdout ?? '').trim()
  const err = ((e as { stderr?: string }).stderr ?? '').trim()
  if (out) say(out)
  if (err) say(err)
  rec(
    dryRun ? 'WARN' : 'FAIL',
    'MD-mech',
    `Markdown ${dryRun ? 'has findings — run without --dry-run to fix' : 'conform pass reported issues (see above)'}`,
    'references/markdown-authoring.md'
  )
  say(
    `  ${paint(C.red, dryRun ? 'diff' : 'fail')}  Markdown ${dryRun ? 'has findings — run without --dry-run to fix' : 'conform pass reported issues (see above)'}`
  )
}

say(`\n${paint(C.cyan, 'toml')}`)
rec('ADVISORY', 'TOML', 'no TOML formatter in the toolchain — .ki-config.toml style is judgment-only', 'references/toml-config.md')
say(`  ${paint(C.dim, 'skip')}  no TOML formatter in the toolchain — .ki-config.toml style is judgment-only (references/toml-config.md)`)

// Judgment handoff — always-on ADVISORY: the [J] criteria conform cannot mechanically
// fix, routed to a human/model pass (SKILL.md Mode CONFORM step 1).
rec(
  'ADVISORY',
  'JUDGMENT',
  'wide tables, link text, and TOML style are not scripted — apply the [J] criteria by reading (SKILL.md Mode CONFORM step 1)',
  'references/audit-rubric.md'
)
say(
  `\n${paint(C.dim, `mechanical layer applied — re-run \`bun scripts/audit.ts ${target}\` (or \`ki:authoring:audit\`) to confirm findings clear.`)}`
)
say(paint(C.dim, 'Judgment criteria (wide tables, link text, TOML style) are not scripted — see SKILL.md Mode CONFORM step 1.'))

if (json) {
  const n = (l: Level): number => findings.filter((f) => f.level === l).length
  const summary = {
    fail: n('FAIL'),
    warn: n('WARN'),
    polish: n('POLISH'),
    advisory: n('ADVISORY'),
    info: n('INFO'),
    na: n('NA'),
    pass: n('PASS')
  }
  process.stdout.write(JSON.stringify({ concern: 'authoring', target, generatedAt: new Date().toISOString(), summary, findings }))
}
