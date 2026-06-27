// Generated on 2026-06-27T20:39:34.296Z by @knowledgeislands/mcp-claude-housekeeping@1.0.0
// Server: kit-mcp-claude-housekeeping
// Source: /Users/krisbrown/.mcporter/mcporter.json
// Transport: STDIO /Users/krisbrown/.local/share/mise/installs/node/lts/bin/node /Users/krisbrown/kis/knowledgeislands/mcp-claude-housekeeping/dist/mcp-server/index.js

import type { CallResult } from 'mcporter'

export interface KitMcpClaudeHousekeepingTools {
  /**
   * Audit check 1. For each workspace, count local_* session dirs and JSON files, compute total disk
   * usage and total session-JSON size, find the 5 largest session dirs, and the date of the oldest and
   * newest session JSON. Flag if total size exceeds flag_size_gb (default 2 GB) or session count exceeds
   * flag_session_count (default 1000).
   *
   * @param flag_size_gb? Threshold in GB for flagging total root size.
   * @param flag_session_count? Threshold for flagging session count.
   * @param workspace? Filter to a single workspace by id ("<account>/<workspace>"); omit to run across
   *                   all.
   */
  claude_desktop_storage_summary(flag_size_gb?: number, flag_session_count?: number, workspace?: string): Promise<CallResult>

  /**
   * Audit check 2. Identify sessions whose .json mtime is older than older_than_days (default 30), with
   * their dir+json sizes summed. Returns the 10 oldest by date plus totals per workspace. Flags if
   * obsolete count exceeds flag_count (default 50) or combined size exceeds flag_size_mb (default 500).
   *
   * @param workspace? Filter to a single workspace by id ("<account>/<workspace>"); omit to run across
   *                   all.
   */
  claude_desktop_sessions_obsolete(
    older_than_days?: number,
    flag_count?: number,
    flag_size_mb?: number,
    workspace?: string
  ): Promise<CallResult>

  /**
   * Audit check 3. Read each workspace's artifacts.json and report each artifact's name, starred status,
   * version count, last-updated date and MCP tools used. Flag artifacts with >flag_versions versions
   * (default 20), not updated in >flag_stale_days days (default 30), or unstarred and not updated in
   * >flag_unstarred_idle_days days (default 14).
   *
   * @param workspace? Filter to a single workspace by id ("<account>/<workspace>"); omit to run across
   *                   all.
   */
  claude_desktop_artifacts_health(
    flag_versions?: number,
    flag_stale_days?: number,
    flag_unstarred_idle_days?: number,
    workspace?: string
  ): Promise<CallResult>

  /**
   * Audit check 5. For each local_* session dir in each workspace, list non-empty outputs/ or uploads/
   * subdirs with file names and sizes. Flag findings whose session is older than older_than_days
   * (default 14).
   *
   * @param workspace? Filter to a single workspace by id ("<account>/<workspace>"); omit to run across
   *                   all.
   */
  claude_desktop_outputs_obsolete(older_than_days?: number, workspace?: string): Promise<CallResult>

  /**
   * Audit check 6. Find all .claude.json.backup.* files in each workspace and its backups/ subdir, count
   * them, list dates, sum size. Flag if count exceeds flag_count (default 10) or total size exceeds
   * flag_size_mb (default 5).
   *
   * @param workspace? Filter to a single workspace by id ("<account>/<workspace>"); omit to run across
   *                   all.
   */
  claude_desktop_backups_summary(flag_count?: number, flag_size_mb?: number, workspace?: string): Promise<CallResult>

  /**
   * Audit check 7. List directories under each workspace's spaces/, count .md files in each space's
   * memory/ subdir, return the first 10 lines of MEMORY.md as the index hook. Flag empty spaces
   * (memory_empty / completely_empty) and bloated ones (memory_files > flag_files, default 20).
   *
   * @param workspace? Filter to a single workspace by id ("<account>/<workspace>"); omit to run across
   *                   all.
   */
  claude_desktop_memory_spaces_summary(flag_files?: number, workspace?: string): Promise<CallResult>

  /**
   * Audit check 8. List installed knowledge-work plugins from each workspace's
   * cowork_plugins/installed_plugins.json (with version, installedAt, lastUpdated, age) and
   * rpm/manifest.json plugins (with name, updatedAt). Flags any knowledge-work install whose age is
   * significantly older than the median (>30d above median).
   *
   * @param workspace? Filter to a single workspace by id ("<account>/<workspace>"); omit to run across
   *                   all.
   */
  claude_desktop_plugins_inventory(workspace?: string): Promise<CallResult>

  /**
   * Audit check 9. List entries in each workspace's .project-cache/, read each metadata.json (name,
   * synced_at). Flag any not synced in >stale_days days (default 14).
   *
   * @param workspace? Filter to a single workspace by id ("<account>/<workspace>"); omit to run across
   *                   all.
   */
  claude_desktop_project_cache_status(stale_days?: number, workspace?: string): Promise<CallResult>

  /**
   * Audit check 10. Report each workspace's debug/ size, entry count and oldest-entry age. Flag if size
   * exceeds flag_size_mb (default 10) or oldest entry is older than flag_age_days (default 7).
   *
   * @param workspace? Filter to a single workspace by id ("<account>/<workspace>"); omit to run across
   *                   all.
   */
  claude_desktop_debug_info(flag_size_mb?: number, flag_age_days?: number, workspace?: string): Promise<CallResult>

  /**
   * List the workspace ids ("<account>/<workspace>") and absolute roots discovered under rootPath. Use
   * the ids when targeting a specific workspace via the optional "workspace" arg on other tools.
   */
  claude_desktop_workspaces_list(): Promise<CallResult>

  /**
   * Phase 1 of memory consolidation. List .md files in <workspace>/spaces/<space_id>/memory/ with size
   * and modified date, plus the full content of MEMORY.md (the index) if present. The "workspace" arg is
   * required when more than one workspace is configured.
   *
   * @param space_id Space directory name (under spaces/).
   * @param workspace? Filter to a single workspace by id ("<account>/<workspace>"); omit to run across
   *                   all.
   */
  claude_desktop_memory_list(space_id: string, workspace?: string): Promise<CallResult>

  /**
   * Read the contents of a single memory file at <workspace>/spaces/<space_id>/memory/<name>. Use this
   * to inspect a memory before deciding whether to keep, merge or retire it. The "workspace" arg is
   * required when more than one workspace is configured.
   *
   * @param space_id Space directory name (under spaces/).
   * @param workspace? Filter to a single workspace by id ("<account>/<workspace>"); omit to run across
   *                   all.
   */
  claude_desktop_memory_read(space_id: string, name: string, workspace?: string): Promise<CallResult>

  /**
   * List cowork-audit-*.md files currently in MCP_CLAUDE_HOUSEKEEPING_PATH with size and modified date,
   * sorted newest first. Useful for confirming yesterday's report exists before cleaning, or showing a
   * history.
   */
  claude_desktop_reports_list(): Promise<CallResult>

  /**
   * List every project under ~/.claude/projects/ with session-file count, on-disk size, whether a
   * memory/ subdir exists, and a best-effort decode of the encoded directory name back to the original
   * filesystem path (with source_exists indicating whether that decoded path still resolves on disk).
   * Sorted by bytes descending.
   */
  claude_code_projects_list(): Promise<object>

  /**
   * Aggregate stats across ~/.claude: total bytes, projects bytes, project count, session count,
   * orphan-project count (projects whose decoded source path no longer exists). Flags large total size,
   * high session count, or many orphans.
   */
  claude_code_storage_summary(flag_size_gb?: number, flag_session_count?: number, flag_orphan_count?: number): Promise<object>

  /**
   * Find session .jsonl files (and any matching <uuid>/ sidecar dirs) older than older_than_days
   * (default 30) across all projects (or one project if "project" is set). Returns the 10 oldest plus
   * totals; flags counts or sizes that exceed thresholds.
   *
   * @param project? Project directory name under ~/.claude/projects/ (the encoded path).
   */
  claude_code_sessions_obsolete(older_than_days?: number, flag_count?: number, flag_size_mb?: number, project?: string): Promise<object>

  /**
   * Report ~/.claude top-level state: history.jsonl size+mtime+line count if present, settings.json
   * existence and cleanupPeriodDays, .last-cleanup contents, plus a sorted list of every top-level dir
   * with its bytes (so bloated subtrees like file-history/ or plugins/ are visible).
   */
  claude_code_global_status(): Promise<object>

  /**
   * Return the first or last N lines of a session JSONL at ~/.claude/projects/<project>/<session>. Use
   * tail=true to peek the most recent turns. Cap with max_lines to keep responses small — full files can
   * be megabytes.
   *
   * @param project Project directory name under ~/.claude/projects/ (the encoded path).
   * @param tail? If true, return the last N lines; if false, the first N.
   */
  claude_code_session_read(project: string, session: string, max_lines?: number, tail?: boolean): Promise<object>

  /**
   * List .md files in ~/.claude/projects/<project>/memory/ with size and modified date, plus the full
   * content of MEMORY.md if present.
   *
   * @param project Project directory name under ~/.claude/projects/ (the encoded path).
   */
  claude_code_memory_list(project: string): Promise<object>

  /**
   * Read the contents of a single memory file at ~/.claude/projects/<project>/memory/<name>.
   *
   * @param project Project directory name under ~/.claude/projects/ (the encoded path).
   */
  claude_code_memory_read(project: string, name: string): Promise<object>

  /**
   * List every workspaceStorage/<id>/chatSessions/ entry with the original workspace URI (from
   * workspace.json), session-file count, and size. Sorted by bytes descending.
   */
  vscode_workspaces_list(): Promise<object>

  /**
   * Aggregate totals across every workspaceStorage/<id>/chatSessions/: workspace count, session count,
   * total chat bytes. Flags large size or session counts.
   */
  vscode_storage_summary(flag_size_gb?: number, flag_session_count?: number): Promise<object>

  /**
   * Find chat session .json/.jsonl files older than older_than_days (default 30) across all
   * workspaceStorage entries (or one if "workspace" is set). Returns the 10 oldest plus totals.
   *
   * @param workspace? VSCode workspaceStorage subdir id (hex).
   */
  vscode_sessions_obsolete(older_than_days?: number, flag_count?: number, flag_size_mb?: number, workspace?: string): Promise<object>

  /**
   * Return the first or last N lines of a chat session at
   * workspaceStorage/<workspace>/chatSessions/<session>. Handles both .json (single document,
   * pretty-printed) and .jsonl (one record per line). Cap with max_lines.
   *
   * @param workspace VSCode workspaceStorage subdir id (hex).
   */
  vscode_session_read(workspace: string, session: string, max_lines?: number, tail?: boolean): Promise<object>
}
