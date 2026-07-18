# Authoring audit rubric

The checkable criteria behind the [Markdown authoring](markdown-authoring.md) and [TOML formatting](toml-config.md) conventions. Each is **[M] mechanical** (this skill runs Prettier + markdownlint-cli2 directly; Biome owns TS/JSON; never hand-judge what a tool checks better) or **[J] judgment** (a reader assesses it). TOML has no formatter, so every TOML criterion is `[J]`.

## Markdown

- **MD-mech [M]** `ki:authoring:audit` passes: prose unwrapped (one paragraph per line — `proseWrap: "never"` joins any broken lines); bullet & quote characters, heading hierarchy, single H1, spacing, table alignment (`MD060`), resolved link fragments (`MD051`) and references (`MD052`), no bare URLs (`MD034`), and descriptive link text (`MD059` — rejects "click here" / "here" / "link"). Prettier + markdownlint run directly inside that audit. (markdown-authoring.md)
- **MD-table [J]** A table with rows that would exceed `printWidth` (140 chars) is reshaped: a descriptive matrix → subheadings or a bulleted definition list; genuinely tabular data with one long column → keep the table and move that column to footnotes below it (a one-char marker in the cell). (markdown-authoring.md)
- **MD-footnote [J]** Footnotes use the marker series `† ‡ § ¶ ‖` (then doubled), reset per table; a distinct second series `※ ❡ ¤ ¥` where one table needs two. Each footnote is a separate paragraph (blank line between each). (markdown-authoring.md)
- **MD-link [J]** Link text is genuinely descriptive — the words you'd skim for, beyond the non-descriptive blocklist `MD059` already rejects (MD-mech). Links are relative markdown, **never wikilinks** — but this is _scoped_: wikilinks are correct in KB note content and in agent system prompts (`ki-kb`, `ki-agents` LINK-2), forbidden only in house files (SKILL.md, repo docs), so applicability is the judgment. Use the angle-bracket form for paths with spaces. (markdown-authoring.md)
- **MD-cell-prose [J]** Tables avoid long descriptive prose in cells — that is the footnote's job. (markdown-authoring.md)

## TOML

- **TOML-keys [J]** Keys lowercase, `snake_case` for multi-word, named for the noun the value holds (`visibility`, not `repo_visibility_setting`). (toml-config.md)
- **TOML-values [J]** Strings double-quoted; short lists inline `["a", "b"]`. (toml-config.md)
- **TOML-tables [J]** One table per skill, named for the skill, with sub-tables nested under it. The `.ki-config.toml` _contract_ behind this is `ki-repo`'s; this rubric checks only that the TOML is written that way. (toml-config.md)
- **TOML-comments [J]** Non-obvious keys carry a `#` line above with their _why_. (toml-config.md)

## Owned files

- **OWNS [M]** The skill owns `.prettierrc.json`, `.editorconfig`, and `.markdownlint-cli2.jsonc` wholly (SHAPE-16 `owns:`): audit flags hash drift from the house template (WARN — conform corrects it unconditionally), conform scaffolds-if-missing and overwrites on drift. (owns:)

## Judgment / SYNC

- **SYNC [J]** the convention references, this rubric, and [`sources.md`](sources.md) agree; when a convention moves, all three move together (Mode REFRESH).
