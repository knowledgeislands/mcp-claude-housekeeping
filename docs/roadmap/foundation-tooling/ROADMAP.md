---
code: FND
---

# Foundation tooling roadmap

## Blocking

Actively broken, or blocking the `Next` horizon: takes priority over everything else and must clear before `Next` work proceeds. Empty means nothing is on fire.

## Next

Scoped and ready to start — the immediate queue, picked up before anything in **Soon** or **Future**.

## Soon

Understood and roughly scoped but not yet started — worth doing once the **Next** queue clears, ahead of anything still speculative.

### Close remaining coverage gap

Close the remaining coverage gap to satisfy the 100% Vitest threshold (currently 99.4% lines and 98.7% branches). Most work is defensive arms in [sessions.ts](../../../src/main/claude-desktop/sessions.ts) and [audit-log.ts](../../../src/utils/audit-log.ts): add tests or targeted `/* v8 ignore */` markers.

### Add wire-level smoke test

Add `bun run ki:test:smoke` to boot the built server and verify that the wire-level tool surface matches in-process registration, then run it in CI.

## Waiting for

Worth doing, but presently blocked on an external dependency or decision. Revisit when its named condition changes rather than treating it as dormant local work.

## Future

Speculative or not yet scoped — items marked _(candidate)_ need a scoping pass (or a decision to drop them) before they're actionable.
