# lore v0.3 — Database Schema Additions

All new tables go into the existing `~/.lore/lore.db`. No separate database.
Migration file: `src/db/migrations/003-graph-tables.ts`.

## New Tables

### `graph_nodes`

One row per extracted entity (concept, file, EXP-ID, etc.).

```sql
CREATE TABLE graph_nodes (
  entity_key     TEXT PRIMARY KEY,     -- e.g. 'exp:EXP-076', 'file:scripts/exp110.py'
  label          TEXT NOT NULL,        -- human-readable: 'EXP-076', 'scripts/exp110.py'
  kind           TEXT NOT NULL,        -- 'exp', 'file', 'commit', 'class', 'concept', 'metric', 'custom'
  source_chunks  TEXT NOT NULL,        -- JSON array of chunk IDs where entity appeared
  first_seen_ts  INTEGER NOT NULL,     -- unix ms
  last_seen_ts   INTEGER NOT NULL,     -- unix ms
  session_count  INTEGER DEFAULT 0,    -- sessions containing this entity
  degree         INTEGER DEFAULT 0,    -- graph degree, updated on commit
  god_score      REAL DEFAULT 0.0,     -- centrality score, updated on community rebuild
  community_id   INTEGER,              -- FK graph_communities(id), nullable before first cluster
  project        TEXT NOT NULL         -- project this entity lives in (FK by name)
);

CREATE INDEX idx_graph_nodes_kind       ON graph_nodes(kind);
CREATE INDEX idx_graph_nodes_community  ON graph_nodes(community_id);
CREATE INDEX idx_graph_nodes_project    ON graph_nodes(project);
CREATE INDEX idx_graph_nodes_god_score  ON graph_nodes(god_score DESC);
CREATE INDEX idx_graph_nodes_last_seen  ON graph_nodes(last_seen_ts DESC);
```

**Entity key convention**: `{kind}:{canonical_name}` — globally unique within project.
Canonicalization rules:
- `exp`: lowercase the letter suffix (EXP-107c, not EXP-107C)
- `file`: repo-relative path, forward slashes, no leading `./`
- `commit`: 10-char prefix
- `class`: PascalCase as found
- `concept`: lowercase underscored (derived from embedding cluster label)
- `metric`: lowercase (`sharpe`, `mdd`)
- `custom`: user pattern name + slug

### `graph_edges`

Directional edge with relation kind.

```sql
CREATE TABLE graph_edges (
  source_key    TEXT NOT NULL,
  target_key    TEXT NOT NULL,
  relation      TEXT NOT NULL,   -- 'co_occurs' | 'similar' | 'temporal' | 'references'
  weight        REAL NOT NULL,   -- see design.md edge builder section
  chunk_count   INTEGER DEFAULT 1,
  first_seen_ts INTEGER NOT NULL,
  last_seen_ts  INTEGER NOT NULL,
  PRIMARY KEY (source_key, target_key, relation),
  FOREIGN KEY (source_key) REFERENCES graph_nodes(entity_key) ON DELETE CASCADE,
  FOREIGN KEY (target_key) REFERENCES graph_nodes(entity_key) ON DELETE CASCADE
);

CREATE INDEX idx_graph_edges_source    ON graph_edges(source_key);
CREATE INDEX idx_graph_edges_target    ON graph_edges(target_key);
CREATE INDEX idx_graph_edges_relation  ON graph_edges(relation);
CREATE INDEX idx_graph_edges_weight    ON graph_edges(weight DESC);
```

**Undirected storage**: for symmetric relations (`similar`, `co_occurs`) store
the edge once with `source_key < target_key` (lexicographic). Query helper
reads both directions via UNION.

### `graph_communities`

Louvain community metadata.

```sql
CREATE TABLE graph_communities (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  label           TEXT,                     -- optional human label (v0.3.1+ LLM-generated)
  project         TEXT NOT NULL,
  size            INTEGER DEFAULT 0,
  cohesion        REAL DEFAULT 0.0,         -- modularity contribution
  rebuilt_at      INTEGER NOT NULL,         -- unix ms of last Louvain run
  representative_entities TEXT              -- JSON array of top 5 entity_keys by degree
);

CREATE INDEX idx_graph_communities_project ON graph_communities(project);
CREATE INDEX idx_graph_communities_size    ON graph_communities(size DESC);
```

### `graph_meta`

Single-row table tracking build state.

```sql
CREATE TABLE graph_meta (
  project                TEXT PRIMARY KEY,
  total_nodes            INTEGER DEFAULT 0,
  total_edges            INTEGER DEFAULT 0,
  total_communities      INTEGER DEFAULT 0,
  last_full_rebuild_ts   INTEGER,
  sessions_since_rebuild INTEGER DEFAULT 0,
  version                INTEGER NOT NULL DEFAULT 1
);
```

`sessions_since_rebuild` increments on each SessionEnd. When it hits the
rebuild threshold (default 100), full Louvain runs and this resets to 0.

## Migration Strategy

### `003-graph-tables.ts`

```typescript
export const migration003 = {
  version: 3,
  name: 'graph-tables',
  up: async (db: Database) => {
    await db.exec(`
      CREATE TABLE graph_nodes (...);
      CREATE TABLE graph_edges (...);
      CREATE TABLE graph_communities (...);
      CREATE TABLE graph_meta (...);
      -- indexes as listed above
    `);
    // Seed graph_meta for existing projects
    const projects = await db.all(`SELECT DISTINCT project FROM sessions`);
    for (const p of projects) {
      await db.run(
        `INSERT INTO graph_meta (project, version) VALUES (?, 1)`,
        [p.project]
      );
    }
  },
  down: async (db: Database) => {
    await db.exec(`
      DROP TABLE IF EXISTS graph_edges;
      DROP TABLE IF EXISTS graph_nodes;
      DROP TABLE IF EXISTS graph_communities;
      DROP TABLE IF EXISTS graph_meta;
    `);
  }
};
```

**Important**: migration does NOT backfill existing sessions. v0.3 builds
the graph going forward. Optional one-time backfill command:

```bash
getlore graph rebuild --project quant-alpha --all-sessions
```

This scans existing chunks, extracts entities, builds edges, runs Louvain.
Can take 10+ min for projects with 1000s of sessions — documented as
one-time cost.

## Size Estimate

From PoC (65 sessions, quant-alpha):
- 295 entity nodes → ~60KB
- 286 edges → ~30KB
- 39 communities → ~5KB
- Total graph addition: ~100KB per 65 sessions → ~1.5KB per session avg

Extrapolating to 1200 sessions across all projects: **+2MB** over the
current ~60MB `lore.db`. Negligible.

## Query Patterns (for MCP tool implementation)

### Get god nodes for current project
```sql
SELECT entity_key, label, god_score, degree
FROM graph_nodes
WHERE project = ? AND god_score > 0
ORDER BY god_score DESC
LIMIT ?;
```

### Get session context (community + gods + neighbors)
```sql
-- 1. Find community of entities in this session
SELECT DISTINCT community_id
FROM graph_nodes
WHERE entity_key IN (
  SELECT entity_key FROM graph_nodes
  WHERE json_each.value IN (SELECT value FROM json_each(?))  -- chunk IDs of session
);

-- 2. Top entities in that community
SELECT entity_key, label, god_score
FROM graph_nodes
WHERE community_id = ?
ORDER BY god_score DESC
LIMIT 10;
```

### Find shortest path
JS-side BFS using in-memory adjacency list loaded from `graph_edges`. Don't
write recursive CTEs in SQLite — they're painful for this.

### Evolution report (god shift over N days)
```sql
-- Current gods
SELECT entity_key, god_score FROM graph_nodes
WHERE project = ? ORDER BY god_score DESC LIMIT 10;

-- Historical snapshot: separate table `graph_god_history` (see future work)
```

v0.3 MVP can compare "now" vs "last community rebuild" (stored in
`graph_meta.last_full_rebuild_ts`). Full history table is v0.3.1.
