# Publishing

This package is published to npm under the `@knowledgeislands` scope as `@knowledgeislands/mcp-claude-housekeeping`.

Releases are **automated via [release-please](https://github.com/googleapis/release-please)** and the `Release` GitHub Actions workflow (`.github/workflows/release.yml`). You should not need to run `npm publish` manually except for emergencies.

## How releases work

```text
Conventional Commits on main
  → release-please opens / updates a "Release PR"
  → merge the Release PR
  → release-please tags the commit (e.g. v1.2.0) and creates a GitHub Release
  → CI publishes to npm with provenance
```

That's it. As long as you commit with [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, etc. — see `CONTRIBUTING.md`), version bumps and changelog entries are derived automatically.

## One-time setup (per maintainer / org)

### 1. Create / sign in to an npm account

```bash
npm login
npm whoami
```

### 2. Make sure the `@knowledgeislands` org exists on npm

If it doesn't:

```bash
open https://www.npmjs.com/org/create
```

Public scoped packages don't require a paid plan.

### 3. Add an `NPM_TOKEN` secret to the GitHub repo

The release workflow needs an automation token to publish.

1. Generate one: <https://www.npmjs.com/settings/_/tokens> → "Generate New Token" → "Automation" type. Copy the value once shown.
2. Add it to the repo: `https://github.com/knowledgeislands/mcp-claude-housekeeping/settings/secrets/actions` → "New repository secret" → name `NPM_TOKEN`, paste the value.

### 4. Enable 2FA on your npm account

```bash
npm profile enable-2fa auth-and-writes
```

(Automation tokens bypass the OTP prompt for CI; your interactive logins still require it.)

## Per-release flow

1. Land your changes on `main` with Conventional Commits.
2. Wait for release-please to open (or update) a `chore: release X.Y.Z` PR.
3. Review the proposed `CHANGELOG.md` entries and version bump.
4. Merge the Release PR.
5. The Release workflow tags + publishes automatically. Verify on <https://www.npmjs.com/package/@knowledgeislands/mcp-claude-housekeeping>.

## Manual publishing (emergencies only)

If release-please is broken or you need a hotfix without going through `main`:

```bash
git status                            # clean tree
npm version patch                     # or minor/major — bumps + commits + tags
git push --follow-tags
npm publish --provenance --access public
```

`prepublishOnly` automatically runs `npm run build` first.

After a manual publish, sync `release-please-config.json` and `.release-please-manifest.json` so release-please picks up where you left off.

## Dry run

Inspect what will ship without publishing:

```bash
npm pack --dry-run
```

Cross-check against `files` in `package.json` (currently `["dist"]`).

## What gets published

The `files` field is the allowlist. npm always also includes `package.json`, `README.md`, `LICENSE`, and any `bin` executables.

Excluded automatically: source under `src/`, tests, configs, `node_modules/`, `.tsbuildinfo`, coverage output, etc.

## Unpublishing

npm only allows unpublish within 72 hours and only when nothing depends on the version. Generally prefer **deprecation**:

```bash
npm deprecate @knowledgeislands/mcp-claude-housekeeping@1.2.3 "use 1.2.4 — fixes <issue>"
```

For real removal within 72 hours:

```bash
npm unpublish @knowledgeislands/mcp-claude-housekeeping@1.2.3
```
