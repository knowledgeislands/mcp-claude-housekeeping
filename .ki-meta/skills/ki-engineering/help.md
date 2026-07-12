# ki-engineering

Use to audit our engineering standards, conform or scaffold a repo's toolchain, or check script-family / tsconfig / biome consistency.

**Invoke:** `ki-engineering audit <repo> | conform <repo> | help | init <repo> | refresh`

**Modes:**

- `AUDIT` — check a repo's common toolchain
- `CONFORM` — bring a repo's toolchain into line
- `HELP` — explain this skill and stop; the default when no mode is given (then routes, if interactive)
- `INIT` — scaffold a new TS/Bun repo's toolchain
- `REFRESH` — re-anchor the toolchain pins to their sources

**See also:** For GitHub settings, security, and the `.ki-config.toml` contract use `ki-repo`; for Markdown/TOML style use `ki-authoring`; for MCP server code use `ki-mcp`.
