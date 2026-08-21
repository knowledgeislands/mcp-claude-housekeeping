import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import type { Config } from '../../config/index.js'
import { memoryFileNameArg, registerClaudeDesktopTools, spaceIdArg } from './index.js'

// These tool-layer schemas are defense-in-depth for inputs that become path
// segments (spaces/<space_id>/memory/<name>). The deep enforcement is the
// two-layer guard in main/, but the schema must reject traversal / separators /
// option-injection-style values before the call ever reaches main/.

describe('spaceIdArg', () => {
  it('accepts a plain identifier', () => {
    expect(spaceIdArg.safeParse('kit-legal_space.1').success).toBe(true)
  })

  it('rejects traversal, separators, "." / "..", and a leading "-"', () => {
    for (const bad of ['..', '.', '../other', 'a/b', 'a\\b', '-flag', '', 'has space', 'tab\tname']) {
      expect(spaceIdArg.safeParse(bad).success).toBe(false)
    }
  })

  it('rejects an over-long id', () => {
    expect(spaceIdArg.safeParse('a'.repeat(256)).success).toBe(false)
  })
})

describe('memoryFileNameArg', () => {
  it('accepts a plain .md file name', () => {
    expect(memoryFileNameArg.safeParse('MEMORY.md').success).toBe(true)
    expect(memoryFileNameArg.safeParse('a_note-1.md').success).toBe(true)
  })

  it('rejects names without .md, with separators, traversal, or a leading "-"', () => {
    for (const bad of ['bad', 'note.txt', '../escape.md', 'a/b.md', 'a\\b.md', '-flag.md', 'foo..md ', '..md', '']) {
      expect(memoryFileNameArg.safeParse(bad).success).toBe(false)
    }
  })

  it('rejects an over-long name', () => {
    expect(memoryFileNameArg.safeParse(`${'a'.repeat(255)}.md`).success).toBe(false)
  })
})

interface RegistrationCall {
  name: string
  config: { outputSchema?: z.ZodType }
  handler: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

const registerTools = (claudeDesktopRootPath: string): RegistrationCall[] => {
  const calls: RegistrationCall[] = []
  const server = {
    registerTool: (name: string, config: RegistrationCall['config'], handler: RegistrationCall['handler']) => {
      calls.push({ name, config, handler })
    }
  } as unknown as McpServer
  const cfg = {
    claudeDesktopRootPath,
    housekeepingPath: path.join(claudeDesktopRootPath, 'housekeeping')
  } as Config
  registerClaudeDesktopTools(server, cfg)
  return calls
}

describe('Claude Desktop result contracts', () => {
  it('registers a strict output schema for every tool', () => {
    const calls = registerTools('/tmp/claude-desktop-schema-test')

    expect(calls).toHaveLength(20)
    for (const call of calls) expect(call.config.outputSchema).toBeDefined()

    const workspaces = calls.find((call) => call.name === 'claude_desktop_workspaces_list')?.config.outputSchema
    const valid = {
      root_path: '/tmp/root',
      workspace_count: 1,
      workspaces: [{ id: 'account/workspace', root: '/tmp/w' }]
    }
    expect(workspaces?.safeParse(valid).success).toBe(true)
    expect(workspaces?.safeParse({ ...valid, unexpected: true }).success).toBe(false)
    expect(
      workspaces?.safeParse({ ...valid, workspaces: [{ ...valid.workspaces[0], unexpected: true }] }).success
    ).toBe(false)
  })

  it('returns schema-valid structured content from a successful handler', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-desktop-tools-'))
    try {
      const workspaceRoot = path.join(root, 'account', 'workspace')
      await fs.mkdir(workspaceRoot, { recursive: true })
      await fs.writeFile(path.join(workspaceRoot, '.claude.json'), '{}\n')
      const calls = registerTools(root)
      const registration = calls.find((call) => call.name === 'claude_desktop_workspaces_list')

      const result = await registration?.handler({})

      expect(result).toMatchObject({
        structuredContent: {
          root_path: root,
          workspace_count: 1,
          workspaces: [{ id: 'account/workspace', root: workspaceRoot }]
        }
      })
      expect(registration?.config.outputSchema?.safeParse(result?.structuredContent).success).toBe(true)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('preserves the MCP error envelope when a handler cannot resolve its workspace', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-desktop-tools-'))
    try {
      const calls = registerTools(root)
      const registration = calls.find((call) => call.name === 'claude_desktop_memory_read')

      const result = await registration?.handler({ space_id: 'space', name: 'note.md', workspace: 'missing' })

      expect(result).toEqual({
        isError: true,
        content: [
          {
            type: 'text',
            text: 'Error reading Claude Desktop memory file: Unknown workspace "missing". Available: (none)'
          }
        ]
      })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
