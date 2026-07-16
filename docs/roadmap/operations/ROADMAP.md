# Operations roadmap

## Blocking

Actively broken, or blocking the `Next` horizon: takes priority over everything else and must clear before `Next` work proceeds. Empty means nothing is on fire.

## Next

Scoped and ready to start — the immediate queue, picked up before anything in **Soon** or **Future**.

### Make orphan detection path-safe

Resolve the true project path from the `cwd` field in session `.jsonl` files rather than decoding the ambiguous Claude project-directory slug. If no readable `cwd` is available, treat the project as unverifiable and skip it; never delete it.

### Add destructive cleanup tools for Claude Desktop sessions and outputs

Add dry-run-first, access-gated prune tools for the existing Claude Desktop obsolete-session and obsolete-output audits, with standard destructive annotations.

## Soon

Understood and roughly scoped but not yet started — worth doing once the **Next** queue clears, ahead of anything still speculative.

## Waiting for

Worth doing, but presently blocked on an external dependency or decision. Revisit when its named condition changes rather than treating it as dormant local work.

## Future

Speculative or not yet scoped — items marked _(candidate)_ need a scoping pass (or a decision to drop them) before they're actionable.
