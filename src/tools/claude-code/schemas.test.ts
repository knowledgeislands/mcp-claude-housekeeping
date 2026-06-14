import { describe, expect, it } from 'vitest'
import { memoryFileNameArg } from './index.js'

// Defense-in-depth schema for a memory file name that becomes a path segment
// under ~/.claude/projects/<project>/memory/<name>. Mirrors projectArg.

describe('claude-code memoryFileNameArg', () => {
  it('accepts a plain .md file name', () => {
    expect(memoryFileNameArg.safeParse('MEMORY.md').success).toBe(true)
    expect(memoryFileNameArg.safeParse('session-digest_1.md').success).toBe(true)
  })

  it('rejects names without .md, with separators, traversal, or a leading "-"', () => {
    for (const bad of ['bad', 'note.txt', '../escape.md', 'a/b.md', 'a\\b.md', '-flag.md', '..md', '']) {
      expect(memoryFileNameArg.safeParse(bad).success).toBe(false)
    }
  })

  it('rejects an over-long name', () => {
    expect(memoryFileNameArg.safeParse(`${'a'.repeat(255)}.md`).success).toBe(false)
  })
})
