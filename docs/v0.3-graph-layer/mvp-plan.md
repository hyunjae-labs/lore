# lore v0.3 — 1-Week MVP Implementation Plan

**Prerequisite reading**: `README.md`, `design.md`, `schema.md`, `poc-results.md`
**Goal**: ship `lore@0.3.0-beta` with graph layer active by default, zero
LLM calls, backward-compatible search.

## Day-by-day breakdown

### Day 1 — Entity extractor + DB migration

**Files to create**:
- `src/db/migrations/003-graph-tables.ts` (schema from `schema.md`)
- `src/graph/patterns.ts` (regex table + custom pattern loader)
- `src/graph/entity-extractor.ts`

**Scope**:
1. Write migration 003, test round-trip (up / down / up).
2. Regex extractor covering Tier 1 patterns in `design.md`:
   - `exp_id`, `commit_sha`, `file_path`, `session_id`,
     `uppercase_acronym`, `class_name`, `metric`
3. Simple noun-phrase candidate extraction for Tier 2 prep
   (punctuation-based segmentation; no external NLP dep).
4. Unit tests: feed 5 synthetic chunks, assert extracted entities.
5. **No embedding clustering yet** — Tier 2 lands Day 3.

**Done when**:
- `003-graph-tables.ts` passes migration round-trip test
- `entity-extractor.ts` returns deterministic entity list for fixed input
- 20+ unit tests green
- Zero runtime dependency additions (use existing better-sqlite3 +
  built-in string methods only)

### Day 2 — Edge builder (co-occurrence + temporal)

**Files to create**:
- `src/graph/edge-builder.ts`
- `src/graph/store.ts` (CRUD layer)

**Scope**:
1. `edge-builder.ts` computes three edge types:
   - `co_occurs`: entity pairs in same chunk, weight = log(1 + count)
   - `temporal_adjacent`: same entity in sessions within 24h,
     weight = log(1 + recency_factor)
   - `similar` stub (implementation Day 3)
2. `store.ts` upsert-or-increment logic for edges (dedup by
   `(source_key, target_key, relation)`).
3. Integration test: run extractor + edge builder on a real session
   markdown (reuse PoC's `sess_*.md` files from
   `~/01_projects/conversations-graph/sessions_md/`).

**Done when**:
- Running on 1 PoC session produces reasonable graph fragment
  (10-30 nodes, 15-50 edges)
- Re-running on same session is idempotent (upsert, not duplicate)
- `store.ts` is the only module writing to graph tables

### Day 3 — Embedding-based edges + noun-phrase clustering

**Files to modify**:
- `src/graph/entity-extractor.ts` (add Tier 2 clustering)
- `src/graph/edge-builder.ts` (implement `similar` edges)

**Scope**:
1. **Tier 2 entities**: feed noun-phrase candidates into existing
   embedder (`src/embedder/`). Cluster by cosine > 0.85. Cluster label
   = most frequent candidate.
2. **Similar edges**: for each new entity, find top-5 existing entities
   with cos > 0.80 and create `similar` edges.
3. Reuse existing embedding batch API — don't reinvent.
4. Benchmark: < 500ms added per session for 50 entities.

**Done when**:
- Running on `EXP-110 session` markdown now produces `similar` edges
  between e.g. "ratio-skip thr=0.8" and "ratio-boost thr=1.2"
- Total per-session build time < 2s on a Mac M-series

### Day 4 — Louvain community detection + god scoring

**Dependency**: `graphology-communities-louvain` (npm)

**Files to create**:
- `src/graph/community.ts`
- `src/graph/god-detector.ts`

**Scope**:
1. `community.ts`:
   - Load graph from DB into graphology Graph object
   - Run Louvain with fixed seed (42)
   - Write community IDs back to `graph_nodes.community_id`
   - Update `graph_communities` table
   - Produce top 5 representative entities per community
2. `god-detector.ts`:
   - Degree centrality (O(n))
   - Approximate betweenness (sample-based, O(n * sqrt(n)))
   - `god_score = 0.7 * norm_degree + 0.3 * norm_betweenness`
   - Write back to `graph_nodes.god_score`
3. Benchmark: < 30s for 1000 nodes / 2000 edges (PoC was 295/286, ran
   instantly)

**Done when**:
- Running on full PoC graph produces communities with > 0.3 modularity
- Top 10 god nodes overlap ≥ 6 of 10 from PoC results
  (see `poc-results.md` god nodes table)

### Day 5 — Hook integration + incremental update

**Files to modify**:
- `src/indexer/index.ts` (add graph build call after chunking)
- `src/graph/index.ts` (orchestrator: `buildForSession(session_id)`)

**Scope**:
1. After `SessionEnd` indexer writes chunks, call `graph.buildForSession`:
   - Extract entities from new chunks
   - Add nodes/edges to DB
   - **Assign new nodes to nearest-neighbor community** (no Louvain rerun)
   - Increment `graph_meta.sessions_since_rebuild`
2. If `sessions_since_rebuild >= 100`, kick off **background**
   full rebuild:
   - Full Louvain
   - Recompute god scores
   - Reset counter
   - Don't block SessionEnd
3. Failure isolation: if graph build fails, log warning, don't fail
   the session index. Vector search must keep working.

**Done when**:
- End-to-end: new session JSONL appears → SessionEnd fires → both
  vector AND graph are updated
- Kill the graph builder mid-run: next session still indexes vector
  successfully
- Time from SessionEnd trigger to both indexes updated: < 5s typical

### Day 6 — MCP tool suite

**Files to create**:
- `src/tools/god_nodes.ts`
- `src/tools/session_context.ts`
- `src/tools/find_path.ts`
- `src/tools/evolution_report.ts`

**Files to modify**:
- `src/tools/search.ts` (add graph enrichment)
- `src/server.ts` (register new tools)

**Scope** per tool — reference `design.md` § "New MCP Tools" for full input/output:

| Tool | Core logic |
|------|-----------|
| `god_nodes_current` | `SELECT … ORDER BY god_score DESC LIMIT N` |
| `session_context` | Find community of session's entities; return community siblings + top gods in community |
| `find_path` | BFS in JS over adjacency list loaded from `graph_edges` |
| `evolution_report` | Compare current god scores vs snapshot at `last_full_rebuild_ts` |
| `search` (extended) | For each result, look up community + nearest_god; add as `graph` field |

**Done when**:
- All 4 new tools return sensible output for quant-alpha corpus
- `search` returns enriched results without breaking v0.2 consumers
  (feature flag or `include_graph` bool, default true)
- MCP tool schemas documented in `README.md` tool list

### Day 7 — Eval + polish + release prep

**Scope**:
1. Add eval cases in `evals/graph-layer/`:
   - Synthetic: 10 handcrafted sessions → assert specific god nodes
     and one specific community
   - Regression: old `evals/` tests must all still pass
2. Update root `README.md`:
   - Feature list adds "Auto-built knowledge graph (local)"
   - New tool examples
   - FAQ: "Does it cost anything?" → No, fully local, no LLM
3. Backfill command: `getlore graph rebuild` (CLI flag) — one-time
   processing of existing sessions. Document clearly as optional.
4. Version bump `package.json` → `0.3.0-beta.1`
5. Manual smoke test: use lore on 3-5 real sessions while building.
   Call `god_nodes_current` and verify output makes sense.

**Done when**:
- All evals green
- Smoke test: user invokes `god_nodes_current` on own system and
  approves output
- `0.3.0-beta.1` published to npm or ready to publish

## Out of Scope for This Week

- LLM fallback extraction (v0.3.1)
- Cross-project meta-graph
- HTML viz export
- Community auto-labeling (will stay as numeric IDs like "C12")
- Web UI
- Graph editing via MCP

## Risk Register

| Risk | Mitigation |
|------|-----------|
| Embedding clustering produces noisy entities | Tune threshold (start 0.85), expose in config, log unclustered candidates for manual review |
| Louvain rebuild too slow on large graphs | Batched rebuild (every 100 sessions) + background process + progress log |
| Hook latency becomes perceptible | Measure, aim for < 2s added on SessionEnd. If > 5s, move to async queue |
| Regex patterns miss project-specific conventions | `~/.lore/patterns.json` for user-defined regexes, documented in README |
| Entity explosion (10k+ nodes from noisy extraction) | TTL decay for unused entities (design § open Q #3), configurable degree threshold for god candidacy |

## Testing Strategy

- **Unit**: each `graph/*.ts` module has colocated tests in `tests/graph/`
- **Integration**: `tests/integration/graph-flow.test.ts` runs
  extract→edges→store→louvain on fixture sessions
- **E2E**: one test that runs the full indexer pipeline end-to-end
  on a single JSONL fixture and asserts both vector and graph outputs
- **Regression**: existing v0.2 tests must all pass

## Release Plan

1. `0.3.0-beta.1` — end of Day 7, internal/manual testing
2. `0.3.0-beta.2` — after 1 week of dogfooding, threshold tuning
3. `0.3.0` — after 2 more weeks of real use with no reported issues
4. v0.3.1 — optional LLM extraction (opt-in)

## Success Criteria for v0.3

1. Existing users upgrade without any config change
2. `god_nodes_current` returns meaningful output for the quant-alpha
   project within 3 sessions of upgrade
3. Session indexing latency P50 ≤ 105% of v0.2 baseline
4. `lore.db` size growth ≤ 2MB per 1000 additional sessions
5. Zero new API keys required
