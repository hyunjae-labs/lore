---
name: lore-help
description: Comprehensive guide to all lore tools and capabilities. Invoke this skill when the user asks what lore is, how to use it, what tools are available, or needs general guidance. Trigger on "what is lore", "how does lore work", "lore help", "lore guide", "what can lore do", "show me lore tools", or any question about lore's capabilities and usage. NOT for actually searching (use lore-search) or indexing (use lore-index).
---

# Lore -- Complete Reference

Lore is a semantic search system for Claude Code conversation history. It indexes past sessions into a searchable database and provides tools to find, browse, and expand conversation context.

Lore uses an **opt-out (blacklist) model**: ALL projects are indexed by default. Users can exclude specific projects they don't want indexed.

## Tools Overview

| Tool | Purpose | When to use |
|------|---------|-------------|
| `search` | Hybrid BM25 + semantic search across indexed sessions | Finding past conversations by topic, keyword, or context |
| `get_context` | Expand a search result to see surrounding conversation | When a result is truncated and you need more context |
| `index` | Index sessions into the searchable database | Setting up, updating, or rebuilding the index |
| `list_sessions` | Browse indexed sessions with metadata | Viewing session history by project, date, or recency |
| `manage_projects` | Exclude/include projects from indexing | Controlling which projects are indexed |
| `status` | Check indexing health and progress | Monitoring a running index or checking DB state |

## Search (`search`)

Finds past conversations using hybrid keyword + semantic matching.

**Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `query` | string (required) | Search query -- combine keyword anchors with semantic phrases |
| `project` | string | Filter by project path (e.g., `/Users/.../my-project`) |
| `session` | string | Filter by session UUID |
| `branch` | string | Filter by git branch |
| `before` | string | Only results before this date (YYYY-MM-DD) |
| `after` | string | Only results after this date (YYYY-MM-DD) |
| `limit` | number | Max results (default 10, max 50) |

**Returns:** Ranked chunks with score, content, session metadata, and `has_more_before`/`has_more_after` flags.

## Get Context (`get_context`)

Expands a search result to show surrounding conversation turns.

| Param | Type | Description |
|-------|------|-------------|
| `chunk_id` | number (required) | The chunk ID from a search result |
| `direction` | "before" / "after" / "both" | Which direction to expand (default: both) |
| `count` | number | How many additional chunks to retrieve |

## Index (`index`)

Indexes Claude Code session files into the searchable database. All non-excluded projects are indexed by default.

| Param | Type | Description | Existing data |
|-------|------|-------------|---------------|
| *(none)* | -- | Incremental index for all non-excluded projects | Preserved |
| `project` | string | Index a specific project (pass full path). Indexes even if excluded. | Preserved |
| `mode` | "rebuild" / "cancel" | Rebuild: **deletes all indexed data** and re-indexes from scratch. Cancel: stop running index | **Deleted** (rebuild) |

**Automatic behaviors:**
- Orphan cleanup: sessions whose JSONL files were deleted are pruned from DB
- Stale exclusion cleanup: excluded entries for vanished directories are cleaned up
- Empty sessions: sessions with no searchable content are marked processed and hidden
- Background execution: index runs in background, search works while indexing
- SessionEnd hook: automatically triggers incremental indexing when a Claude Code session ends

## List Sessions (`list_sessions`)

Browse indexed sessions with metadata.

| Param | Type | Description |
|-------|------|-------------|
| `project` | string | Filter by project |
| `limit` | number | Max sessions to return (default 20, max 100) |
| `sort` | "recent" / "oldest" | Sort order (default: recent) |

## Manage Projects (`manage_projects`)

Control which projects are indexed using an opt-out model. All projects are indexed by default.

| Action | Description |
|--------|-------------|
| `list` | Show all projects on disk with `excluded: true/false` |
| `exclude` | Stop indexing a project + delete all its indexed data from DB |
| `include` | Undo an exclusion -- next index run will pick it up |

**Path-based matching:** Always pass the actual project path (e.g., `/Users/hyunjaelim/01_projects/lore`). Fuzzy names are not supported.

## Status (`status`)

Shows indexing health: running/idle state, progress, session counts, DB size, and ETA for running indexes.

## Common Workflows

**First time setup:**
1. `manage_projects(action: "list")` -- see available projects (all indexed by default)
2. `index()` -- index everything
3. `status` -- monitor progress

**Daily use:**
- Just `search` -- SessionEnd hook keeps the index fresh automatically
- `get_context` to expand interesting results

**Exclude a noisy project:**
- `manage_projects(action: "exclude", projects: ["/path/to/noisy-project"])` -- stops indexing + cleans data

**Undo an exclusion:**
- `manage_projects(action: "include", projects: ["/path"])` -- next index run picks it up

**Clean up:**
- `index(mode: "rebuild")` -- fresh start (**deletes all data**)

## Related Skills

- **lore-search** -- Detailed guide for formulating effective search queries
- **lore-index** -- Step-by-step guide for indexing and project management with user interaction
