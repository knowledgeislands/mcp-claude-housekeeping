/**
 * Canonical checker reporter for governance checkers.
 *
 * This module deliberately knows nothing about a skill's policy or terminal
 * presentation. A checker gives it already-collected findings; it creates the
 * shared JSONL event stream to stdout.
 *
 * Bootstrap copies this source beside every checker so the local import remains
 * valid in a vendored `.ki-meta/` payload.
 */

import { readFileSync } from 'node:fs'

export const CHECKER_LEVELS = ['FAIL', 'WARN', 'POLISH', 'ADVISORY', 'INFO', 'NA', 'PASS'] as const
export type CheckerLevel = (typeof CHECKER_LEVELS)[number]

export type MechanicalFinding = {
  type: 'M'
  level: CheckerLevel
  code: string
  message: string
  ref?: string
  file?: string
}

export type JudgmentFinding = {
  type: 'J'
  level: 'ADVISORY'
  code: string
  message: string
  ref: string
  file?: string
}

export type CheckerFinding = MechanicalFinding | JudgmentFinding

export type CheckerReporterRun = {
  version: 1
  runId: string
  mode: 'audit' | 'conform'
  concern: string
  target: string
  generatedAt: string
}

export type CheckerReporterMeta = CheckerReporterRun & {
  record: 'meta'
}

export type CheckerReporterFinding = CheckerReporterRun &
  CheckerFinding & {
    record: 'finding'
  }

export type CheckerReporterSummary = CheckerReporterRun & {
  record: 'summary'
  summary: Record<Lowercase<CheckerLevel>, number>
}

export type CheckerReporterEvent = CheckerReporterMeta | CheckerReporterFinding | CheckerReporterSummary

export type CheckerReporterInput = {
  mode: 'audit' | 'conform'
  concern: string
  target: string
  findings: CheckerFinding[]
}

const SUMMARY_KEYS = ['fail', 'warn', 'polish', 'advisory', 'info', 'na', 'pass'] as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const RUN_KEYS = ['version', 'runId', 'record', 'mode', 'concern', 'target', 'generatedAt'] as const

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function sameRunValue(left: unknown, right: unknown): boolean {
  return typeof left === 'string' && left === right
}

export type CheckerReporterParseResult = {
  events: unknown[]
  errors: string[]
}

export type RubricCriterion = {
  code: string
  title: string
  types: Set<'M' | 'J'>
}

function normaliseCriterionTitle(value: string): string {
  return value
    .replace(/^\s*(?:\[[^\]]+\]\s*)*/, '')
    .replace(/\s*\[[^\]]+\]/g, '')
    .replace(/^(?:FAIL|WARN|POLISH|ADVISORY|INFO|NA|PASS)\s*[—–-]\s*/i, '')
    .replace(/[`*_]/g, '')
    .trim()
}

function addCriterion(criteria: Map<string, RubricCriterion>, code: string, title: string, tags: string): void {
  const types = new Set<'M' | 'J'>()
  if (/\[[^\]]*\bM\b[^\]]*\]/.test(tags)) types.add('M')
  if (/\[[^\]]*\bJ\b[^\]]*\]/.test(tags)) types.add('J')
  if (types.size === 0) return

  const existing = criteria.get(code)
  if (existing) {
    for (const type of types) existing.types.add(type)
    return
  }
  criteria.set(code, { code, title: normaliseCriterionTitle(title), types })
}

/**
 * Read the bullet form used by KI rubrics without making the reporter depend on a
 * Markdown parser. The criterion title stays in that rubric: checkers emit only
 * stable codes, and consumers resolve presentation and validation locally.
 */
export function rubricCriteriaFromMarkdown(markdown: string): Map<string, RubricCriterion> {
  const criteria = new Map<string, RubricCriterion>()
  for (const line of markdown.split(/\r?\n/)) {
    const entry = line.match(/^\s*(?:-\s+)?(?:\[[ xX]\]\s+)?\*\*([^*]+)\*\*(.*)$/)
    if (!entry) {
      // Older checklist rubrics put the M/J tag before a later inline code, for
      // example `- [ ] [M] WARN — ... \`LAY-1\`: description`.
      const checklistCode = line.match(/^\s*-\s+\[[ xX]\][\s\S]*`([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)?)`/)?.[1]
      if (checklistCode) {
        const checklistTitle = line.slice(line.indexOf(`\`${checklistCode}\``) + checklistCode.length + 2).replace(/^\s*:\s*/, '')
        if (normaliseCriterionTitle(checklistTitle)) addCriterion(criteria, checklistCode, checklistTitle, line)
      }
      continue
    }
    const [, bold, after] = entry
    const tags = `${bold} ${after}`

    // Most current rubrics declare the code in the bold heading, for example
    // `**LAY-1 [M]** ...`. Retain named codes such as `JUDGMENT` too.
    const headingCode = bold.trim().match(/^(?:\[[^\]]+\]\s*)?`?([A-Z][A-Za-z0-9-]*)`?/)?.[1]
    if (headingCode) {
      const title = normaliseCriterionTitle(after)
      if (title) addCriterion(criteria, headingCode, title, tags)
      continue
    }

    // `ki-repo` predates that convention: it puts a short human label in bold
    // and the stable code in a following inline-code token. Treat that label as
    // the readable title, while still taking M/J ownership from the label tags.
    const trailingCode = after.match(/`{1,2}\s*`?([A-Z][A-Z0-9]*-[A-Z0-9]+)`?\s*`{1,2}/)?.[1]
    const title = normaliseCriterionTitle(bold)
    if (trailingCode && title) addCriterion(criteria, trailingCode, title, tags)
  }
  return criteria
}

export function rubricCriteriaFromFile(rubricPath: string): Map<string, RubricCriterion> {
  return rubricCriteriaFromMarkdown(readFileSync(rubricPath, 'utf8'))
}

/**
 * Enforce the rubric-aware part of the contract once a caller has parsed the
 * transport itself. This works over data, so both a source-fleet collector and
 * a vendored aggregate can use it without importing presentation code.
 */
export function validateCheckerReporterRubric(events: readonly unknown[], criteria: ReadonlyMap<string, RubricCriterion>): string[] {
  const errors: string[] = []
  const judgmentCounts = new Map<string, number>()
  for (const [index, event] of events.entries()) {
    if (!isRecord(event) || event.record !== 'finding') continue
    const label = `record ${index + 1}`
    const code = typeof event.code === 'string' ? event.code : ''
    const type = event.type === 'M' || event.type === 'J' ? event.type : undefined
    const criterion = criteria.get(code)
    if (!criterion) {
      errors.push(`${label} code does not resolve in the emitting rubric: ${code || '(empty)'}`)
      continue
    }
    if (!type || !criterion.types.has(type)) errors.push(`${label} type does not match rubric criterion: ${code}`)
    if (type === 'J') judgmentCounts.set(code, (judgmentCounts.get(code) ?? 0) + 1)

    const message = typeof event.message === 'string' ? event.message.trim() : ''
    const file = typeof event.file === 'string' ? event.file.trim() : ''
    const lower = message.toLowerCase()
    if (lower.startsWith(`${code.toLowerCase()}:`) || lower.startsWith(`${code.toLowerCase()} `))
      errors.push(`${label} message repeats its code: ${code}`)
    if (lower.startsWith(criterion.title.toLowerCase())) errors.push(`${label} message repeats its rubric title: ${code}`)
    if (lower.startsWith('[j]:')) errors.push(`${label} message repeats the judgment marker: ${code}`)
    if (file) {
      const basename = file.split('/').filter(Boolean).at(-1) ?? file
      if (lower.startsWith(file.toLowerCase()) || lower.startsWith(basename.toLowerCase()))
        errors.push(`${label} message repeats its file field: ${code}`)
    }
  }
  for (const [code, criterion] of criteria) {
    if (!criterion.types.has('J')) continue
    const count = judgmentCounts.get(code) ?? 0
    if (count !== 1) errors.push(`rubric judgment criterion must emit exactly one J finding: ${code} (found ${count})`)
  }
  return errors
}

/**
 * Turn the declaring skill's judgment rubric into its one-per-run review prompts.
 * The rubric remains the source of truth for codes and types; checkers only decide
 * their mechanical findings.
 */
export function judgmentFindingsFromRubric(rubricPath: string, ref = 'references/rubric.md'): CheckerFinding[] {
  return [...rubricCriteriaFromFile(rubricPath).values()]
    .filter((criterion) => criterion.types.has('J'))
    .map((criterion) => criterion.code)
    .sort()
    .map((code) => ({ type: 'J', level: 'ADVISORY', code, message: 'Review this judgment criterion against the audited scope.', ref }))
}

/** Parse JSON Lines without coupling a caller to a particular checker process. */
export function parseCheckerReporterJsonl(output: string): CheckerReporterParseResult {
  const events: unknown[] = []
  const errors: string[] = []
  for (const [index, raw] of output.split(/\r?\n/).entries()) {
    const line = raw.trim()
    if (!line) continue
    try {
      events.push(JSON.parse(line) as unknown)
    } catch {
      errors.push(`line ${index + 1} is not valid JSON`)
    }
  }
  return { events, errors }
}

/**
 * Validate one canonical checker run. This is deliberately data-only so the
 * source-harness fleet collector and the bootstrap aggregate can share the
 * exact contract without importing a renderer.
 */
export function validateCheckerReporterEvents(events: readonly unknown[], exitCode?: number): string[] {
  const errors: string[] = []
  if (events.length < 2) return ['a checker report must contain a meta and summary record']

  const first = events[0]
  const last = events.at(-1)
  if (!isRecord(first) || first.record !== 'meta') errors.push('first record must be meta')
  if (!isRecord(last) || last.record !== 'summary') errors.push('last record must be summary')
  if (!isRecord(first)) return errors

  const runId = first.runId
  const mode = first.mode
  const concern = first.concern
  const target = first.target
  const generatedAt = first.generatedAt
  if (!nonEmptyString(runId) || !UUID.test(runId)) errors.push('meta runId must be a UUID')
  if (mode !== 'audit' && mode !== 'conform') errors.push('meta mode must be audit or conform')
  if (!nonEmptyString(concern)) errors.push('meta concern must be non-empty')
  if (!nonEmptyString(target)) errors.push('meta target must be non-empty')
  if (!nonEmptyString(generatedAt) || Number.isNaN(Date.parse(generatedAt))) errors.push('meta generatedAt must be an ISO timestamp')

  const counts: Record<Lowercase<CheckerLevel>, number> = { fail: 0, warn: 0, polish: 0, advisory: 0, info: 0, na: 0, pass: 0 }
  let mechanicalFailure = false
  for (const [index, event] of events.entries()) {
    const label = `record ${index + 1}`
    if (!isRecord(event)) {
      errors.push(`${label} must be an object`)
      continue
    }
    const record = event.record
    if (record !== 'meta' && record !== 'finding' && record !== 'summary') {
      errors.push(`${label} has an invalid record kind`)
      continue
    }
    if (index > 0 && index < events.length - 1 && record !== 'finding') errors.push(`${label} must be a finding record`)
    const permitted =
      record === 'meta'
        ? RUN_KEYS
        : record === 'finding'
          ? [...RUN_KEYS, 'type', 'level', 'code', 'message', 'ref', 'file']
          : [...RUN_KEYS, 'summary']
    for (const key of Object.keys(event))
      if (!(permitted as readonly string[]).includes(key)) errors.push(`${label} has unknown field: ${key}`)
    for (const [field, expected] of Object.entries({ version: 1, runId, mode, concern, target, generatedAt })) {
      if (field === 'version') {
        if (event[field] !== expected) errors.push(`${label} version must be 1`)
      } else if (!sameRunValue(event[field], expected)) {
        errors.push(`${label} ${field} must match meta`)
      }
    }
    if (record !== 'finding') continue

    const type = event.type
    const level = event.level
    if (type !== 'M' && type !== 'J') errors.push(`${label} type must be M or J`)
    if (typeof level !== 'string' || !CHECKER_LEVELS.includes(level as CheckerLevel)) errors.push(`${label} level is not recognised`)
    if (!nonEmptyString(event.code)) errors.push(`${label} code must be non-empty`)
    if (!nonEmptyString(event.message)) errors.push(`${label} message must be non-empty`)
    if (event.ref !== undefined && !nonEmptyString(event.ref)) errors.push(`${label} ref must be non-empty when present`)
    if (event.file !== undefined && !nonEmptyString(event.file)) errors.push(`${label} file must be non-empty when present`)
    if (type === 'J' && level !== 'ADVISORY') errors.push(`${label} J finding must be ADVISORY`)
    if (type === 'J' && !nonEmptyString(event.ref)) errors.push(`${label} J finding must cite its criterion`)
    if (type === 'M' && (level === 'FAIL' || level === 'WARN' || level === 'POLISH') && !nonEmptyString(event.ref))
      errors.push(`${label} ${level} M finding must cite its criterion`)
    if (typeof level === 'string' && CHECKER_LEVELS.includes(level as CheckerLevel)) {
      counts[level.toLowerCase() as Lowercase<CheckerLevel>]++
      if (type === 'M' && level === 'FAIL') mechanicalFailure = true
    }
  }

  if (isRecord(last) && last.record === 'summary') {
    const summary = last.summary
    if (!isRecord(summary)) {
      errors.push('summary record must carry a summary object')
    } else {
      for (const key of SUMMARY_KEYS) {
        if (!Number.isInteger(summary[key]) || (summary[key] as number) < 0) errors.push(`summary ${key} must be a non-negative integer`)
        else if (summary[key] !== counts[key]) errors.push(`summary ${key} does not match findings`)
      }
      for (const key of Object.keys(summary))
        if (!SUMMARY_KEYS.includes(key as (typeof SUMMARY_KEYS)[number])) errors.push(`summary has unknown key: ${key}`)
    }
  }
  if (exitCode !== undefined && (exitCode !== 0) !== mechanicalFailure)
    errors.push('process exit status must be non-zero if and only if an M FAIL finding exists')
  return errors
}

function assertFinding(finding: CheckerFinding): void {
  if (!finding.code.trim()) throw new Error('checker finding code must be non-empty')
  if (!finding.message.trim()) throw new Error('checker finding message must be non-empty')
  if (finding.type === 'J' && !finding.ref?.trim()) throw new Error('J finding must cite its judgment criterion')
  if (finding.type === 'M' && ['FAIL', 'WARN', 'POLISH'].includes(finding.level) && !finding.ref?.trim())
    throw new Error(`${finding.level} M finding must cite its criterion`)
}

export function buildCheckerReporterEvents(input: CheckerReporterInput): CheckerReporterEvent[] {
  if (!input.concern.trim()) throw new Error('checker reporter concern must be non-empty')
  if (!input.target.trim()) throw new Error('checker reporter target must be non-empty')
  for (const finding of input.findings) assertFinding(finding)
  const summary: CheckerReporterSummary['summary'] = { fail: 0, warn: 0, polish: 0, advisory: 0, info: 0, na: 0, pass: 0 }
  for (const finding of input.findings) summary[finding.level.toLowerCase() as keyof typeof summary]++

  const run: CheckerReporterRun = {
    version: 1,
    runId: crypto.randomUUID(),
    mode: input.mode,
    concern: input.concern,
    target: input.target,
    generatedAt: new Date().toISOString()
  }

  return [
    { ...run, record: 'meta' },
    ...input.findings.map((finding) => ({ ...run, record: 'finding' as const, ...finding })),
    { ...run, record: 'summary', summary }
  ]
}

export function emitCheckerReporter(input: CheckerReporterInput): CheckerReporterEvent[] {
  const events = buildCheckerReporterEvents(input)
  for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`)
  return events
}

export function checkerReporterExitCode(findings: readonly CheckerFinding[]): number {
  return findings.some((finding) => finding.type === 'M' && finding.level === 'FAIL') ? 1 : 0
}
