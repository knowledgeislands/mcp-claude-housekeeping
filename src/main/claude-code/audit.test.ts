import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  decodeProjectDir,
  discoverProjects,
  encodeProjectPath,
  globalStatus,
  obsoleteSessions,
  projectsList,
  pruneOrphanProjects,
  relocateProject,
  sessionRead,
  sessionsPrune,
  storageSummary
} from './audit.js'

// Tests must NEVER touch the real ~/.claude/. Shadow the config import with a
// per-suite tmpdir; afterAll/beforeEach below will recursively rm this root.
const CLAUDE_CODE_ROOT_PATH = path.join(os.tmpdir(), 'mcp-housekeeping-claude-code-audit-tests')

const DAY_MS = 24 * 60 * 60 * 1000

const setMtime = async (p: string, when: Date) => {
  await fs.utimes(p, when, when)
}

const writeSession = async (project: string, uuid: string, mtime: Date, payload = '{"role":"user","content":"hi"}') => {
  const projectDir = path.join(CLAUDE_CODE_ROOT_PATH, 'projects', project)
  await fs.mkdir(projectDir, { recursive: true })
  const file = path.join(projectDir, `${uuid}.jsonl`)
  await fs.writeFile(file, `${payload}\n`)
  await setMtime(file, mtime)
  return file
}

beforeAll(async () => {
  await fs.mkdir(path.join(CLAUDE_CODE_ROOT_PATH, 'projects'), { recursive: true })
})

afterAll(async () => {
  await fs.rm(CLAUDE_CODE_ROOT_PATH, { recursive: true, force: true })
})

beforeEach(async () => {
  // Wipe just the projects/ subtree to keep each test isolated, but leave the
  // root in place so other test files / settings don't churn.
  await fs.rm(path.join(CLAUDE_CODE_ROOT_PATH, 'projects'), { recursive: true, force: true })
  await fs.mkdir(path.join(CLAUDE_CODE_ROOT_PATH, 'projects'), { recursive: true })
})

describe('decodeProjectDir', () => {
  it('decodes a slash-only encoded path back to a slash-separated path', async () => {
    // Best-effort: original hyphens in segment names are not recoverable, so
    // we only assert decoding works for paths that had no embedded hyphens.
    const r = await decodeProjectDir('-Users-krisbrown-kis-mcps-mcpkb')
    expect(r.decoded).toBe('/Users/krisbrown/kis/mcps/mcpkb')
  })

  it('decoded path loses original hyphens (documented lossy behaviour)', async () => {
    const r = await decodeProjectDir('-Users-krisbrown-kis-mcps-mcp-kb-fs')
    expect(r.decoded).toBe('/Users/krisbrown/kis/mcps/mcp/kb/fs')
  })

  it('reports source_exists=false when the decoded path is missing', async () => {
    const r = await decodeProjectDir('-this-path-is-definitely-not-real-1234567890')
    expect(r.exists).toBe(false)
  })
})

describe('discoverProjects error paths', () => {
  it('rethrows projects/ readdir errors other than ENOENT (EACCES via chmod 0)', async () => {
    const isolatedRoot = path.join(CLAUDE_CODE_ROOT_PATH, '__discover_blocked__')
    const projectsDir = path.join(isolatedRoot, 'projects')
    await fs.mkdir(projectsDir, { recursive: true })
    await fs.chmod(projectsDir, 0o000)
    try {
      const { discoverProjects } = await import('./audit.js')
      await expect(discoverProjects(isolatedRoot)).rejects.toThrow(/EACCES|permission/i)
    } finally {
      await fs.chmod(projectsDir, 0o755)
      await fs.rm(isolatedRoot, { recursive: true, force: true })
    }
  })
})

describe('discoverProjects (non-directory entries are skipped)', () => {
  it('skips non-directory entries in projects/', async () => {
    // Create a stray file inside projects/ — discoverProjects must skip it.
    await fs.mkdir(path.join(CLAUDE_CODE_ROOT_PATH, 'projects'), { recursive: true })
    await fs.writeFile(path.join(CLAUDE_CODE_ROOT_PATH, 'projects', 'README.txt'), 'not a project')
    await writeSession('-real', '11111111-1111-1111-1111-111111111111', new Date())
    const r = await projectsList(CLAUDE_CODE_ROOT_PATH)
    expect(r.projects.map((p) => p.id)).toEqual(['-real'])
  })
})

describe('discoverProjects', () => {
  it('returns empty when no projects exist', async () => {
    const r = await discoverProjects(CLAUDE_CODE_ROOT_PATH)
    expect(r).toEqual([])
  })

  it('returns empty when projects/ does not exist', async () => {
    await fs.rm(path.join(CLAUDE_CODE_ROOT_PATH, 'projects'), { recursive: true, force: true })
    const r = await discoverProjects(CLAUDE_CODE_ROOT_PATH)
    expect(r).toEqual([])
  })

  it('lists projects with session files + memory presence', async () => {
    await writeSession('-Users-foo-a', '11111111-1111-1111-1111-111111111111', new Date())
    await writeSession('-Users-foo-a', '22222222-2222-2222-2222-222222222222', new Date())
    await fs.mkdir(path.join(CLAUDE_CODE_ROOT_PATH, 'projects', '-Users-foo-a', 'memory'), { recursive: true })
    await fs.mkdir(path.join(CLAUDE_CODE_ROOT_PATH, 'projects', '-Users-foo-b'), { recursive: true })
    await writeSession('-Users-foo-b', '33333333-3333-3333-3333-333333333333', new Date())

    const r = await discoverProjects(CLAUDE_CODE_ROOT_PATH)
    expect(r.map((p) => p.id)).toEqual(['-Users-foo-a', '-Users-foo-b'])
    expect(r[0]?.session_files).toHaveLength(2)
    expect(r[0]?.has_memory).toBe(true)
    expect(r[1]?.has_memory).toBe(false)
  })

  it('ignores non-jsonl files in a project dir', async () => {
    const projDir = path.join(CLAUDE_CODE_ROOT_PATH, 'projects', '-Users-foo-c')
    await fs.mkdir(projDir, { recursive: true })
    await fs.writeFile(path.join(projDir, 'notes.txt'), 'x')
    await fs.writeFile(path.join(projDir, 'random.json'), '{}')
    await writeSession('-Users-foo-c', '44444444-4444-4444-4444-444444444444', new Date())

    const r = await discoverProjects(CLAUDE_CODE_ROOT_PATH)
    expect(r[0]?.session_files).toEqual(['44444444-4444-4444-4444-444444444444.jsonl'])
  })
})

describe('projectsList', () => {
  it('returns sorted projects with bytes', async () => {
    await writeSession('-A', '11111111-1111-1111-1111-111111111111', new Date(), 'a')
    await writeSession('-B', '22222222-2222-2222-2222-222222222222', new Date(), 'b'.repeat(64 * 1024))
    const r = await projectsList(CLAUDE_CODE_ROOT_PATH)
    expect(r.project_count).toBe(2)
    // Larger project first
    expect(r.projects[0]?.id).toBe('-B')
  })
})

describe('storageSummary', () => {
  it('aggregates counts + flags large totals', async () => {
    await writeSession('-A', '11111111-1111-1111-1111-111111111111', new Date())
    await writeSession('-A', '22222222-2222-2222-2222-222222222222', new Date())
    const r = await storageSummary(CLAUDE_CODE_ROOT_PATH, { flag_size_gb: 100, flag_session_count: 1, flag_orphan_count: 100 })
    expect(r.session_count).toBe(2)
    expect(r.project_count).toBe(1)
    expect(r.flags).toContain('session_count_exceeds_1')
  })

  it('flags orphan projects whose decoded path does not exist', async () => {
    await writeSession('-Users-ghost-project-1234567890', '11111111-1111-1111-1111-111111111111', new Date())
    const r = await storageSummary(CLAUDE_CODE_ROOT_PATH, { flag_size_gb: 100, flag_session_count: 100, flag_orphan_count: 0 })
    expect(r.orphan_project_count).toBe(1)
    expect(r.flags).toContain('orphan_projects_exceed_0')
  })

  it('flags total_size_exceeds when projects bytes exceed the gb threshold', async () => {
    await writeSession('-A', '11111111-1111-1111-1111-111111111111', new Date())
    // flag_size_gb: 0 ⇒ flagSizeBytes = 0 ⇒ any totalBytes > 0 flags.
    const r = await storageSummary(CLAUDE_CODE_ROOT_PATH, { flag_size_gb: 0, flag_session_count: 100, flag_orphan_count: 100 })
    expect(r.flags).toContain('total_size_exceeds_0gb')
  })
})

describe('obsoleteSessions', () => {
  it('returns sessions older than the cutoff', async () => {
    const oldDate = new Date(Date.now() - 45 * DAY_MS)
    const recent = new Date()
    await writeSession('-A', '11111111-1111-1111-1111-111111111111', oldDate)
    await writeSession('-A', '22222222-2222-2222-2222-222222222222', recent)

    const r = await obsoleteSessions(CLAUDE_CODE_ROOT_PATH, { older_than_days: 30, flag_count: 100, flag_size_mb: 100 })
    expect(r.obsolete_count).toBe(1)
    expect(r.top_10_oldest[0]?.session).toBe('11111111-1111-1111-1111-111111111111.jsonl')
  })

  it('includes sidecar dir bytes when present', async () => {
    const oldDate = new Date(Date.now() - 45 * DAY_MS)
    const uuid = '11111111-1111-1111-1111-111111111111'
    await writeSession('-A', uuid, oldDate)
    const sidecar = path.join(CLAUDE_CODE_ROOT_PATH, 'projects', '-A', uuid)
    await fs.mkdir(sidecar, { recursive: true })
    await fs.writeFile(path.join(sidecar, 'output.bin'), 'x'.repeat(2048))

    const r = await obsoleteSessions(CLAUDE_CODE_ROOT_PATH, { older_than_days: 30, flag_count: 100, flag_size_mb: 100 })
    expect(r.top_10_oldest[0]?.bytes).toBeGreaterThan(2048)
  })

  it('sorts multiple obsolete sessions by mtime ascending', async () => {
    const older = new Date(Date.now() - 90 * DAY_MS)
    const middle = new Date(Date.now() - 45 * DAY_MS)
    await writeSession('-A', '11111111-1111-1111-1111-111111111111', middle)
    await writeSession('-A', '22222222-2222-2222-2222-222222222222', older)
    const r = await obsoleteSessions(CLAUDE_CODE_ROOT_PATH, { older_than_days: 30, flag_count: 100, flag_size_mb: 100 })
    expect(r.obsolete_count).toBe(2)
    expect(r.top_10_oldest[0]?.session).toBe('22222222-2222-2222-2222-222222222222.jsonl')
    expect(r.top_10_oldest[1]?.session).toBe('11111111-1111-1111-1111-111111111111.jsonl')
  })

  it('flags when obsolete count and total bytes exceed their thresholds', async () => {
    const oldDate = new Date(Date.now() - 45 * DAY_MS)
    await writeSession('-A', '11111111-1111-1111-1111-111111111111', oldDate)
    await writeSession('-A', '22222222-2222-2222-2222-222222222222', oldDate)
    // flag_count=1 + 2 obsolete → count flag
    // flag_size_mb=0 + nonzero bytes → size flag
    const r = await obsoleteSessions(CLAUDE_CODE_ROOT_PATH, { older_than_days: 30, flag_count: 1, flag_size_mb: 0 })
    expect(r.flags).toContain('obsolete_count_exceeds_1')
    expect(r.flags).toContain('obsolete_size_exceeds_0mb')
  })

  it('honours the project filter', async () => {
    const oldDate = new Date(Date.now() - 45 * DAY_MS)
    await writeSession('-A', '11111111-1111-1111-1111-111111111111', oldDate)
    await writeSession('-B', '22222222-2222-2222-2222-222222222222', oldDate)

    const r = await obsoleteSessions(CLAUDE_CODE_ROOT_PATH, { older_than_days: 30, flag_count: 100, flag_size_mb: 100, project: '-A' })
    expect(r.obsolete_count).toBe(1)
  })
})

describe('globalStatus', () => {
  it('reads history.jsonl line count and settings.cleanupPeriodDays', async () => {
    await fs.writeFile(path.join(CLAUDE_CODE_ROOT_PATH, 'history.jsonl'), 'a\nb\nc\n')
    await fs.writeFile(path.join(CLAUDE_CODE_ROOT_PATH, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 999 }))
    await fs.writeFile(path.join(CLAUDE_CODE_ROOT_PATH, '.last-cleanup'), '2026-05-11T00:00:00.000Z')

    const r = await globalStatus(CLAUDE_CODE_ROOT_PATH)
    expect(r.history.exists).toBe(true)
    expect(r.history.lines).toBe(3)
    expect(r.settings.cleanup_period_days).toBe(999)
    expect(r.last_cleanup).toBe('2026-05-11T00:00:00.000Z')

    await fs.rm(path.join(CLAUDE_CODE_ROOT_PATH, 'history.jsonl'))
    await fs.rm(path.join(CLAUDE_CODE_ROOT_PATH, 'settings.json'))
    await fs.rm(path.join(CLAUDE_CODE_ROOT_PATH, '.last-cleanup'))
  })

  it('handles a missing history.jsonl gracefully', async () => {
    const r = await globalStatus(CLAUDE_CODE_ROOT_PATH)
    expect(r.history.exists).toBe(false)
  })

  it('reports lines=0 for an empty history.jsonl', async () => {
    await fs.writeFile(path.join(CLAUDE_CODE_ROOT_PATH, 'history.jsonl'), '')
    const r = await globalStatus(CLAUDE_CODE_ROOT_PATH)
    expect(r.history.exists).toBe(true)
    expect(r.history.lines).toBe(0)
    await fs.rm(path.join(CLAUDE_CODE_ROOT_PATH, 'history.jsonl'))
  })

  it('keeps last_cleanup null when .last-cleanup exists but cannot be read (EISDIR when it is a directory)', async () => {
    // Make .last-cleanup a *directory* — pathExists returns true, but the
    // subsequent fs.readFile throws EISDIR. The catch swallows it and leaves
    // lastCleanup null.
    await fs.mkdir(path.join(CLAUDE_CODE_ROOT_PATH, '.last-cleanup'), { recursive: true })
    try {
      const r = await globalStatus(CLAUDE_CODE_ROOT_PATH)
      expect(r.last_cleanup).toBeNull()
    } finally {
      await fs.rm(path.join(CLAUDE_CODE_ROOT_PATH, '.last-cleanup'), { recursive: true, force: true })
    }
  })
})

describe('sessionRead', () => {
  it('returns the last N lines by default', async () => {
    const uuid = '11111111-1111-1111-1111-111111111111'
    const lines = Array.from({ length: 5 }, (_, i) => `{"i":${i}}`).join('\n')
    await fs.mkdir(path.join(CLAUDE_CODE_ROOT_PATH, 'projects', '-A'), { recursive: true })
    await fs.writeFile(path.join(CLAUDE_CODE_ROOT_PATH, 'projects', '-A', `${uuid}.jsonl`), lines)

    const r = await sessionRead(CLAUDE_CODE_ROOT_PATH, { project: '-A', session: `${uuid}.jsonl`, max_lines: 2, tail: true })
    expect(r.lines).toEqual(['{"i":3}', '{"i":4}'])
    expect(r.line_count).toBe(5)
  })

  it('rejects a session name that is not <uuid>.jsonl', async () => {
    await expect(sessionRead(CLAUDE_CODE_ROOT_PATH, { project: '-A', session: 'not-a-uuid.jsonl', max_lines: 10, tail: true })).rejects.toThrow(/must be "<uuid>.jsonl"/)
  })

  it('honours tail=false (returns the first N lines)', async () => {
    const uuid = '11111111-1111-1111-1111-111111111111'
    const lines = Array.from({ length: 5 }, (_, i) => `{"i":${i}}`).join('\n')
    await fs.mkdir(path.join(CLAUDE_CODE_ROOT_PATH, 'projects', '-A'), { recursive: true })
    await fs.writeFile(path.join(CLAUDE_CODE_ROOT_PATH, 'projects', '-A', `${uuid}.jsonl`), lines)
    const r = await sessionRead(CLAUDE_CODE_ROOT_PATH, { project: '-A', session: `${uuid}.jsonl`, max_lines: 2, tail: false })
    expect(r.lines).toEqual(['{"i":0}', '{"i":1}'])
  })
})

describe('sessionsPrune', () => {
  it('dry_run reports deletions but does not remove files', async () => {
    const oldDate = new Date(Date.now() - 70 * DAY_MS)
    await writeSession('-A', '11111111-1111-1111-1111-111111111111', oldDate)
    const r = await sessionsPrune(CLAUDE_CODE_ROOT_PATH, { older_than_days: 60, dry_run: true })
    expect(r.deleted_count).toBe(1)
    // File should still exist
    const stillThere = await fs.stat(path.join(CLAUDE_CODE_ROOT_PATH, 'projects', '-A', '11111111-1111-1111-1111-111111111111.jsonl'))
    expect(stillThere.isFile()).toBe(true)
  })

  it('deletes old sessions and their sidecar dirs', async () => {
    const oldDate = new Date(Date.now() - 70 * DAY_MS)
    const uuid = '11111111-1111-1111-1111-111111111111'
    await writeSession('-A', uuid, oldDate)
    const sidecar = path.join(CLAUDE_CODE_ROOT_PATH, 'projects', '-A', uuid)
    await fs.mkdir(sidecar, { recursive: true })
    await fs.writeFile(path.join(sidecar, 'output.bin'), 'x')

    const r = await sessionsPrune(CLAUDE_CODE_ROOT_PATH, { older_than_days: 60, dry_run: false })
    expect(r.deleted_count).toBe(1)
    expect(r.deleted[0]?.sidecar_deleted).toBe(true)
    await expect(fs.access(path.join(CLAUDE_CODE_ROOT_PATH, 'projects', '-A', `${uuid}.jsonl`))).rejects.toThrow()
    await expect(fs.access(sidecar)).rejects.toThrow()
  })

  it('leaves recent sessions alone', async () => {
    const recent = new Date()
    await writeSession('-A', '11111111-1111-1111-1111-111111111111', recent)
    const r = await sessionsPrune(CLAUDE_CODE_ROOT_PATH, { older_than_days: 60, dry_run: false })
    expect(r.deleted_count).toBe(0)
  })

  it('reports sidecar_deleted=false when there is no sidecar dir for the session', async () => {
    const oldDate = new Date(Date.now() - 70 * DAY_MS)
    const uuid = '11111111-1111-1111-1111-111111111111'
    await writeSession('-A', uuid, oldDate)
    // No sidecar created — exercises the `sidecarExists ? ... : 0` falsy branch.
    const r = await sessionsPrune(CLAUDE_CODE_ROOT_PATH, { older_than_days: 60, dry_run: false })
    expect(r.deleted_count).toBe(1)
    expect(r.deleted[0]?.sidecar_deleted).toBe(false)
  })

  it('honours the project filter', async () => {
    const oldDate = new Date(Date.now() - 70 * DAY_MS)
    await writeSession('-A', '11111111-1111-1111-1111-111111111111', oldDate)
    await writeSession('-B', '22222222-2222-2222-2222-222222222222', oldDate)
    const r = await sessionsPrune(CLAUDE_CODE_ROOT_PATH, { older_than_days: 60, project: '-B', dry_run: false })
    expect(r.deleted_count).toBe(1)
    expect(r.deleted[0]?.project).toBe('-B')
    // -A session still on disk.
    const kept = await fs.stat(path.join(CLAUDE_CODE_ROOT_PATH, 'projects', '-A', '11111111-1111-1111-1111-111111111111.jsonl'))
    expect(kept.isFile()).toBe(true)
  })
})

describe('encodeProjectPath', () => {
  it('encodes an absolute path the way Claude Code names project dirs', () => {
    expect(encodeProjectPath('/Users/foo/dev/proj')).toBe('-Users-foo-dev-proj')
  })

  it('renders dots as dashes (matches the lossy doc convention)', () => {
    expect(encodeProjectPath('/Users/foo/my.app')).toBe('-Users-foo-my-app')
  })

  it('throws if not given an absolute path', () => {
    expect(() => encodeProjectPath('relative/path')).toThrow(/absolute path/)
  })
})

describe('globalStatus.freshness', () => {
  it('flags looks_freshly_initialized when no history/settings and dirs are recent', async () => {
    // beforeEach already cleaned projects/. Make sure history/settings are absent too.
    await fs.rm(path.join(CLAUDE_CODE_ROOT_PATH, 'history.jsonl'), { force: true })
    await fs.rm(path.join(CLAUDE_CODE_ROOT_PATH, 'settings.json'), { force: true })

    const r = await globalStatus(CLAUDE_CODE_ROOT_PATH)
    expect(r.freshness.looks_freshly_initialized).toBe(true)
    expect(r.freshness.oldest_top_level_age_hours).not.toBeNull()
  })

  it('does not flag when history.jsonl is present', async () => {
    await fs.writeFile(path.join(CLAUDE_CODE_ROOT_PATH, 'history.jsonl'), 'x\n')
    const r = await globalStatus(CLAUDE_CODE_ROOT_PATH)
    expect(r.freshness.looks_freshly_initialized).toBe(false)
    await fs.rm(path.join(CLAUDE_CODE_ROOT_PATH, 'history.jsonl'))
  })

  it('returns oldest_top_level_age_hours=null when claudeRoot has no top-level subdirectories', async () => {
    // Use an isolated empty claudeRoot so topLevel ends up empty.
    const emptyRoot = path.join(CLAUDE_CODE_ROOT_PATH, '__empty_root__')
    await fs.mkdir(emptyRoot, { recursive: true })
    try {
      const r = await globalStatus(emptyRoot)
      expect(r.top_level_dirs).toEqual([])
      expect(r.freshness.oldest_top_level_age_hours).toBeNull()
      expect(r.freshness.looks_freshly_initialized).toBe(false)
    } finally {
      await fs.rm(emptyRoot, { recursive: true, force: true })
    }
  })
})

describe('relocateProject', () => {
  it('renames the encoded project subdir to match new_path', async () => {
    const oldDir = '-Users-foo-old-proj'
    await writeSession(oldDir, '11111111-1111-1111-1111-111111111111', new Date())

    // Stand up a real destination so the existence check passes.
    const realDest = path.join(CLAUDE_CODE_ROOT_PATH, '__relocate_fixture__')
    await fs.mkdir(realDest, { recursive: true })

    const r = await relocateProject(CLAUDE_CODE_ROOT_PATH, { project: oldDir, new_path: realDest, dry_run: false })
    expect(r.moved).toBe(true)
    expect(r.new_id).toBe(encodeProjectPath(realDest))

    // Old dir gone, new dir present with the session intact.
    await expect(fs.access(path.join(CLAUDE_CODE_ROOT_PATH, 'projects', oldDir))).rejects.toThrow()
    const movedSession = path.join(CLAUDE_CODE_ROOT_PATH, 'projects', r.new_id, '11111111-1111-1111-1111-111111111111.jsonl')
    const stat = await fs.stat(movedSession)
    expect(stat.isFile()).toBe(true)

    await fs.rm(realDest, { recursive: true, force: true })
  })

  it('dry_run reports intended move without renaming', async () => {
    const oldDir = '-Users-foo-old-proj'
    await writeSession(oldDir, '11111111-1111-1111-1111-111111111111', new Date())
    const realDest = path.join(CLAUDE_CODE_ROOT_PATH, '__relocate_fixture_dry__')
    await fs.mkdir(realDest, { recursive: true })

    const r = await relocateProject(CLAUDE_CODE_ROOT_PATH, { project: oldDir, new_path: realDest, dry_run: true })
    expect(r.moved).toBe(false)
    const stillThere = await fs.stat(path.join(CLAUDE_CODE_ROOT_PATH, 'projects', oldDir))
    expect(stillThere.isDirectory()).toBe(true)

    await fs.rm(realDest, { recursive: true, force: true })
  })

  it('rejects when new_path does not exist on disk', async () => {
    await writeSession('-A', '11111111-1111-1111-1111-111111111111', new Date())
    await expect(relocateProject(CLAUDE_CODE_ROOT_PATH, { project: '-A', new_path: '/definitely/not/a/real/path/here/xyz', dry_run: false })).rejects.toThrow(/does not exist on disk/)
  })

  it('rejects when destination encoded name already exists', async () => {
    const realDest = path.join(CLAUDE_CODE_ROOT_PATH, '__relocate_fixture_conflict__')
    await fs.mkdir(realDest, { recursive: true })
    const destId = encodeProjectPath(realDest)
    await writeSession('-Users-foo-source', '11111111-1111-1111-1111-111111111111', new Date())
    await writeSession(destId, '22222222-2222-2222-2222-222222222222', new Date())

    await expect(relocateProject(CLAUDE_CODE_ROOT_PATH, { project: '-Users-foo-source', new_path: realDest, dry_run: false })).rejects.toThrow(/already exists/)

    await fs.rm(realDest, { recursive: true, force: true })
  })

  it('rejects when the source project dir does not exist', async () => {
    const realDest = path.join(CLAUDE_CODE_ROOT_PATH, '__relocate_fixture_missing_source__')
    await fs.mkdir(realDest, { recursive: true })
    try {
      await expect(relocateProject(CLAUDE_CODE_ROOT_PATH, { project: '-totally-fake-project', new_path: realDest, dry_run: false })).rejects.toThrow(/Project dir not found/)
    } finally {
      await fs.rm(realDest, { recursive: true, force: true })
    }
  })

  it('returns moved=false with reason="already-encoded-to-this-id" when new_path encodes back to the same project id', async () => {
    // When the source project id already matches what encodeProjectPath
    // would produce for new_path, there's nothing to rename.
    const realDest = path.join(CLAUDE_CODE_ROOT_PATH, '__relocate_fixture_same__')
    await fs.mkdir(realDest, { recursive: true })
    try {
      const sameId = encodeProjectPath(realDest)
      await writeSession(sameId, '33333333-3333-3333-3333-333333333333', new Date())
      const r = await relocateProject(CLAUDE_CODE_ROOT_PATH, { project: sameId, new_path: realDest, dry_run: false })
      expect(r.moved).toBe(false)
      expect((r as { reason?: string }).reason).toBe('already-encoded-to-this-id')
    } finally {
      await fs.rm(realDest, { recursive: true, force: true })
    }
  })
})

describe('pruneOrphanProjects', () => {
  it('deletes orphan projects whose decoded path is missing', async () => {
    await writeSession('-Users-ghost-project-aaaaaaaa', '11111111-1111-1111-1111-111111111111', new Date())
    // A non-orphan: "/tmp" exists on every Unix and round-trips cleanly through encode/decode.
    await writeSession('-tmp', '22222222-2222-2222-2222-222222222222', new Date())

    const r = await pruneOrphanProjects(CLAUDE_CODE_ROOT_PATH, { dry_run: false, include_with_memory: false })
    expect(r.deleted_count).toBe(1)
    expect(r.deleted[0]?.id).toBe('-Users-ghost-project-aaaaaaaa')

    // Live project untouched.
    const stillThere = await fs.stat(path.join(CLAUDE_CODE_ROOT_PATH, 'projects', '-tmp'))
    expect(stillThere.isDirectory()).toBe(true)
  })

  it('dry_run reports orphans without deleting', async () => {
    await writeSession('-Users-ghost-project-bbbbbbbb', '11111111-1111-1111-1111-111111111111', new Date())
    const r = await pruneOrphanProjects(CLAUDE_CODE_ROOT_PATH, { dry_run: true, include_with_memory: false })
    expect(r.deleted_count).toBe(1)
    const stillThere = await fs.stat(path.join(CLAUDE_CODE_ROOT_PATH, 'projects', '-Users-ghost-project-bbbbbbbb'))
    expect(stillThere.isDirectory()).toBe(true)
  })

  it('skips orphans with memory by default', async () => {
    await writeSession('-Users-ghost-project-cccccccc', '11111111-1111-1111-1111-111111111111', new Date())
    await fs.mkdir(path.join(CLAUDE_CODE_ROOT_PATH, 'projects', '-Users-ghost-project-cccccccc', 'memory'), { recursive: true })

    const r = await pruneOrphanProjects(CLAUDE_CODE_ROOT_PATH, { dry_run: false, include_with_memory: false })
    expect(r.deleted_count).toBe(0)
    expect(r.skipped).toHaveLength(1)
    expect(r.skipped[0]?.reason).toBe('has_memory')
  })

  it('deletes orphans with memory when include_with_memory is true', async () => {
    await writeSession('-Users-ghost-project-dddddddd', '11111111-1111-1111-1111-111111111111', new Date())
    await fs.mkdir(path.join(CLAUDE_CODE_ROOT_PATH, 'projects', '-Users-ghost-project-dddddddd', 'memory'), { recursive: true })

    const r = await pruneOrphanProjects(CLAUDE_CODE_ROOT_PATH, { dry_run: false, include_with_memory: true })
    expect(r.deleted_count).toBe(1)
  })
})
