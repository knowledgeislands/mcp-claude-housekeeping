/**
 * loadConfig() reads an explicit env object into a plain Config value. Tests
 * pass their own env literal — no module-level singleton, no vi.resetModules().
 */
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from './index.js'

const baseEnv = (overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  MCP_HOUSEKEEPING_CLAUDE_PATH: '/tmp/housekeeping',
  ...overrides
})

describe('MCP_HOUSEKEEPING_CLAUDE_PATH', () => {
  it('expands a leading ~/ to the user home directory', () => {
    const cfg = loadConfig(baseEnv({ MCP_HOUSEKEEPING_CLAUDE_PATH: '~/some-housekeeping' }))
    expect(cfg.housekeepingPath).toBe(path.resolve(path.join(os.homedir(), 'some-housekeeping')))
  })

  it('leaves an absolute path unchanged', () => {
    const cfg = loadConfig(baseEnv({ MCP_HOUSEKEEPING_CLAUDE_PATH: '/tmp/explicit-housekeeping' }))
    expect(cfg.housekeepingPath).toBe('/tmp/explicit-housekeeping')
  })

  it('throws when MCP_HOUSEKEEPING_CLAUDE_PATH is unset', () => {
    expect(() => loadConfig(baseEnv({ MCP_HOUSEKEEPING_CLAUDE_PATH: undefined }))).toThrow(
      /MCP_HOUSEKEEPING_CLAUDE_PATH environment variable must be set/
    )
  })
})

describe('MCP_HOUSEKEEPING_CLAUDE_ACCESS_LEVEL', () => {
  it('defaults to read when unset', () => {
    expect(loadConfig(baseEnv()).accessLevel).toBe('read')
  })

  it('defaults to read when empty/whitespace', () => {
    expect(loadConfig(baseEnv({ MCP_HOUSEKEEPING_CLAUDE_ACCESS_LEVEL: '   ' })).accessLevel).toBe('read')
  })

  it('accepts write', () => {
    expect(loadConfig(baseEnv({ MCP_HOUSEKEEPING_CLAUDE_ACCESS_LEVEL: 'write' })).accessLevel).toBe('write')
  })

  it('accepts destructive', () => {
    expect(loadConfig(baseEnv({ MCP_HOUSEKEEPING_CLAUDE_ACCESS_LEVEL: 'destructive' })).accessLevel).toBe('destructive')
  })

  it('throws on an unknown level', () => {
    expect(() => loadConfig(baseEnv({ MCP_HOUSEKEEPING_CLAUDE_ACCESS_LEVEL: 'observer' }))).toThrow(
      /Invalid MCP_HOUSEKEEPING_CLAUDE_ACCESS_LEVEL="observer"/
    )
  })
})

describe('MCP_HOUSEKEEPING_CLAUDE_AUDIT_LOG', () => {
  it('defaults to writes when unset', () => {
    expect(loadConfig(baseEnv()).auditLogMode).toBe('writes')
  })

  it('accepts off / all', () => {
    expect(loadConfig(baseEnv({ MCP_HOUSEKEEPING_CLAUDE_AUDIT_LOG: 'off' })).auditLogMode).toBe('off')
    expect(loadConfig(baseEnv({ MCP_HOUSEKEEPING_CLAUDE_AUDIT_LOG: 'all' })).auditLogMode).toBe('all')
  })

  it('throws on an unknown mode', () => {
    expect(() => loadConfig(baseEnv({ MCP_HOUSEKEEPING_CLAUDE_AUDIT_LOG: 'sometimes' }))).toThrow(
      /Invalid MCP_HOUSEKEEPING_CLAUDE_AUDIT_LOG/
    )
  })
})

describe('audit-log path + rotation knobs', () => {
  it('defaults the audit-log path under the housekeeping dir', () => {
    const cfg = loadConfig(baseEnv({ MCP_HOUSEKEEPING_CLAUDE_PATH: '/tmp/hk' }))
    expect(cfg.auditLogPath).toBe(path.resolve('/tmp/hk', 'audit', 'audit.jsonl'))
  })

  it('honours an explicit audit-log path (with ~ expansion)', () => {
    const cfg = loadConfig(baseEnv({ MCP_HOUSEKEEPING_CLAUDE_AUDIT_LOG_PATH: '~/logs/audit.jsonl' }))
    expect(cfg.auditLogPath).toBe(path.resolve(path.join(os.homedir(), 'logs', 'audit.jsonl')))
  })

  it('defaults max bytes (10 MiB) and keep (5)', () => {
    const cfg = loadConfig(baseEnv())
    expect(cfg.auditLogMaxBytes).toBe(10 * 1024 * 1024)
    expect(cfg.auditLogKeep).toBe(5)
  })

  it('parses explicit max bytes / keep', () => {
    const cfg = loadConfig(
      baseEnv({ MCP_HOUSEKEEPING_CLAUDE_AUDIT_LOG_MAX_BYTES: '200', MCP_HOUSEKEEPING_CLAUDE_AUDIT_LOG_KEEP: '2' })
    )
    expect(cfg.auditLogMaxBytes).toBe(200)
    expect(cfg.auditLogKeep).toBe(2)
  })

  it('throws on a negative max bytes', () => {
    expect(() => loadConfig(baseEnv({ MCP_HOUSEKEEPING_CLAUDE_AUDIT_LOG_MAX_BYTES: '-5' }))).toThrow(
      /MCP_HOUSEKEEPING_CLAUDE_AUDIT_LOG_MAX_BYTES.*non-negative/
    )
  })
})

describe('derived roots', () => {
  it('derives the three target roots from the home directory', () => {
    const cfg = loadConfig(baseEnv())
    expect(cfg.claudeCodeRootPath).toBe(path.join(os.homedir(), '.claude'))
    expect(cfg.claudeDesktopRootPath).toBe(
      path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions')
    )
    expect(cfg.vscodeWorkspaceStorageRootPath).toBe(
      path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage')
    )
  })
})

describe('hydrateEnvFromFiles (via loadConfig)', () => {
  // Every loadConfig call hydrates process.env from the package's `.env*`
  // files; that step branches on whether NODE_ENV is set. Exercise both arms.
  // Values still come from the explicit env literal, so the observable
  // contract is that hydration is NODE_ENV-agnostic and never throws.
  it('loads regardless of whether NODE_ENV is set', async () => {
    const { loadConfig } = await import('./index.js')
    const original = process.env.NODE_ENV
    try {
      process.env.NODE_ENV = 'production'
      expect(loadConfig(baseEnv({ MCP_HOUSEKEEPING_CLAUDE_ACCESS_LEVEL: 'write' })).accessLevel).toBe('write')
      delete process.env.NODE_ENV
      expect(loadConfig(baseEnv({ MCP_HOUSEKEEPING_CLAUDE_ACCESS_LEVEL: 'write' })).accessLevel).toBe('write')
    } finally {
      if (original === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = original
    }
  })
})
