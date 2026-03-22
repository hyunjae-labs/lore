---
name: lore-index
description: Manage lore indexing and project registration. MUST invoke this skill before calling mcp__lore__index or mcp__lore__manage_projects. Guides you to explain options to the user and confirm their intent before acting. Trigger when the user asks to index sessions, add or remove projects, rebuild the index, check indexing status, or set up lore for the first time. Trigger on "index", "reindex", "rebuild index", "add project", "remove project", "indexing status", "set up lore", or any request related to managing what gets indexed and how. NOT for searching past conversations (use lore-search) or general lore questions (use lore-help).
---

# Lore Indexing & Project Management

Lore indexes Claude Code conversation sessions (JSONL files) into a searchable database. Before doing anything, understand what the user wants and explain their options.

## First-Time Setup

If the user has never used lore indexing before, or asks to index without context, walk them through:

1. **Check current state first** — call `status` to see if anything is indexed, then `manage_projects(action: "list")` to see available projects.
2. **Explain what they're looking at:**
   - How many projects exist, how many are registered (`added: true`) for indexing.
3. **Ask what they want:**
   - Index all projects? Just this project? A specific set?
4. **Execute based on their answer.**

Do not skip the explanation step. The user needs to understand what's happening.

## Index Options

| User intent | Tool call |
|-------------|-----------|
| Index everything | `index(scope: "all")` — registers all projects + incremental index |
| Index a specific project | `index(project: "/full/path/to/project")` — auto-registers + indexes |
| Update existing index | `index()` — incremental for registered projects |
| Start fresh | `index(mode: "rebuild")` → confirm gate → `index(mode: "rebuild", confirm: true)` |
| Stop running index | `index(mode: "cancel")` |

**Important:** Always use full project paths, not fuzzy names.

## Project Management

| User intent | Tool call |
|-------------|-----------|
| See available projects | `manage_projects(action: "list")` |
| Register for indexing | `manage_projects(action: "add", projects: ["/full/path"])` |
| Unregister + clean DB | `manage_projects(action: "remove", projects: ["/full/path"])` |

When the user asks to add or remove, confirm which project they mean. If ambiguous, show the list first.

## Monitoring Progress

After starting indexing, check progress with `status`. It shows:
- Running/idle state
- Sessions indexed / total
- Current project and chunk embedding progress
- ETA

Indexing runs in the background — the user can search while it's in progress.

## Automatic Behavior

These happen without user intervention:
- **Auto-index on search:** Every search triggers a background incremental index for registered projects.
- **Orphan cleanup:** Deleted JSONL files are automatically pruned from DB during any index run.
- **Empty session handling:** Sessions with no searchable content are marked as processed and hidden.

## Rebuild: When and Why

Rebuild is rarely needed. It deletes all indexed data and re-indexes from scratch. Suggest it only when:
- Search results seem corrupted or inconsistent
- The user explicitly asks to start fresh
- Major version upgrade that changes indexing format

Always explain that rebuild can take several minutes for large projects, and require explicit confirmation.
