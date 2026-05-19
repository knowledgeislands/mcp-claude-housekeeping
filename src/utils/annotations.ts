/**
 * MCP tool annotations shared across tool groups.
 *
 * Naming convention: unsuffixed presets are closed-world (the tool acts only on
 * local state); `_REMOTE` suffix marks open-world (calls external APIs).
 *
 * Underlying MCP hints:
 *   readOnlyHint    — tool does NOT modify state
 *   destructiveHint — tool deletes/destroys state
 *   idempotentHint  — same input → same end state
 *   openWorldHint   — interacts with services outside the local environment
 *
 * Canonical preset set across the sibling MCPs (each repo exports the subset
 * its tools need):
 *   READ_ONLY              — closed-world read
 *   READ_ONLY_REMOTE       — open-world read
 *   ADDITIVE               — closed-world create (non-idempotent)
 *   ADDITIVE_REMOTE        — open-world create (non-idempotent)
 *   STATE_TOGGLE           — closed-world idempotent state flip
 *   STATE_TOGGLE_REMOTE    — open-world idempotent state flip
 *   DESTRUCTIVE            — closed-world destructive (idempotent end state)
 *   DESTRUCTIVE_REMOTE     — open-world destructive (idempotent end state)
 *   DESTRUCTIVE_ONESHOT    — closed-world destructive, NON-idempotent
 *                            (effect depends on current state — e.g. prune)
 */
export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const
export const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const
export const DESTRUCTIVE_ONESHOT = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const
