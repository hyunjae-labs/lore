---
name: lore
description: Optimizes lore MCP search queries for accurate retrieval from conversation history. MUST be invoked before calling mcp__lore__search — consult this skill first to formulate effective queries. Trigger when the user asks to find past work, recall previous sessions, or search conversation history. Korean triggers include 저번에/예전에/이전에 + ~했었는데/~해결했었는지/~돌렸던, 이전 작업 이력, 과거 대화에서 찾아. English triggers include "last time we", "how did we solve", "check previous sessions", "find in history". NOT for git log, reading current files, web search, Notion, or GitHub.
---

# Lore Search Query Optimization

You're searching a hybrid BM25 + semantic index of past Claude Code conversation turns. The index contains mixed Korean/English content organized as session chunks with metadata (project, branch, timestamp, model, intent).

## Quick Reference: Available Tools

| Tool | Purpose |
|------|---------|
| `search` | Semantic + keyword search across indexed sessions |
| `get_context` | Expand a search result to see surrounding conversation |
| `index` | Index sessions — no params (added projects), `project: path` (auto-add one), `scope: "all"` (everything) |
| `list_sessions` | Browse indexed sessions by project/date |
| `manage_projects` | `list` / `add` / `remove` projects for indexing |
| `status` | Check indexing progress |

## Core Principle: Multiple Fast Searches > One Perfect Query

Each search takes <20ms. The cost of an extra search is near zero; the cost of missing relevant results is high. Fire 3-5 targeted searches in parallel rather than trying to craft one perfect query.

## Query Formulation: Dual-Format Strategy

Every query should serve BOTH retrieval engines simultaneously. BM25 needs exact token matches; semantic search needs dense meaning. A single query optimized for one will underperform on the other.

**Structure each query as: [keyword anchors] + [semantic phrase]**

```
Bad:  "CircuitBreaker"                          (BM25-only, no semantic signal)
Bad:  "the safety system that stops trading"     (semantic-only, no keyword anchor)
Good: "CircuitBreaker daily loss limit HALF_OPEN recovery mechanism"
       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^          ^^^^^^^^^^^^^^^^^
       BM25 keyword anchors                      Semantic context
```

### Keyword Anchors (BM25 side)

Include terms that actually appeared in the conversation:
- File/class/variable names: `backtest_ab_comparison.py`, `StackingEnsemble`, `OMP_NUM_THREADS`
- Error messages and codes: `SIGSEGV`, `horizon mismatch`, `Sharpe -0.953`
- Tool/library names: `XGBoost`, `LightGBM`, `Optuna`, `Modal`
- Identifiers: `PID 48297`, `V2.5`, `Phase 12`

### Semantic Phrases (embedding side)

Add natural language that captures intent and relationships:
- "데이터 누수를 발견하고 수정한 과정" (captures the story arc)
- "why model performance dropped after bias fix" (captures causality)

The embedding model handles cross-concept matching — "미래 데이터를 몰래 보는" matches "look-ahead bias". But relying on semantic alone is risky; always pair with keyword anchors.

## Bilingual Strategy

The index mixes Korean and English, often within the same turn ("Redis 캐싱을 써야 할 것 같아요"). Always generate queries in both languages, and include code-switching variants:

```
Query A (Korean):  "SEAIS 데이터 누수 학습 검증 분할"
Query B (English): "SEAIS data leakage train validation split"
Query C (Mixed):   "SEAIS OOF early stopping 타겟 누수 fix"
```

Code-switching variants (Query C) are especially effective because bilingual developers naturally mix languages in conversation — and BM25 matches those exact mixed tokens.

## Conversational Context Resolution

When the user's question references prior context in the current conversation ("그거", "아까 말한 것", "that thing"), resolve pronouns and references BEFORE formulating the lore query.

```
User says: "아까 말한 그 버그 히스토리 찾아봐"
Context:   We were discussing SEAIS data leakage

Don't search: "그 버그 히스토리"
Do search:    "SEAIS data leakage OOF early stopping audit history"
```

This is free — you already have the conversation context. Just use it to make the query standalone.

## Query Decomposition for Complex Questions

Broad questions span multiple conversation sessions. Decompose into angles:

"SEAIS 프로젝트 전체 이력 파악해줘" →

| Angle | Query |
|-------|-------|
| Architecture | "SEAIS architecture pipeline hexagonal ML model ensemble" |
| Performance | "SEAIS backtest sharpe profit loss walk-forward result" |
| Issues | "SEAIS data leakage bug critical audit fix" |
| Planning | "SEAIS Phase plan roadmap strategy redesign" |
| Operations | "SEAIS live trading deploy production paper trading" |

Fire ALL in parallel. Synthesize across results.

## Step-Back Fallback

If initial queries return few results (< 3) or low scores (< 0.5), the query may be too specific. Step back to a more abstract version:

```
Specific (failed): "train_stacking_v2.py line 168 OOF embargo fix"
Step-back:         "SEAIS ML model training pipeline improvement"
```

This catches conversations where the topic was discussed in broader terms before drilling into specifics.

## Scope Narrowing via Parameters

Always use available filters to narrow search scope:

```
project: "/Users/hyunjaelim/01_projects/SEAIS"  # Project path (auto-converted to dirName)
session: "a1b2c3d4-..."                          # Specific session UUID
branch: "feat/new-model"                         # Git branch
limit: 5-10                                      # Per query, not total
before: "2026-03-01"                             # Time-bound
after: "2026-02-15"                              # Time-bound
```

- When user mentions a project → set `project` (use the actual project path, e.g. `/Users/.../my-project`)
- When user references a specific session → set `session` (use UUID from `list_sessions`)
- When user references time ("last week", "2월에") → convert to `before`/`after`
- Default `limit: 5-10` per query. With 3-5 parallel queries, total coverage is 15-50 results

## Follow-up with get_context

When a result is relevant but truncated (`has_more_before`/`has_more_after` is true), use `get_context(chunk_id, direction="both")` to expand. This is cheaper than a new search and gives full conversation flow.

## Indexing: Getting Data Ready for Search

Before searching, sessions must be indexed. Lore auto-indexes added projects in the background on every search. For explicit control:

| User says | Action |
|-----------|--------|
| "전부 인덱싱해줘" | `index(scope: "all")` — registers and indexes all projects |
| "이 프로젝트 인덱싱해줘" | `index(project: "/Users/.../my-project")` — auto-adds and indexes |
| "업데이트해줘" | `index()` — incremental update for added projects |
| "처음부터 다시" | `index(mode: "rebuild", confirm: true)` — clean rebuild |

Orphan cleanup is automatic: deleted JSONL files are pruned from DB during any index run.

## Project Management

| Action | Command |
|--------|---------|
| See all projects | `manage_projects(action: "list")` |
| Register for indexing | `manage_projects(action: "add", projects: ["/path/to/project"])` |
| Unregister + clean DB | `manage_projects(action: "remove", projects: ["/path/to/project"])` |

Projects use path-based matching — pass the actual project path (e.g., `/Users/hyunjaelim/01_projects/lore`), not fuzzy names.

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Single broad query hoping to catch everything | 3-5 parallel targeted queries per angle |
| Pure natural language ("the thing that broke") | Keywords + semantic: "LightGBM SIGSEGV model loading crash" |
| One language only | Bilingual + code-switching variants |
| limit: 20 on vague query | limit: 5-10, compensate with more queries |
| Ignore context ("그거 찾아봐") | Resolve to standalone: specific terms from current conversation |
| Give up after one search | Step-back to broader query if results are sparse |
| Use fuzzy project names ("lore") | Use full path: "/Users/.../lore" |

## Execution Template

```
1. Resolve: Convert user's question to standalone (resolve pronouns, context)
2. Decompose: Identify 3-5 search angles if question is complex
3. Formulate: For each angle, create query with [keyword anchors] + [semantic phrase]
4. Bilingual: Ensure at least one Korean and one English query
5. Scope: Set project/session/before/after/limit parameters
6. Execute: Fire all queries in parallel (single tool call block)
7. Expand: Use get_context on high-score chunks that are truncated
8. Fallback: If sparse results, step-back to broader queries
9. Synthesize: Merge findings across all results
```
