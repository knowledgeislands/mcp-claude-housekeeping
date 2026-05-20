# Contributing

Thanks for your interest. This file covers the dev loop, conventions, and what to check before you open a PR.

## Setup

You'll need [Bun](https://bun.sh) 1.3+ for the dev loop, and Node.js 22+ to run the compiled `dist/` output the published package ships.

```bash
git clone https://github.com/knowledgeislands/mcp-claude-housekeeping.git
cd mcp-claude-housekeeping
bun install
```

`bun install` triggers `prepare` which configures the husky pre-commit hook — so every commit will auto-run `lint-staged` and format your changes.

## Dev loop

```bash
bun run server:mcp:dev      # bun --watch — runs the server from source
bun run server:mcp:inspect  # MCP Inspector against the TS source
bun run lint:types          # tsc --noEmit
bun run test                # vitest (use `bun run test`, not `bun test`)
bun run test:watch          # vitest in watch mode
bun run test:coverage       # vitest with v8 coverage report
bun run lint:check          # Biome lint + format check
bun run lint:fix            # Biome auto-fix
bun run lint:md             # prettier + markdownlint for *.md
```

## Conventions

### Code

- **TypeScript ES modules** — `"type": "module"`, internal imports use `.js` extensions (e.g. `from './audit.js'`) so `tsc` emits valid JS.
- **Arrow functions** for top-level declarations (`export const foo = () => …`).
- **Strict path safety**: any tool input that touches the filesystem must go through `resolveWithinRoot(<root>, …)` from `src/utils/utils.ts` (where `<root>` is the relevant configured root — `CLAUDE_DESKTOP_ROOT_PATH`, `CLAUDE_CODE_ROOT_PATH`, or `VSCODE_WORKSPACE_STORAGE_ROOT_PATH`). Inputs that resolve outside that root throw `Path escapes root`.
- **Errors**: tools return MCP errors via `errorResult(...)`; structured results via `jsonResult(...)`.
- **Annotations**: be honest with `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` on every tool registration.

### Commits

This repo uses [Conventional Commits](https://www.conventionalcommits.org/) so version bumps and `CHANGELOG.md` entries are easy to derive when releasing by hand. There is no auto-release pipeline.

| Type        | What it means           | Bumps |
| ----------- | ----------------------- | ----- |
| `feat:`     | new feature             | minor |
| `fix:`      | bug fix                 | patch |
| `perf:`     | performance improvement | patch |
| `docs:`     | documentation only      | patch |
| `deps:`     | dependency change       | patch |
| `refactor:` | internal restructuring  | none  |
| `test:`     | test-only changes       | none  |
| `chore:`    | tooling, config         | none  |
| `build:`    | build pipeline          | none  |
| `ci:`       | CI changes              | none  |

Add `!` for breaking changes (`feat!:` / `fix!:`) — bumps major.

### Testing

- New code should ship with tests. Vitest is configured with V8 coverage and has thresholds in `vitest.config.ts` — if your change drops coverage below the threshold, CI fails.
- File-level isolation: each test file defines its own fixture root under `os.tmpdir()` so test data never touches the real Claude/VSCode locations. Tests should clean up after themselves with `beforeEach`/`afterEach`.

## Before opening a PR

- [ ] `bun run lint:check` passes
- [ ] `bun run lint:types` passes
- [ ] `bun run test:coverage` passes (no threshold failures)
- [ ] Commit messages follow Conventional Commits
- [ ] If you added/removed/renamed a tool, update `README.md` and `CLAUDE.md`

CI runs all of the above on every PR.
