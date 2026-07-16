# ki-authoring

The foundational authoring and formatting conventions shared across every Knowledge Islands skill, repo, and base — the common style layer the others build on rather than restate.

**Invoke:** `ki-authoring audit <path> | conform <path> | help | init <target> | refresh`

**Modes:**

- `AUDIT` — check a document against house style
- `CONFORM` — bring a document into house style
- `HELP` — explain this skill and stop; the default when no mode is given (then routes, if interactive)
- `INIT` — vendor the style gate, scaffold the owned files
- `REFRESH` — re-anchor the conventions to their sources

**See also:** For KB note-writing use the `ki-kb` skill; for a repo's configuration and the `.ki-config.toml` contract use `ki-repo`; to judge a SKILL.md use `ki-skills`; for the build/lint/test toolchain use `ki-engineering`.
