import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuditConfig } from './audit-log.js'

describe('appendAuditEvent / withAuditLog', () => {
  const tmpDir = path.join(os.tmpdir(), 'audit-log-tests', `run-${process.pid}-${Date.now()}`)
  const logPath = path.join(tmpDir, 'audit.jsonl')

  // The audit-log module keeps internal state (chmodEnsured, the append queue),
  // so reset modules per test for isolation. Config is passed in explicitly.
  const auditCfg = (o: Partial<AuditConfig> = {}): AuditConfig => ({
    mode: 'writes',
    path: logPath,
    maxBytes: 10 * 1024 * 1024,
    keep: 5,
    ...o
  })

  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true })
    vi.resetModules()
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  const flushAsync = () => new Promise((r) => setTimeout(r, 20))

  it('appends an event line for a destructive-level tool', async () => {
    const { withAuditLog } = await import('./audit-log.js')
    const wrapped = withAuditLog(auditCfg(), 'test_destructive_tool', 'destructive', async () => ({
      content: [{ type: 'text', text: '{}' }]
    }))
    await wrapped({ name: 'memo.md' })
    await flushAsync()
    const raw = await fs.readFile(logPath, 'utf-8')
    const event = JSON.parse(raw.trim())
    expect(event.server).toBe('mcp-housekeeping-claude')
    expect(event.tool).toBe('test_destructive_tool')
    expect(event.level).toBe('destructive')
    expect(event.ok).toBe(true)
    expect(event.args).toEqual({ name: 'memo.md' })
  })

  it('redacts large content fields', async () => {
    const { withAuditLog } = await import('./audit-log.js')
    const wrapped = withAuditLog(auditCfg(), 'test_destructive_tool', 'destructive', async () => ({
      content: [{ type: 'text', text: '{}' }]
    }))
    await wrapped({ name: 'memo.md', content: 'x'.repeat(5000) })
    await flushAsync()
    const event = JSON.parse((await fs.readFile(logPath, 'utf-8')).trim())
    expect(event.args.content).toMatch(/^\[redacted \d+B\]$/)
  })

  it('records ok:false and error text when tool result is isError', async () => {
    const { withAuditLog } = await import('./audit-log.js')
    const wrapped = withAuditLog(auditCfg(), 'test_destructive_tool', 'destructive', async () => ({
      isError: true,
      content: [{ type: 'text', text: 'boom' }]
    }))
    await wrapped({})
    await flushAsync()
    const event = JSON.parse((await fs.readFile(logPath, 'utf-8')).trim())
    expect(event.ok).toBe(false)
    expect(event.error).toBe('boom')
  })

  it('records ok:false when the handler throws', async () => {
    const { withAuditLog } = await import('./audit-log.js')
    const wrapped = withAuditLog(auditCfg(), 'test_destructive_tool', 'destructive', async () => {
      throw new Error('kaboom')
    })
    await expect(wrapped({})).rejects.toThrow(/kaboom/)
    await flushAsync()
    const event = JSON.parse((await fs.readFile(logPath, 'utf-8')).trim())
    expect(event.ok).toBe(false)
    expect(event.error).toBe('kaboom')
  })

  it('skips read-level tools by default (mode=writes)', async () => {
    const { withAuditLog } = await import('./audit-log.js')
    const handler = vi.fn(async () => ({ content: [{ type: 'text', text: '{}' }] }))
    const wrapped = withAuditLog(auditCfg(), 'test_readonly_tool', 'read', handler)
    // When read-level logging is disabled, withAuditLog returns the handler verbatim.
    expect(wrapped).toBe(handler)
  })

  it('logs read-level tools when mode=all', async () => {
    const { withAuditLog } = await import('./audit-log.js')
    const wrapped = withAuditLog(auditCfg({ mode: 'all' }), 'test_readonly_tool', 'read', async () => ({
      content: [{ type: 'text', text: '{}' }]
    }))
    expect(wrapped).not.toBeUndefined()
    await wrapped({})
    await flushAsync()
    const event = JSON.parse((await fs.readFile(logPath, 'utf-8')).trim())
    expect(event.level).toBe('read')
  })

  it('skips every tool — read and destructive levels — when mode=off', async () => {
    const { withAuditLog } = await import('./audit-log.js')
    const destructiveHandler = vi.fn(async (_args: unknown) => ({ content: [{ type: 'text', text: '{}' }] }))
    const readHandler = vi.fn(async (_args: unknown) => ({ content: [{ type: 'text', text: '{}' }] }))
    // Both return the original handler verbatim — no wrapping, no file I/O.
    expect(withAuditLog(auditCfg({ mode: 'off' }), 'test_destructive_tool', 'destructive', destructiveHandler)).toBe(
      destructiveHandler
    )
    expect(withAuditLog(auditCfg({ mode: 'off' }), 'test_readonly_tool', 'read', readHandler)).toBe(readHandler)
    await destructiveHandler({})
    await flushAsync()
    // No audit file should have been created.
    await expect(fs.access(logPath)).rejects.toThrow()
  })

  it('creates the audit log with mode 0o600 and chmods an existing 0o644 log down to 0o600', async () => {
    // Pre-create the log with the world-readable default so we exercise the
    // chmod path, not just the appendFile(mode) creation path.
    await fs.mkdir(path.dirname(logPath), { recursive: true })
    await fs.writeFile(logPath, '', { mode: 0o644 })
    expect(((await fs.stat(logPath)).mode & 0o777).toString(8)).toBe('644')

    const { withAuditLog } = await import('./audit-log.js')
    const wrapped = withAuditLog(auditCfg(), 'test_destructive_tool', 'destructive', async () => ({
      content: [{ type: 'text', text: '{}' }]
    }))
    await wrapped({ name: 'memo.md' })
    await flushAsync()

    const mode = (await fs.stat(logPath)).mode & 0o777
    expect(mode.toString(8)).toBe('600')
  })

  it('rotates the log when it exceeds maxBytes — keeping the last KEEP archives', async () => {
    // Tiny cap (200 bytes) so one append crosses it, and keep=2 so we exercise
    // both the shift (.1 → .2) and the drop (.2 oldest goes away).
    const { withAuditLog } = await import('./audit-log.js')
    const wrapped = withAuditLog(
      auditCfg({ maxBytes: 200, keep: 2 }),
      'test_destructive_tool',
      'destructive',
      async () => ({
        content: [{ type: 'text', text: '{}' }]
      })
    )

    // Each call produces a ~250-byte event line, so every append rotates.
    await wrapped({ note: 'first', padding: 'x'.repeat(100) })
    await flushAsync()
    await wrapped({ note: 'second', padding: 'y'.repeat(100) })
    await flushAsync()
    await wrapped({ note: 'third', padding: 'z'.repeat(100) })
    await flushAsync()

    // After three rotating appends:
    //   - audit.jsonl    holds nothing yet (or the next event if a fourth append fires)
    //   - audit.jsonl.1  holds the third event (most recent before live)
    //   - audit.jsonl.2  holds the second event
    //   - audit.jsonl.3  must NOT exist (would exceed keep=2)
    const r1 = await fs.readFile(`${logPath}.1`, 'utf-8')
    const r2 = await fs.readFile(`${logPath}.2`, 'utf-8')
    expect(r1).toMatch(/"note":"third"/)
    expect(r2).toMatch(/"note":"second"/)
    await expect(fs.access(`${logPath}.3`)).rejects.toThrow()
  })

  it('does not rotate when maxBytes=0 (rotation disabled)', async () => {
    const { withAuditLog } = await import('./audit-log.js')
    const wrapped = withAuditLog(
      auditCfg({ maxBytes: 0, keep: 2 }),
      'test_destructive_tool',
      'destructive',
      async () => ({
        content: [{ type: 'text', text: '{}' }]
      })
    )
    await wrapped({ note: 'a', padding: 'x'.repeat(500) })
    await wrapped({ note: 'b', padding: 'y'.repeat(500) })
    await flushAsync()

    // Both lines should live in the same live file; no rotation files created.
    const live = await fs.readFile(logPath, 'utf-8')
    expect(live).toMatch(/"note":"a"/)
    expect(live).toMatch(/"note":"b"/)
    await expect(fs.access(`${logPath}.1`)).rejects.toThrow()
  })

  it('truncates without preserving history when keep=0', async () => {
    const { withAuditLog } = await import('./audit-log.js')
    const wrapped = withAuditLog(
      auditCfg({ maxBytes: 200, keep: 0 }),
      'test_destructive_tool',
      'destructive',
      async () => ({
        content: [{ type: 'text', text: '{}' }]
      })
    )
    await wrapped({ note: 'first', padding: 'x'.repeat(100) })
    await wrapped({ note: 'second', padding: 'y'.repeat(100) })
    await flushAsync()

    // keep=0 means rotation just unlinks the live file rather than archiving it.
    await expect(fs.access(`${logPath}.1`)).rejects.toThrow()
  })

  it('truncates the serialized args when they exceed the size cap but `content` is not a string', async () => {
    // The `copy.content = '[redacted ...B]'` redaction in sanitizeArgs only
    // fires when `content` is a string. For any other oversized field we fall
    // through to the JSON.stringify length check and return a `_truncated`
    // preview — that's the path this test pins down.
    const { withAuditLog } = await import('./audit-log.js')
    const wrapped = withAuditLog(auditCfg(), 'test_destructive_tool', 'destructive', async () => ({
      content: [{ type: 'text', text: '{}' }]
    }))
    await wrapped({ payload: 'x'.repeat(5000) })
    await flushAsync()
    const event = JSON.parse((await fs.readFile(logPath, 'utf-8')).trim())
    expect(event.args._truncated).toBe(true)
    expect(typeof event.args.preview).toBe('string')
    expect(event.args.preview.length).toBeLessThanOrEqual(4096)
  })

  it('skips rotation silently when stat fails (eg the log was removed mid-flight)', async () => {
    // Covers the inner `try { fs.stat(...) } catch { return }` in rotateIfNeeded.
    // stat is otherwise unreachable from a failing path because appendFile would
    // already have errored before rotation runs — so we substitute a one-shot
    // ENOENT for the dynamically-imported audit-log only. ESM namespaces are
    // frozen, so `vi.doMock` (which intercepts the loader) is required;
    // `vi.spyOn(fs, 'stat')` would throw "namespace is not configurable".
    let statCalls = 0
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
      return {
        ...actual,
        stat: async (...args: Parameters<typeof actual.stat>) => {
          statCalls++
          if (statCalls === 1) throw new Error('ENOENT (simulated)')
          return actual.stat(...args)
        }
      }
    })

    const { withAuditLog } = await import('./audit-log.js')
    const wrapped = withAuditLog(auditCfg({ maxBytes: 1 }), 'test_destructive_tool', 'destructive', async () => ({
      content: [{ type: 'text', text: '{}' }]
    }))
    await wrapped({ note: 'a' })
    await new Promise((r) => setTimeout(r, 30))

    expect(statCalls).toBeGreaterThanOrEqual(1)
    // No rotation files exist — the stat catch returned before any rename/rm.
    await expect(fs.access(`${logPath}.1`)).rejects.toThrow()
    vi.doUnmock('node:fs/promises')
  })

  it('reports a rotation failure to stderr without crashing (eg a slot path is a directory)', async () => {
    // Force the `rm(<keep>+1, { force: true })` call to throw EISDIR by
    // placing a directory at that slot — `force` only suppresses ENOENT, not
    // EISDIR. This exercises the outer `catch` around the rotation block.
    await fs.mkdir(path.dirname(logPath), { recursive: true })
    await fs.mkdir(`${logPath}.2`, { recursive: true })

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { withAuditLog } = await import('./audit-log.js')
    const wrapped = withAuditLog(
      auditCfg({ maxBytes: 200, keep: 2 }),
      'test_destructive_tool',
      'destructive',
      async () => ({
        content: [{ type: 'text', text: '{}' }]
      })
    )
    await wrapped({ note: 'forces-rotation', padding: 'x'.repeat(300) })
    await new Promise((r) => setTimeout(r, 30))

    expect(errSpy.mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes('rotation failed'))).toBe(true)
    errSpy.mockRestore()
  })

  it('handles non-object args (eg an array or primitive) without copying or redacting', async () => {
    // Covers the `args && typeof args === 'object' && !Array.isArray(args)` false
    // branch in sanitizeArgs. Two cases pinned in a single test: an array
    // (truthy + object but Array.isArray → true) and a primitive string
    // (truthy but typeof !== 'object').
    const { withAuditLog } = await import('./audit-log.js')
    const wrapped = withAuditLog(auditCfg(), 'test_destructive_tool', 'destructive', async () => ({
      content: [{ type: 'text', text: '{}' }]
    }))
    // appendAuditEvent fires via void so we need a settle delay between calls
    // to keep the JSONL order deterministic.
    await wrapped(['x', 'y'])
    await flushAsync()
    await wrapped('a-primitive-string')
    await flushAsync()
    const [first, second] = (await fs.readFile(logPath, 'utf-8')).trim().split('\n')
    expect(JSON.parse(first ?? '').args).toEqual(['x', 'y'])
    expect(JSON.parse(second ?? '').args).toBe('a-primitive-string')
  })

  it('redacts URL credentials anywhere in args — strings, arrays, nested objects — leaving primitives untouched', async () => {
    // Covers redactUrlCredentials' deep walk: the credential-bearing string
    // replacement, the array branch, recursion into a nested object, and the
    // primitive fall-through (the number is returned verbatim, hitting line 58).
    const { withAuditLog } = await import('./audit-log.js')
    const wrapped = withAuditLog(auditCfg(), 'test_destructive_tool', 'destructive', async () => ({
      content: [{ type: 'text', text: '{}' }]
    }))
    await wrapped({
      url: 'https://user:tok3n@example.com/x',
      list: ['https://user:tok3n@example.com/y'],
      nested: { inner: 'https://user:tok3n@example.com/z' },
      count: 42
    })
    await flushAsync()
    const raw = await fs.readFile(logPath, 'utf-8')
    expect(raw).toContain('<redacted>')
    expect(raw).not.toContain('tok3n')
    const event = JSON.parse(raw.trim())
    expect(event.args.url).toBe('https://<redacted>@example.com/x')
    expect(event.args.list).toEqual(['https://<redacted>@example.com/y'])
    expect(event.args.nested.inner).toBe('https://<redacted>@example.com/z')
    expect(event.args.count).toBe(42)
  })

  it('coerces a non-Error throw value to a string when recording the failure', async () => {
    // Covers the `err instanceof Error ? err.message : String(err)` false branch
    // in withAuditLog's catch. Handlers can throw anything (string, object, …);
    // the audit row must still capture a textual `error` field.
    const { withAuditLog } = await import('./audit-log.js')
    const wrapped = withAuditLog(auditCfg(), 'test_destructive_tool', 'destructive', async () => {
      throw 'plain-string-failure'
    })
    await expect(wrapped({})).rejects.toBe('plain-string-failure')
    await flushAsync()
    const event = JSON.parse((await fs.readFile(logPath, 'utf-8')).trim())
    expect(event.ok).toBe(false)
    expect(event.error).toBe('plain-string-failure')
  })

  it('records ok:false with no error text when an isError result has no content array', async () => {
    // Covers the `!Array.isArray(content)` true branch in extractErrorText.
    const { withAuditLog } = await import('./audit-log.js')
    const wrapped = withAuditLog(auditCfg(), 'test_destructive_tool', 'destructive', async () => ({ isError: true }))
    await wrapped({})
    await flushAsync()
    const event = JSON.parse((await fs.readFile(logPath, 'utf-8')).trim())
    expect(event.ok).toBe(false)
    expect(event.error).toBeUndefined()
  })

  it('coerces a non-Error rejection from fs to a string when logging the rotation failure', async () => {
    // The `err instanceof Error ? err.message : String(err)` false branch inside
    // rotateIfNeeded's catch can't fire in production because fs always rejects
    // with an Error subclass — we substitute a non-Error rejection to pin it
    // down so branch coverage hits 100%.
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
      return {
        ...actual,
        rm: async (...args: Parameters<typeof actual.rm>) => {
          const [target] = args
          // Only the rotation's `rm(.${KEEP+1})` call should be redirected to
          // the non-Error rejection — leave unrelated rm calls untouched.
          if (typeof target === 'string' && target.endsWith('.2')) {
            throw 'plain-string-rotation-failure'
          }
          return actual.rm(...args)
        }
      }
    })

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { withAuditLog } = await import('./audit-log.js')
    const wrapped = withAuditLog(
      auditCfg({ maxBytes: 200, keep: 2 }),
      'test_destructive_tool',
      'destructive',
      async () => ({
        content: [{ type: 'text', text: '{}' }]
      })
    )
    await wrapped({ note: 'forces-rotation', padding: 'x'.repeat(300) })
    await new Promise((r) => setTimeout(r, 30))

    expect(
      errSpy.mock.calls.some(
        ([msg]) =>
          typeof msg === 'string' && msg.includes('rotation failed') && msg.includes('plain-string-rotation-failure')
      )
    ).toBe(true)
    errSpy.mockRestore()
    vi.doUnmock('node:fs/promises')
  })

  it('coerces a non-Error rejection from fs to a string when logging the appendFile failure', async () => {
    // Same defensive branch as above, but in appendAuditEvent's outer catch.
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
      return {
        ...actual,
        mkdir: async (..._args: unknown[]) => {
          throw 'plain-string-mkdir-failure'
        }
      }
    })

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { withAuditLog } = await import('./audit-log.js')
    const wrapped = withAuditLog(auditCfg(), 'test_destructive_tool', 'destructive', async () => ({
      content: [{ type: 'text', text: '{}' }]
    }))
    await expect(wrapped({ note: 'x' })).resolves.toBeDefined()
    await new Promise((r) => setTimeout(r, 30))

    expect(
      errSpy.mock.calls.some(
        ([msg]) =>
          typeof msg === 'string' && msg.includes('failed to write') && msg.includes('plain-string-mkdir-failure')
      )
    ).toBe(true)
    errSpy.mockRestore()
    vi.doUnmock('node:fs/promises')
  })

  it('reports an appendFile failure to stderr without throwing back to the caller', async () => {
    // Point the audit-log path at a path whose parent is a regular file, not a
    // directory. `fs.mkdir(..., { recursive: true })` fails with ENOTDIR in
    // that case, surfacing the outer `catch` in appendAuditEvent.
    await fs.mkdir(tmpDir, { recursive: true })
    const blockerFile = path.join(tmpDir, 'blocker')
    await fs.writeFile(blockerFile, '')

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { withAuditLog } = await import('./audit-log.js')
    const wrapped = withAuditLog(
      auditCfg({ path: path.join(blockerFile, 'log.jsonl') }),
      'test_destructive_tool',
      'destructive',
      async () => ({
        content: [{ type: 'text', text: '{}' }]
      })
    )
    // The wrapped tool call must still resolve normally even though the audit
    // append fails underneath — that's the whole point of the swallow.
    await expect(wrapped({ note: 'x' })).resolves.toBeDefined()
    await new Promise((r) => setTimeout(r, 30))

    expect(errSpy.mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes('failed to write'))).toBe(true)
    errSpy.mockRestore()
  })
})
