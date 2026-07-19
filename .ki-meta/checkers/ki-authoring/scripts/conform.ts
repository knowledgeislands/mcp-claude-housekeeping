#!/usr/bin/env bun
/**
 * Mechanical CONFORM for the Knowledge Islands authoring conventions — the
 * write-pass twin of audit.ts's mechanical half.
 *
 *   bun scripts/conform.ts [path]   # default: cwd
 *   --dry-run                                  # check-mode only, write nothing
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
 * It emits the canonical JSONL checker reporter stream. `--dry-run` governs
 * writing only; each action becomes a typed record on the shared severity ladder.
 */
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type CheckerFinding,
  type CheckerLevel,
  checkerReporterExitCode,
  emitCheckerReporter,
  judgmentFindingsFromRubric
} from './vendored/ki-skills/checker-reporter.ts'

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const elementArg = argv.find((arg) => arg.startsWith('--mode-element='))
const modeElement = elementArg?.slice('--mode-element='.length)
if (modeElement !== undefined && modeElement !== 'authoring-config' && modeElement !== 'markdown-normalise') {
  console.error('error: --mode-element must be authoring-config or markdown-normalise')
  process.exit(2)
}
const runsConfig = modeElement === undefined || modeElement === 'authoring-config'
const runsMarkdown = modeElement === undefined || modeElement === 'markdown-normalise'
const target = resolve(argv.find((arg) => !arg.startsWith('-')) ?? '.')
const findings: CheckerFinding[] = []
const rec = (level: CheckerLevel, code: string, message: string, ref?: string, file?: string): void =>
  void findings.push({ type: 'M', level, code, message, ref, file })
function localRubricPath(): string {
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const skillRoot = basename(scriptDir) === 'scripts' ? dirname(scriptDir) : scriptDir
  return join(skillRoot, 'references', 'rubric.md')
}

const rubricPath = localRubricPath()

if (!existsSync(target)) {
  rec('FAIL', 'MD-mech', 'conform target does not exist', 'references/markdown-authoring.md', target)
  findings.push(...judgmentFindingsFromRubric(rubricPath))
  emitCheckerReporter({ mode: 'conform', concern: 'authoring', target, findings })
  process.exit(checkerReporterExitCode(findings))
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
  // \`.ki-meta/\` vendored checkers, generated source, and generated runtime payloads are
  // machine-produced (ADR-KI-HARNESS-TOOLCHAIN-005) — excluded like dist/, so their
  // formatting is never a finding. Command files are frontmatter-first runtime definitions,
  // while authored \`.claude/\` siblings such as workflows remain in scope.
  "ignores": ["dist/**", "**/node_modules/**", ".ki-meta/**", "src/generated/**", ".claude/commands/**", ".claude/skills/**", ".claude/agents/**", ".agents/skills/**"]
}
`

function syncOwned(name: string, canonical: string): void {
  const path = join(target, name)
  if (!existsSync(path)) {
    rec('POLISH', 'OWNS', `${name} scaffolded from the house template (was missing)`, 'owns:', name)
    if (!dryRun) writeFileSync(path, canonical)
    return
  }
  const current = readFileSync(path, 'utf8')
  if (sha256(current) === sha256(canonical)) {
    rec('PASS', 'OWNS', `${name} already canonical`, 'owns:', name)
    return
  }
  rec('POLISH', 'OWNS', `${name} drifted from the house template — ${dryRun ? 'would overwrite' : 'overwritten'}`, 'owns:', name)
  if (!dryRun) writeFileSync(path, canonical)
}

if (runsConfig) {
  syncOwned('.prettierrc.json', PRETTIER_DEFAULT)
  syncOwned('.editorconfig', EDITORCONFIG_DEFAULT)
  syncOwned('.markdownlint-cli2.jsonc', MARKDOWNLINT_DEFAULT)
}

// The Markdown gate tools, run directly (ki:lint:md is retired, TOOLCHAIN-001) — write mode
// runs --write/--fix; dry-run runs the check-mode twins and reports only.
// .ki-meta/ holds vendored/generated bootstrap artifacts — the harness owns their
// formatting, so the target repo's Markdown gate must not touch them. Prettier gets the
// exclusion inline; markdownlint's lives in the owned .markdownlint-cli2.jsonc (mirrors audit.ts).
const PRETTIER = dryRun
  ? 'bunx prettier --check "**/*.md" "!.ki-meta/**" "!src/generated/**" "!.claude/commands/**" "!.claude/skills/**" "!.claude/agents/**" "!.agents/skills/**" --ignore-path .gitignore'
  : 'bunx prettier --write "**/*.md" "!.ki-meta/**" "!src/generated/**" "!.claude/commands/**" "!.claude/skills/**" "!.claude/agents/**" "!.agents/skills/**" --ignore-path .gitignore'
const MARKDOWNLINT = dryRun ? 'bunx markdownlint-cli2' : 'bunx markdownlint-cli2 --fix'
const cmd = `${PRETTIER} && ${MARKDOWNLINT}`

if (runsMarkdown) {
  try {
    execSync(cmd, { cwd: target, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    rec(
      'PASS',
      'MD-mech',
      `Markdown ${dryRun ? 'already conforms' : 'conformed'} (Prettier + markdownlint-cli2)`,
      'references/markdown-authoring.md'
    )
  } catch {
    rec(
      dryRun ? 'WARN' : 'FAIL',
      'MD-mech',
      `Markdown ${dryRun ? 'has findings — run without --dry-run to fix' : 'conform pass reported issues (see above)'}`,
      'references/markdown-authoring.md'
    )
  }
}

findings.push(...judgmentFindingsFromRubric(rubricPath))
emitCheckerReporter({ mode: 'conform', concern: 'authoring', target, findings })
process.exit(checkerReporterExitCode(findings))
