# lore

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

Semantic search across your Claude Code conversations.
Find anything you've ever discussed -- across all projects, all sessions, any branch.

## Features

- **Hybrid search (vector + keyword)**
  Combines multilingual-e5-small embeddings with FTS5/BM25 via Reciprocal Rank Fusion. Finds results by meaning *and* exact terms.

- **Fully local, zero API keys**
  Everything runs on your machine. ONNX Runtime for embedding, sqlite-vec for storage. No data leaves your device.

- **Background indexing**
  Index triggers return instantly. Monitor progress while you keep working. Search what's already indexed while the rest catches up.

- **Project-selective**
  Register only the projects you care about. Add or remove anytime. Unregistering deletes indexed data to keep things clean.

- **Conversation-aware chunking**
  Splits by logical turns (user question + full assistant response chain), not arbitrary token windows. Handles tool-use chains, thinking blocks, and multi-step interactions correctly.

- **100+ languages**
  Korean, Japanese, Chinese, English, and 90+ more. CJK-aware token estimation for accurate chunking.

## Quick Start

### Add to Claude Code

```bash
# Recommended — always runs latest version, no install needed
claude mcp add -s user lore -- npx getlore

# Or for a single project
claude mcp add -s project lore -- npx getlore
```

<details>
<summary>Alternative: global install (faster startup)</summary>

```bash
npm install -g getlore
claude mcp add -s user lore -- getlore

# To update later:
npm install -g getlore@latest
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

1. **Browse projects** -- lore shows all your Claude Code projects
2. **Register** -- pick which ones to index
3. **Index** -- runs in background, takes ~15 seconds per project
4. **Search** -- ask anything about past conversations

## Tools

| Tool | Purpose |
|------|---------|
| `manage_projects` | Register/unregister projects for indexing |
| `index` | Start background indexing of registered projects |
| `status` | Check indexing progress and DB health |
| `search` | Semantic + keyword search across conversations |
| `get_context` | Expand search results with surrounding conversation |
| `list_sessions` | Browse indexed sessions by project |

## Why This Exists

Claude Code stores every conversation as a JSONL transcript in `~/.claude/projects/`. After a few weeks, you have hundreds of sessions across dozens of projects -- discussions about architecture decisions, debugging sessions, code reviews, and design explorations.

But there's no way to search through them. You can't ask "what approach did we take for the auth middleware?" or "which project had that database migration discussion?"

Existing tools either require cloud APIs, spawn zombie processes, or treat conversations as generic documents. lore is purpose-built for Claude Code sessions: it understands turn boundaries, tool-use chains, and thinking blocks. It runs entirely locally with zero dependencies beyond Node.js.

## How It Works

```
~/.claude/projects/*/*.jsonl
        |
   JSONL Parser (extracts user/assistant messages, skips noise)
        |
   Turn-pair Chunker (groups by logical conversation turns)
        |
   Transformers.js (multilingual-e5-small, INT8 quantized, 384d)
        |
   sqlite-vec + FTS5 (hybrid vector + keyword storage)
        |
   Reciprocal Rank Fusion (combines both signals for ranking)
```

**Storage:** Single SQLite file at `~/.lore/lore.db` with WAL mode for concurrent reads.

**Config:** Project registration stored in `~/.lore/config.json`.

<details>
<summary><strong>Configuration</strong></summary>

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LORE_DIR` | `~/.lore` | Data directory |
| `LORE_DB` | `~/.lore/lore.db` | Database path |
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | Claude Code transcripts location |

</details>

<details>
<summary><strong>Performance</strong></summary>

Measured on Apple Silicon (M-series):

| Metric | Value |
|--------|-------|
| Search latency | 7-15ms |
| Index speed | ~10 sessions/sec |
| First search (cold model load) | ~5s |
| DB size | ~0.1MB per 10 sessions |
| Model size (downloaded once) | ~112MB |

</details>

<details>
<summary><strong>Troubleshooting</strong></summary>

### "No projects registered"

Run `manage_projects` with action `list` to see available projects, then `add` the ones you want.

### Stale lock file

If indexing was interrupted, the lock file auto-cleans on next run (PID-based detection).

### DB corruption

Delete `~/.lore/lore.db` and re-index. Your source data (`~/.claude/projects/`) is never modified.

</details>

## Development

```bash
git clone https://github.com/your-username/getlore.git
cd getlore/getlore
npm install
npm run build
npm test          # 114 tests
```

## Tech Stack

- [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk) -- stdio transport
- [@huggingface/transformers](https://huggingface.co/docs/transformers.js) -- multilingual-e5-small (INT8)
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) + [sqlite-vec](https://github.com/asg017/sqlite-vec) -- embedded vector DB
- [Reciprocal Rank Fusion](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf) -- hybrid search ranking

## License

MIT
