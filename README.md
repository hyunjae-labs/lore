# lore

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![lore MCP server](https://glama.ai/mcp/servers/hyunjae-labs/lore/badges/score.svg)](https://glama.ai/mcp/servers/hyunjae-labs/lore)

Semantic search across your Claude Code **and** OpenAI Codex CLI conversations.
Find anything you've ever discussed -- across all projects, all sessions, any branch, any agent.

[![lore MCP server](https://glama.ai/mcp/servers/hyunjae-labs/lore/badges/card.svg)](https://glama.ai/mcp/servers/hyunjae-labs/lore)

## Features

- **Hybrid search (vector + keyword)**
  Combines multilingual-e5-small embeddings with FTS5/BM25 via Reciprocal Rank Fusion. Finds results by meaning *and* exact terms.

- **Multi-agent: Claude Code + Codex CLI**
  Indexes both `~/.claude/projects/` (Claude Code) and `~/.codex/sessions/` (OpenAI Codex CLI) in the same DB. Codex sessions are grouped by `cwd` from `session_meta`, surfaced as `codex-<path>` virtual projects so you can search them together or filter to one agent.

- **Fully local, zero API keys**
  Everything runs on your machine. ONNX Runtime for embedding, sqlite-vec for storage. No data leaves your device.

- **Auto-index on session end**
  A SessionEnd hook automatically indexes all new sessions in the background. No manual triggers needed.

- **Background indexing**
  Manual index triggers return instantly. Monitor progress while you keep working. Search what's already indexed while the rest catches up.

- **Opt-out by default**
  All projects are indexed automatically. Exclude the ones you don't want. No registration needed.

- **Conversation-aware chunking**
  Splits by logical turns (user question + full assistant response chain), not arbitrary token windows. Handles tool-use chains, thinking blocks, and multi-step interactions correctly.

- **100+ languages**
  Korean, Japanese, Chinese, English, and 90+ more. CJK-aware token estimation for accurate chunking.

## Quick Start

### Add to Claude Code

```bash
# No install needed — always runs latest version
claude mcp add -s user lore -- npx getlore

# Or for a single project only
claude mcp add -s project lore -- npx getlore
```

### Add to OpenAI Codex CLI

```bash
# No install needed
codex mcp add lore -- npx getlore
```

<details>
<summary>Alternative: global install (faster startup, works offline)</summary>

```bash
npm install -g getlore

# Then register with your tool:
claude mcp add -s user lore -- getlore   # Claude Code
codex mcp add lore -- getlore            # Codex CLI

# Manage your install:
getlore --version   # Check installed version
getlore update      # Update to latest
```

</details>

### Usage

Once connected, the AI can use lore's tools directly:

```
You: "What did we discuss about auth refactoring last week?"

Claude: [calls lore search] Found 3 relevant conversations...
        In your "my-webapp" project on March 15, you decided to...
```

**First time setup:**

1. **Index** -- `index()` scans all projects automatically, runs in background
2. **Search** -- ask anything about past conversations
3. **Exclude** (optional) -- hide noisy projects you don't care about

## Tools

| Tool | Purpose |
|------|---------|
| `manage_projects` | Exclude/include projects from indexing (opt-out model) |
| `index` | Start background indexing. All non-excluded projects. Modes: `incremental` (default), `rebuild`, `cancel` |
| `status` | Check indexing progress, ETA, skip reasons, DB health |
| `search` | Semantic + keyword search across conversations |
| `get_context` | Expand search results with surrounding conversation |
| `list_sessions` | Browse indexed sessions by project |

## Why This Exists

Claude Code stores every conversation as a JSONL transcript in `~/.claude/projects/`, and OpenAI Codex CLI stores its rollouts in `~/.codex/sessions/YYYY/MM/DD/`. After a few weeks, you have hundreds of sessions across dozens of projects, often spread across both agents -- discussions about architecture decisions, debugging sessions, code reviews, and design explorations.

But there's no way to search through them. You can't ask "what approach did we take for the auth middleware?" or "which project had that database migration discussion?"

Existing tools either require cloud APIs, spawn zombie processes, or treat conversations as generic documents. lore is purpose-built for AI coding sessions: it understands turn boundaries, tool-use chains, and thinking blocks, and parses both Claude Code and Codex JSONL formats natively. It runs entirely locally with zero dependencies beyond Node.js.

## How It Works

```
~/.claude/projects/*/*.jsonl     ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
        \                                       /
         \                                     /
          JSONL Parser (Claude Code + Codex formats, skips noise)
                              |
          Turn-pair Chunker (groups by logical conversation turns)
                              |
          Transformers.js (multilingual-e5-small, INT8 quantized, 384d)
                              |
          sqlite-vec + FTS5 (hybrid vector + keyword storage)
                              |
          Reciprocal Rank Fusion (combines both signals for ranking)
```

Codex sessions are grouped by `cwd` extracted from each file's `session_meta` line and surfaced as `codex-<path>` virtual projects in the index.

**Storage:** Single SQLite file at `~/.lore/lore.db` with WAL mode for concurrent reads.

**Config:** Project exclusions stored in `~/.lore/config.json`.

<details>
<summary><strong>Configuration</strong></summary>

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LORE_DIR` | `~/.lore` | Data directory |
| `LORE_DB` | `~/.lore/lore.db` | Database path |
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | Claude Code transcripts location |
| `CODEX_SESSIONS_DIR` | `~/.codex/sessions` | OpenAI Codex CLI rollouts location |

</details>

<details>
<summary><strong>Performance</strong></summary>

Measured on Apple Silicon (M-series):

| Metric | Value |
|--------|-------|
| Search latency | 20-30ms |
| Index speed | ~10 sessions/sec |
| First search (cold model load) | ~5s |
| DB size | ~0.1MB per 10 sessions |
| Model size (downloaded once) | ~112MB |

</details>

<details>
<summary><strong>Troubleshooting</strong></summary>

### "No sessions found"

Run `manage_projects` with action `list` to see available projects. All are indexed by default unless excluded.

### Stale lock file

If indexing was interrupted, the lock file auto-cleans on next run (PID-based detection).

### DB corruption

Delete `~/.lore/lore.db` and re-index. Your source data (`~/.claude/projects/`) is never modified.

</details>

## Development

```bash
git clone https://github.com/hyunjae-labs/lore.git
cd lore
npm install
npm run build
npm test          # 135 tests
```

## Tech Stack

- [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk) -- stdio transport
- [@huggingface/transformers](https://huggingface.co/docs/transformers.js) -- multilingual-e5-small (INT8)
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) + [sqlite-vec](https://github.com/asg017/sqlite-vec) -- embedded vector DB
- [Reciprocal Rank Fusion](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf) -- hybrid search ranking

## License

MIT