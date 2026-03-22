import type Database from "better-sqlite3";

export interface ProjectRow {
  id: number;
  dir_name: string;
  path: string;
  name: string;
  created_at: string;
  last_indexed_at: string | null;
}

export interface SessionRow {
  id: number;
  project_id: number;
  session_id: string;
  started_at: string | null;
  ended_at: string | null;
  branch: string | null;
  model: string | null;
  intent: string | null;
  turn_count: number;
  jsonl_path: string;
  jsonl_size: number | null;
  jsonl_mtime: number | null;
  indexed_offset: number;
  indexed_at: string | null;
}

export interface ChunkRow {
  id: number;
  session_id: number;
  chunk_index: number;
  role: string;
  content: string;
  timestamp: string | null;
  turn_start: number | null;
  turn_end: number | null;
  token_count: number | null;
}

export interface SearchResult extends ChunkRow {
  score: number;
  project_name: string;
  project_path: string;
  session_uuid: string;
  branch: string | null;
  model: string | null;
  intent: string | null;
  turn_count: number;
  has_more_before: boolean;
  has_more_after: boolean;
  turn_range: string;
}

export function upsertProject(
  db: Database.Database,
  params: { dir_name: string; path: string; name: string }
): number {
  const stmt = db.prepare(`
    INSERT INTO projects (dir_name, path, name)
    VALUES (@dir_name, @path, @name)
    ON CONFLICT(dir_name) DO UPDATE SET
      path = excluded.path,
      name = excluded.name
    RETURNING id
  `);
  const row = stmt.get(params) as { id: number };
  return row.id;
}

export function upsertSession(
  db: Database.Database,
  params: {
    project_id: number;
    session_id: string;
    started_at?: string | null;
    ended_at?: string | null;
    branch?: string | null;
    model?: string | null;
    intent?: string | null;
    turn_count?: number;
    jsonl_path: string;
    jsonl_size?: number | null;
    jsonl_mtime?: number | null;
  }
): number {
  const stmt = db.prepare(`
    INSERT INTO sessions (
      project_id, session_id, started_at, ended_at, branch, model, intent,
      turn_count, jsonl_path, jsonl_size, jsonl_mtime
    ) VALUES (
      @project_id, @session_id, @started_at, @ended_at, @branch, @model, @intent,
      @turn_count, @jsonl_path, @jsonl_size, @jsonl_mtime
    )
    ON CONFLICT(session_id) DO UPDATE SET
      project_id = excluded.project_id,
      started_at = COALESCE(excluded.started_at, sessions.started_at),
      ended_at = COALESCE(excluded.ended_at, sessions.ended_at),
      branch = COALESCE(excluded.branch, sessions.branch),
      model = COALESCE(excluded.model, sessions.model),
      intent = COALESCE(excluded.intent, sessions.intent),
      turn_count = COALESCE(excluded.turn_count, sessions.turn_count),
      jsonl_path = excluded.jsonl_path,
      jsonl_size = COALESCE(excluded.jsonl_size, sessions.jsonl_size),
      jsonl_mtime = COALESCE(excluded.jsonl_mtime, sessions.jsonl_mtime)
    RETURNING id
  `);
  const row = stmt.get({
    project_id: params.project_id,
    session_id: params.session_id,
    started_at: params.started_at ?? null,
    ended_at: params.ended_at ?? null,
    branch: params.branch ?? null,
    model: params.model ?? null,
    intent: params.intent ?? null,
    turn_count: params.turn_count ?? 0,
    jsonl_path: params.jsonl_path,
    jsonl_size: params.jsonl_size ?? null,
    jsonl_mtime: params.jsonl_mtime ?? null,
  }) as { id: number };
  return row.id;
}

export function insertChunkWithVector(
  db: Database.Database,
  params: {
    session_id: number;
    chunk_index: number;
    role: string;
    content: string;
    timestamp?: string | null;
    turn_start?: number | null;
    turn_end?: number | null;
    token_count?: number | null;
    embedding: Float32Array;
  }
): number {
  const insertChunk = db.prepare(`
    INSERT INTO chunks (session_id, chunk_index, role, content, timestamp, turn_start, turn_end, token_count)
    VALUES (@session_id, @chunk_index, @role, @content, @timestamp, @turn_start, @turn_end, @token_count)
  `);

  const insertVec = db.prepare(`
    INSERT INTO vec_chunks (rowid, embedding)
    VALUES (?, ?)
  `);

  const transaction = db.transaction(() => {
    const result = insertChunk.run({
      session_id: params.session_id,
      chunk_index: params.chunk_index,
      role: params.role,
      content: params.content,
      timestamp: params.timestamp ?? null,
      turn_start: params.turn_start ?? null,
      turn_end: params.turn_end ?? null,
      token_count: params.token_count ?? null,
    });
    const chunkId = result.lastInsertRowid as number;
    // sqlite-vec requires BigInt rowid and Buffer (not ArrayBuffer)
    insertVec.run(BigInt(chunkId), Buffer.from(params.embedding.buffer));
    return chunkId;
  });

  return transaction() as number;
}

export function vectorSearch(
  db: Database.Database,
  params: {
    embedding: Float32Array;
    query: string;
    limit: number;
    projectName?: string;
    sessionId?: string;
    branch?: string;
    after?: string;
    before?: string;
  }
): SearchResult[] {
  const overFetchLimit = params.limit * 5;
  const RRF_K = 60; // Reciprocal Rank Fusion constant

  // Step 1a: Vector search — over-fetch from vec index
  const vecStmt = db.prepare(`
    SELECT rowid, distance
    FROM vec_chunks
    WHERE embedding MATCH ?
    ORDER BY distance ASC
    LIMIT ?
  `);

  const vecRows = vecStmt.all(
    Buffer.from(params.embedding.buffer),
    overFetchLimit
  ) as { rowid: number; distance: number }[];

  // Step 1b: FTS5/BM25 keyword search
  let ftsRows: { rowid: number; rank: number }[] = [];
  try {
    const ftsStmt = db.prepare(`
      SELECT rowid, rank
      FROM chunks_fts
      WHERE chunks_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);
    ftsRows = ftsStmt.all(params.query, overFetchLimit) as { rowid: number; rank: number }[];
  } catch {
    // FTS query syntax error (special characters) — fall back to vec-only
  }

  // Step 1c: Reciprocal Rank Fusion — combine both result sets
  const rrfScores = new Map<number, number>();

  vecRows.forEach((r, i) => {
    rrfScores.set(r.rowid, (rrfScores.get(r.rowid) || 0) + 1 / (RRF_K + i));
  });
  ftsRows.forEach((r, i) => {
    rrfScores.set(r.rowid, (rrfScores.get(r.rowid) || 0) + 1 / (RRF_K + i));
  });

  if (rrfScores.size === 0) return [];

  // Use RRF scores for final ranking
  const allRowids = [...rrfScores.keys()];

  // Step 2: Hydrate with chunk + session + project data (filters pushed into SQL)
  const placeholders = allRowids.map(() => "?").join(",");
  const conditions: string[] = [`c.id IN (${placeholders})`];
  const queryParams: any[] = [...allRowids];

  if (params.projectName) {
    conditions.push(`LOWER(p.name) LIKE ?`);
    queryParams.push(`%${params.projectName.toLowerCase()}%`);
  }
  if (params.sessionId) {
    conditions.push(`s.session_id = ?`);
    queryParams.push(params.sessionId);
  }
  if (params.branch) {
    conditions.push(`s.branch = ?`);
    queryParams.push(params.branch);
  }
  if (params.after) {
    conditions.push(`c.timestamp >= ?`);
    queryParams.push(params.after);
  }
  if (params.before) {
    conditions.push(`c.timestamp <= ?`);
    queryParams.push(params.before);
  }

  const hydrationSql = `
    SELECT
      c.id, c.session_id, c.chunk_index, c.role, c.content,
      c.timestamp, c.turn_start, c.turn_end, c.token_count,
      p.name AS project_name, p.path AS project_path,
      s.session_id AS session_uuid, s.branch, s.model, s.intent, s.turn_count
    FROM chunks c
    JOIN sessions s ON c.session_id = s.id
    JOIN projects p ON s.project_id = p.id
    WHERE ${conditions.join(" AND ")}
  `;

  const filtered = db.prepare(hydrationSql).all(...queryParams) as (ChunkRow & {
    project_name: string;
    project_path: string;
    session_uuid: string;
    branch: string | null;
    model: string | null;
    intent: string | null;
    turn_count: number;
  })[];

  // Step 4: Check adjacent chunks existence
  const hasAdjacentStmt = db.prepare(`
    SELECT 1 FROM chunks WHERE session_id = ? AND chunk_index = ? LIMIT 1
  `);

  // Step 5: Build results with RRF score, has_more, turn_range
  // Normalize RRF scores to 0-1 range
  const maxRrf = Math.max(...filtered.map(r => rrfScores.get(r.id) || 0), 0.001);

  const results: SearchResult[] = filtered.map((row) => {
    const rrfScore = rrfScores.get(row.id) || 0;
    const score = Math.round((rrfScore / maxRrf) * 100) / 100;

    const hasBefore = hasAdjacentStmt.get(row.session_id, row.chunk_index - 1) !== undefined;
    const hasAfter = hasAdjacentStmt.get(row.session_id, row.chunk_index + 1) !== undefined;

    const turnStart = row.turn_start ?? "?";
    const turnEnd = row.turn_end ?? "?";
    const turn_range =
      turnStart === turnEnd ? `turn ${turnStart}` : `turns ${turnStart}-${turnEnd}`;

    return {
      ...row,
      score,
      has_more_before: hasBefore,
      has_more_after: hasAfter,
      turn_range,
    };
  });

  // Step 6: Sort by score desc, slice to limit
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, params.limit);
}

export function updateSessionMetadata(
  db: Database.Database,
  params: {
    session_id: number;
    indexed_offset: number;
    indexed_at: string;
    turn_count?: number;
    started_at?: string | null;
    ended_at?: string | null;
    branch?: string | null;
    model?: string | null;
    intent?: string | null;
    jsonl_size?: number | null;
    jsonl_mtime?: number | null;
  }
): void {
  db.prepare(`
    UPDATE sessions SET
      indexed_offset = @indexed_offset,
      indexed_at = @indexed_at,
      turn_count = COALESCE(@turn_count, turn_count),
      started_at = COALESCE(@started_at, started_at),
      ended_at = COALESCE(@ended_at, ended_at),
      branch = COALESCE(@branch, branch),
      model = COALESCE(@model, model),
      intent = COALESCE(@intent, intent),
      jsonl_size = COALESCE(@jsonl_size, jsonl_size),
      jsonl_mtime = COALESCE(@jsonl_mtime, jsonl_mtime)
    WHERE id = @session_id
  `).run({
    session_id: params.session_id,
    indexed_offset: params.indexed_offset,
    indexed_at: params.indexed_at,
    turn_count: params.turn_count ?? null,
    started_at: params.started_at ?? null,
    ended_at: params.ended_at ?? null,
    branch: params.branch ?? null,
    model: params.model ?? null,
    intent: params.intent ?? null,
    jsonl_size: params.jsonl_size ?? null,
    jsonl_mtime: params.jsonl_mtime ?? null,
  });
}

export function getAdjacentChunks(
  db: Database.Database,
  params: {
    session_id: number;
    chunk_index: number;
    before?: number;
    after?: number;
  }
): { before: ChunkRow[]; after: ChunkRow[] } {
  const beforeCount = params.before ?? 2;
  const afterCount = params.after ?? 2;

  const beforeStmt = db.prepare(`
    SELECT id, session_id, chunk_index, role, content, timestamp, turn_start, turn_end, token_count
    FROM chunks
    WHERE session_id = ? AND chunk_index < ?
    ORDER BY chunk_index DESC
    LIMIT ?
  `);

  const afterStmt = db.prepare(`
    SELECT id, session_id, chunk_index, role, content, timestamp, turn_start, turn_end, token_count
    FROM chunks
    WHERE session_id = ? AND chunk_index > ?
    ORDER BY chunk_index ASC
    LIMIT ?
  `);

  const beforeRows = (
    beforeStmt.all(params.session_id, params.chunk_index, beforeCount) as ChunkRow[]
  ).reverse();

  const afterRows = afterStmt.all(
    params.session_id,
    params.chunk_index,
    afterCount
  ) as ChunkRow[];

  return { before: beforeRows, after: afterRows };
}

export function getSessionCount(db: Database.Database): number {
  const row = db.prepare("SELECT COUNT(*) as count FROM sessions").get() as {
    count: number;
  };
  return row.count;
}

export function getIndexedSessionCount(db: Database.Database): number {
  const row = db
    .prepare("SELECT COUNT(*) as count FROM sessions WHERE indexed_at IS NOT NULL")
    .get() as { count: number };
  return row.count;
}

export function deleteSessionChunks(
  db: Database.Database,
  sessionId: number
): void {
  const getChunkIds = db.prepare(
    "SELECT id FROM chunks WHERE session_id = ?"
  );
  const chunkIds = (getChunkIds.all(sessionId) as { id: number }[]).map(
    (r) => r.id
  );

  const transaction = db.transaction(() => {
    if (chunkIds.length > 0) {
      const placeholders = chunkIds.map(() => "?").join(",");
      db.prepare(`DELETE FROM vec_chunks WHERE rowid IN (${placeholders})`).run(
        ...chunkIds
      );
    }
    db.prepare("DELETE FROM chunks WHERE session_id = ?").run(sessionId);
  });

  transaction();
}
