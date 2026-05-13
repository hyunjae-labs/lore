# lore v0.3 — Graph Layer Architecture

## Context

lore v0.2.x provides:
- Hybrid search (vector `e5-small` + FTS5/BM25 via RRF)
- Auto-index on `SessionEnd` hook
- SQLite + sqlite-vec, fully local, zero API keys
- Conversation-aware chunking (per logical turn)

What lore v0.2.x does **not** provide:
- Structural relationships between entities across sessions
- Any notion of "hub" or "center of gravity" in the user's thinking
- Automatic thematic grouping (communities)
- Surprising cross-session connections that pure similarity misses

v0.3 adds a **graph layer** that provides all four, without breaking
any of the v0.2 guarantees.

## Design Pillars (hard constraints)

| # | Constraint | Consequence |
|---|-----------|-------------|
| 1 | Zero API keys preserved | No LLM calls during extraction. Regex + embedding-clustering only |
| 2 | Fully local | Graph stays in `lore.db`. No external service |
| 3 | Autonomous | Built inside SessionEnd hook. No user command equivalent to `graphify --update` |
| 4 | Backward compatible | Existing MCP tools unchanged. Graph metadata additive |
| 5 | Incremental | Entity extraction per session. Community detection batched |
| 6 | Language-agnostic | Korean/Japanese/CJK support equal to existing chunking |

## Architecture

```
                     ┌──────────────────────────────┐
                     │   SessionEnd hook (existing) │
                     └──────────────┬───────────────┘
                                    │
                                    ▼
                     ┌──────────────────────────────┐
                     │ chunker → embedder → indexer │  (existing)
                     │        (v0.2.x flow)         │
                     └──────────────┬───────────────┘
                                    │  new chunks committed to DB
                                    ▼
                     ╔══════════════════════════════╗
                     ║        GRAPH BUILDER         ║  NEW in v0.3
                     ║ ┌──────────────────────────┐ ║
                     ║ │ 1. entity-extractor       │ ║ regex + NER-lite
                     ║ │    - EXP-NNN patterns     │ ║
                     ║ │    - file paths           │ ║
                     ║ │    - commit SHAs          │ ║
                     ║ │    - function/class names │ ║
                     ║ │    - custom user patterns │ ║ (config)
                     ║ └────────────┬──────────────┘ ║
                     ║              ▼                ║
                     ║ ┌──────────────────────────┐ ║
                     ║ │ 2. edge-builder           │ ║
                     ║ │    - co-occurrence (chunk)│ ║ weight by chunk count
                     ║ │    - e5 similarity (cos)  │ ║ reuse existing embeddings
                     ║ │    - temporal adjacency   │ ║ sessions within 24h
                     ║ └────────────┬──────────────┘ ║
                     ║              ▼                ║
                     ║ ┌──────────────────────────┐ ║
                     ║ │ 3. graph-store            │ ║ SQLite upserts
                     ║ │    (nodes + edges tables) │ ║
                     ║ └────────────┬──────────────┘ ║
                     ║              ▼                ║
                     ║ ┌──────────────────────────┐ ║
                     ║ │ 4. community-updater      │ ║ Louvain
                     ║ │    - immediate: nearest   │ ║ fast, approximate
                     ║ │    - scheduled: full      │ ║ every 100 sessions
                     ║ └──────────────────────────┘ ║
                     ╚══════════════════════════════╝
```

## File structure (v0.3)

```
src/
├── config.ts
├── db/
│   ├── migrations/
│   │   └── 003-graph-tables.ts     ← NEW
│   └── ...
├── embedder/                        (unchanged)
├── indexer/                         (unchanged)
├── graph/                           ← NEW module
│   ├── index.ts                     ← public API: buildForSession(), query()
│   ├── entity-extractor.ts          ← regex + NER-lite
│   ├── edge-builder.ts              ← co-occurrence + similarity + temporal
│   ├── community.ts                 ← Louvain via graphology-communities-louvain
│   ├── god-detector.ts              ← centrality metrics
│   ├── store.ts                     ← SQLite CRUD for nodes/edges/communities
│   └── patterns.ts                  ← entity regex patterns (user-configurable)
├── server.ts                        (extended: register new tools)
└── tools/
    ├── search.ts                    ← existing: extended with graph metadata
    ├── god_nodes.ts                 ← NEW
    ├── session_context.ts           ← NEW (neighbors, community, gods)
    ├── find_path.ts                 ← NEW (shortest path in graph)
    ├── evolution_report.ts          ← NEW (god node shift over N days)
    └── ...
```

## Entity Extraction Strategy (LLM-free)

### Tier 1: High-precision regex (deterministic)

Run on chunk text. High-signal patterns:

```typescript
const PATTERNS = {
  exp_id: /EXP-\d{3,4}[a-z]?/g,                 // EXP-076, EXP-107c
  commit_sha: /\b[0-9a-f]{7,12}\b/g,            // 9c44cea, 3c49fad
  file_path: /(?:[\w\-.]+\/){1,}[\w\-.]+\.\w+/g, // scripts/exp110.py
  session_id: /sess_[0-9a-f-]+/g,
  uppercase_acronym: /\b[A-Z]{2,}(?:_[A-Z0-9]+)*\b/g,  // ADX, TWRR, BASE_COST
  class_name: /\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g,      // PortfolioManager
  metric: /(?:Sharpe|MDD|CAGR|Calmar)\s*[:=]?\s*[\d.+-]+/gi,
};
```

### Tier 2: Embedding-cluster entities

Longer concepts ("Filter Paradox", "Loser removal overfitting") won't
match regex. Strategy:

1. Extract noun-phrase candidates from chunks (simple POS tag or
   punctuation-based segmentation — no spaCy, use minimal JS NLP).
2. Embed candidates via existing e5 (batch).
3. Cluster candidates whose cosine similarity > threshold (0.85).
4. Cluster label = representative candidate (longest or most frequent).
5. Treat each cluster as one entity node.

This pulls out **named concepts** without LLM. Quality is mid-tier
but covers the 80% case. v0.4 can add optional LLM refinement.

### Tier 3: User patterns (config file)

`~/.lore/patterns.json`:
```json
{
  "custom_patterns": [
    { "name": "finding", "regex": "Finding:\\s*[^\\n]{10,100}" },
    { "name": "rule",    "regex": "Rule\\s+R\\d+:\\s*[^\\n]{10,100}" }
  ]
}
```

## Edge Builder

Three edge types, each with its own score:

| Type | Logic | Confidence |
|------|-------|------------|
| `co_occurs_in_chunk` | Two entities in same chunk | weight = log(1 + count) |
| `semantically_similar` | Cosine(e5) > 0.80 | weight = similarity score |
| `temporally_adjacent` | Same entity in sessions within 24h | weight = log(1 + recency) |

Edges stored in a single table with `relation` discriminator.

## Community Detection

**Algorithm**: Louvain modularity (JS library `graphology-communities-louvain`).
- Fast: O(n log n), handles 10k+ nodes easily
- Deterministic with seed
- Produces hierarchy (can pick top level or sub-communities)

**Schedule**:
- **Immediate** (every session): new nodes assigned to nearest existing
  community by neighbor vote (no Louvain rerun)
- **Batched** (every 100 new sessions): full Louvain on entire graph,
  rebalance communities, update cohesion scores
- **Manual** trigger available (MCP tool `rebuild_communities`)

## God Node Detection

Simple weighted degree centrality + betweenness centrality:

```typescript
godScore(node) = 0.7 * normalized_degree + 0.3 * normalized_betweenness
```

Top N by god score become "god nodes". Update on each community rebuild
(cheap enough to compute every session — betweenness is the bottleneck,
approximate version available).

## Search API — Enriched Response

Existing search tool keeps its API. Results get a new optional `graph`
field:

```typescript
// Current v0.2
interface SearchResult {
  chunk_id: number;
  content: string;
  score: number;
  session_id: string;
  project: string;
  timestamp: string;
}

// v0.3 — additive
interface SearchResult {
  ...v0.2 fields,
  graph?: {
    community: {
      id: number;
      label: string;          // auto-generated or LLM-later
      size: number;
    };
    nearest_god: {
      entity: string;
      distance: number;       // hops
      god_score: number;
    };
    siblings_in_community: string[];  // top 3 sibling session IDs
  }
}
```

Enabled by default. `search(..., include_graph: false)` opts out for
latency-sensitive callers.

## New MCP Tools

| Tool | Input | Output | Purpose |
|------|-------|--------|---------|
| `god_nodes_current` | `{ limit? }` | `[{entity, score, degree}]` | "Show me what I've been thinking about most" |
| `session_context` | `{ session_id }` | Community + neighbors + gods | "Put this session in context" |
| `find_path` | `{ from, to }` | Shortest path node list | "How did I get from X to Y?" |
| `evolution_report` | `{ days: 7 }` | God-node delta over N days | "What changed this week?" |
| `community_summary` | `{ community_id? }` | Community entities + sessions | "Show me everything in this cluster" |
| `rebuild_communities` | `{}` | Rebuild status | Manual trigger for full Louvain rerun |

## Database Schema Additions

See `schema.md` for full DDL. Summary of new tables:

- `graph_nodes` (entity_key, label, kind, first_seen, last_seen, degree, god_score, community_id)
- `graph_edges` (source_key, target_key, relation, weight, chunk_count, last_seen)
- `graph_communities` (id, label, size, cohesion, rebuilt_at)
- `graph_meta` (last_community_rebuild, total_nodes, total_edges)

Indexes on `(entity_key)`, `(community_id)`, `(relation, source_key)`.

## Performance Budget

| Operation | Target | Rationale |
|-----------|--------|-----------|
| Per-session graph build | < 2s | Runs inside SessionEnd hook, shouldn't delay user |
| Single search + graph enrichment | < 50ms added | ~15ms per lookup × 3 results |
| Full Louvain rebuild (100 sessions) | < 30s | Background, after new batch |
| `god_nodes_current` | < 100ms | Simple sorted query |
| `find_path` | < 200ms | BFS on ~10k nodes |

## Open Questions

| # | Question | Working answer | Revisit when |
|---|----------|----------------|--------------|
| 1 | Should community labels be auto-generated (LLM) or numeric? | Start numeric ("C12"). Add optional LLM labeling as v0.3.1 feature. | After MVP works |
| 2 | Should graph span all projects or be per-project? | Per-project by default, with optional global view tool. | Implementation start |
| 3 | How to handle stale entities (mentioned once in 2020, never again)? | TTL decay: `god_score *= 0.95^(days_since_last_seen / 30)`. | After 30 days of real usage |
| 4 | Embedding cluster threshold (0.80? 0.85? 0.90?) | Start 0.85, expose as config | Eval pass |
| 5 | Should temporal edges decay? | Yes, half-life 90 days | Implementation |

## Future Work (v0.4+)

- Optional Ollama/local-LLM extraction for higher-quality entity detection
- Optional API-based extraction (paid, opt-in) for best quality
- Cross-project graph unification (meta-graph over all projects)
- Graph visualization exports (HTML similar to graphify's)
- Git commit integration (commit SHAs in graph linked to actual diffs)
- Export to Neo4j / GraphML for power users
- Rationale extraction (why decisions were made) via LLM

## Non-Goals

- Replacing lore's vector search (graph is additive layer)
- LLM calls in the hot path (must stay zero-API-key by default)
- Real-time graph streaming (batched is fine)
- GUI (CLI + MCP tools only)
- Query language (MCP tool set is the interface)
