---
name: lore-search
description: Search past Claude Code conversations using lore MCP. MUST invoke this skill before calling mcp__lore__search — it guides you to clarify the user's intent and formulate effective queries. Trigger when the user asks to find past work, recall previous sessions, or search conversation history. Trigger on phrases like "last time we", "how did we solve", "check previous sessions", "find in history", "did we ever", "remember when", or any reference to past conversations, prior decisions, or previous work sessions. Also trigger on Korean equivalents like references to past work or prior sessions. NOT for git log, reading current files, web search, Notion, or GitHub.
---

# Lore Search

You're searching a hybrid BM25 + semantic index of past Claude Code conversation turns. The index contains multilingual content organized as session chunks with metadata (project, branch, timestamp, model, intent).

## Step 1: Clarify Intent Before Searching

Do not search immediately. The user's request often contains implicit scope that, if clarified, dramatically improves results. Ask about any of these that aren't obvious from context:

- **Which project?** If you know the current project, confirm whether to search just this project or across all indexed projects.
- **When?** Ask if the user remembers roughly when the work happened — convert to `before`/`after` filters.
- **Which branch?** If relevant to the work context.
- **How broad?** A single conversation vs. a broad topic across many sessions.

If the user's intent is already crystal clear (e.g., they name a specific feature and project), skip clarification and search directly.

## Step 2: Formulate Queries

### Dual-Format Strategy

Every query must serve BOTH retrieval engines simultaneously. BM25 needs exact token matches; semantic search needs dense meaning.

**Structure: [keyword anchors] + [semantic phrase]**

```
Bad:  "CircuitBreaker"                          (BM25-only, no semantic signal)
Bad:  "the safety system that stops trading"     (semantic-only, no keyword anchor)
Good: "CircuitBreaker daily loss limit HALF_OPEN recovery mechanism"
```

**Keyword anchors** — terms that actually appeared in conversations:
- File/class/variable names: `backtest_ab_comparison.py`, `StackingEnsemble`
- Error messages: `SIGSEGV`, `horizon mismatch`
- Tool/library names: `XGBoost`, `LightGBM`, `Optuna`

**Semantic phrases** — natural language capturing intent:
- "data leakage discovery and fix process"
- "why model performance dropped after bias fix"

### Multilingual Queries

The index often contains mixed-language content. Generate queries in the user's language AND English, plus code-switching variants when the user works in a non-English language:

```
Query A (user's language): "data leakage training validation split"
Query B (English):         "data leakage train validation split"
Query C (code-switching):  "OOF early stopping target leakage fix"
```

Code-switching variants are especially effective because developers naturally mix languages with technical terms.

### Conversational Context Resolution

When the user references prior context in the current conversation ("that thing", "what we discussed earlier"), resolve pronouns BEFORE formulating queries. You already have the conversation context — use it to make the query standalone.

### Decompose Complex Questions

Broad questions span multiple sessions. Break into angles and fire ALL in parallel:

| Angle | Query example |
|-------|--------------|
| Architecture | "SEAIS architecture pipeline hexagonal ML ensemble" |
| Performance | "SEAIS backtest sharpe profit loss walk-forward" |
| Issues | "SEAIS data leakage bug critical audit fix" |
| Planning | "SEAIS Phase plan roadmap strategy redesign" |

## Step 3: Search with Scope

Use available filters based on what you learned in Step 1:

| Parameter | Description |
|-----------|-------------|
| `query` | Keyword anchors + semantic phrase |
| `project` | Full project path (e.g., `/Users/.../my-project`) — not fuzzy names |
| `session` | Specific session UUID |
| `branch` | Git branch name |
| `before` | Results before this date (YYYY-MM-DD) |
| `after` | Results after this date (YYYY-MM-DD) |
| `limit` | 5-10 per query |

Fire 3-5 queries in parallel. Each search takes <20ms — the cost of extra searches is near zero.

## Step 4: Expand and Follow Up

When a result is relevant but truncated (`has_more_before`/`has_more_after` is true), use `get_context(chunk_id, direction="both")` to expand. This is cheaper than a new search.

### Step-Back Fallback

If results are sparse (< 3) or low scores (< 0.5), broaden the query:

```
Specific (failed): "train_stacking_v2.py line 168 OOF embargo fix"
Step-back:         "ML model training pipeline improvement"
```

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Search without understanding intent | Ask scope questions first |
| Single broad query | 3-5 parallel targeted queries |
| Pure natural language | Keywords + semantic |
| Single language only | Multilingual + code-switching |
| Fuzzy project names | Full project path |
| Give up after one search | Step-back to broader query |
