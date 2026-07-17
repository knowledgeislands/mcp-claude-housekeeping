# ki-engineering

Use to audit our engineering standards, conform or scaffold a repo's toolchain, or check audit wiring, tsconfig, or Biome consistency.

**Invoke:** `ki-engineering audit <repo> | conform <repo> | help | educate <repo> | refresh`

**Modes:**

- `AUDIT` — check a repo's common toolchain
- `CONFORM` — bring a repo's toolchain into line
- `EDUCATE` — scaffold a new TS/Bun repo's toolchain
- `HELP` — explain this skill and stop; the default when no mode is given (then routes, if interactive)
- `REFRESH` — re-anchor the toolchain pins to their sources

**See also:** For GitHub settings, security, and the `.ki-config.toml` contract use `ki-repo`; for Markdown/TOML style use `ki-authoring`; for MCP server code use `ki-mcp`.
