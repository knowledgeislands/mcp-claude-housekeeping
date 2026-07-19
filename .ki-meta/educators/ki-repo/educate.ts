#!/usr/bin/env bun
// Vendored by ki-bootstrap. A target-local EDUCATE launcher for ki-repo; it has no
// harness-relative imports and invokes the canonical bootstrap transport.
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const skill = "ki-repo"
const target = resolve(process.argv[2] ?? '.')
const args = process.argv.slice(3)
let ref = 'main'
let dryRun = false
let verbose = false
for (let index = 0; index < args.length; index++) {
  const arg = args[index]
  if (arg === '--help' || arg === '-h') {
    console.log('usage: ki-educate ' + skill + ' [--ref <ref>] [--dry-run] [--verbose]')
    console.log('  runs this target-local educator via the canonical bootstrap transport.')
    process.exit(0)
  }
  if (arg === '--dry-run') {
    dryRun = true
    continue
  }
  if (arg === '--verbose') {
    verbose = true
    continue
  }
  if (arg === '--ref' && args[index + 1]) {
    ref = args[++index] as string
    continue
  }
  console.error('unsupported educator argument: ' + arg)
  process.exit(2)
}
if (!/^[A-Za-z0-9._/-]+$/.test(ref) || ref.includes('..')) {
  console.error('unsafe harness ref: ' + ref)
  process.exit(2)
}
const url = 'https://raw.githubusercontent.com/knowledgeislands/ki-agentic-harness/' + ref + '/skills/keystone/ki-bootstrap/scripts/repo-bootstrap.sh'
const fetched = spawnSync('curl', ['-fsSL', url], { encoding: 'utf8' })
if (fetched.status !== 0 || !fetched.stdout) process.exit(fetched.status ?? 1)
const result = spawnSync('sh', ['-s', '--', target, '--ref', ref, '--seed', skill, ...(dryRun ? ['--dry-run'] : []), ...(verbose ? ['--verbose'] : [])], {
  input: fetched.stdout,
  stdio: ['pipe', 'inherit', 'inherit']
})
process.exit(result.status ?? 1)
