export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  dir_name TEXT UNIQUE NOT NULL,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_indexed_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  session_id TEXT UNIQUE NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  branch TEXT,
  model TEXT,
  intent TEXT,
  turn_count INTEGER DEFAULT 0,
  jsonl_path TEXT NOT NULL,
  jsonl_size INTEGER,
  jsonl_mtime REAL,
  indexed_offset INTEGER DEFAULT 0,
  indexed_at TEXT
);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  chunk_index INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp TEXT,
  turn_start INTEGER,
  turn_end INTEGER,
  token_count INTEGER
);

CREATE INDEX IF NOT EXISTS idx_chunks_session ON chunks(session_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_session_id ON sessions(session_id);
`;

export const VEC_TABLE_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
  embedding FLOAT[384]
);
`;

export const FTS_TABLE_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  content,
  content=chunks,
  content_rowid=id
);

-- Triggers to keep FTS in sync with chunks table
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.id, old.content);
  INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
END;
`;
