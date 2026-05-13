# lore v0.3 — Graph Layer Design

**Status**: Design complete, awaiting implementation session
**Date**: 2026-04-16
**PoC validated**: ✅ (see `poc-results.md`)

## TL;DR

Add a graph layer on top of lore's existing vector + FTS5 hybrid search.
The graph is **built autonomously** — no manual `/graphify` equivalent needed.
It auto-updates via the existing `SessionEnd` hook, stays in the same
SQLite database, and **strictly respects the "zero API keys, fully local"
philosophy** (rule-based + embedding-clustered entity extraction only,
no LLM calls required).

## Why

PoC against 65 quant-alpha sessions (see `poc-results.md`) showed:
- **God nodes** surface the user's actual mental model — things lore
  search alone cannot reveal (e.g. "Session X is a hub"). Showed the
  user their reasoning was concentrated on 5 turning points.
- **Communities** auto-classify work into themes that keyword search
  can't group — e.g. "Phase 2 Validation" cluster spans 18 sessions.
- **Surprising cross-session connections** found links between sessions
  2+ weeks apart that the user didn't know were thematically related.
  This is the single highest-value output — it cannot come from
  similarity search alone.

These are meta-insights lore currently does not provide. v0.3 bakes
them in as first-class tools.

## Design pillars

1. **Zero API keys preserved** — graph extraction uses regex entities +
   existing `multilingual-e5-small` embedding similarity. No LLM call.
   (LLM-quality extraction is a v0.4 opt-in feature.)
2. **Auto-build** — graph updates inside the existing SessionEnd hook
   after the chunking/embedding step. User does nothing.
3. **Same database** — graph tables live in `lore.db` alongside
   vector + FTS5 tables. No new storage, no new migration tooling.
4. **Backward compatible** — existing `search`, `list_sessions`,
   `get_context` tools unchanged. Graph metadata is additive.
5. **Incremental** — never rebuild the whole graph. Entity extraction
   per session, community detection on schedule (every 100 new
   sessions) with interim nearest-community placement.

## Repo layout of v0.3 work

```
docs/v0.3-graph-layer/
├── README.md            ← you are here
├── design.md            ← full architecture + rationale
├── mvp-plan.md          ← day-by-day 1-week implementation
├── schema.md            ← DB schema additions
└── poc-results.md       ← evidence from the 65-session PoC
```

## How to resume in the next session

1. Read this README.md (you just did).
2. Read `design.md` for the full picture.
3. Read `mvp-plan.md` — start with Day 1 task.
4. Reference `schema.md` when writing the migration.
5. Reference `poc-results.md` for design-validation evidence.

PoC artifacts live outside this repo at
`~/01_projects/conversations-graph/` — graph.json, graph.html,
sessions_md/ — useful as a reference implementation (it was built
with the stand-alone `graphify` tool, not lore itself).

## Non-goals for v0.3

- LLM-based extraction (v0.4)
- Cross-project graph unification (v0.4)
- Web UI / visualization server (maybe never — HTML static export is enough)
- Graph editing via MCP (read-only tools only in v0.3)

## Open questions (decide during implementation)

See `design.md` § "Open Questions". Nothing blocking for MVP start.
