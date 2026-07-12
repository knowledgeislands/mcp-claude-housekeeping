# ki-repo

Codify, audit, and apply the Knowledge Islands repo standard to any Knowledge Islands–compliant git repo — one that carries a `.ki-config.toml` — not only the `knowledgeislands` org, which is its reference set.

**Invoke:** `ki-repo audit | conform <repo> | help | init <repo> | refresh`

**Modes:**

- `AUDIT` — check a repo against the standard
- `CONFORM` — bring a repo (or the org) into line
- `HELP` — explain this skill and stop; the default when no mode is given (then routes, if interactive)
- `INIT` — make a repo Knowledge Islands–compliant
- `REFRESH` — re-anchor the standard to GitHub's surface

**See also:** `ki-authoring` (Markdown/TOML style), `ki-engineering` (toolchain), `ki-harness` (bundle layout).
