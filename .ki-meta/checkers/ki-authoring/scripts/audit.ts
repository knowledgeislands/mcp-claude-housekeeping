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
 * Judgment half: surfaces the [J] criteria from references/rubric.md as
 * ADVISORY findings. These cannot be automated — a reader must assess them.
 * The script names each criterion and cites where to read the standard.
 *
 * TOML conventions are judgment-only (no TOML formatter runs in the toolchain).
 *
 * It emits the canonical JSONL checker reporter stream; exit code is non-zero
 * iff any mechanical FAIL. The reporter is vendored locally from ki-skills.
 */
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type CheckerFinding,
  type CheckerLevel,
  checkerReporterExitCode,
  emitCheckerReporter,
  judgmentFindingsFromRubric
} from './vendored/ki-skills/checker-reporter.ts'

const findings: CheckerFinding[] = []
const add = (level: CheckerLevel, code: string, message: string, ref?: string, file?: string): void =>
  void findings.push({ type: 'M', level, code, message, ref, file })
function localRubricPath(): string {
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const skillRoot = basename(scriptDir) === 'scripts' ? dirname(scriptDir) : scriptDir
  return join(skillRoot, 'references', 'rubric.md')
}

const rubricPath = localRubricPath()

const repoArg = process.argv[2]
const repo = resolve(repoArg ?? '.')
if (!repoArg || !existsSync(repo)) {
  add('FAIL', 'MD-mech', 'audit target is missing or does not exist', 'references/markdown-authoring.md', repo)
  findings.push(...judgmentFindingsFromRubric(rubricPath))
  emitCheckerReporter({ mode: 'audit', concern: 'authoring', target: repo, findings })
  process.exit(checkerReporterExitCode(findings))
}
const at = (...p: string[]) => join(repo, ...p)
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
// .ki-meta/ holds vendored/generated bootstrap artifacts — the harness owns their
// formatting, so the target repo's Markdown gate must not judge them. Prettier gets the
// exclusion inline; markdownlint's lives in the owned .markdownlint-cli2.jsonc below.
const MD_CHECK_CMD =
  'bunx prettier --check "**/*.md" "!.ki-meta/**" "!src/generated/**" "!.claude/commands/**" "!.claude/skills/**" "!.claude/agents/**" "!.agents/skills/**" --ignore-path .gitignore && bunx markdownlint-cli2 "**/*.md"'

try {
  execSync(MD_CHECK_CMD, { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8' })
  add('PASS', 'MD-mech', 'Prettier + markdownlint clean', 'references/markdown-authoring.md')
} catch (err) {
  const out = (err as { stdout?: string; stderr?: string }).stdout ?? ''
  const detail = out.trim().split('\n').slice(0, 8).join('\n    ')
  add(
    'FAIL',
    'MD-mech',
    `Markdown mechanical check failed — run "bun run ki:authoring:conform" to fix\n    ${detail}`,
    'references/markdown-authoring.md'
  )
}

// ── owns: .prettierrc.json / .editorconfig — hash-drift check ────────────────────
// This skill owns both files wholly (SHAPE-16 `owns:`) — conform always corrects
// drift unconditionally, so a mismatch here is WARN (informational: conform fixes
// it), not FAIL. The table-reshape judgment below depends on printWidth; parse it
// from whatever is on disk so ADVISORY recipients see the real threshold even when
// the file is drifted.
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

function checkOwned(name: string, canonical: string): void {
  const current = read(name)
  if (!current) {
    add('WARN', 'OWNS', `missing — run ki:authoring:conform to scaffold it from the house template`, 'owns:', name)
    return
  }
  if (sha256(current) === sha256(canonical)) {
    add('PASS', 'OWNS', `matches the house template`, 'owns:', name)
  } else {
    add('WARN', 'OWNS', `has drifted from the house template — run ki:authoring:conform to correct it`, 'owns:', name)
  }
}

checkOwned('.prettierrc.json', PRETTIER_DEFAULT)
checkOwned('.editorconfig', EDITORCONFIG_DEFAULT)
checkOwned('.markdownlint-cli2.jsonc', MARKDOWNLINT_DEFAULT)

findings.push(...judgmentFindingsFromRubric(rubricPath))
emitCheckerReporter({ mode: 'audit', concern: 'authoring', target: repo, findings })
process.exit(checkerReporterExitCode(findings))
