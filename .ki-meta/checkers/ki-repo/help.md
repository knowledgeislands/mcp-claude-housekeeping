# ki-repo

Codify, audit, and apply the Knowledge Islands repo standard to any KI-compliant git repo carrying `.ki-config.toml`, not only the `knowledgeislands` reference org.

**Invoke:** `ki-repo audit | conform <repo> | educate <repo> | help | refresh`

**Modes:**

- `AUDIT` — check a repo against the standard
- `CONFORM` — bring a repo (or the org) into line
- `EDUCATE` — make a repo Knowledge Islands–compliant
- `HELP` — explain this skill and stop; the default when no mode is given (then routes, if interactive)
- `REFRESH` — re-anchor the standard to GitHub's surface

**See also:** `ki-authoring` (Markdown/TOML), `ki-engineering` (toolchain), `ki-harness` (bundle layout).
