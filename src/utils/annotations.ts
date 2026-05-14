/**
 * MCP tool annotations shared across tool groups.
 *
 * - READ_ONLY            — pure read tools that can be called freely
 * - DESTRUCTIVE          — writes/deletes; idempotent (same input → same end state)
 * - DESTRUCTIVE_ONESHOT  — destructive AND non-idempotent (e.g. prune that depends on current contents)
 */
export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const
export const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const
export const DESTRUCTIVE_ONESHOT = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const
