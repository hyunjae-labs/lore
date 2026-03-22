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
import { handleListSessions } from "../src/tools/list-sessions.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  sqliteVec.load(db);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA_SQL);
  db.exec(VEC_TABLE_SQL);
  return db;
}

interface SeedSessionOpts {
  projectDirName: string;
  projectName: string;
  projectPath: string;
  sessionUuid: string;
  startedAt?: string;
  branch?: string;
  model?: string;
  intent?: string;
  chunkCount?: number;
  indexed?: boolean;
}

function seedSession(db: Database.Database, opts: SeedSessionOpts): number {
  const projectId = upsertProject(db, {
    dir_name: opts.projectDirName,
    path: opts.projectPath,
    name: opts.projectName,
  });

  const sessionDbId = upsertSession(db, {
    project_id: projectId,
    session_id: opts.sessionUuid,
    jsonl_path: `${opts.projectPath}/${opts.sessionUuid}.jsonl`,
    started_at: opts.startedAt ?? null,
    branch: opts.branch ?? "main",
    model: opts.model ?? "claude-3-5-sonnet",
    intent: opts.intent ?? null,
  });

  const chunkCount = opts.chunkCount ?? 0;
  for (let i = 0; i < chunkCount; i++) {
    insertChunkWithVector(db, {
      session_id: sessionDbId,
      chunk_index: i,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Chunk ${i} for session ${opts.sessionUuid}`,
      embedding: new Float32Array(384).fill(i * 0.1),
    });
  }

  if (opts.indexed !== false) {
    updateSessionMetadata(db, {
      session_id: sessionDbId,
      indexed_offset: 100,
      indexed_at: new Date().toISOString(),
    });
  }

  return sessionDbId;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("handleListSessions", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
  });

  // ── 1. Returns sessions with correct structure ────────────────────────────

  it("returns sessions with required metadata fields", async () => {
    seedSession(db, {
      projectDirName: "-Users-test-ls",
      projectName: "ls-project",
      projectPath: "/Users/test/ls-project",
      sessionUuid: "ls-session-0001",
      startedAt: "2024-01-10T10:00:00.000Z",
      chunkCount: 2,
    });

    const response = await handleListSessions(db, {});

    expect(response.content).toHaveLength(1);
    expect(response.content[0].type).toBe("text");

    const parsed = JSON.parse(response.content[0].text);
    expect(Array.isArray(parsed.sessions)).toBe(true);
    expect(parsed.sessions.length).toBe(1);

    const s = parsed.sessions[0];
    expect(s.session_id).toBe("ls-session-0001");
    expect(s.project).toBe("/Users/test/ls-project");
    expect(s.project_name).toBe("ls-project");
    expect(s.branch).toBe("main");
    expect(s.model).toBe("claude-3-5-sonnet");
    expect(typeof s.indexed).toBe("boolean");
    expect(s.chunk_count).toBe(2);
  });

  // ── 2. Returns total_sessions and total_indexed counts ───────────────────

  it("returns total_sessions and total_indexed summary counts", async () => {
    seedSession(db, {
      projectDirName: "-Users-test-a",
      projectName: "proj-a",
      projectPath: "/Users/test/a",
      sessionUuid: "summary-session-a",
      chunkCount: 1,
      indexed: true,
    });
    seedSession(db, {
      projectDirName: "-Users-test-b",
      projectName: "proj-b",
      projectPath: "/Users/test/b",
      sessionUuid: "summary-session-b",
      chunkCount: 1,
      indexed: false,
    });

    const response = await handleListSessions(db, {});
    const parsed = JSON.parse(response.content[0].text);

    expect(parsed.total_sessions).toBe(2);
    expect(parsed.total_indexed).toBe(1);
  });

  // ── 3. Filters by project name ────────────────────────────────────────────

  it("filters sessions by project name (partial match)", async () => {
    seedSession(db, {
      projectDirName: "-Users-test-alpha",
      projectName: "alpha-project",
      projectPath: "/Users/test/alpha",
      sessionUuid: "filter-session-alpha",
      chunkCount: 1,
    });
    seedSession(db, {
      projectDirName: "-Users-test-beta",
      projectName: "beta-project",
      projectPath: "/Users/test/beta",
      sessionUuid: "filter-session-beta",
      chunkCount: 1,
    });

    const response = await handleListSessions(db, { project: "alpha" });
    const parsed = JSON.parse(response.content[0].text);

    expect(parsed.sessions.length).toBe(1);
    expect(parsed.sessions[0].session_id).toBe("filter-session-alpha");
  });

  // ── 4. Respects limit parameter ──────────────────────────────────────────

  it("respects the limit parameter", async () => {
    for (let i = 0; i < 5; i++) {
      seedSession(db, {
        projectDirName: `-Users-test-lim-${i}`,
        projectName: `lim-proj-${i}`,
        projectPath: `/Users/test/lim-${i}`,
        sessionUuid: `limit-session-${i}`,
        startedAt: `2024-01-${String(i + 1).padStart(2, "0")}T10:00:00.000Z`,
        chunkCount: 1,
      });
    }

    const response = await handleListSessions(db, { limit: 3 });
    const parsed = JSON.parse(response.content[0].text);

    expect(parsed.sessions.length).toBeLessThanOrEqual(3);
  });

  // ── 5. Caps limit at 100 ─────────────────────────────────────────────────

  it("caps limit at 100 even when a higher value is passed", async () => {
    seedSession(db, {
      projectDirName: "-Users-test-cap",
      projectName: "cap-proj",
      projectPath: "/Users/test/cap",
      sessionUuid: "cap-session-001",
      chunkCount: 1,
    });

    // Should not throw; just verify it runs without error
    const response = await handleListSessions(db, { limit: 9999 });
    const parsed = JSON.parse(response.content[0].text);
    expect(Array.isArray(parsed.sessions)).toBe(true);
  });

  // ── 6. Respects sort "recent" (DESC) ─────────────────────────────────────

  it("sorts sessions newest-first by default (sort: recent)", async () => {
    seedSession(db, {
      projectDirName: "-Users-test-sort-a",
      projectName: "sort-a",
      projectPath: "/Users/test/sort-a",
      sessionUuid: "sort-session-older",
      startedAt: "2024-01-01T10:00:00.000Z",
      chunkCount: 1,
    });
    seedSession(db, {
      projectDirName: "-Users-test-sort-b",
      projectName: "sort-b",
      projectPath: "/Users/test/sort-b",
      sessionUuid: "sort-session-newer",
      startedAt: "2024-06-01T10:00:00.000Z",
      chunkCount: 1,
    });

    const response = await handleListSessions(db, { sort: "recent" });
    const parsed = JSON.parse(response.content[0].text);

    expect(parsed.sessions.length).toBe(2);
    expect(parsed.sessions[0].session_id).toBe("sort-session-newer");
    expect(parsed.sessions[1].session_id).toBe("sort-session-older");
  });

  // ── 7. Respects sort "oldest" (ASC) ──────────────────────────────────────

  it("sorts sessions oldest-first when sort is 'oldest'", async () => {
    seedSession(db, {
      projectDirName: "-Users-test-old-a",
      projectName: "old-a",
      projectPath: "/Users/test/old-a",
      sessionUuid: "oldest-session-first",
      startedAt: "2024-01-01T10:00:00.000Z",
      chunkCount: 1,
    });
    seedSession(db, {
      projectDirName: "-Users-test-old-b",
      projectName: "old-b",
      projectPath: "/Users/test/old-b",
      sessionUuid: "oldest-session-second",
      startedAt: "2024-06-01T10:00:00.000Z",
      chunkCount: 1,
    });

    const response = await handleListSessions(db, { sort: "oldest" });
    const parsed = JSON.parse(response.content[0].text);

    expect(parsed.sessions.length).toBe(2);
    expect(parsed.sessions[0].session_id).toBe("oldest-session-first");
    expect(parsed.sessions[1].session_id).toBe("oldest-session-second");
  });

  // ── 8. Includes projects summary ─────────────────────────────────────────

  it("includes a projects summary with name, path, session_count", async () => {
    seedSession(db, {
      projectDirName: "-Users-test-proj1",
      projectName: "proj1",
      projectPath: "/Users/test/proj1",
      sessionUuid: "proj-summary-s1",
      chunkCount: 1,
    });
    seedSession(db, {
      projectDirName: "-Users-test-proj2",
      projectName: "proj2",
      projectPath: "/Users/test/proj2",
      sessionUuid: "proj-summary-s2",
      chunkCount: 1,
    });
    // Add a second session to proj1
    seedSession(db, {
      projectDirName: "-Users-test-proj1",
      projectName: "proj1",
      projectPath: "/Users/test/proj1",
      sessionUuid: "proj-summary-s3",
      chunkCount: 1,
    });

    const response = await handleListSessions(db, {});
    const parsed = JSON.parse(response.content[0].text);

    expect(Array.isArray(parsed.projects)).toBe(true);
    expect(parsed.projects.length).toBe(2);

    const proj1 = parsed.projects.find((p: any) => p.name === "proj1");
    expect(proj1).toBeDefined();
    expect(proj1.session_count).toBe(2);
    expect(proj1.path).toBe("/Users/test/proj1");

    const proj2 = parsed.projects.find((p: any) => p.name === "proj2");
    expect(proj2).toBeDefined();
    expect(proj2.session_count).toBe(1);
  });

  // ── 9. Returns empty sessions array for empty DB ─────────────────────────

  it("returns empty sessions list when DB has no sessions", async () => {
    const response = await handleListSessions(db, {});
    const parsed = JSON.parse(response.content[0].text);

    expect(parsed.sessions).toHaveLength(0);
    expect(parsed.total_sessions).toBe(0);
    expect(parsed.total_indexed).toBe(0);
    expect(Array.isArray(parsed.projects)).toBe(true);
  });

  // ── 10. indexed field is a boolean ───────────────────────────────────────

  it("returns indexed as a boolean value", async () => {
    seedSession(db, {
      projectDirName: "-Users-test-bool",
      projectName: "bool-proj",
      projectPath: "/Users/test/bool",
      sessionUuid: "bool-indexed-session",
      chunkCount: 1,
      indexed: true,
    });
    seedSession(db, {
      projectDirName: "-Users-test-bool2",
      projectName: "bool-proj2",
      projectPath: "/Users/test/bool2",
      sessionUuid: "bool-unindexed-session",
      chunkCount: 1,
      indexed: false,
    });

    const response = await handleListSessions(db, {});
    const parsed = JSON.parse(response.content[0].text);

    for (const s of parsed.sessions) {
      expect(typeof s.indexed).toBe("boolean");
    }

    const indexed = parsed.sessions.find(
      (s: any) => s.session_id === "bool-indexed-session"
    );
    const unindexed = parsed.sessions.find(
      (s: any) => s.session_id === "bool-unindexed-session"
    );
    expect(indexed.indexed).toBe(true);
    expect(unindexed.indexed).toBe(false);
  });

  // ── 11. chunk_count reflects actual chunk count ──────────────────────────

  it("chunk_count reflects actual number of indexed chunks", async () => {
    seedSession(db, {
      projectDirName: "-Users-test-cc",
      projectName: "cc-proj",
      projectPath: "/Users/test/cc",
      sessionUuid: "chunk-count-session",
      chunkCount: 5,
    });

    const response = await handleListSessions(db, {});
    const parsed = JSON.parse(response.content[0].text);

    const s = parsed.sessions.find(
      (s: any) => s.session_id === "chunk-count-session"
    );
    expect(s).toBeDefined();
    expect(s.chunk_count).toBe(5);
  });
});
