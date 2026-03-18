import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { SCHEMA_SQL, VEC_TABLE_SQL } from "../src/db/schema.js";
import {
  upsertProject,
  upsertSession,
  insertChunkWithVector,
  updateSessionMetadata,
} from "../src/db/queries.js";
import { handleGetContext } from "../src/tools/get-context.js";

// ── helpers ─────────────────────────────────────────────────────────────────

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  sqliteVec.load(db);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA_SQL);
  db.exec(VEC_TABLE_SQL);
  return db;
}

interface SeedResult {
  sessionDbId: number;
  chunkIds: number[];
}

/**
 * Seeds a project + session with `chunkCount` sequential chunks.
 * Returns the session DB id and an array of chunk IDs in order.
 */
function seedSession(
  db: Database.Database,
  opts: {
    projectDirName: string;
    projectName: string;
    projectPath: string;
    sessionUuid: string;
    chunkCount: number;
    indexed?: boolean;
  }
): SeedResult {
  const projectId = upsertProject(db, {
    dir_name: opts.projectDirName,
    path: opts.projectPath,
    name: opts.projectName,
  });

  const sessionDbId = upsertSession(db, {
    project_id: projectId,
    session_id: opts.sessionUuid,
    jsonl_path: `${opts.projectPath}/${opts.sessionUuid}.jsonl`,
    branch: "main",
    model: "claude-3-5-sonnet",
    intent: "test session",
  });

  const chunkIds: number[] = [];
  for (let i = 0; i < opts.chunkCount; i++) {
    const id = insertChunkWithVector(db, {
      session_id: sessionDbId,
      chunk_index: i,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Chunk content ${i}`,
      embedding: new Float32Array(384).fill(i * 0.05),
      timestamp: `2024-01-${String(i + 1).padStart(2, "0")}T10:00:00.000Z`,
    });
    chunkIds.push(id);
  }

  if (opts.indexed !== false) {
    updateSessionMetadata(db, {
      session_id: sessionDbId,
      indexed_offset: 100,
      indexed_at: new Date().toISOString(),
    });
  }

  return { sessionDbId, chunkIds };
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("handleGetContext", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
  });

  // ── 1. Returns anchor + before + after with default direction "both" ──────

  it("returns anchor with before and after chunks (direction: both)", async () => {
    const { chunkIds } = seedSession(db, {
      projectDirName: "-Users-test-ctx",
      projectName: "ctx-project",
      projectPath: "/Users/test/ctx-project",
      sessionUuid: "ctx-session-uuid-0001",
      chunkCount: 5,
    });

    // chunk index 2 is the middle chunk (chunkIds[2])
    const response = await handleGetContext(db, { chunk_id: chunkIds[2] });

    expect(response.content).toHaveLength(1);
    expect(response.content[0].type).toBe("text");

    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.anchor).toBeDefined();
    expect(parsed.anchor.chunk_id).toBe(chunkIds[2]);
    expect(parsed.anchor.content).toBe("Chunk content 2");
    expect(parsed.anchor.role).toBe("user"); // index 2 is even → user

    // Default count is 3, but only 2 exist before index 2
    expect(Array.isArray(parsed.before)).toBe(true);
    expect(Array.isArray(parsed.after)).toBe(true);
    expect(parsed.before.length).toBe(2);
    expect(parsed.after.length).toBe(2);
  });

  // ── 2. Respects direction "before" ────────────────────────────────────────

  it("returns only before chunks when direction is 'before'", async () => {
    const { chunkIds } = seedSession(db, {
      projectDirName: "-Users-test-ctx-b",
      projectName: "ctx-project-b",
      projectPath: "/Users/test/ctx-project-b",
      sessionUuid: "ctx-session-uuid-0002",
      chunkCount: 5,
    });

    const response = await handleGetContext(db, {
      chunk_id: chunkIds[3],
      direction: "before",
      count: 2,
    });

    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.before.length).toBe(2);
    expect(parsed.after.length).toBe(0);
  });

  // ── 3. Respects direction "after" ─────────────────────────────────────────

  it("returns only after chunks when direction is 'after'", async () => {
    const { chunkIds } = seedSession(db, {
      projectDirName: "-Users-test-ctx-a",
      projectName: "ctx-project-a",
      projectPath: "/Users/test/ctx-project-a",
      sessionUuid: "ctx-session-uuid-0003",
      chunkCount: 5,
    });

    const response = await handleGetContext(db, {
      chunk_id: chunkIds[1],
      direction: "after",
      count: 2,
    });

    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.before.length).toBe(0);
    expect(parsed.after.length).toBe(2);
  });

  // ── 4. Respects count parameter ──────────────────────────────────────────

  it("limits chunks by count parameter", async () => {
    const { chunkIds } = seedSession(db, {
      projectDirName: "-Users-test-ctx-c",
      projectName: "ctx-project-c",
      projectPath: "/Users/test/ctx-project-c",
      sessionUuid: "ctx-session-uuid-0004",
      chunkCount: 9,
    });

    const response = await handleGetContext(db, {
      chunk_id: chunkIds[4], // middle chunk with 4 before and 4 after
      direction: "both",
      count: 2,
    });

    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.before.length).toBe(2);
    expect(parsed.after.length).toBe(2);
  });

  // ── 5. Caps count at 10 ──────────────────────────────────────────────────

  it("caps count at 10 even when higher value is passed", async () => {
    const { chunkIds } = seedSession(db, {
      projectDirName: "-Users-test-ctx-cap",
      projectName: "ctx-cap",
      projectPath: "/Users/test/ctx-cap",
      sessionUuid: "ctx-session-uuid-0005",
      chunkCount: 25,
    });

    const response = await handleGetContext(db, {
      chunk_id: chunkIds[12],
      direction: "both",
      count: 999,
    });

    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.before.length).toBeLessThanOrEqual(10);
    expect(parsed.after.length).toBeLessThanOrEqual(10);
  });

  // ── 6. Returns error when chunk_id is missing ─────────────────────────────

  it("returns error when chunk_id is 0 (falsy)", async () => {
    const response = await handleGetContext(db, { chunk_id: 0 });
    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.error).toMatch(/chunk_id is required/i);
  });

  // ── 7. Returns error when chunk not found ─────────────────────────────────

  it("returns error when chunk_id does not exist", async () => {
    const response = await handleGetContext(db, { chunk_id: 999999 });
    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.error).toMatch(/chunk not found/i);
  });

  // ── 8. Includes session_id and project in result ─────────────────────────

  it("includes session_id and project in the result", async () => {
    const { chunkIds } = seedSession(db, {
      projectDirName: "-Users-test-meta",
      projectName: "meta-project",
      projectPath: "/Users/test/meta-project",
      sessionUuid: "meta-session-uuid-abcd",
      chunkCount: 3,
    });

    const response = await handleGetContext(db, { chunk_id: chunkIds[1] });
    const parsed = JSON.parse(response.content[0].text);

    expect(parsed.session_id).toBe("meta-session-uuid-abcd");
    expect(parsed.project).toBe("/Users/test/meta-project");
  });

  // ── 9. Result chunks have expected fields ────────────────────────────────

  it("result chunks include chunk_id, content, timestamp, role", async () => {
    const { chunkIds } = seedSession(db, {
      projectDirName: "-Users-test-fields",
      projectName: "fields-project",
      projectPath: "/Users/test/fields-project",
      sessionUuid: "fields-session-uuid",
      chunkCount: 3,
    });

    const response = await handleGetContext(db, {
      chunk_id: chunkIds[1],
      direction: "both",
      count: 1,
    });

    const parsed = JSON.parse(response.content[0].text);
    const allChunks = [parsed.anchor, ...parsed.before, ...parsed.after];

    for (const chunk of allChunks) {
      expect(typeof chunk.chunk_id).toBe("number");
      expect(typeof chunk.content).toBe("string");
      expect(typeof chunk.role).toBe("string");
      // timestamp can be string or null
      expect("timestamp" in chunk).toBe(true);
    }
  });

  // ── 10. Works at boundary (first chunk) ─────────────────────────────────

  it("returns empty before array when chunk is first in session", async () => {
    const { chunkIds } = seedSession(db, {
      projectDirName: "-Users-test-first",
      projectName: "first-project",
      projectPath: "/Users/test/first-project",
      sessionUuid: "first-session-uuid",
      chunkCount: 4,
    });

    const response = await handleGetContext(db, {
      chunk_id: chunkIds[0],
      direction: "both",
      count: 3,
    });

    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.before.length).toBe(0);
    expect(parsed.after.length).toBe(3);
  });
});
