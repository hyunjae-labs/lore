---
name: lore-index
description: Manage lore indexing and project exclusions. MUST invoke this skill before calling mcp__lore__index or mcp__lore__manage_projects. Guides you to explain options to the user and confirm their intent before acting. Trigger when the user asks to index sessions, exclude or include projects, rebuild the index, check indexing status, or set up lore for the first time. Trigger on "index", "reindex", "rebuild index", "exclude project", "include project", "indexing status", "set up lore", or any request related to managing what gets indexed and how. NOT for searching past conversations (use lore-search) or general lore questions (use lore-help).
---

# Lore Indexing & Project Management

Lore uses an **opt-out (blacklist) model**: ALL projects are indexed by default. Users can exclude specific projects they don't want indexed.

**Two source agents are indexed in the same DB:**
- **Claude Code** sessions from `~/.claude/projects/` (override with `CLAUDE_PROJECTS_DIR`)
- **OpenAI Codex CLI** sessions from `~/.codex/sessions/` (override with `CODEX_SESSIONS_DIR`)

Codex sessions are grouped by `cwd` (read from each file's `session_meta` line) and surfaced as virtual projects with a `codex-` `dirName` prefix. The same project working directory may appear twice in the list — once as a Claude Code project (no prefix) and once as a Codex project (`codex-` prefix). They are independent rows; excluding one does not affect the other.

## First-Time Setup

If the user has never used lore indexing before, or asks to index without context, walk them through:

1. **Check current state first** -- call `status` to see if anything is indexed, then `manage_projects(action: "list")` to see available projects.
2. **Explain what they're looking at:**
   - How many projects exist, how many are excluded. By default, all are indexed.
3. **Ask what they want:**
   - Index everything (just run `index()`)? Exclude certain projects first?
4. **Execute based on their answer.**

Do not skip the explanation step. The user needs to understand what's happening.

## Index Options

| User intent | Tool call | Existing data |
|-------------|-----------|---------------|
| Index everything (default) | `index()` -- incremental index for all non-excluded projects | Preserved |
| Index a specific project | `index(project: "/full/path/to/project")` -- indexes that project (even if excluded) | Preserved |
| Start fresh | `index(mode: "rebuild")` -- **deletes ALL indexed data** and re-indexes from scratch | **Deleted** |
| Stop running index | `index(mode: "cancel")` | -- |

**Important:** Always use full project paths, not fuzzy names. Never summarize or drop rows from tool results when presenting to the user.

## Project Management (Opt-Out)

| User intent | Tool call |
|-------------|-----------|
| See available projects | `manage_projects(action: "list")` |
| Stop indexing a project | `manage_projects(action: "exclude", projects: ["/full/path"])` -- adds to blacklist + cleans DB data |
| Undo an exclusion | `manage_projects(action: "include", projects: ["/full/path"])` -- removes from blacklist, next index picks it up |

When the user asks to exclude or include, confirm which project they mean. If ambiguous, show the list first.

## Monitoring Progress

After starting indexing, check progress with `status`. It shows:
- Running/idle state
- Sessions indexed / total
- Current project and chunk embedding progress
- ETA

Indexing runs in the background -- the user can search while it's in progress.

## Automatic Behavior

These happen without user intervention:
- **SessionEnd hook:** Every session end triggers a background incremental index for all non-excluded projects, keeping the index fresh.
- **Orphan cleanup:** Deleted JSONL files are automatically pruned from DB during any index run.
- **Stale exclusion cleanup:** Excluded entries for vanished project directories are automatically cleaned up.
- **Empty session handling:** Sessions with no searchable content are marked as processed and hidden.

## Rebuild: When and Why

Rebuild **deletes all indexed data** and re-indexes from scratch. Suggest it only when:
- Search results seem corrupted or inconsistent
- The user explicitly asks to start fresh
- Major version upgrade that changes indexing format

Always explain that rebuild can take several minutes for large projects.
