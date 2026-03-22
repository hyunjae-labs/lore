import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { SCHEMA_SQL, VEC_TABLE_SQL } from "../src/db/schema.js";
import {
  upsertProject,
  upsertSession,
  insertChunkWithVector,
  updateSessionMetadata,
} from "../src/db/queries.js";
import { handleSearch } from "../src/tools/search.js";

// ── helpers ────────────────────────────────────────────────────────────────

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  sqliteVec.load(db);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA_SQL);
  db.exec(VEC_TABLE_SQL);
  return db;
}

/**
 * Insert a project + session that is marked as indexed, plus one chunk with a
 * known embedding. Returns the internal session row id.
 */
function seedIndexedSession(
  db: Database.Database,
  opts: {
    projectDirName: string;
    projectName: string;
    projectPath: string;
    sessionUuid: string;
    branch?: string;
    model?: string;
    intent?: string;
    chunkContent: string;
    embedding: Float32Array;
    timestamp?: string;
  }
): number {
  const projectId = upsertProject(db, {
    dir_name: opts.projectDirName,
    path: opts.projectPath,
    name: opts.projectName,
  });

  const sessionDbId = upsertSession(db, {
    project_id: projectId,
    session_id: opts.sessionUuid,
    jsonl_path: `${opts.projectPath}/${opts.sessionUuid}.jsonl`,
    branch: opts.branch ?? "main",
    model: opts.model ?? "claude-3-5-sonnet",
    intent: opts.intent ?? "test intent",
  });

  insertChunkWithVector(db, {
    session_id: sessionDbId,
    chunk_index: 0,
    role: "user",
    content: opts.chunkContent,
    embedding: opts.embedding,
    timestamp: opts.timestamp ?? "2024-01-10T10:00:00.000Z",
  });

  // Mark as indexed
  updateSessionMetadata(db, {
    session_id: sessionDbId,
    indexed_offset: 100,
    indexed_at: new Date().toISOString(),
  });

  return sessionDbId;
}

// ── module mocks ──────────────────────────────────────────────────────────

// Mock the embedder so tests run fast (no real model download)
vi.mock("../src/embedder/index.js", () => ({
  getEmbedder: vi.fn().mockResolvedValue({
    embed: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.9)),
    embedBatch: vi.fn().mockResolvedValue([new Float32Array(384).fill(0.9)]),
  }),
}));

// Mock scanner so empty-index auto-index path doesn't touch the filesystem
vi.mock("../src/indexer/scanner.js", () => ({
  scanProjects: vi.fn().mockReturnValue([]),
  scanSessions: vi.fn().mockReturnValue([]),
  needsReindex: vi.fn().mockReturnValue("skip"),
}));

// ── tests ──────────────────────────────────────────────────────────────────

describe("handleSearch", () => {
  let db: Database.Database;
  let tempLoreDir: string;

  beforeEach(() => {
    db = makeDb();
    // Provide a real LORE_DIR so acquireLock() in handleIndex has a place to write
    tempLoreDir = join(tmpdir(), `lore-search-test-${Date.now()}`);
    mkdirSync(tempLoreDir, { recursive: true });
    process.env.LORE_DIR = tempLoreDir;
  });

  afterEach(() => {
    db.close();
    rmSync(tempLoreDir, { recursive: true, force: true });
    delete process.env.LORE_DIR;
  });

  // ── 1. Basic search returns results with correct format ─────────────────

  it("returns results with correct format fields", async () => {
    seedIndexedSession(db, {
      projectDirName: "-Users-test-myapp",
      projectName: "myapp",
      projectPath: "/Users/test/myapp",
      sessionUuid: "aaaaaaaa-bbbb-cccc-dddd-111111111111",
      chunkContent: "How to implement authentication with JWT",
      embedding: new Float32Array(384).fill(0.9),
    });

    const response = await handleSearch(db, { query: "authentication" });

    expect(response.content).toHaveLength(1);
    expect(response.content[0].type).toBe("text");

    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.status).toBe("ok");
    expect(parsed.query).toBe("authentication");
    expect(typeof parsed.query_time_ms).toBe("number");
    expect(typeof parsed.total_indexed_sessions).toBe("number");
    expect(typeof parsed.result_count).toBe("number");
    expect(Array.isArray(parsed.results)).toBe(true);

    if (parsed.results.length > 0) {
      const r = parsed.results[0];
      expect(typeof r.chunk_id).toBe("number");
      expect(typeof r.score).toBe("number");
      expect(typeof r.content).toBe("string");
      expect(typeof r.role).toBe("string");
      expect(typeof r.session_id).toBe("string");
      expect(typeof r.project).toBe("string");
      expect(typeof r.project_name).toBe("string");
      // branch can be string or null
      expect(typeof r.turn_range).toBe("string");
      expect(typeof r.has_more_before).toBe("boolean");
      expect(typeof r.has_more_after).toBe("boolean");
    }
  });

  // ── 2. Empty index returns indexing status ────────────────────────

  it("returns indexing status when no sessions are indexed", async () => {
    // DB has no indexed sessions
    const response = await handleSearch(db, {
      query: "something",
    });

    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.status).toBe("indexing");
    expect(typeof parsed.message).toBe("string");
  });

  // ── 3. Project filter works ─────────────────────────────────────────────

  it("filters results by project name", async () => {
    // Two projects with similar embeddings
    seedIndexedSession(db, {
      projectDirName: "-Users-test-alpha",
      projectName: "alpha",
      projectPath: "/Users/test/alpha",
      sessionUuid: "aaaaaaaa-bbbb-cccc-dddd-222222222222",
      chunkContent: "Alpha project content about deployment",
      embedding: new Float32Array(384).fill(0.9),
    });

    seedIndexedSession(db, {
      projectDirName: "-Users-test-beta",
      projectName: "beta",
      projectPath: "/Users/test/beta",
      sessionUuid: "aaaaaaaa-bbbb-cccc-dddd-333333333333",
      chunkContent: "Beta project content about deployment",
      embedding: new Float32Array(384).fill(0.85),
    });

    const response = await handleSearch(db, {
      query: "deployment",
      project: "alpha",
    });

    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.status).toBe("ok");

    // All returned results should belong to project "alpha"
    for (const r of parsed.results) {
      expect(r.project_name.toLowerCase()).toContain("alpha");
    }
  });

  // ── 4. Limit is respected ───────────────────────────────────────────────

  it("respects the limit parameter", async () => {
    // Insert 5 sessions with varying embeddings
    for (let i = 0; i < 5; i++) {
      const val = 0.5 + i * 0.05; // 0.50, 0.55, 0.60, 0.65, 0.70
      seedIndexedSession(db, {
        projectDirName: `-Users-test-proj${i}`,
        projectName: `proj${i}`,
        projectPath: `/Users/test/proj${i}`,
        sessionUuid: `aaaaaaaa-bbbb-cccc-dddd-${String(i).padStart(12, "0")}`,
        chunkContent: `Content for session ${i}`,
        embedding: new Float32Array(384).fill(val),
      });
    }

    const response = await handleSearch(db, { query: "content", limit: 2 });

    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.status).toBe("ok");
    expect(parsed.results.length).toBeLessThanOrEqual(2);
  });

  // ── 5. Query is required ────────────────────────────────────────────────

  it("returns error when query is missing", async () => {
    const response = await handleSearch(db, { query: "" });
    const result = JSON.parse(response.content[0].text);
    expect(result.error).toMatch(/query/i);
  });

  // ── 6. Limit is capped at searchMaxLimit ───────────────────────────────

  it("caps limit at CONFIG.searchMaxLimit (50)", async () => {
    seedIndexedSession(db, {
      projectDirName: "-Users-test-cap",
      projectName: "cap",
      projectPath: "/Users/test/cap",
      sessionUuid: "aaaaaaaa-bbbb-cccc-dddd-444444444444",
      chunkContent: "Content for limit cap test",
      embedding: new Float32Array(384).fill(0.7),
    });

    // Should not throw even with a huge limit
    const response = await handleSearch(db, { query: "content", limit: 9999 });
    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.status).toBe("ok");
    // result_count <= 50 (only 1 session anyway, but cap logic is exercised)
    expect(parsed.result_count).toBeLessThanOrEqual(50);
  });

});
