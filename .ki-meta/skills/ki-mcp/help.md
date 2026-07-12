# ki-mcp

Codify and audit Knowledge Islands MCP servers against the canonical "workspace MCP" standard.

**Invoke:** `ki-mcp audit <repo> | conform <repo> | help | init <repo> | refresh`

**Modes:**

- `AUDIT`
- `CONFORM`
- `HELP` — explain this skill and stop; the default when no mode is given (then routes, if interactive)
- `INIT`
- `REFRESH`

**See also:** Use when scaffolding a new MCP server, bringing an existing one up to standard, or reviewing one for compliance: project layout, config injection (no module-level singleton), the `<app>_<resource>_<action>` tool-naming scheme, the annotation-driven access-level gate, audit logging, the security invariants, the common build/lint/test toolchain (now `ki-engineering`'s, which this builds on). Audits MCP **server code** — not a repo's GitHub configuration, nor a `SKILL.md`'s prose (for that, use `ki-skills`).
