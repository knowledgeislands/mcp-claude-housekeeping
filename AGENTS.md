# AGENTS.md

## Runtime

Use Bun (>= 1.3) for install, development, and tests; use `bun run test`, never `bun test`. The published `dist/` MCP runs under Node (>= 22). Keep `NODE_ENV=development` confined to dev and inspector commands; production configuration comes from the host environment.

## MCP architecture

Keep configuration injectable: no module-level environment reads or config singleton. The server loads config once and passes it to registration functions. Tool modules validate and adapt MCP envelopes only; implementation belongs in `src/main/` and receives the smallest config primitive it needs as its first argument. Keep reusable, config-agnostic helpers in `src/utils/`.

Use snake_case `<app>_<resource>_<action>` tool names. Register through the annotation-driven access gate; every tool must use an explicit annotation preset. The access level controls visibility and never substitutes for effect-level safeguards.

## Safety and tests

Constrain every filesystem path to its configured root, including symlink-aware containment. Validate user-controlled identifiers with tight schemas. Invoke subprocesses through argv APIs, never shell strings. Mutating or non-idempotent tools require an explicit, default-true `dry_run` where applicable. Keep Zod schemas strict. Tests use isolated fixtures and never exercise real user roots.

Keep user-facing installation, configuration, and tool reference in README; record only runtime-specific deltas in CLAUDE.md.
