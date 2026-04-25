# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.1] - 2026-04-25

### Added
- **OpenAI Codex CLI session indexing.** Sessions stored under `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` are now indexed alongside Claude Code sessions in the same DB.
  - New `extractCodexCwd()` reads each rollout file's `session_meta` line to extract the working directory. Uses adaptive chunked read (16KB chunks, 1MB hard limit) so the parser handles real-world `instructions` fields >25KB.
  - New `scanCodexProjectsAndSessions()` groups rollout files by `cwd` into virtual projects. Each virtual project's `dirName` is `codex-` + the path-encoded `cwd` (e.g., `codex--Users-foo-01-projects-my-app`).
  - New `parseCodexLine()` handles Codex JSONL format: `response_item` events with `payload.role` of `user`/`assistant` and `input_text`/`output_text` content blocks.
- `CODEX_SESSIONS_DIR` env var to override the Codex sessions location (default `~/.codex/sessions`).
- `SessionInfo.format?: "claude" | "codex"` field — the indexer dispatches the correct parser per session.
- `manage_projects(action: "list")` now includes Codex virtual projects with their session counts and current exclusion state.

### Changed
- `runIndexInBackground()` now uses `SessionInfo[]` for its `sessions` parameter (was a manual inline type missing the `format` field).
- `pruneOrphanSessions()` skips Codex virtual projects, since they have no real on-disk directory.
- README, lore-search SKILL, and lore-index SKILL updated to reflect dual-agent support.

### Notes
- Same `cwd` can appear twice in the project list — once as a Claude Code project (no prefix) and once as a Codex project (`codex-` prefix). They are independent rows; exclude/include affects only the chosen one.
- To search across both for the same `cwd`, query both `dirName`s and merge results in the caller.

## [0.2.40] - 2026-04-22

Internal version bump.

## [0.2.35] - 2026-04-XX

Cleaned stale references from the old opt-in project management model.

## [0.2.34] - 2026-04-XX

Switched to opt-out indexing model. Fixed hooks duplication. Documentation updates.
