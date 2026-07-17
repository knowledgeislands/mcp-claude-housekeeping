#!/usr/bin/env bun
/**
 * Mechanical CONFORM for the Knowledge Islands repo standard — the [M] half of
 * references/repo-standard.md's "Applying it" recipe, scripted so it needn't be
 * copy-pasted by hand per repo.
 *
 * Scope: a single target repo (default cwd), matching how ki-bootstrap scaffolds
 * `ki:repo:conform` (`bun .../conform.ts .`) — not an org sweep like
 * audit.ts's `--org`, since conforming mutates and should be reviewed per-repo.
 *
 *   bun scripts/conform.ts [path]      # default: cwd
 *   --dry-run                                # print the plan, run nothing
 *   --json                                   # emit the cited-finding wrapper (audit's shape)
 *
 * Each action records a cited finding on the shared ladder — written/enabled/set → POLISH,
 * already-conformant → PASS, action failed → FAIL, judgment manual-TODO → ADVISORY — so the
 * aggregate renders conform and audit identically. `--json` governs *reporting*, `--dry-run`
 * governs *writing*; the two compose. A single atomic `gh` call that satisfies several fine
 * audit checks (merge+delete-branch, secret-scanning+push-protection) cites the parent code
 * and enumerates the covered checks; audit still emits each fine check with its own code.
 *
 * Every GitHub-settings action reads live state first (the same REST fields `audit.ts` checks,
 * via one `repos/${nwo}` fetch plus a handful of per-setting reads) and only issues a `gh` call
 * when that setting actually differs from the standard — an already-conformant setting records
 * PASS and is never re-written. This matters because a `gh` write is not silently free: it's a
 * live mutation (and, for branch-protection, PUT fully replaces the rule rather than patching
 * it), so skip-when-conformant is the correct behavior, not just a nicety.
 *
 * Applies, via `gh`:
 *   - Layer 2: merge method (squash-only), auto-delete-branch, Wiki/Projects off,
 *     Issues on, topics (public, standard set), branch protection (present-but-off
 *     by default; stripped unless the repo's [ki-repo.checks] opts branch-protection
 *     in, in which case the standard protection set is applied).
 *   - Layer 3: Dependabot alerts + security updates, allow_update_branch, secret
 *     scanning + push protection (public), Actions allowed_actions = all.
 * Scaffolds locally (only when absent, never overwritten):
 *   - .gitignore — from this skill's own template.
 *   - .ki-config.toml's missing [ki-repo] / [ki-authoring] root markers —
 *     audit.ts's `--educate` template, appended without rewriting existing bytes.
 * `.editorconfig` is owned by ki-authoring (it backs that skill's own Markdown
 * conform pass), not this skill.
 *
 * Deliberately NEVER touches (judgment — printed as manual TODOs instead):
 *   - README.md content, LICENSE content.
 *   - The GitHub description text, and whether visibility is the right call.
 *   - Whether a [ki-repo.checks] override is warranted for this repo.
 *   - default-branch rename (destructive; a repo not on `main` needs a deliberate,
 *     reviewed rename, not a scripted one).
 *
 * Requires `gh` authenticated with repo-admin scope. No npm dependencies.
 * Exit code is non-zero only on an unrecoverable error (can't resolve nameWithOwner).
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  type Stats,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, join, resolve } from 'node:path'

// ── the standard (kept in sync with audit.ts / references/repo-standard.md) ──
const TOPICS = ['mcp', 'model-context-protocol', 'claude', 'typescript', 'bun']
const REQUIRED_CHECK = 'build'
const ALLOWED_ACTIONS = 'all'
// Reference-doc pointers carried on every finding — identical to audit.ts, so a criterion
// cites the same (area, ref) in both. STD is the standard a mechanical action applies;
// RUBRIC is where the judgment (manual-TODO) criteria live.
const STD = 'references/repo-standard.md'
const RUBRIC = 'references/audit-rubric.md'
const CHECK_DEFAULTS: Record<string, boolean> = {
  'branch-protection': false,
  wiki: true,
  projects: true,
  issues: true,
  topics: true,
  'secret-scanning': true,
  'push-protection': true,
  structure: true
}
const KI_CONFIG = '.ki-config.toml'
const KI_SECTION = 'ki-repo'
const KI_REPO_DEFAULT = `[${KI_SECTION}]
visibility = "private"   # "public" | "private" — must match the repo's actual GitHub visibility
license = "MIT"          # SPDX id the LICENSE, package.json, and GitHub must match; default MIT. Use "UNLICENSED" for proprietary. Pick one at https://choosealicense.com/

# Per-repo check overrides — true = enforce, false = don't. Omit any check to take
# the org default; a repo that fully conforms needs nothing here.
# [${KI_SECTION}.checks]
# branch-protection = true   # default off — protect \`main\` on this repo
# wiki = false               # default on  — allow this repo's Wiki
`
const KI_AUTHORING_DEFAULT = `# The authoring standard (Markdown/TOML house style) is baseline — every KI repo is
# governed by it. Declared explicitly, not assumed; its presence is the compliance marker.
[ki-authoring]
`
const KI_DEFAULT = `${KI_REPO_DEFAULT}\n${KI_AUTHORING_DEFAULT}`
const GITIGNORE_DEFAULT = 'node_modules/\n.DS_Store\n.ki-meta/audits/\n.ki-meta/conform/\n'

type Identity = { dev: number; ino: number }
type LeafSnapshot = { kind: 'absent' } | { kind: 'file'; identity: Identity; mode: number; bytes: Buffer }
type JournalEntry = { identity: Identity; mode: number; bytes?: Buffer }
type Transaction = { path: string; identity: Identity; target: string; targetIdentity: Identity; journal: Map<string, JournalEntry> }

function identityOf(stat: { dev: number; ino: number }): Identity {
  return { dev: stat.dev, ino: stat.ino }
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function bindPhysicalTarget(input: string): { path: string; identity: Identity } {
  const path = realpathSync(resolve(input))
  const stat = lstatSync(path)
  if (!stat.isDirectory() || realpathSync(path) !== path) throw new Error(`target is not a stable physical directory: ${input}`)
  return { path, identity: identityOf(stat) }
}

function targetIsStable(path: string, identity: Identity): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isDirectory() && sameIdentity(identityOf(stat), identity) && realpathSync(path) === path
  } catch {
    return false
  }
}

function snapshotLeaf(path: string): LeafSnapshot {
  let leaf: Stats
  try {
    leaf = lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }
    throw error
  }
  if (!leaf.isFile()) throw new Error(`refusing non-regular generated-file leaf: ${path}`)

  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || !sameIdentity(identityOf(before), identityOf(leaf))) {
      throw new Error(`generated-file leaf changed while opening: ${path}`)
    }
    const bytes = readFileSync(fd)
    const after = fstatSync(fd)
    if (
      !sameIdentity(identityOf(before), identityOf(after)) ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      after.size !== bytes.length
    ) {
      throw new Error(`generated-file leaf changed while reading: ${path}`)
    }
    return { kind: 'file', identity: identityOf(before), mode: before.mode & 0o7777, bytes }
  } finally {
    closeSync(fd)
  }
}

function snapshotMatches(path: string, expected: LeafSnapshot): boolean {
  try {
    const current = snapshotLeaf(path)
    if (expected.kind === 'absent') return current.kind === 'absent'
    return (
      current.kind === 'file' &&
      sameIdentity(current.identity, expected.identity) &&
      current.mode === expected.mode &&
      current.bytes.equals(expected.bytes)
    )
  } catch {
    return false
  }
}

function transactionIsStable(transaction: Transaction): boolean {
  if (!targetIsStable(transaction.target, transaction.targetIdentity)) return false
  try {
    const stat = lstatSync(transaction.path)
    return (
      stat.isDirectory() &&
      sameIdentity(identityOf(stat), transaction.identity) &&
      (stat.mode & 0o7777) === 0o700 &&
      realpathSync(transaction.path) === transaction.path
    )
  } catch {
    return false
  }
}

function createTransaction(target: string, targetIdentity: Identity): Transaction {
  if (!targetIsStable(target, targetIdentity)) throw new Error('physical target changed before transaction creation')
  for (let attempt = 0; attempt < 8; attempt++) {
    const path = join(target, `.ki-repo-transaction-${process.pid}-${randomBytes(16).toString('hex')}`)
    const priorUmask = process.umask(0)
    try {
      try {
        mkdirSync(path, { mode: 0o700 })
      } finally {
        process.umask(priorUmask)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
    let fd: number | undefined
    let createdIdentity: Identity | undefined
    try {
      // Bind the exclusively created directory through a no-follow descriptor
      // immediately. This is the directory equivalent of the file journal: even
      // if a later path validation throws, cleanup still knows exactly which
      // inode this process created.
      fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      const created = fstatSync(fd)
      if (!created.isDirectory()) throw new Error(`transaction path is not a directory: ${path}`)
      createdIdentity = identityOf(created)
      fchmodSync(fd, 0o700)
      if (process.env.NODE_ENV === 'test' && process.env.KI_REPO_TEST_FAIL_TRANSACTION_VALIDATION) {
        throw new Error('injected transaction-directory validation failure')
      }
      const stat = lstatSync(path)
      const transaction = { path, identity: createdIdentity, target, targetIdentity, journal: new Map<string, JournalEntry>() }
      if (!stat.isDirectory() || !sameIdentity(identityOf(stat), createdIdentity) || (stat.mode & 0o7777) !== 0o700) {
        throw new Error(`transaction directory failed identity validation: ${path}`)
      }
      if (!transactionIsStable(transaction)) throw new Error(`transaction directory failed identity validation: ${path}`)
      return transaction
    } catch (error) {
      if (createdIdentity) {
        try {
          const current = lstatSync(path)
          if (current.isDirectory() && sameIdentity(identityOf(current), createdIdentity) && readdirSync(path).length === 0) {
            rmdirSync(path)
          }
        } catch {
          // The original validation error remains primary. An unrecognisable
          // path is never removed merely because it reused our random name.
        }
      }
      throw error
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }
  throw new Error('could not allocate an exclusive repository transaction directory')
}

function createOwnedFile(transaction: Transaction, stem: string, bytes: Buffer, mode: number): { path: string; expected: JournalEntry } {
  if (!transactionIsStable(transaction)) throw new Error('transaction directory changed before file creation')
  for (let attempt = 0; attempt < 8; attempt++) {
    const path = join(transaction.path, `${stem}-${randomBytes(12).toString('hex')}`)
    let fd: number
    try {
      fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
    try {
      const created = fstatSync(fd)
      if (!created.isFile()) throw new Error(`transaction file is not regular: ${path}`)
      const expected: JournalEntry = { identity: identityOf(created), mode: created.mode & 0o7777 }
      // Journal immediately after the exclusive create, before any later write,
      // chmod, fsync, or validation can throw.
      transaction.journal.set(path, expected)
      if (process.env.NODE_ENV === 'test' && process.env.KI_REPO_TEST_FAIL_MATERIALISE_STEM === stem) {
        throw new Error(`injected materialisation failure for ${stem}`)
      }
      writeFileSync(fd, bytes)
      fchmodSync(fd, mode)
      // fchmod mutates mode but not inode identity. Refresh the journal at the
      // first instruction after the successful mutation so any later failure is
      // still exactly cleanable under a restrictive creation umask.
      expected.mode = mode
      transaction.journal.set(path, expected)
      if (process.env.NODE_ENV === 'test' && process.env.KI_REPO_TEST_FAIL_AFTER_FCHMOD_STEM === stem) {
        throw new Error(`injected post-fchmod failure for ${stem}`)
      }
      fsyncSync(fd)
      const stat = fstatSync(fd)
      if (!stat.isFile() || !sameIdentity(identityOf(stat), expected.identity) || (stat.mode & 0o7777) !== mode) {
        throw new Error(`transaction file changed while being materialised: ${path}`)
      }
    } finally {
      closeSync(fd)
    }
    const snapshot = snapshotLeaf(path)
    if (snapshot.kind !== 'file' || snapshot.mode !== mode || !snapshot.bytes.equals(bytes)) {
      throw new Error(`transaction file changed after creation: ${path}`)
    }
    const expected = { identity: snapshot.identity, mode: snapshot.mode, bytes: snapshot.bytes }
    transaction.journal.set(path, expected)
    return { path, expected }
  }
  throw new Error(`could not allocate an exclusive transaction file for ${stem}`)
}

function journalMatches(path: string, expected: JournalEntry): boolean {
  try {
    const snapshot = snapshotLeaf(path)
    return (
      snapshot.kind === 'file' &&
      sameIdentity(snapshot.identity, expected.identity) &&
      snapshot.mode === expected.mode &&
      (expected.bytes === undefined || snapshot.bytes.equals(expected.bytes))
    )
  } catch {
    return false
  }
}

function cleanupJournaled(transaction: Transaction, path: string): void {
  const expected = transaction.journal.get(path)
  if (!expected || !transactionIsStable(transaction) || !path.startsWith(`${transaction.path}/`) || !journalMatches(path, expected)) {
    throw new Error(`transaction-owned file changed before cleanup: ${path}`)
  }
  unlinkSync(path)
  transaction.journal.delete(path)
}

function cleanupTransaction(transaction: Transaction, preserve: Set<string> = new Set()): void {
  for (const path of [...transaction.journal.keys()]) {
    if (!preserve.has(path)) cleanupJournaled(transaction, path)
  }
  if (transaction.journal.size !== 0) return
  if (!transactionIsStable(transaction)) throw new Error(`transaction directory changed before cleanup: ${transaction.path}`)
  rmdirSync(transaction.path)
}

function maybeInjectRootSwap(root: string, leaf: string): void {
  if (process.env.NODE_ENV !== 'test' || process.env.KI_REPO_TEST_TARGET_LEAF !== basename(leaf)) return
  const replacement = process.env.KI_REPO_TEST_SWAP_ROOT_BEFORE_PUBLISH
  if (!replacement) return
  renameSync(root, replacement)
  mkdirSync(root)
}

function maybeInjectLeafRace(leaf: string, original: LeafSnapshot): void {
  if (process.env.NODE_ENV !== 'test' || process.env.KI_REPO_TEST_TARGET_LEAF !== basename(leaf)) return
  if (process.env.KI_REPO_TEST_CREATE_BEFORE_PUBLISH && original.kind === 'absent') {
    writeFileSync(leaf, process.env.KI_REPO_TEST_CREATE_BEFORE_PUBLISH, { flag: 'wx' })
  }
  if (process.env.KI_REPO_TEST_MUTATE_BEFORE_PUBLISH && original.kind === 'file') {
    writeFileSync(leaf, process.env.KI_REPO_TEST_MUTATE_BEFORE_PUBLISH)
  }
  if (process.env.KI_REPO_TEST_REPLACE_SAME_BYTES_BEFORE_PUBLISH && original.kind === 'file') {
    renameSync(leaf, `${leaf}.ki-test-original`)
    writeFileSync(leaf, original.bytes, { mode: original.mode })
  }
}

function maybeInjectAfterValidation(leaf: string, original: LeafSnapshot): void {
  if (
    process.env.NODE_ENV !== 'test' ||
    process.env.KI_REPO_TEST_TARGET_LEAF !== basename(leaf) ||
    !process.env.KI_REPO_TEST_REPLACE_AFTER_VALIDATION ||
    original.kind !== 'file'
  ) {
    return
  }
  renameSync(leaf, `${leaf}.ki-test-original-after-validation`)
  writeFileSync(leaf, process.env.KI_REPO_TEST_REPLACE_AFTER_VALIDATION, { mode: original.mode })
}

function maybeInjectPostPublication(leaf: string, bytes: Buffer, mode: number): void {
  if (process.env.NODE_ENV !== 'test' || process.env.KI_REPO_TEST_TARGET_LEAF !== basename(leaf)) return
  if (process.env.KI_REPO_TEST_MUTATE_AFTER_PUBLISH) writeFileSync(leaf, process.env.KI_REPO_TEST_MUTATE_AFTER_PUBLISH)
  if (process.env.KI_REPO_TEST_REPLACE_SAME_BYTES_AFTER_PUBLISH) {
    renameSync(leaf, `${leaf}.ki-test-published-after-publication`)
    writeFileSync(leaf, bytes, { flag: 'wx', mode })
  }
  if (process.env.KI_REPO_TEST_FAIL_AFTER_PUBLISH) throw new Error(`injected post-publication failure for ${basename(leaf)}`)
}

function maybeInjectAfterQuarantine(leaf: string): void {
  if (process.env.NODE_ENV !== 'test' || process.env.KI_REPO_TEST_TARGET_LEAF !== basename(leaf)) return
  if (process.env.KI_REPO_TEST_RECREATE_AFTER_QUARANTINE) {
    writeFileSync(leaf, process.env.KI_REPO_TEST_RECREATE_AFTER_QUARANTINE, { flag: 'wx' })
  }
  const alias = process.env.KI_REPO_TEST_MUTATE_ALIAS_AFTER_QUARANTINE
  if (alias) writeFileSync(alias, 'external hard-link mutation\n')
}

function maybeInjectBeforeRollbackPublication(leaf: string): void {
  if (process.env.NODE_ENV !== 'test' || process.env.KI_REPO_TEST_TARGET_LEAF !== basename(leaf)) return
  const replacement = process.env.KI_REPO_TEST_RECREATE_BEFORE_ROLLBACK
  if (replacement) writeFileSync(leaf, replacement, { flag: 'wx' })
}

type LeafPlan = { name: string; original: LeafSnapshot; next: Buffer }
type PublicationState = LeafPlan & {
  leaf: string
  candidate: ReturnType<typeof createOwnedFile>
  rollbackCopy: ReturnType<typeof createOwnedFile> | null
  quarantine: string | null
  published: boolean
}

function publishPreparedLeaves(root: string, rootIdentity: Identity, plans: LeafPlan[], dryRun: boolean): void {
  const changes = plans.filter((plan) => plan.original.kind === 'absent' || !plan.original.bytes.equals(plan.next))
  if (changes.length === 0) return
  if (dryRun) return

  for (const plan of changes) maybeInjectRootSwap(root, join(root, plan.name))
  if (!targetIsStable(root, rootIdentity)) throw new Error('physical target changed before generated-file publication')

  const transaction = createTransaction(root, rootIdentity)
  const states: PublicationState[] = []
  try {
    for (const plan of changes) {
      states.push({
        ...plan,
        leaf: join(root, plan.name),
        candidate: createOwnedFile(
          transaction,
          `${plan.name}.candidate`,
          plan.next,
          plan.original.kind === 'file' ? plan.original.mode : 0o644
        ),
        rollbackCopy:
          plan.original.kind === 'file'
            ? createOwnedFile(transaction, `${plan.name}.rollback`, plan.original.bytes, plan.original.mode)
            : null,
        quarantine: null,
        published: false
      })
    }
  } catch (error) {
    cleanupTransaction(transaction)
    throw error
  }

  try {
    for (const state of states) maybeInjectLeafRace(state.leaf, state.original)
    if (!transactionIsStable(transaction)) throw new Error('physical target changed before generated-file publication')
    for (const state of states) {
      if (!snapshotMatches(state.leaf, state.original) || !journalMatches(state.candidate.path, state.candidate.expected)) {
        throw new Error(`${state.name} changed before publication`)
      }
      if (state.rollbackCopy && !journalMatches(state.rollbackCopy.path, state.rollbackCopy.expected)) {
        throw new Error(`${state.name} rollback copy changed before publication`)
      }
    }

    for (const state of states) {
      if (state.original.kind === 'file') {
        if (!snapshotMatches(state.leaf, state.original)) throw new Error(`${state.name} changed before quarantine`)
        maybeInjectAfterValidation(state.leaf, state.original)
        const quarantinePath = join(transaction.path, `${state.name}.original`)
        renameSync(state.leaf, quarantinePath)
        transaction.journal.set(quarantinePath, {
          identity: state.original.identity,
          mode: state.original.mode,
          bytes: state.original.bytes
        })
        state.quarantine = quarantinePath
        if (
          !transactionIsStable(transaction) ||
          !snapshotMatches(state.leaf, { kind: 'absent' }) ||
          !journalMatches(quarantinePath, transaction.journal.get(quarantinePath) as JournalEntry)
        ) {
          throw new Error(`${state.name} changed while entering quarantine`)
        }
        maybeInjectAfterQuarantine(state.leaf)
        if (!journalMatches(quarantinePath, transaction.journal.get(quarantinePath) as JournalEntry)) {
          throw new Error(`${state.name} quarantine changed before publication`)
        }
      }

      // Publication is an exclusive no-clobber hard link from the trusted private
      // candidate. Any concurrently recreated leaf makes it fail.
      linkSync(state.candidate.path, state.leaf)
      state.published = true
      maybeInjectPostPublication(state.leaf, state.next, state.candidate.expected.mode)
      const publishedSnapshot: LeafSnapshot = {
        kind: 'file',
        identity: state.candidate.expected.identity,
        mode: state.candidate.expected.mode,
        bytes: state.next
      }
      if (!transactionIsStable(transaction) || !snapshotMatches(state.leaf, publishedSnapshot)) {
        throw new Error(`${state.name} changed during publication`)
      }
    }

    for (const state of states) {
      const publishedSnapshot: LeafSnapshot = {
        kind: 'file',
        identity: state.candidate.expected.identity,
        mode: state.candidate.expected.mode,
        bytes: state.next
      }
      if (!snapshotMatches(state.leaf, publishedSnapshot)) throw new Error(`${state.name} generation changed before commit`)
      if (state.quarantine && !journalMatches(state.quarantine, transaction.journal.get(state.quarantine) as JournalEntry)) {
        throw new Error(`${state.name} quarantine changed before commit`)
      }
    }
    if (!transactionIsStable(transaction)) throw new Error('physical target changed before generated-file commit')
  } catch (error) {
    const conflicts: string[] = []
    const preserve = new Set<string>()
    for (const state of [...states].reverse()) {
      if (state.published) {
        const publishedSnapshot: LeafSnapshot = {
          kind: 'file',
          identity: state.candidate.expected.identity,
          mode: state.candidate.expected.mode,
          bytes: state.next
        }
        if (!transactionIsStable(transaction)) {
          conflicts.push(`physical target changed; ${state.name} cannot be rolled back safely`)
        } else if (!snapshotMatches(state.leaf, publishedSnapshot)) {
          conflicts.push(`${state.name} was changed by another writer; preserving it and its quarantine`)
          if (state.quarantine) preserve.add(state.quarantine)
        } else {
          const publishedPath = join(transaction.path, `${state.name}.published`)
          renameSync(state.leaf, publishedPath)
          transaction.journal.set(publishedPath, {
            identity: publishedSnapshot.identity,
            mode: publishedSnapshot.mode,
            bytes: publishedSnapshot.bytes
          })
          if (!journalMatches(publishedPath, transaction.journal.get(publishedPath) as JournalEntry)) {
            conflicts.push(`${state.name} changed while quarantining the published leaf`)
            preserve.add(publishedPath)
          }
          state.published = false
        }
      }

      if (!state.published && state.original.kind === 'file' && state.quarantine) {
        const quarantineExpected = transaction.journal.get(state.quarantine)
        if (!transactionIsStable(transaction)) {
          conflicts.push(`physical target changed; ${state.name} quarantine cannot be restored safely`)
        } else if (!snapshotMatches(state.leaf, { kind: 'absent' })) {
          conflicts.push(`${state.name} was recreated after quarantine; preserving both paths`)
          preserve.add(state.quarantine)
        } else if (quarantineExpected && journalMatches(state.quarantine, quarantineExpected)) {
          const quarantinePath = state.quarantine
          maybeInjectBeforeRollbackPublication(state.leaf)
          try {
            // Restoration is an exclusive publication from private quarantine.
            // Never rename over a path that may have appeared after the absence
            // check: link(2) fails with EEXIST and preserves both writers.
            linkSync(quarantinePath, state.leaf)
            if (!snapshotMatches(state.leaf, state.original)) {
              conflicts.push(`${state.name} did not match its exact snapshot after rollback`)
              preserve.add(quarantinePath)
            } else {
              cleanupJournaled(transaction, quarantinePath)
              state.quarantine = null
            }
          } catch {
            conflicts.push(`${state.name} appeared before rollback publication; preserving it and its exact quarantine`)
            preserve.add(quarantinePath)
          }
        } else if (state.rollbackCopy && journalMatches(state.rollbackCopy.path, state.rollbackCopy.expected)) {
          maybeInjectBeforeRollbackPublication(state.leaf)
          try {
            linkSync(state.rollbackCopy.path, state.leaf)
            const restored: LeafSnapshot = {
              kind: 'file',
              identity: state.rollbackCopy.expected.identity,
              mode: state.rollbackCopy.expected.mode,
              bytes: state.original.bytes
            }
            if (!snapshotMatches(state.leaf, restored)) conflicts.push(`${state.name} rollback copy changed during restoration`)
            conflicts.push(`${state.name} quarantine changed through an external alias; restored snapshot bytes and preserved the mutation`)
            preserve.add(state.quarantine)
          } catch {
            conflicts.push(`${state.name} appeared before snapshot rollback publication; preserving it and the changed quarantine`)
            preserve.add(state.quarantine)
          }
        } else {
          conflicts.push(`${state.name} quarantine and rollback copy changed; preserving transaction state`)
          preserve.add(state.quarantine)
        }
      }
    }
    try {
      cleanupTransaction(transaction, preserve)
    } catch (cleanupError) {
      conflicts.push((cleanupError as Error).message)
    }
    const detail = conflicts.length ? `; rollback conflict: ${conflicts.join('; ')}` : ''
    throw new Error(`${(error as Error).message}${detail}`)
  }

  // The generation is committed once every destination and the bound root have
  // passed final validation. Cleanup failure after this point must not roll back
  // a partially cleaned transaction whose earlier quarantine is already gone.
  cleanupTransaction(transaction)
}

const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m' }
const paint = (c: string, s: string): string => `${c}${s}${C.reset}`

const argv = process.argv.slice(2)
if (process.env.NODE_ENV === 'test' && process.env.KI_REPO_TEST_UMASK) {
  process.umask(Number.parseInt(process.env.KI_REPO_TEST_UMASK, 8))
}
const dryRun = argv.includes('--dry-run')
const json = argv.includes('--json')
const scaffoldConfigOnly = argv.includes('--scaffold-config-only')
const say = (line: string): void => {
  if (!json) console.log(line)
}

// Collect-then-emit harness (mirrors audit.ts / ki-authoring conform). Each action records
// a cited finding; `say` prints the human line only when not in --json mode, so a direct run
// streams prose while the aggregate consumes the JSON wrapper. `--json` governs *reporting*;
// `--dry-run` governs *writing* — the two compose. Level ladder: written/enabled/set → POLISH,
// already-conformant → PASS, action failed → FAIL, judgment/manual-TODO → ADVISORY.
type Level = 'FAIL' | 'WARN' | 'POLISH' | 'ADVISORY' | 'INFO' | 'NA' | 'PASS'
type Finding = { level: Level; area: string; msg: string; ref?: string; file?: string }
const findings: Finding[] = []
const rec = (level: Level, area: string, msg: string, ref?: string, file?: string): void =>
  void findings.push({ level, area, msg, ref, file })

// `gh()` applies one GitHub setting. `area` is the rubric code it satisfies; when a single
// atomic `gh` call covers several fine audit checks (e.g. merge + delete-branch), `covers`
// enumerates them in the msg while `area` stays the bundle's parent code — audit still emits
// each fine check with its own code. dry-run records the planned action as POLISH.
const gh = (args: string[], area: string, label: string, covers?: string): void => {
  const detail = covers ? `${label} (covers: ${covers})` : label
  if (dryRun) {
    say(`  ${paint(C.dim, '$')} gh ${args.join(' ')}`)
    rec('POLISH', area, `would ${detail}`, STD)
    return
  }
  try {
    execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    say(`  ${paint(C.green, 'ok')}    ${label}`)
    rec('POLISH', area, detail, STD)
  } catch (e) {
    const m = String((e as Error).message ?? e).split('\n')[0]
    say(`  ${paint(C.red, 'fail')}  ${label} — ${m}`)
    rec('FAIL', area, `${detail} — ${m}`, STD)
  }
}
const ghJSON = (apiPath: string): unknown => JSON.parse(execFileSync('gh', ['api', apiPath], { encoding: 'utf8' }))
const ghOk = (apiPath: string): boolean => {
  try {
    execFileSync('gh', ['api', apiPath], { encoding: 'utf8' })
    return true
  } catch {
    return false
  }
}

// `ghIfNeeded` is `gh()`'s conformance-checked twin: when `already` is true the setting is
// left untouched and recorded PASS; otherwise it delegates to `gh()` as before (which itself
// still records POLISH on write / FAIL on error, dry-run included).
const ghIfNeeded = (already: boolean, args: string[], area: string, label: string, covers?: string): void => {
  if (already) {
    const detail = covers ? `${label} (covers: ${covers})` : label
    say(`  ${paint(C.dim, 'ok')}    ${detail} — already conformant`)
    rec('PASS', area, `${detail} already conformant`, STD)
    return
  }
  gh(args, area, label, covers)
}

// Same TOML-aware owned-table parser as audit.ts.
type KiConfig = { visibility?: string; checks: Record<string, boolean> }
const CHECKS_SECTION = `${KI_SECTION}.checks`
const TOML = (globalThis as unknown as { Bun: { TOML: { parse(text: string): unknown } } }).Bun.TOML
function parseKiConfig(text: string): KiConfig | null {
  let document: Record<string, unknown>
  try {
    document = TOML.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
  const value = document[KI_SECTION]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const table = value as Record<string, unknown>
  const out: KiConfig = { checks: {} }
  if (typeof table.visibility === 'string') out.visibility = table.visibility
  if (table.checks && typeof table.checks === 'object' && !Array.isArray(table.checks)) {
    for (const [key, check] of Object.entries(table.checks as Record<string, unknown>)) {
      if (typeof check === 'boolean') out.checks[key] = check
    }
  }
  return out
}

type MultilineDelimiter = '"""' | "'''"
function tripleClose(line: string, delimiter: MultilineDelimiter, from: number): number {
  let at = line.indexOf(delimiter, from)
  while (at !== -1) {
    const backslashes = line.slice(0, at).match(/\\+$/)?.[0].length ?? 0
    if (delimiter === "'''" || backslashes % 2 === 0) return at
    at = line.indexOf(delimiter, at + delimiter.length)
  }
  return -1
}

function declaresRootTable(text: string, table: string): boolean {
  let multiline: MultilineDelimiter | null = null
  for (const raw of text.split(/\r?\n/)) {
    if (multiline) {
      if (tripleClose(raw, multiline, 0) !== -1) multiline = null
      continue
    }
    let code = ''
    let quote: '"' | "'" | null = null
    let escaped = false
    for (let i = 0; i < raw.length; i++) {
      const delimiter = raw.startsWith('"""', i) ? '"""' : raw.startsWith("'''", i) ? "'''" : null
      if (!quote && delimiter) {
        if (tripleClose(raw, delimiter, i + delimiter.length) === -1) multiline = delimiter
        break
      }
      const char = raw[i] as string
      if (!quote && char === '#') break
      code += char
      if (quote === '"') {
        if (!escaped && char === '"') quote = null
        escaped = !escaped && char === '\\'
      } else if (quote === "'") {
        if (char === "'") quote = null
      } else if (char === '"' || char === "'") {
        quote = char
        escaped = false
      }
    }
    const match = code.trim().match(/^\[\s*(?:"([^"\\]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*(\.|\])/)
    const root = match?.[1] ?? match?.[2] ?? match?.[3]
    if (root === table && match?.[4] === ']') return true
  }
  return false
}

type ConfigPlan = { text: string; addRepo: boolean; addAuthoring: boolean }
function configPlan(existing: string): ConfigPlan {
  const addRepo = !declaresRootTable(existing, KI_SECTION)
  const addAuthoring = !declaresRootTable(existing, 'ki-authoring')
  if (existing.length === 0 && addRepo && addAuthoring) return { text: KI_DEFAULT, addRepo, addAuthoring }
  const blocks = [addRepo ? KI_REPO_DEFAULT : '', addAuthoring ? KI_AUTHORING_DEFAULT : ''].filter(Boolean)
  if (blocks.length === 0) return { text: existing, addRepo, addAuthoring }
  const separator = existing.length === 0 ? '' : existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n'
  return { text: `${existing}${separator}${blocks.join('\n')}`, addRepo, addAuthoring }
}

// ── local file scaffolding (only when absent; never overwrite) ──
// A scaffold line cites the presence-check code (audit's `gitignore` / `ki-config`) with
// file = the scaffolded path: written → POLISH, already present → PASS (never overwritten).
// The scaffolded filename is the FIRST argument by contract — ki-skills SHAPE-16 reads
// the leading string literal of each scaffold/syncOwned call cross-skill to check the
// file is declared under `owns:`, so the real path (not the area code) must lead.
function scaffold(name: string, area: string, snapshot: LeafSnapshot): void {
  if (snapshot.kind === 'file') {
    rec('PASS', area, `${name} already present`, STD, name)
    return
  }
  rec('POLISH', area, `${name} scaffolded (was missing)`, STD, name)
  say(`  ${paint(C.green, 'write')} ${name}`)
}

function gitOrigin(dir: string): string | null {
  try {
    return execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}
const GH_REMOTE = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/

// ── entry ──
const boundTarget = bindPhysicalTarget(argv.find((a) => !a.startsWith('-')) ?? '.')
const target = boundTarget.path
const kiPath = join(target, KI_CONFIG)
const kiSnapshot = snapshotLeaf(kiPath)
const kiText = kiSnapshot.kind === 'file' ? kiSnapshot.bytes.toString('utf8') : ''
const plannedConfig = configPlan(kiText)
const gitignoreSnapshot = scaffoldConfigOnly ? null : snapshotLeaf(join(target, '.gitignore'))

// Layer 1 is local and must converge even when the target has no GitHub remote or
// `gh` is unauthenticated. Live-state checks begin only after these writes finish.
if (gitignoreSnapshot) scaffold('.gitignore', 'FILES-1', gitignoreSnapshot)
if (plannedConfig.addRepo) {
  rec(
    'POLISH',
    'FILES-1',
    `${KI_CONFIG} [${KI_SECTION}] block appended (edit \`visibility\` to match — templated "private")`,
    STD,
    KI_CONFIG
  )
  say(`  ${paint(C.green, 'append')} ${KI_CONFIG} [${KI_SECTION}] block (edit \`visibility\` to match — currently templated "private")`)
} else {
  rec('PASS', 'FILES-1', `${KI_CONFIG} [${KI_SECTION}] block already present`, STD, KI_CONFIG)
}
if (plannedConfig.addAuthoring) {
  rec('POLISH', 'FILES-3', `${KI_CONFIG} [ki-authoring] marker appended`, STD, KI_CONFIG)
  say(`  ${paint(C.green, 'append')} ${KI_CONFIG} [ki-authoring] marker`)
} else {
  rec('PASS', 'FILES-3', `${KI_CONFIG} [ki-authoring] marker already present`, STD, KI_CONFIG)
}
publishPreparedLeaves(
  target,
  boundTarget.identity,
  [
    ...(gitignoreSnapshot
      ? [
          {
            name: '.gitignore',
            original: gitignoreSnapshot,
            next: gitignoreSnapshot.kind === 'file' ? gitignoreSnapshot.bytes : Buffer.from(GITIGNORE_DEFAULT)
          }
        ]
      : []),
    { name: KI_CONFIG, original: kiSnapshot, next: Buffer.from(plannedConfig.text) }
  ],
  dryRun
)

if (scaffoldConfigOnly) process.exit(0)

const origin = gitOrigin(target)
const m = origin?.match(GH_REMOTE)
if (!m) {
  console.error(paint(C.red, `${target}: origin is not on github.com (${origin ?? 'no origin'}) — nothing to conform`))
  process.exit(1)
}
const nwo = `${m[1]}/${m[2]}`

const ki = parseKiConfig(plannedConfig.text)
const enforced = (id: string): boolean => ki?.checks[id] ?? CHECK_DEFAULTS[id] ?? true

type RepoInfo = {
  private?: boolean
  has_wiki?: boolean
  has_projects?: boolean
  has_issues?: boolean
  allow_merge_commit?: boolean
  allow_rebase_merge?: boolean
  allow_squash_merge?: boolean
  delete_branch_on_merge?: boolean
  allow_update_branch?: boolean
  security_and_analysis?: {
    secret_scanning?: { status?: string }
    secret_scanning_push_protection?: { status?: string }
  }
}
let repoInfo: RepoInfo
try {
  repoInfo = ghJSON(`repos/${nwo}`) as RepoInfo
} catch {
  console.error(paint(C.red, `could not read repos/${nwo} via gh — is gh authenticated? (gh auth status)`))
  process.exit(1)
}
const isPublic = !repoInfo.private

say(paint(C.dim, `target: ${nwo}   ${isPublic ? 'public' : 'private'}${dryRun ? '   (dry run)' : ''}\n`))

// ── Layer 2: core GitHub settings ──
say(`\n${paint(C.cyan, 'layer 2 — core GitHub')}`)
const mergeConformant =
  repoInfo.allow_merge_commit === false &&
  repoInfo.allow_rebase_merge === false &&
  repoInfo.allow_squash_merge === true &&
  repoInfo.delete_branch_on_merge === true
ghIfNeeded(
  mergeConformant,
  [
    'repo',
    'edit',
    nwo,
    '--enable-merge-commit=false',
    '--enable-rebase-merge=false',
    '--enable-squash-merge=true',
    '--delete-branch-on-merge=true'
  ],
  'MERGE-1',
  'squash-only + auto-delete-branch',
  'merge, delete-branch'
)
if (enforced('wiki')) ghIfNeeded(repoInfo.has_wiki === false, ['repo', 'edit', nwo, '--enable-wiki=false'], 'TOGGLE-1', 'Wiki off')
if (enforced('projects'))
  ghIfNeeded(repoInfo.has_projects === false, ['repo', 'edit', nwo, '--enable-projects=false'], 'TOGGLE-1', 'Projects off')
if (enforced('issues')) ghIfNeeded(repoInfo.has_issues === true, ['repo', 'edit', nwo, '--enable-issues=true'], 'TOGGLE-1', 'Issues on')

if (isPublic && enforced('topics')) {
  let currentTopics: string[] = []
  try {
    currentTopics = (ghJSON(`repos/${nwo}/topics`) as { names?: string[] }).names ?? []
  } catch {
    currentTopics = []
  }
  const topicsConformant = TOPICS.every((t) => currentTopics.includes(t))
  const args = ['repo', 'edit', nwo]
  for (const t of TOPICS) args.push('--add-topic', t)
  ghIfNeeded(topicsConformant, args, 'TOPICS-1', `topics: ${TOPICS.join(', ')}`)
}

const branchProtectionOn = ghOk(`repos/${nwo}/branches/main/protection`)
if (enforced('branch-protection') && branchProtectionOn) {
  say(`  ${paint(C.dim, 'ok')}    branch protection on main — already conformant`)
  rec('PASS', 'BP-1', `branch protection on main (opted in via [${CHECKS_SECTION}]) already conformant`, STD)
} else if (!enforced('branch-protection') && !branchProtectionOn) {
  say(`  ${paint(C.dim, 'ok')}    no branch protection on main — already conformant (default: off)`)
  rec('PASS', 'BP-1', 'no branch protection on main already conformant (default: off)', STD)
} else if (enforced('branch-protection')) {
  const body = JSON.stringify({
    required_status_checks: { strict: true, checks: [{ context: REQUIRED_CHECK }] },
    enforce_admins: false,
    required_pull_request_reviews: { required_approving_review_count: 0 },
    restrictions: null,
    required_linear_history: true,
    allow_force_pushes: false,
    allow_deletions: false
  })
  if (dryRun) {
    say(`  ${paint(C.dim, '$')} gh api -X PUT repos/${nwo}/branches/main/protection --input - <<< ${body}`)
    rec('POLISH', 'BP-1', `would set branch protection on main (opted in via [${CHECKS_SECTION}])`, STD)
  } else {
    try {
      execFileSync('gh', ['api', '-X', 'PUT', `repos/${nwo}/branches/main/protection`, '--input', '-'], { input: body, encoding: 'utf8' })
      say(`  ${paint(C.green, 'ok')}    branch protection on main (opted in via [${CHECKS_SECTION}])`)
      rec('POLISH', 'BP-1', `branch protection on main (opted in via [${CHECKS_SECTION}])`, STD)
    } catch (e) {
      const m = String((e as Error).message ?? e).split('\n')[0]
      say(`  ${paint(C.red, 'fail')}  branch protection — ${m}`)
      rec('FAIL', 'BP-1', `branch protection — ${m}`, STD)
    }
  }
} else if (dryRun) {
  say(`  ${paint(C.dim, '$')} gh api -X DELETE repos/${nwo}/branches/main/protection`)
  rec('POLISH', 'BP-1', 'would strip any leftover branch protection (default: off)', STD)
} else {
  try {
    execFileSync('gh', ['api', '-X', 'DELETE', `repos/${nwo}/branches/main/protection`], { encoding: 'utf8' })
    say(`  ${paint(C.green, 'ok')}    strip any leftover branch protection (default: off)`)
    rec('POLISH', 'BP-1', 'stripped leftover branch protection (default: off)', STD)
  } catch (e) {
    const msg = String((e as Error).message ?? e)
    if (!isPublic && /Upgrade to GitHub Pro/.test(msg)) {
      say(`  ${paint(C.dim, 'skip')}  branch protection unavailable on this plan for private repos — nothing to strip`)
      rec('PASS', 'BP-1', 'branch protection unavailable on this plan for private repos — nothing to strip', STD)
    } else {
      say(`  ${paint(C.red, 'fail')}  strip any leftover branch protection (default: off) — ${msg.split('\n')[0]}`)
      rec('FAIL', 'BP-1', `strip any leftover branch protection (default: off) — ${msg.split('\n')[0]}`, STD)
    }
  }
}

// ── Layer 3: deeper GitHub ──
say(`\n${paint(C.cyan, 'layer 3 — deeper GitHub')}`)
ghIfNeeded(
  ghOk(`repos/${nwo}/vulnerability-alerts`),
  ['api', '-X', 'PUT', `repos/${nwo}/vulnerability-alerts`],
  'DEP-1',
  'Dependabot alerts on'
)
let autoSecurityFixesOn = false
try {
  autoSecurityFixesOn = (ghJSON(`repos/${nwo}/automated-security-fixes`) as { enabled?: boolean }).enabled === true
} catch {
  autoSecurityFixesOn = false
}
ghIfNeeded(autoSecurityFixesOn, ['api', '-X', 'PUT', `repos/${nwo}/automated-security-fixes`], 'DEP-1', 'Dependabot security updates on')
ghIfNeeded(
  repoInfo.allow_update_branch === true,
  ['api', '-X', 'PATCH', `repos/${nwo}`, '-F', 'allow_update_branch=true'],
  'DEP-1',
  'always-suggest-updating-PR-branches on'
)
if (isPublic && (enforced('secret-scanning') || enforced('push-protection'))) {
  const sa: Record<string, unknown> = {}
  const covered: string[] = []
  let allConformant = true
  if (enforced('secret-scanning')) {
    sa.secret_scanning = { status: 'enabled' }
    covered.push('secret-scanning')
    if (repoInfo.security_and_analysis?.secret_scanning?.status !== 'enabled') allConformant = false
  }
  if (enforced('push-protection')) {
    sa.secret_scanning_push_protection = { status: 'enabled' }
    covered.push('push-protection')
    if (repoInfo.security_and_analysis?.secret_scanning_push_protection?.status !== 'enabled') allConformant = false
  }
  const body = JSON.stringify({ security_and_analysis: sa })
  // One atomic PATCH bundles both fine checks; cite the parent code, enumerate the covered set.
  const covers = covered.join(', ')
  if (allConformant) {
    say(`  ${paint(C.dim, 'ok')}    secret scanning / push protection (covers: ${covers}) — already conformant`)
    rec('PASS', 'SEC-1', `secret scanning / push protection (covers: ${covers}) already conformant`, STD)
  } else if (dryRun) {
    say(`  ${paint(C.dim, '$')} gh api -X PATCH repos/${nwo} --input - <<< ${body}`)
    rec('POLISH', 'SEC-1', `would set secret scanning / push protection (covers: ${covers})`, STD)
  } else {
    try {
      execFileSync('gh', ['api', '-X', 'PATCH', `repos/${nwo}`, '--input', '-'], { input: body, encoding: 'utf8' })
      say(`  ${paint(C.green, 'ok')}    secret scanning / push protection`)
      rec('POLISH', 'SEC-1', `secret scanning / push protection (covers: ${covers})`, STD)
    } catch (e) {
      const m = String((e as Error).message ?? e).split('\n')[0]
      say(`  ${paint(C.red, 'fail')}  secret scanning / push protection — ${m}`)
      rec('FAIL', 'SEC-1', `secret scanning / push protection (covers: ${covers}) — ${m}`, STD)
    }
  }
}
let actionsConformant = false
try {
  const perms = ghJSON(`repos/${nwo}/actions/permissions`) as { enabled?: boolean; allowed_actions?: string }
  actionsConformant = perms.enabled === true && perms.allowed_actions === ALLOWED_ACTIONS
} catch {
  actionsConformant = false
}
ghIfNeeded(
  actionsConformant,
  // `enabled` is required by the API (422 without it); `allowed_actions` is only honoured when enabled.
  ['api', '-X', 'PUT', `repos/${nwo}/actions/permissions`, '-F', 'enabled=true', '-f', `allowed_actions=${ALLOWED_ACTIONS}`],
  'ACT-1',
  `Actions allowed_actions=${ALLOWED_ACTIONS}`
)

// ── judgment items — never guessed, always surfaced as ADVISORY (the [J] criteria conform
// cannot mechanically settle, routed to a human/model reading). Cite the rubric's Judgment
// section (RUBRIC); audit emits none of these areas, so there is no cross-file conflict.
say(`\n${paint(C.cyan, 'manual TODOs (judgment — not scripted)')}`)
rec('ADVISORY', 'FILES-J1', `README.md / LICENSE content: accurate and current for ${nwo}?`, RUBRIC, 'README.md')
rec(
  'ADVISORY',
  'DESCFIT-1',
  `GitHub description: does it actually describe ${nwo}'s purpose? (sync with package.json "description")`,
  RUBRIC
)
rec(
  'ADVISORY',
  'OVR-J1',
  `[${CHECKS_SECTION}] overrides: genuinely warranted per-repo, not waving off real drift (e.g. branch-protection)?`,
  RUBRIC
)
say(`  - README.md content: is it accurate and current for ${nwo}?`)
say(`  - GitHub description text: does it actually describe the repo's purpose? (sync with package.json's "description" once set)`)
say(`  - [${CHECKS_SECTION}] overrides: does this repo genuinely need to diverge from an org default (e.g. branch-protection)?`)
say(`\n${paint(C.dim, 'mechanical layer applied — re-run `bun scripts/audit.ts .` (or `ki:repo:audit`) to confirm findings clear.')}`)

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
  process.stdout.write(JSON.stringify({ concern: 'repo', target, generatedAt: new Date().toISOString(), summary, findings }))
}
