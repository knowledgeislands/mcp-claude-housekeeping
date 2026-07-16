#!/usr/bin/env bun
// Vendored by ki-bootstrap. Runs each vendored skill checker under ../skills/ in
// sequence for the given verb — no package.json required.
// Usage: bun .ki-meta/bin/aggregate.ts <audit|conform|init|help>
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const verb = process.argv[2]
if (!verb) {
  console.error('usage: aggregate.ts <audit|conform|init|help>')
  process.exit(2)
}
const binDir = dirname(fileURLToPath(import.meta.url))
if (verb === 'init' || verb === 'help') {
  // init: the local re-sync prompt (re-run the remote chain at the manifest's ref).
  // help: the vendored HELP snapshots. Both exec the sibling wrapper.
  execFileSync(join(binDir, verb === 'init' ? 'ki-init' : 'ki-help'), process.argv.slice(3), { stdio: 'inherit' })
  process.exit(0)
}
if (verb === 'refresh') {
  // REFRESH's write target is always a skill's own canonical files under skills/<name>/
  // in ki-agentic-harness — this vendored runner is by construction never running
  // there, so refresh is always out of scope here. Say so explicitly instead of
  // silently falling through the pattern match below to a bare exit(0).
  console.error(
    '\x1b[33m⚠️  REFRESH is harness-only\x1b[0m — it edits only its own canonical\n' +
      "files, which live in ki-agentic-harness. Run it there, or use ki-kb's\n" +
      'IMPROVE mode for a pattern recurring across bases.'
  )
  process.exit(3)
}
// Vendored copies are named by verb (audit.ts / conform.ts) — the skill dir already
// carries the identity.
const pattern = verb === 'audit' ? /^(audit|lint)\.ts$/ : verb === 'conform' ? /^conform\.ts$/ : null
if (!pattern) process.exit(0)
const skillsDir = join(binDir, '..', 'skills')
if (!existsSync(skillsDir)) process.exit(0)
const skills = readdirSync(skillsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort()

// Unified severity ladder — most audit-*.ts/lint-*.ts checkers normalize findings to
// { level, area, msg } and, under --json, wrap them as
// { concern, target, generatedAt, summary, findings }. A couple of outliers (e.g.
// ki-housekeeping) emit a bare findings array with { id, severity: <0-6>, message }
// instead — SEV_BY_NUM and the field fallbacks below absorb that variant too.
// Every icon must occupy two display columns so the level column aligns. Most are
// Emoji_Presentation=Yes glyphs (genuinely 2 cols everywhere); ⚠️/ℹ️ have narrow base
// chars that VS16 does NOT widen under wcwidth-style terminals (VS Code/xterm.js counts
// them 1 col), so they carry an explicit trailing space to make up the second column.
// NA uses 🚫 (a 2-col circle-slash) in place of the 1-col ⊘.
const ICON = { FAIL: '\u274c', WARN: '\u26a0\ufe0f ', POLISH: '\u2728', ADVISORY: '\ud83e\udded', INFO: '\u2139\ufe0f ', NA: '\ud83d\udeab', PASS: '\u2705' }
const SEV_BY_NUM = ['FAIL', 'WARN', 'POLISH', 'ADVISORY', 'INFO', 'NA', 'PASS']
// The recap splits real violations (FAIL/WARN/POLISH — the checker decided a criterion
// is broken) from ADVISORY (always-on judgment reminders the checker cannot decide). A
// genuine failure must never be buried under the unconditional reminders.
const FAILURE_LEVELS = ['FAIL', 'WARN', 'POLISH']
const RECAP_LEVELS = ['FAIL', 'WARN', 'POLISH', 'ADVISORY']
const verbed = verb === 'conform' ? 'conformed' : 'audited'
// Render one finding row: icon status [code] file msg (ref). file/ref shown only when
// the finding carries them (structured fields — most checkers only populate them once
// swept). full=false trims msg to its first line (recap rows stay one-line).
// Fixed-width short level tags (fail/warn/pol/adv/info/na/pass) keep the [code] column
// aligned at a tight 4-wide field — without them "advisory" would force an 8-wide pad.
// Icons are each two display columns (sub-width glyphs ⊘/⚠️/ℹ️ carry a trailing space),
// so [code] lands in a constant column across both body and recap rows.
const SHORT = { FAIL: 'fail', WARN: 'warn', POLISH: 'pol', ADVISORY: 'adv', INFO: 'info', NA: 'na', PASS: 'pass' }
const findingLine = (icon, level, code, file, msg, ref, skill, full) =>
  '  ' + icon + ' ' + (SHORT[level] || level.toLowerCase()).padEnd(4) +
  (skill ? ' ' + skill.padEnd(20) : '') +
  ' \x1b[2m[' + code + ']\x1b[0m' +
  (file ? ' \x1b[36m' + file + '\x1b[0m' : '') +
  ' ' + (full ? msg : String(msg).split('\n')[0]) +
  (ref ? ' \x1b[2m(' + ref + ')\x1b[0m' : '')
let failed = 0
const recap = []
const unstructured = []
const extraArgs = process.argv.slice(3).filter((a) => a !== '--json')
for (const skill of skills) {
  const dir = join(skillsDir, skill)
  const script = readdirSync(dir).find((f) => pattern.test(f))
  if (!script) continue
  const key = 'ki:' + skill.replace(/^ki-/, '') + ':' + verb
  console.log('\n\x1b[36m==> ' + key + '\x1b[0m')
  const scriptPath = join(dir, script)
  // Both verbs render through the same structured path: run --json, parse the wrapper,
  // render uniform rows, accumulate the recap. A checker (still) without --json support
  // falls back to its native display. For conform this means --json also drives the
  // writes (a conform without --json just runs its normal write pass and streams prose).
  // Flags after the verb (e.g. --dry-run) forward through to every child script —
  // conform's write pass must be skippable aggregate-wide, not just per-skill.
  const res = spawnSync('bun', [scriptPath, '.', ...extraArgs, '--json'], { encoding: 'utf8' })
  let parsed = null
  try {
    parsed = JSON.parse(res.stdout ?? '')
  } catch {
    parsed = null
  }
  const findingsArr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.findings) ? parsed.findings : null
  if (!findingsArr) {
    // no --json support (or a crash, or a shape we don't recognise) — fall back to
    // this checker's native display.
    process.stdout.write(res.stdout ?? '')
    process.stderr.write(res.stderr ?? '')
    unstructured.push(skill)
  } else {
    const counts = {}
    for (const raw of findingsArr) {
      const level =
        typeof raw.level === 'string'
          ? raw.level.toUpperCase()
          : typeof raw.severity === 'number'
            ? SEV_BY_NUM[raw.severity] ?? 'INFO'
            : typeof raw.severity === 'string'
              ? raw.severity.toUpperCase()
              : 'INFO'
      const area = String(raw.area ?? raw.criterion ?? raw.check ?? raw.id ?? '?')
      const msg = String(raw.msg ?? raw.message ?? '')
      const ref = raw.ref ? String(raw.ref) : ''
      const file = raw.file ? String(raw.file) : ''
      const icon = ICON[level] ?? ''
      console.log(findingLine(icon, level, area, file, msg, ref, '', true))
      counts[level] = (counts[level] ?? 0) + 1
      if (RECAP_LEVELS.includes(level)) recap.push({ skill, level, code: area, msg, ref, file })
    }
    const wrapperSummary = !Array.isArray(parsed) ? parsed?.summary : null
    const s = wrapperSummary ?? {
      fail: counts.FAIL ?? 0,
      warn: counts.WARN ?? 0,
      polish: counts.POLISH ?? 0,
      pass: counts.PASS ?? 0,
      advisory: counts.ADVISORY ?? 0,
      na: counts.NA ?? 0
    }
    // Icon prefixes the label; the KEY=n tokens stay byte-identical so CHK-005 parses.
    const sicon = (s.fail ?? 0) ? ICON.FAIL : (s.warn ?? 0) ? ICON.WARN : (s.polish ?? 0) ? ICON.POLISH : (s.advisory ?? 0) ? ICON.ADVISORY : ICON.PASS
    console.log(
      '  ' + sicon + ' \x1b[2msummary: FAIL=' +
        (s.fail ?? 0) +
        ' WARN=' +
        (s.warn ?? 0) +
        ' POLISH=' +
        (s.polish ?? 0) +
        ' PASS=' +
        (s.pass ?? 0) +
        ' ADVISORY=' +
        (s.advisory ?? 0) +
        ' NA=' +
        (s.na ?? 0) +
        '\x1b[0m'
    )
  }
  if ((res.status ?? 0) !== 0) failed++
}
console.log('\n\x1b[36m==> recap\x1b[0m')
const fails = recap.filter((r) => FAILURE_LEVELS.includes(r.level))
const reminders = recap.filter((r) => r.level === 'ADVISORY')
if (fails.length === 0) {
  console.log('  \x1b[32m\u2705 no FAIL / WARN / POLISH across ' + verbed + ' skills\x1b[0m')
} else {
  console.log('  \x1b[1mfailures & warnings\x1b[0m')
  for (const level of FAILURE_LEVELS)
    for (const h of fails.filter((r) => r.level === level))
      console.log(findingLine(ICON[level], level, h.code, h.file, h.msg, h.ref, h.skill, false))
}
if (reminders.length) {
  console.log('  \x1b[1mjudgment reminders (always on — read & assess)\x1b[0m')
  for (const h of reminders) console.log(findingLine(ICON.ADVISORY, 'ADVISORY', h.code, h.file, h.msg, h.ref, h.skill, false))
}
const count = (l) => recap.filter((r) => r.level === l).length
const ticon = count('FAIL') ? ICON.FAIL : count('WARN') ? ICON.WARN : count('POLISH') ? ICON.POLISH : ICON.PASS
console.log(
  '  ' + ticon + ' \x1b[2mtotals: FAIL=' + count('FAIL') + ' WARN=' + count('WARN') + ' POLISH=' + count('POLISH') + ' ADVISORY=' + count('ADVISORY') + '\x1b[0m'
)
if (unstructured.length) {
  console.log('  \x1b[2m(no structured output — see native output above for: ' + unstructured.join(', ') + ')\x1b[0m')
}
process.exit(failed > 0 ? 1 : 0)
