import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDb, closeDb } from "../src/db/index.js";
import {
  upsertProject,
  upsertSession,
  insertChunkWithVector,
  getAdjacentChunks,
  deleteSessionChunks,
  vectorSearch,
} from "../src/db/queries.js";
import Database from "better-sqlite3";

describe("Database", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = getDb(":memory:");
  });

  afterEach(() => {
    closeDb();
  });

  it("creates all tables", () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("projects");
    expect(names).toContain("sessions");
    expect(names).toContain("chunks");
  });

  it("creates vec_chunks virtual table", () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='vec_chunks'"
    ).all();
    expect(tables.length).toBe(1);
  });

  it("sets WAL journal mode or acknowledges memory mode", () => {
    const result = db.pragma("journal_mode") as { journal_mode: string }[];
    // :memory: databases may use "memory" journal mode instead of "wal"
    expect(["wal", "memory"]).toContain(result[0].journal_mode);
  });

  describe("upsertProject", () => {
    it("creates and returns id", () => {
      const id = upsertProject(db, {
        dir_name: "my-project",
        path: "/home/user/my-project",
        name: "My Project",
      });
      expect(typeof id).toBe("number");
      expect(id).toBeGreaterThan(0);
    });

    it("updates on conflict and returns same id", () => {
      const id1 = upsertProject(db, {
        dir_name: "my-project",
        path: "/home/user/my-project",
        name: "My Project",
      });
      const id2 = upsertProject(db, {
        dir_name: "my-project",
        path: "/home/user/my-project-updated",
        name: "My Project Updated",
      });
      expect(id1).toBe(id2);

      const row = db
        .prepare("SELECT * FROM projects WHERE id = ?")
        .get(id1) as { path: string; name: string };
      expect(row.path).toBe("/home/user/my-project-updated");
      expect(row.name).toBe("My Project Updated");
    });
  });

  describe("upsertSession", () => {
    let projectId: number;

    beforeEach(() => {
      projectId = upsertProject(db, {
        dir_name: "test-project",
        path: "/home/user/test-project",
        name: "Test Project",
      });
    });

    it("creates and returns id", () => {
      const id = upsertSession(db, {
        project_id: projectId,
        session_id: "abc-123-uuid",
        jsonl_path: "/path/to/session.jsonl",
      });
      expect(typeof id).toBe("number");
      expect(id).toBeGreaterThan(0);
    });

    it("updates on conflict and returns same id", () => {
      const id1 = upsertSession(db, {
        project_id: projectId,
        session_id: "abc-123-uuid",
        jsonl_path: "/path/to/session.jsonl",
        branch: "main",
      });
      const id2 = upsertSession(db, {
        project_id: projectId,
        session_id: "abc-123-uuid",
        jsonl_path: "/path/to/session.jsonl",
        model: "claude-3-5-sonnet",
      });
      expect(id1).toBe(id2);
    });
  });

  describe("insertChunkWithVector", () => {
    let projectId: number;
    let sessionId: number;

    beforeEach(() => {
      projectId = upsertProject(db, {
        dir_name: "test-project",
        path: "/home/user/test-project",
        name: "Test Project",
      });
      sessionId = upsertSession(db, {
        project_id: projectId,
        session_id: "chunk-test-session",
        jsonl_path: "/path/to/session.jsonl",
      });
    });

    it("stores chunk and vector atomically", () => {
      const embedding = new Float32Array(384).fill(0.1);
      const chunkId = insertChunkWithVector(db, {
        session_id: sessionId,
        chunk_index: 0,
        role: "user",
        content: "Hello, how are you?",
        embedding,
      });

      expect(typeof chunkId).toBe("number");
      expect(chunkId).toBeGreaterThan(0);

      // Verify chunk exists in DB
      const chunk = db
        .prepare("SELECT * FROM chunks WHERE id = ?")
        .get(chunkId) as { content: string; role: string };
      expect(chunk).toBeDefined();
      expect(chunk.content).toBe("Hello, how are you?");
      expect(chunk.role).toBe("user");

      // Verify vector exists in vec_chunks with same rowid
      const vecRow = db
        .prepare("SELECT rowid FROM vec_chunks WHERE rowid = ?")
        .get(chunkId) as { rowid: number } | undefined;
      expect(vecRow).toBeDefined();
      expect(vecRow?.rowid).toBe(chunkId);
    });

    it("stores multiple chunks with aligned rowids", () => {
      const embedding1 = new Float32Array(384).fill(0.1);
      const embedding2 = new Float32Array(384).fill(0.2);

      const id1 = insertChunkWithVector(db, {
        session_id: sessionId,
        chunk_index: 0,
        role: "user",
        content: "First chunk",
        embedding: embedding1,
      });

      const id2 = insertChunkWithVector(db, {
        session_id: sessionId,
        chunk_index: 1,
        role: "assistant",
        content: "Second chunk",
        embedding: embedding2,
      });

      expect(id2).toBeGreaterThan(id1);

      // Both rowids should align
      const vec1 = db.prepare("SELECT rowid FROM vec_chunks WHERE rowid = ?").get(id1);
      const vec2 = db.prepare("SELECT rowid FROM vec_chunks WHERE rowid = ?").get(id2);
      expect(vec1).toBeDefined();
      expect(vec2).toBeDefined();
    });
  });

  describe("getAdjacentChunks", () => {
    let projectId: number;
    let sessionId: number;

    beforeEach(() => {
      projectId = upsertProject(db, {
        dir_name: "adjacent-test",
        path: "/home/user/adjacent-test",
        name: "Adjacent Test",
      });
      sessionId = upsertSession(db, {
        project_id: projectId,
        session_id: "adjacent-session",
        jsonl_path: "/path/to/session.jsonl",
      });

      // Insert 5 chunks
      for (let i = 0; i < 5; i++) {
        insertChunkWithVector(db, {
          session_id: sessionId,
          chunk_index: i,
          role: i % 2 === 0 ? "user" : "assistant",
          content: `Chunk ${i}`,
          embedding: new Float32Array(384).fill(i * 0.1),
        });
      }
    });

    it("returns before and after chunks", () => {
      const result = getAdjacentChunks(db, {
        session_id: sessionId,
        chunk_index: 2,
        before: 2,
        after: 2,
      });

      expect(result.before.length).toBe(2);
      expect(result.after.length).toBe(2);

      // Before chunks should be ordered ascending (closest to the chunk first)
      expect(result.before[0].chunk_index).toBe(0);
      expect(result.before[1].chunk_index).toBe(1);

      // After chunks should be ordered ascending
      expect(result.after[0].chunk_index).toBe(3);
      expect(result.after[1].chunk_index).toBe(4);
    });

    it("returns empty arrays when no adjacent chunks exist", () => {
      const result = getAdjacentChunks(db, {
        session_id: sessionId,
        chunk_index: 0,
        before: 2,
        after: 0,
      });

      expect(result.before.length).toBe(0);
    });
  });

  describe("deleteSessionChunks", () => {
    let projectId: number;
    let sessionId: number;

    beforeEach(() => {
      projectId = upsertProject(db, {
        dir_name: "delete-test",
        path: "/home/user/delete-test",
        name: "Delete Test",
      });
      sessionId = upsertSession(db, {
        project_id: projectId,
        session_id: "delete-session",
        jsonl_path: "/path/to/session.jsonl",
      });

      for (let i = 0; i < 3; i++) {
        insertChunkWithVector(db, {
          session_id: sessionId,
          chunk_index: i,
          role: "user",
          content: `Chunk to delete ${i}`,
          embedding: new Float32Array(384).fill(0.5),
        });
      }
    });

    it("removes chunks and vectors", () => {
      // Verify chunks exist before deletion
      const beforeChunks = db
        .prepare("SELECT COUNT(*) as count FROM chunks WHERE session_id = ?")
        .get(sessionId) as { count: number };
      expect(beforeChunks.count).toBe(3);

      deleteSessionChunks(db, sessionId);

      // Verify chunks are gone
      const afterChunks = db
        .prepare("SELECT COUNT(*) as count FROM chunks WHERE session_id = ?")
        .get(sessionId) as { count: number };
      expect(afterChunks.count).toBe(0);

      // Verify vectors are gone
      const afterVecs = db
        .prepare("SELECT COUNT(*) as count FROM vec_chunks")
        .get() as { count: number };
      expect(afterVecs.count).toBe(0);
    });
  });

  describe("vectorSearch", () => {
    let projectId: number;
    let sessionId: number;

    beforeEach(() => {
      projectId = upsertProject(db, {
        dir_name: "search-test",
        path: "/home/user/search-test",
        name: "Search Test",
      });
      sessionId = upsertSession(db, {
        project_id: projectId,
        session_id: "search-session",
        jsonl_path: "/path/to/session.jsonl",
        branch: "main",
        model: "claude-3-5-sonnet",
      });

      const vectors = [
        new Float32Array(384).fill(0.9),
        new Float32Array(384).fill(0.5),
        new Float32Array(384).fill(0.1),
      ];

      for (let i = 0; i < 3; i++) {
        insertChunkWithVector(db, {
          session_id: sessionId,
          chunk_index: i,
          role: "user",
          content: `Search chunk ${i}`,
          embedding: vectors[i],
          timestamp: `2024-01-0${i + 1}T00:00:00Z`,
        });
      }
    });

    it("returns results sorted by score descending", () => {
      const query = new Float32Array(384).fill(0.9);
      const results = vectorSearch(db, { embedding: query, limit: 3 });

      expect(results.length).toBeGreaterThan(0);
      // Results should be sorted by score descending
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    });

    it("respects limit", () => {
      const query = new Float32Array(384).fill(0.5);
      const results = vectorSearch(db, { embedding: query, limit: 1 });
      expect(results.length).toBeLessThanOrEqual(1);
    });

    it("includes project and session metadata", () => {
      const query = new Float32Array(384).fill(0.9);
      const results = vectorSearch(db, { embedding: query, limit: 3 });

      if (results.length > 0) {
        expect(results[0].project_name).toBe("Search Test");
        expect(results[0].project_path).toBe("/home/user/search-test");
        expect(results[0].session_uuid).toBe("search-session");
        expect(results[0].branch).toBe("main");
      }
    });

    it("includes has_more_before and has_more_after flags", () => {
      const query = new Float32Array(384).fill(0.5);
      const results = vectorSearch(db, { embedding: query, limit: 3 });

      if (results.length > 0) {
        expect(typeof results[0].has_more_before).toBe("boolean");
        expect(typeof results[0].has_more_after).toBe("boolean");
      }
    });

    it("includes turn_range string", () => {
      const query = new Float32Array(384).fill(0.9);
      const results = vectorSearch(db, { embedding: query, limit: 3 });

      if (results.length > 0) {
        expect(typeof results[0].turn_range).toBe("string");
      }
    });
  });
});
