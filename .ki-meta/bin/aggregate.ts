#!/usr/bin/env bun
// Vendored by ki-bootstrap. Runs each vendored skill checker under ../checkers/ in
// sequence for the given verb — no package.json required.
// Usage: bun .ki-meta/bin/aggregate.ts <audit|conform|educate|help> [--skill <ki-skill>] [--reporter-levels=<levels>]
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { planModeElements } from './mode-elements.ts'

const verb = process.argv[2]
if (!verb) {
  console.error('usage: aggregate.ts <audit|conform|educate|help> [--skill <ki-skill>] [--reporter-levels=<levels>]')
  process.exit(2)
}
const binDir = dirname(fileURLToPath(import.meta.url))
if (verb === 'educate' || verb === 'help') {
  // educate: whole-set re-bootstrap or a selected target-local educator payload.
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
if (verb !== 'audit' && verb !== 'conform') process.exit(0)
const checkersDir = join(binDir, '..', 'checkers')
if (!existsSync(checkersDir)) process.exit(0)
let checkers = readdirSync(checkersDir, { withFileTypes: true })
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
const FAILURE_LEVELS = ['FAIL', 'WARN', 'POLISH']
const verbed = verb === 'conform' ? 'conformed' : 'audited'
// Render one finding row: icon status [readable title (code)] file msg (ref). file/ref shown only when
// the finding carries them (structured fields — most checkers only populate them once
// swept). full=false trims msg to its first line (recap rows stay one-line).
// Fixed-width short level tags (fail/warn/pol/adv/info/na/pass) keep the identity column
// aligned at a tight 4-wide field — without them "advisory" would force an 8-wide pad.
// Icons are each two display columns (sub-width glyphs ⊘/⚠️/ℹ️ carry a trailing space),
// aligned across both body and recap rows.
const SHORT = { FAIL: 'fail', WARN: 'warn', POLISH: 'pol', ADVISORY: 'adv', INFO: 'info', NA: 'na', PASS: 'pass' }
const DEFAULT_REPORTER_LEVELS = new Set(FAILURE_LEVELS)
const parseReporterOptions = (args) => {
  let levels = DEFAULT_REPORTER_LEVELS
  let skill
  const childArgs = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    let value
    if (arg === '--reporter-levels') value = args[++index]
    else if (arg.startsWith('--reporter-levels=')) value = arg.slice('--reporter-levels='.length)
    else if (arg === '--skill') {
      skill = args[++index]
      if (!skill || !/^ki-[a-z0-9-]+$/.test(skill)) throw new Error('--skill requires one canonical ki-* skill name')
      continue
    } else if (arg.startsWith('--skill=')) {
      skill = arg.slice('--skill='.length)
      if (!/^ki-[a-z0-9-]+$/.test(skill)) throw new Error('--skill requires one canonical ki-* skill name')
      continue
    } else {
      childArgs.push(arg)
      continue
    }
    if (!value) throw new Error('--reporter-levels requires one or more comma-separated levels')
    const requested = value.toUpperCase() === 'ALL' ? LEVELS : value.split(',').map((level) => level.trim().toUpperCase())
    if (!requested.length || requested.some((level) => !LEVELS.includes(level)))
      throw new Error('--reporter-levels accepts comma-separated values from ' + LEVELS.join(', ') + ', or all')
    levels = new Set(requested)
  }
  return { levels, skill, childArgs }
}
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
  ' \x1b[2m[' + (title ? title + ' (' + code + ')' : code) + ']\x1b[0m' +
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
const reports = []
const reportErrors = []
let reporter
try {
  reporter = parseReporterOptions(process.argv.slice(3))
} catch (error) {
  console.error('error: ' + error.message)
  process.exit(2)
}
if (reporter.skill) {
  if (!checkers.includes(reporter.skill)) {
    console.error('error: no vendored checker for ' + reporter.skill)
    process.exit(2)
  }
  checkers = [reporter.skill]
}
const declarations = {}
for (const skill of checkers) {
  const declarationPath = join(checkersDir, skill, 'mode-elements.json')
  if (!existsSync(declarationPath)) {
    console.error('error: no vendored mode-element declaration for ' + skill)
    process.exit(2)
  }
  const stat = lstatSync(declarationPath)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    console.error('error: unsafe mode-element declaration for ' + skill)
    process.exit(2)
  }
  try {
    declarations[skill] = JSON.parse(readFileSync(declarationPath, 'utf8'))
  } catch {
    console.error('error: invalid mode-element JSON for ' + skill)
    process.exit(2)
  }
}
const planned = planModeElements(declarations, verb)
if (planned.errors.length) {
  console.error('error: invalid mode-element graph: ' + planned.errors.join('; '))
  process.exit(2)
}
const entryCounts = new Map()
for (const item of planned.order) {
  const key = item.skill + '/' + item.element.entry
  entryCounts.set(key, (entryCounts.get(key) || 0) + 1)
}
for (const { skill, element } of planned.order) {
  const dir = join(checkersDir, skill)
  const scriptPath = join(dir, element.entry)
  if (!existsSync(scriptPath)) {
    failed = true
    reportErrors.push({ skill, errors: ['declared entry is missing: ' + element.entry] })
    continue
  }
  const scriptStat = lstatSync(scriptPath)
  if (!scriptStat.isFile() || scriptStat.isSymbolicLink()) {
    failed = true
    reportErrors.push({ skill, errors: ['declared entry is unsafe: ' + element.entry] })
    continue
  }
  // The renderer consumes --reporter-levels itself. All other flags (for example
  // --dry-run) forward to every child, whose canonical JSONL stays complete.
  const selected = entryCounts.get(skill + '/' + element.entry) > 1 ? ['--mode-element=' + element.id] : []
  const res = spawnSync('bun', [scriptPath, '.', ...selected, ...reporter.childArgs], { encoding: 'utf8' })
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
  reports.push({ skill, key: 'ki:' + skill.replace(/^ki-/, '') + ':' + verb + '/' + element.id, findings, titles, summary: parsed.events.at(-1).summary })
  if ((res.status ?? 0) !== 0) failed = true
}
for (const report of reports) {
  const visible = report.findings.filter((finding) => reporter.levels.has(finding.level))
  if (!visible.length) continue
  console.log('\n\x1b[36m==> ' + report.key + '\x1b[0m')
  for (const finding of visible) {
    const level = finding.level
    console.log(
      findingLine(
        ICON[level],
        level,
        finding.code,
        report.titles.get(finding.code) || '',
        finding.file ?? '',
        finding.message,
        finding.ref ?? '',
        '',
        true
      )
    )
  }
  const summary = report.summary
  const sicon = summary.fail ? ICON.FAIL : summary.warn ? ICON.WARN : summary.polish ? ICON.POLISH : ICON.PASS
  console.log('  ' + sicon + ' \x1b[2msummary: FAIL=' + summary.fail + ' WARN=' + summary.warn + ' POLISH=' + summary.polish + '\x1b[0m')
}
console.log('\n\x1b[36m==> recap\x1b[0m')
const allFindings = reports.flatMap((report) =>
  report.findings.map((finding) => ({
    skill: report.skill,
    level: finding.level,
    code: finding.code,
    title: report.titles.get(finding.code) || '',
    msg: finding.message,
    ref: finding.ref ?? '',
    file: finding.file ?? ''
  }))
)
const recap = allFindings.filter((finding) => reporter.levels.has(finding.level))
if (recap.length === 0) {
  console.log('  \x1b[32m\u2705 no ' + [...reporter.levels].join(' / ') + ' findings across ' + verbed + ' skills\x1b[0m')
} else {
  console.log('  \x1b[1mselected findings\x1b[0m')
  for (const level of LEVELS)
    for (const h of recap.filter((finding) => finding.level === level))
      console.log(findingLine(ICON[level], level, h.code, h.title, h.file, h.msg, h.ref, h.skill, false))
}
const count = (level) => allFindings.filter((finding) => finding.level === level).length
const ticon = count('FAIL') ? ICON.FAIL : count('WARN') ? ICON.WARN : count('POLISH') ? ICON.POLISH : ICON.PASS
const suppressed = LEVELS.filter((level) => !reporter.levels.has(level))
const suppressedCounts = suppressed.map((level) => level + '=' + count(level)).join(' ')
console.log(
  '  ' +
    ticon +
    ' \x1b[2mtotals: FAIL=' +
    count('FAIL') +
    ' WARN=' +
    count('WARN') +
    ' POLISH=' +
    count('POLISH') +
    (suppressed.length ? ' (suppressed: ' + suppressedCounts + ')' : ' (all levels shown)') +
    '\x1b[0m'
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
