# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file is maintained automatically by
[release-please](https://github.com/googleapis/release-please) — entries below
are generated from [Conventional Commits](https://www.conventionalcommits.org/)
on `main`. Edit only when manually overriding release-please output.

## [1.0.0] - 2026-05-09

### Added

- Initial release.
- 12 read-only audit tools (`sessions_audit_*`): storage summary, obsolete sessions, artifact health, obsolete outputs, backup summary, memory spaces summary, plugins inventory, project cache status, debug info, memory list/read, report list.
- 6 destructive cleaner tools (`sessions_cleaner_*`): prune unstarred artifacts, clear/write reports, write/delete memory files, write memory index.
- Path-safe operations confined to `ROOT_PATH` (and `spaces/<id>/memory/` for memory tools).
- Audit reports written to a configurable `HOUSEKEEPING_PATH`.
