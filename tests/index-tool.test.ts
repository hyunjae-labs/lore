import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
} from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { saveUserConfig } from "../src/config.js";
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

beforeEach(() => {
  const ts = Date.now();
  tempDir = join(tmpdir(), `lore-index-test-${ts}`);
  projectsDir = join(tempDir, "projects");
  loreDir = join(tempDir, "lore");

  mkdirSync(projectsDir, { recursive: true });
  mkdirSync(loreDir, { recursive: true });

  // Point CONFIG env vars to temp dirs so CONFIG picks them up
  process.env.CLAUDE_PROJECTS_DIR = projectsDir;
  process.env.LORE_DIR = loreDir;
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
      saveUserConfig({ indexed_projects: [projectDirName] });

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

      const response = await handleIndex(db, { mode: "incremental" });

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
      saveUserConfig({ indexed_projects: [projectDirName] });

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
      await handleIndex(db, { mode: "incremental" });
      await waitForIndexComplete(60000);

      const chunksAfterFirst = (
        db.prepare("SELECT COUNT(*) as count FROM chunks").get() as { count: number }
      ).count;
      expect(chunksAfterFirst).toBeGreaterThan(0);

      // Second index run — file unchanged, should skip
      await handleIndex(db, { mode: "incremental" });
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
      saveUserConfig({ indexed_projects: [projectDirName] });

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
      await handleIndex(db, { mode: "incremental" });
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
    "returns no_projects_registered when config is empty",
    async () => {
      // No projects registered in config
      const db = makeDb();

      const response = await handleIndex(db, { mode: "incremental" });
      const result = JSON.parse(response.content[0].text);

      expect(result.status).toBe("no_projects_registered");

      db.close();
    },
    30000
  );

  it(
    "releases lock file after completion",
    async () => {
      // Need a registered project with a session for lock to be acquired
      const projectDirName = "-Users-test-locktest";
      const projectDir = join(projectsDir, projectDirName);
      mkdirSync(projectDir, { recursive: true });
      saveUserConfig({ indexed_projects: [projectDirName] });
      writeFileSync(
        join(projectDir, "lock-test-session.jsonl"),
        JSON.stringify({ type: "user", sessionId: "lock-test", timestamp: "2024-01-01T00:00:00Z", message: { role: "user", content: "test" } }) + "\n"
      );

      const db = makeDb();
      await handleIndex(db, { mode: "incremental" });
      await waitForIndexComplete(30000);

      // Lock file should be removed after completion
      const lockPath = join(loreDir, "index.lock");
      expect(existsSync(lockPath)).toBe(false);

      db.close();
    },
    30000
  );

  it(
    "filters by project name when project param provided",
    async () => {
      // Two projects
      const projectDirA = join(projectsDir, "-Users-test-alpha");
      const projectDirB = join(projectsDir, "-Users-test-beta");
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

      // Index only "alpha" project
      await handleIndex(db, {
        mode: "incremental",
        project: "alpha",
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
});
