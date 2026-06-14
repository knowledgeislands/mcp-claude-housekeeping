import { describe, expect, it } from 'vitest'
import { memoryFileNameArg, spaceIdArg } from './index.js'

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
