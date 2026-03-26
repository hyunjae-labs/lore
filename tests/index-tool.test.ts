import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
} from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { loadUserConfig, saveUserConfig } from "../src/config.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { SCHEMA_SQL, VEC_TABLE_SQL } from "../src/db/schema.js";
import { handleIndex, waitForIndexComplete } from "../src/tools/index-tool.js";

// ── helpers ────────────────────────────────────────────────────────────────

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  sqliteVec.load(db);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA_SQL);
  db.exec(VEC_TABLE_SQL);
  return db;
}

/** Build a minimal valid Claude Code JSONL line */
function makeUserLine(text: string, sessionId: string, timestamp: string): string {
  return JSON.stringify({
    type: "user",
    sessionId,
    timestamp,
    gitBranch: "main",
    message: {
      role: "user",
      content: text,
    },
  });
}

function makeAssistantLine(
  text: string,
  sessionId: string,
  timestamp: string
): string {
  return JSON.stringify({
    type: "assistant",
    sessionId,
    timestamp,
    message: {
      role: "assistant",
      model: "claude-3-5-sonnet-20241022",
      content: [{ type: "text", text }],
    },
  });
}

// ── test setup ─────────────────────────────────────────────────────────────

let tempDir: string;
let projectsDir: string;
let loreDir: string;

let testCounter = 0;

beforeEach(() => {
  const ts = Date.now();
  testCounter++;
  tempDir = join(tmpdir(), `lore-index-test-${ts}-${testCounter}`);
  projectsDir = join(tempDir, "projects");
  loreDir = join(tempDir, "lore");

  mkdirSync(projectsDir, { recursive: true });
  mkdirSync(loreDir, { recursive: true });

  // Point CONFIG env vars to temp dirs so CONFIG picks them up
  process.env.CLAUDE_PROJECTS_DIR = projectsDir;
  process.env.LORE_DIR = loreDir;

  // Ensure a clean config for each test
  saveUserConfig({ excluded_projects: [] });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.CLAUDE_PROJECTS_DIR;
  delete process.env.LORE_DIR;
});

// ── tests ──────────────────────────────────────────────────────────────────

describe("handleIndex", () => {
  it(
    "indexes sessions and creates chunks",
    async () => {
      // Set up a project directory with one session JSONL
      const projectDirName = "-Users-test-myapp";
      const projectDir = join(projectsDir, projectDirName);
      mkdirSync(projectDir, { recursive: true });

      const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee01";
      const ts1 = "2024-01-10T10:00:00.000Z";
      const ts2 = "2024-01-10T10:00:05.000Z";

      const lines = [
        makeUserLine("How do I implement authentication?", sessionId, ts1),
        makeAssistantLine(
          "You can implement auth using JWT tokens. First, install jsonwebtoken...",
          sessionId,
          ts2
        ),
      ];

      writeFileSync(
        join(projectDir, `${sessionId}.jsonl`),
        lines.join("\n") + "\n"
      );

      const db = makeDb();

      const response = await handleIndex(db, {});

      // Response should return immediately with "started" status
      expect(response.content).toHaveLength(1);
      const result = JSON.parse(response.content[0].text);
      expect(result.status).toBe("started");
      expect(result.sessions_found).toBeGreaterThanOrEqual(1);

      // Wait for background indexing to complete
      await waitForIndexComplete(60000);

      // Verify session was created in DB
      const session = db
        .prepare("SELECT * FROM sessions WHERE session_id = ?")
        .get(sessionId) as any;
      expect(session).toBeDefined();
      expect(session.indexed_at).not.toBeNull();
      expect(session.intent).toContain("How do I implement authentication");
      expect(session.branch).toBe("main");
      expect(session.model).toBe("claude-3-5-sonnet-20241022");

      // Verify chunks were created
      const chunks = db
        .prepare("SELECT * FROM chunks WHERE session_id = ?")
        .all(session.id) as any[];
      expect(chunks.length).toBeGreaterThanOrEqual(1);

      // Verify vectors were created (one per chunk)
      const vecCount = db
        .prepare("SELECT COUNT(*) as count FROM vec_chunks")
        .get() as { count: number };
      expect(vecCount.count).toBe(chunks.length);

      db.close();
    },
    60000
  );

  it(
    "skips sessions that haven't changed (incremental)",
    async () => {
      const projectDirName = "-Users-test-myapp2";
      const projectDir = join(projectsDir, projectDirName);
      mkdirSync(projectDir, { recursive: true });

      const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee02";
      const ts1 = "2024-02-01T09:00:00.000Z";
      const ts2 = "2024-02-01T09:00:10.000Z";

      const lines = [
        makeUserLine("What is a closure in JavaScript?", sessionId, ts1),
        makeAssistantLine(
          "A closure is a function that retains access to its lexical scope...",
          sessionId,
          ts2
        ),
      ];

      const jsonlPath = join(projectDir, `${sessionId}.jsonl`);
      writeFileSync(jsonlPath, lines.join("\n") + "\n");

      const db = makeDb();

      // First index run
      await handleIndex(db, {});
      await waitForIndexComplete(60000);

      const chunksAfterFirst = (
        db.prepare("SELECT COUNT(*) as count FROM chunks").get() as { count: number }
      ).count;
      expect(chunksAfterFirst).toBeGreaterThan(0);

      // Second index run — file unchanged, should skip
      await handleIndex(db, {});
      await waitForIndexComplete(60000);

      // Chunk count must not grow
      const chunksAfterSecond = (
        db.prepare("SELECT COUNT(*) as count FROM chunks").get() as { count: number }
      ).count;
      expect(chunksAfterSecond).toBe(chunksAfterFirst);

      db.close();
    },
    60000
  );

  it(
    "re-indexes on rebuild mode (clears old chunks and reindexes)",
    async () => {
      const projectDirName = "-Users-test-myapp3";
      const projectDir = join(projectsDir, projectDirName);
      mkdirSync(projectDir, { recursive: true });

      const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee03";
      const ts1 = "2024-03-01T08:00:00.000Z";
      const ts2 = "2024-03-01T08:00:10.000Z";

      const lines = [
        makeUserLine("Explain dependency injection", sessionId, ts1),
        makeAssistantLine(
          "Dependency injection is a design pattern where objects receive their dependencies...",
          sessionId,
          ts2
        ),
      ];

      writeFileSync(
        join(projectDir, `${sessionId}.jsonl`),
        lines.join("\n") + "\n"
      );

      const db = makeDb();

      // First index run
      await handleIndex(db, {});
      await waitForIndexComplete(60000);

      const chunksAfterFirst = (
        db.prepare("SELECT COUNT(*) as count FROM chunks").get() as { count: number }
      ).count;
      expect(chunksAfterFirst).toBeGreaterThan(0);

      // Rebuild — should clear and rebuild
      await handleIndex(db, { mode: "rebuild" });
      await waitForIndexComplete(60000);

      const chunksAfterFull = (
        db.prepare("SELECT COUNT(*) as count FROM chunks").get() as { count: number }
      ).count;
      // After full re-index, the chunk count should match (not doubled)
      expect(chunksAfterFull).toBe(chunksAfterFirst);

      db.close();
    },
    60000
  );

  it(
    "indexes all projects by default (opt-out model)",
    async () => {
      // Create two projects on disk, no exclusions
      const projectDirNameA = "-Users-test-optout-a";
      const projectDirNameB = "-Users-test-optout-b";
      mkdirSync(join(projectsDir, projectDirNameA), { recursive: true });
      mkdirSync(join(projectsDir, projectDirNameB), { recursive: true });

      const sidA = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeee0a1";
      const sidB = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeee0b1";
      const ts = "2024-07-01T10:00:00.000Z";

      writeFileSync(
        join(projectsDir, projectDirNameA, `${sidA}.jsonl`),
        [
          makeUserLine("Opt-out test A", sidA, ts),
          makeAssistantLine("Answer A", sidA, ts),
        ].join("\n") + "\n"
      );

      writeFileSync(
        join(projectsDir, projectDirNameB, `${sidB}.jsonl`),
        [
          makeUserLine("Opt-out test B", sidB, ts),
          makeAssistantLine("Answer B", sidB, ts),
        ].join("\n") + "\n"
      );

      const db = makeDb();

      const response = await handleIndex(db, {});
      const result = JSON.parse(response.content[0].text);
      expect(result.status).toBe("started");

      await waitForIndexComplete(30000);

      // Both sessions should be indexed (all projects indexed by default)
      const sessionA = db
        .prepare("SELECT * FROM sessions WHERE session_id = ?")
        .get(sidA);
      const sessionB = db
        .prepare("SELECT * FROM sessions WHERE session_id = ?")
        .get(sidB);
      expect(sessionA).toBeDefined();
      expect(sessionB).toBeDefined();

      db.close();
    },
    60000
  );

  it(
    "excludes projects in excluded_projects from indexing",
    async () => {
      const projectDirNameA = "-Users-test-excl-a";
      const projectDirNameB = "-Users-test-excl-b";
      mkdirSync(join(projectsDir, projectDirNameA), { recursive: true });
      mkdirSync(join(projectsDir, projectDirNameB), { recursive: true });

      const sidA = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeee0c1";
      const sidB = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeee0d1";
      const ts = "2024-08-01T10:00:00.000Z";

      writeFileSync(
        join(projectsDir, projectDirNameA, `${sidA}.jsonl`),
        [
          makeUserLine("Excluded test A", sidA, ts),
          makeAssistantLine("Answer A", sidA, ts),
        ].join("\n") + "\n"
      );

      writeFileSync(
        join(projectsDir, projectDirNameB, `${sidB}.jsonl`),
        [
          makeUserLine("Excluded test B", sidB, ts),
          makeAssistantLine("Answer B", sidB, ts),
        ].join("\n") + "\n"
      );

      // Exclude project B
      saveUserConfig({ excluded_projects: [projectDirNameB] });

      const db = makeDb();

      await handleIndex(db, {});
      await waitForIndexComplete(30000);

      // Only project A should be indexed
      const sessionA = db
        .prepare("SELECT * FROM sessions WHERE session_id = ?")
        .get(sidA);
      const sessionB = db
        .prepare("SELECT * FROM sessions WHERE session_id = ?")
        .get(sidB);
      expect(sessionA).toBeDefined();
      expect(sessionB).toBeUndefined();

      db.close();
    },
    60000
  );

  it(
    "releases lock file after completion",
    async () => {
      // Need a project with a session for lock to be acquired
      const projectDirName = "-Users-test-locktest";
      const projectDir = join(projectsDir, projectDirName);
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(
        join(projectDir, "lock-test-session.jsonl"),
        JSON.stringify({ type: "user", sessionId: "lock-test", timestamp: "2024-01-01T00:00:00Z", message: { role: "user", content: "test" } }) + "\n"
      );

      const db = makeDb();
      await handleIndex(db, {});
      await waitForIndexComplete(30000);

      // Lock file should be removed after completion
      const lockPath = join(loreDir, "index.lock");
      expect(existsSync(lockPath)).toBe(false);

      db.close();
    },
    30000
  );

  it(
    "filters by project dirName when project param provided",
    async () => {
      // Two projects
      const projectDirNameA = "-Users-test-alpha";
      const projectDirNameB = "-Users-test-beta";
      const projectDirA = join(projectsDir, projectDirNameA);
      const projectDirB = join(projectsDir, projectDirNameB);
      mkdirSync(projectDirA, { recursive: true });
      mkdirSync(projectDirB, { recursive: true });

      const sidA = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee04";
      const sidB = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee05";
      const ts = "2024-04-01T12:00:00.000Z";

      writeFileSync(
        join(projectDirA, `${sidA}.jsonl`),
        [
          makeUserLine("Alpha project question", sidA, ts),
          makeAssistantLine("Alpha answer", sidA, ts),
        ].join("\n") + "\n"
      );

      writeFileSync(
        join(projectDirB, `${sidB}.jsonl`),
        [
          makeUserLine("Beta project question", sidB, ts),
          makeAssistantLine("Beta answer", sidB, ts),
        ].join("\n") + "\n"
      );

      const db = makeDb();

      // Index only "alpha" project by dirName
      await handleIndex(db, {
        project: projectDirNameA,
      });
      await waitForIndexComplete(60000);

      // Only alpha session should be in DB
      const alphaSession = db
        .prepare("SELECT * FROM sessions WHERE session_id = ?")
        .get(sidA);
      const betaSession = db
        .prepare("SELECT * FROM sessions WHERE session_id = ?")
        .get(sidB);

      expect(alphaSession).toBeDefined();
      expect(betaSession).toBeUndefined();

      db.close();
    },
    60000
  );

  it(
    "project param indexes even if project is excluded",
    async () => {
      const projectDirName = "-Users-test-excluded-explicit";
      const projectDir = join(projectsDir, projectDirName);
      mkdirSync(projectDir, { recursive: true });

      const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeee0e1";
      const ts = "2024-08-01T10:00:00.000Z";

      writeFileSync(
        join(projectDir, `${sessionId}.jsonl`),
        [
          makeUserLine("Explicit project test", sessionId, ts),
          makeAssistantLine("Explicit project answer", sessionId, ts),
        ].join("\n") + "\n"
      );

      // Exclude the project
      saveUserConfig({ excluded_projects: [projectDirName] });

      const db = makeDb();

      // Pass the dirName directly — should index even though excluded
      const response = await handleIndex(db, { project: projectDirName });
      const result = JSON.parse(response.content[0].text);
      expect(result.status).toBe("started");

      await waitForIndexComplete(30000);

      // Session should be indexed
      const session = db
        .prepare("SELECT * FROM sessions WHERE session_id = ?")
        .get(sessionId);
      expect(session).toBeDefined();

      db.close();
    },
    60000
  );

  it(
    "incremental prunes sessions whose JSONL was deleted from disk",
    async () => {
      const projectDirName = "-Users-test-pruneapp";
      const projectDir = join(projectsDir, projectDirName);
      mkdirSync(projectDir, { recursive: true });

      const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee06";
      const ts1 = "2024-05-01T10:00:00.000Z";
      const ts2 = "2024-05-01T10:00:05.000Z";

      const jsonlPath = join(projectDir, `${sessionId}.jsonl`);
      const lines = [
        makeUserLine("How do I prune orphan sessions?", sessionId, ts1),
        makeAssistantLine(
          "You compare disk files with DB records and delete orphans.",
          sessionId,
          ts2
        ),
      ];
      writeFileSync(jsonlPath, lines.join("\n") + "\n");

      const db = makeDb();

      // 1. Index the session
      await handleIndex(db, {});
      await waitForIndexComplete(60000);

      // 2. Verify it was indexed
      const sessionBefore = db
        .prepare("SELECT * FROM sessions WHERE session_id = ?")
        .get(sessionId) as any;
      expect(sessionBefore).toBeDefined();
      expect(sessionBefore.indexed_at).not.toBeNull();

      const chunksBefore = db
        .prepare("SELECT COUNT(*) as count FROM chunks WHERE session_id = ?")
        .get(sessionBefore.id) as { count: number };
      expect(chunksBefore.count).toBeGreaterThan(0);

      // 3. Delete the JSONL file from disk
      unlinkSync(jsonlPath);

      // 4. Run incremental again — should prune the orphan
      await handleIndex(db, {});
      await waitForIndexComplete(60000);

      // 5. Verify the session and its chunks were pruned from DB
      const sessionAfter = db
        .prepare("SELECT * FROM sessions WHERE session_id = ?")
        .get(sessionId);
      expect(sessionAfter).toBeUndefined();

      const chunksAfter = db
        .prepare("SELECT COUNT(*) as count FROM chunks WHERE session_id = ?")
        .get(sessionBefore.id) as { count: number };
      expect(chunksAfter.count).toBe(0);

      db.close();
    },
    60000
  );

  it(
    "rebuild removes sessions whose JSONL was deleted from disk",
    async () => {
      const projectDirName = "-Users-test-rebuildapp";
      const projectDir = join(projectsDir, projectDirName);
      mkdirSync(projectDir, { recursive: true });

      const sessionId1 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee07";
      const sessionId2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee08";
      const ts1 = "2024-06-01T10:00:00.000Z";
      const ts2 = "2024-06-01T10:00:05.000Z";

      // Create two session files
      const jsonlPath1 = join(projectDir, `${sessionId1}.jsonl`);
      const jsonlPath2 = join(projectDir, `${sessionId2}.jsonl`);

      writeFileSync(
        jsonlPath1,
        [
          makeUserLine("How do I handle errors in async code?", sessionId1, ts1),
          makeAssistantLine("Use try/catch with await or .catch() on promises.", sessionId1, ts2),
        ].join("\n") + "\n"
      );

      writeFileSync(
        jsonlPath2,
        [
          makeUserLine("What is a monad in functional programming?", sessionId2, ts1),
          makeAssistantLine("A monad is a design pattern that wraps values with context.", sessionId2, ts2),
        ].join("\n") + "\n"
      );

      const db = makeDb();

      // 1. Index everything
      await handleIndex(db, {});
      await waitForIndexComplete(60000);

      // 2. Verify both sessions were indexed
      const session1Before = db
        .prepare("SELECT * FROM sessions WHERE session_id = ?")
        .get(sessionId1) as any;
      const session2Before = db
        .prepare("SELECT * FROM sessions WHERE session_id = ?")
        .get(sessionId2) as any;
      expect(session1Before).toBeDefined();
      expect(session2Before).toBeDefined();

      // 3. Delete the second session file from disk
      unlinkSync(jsonlPath2);

      // 4. Run rebuild (with confirm: true)
      await handleIndex(db, { mode: "rebuild", confirm: true });
      await waitForIndexComplete(60000);

      // 5. Verify deleted session is NOT in DB
      const session2After = db
        .prepare("SELECT * FROM sessions WHERE session_id = ?")
        .get(sessionId2);
      expect(session2After).toBeUndefined();

      const chunks2After = db
        .prepare("SELECT COUNT(*) as count FROM chunks WHERE session_id = ?")
        .get(session2Before.id) as { count: number };
      expect(chunks2After.count).toBe(0);

      // Session 1 (file still exists) should still be in DB
      const session1After = db
        .prepare("SELECT * FROM sessions WHERE session_id = ?")
        .get(sessionId1);
      expect(session1After).toBeDefined();

      db.close();
    },
    60000
  );
});
