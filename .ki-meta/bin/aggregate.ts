#!/usr/bin/env bun
// Vendored by ki-bootstrap. Runs each vendored skill checker under ../skills/ in
// sequence for the given verb — no package.json required.
// Usage: bun .ki-meta/bin/aggregate.ts <audit|conform|educate|help>
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const verb = process.argv[2]
if (!verb) {
  console.error('usage: aggregate.ts <audit|conform|educate|help>')
  process.exit(2)
}
const binDir = dirname(fileURLToPath(import.meta.url))
if (verb === 'educate' || verb === 'help') {
  // educate: the local re-sync prompt (re-run the remote chain at the manifest's ref).
  // help: the vendored HELP snapshots. Both exec the sibling wrapper.
  execFileSync(join(binDir, verb === 'educate' ? 'ki-educate' : 'ki-help'), process.argv.slice(3), { stdio: 'inherit' })
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

// The aggregate is the sole terminal renderer. Each checker is invoked normally and
// must emit the canonical JSONL stream. A malformed stream is a clear aggregate
// failure: the runner never falls back to a checker's legacy prose or wrapper format.
// Every icon must occupy two display columns so the level column aligns. Most are
// Emoji_Presentation=Yes glyphs (genuinely 2 cols everywhere); ⚠️/ℹ️ have narrow base
// chars that VS16 does NOT widen under wcwidth-style terminals (VS Code/xterm.js counts
// them 1 col), so they carry an explicit trailing space to make up the second column.
// NA uses 🚫 (a 2-col circle-slash) in place of the 1-col ⊘.
const ICON = { FAIL: '\u274c', WARN: '\u26a0\ufe0f ', POLISH: '\u2728', ADVISORY: '\ud83e\udded', INFO: '\u2139\ufe0f ', NA: '\ud83d\udeab', PASS: '\u2705' }
const LEVELS = ['FAIL', 'WARN', 'POLISH', 'ADVISORY', 'INFO', 'NA', 'PASS']
const SUMMARY_KEYS = ['fail', 'warn', 'polish', 'advisory', 'info', 'na', 'pass']
const RUN_KEYS = ['version', 'runId', 'record', 'mode', 'concern', 'target', 'generatedAt']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
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
const rubricTitleCache = new Map()
const rubricTitles = (skillDir) => {
  if (rubricTitleCache.has(skillDir)) return rubricTitleCache.get(skillDir)
  const titles = new Map()
  const rubric = join(skillDir, 'references', 'rubric.md')
  if (existsSync(rubric)) {
    for (const line of readFileSync(rubric, 'utf8').split(/\r?\n/)) {
      const bullet = line.match(/^\s*-\s+(?:\[[ xX]\]\s+)?\*\*([^*]+)\*\*(.*)$/)
      if (!bullet) continue
      const [, bold, after] = bullet
      const code = bold.trim().match(/^(?:\[[^\]]+\]\s*)?([A-Z][A-Za-z0-9-]*)/)?.[1]
      const tags = bold + ' ' + after
      if (!code || !/\[[^\]]*\b[JM]\b[^\]]*\]/.test(tags)) continue
      const title = after
        .replace(/^\s*(?:\[[^\]]+\]\s*)*/, '')
        .replace(/^(?:FAIL|WARN|POLISH|ADVISORY|INFO|NA|PASS)\s*[—–-]\s*/i, '')
        .replace(/[`*_]/g, '')
        .trim()
      if (title) titles.set(code, title)
    }
  }
  rubricTitleCache.set(skillDir, titles)
  return titles
}
const findingLine = (icon, level, code, title, file, msg, ref, skill, full) =>
  '  ' + icon + ' ' + (SHORT[level] || level.toLowerCase()).padEnd(4) +
  (skill ? ' ' + skill.padEnd(20) : '') +
  ' \x1b[2m[' + code + (title ? ': ' + title : '') + ']\x1b[0m' +
  (file ? ' \x1b[36m' + file + '\x1b[0m' : '') +
  ' ' + (full ? msg : String(msg).split('\n')[0]) +
  (ref ? ' \x1b[2m(' + ref + ')\x1b[0m' : '')

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const nonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0
const parseJsonl = (output) => {
  const events = []
  const errors = []
  for (const [index, raw] of output.split(/\r?\n/).entries()) {
    const line = raw.trim()
    if (!line) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      errors.push('line ' + (index + 1) + ' is not valid JSON')
    }
  }
  return { events, errors }
}
const validateReport = (events, exitCode, expectedMode) => {
  const errors = []
  if (events.length < 2) return ['report must contain meta and summary records']
  const meta = events[0]
  const summary = events.at(-1)
  if (!isRecord(meta) || meta.record !== 'meta') errors.push('first record must be meta')
  if (!isRecord(summary) || summary.record !== 'summary') errors.push('last record must be summary')
  if (!isRecord(meta)) return errors
  if (meta.version !== 1) errors.push('meta version must be 1')
  if (!nonEmptyString(meta.runId) || !UUID.test(meta.runId)) errors.push('meta runId must be a UUID')
  if (meta.mode !== expectedMode) errors.push('meta mode must be ' + expectedMode)
  if (!nonEmptyString(meta.concern) || !nonEmptyString(meta.target)) errors.push('meta concern and target must be non-empty')
  if (!nonEmptyString(meta.generatedAt) || Number.isNaN(Date.parse(meta.generatedAt))) errors.push('meta generatedAt must be an ISO timestamp')
  const counts = { fail: 0, warn: 0, polish: 0, advisory: 0, info: 0, na: 0, pass: 0 }
  let mechanicalFailure = false
  for (const [index, event] of events.entries()) {
    const label = 'record ' + (index + 1)
    if (!isRecord(event)) {
      errors.push(label + ' must be an object')
      continue
    }
    const record = event.record
    if (record !== 'meta' && record !== 'finding' && record !== 'summary') {
      errors.push(label + ' has an invalid record kind')
      continue
    }
    const permitted = record === 'meta' ? RUN_KEYS : record === 'finding' ? [...RUN_KEYS, 'type', 'level', 'code', 'message', 'ref', 'file'] : [...RUN_KEYS, 'summary']
    for (const key of Object.keys(event)) if (!permitted.includes(key)) errors.push(label + ' has unknown field: ' + key)
    if (event.version !== 1 || event.runId !== meta.runId || event.mode !== meta.mode || event.concern !== meta.concern || event.target !== meta.target || event.generatedAt !== meta.generatedAt)
      errors.push(label + ' must carry the meta run identity')
    if (index > 0 && index < events.length - 1 && record !== 'finding') {
      errors.push(label + ' must be a finding record')
      continue
    }
    if (record !== 'finding') continue
    if ((event.type !== 'M' && event.type !== 'J') || !LEVELS.includes(event.level)) errors.push(label + ' has an invalid finding type or level')
    if (!nonEmptyString(event.code) || !nonEmptyString(event.message)) errors.push(label + ' must carry a code and message')
    if (event.ref !== undefined && !nonEmptyString(event.ref)) errors.push(label + ' ref must be non-empty when present')
    if (event.file !== undefined && !nonEmptyString(event.file)) errors.push(label + ' file must be non-empty when present')
    if (event.type === 'J' && (event.level !== 'ADVISORY' || !nonEmptyString(event.ref))) errors.push(label + ' J findings must be cited ADVISORY records')
    if (event.type === 'M' && ['FAIL', 'WARN', 'POLISH'].includes(event.level) && !nonEmptyString(event.ref)) errors.push(label + ' non-passing M findings must cite their criterion')
    if (LEVELS.includes(event.level)) counts[event.level.toLowerCase()]++
    if (event.type === 'M' && event.level === 'FAIL') mechanicalFailure = true
  }
  if (isRecord(summary) && summary.record === 'summary') {
    if (!isRecord(summary.summary)) errors.push('summary record must carry a summary object')
    else for (const key of SUMMARY_KEYS) {
      if (!Number.isInteger(summary.summary[key]) || summary.summary[key] < 0 || summary.summary[key] !== counts[key]) errors.push('summary ' + key + ' does not match findings')
    }
    for (const key of Object.keys(summary.summary || {})) if (!SUMMARY_KEYS.includes(key)) errors.push('summary has unknown key: ' + key)
  }
  if ((exitCode !== 0) !== mechanicalFailure) errors.push('exit status must be non-zero if and only if an M FAIL finding exists')
  return errors
}

let failed = false
const recap = []
const reportErrors = []
const extraArgs = process.argv.slice(3)
for (const skill of skills) {
  const dir = join(skillsDir, skill)
  const script = readdirSync(dir).find((f) => pattern.test(f))
  if (!script) continue
  const key = 'ki:' + skill.replace(/^ki-/, '') + ':' + verb
  console.log('\n\x1b[36m==> ' + key + '\x1b[0m')
  const scriptPath = join(dir, script)
  // Flags after the verb (for example --dry-run) forward to every child. Reporting
  // is never a flag: canonical JSONL is the normal checker output.
  const res = spawnSync('bun', [scriptPath, '.', ...extraArgs], { encoding: 'utf8' })
  const parsed = parseJsonl(res.stdout ?? '')
  const errors = [...parsed.errors, ...validateReport(parsed.events, res.status ?? 1, verb)]
  if (res.error) errors.push('process failed to start: ' + res.error.message)
  if ((res.stderr ?? '').trim()) errors.push('checker wrote to stderr: ' + (res.stderr ?? '').trim().split('\n')[0])
  if (errors.length) {
    failed = true
    reportErrors.push({ skill, errors })
    continue
  }
  const findings = parsed.events.slice(1, -1)
  const titles = rubricTitles(dir)
  for (const finding of findings) {
    const level = finding.level
    const code = finding.code
    const title = titles.get(code) || ''
    const message = finding.message
    const ref = finding.ref ?? ''
    const file = finding.file ?? ''
    console.log(findingLine(ICON[level], level, code, title, file, message, ref, '', true))
    if (RECAP_LEVELS.includes(level)) recap.push({ skill, level, code, title, msg: message, ref, file })
  }
  const summary = parsed.events.at(-1).summary
  const sicon = summary.fail ? ICON.FAIL : summary.warn ? ICON.WARN : summary.polish ? ICON.POLISH : summary.advisory ? ICON.ADVISORY : ICON.PASS
  console.log('  ' + sicon + ' \x1b[2msummary: FAIL=' + summary.fail + ' WARN=' + summary.warn + ' POLISH=' + summary.polish + ' PASS=' + summary.pass + ' ADVISORY=' + summary.advisory + ' NA=' + summary.na + '\x1b[0m')
  if ((res.status ?? 0) !== 0) failed = true
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
      console.log(findingLine(ICON[level], level, h.code, h.title, h.file, h.msg, h.ref, h.skill, false))
}
if (reminders.length) {
  console.log('  \x1b[1mjudgment reminders (always on — read & assess)\x1b[0m')
  for (const h of reminders) console.log(findingLine(ICON.ADVISORY, 'ADVISORY', h.code, h.title, h.file, h.msg, h.ref, h.skill, false))
}
const count = (l) => recap.filter((r) => r.level === l).length
const ticon = count('FAIL') ? ICON.FAIL : count('WARN') ? ICON.WARN : count('POLISH') ? ICON.POLISH : ICON.PASS
console.log(
  '  ' + ticon + ' \x1b[2mtotals: FAIL=' + count('FAIL') + ' WARN=' + count('WARN') + ' POLISH=' + count('POLISH') + ' ADVISORY=' + count('ADVISORY') + '\x1b[0m'
)
if (reportErrors.length) {
  console.log('  \x1b[1minvalid checker reports\x1b[0m')
  for (const item of reportErrors) {
    const shown = item.errors.slice(0, 3)
    const remaining = item.errors.length - shown.length
    console.log('  ' + ICON.FAIL + ' fail ' + item.skill + ': ' + shown.join('; ') + (remaining ? '; +' + remaining + ' more' : ''))
  }
}
process.exit(failed ? 1 : 0)
