#!/usr/bin/env bun
// Vendored by ki-bootstrap. Runs every ki:<skill>:<verb> package.json script in
// sequence for the given verb. Usage: bun scripts/ki/aggregate.ts <audit|conform|init>
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const verb = process.argv[2]
if (!verb) {
  console.error('usage: aggregate.ts <audit|conform|init>')
  process.exit(2)
}
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const keys = Object.keys(pkg.scripts ?? {}).filter((k) => /^ki:[a-z0-9-]+:/.test(k) && k.endsWith(':' + verb) && !/^ki:(audit|conform|init)$/.test(k))
let failed = 0
for (const k of keys.sort()) {
  console.log('\n\x1b[36m==> ' + k + '\x1b[0m')
  try {
    execFileSync('bun', ['run', k], { stdio: 'inherit' })
  } catch {
    failed++
  }
}
process.exit(failed > 0 ? 1 : 0)
