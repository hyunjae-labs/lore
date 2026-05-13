# lore v0.3 — Decision Log

This is the narrative of *how* this design arrived at its current shape.
Read this when you want context for a specific choice, or when revisiting
the design later. Each decision here was made in a real conversation
session on 2026-04-16.

## Session context

The user (lore's author) was using quant-alpha's trading infrastructure
and had the following exchange that led to v0.3:

1. Ran `/graphify . --update` on the quant-alpha repo — explored how
   graphify structured the code.
2. Asked about using graphify as a RAG replacement — I pushed back:
   it's good for *structure discovery*, not Q&A.
3. Asked about building a graphify-with-embeddings project — I pushed
   back: Microsoft GraphRAG and LightRAG already exist in that space.
4. Pivoted to: "what if we graph-index lore's conversation sessions
   instead?" — I got excited; this is the combination that **nobody
   else does** (because most people don't have a huge local conversation
   corpus).
5. Clarified the source: not lore's DB, but the raw Claude Code data
   at `~/.claude/projects/*.jsonl`.
6. Ran the Stage 1 PoC (65 sessions, quant-alpha). Cross-session
   connections blew past the go/no-go threshold.
7. Asked how to make it autonomous ("like graphify"). I mapped out a
   Chronicle-style separate MCP.
8. Got corrected: the user IS lore's author. Realized this is not
   "build adjacent to lore" — it's "build v0.3 of lore".

This document records the decisions that emerged.

## Decision Log

Entries are chronological within this design session.

### D-01: Use conversation graph on top of lore, not a new product

**Question**: Should this be a separate MCP (`chronicle`), a fork, or a lore feature?

**Decision**: lore feature (v0.3). The user owns lore. Forking would
duplicate vector infra. A new MCP would fragment the user's tools.

**Tradeoff accepted**: lore's scope grows. Becomes "conversation graph
+ search" rather than pure "conversation search". Worth it because
the value is meta, the infrastructure is reusable.

### D-02: Zero LLM calls in v0.3 (extraction via rule + embedding)

**Question**: Graph extraction usually needs LLM. But lore's brand
pillar is "zero API keys, fully local". Which wins?

**Decision**: Rule + embedding extraction for v0.3. LLM extraction is
v0.4 opt-in at most.

**Rationale**:
- lore's positioning ("no data leaves your device") is a market
  differentiator vs GraphRAG/LightRAG. Breaking it costs more than it
  gains.
- PoC used LLM and it worked great. But 80% of the surprise value
  (cross-session links, session hubs) came from graph *structure*,
  not from deep semantic extraction. Rules + embedding clustering can
  reproduce the structure at $0 cost.
- If we need higher quality later, we can add optional local LLM
  (Ollama) or optional paid API — both strictly opt-in.

**Reversal criterion**: If after 1 month of usage, users consistently
ask for better entity detection that regex can't deliver, revisit.

### D-03: Same `lore.db`, new tables (not a separate DB)

**Question**: Put graph data in a new sqlite file, or extend `lore.db`?

**Decision**: Extend `lore.db`. New tables: `graph_nodes`, `graph_edges`,
`graph_communities`, `graph_meta`.

**Rationale**:
- Joins across vector/FTS/graph on single connection are much simpler
- Backup/restore is one file, not two
- Migrations already exist for lore.db; extending is natural
- Size impact is trivial (~1.5KB/session, see `poc-results.md`)

### D-04: Per-project graph, not cross-project

**Question**: Build one unified graph across all 58 projects, or a
graph per project?

**Decision**: Per-project for v0.3. Cross-project meta-graph is v0.4.

**Rationale**:
- Communities across projects would be semantically noisy (e.g.,
  "database migration" in an app project and "migration" in a DevOps
  project don't belong together)
- Single-project is the dominant mental model for the user
- MCP tools become simpler (no `--project` arg needed by default —
  use the caller's `cwd`)

**Future**: a `meta_graph_rebuild` command can join per-project graphs
when desired.

### D-05: Auto-build via existing SessionEnd hook

**Question**: Should graph build be its own hook, a daemon, or integrated
into SessionEnd?

**Decision**: Integrate into SessionEnd. No new process, no new config.

**Rationale**:
- lore already has SessionEnd. Adding a post-step is zero-overhead for
  the user.
- Graph build runs AFTER chunking/embedding → can reuse fresh data.
- If graph build fails, vector indexing already committed — robust.

**Latency budget**: < 2s added per SessionEnd. If that breaks, fall
back to async queue.

### D-06: Incremental nearest-neighbor for new nodes + periodic Louvain

**Question**: Run Louvain on every session (expensive) or on schedule
(stale communities in interim)?

**Decision**: Hybrid. New nodes are immediately placed into the
nearest-neighbor community (cheap, approximate). Full Louvain runs
every 100 new sessions, in background.

**Rationale**:
- Full Louvain costs ~30s for reasonable graphs. Not acceptable on
  every SessionEnd.
- Nearest-neighbor placement is O(N_neighbors) per new node — sub-100ms.
- 100-session threshold chosen so weekly rebuild for power users,
  monthly for casual — feels right, easily tuned.
- User can always force rebuild via `rebuild_communities` MCP tool.

### D-07: Search API stays backward-compatible

**Question**: New enriched `search` or new tool `graph_search`?

**Decision**: Extend existing `search` with optional `graph` field in
response. Add new specialized tools (`god_nodes_current`, etc.) for
graph-first queries.

**Rationale**:
- Existing consumers (Claude Code itself, any agent using lore) keep
  working.
- Users who want raw vector results can pass `include_graph: false`.
- Adds value to every existing use.

### D-08: Sessions themselves are nodes (not just concepts within sessions)

**Key PoC insight**: 4 of top 10 god nodes were entire sessions, not
individual concepts.

**Decision**: Entity extractor produces `session:{id}` node kind by
default. Sessions get edges to every entity they contain.

**Implication**: Cross-session links become natural. "Session A is
semantically similar to Session B" is a first-class edge, not
something users must discover through multi-hop traversal.

### D-09: Temporal adjacency is a first-class edge type

**Key PoC insight**: "Two sessions 2+ weeks apart with same themes"
was the most "wow" finding. Pure similarity missed time dimension.

**Decision**: Add `temporal_adjacent` edge type — same entity appearing
in sessions within 24h of each other creates a weighted edge. Half-life
decay 90 days.

**Rationale**: time matters. Weekend of intense work should be
structurally distinct from a concept that spans months.

### D-10: Reject wrapper-style integration

**Question**: Should graph live as a **wrapper around** lore (thin
shim), or **inside** lore (first-class subsystem)?

**Decision**: Inside lore. Full integration, not a wrapper.

**Rationale**:
- User is lore's author; no coordination cost.
- Shared SQLite connection, shared embedding model — wrapper would
  duplicate these.
- The "autonomous build" constraint (no user command) demands
  integration into the lore lifecycle.

Wrapper was evaluated and rejected. It was my suggestion early in the
session, reasonable under the assumption the user was external to lore.
Corrected as soon as I learned the user IS lore's author.

## Rejected Alternatives

Kept here so we don't relitigate them:

- **LLM-based extraction in v0.3**: see D-02
- **Separate `chronicle` MCP**: see D-01
- **Per-chunk graph nodes (instead of per-entity)**: too many nodes,
  no semantic unit. Entities are the right abstraction.
- **Neo4j / external graph DB**: breaks "fully local / single file"
  pillar. Migration complexity not worth it.
- **Real-time streaming updates**: not needed. SessionEnd granularity
  is perfect.
- **Hard-coded community labels via LLM on rebuild**: deferred to v0.3.1.
  Numeric IDs work for MVP.

## Things Explicitly Deferred to Later Versions

| Feature | Version | Why deferred |
|---------|---------|--------------|
| LLM-based entity extraction (opt-in) | v0.3.1 or v0.4 | MVP works without it per PoC |
| Human-readable community labels (LLM auto-gen) | v0.3.1 | Numeric IDs usable for MVP |
| Cross-project meta-graph | v0.4 | Per-project is 95% of value |
| Graph visualization export (HTML) | v0.4 | CLI + MCP tools sufficient |
| Rationale / decision extraction (why was X done?) | v0.4 | Needs LLM |
| Graph editing via MCP | v0.5 | Read-only is safer for MVP |
| Git commit integration (SHA → actual diff) | v0.4 | Needs git plumbing |

## Open Questions (Carried into Implementation)

These are unresolved. Decisions must happen during coding. Track each
with a short note in a PR description.

1. **Embedding cluster threshold** — start 0.85, expose as config, tune
   after seeing real data.
2. **TTL decay for stale entities** — only matters after months of use.
   Default: `god_score *= 0.95 ^ (days_since_last_seen / 30)`.
3. **Temporal adjacency window** — 24h start. Might be too short for
   casual users (weekend → Monday). Expose as config.
4. **Community label strategy** — numeric IDs for MVP. Top representative
   entity name later. LLM summary later still.
5. **How to version graph schema** — `graph_meta.version` column
   reserved. Migration strategy for structural changes TBD when first
   real schema change lands.

## Summary for the implementer

- You are the lore author. The graph lives inside lore.
- No LLM in the hot path. Regex + embedding clustering.
- Graph builds on SessionEnd, auto-maintains itself, communities
  rebuild every 100 sessions.
- Sessions are first-class nodes; temporal and similarity edges are
  first-class.
- Search response gets additive `graph` field; new MCP tools expose
  god nodes / evolution / paths.
- If something is ambiguous, check `design.md` → if still ambiguous,
  check this `decisions.md` → if still ambiguous, pick the simpler
  option and document your choice as a new decision entry here.
