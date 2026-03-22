/**
 * Integration test: exercises the full pipeline with real embeddings.
 *
 * - Creates temp directories with realistic Claude Code JSONL files
 * - Calls handleIndex → verifies sessions and chunks are created
 * - Calls handleSearch → verifies results with correct format
 * - Calls handleGetContext with a result chunk_id → verifies context returned
 * - Calls handleListSessions → verifies session metadata
 *
 * Timeout: 60 000 ms (model loading + embedding)
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { SCHEMA_SQL, VEC_TABLE_SQL } from "../src/db/schema.js";
import { handleIndex, waitForIndexComplete } from "../src/tools/index-tool.js";
import { saveUserConfig } from "../src/config.js";
import { handleSearch } from "../src/tools/search.js";
import { handleGetContext } from "../src/tools/get-context.js";
import { handleListSessions } from "../src/tools/list-sessions.js";

// ── helpers ─────────────────────────────────────────────────────────────────

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  sqliteVec.load(db);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA_SQL);
  db.exec(VEC_TABLE_SQL);
  return db;
}

/** Produce a realistic multi-turn JSONL with tool use */
function realisticJsonl(sessionId: string): string {
  const lines: object[] = [
    // Turn 1 – user asks about authentication
    {
      type: "user",
      sessionId,
      timestamp: "2024-05-01T09:00:00.000Z",
      gitBranch: "feature/auth",
      message: {
        role: "user",
        content:
          "How do I implement JWT authentication in a Node.js Express app?",
      },
    },
    // Turn 2 – assistant responds
    {
      type: "assistant",
      sessionId,
      timestamp: "2024-05-01T09:00:04.000Z",
      message: {
        role: "assistant",
        model: "claude-3-5-sonnet-20241022",
        content: [
          {
            type: "text",
            text: "To implement JWT authentication in Express, install jsonwebtoken and express-jwt. " +
              "Create a middleware that verifies the token on protected routes. " +
              "Use jwt.sign() to create tokens on login and jwt.verify() to validate them.",
          },
        ],
      },
    },
    // Turn 3 – user follows up with tool use
    {
      type: "user",
      sessionId,
      timestamp: "2024-05-01T09:01:00.000Z",
      gitBranch: "feature/auth",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_01ABCDEF",
            content: "File created: src/middleware/auth.ts",
          },
          {
            type: "text",
            text: "What about refresh tokens? Should I store them in the database?",
          },
        ],
      },
    },
    // Turn 4 – assistant explains refresh token strategy
    {
      type: "assistant",
      sessionId,
      timestamp: "2024-05-01T09:01:05.000Z",
      message: {
        role: "assistant",
        model: "claude-3-5-sonnet-20241022",
        content: [
          {
            type: "tool_use",
            id: "toolu_01ABCDEF",
            name: "Write",
            input: { path: "src/middleware/auth.ts", content: "// auth middleware" },
          },
          {
            type: "text",
            text: "Yes, refresh tokens should be stored securely in the database with " +
              "a hashed version. This allows token revocation. Short-lived access tokens " +
              "(15 min) and longer-lived refresh tokens (7 days) is a common strategy.",
          },
        ],
      },
    },
    // Turn 5 – user asks about database setup
    {
      type: "user",
      sessionId,
      timestamp: "2024-05-01T09:02:00.000Z",
      gitBranch: "feature/auth",
      message: {
        role: "user",
        content: "How should I set up the PostgreSQL schema for refresh tokens?",
      },
    },
    // Turn 6 – assistant provides SQL schema
    {
      type: "assistant",
      sessionId,
      timestamp: "2024-05-01T09:02:06.000Z",
      message: {
        role: "assistant",
        model: "claude-3-5-sonnet-20241022",
        content: [
          {
            type: "text",
            text: "CREATE TABLE refresh_tokens (\n" +
              "  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),\n" +
              "  user_id UUID NOT NULL REFERENCES users(id),\n" +
              "  token_hash TEXT NOT NULL UNIQUE,\n" +
              "  expires_at TIMESTAMPTZ NOT NULL,\n" +
              "  created_at TIMESTAMPTZ DEFAULT NOW()\n" +
              ");\n" +
              "Use an index on user_id for fast lookups during refresh.",
          },
        ],
      },
    },
  ];

  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

// ── global setup / teardown ──────────────────────────────────────────────────

let tempDir: string;
let projectsDir: string;
let loreDir: string;
let db: Database.Database;

const SESSION_ID = "integ-aaaa-bbbb-cccc-dddd-000000000001";
const PROJECT_DIR_NAME = "-Users-integ-jwtapp";

beforeAll(() => {
  const ts = Date.now();
  tempDir = join(tmpdir(), `lore-integration-${ts}`);
  projectsDir = join(tempDir, "projects");
  loreDir = join(tempDir, "lore");

  mkdirSync(projectsDir, { recursive: true });
  mkdirSync(loreDir, { recursive: true });

  process.env.CLAUDE_PROJECTS_DIR = projectsDir;
  process.env.LORE_DIR = loreDir;

  // Create a project dir with one realistic JSONL session
  const projectPath = join(projectsDir, PROJECT_DIR_NAME);
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(join(projectPath, `${SESSION_ID}.jsonl`), realisticJsonl(SESSION_ID));

  // Register project for indexing
  saveUserConfig({ indexed_projects: [PROJECT_DIR_NAME] });

  db = makeDb();
});

afterAll(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.CLAUDE_PROJECTS_DIR;
  delete process.env.LORE_DIR;
});

// ── tests ────────────────────────────────────────────────────────────────────

describe("lore full pipeline integration", () => {
  // Track a chunk_id returned by search for use in the context test
  let foundChunkId: number;

  it(
    "handleIndex: creates sessions and chunks from JSONL files",
    async () => {
      const response = await handleIndex(db, {});
      const result = JSON.parse(response.content[0].text);
      expect(result.status).toBe("started");

      await waitForIndexComplete(60000);

      // Session row should exist and be marked as indexed
      const session = db
        .prepare("SELECT * FROM sessions WHERE session_id = ?")
        .get(SESSION_ID) as any;

      expect(session).toBeDefined();
      expect(session.indexed_at).not.toBeNull();
      expect(session.branch).toBe("feature/auth");
      expect(session.model).toBe("claude-3-5-sonnet-20241022");
      // Intent should be extracted from the first user message
      expect(session.intent).toBeTruthy();

      // At least one chunk must exist for this session
      const chunks = db
        .prepare("SELECT * FROM chunks WHERE session_id = ?")
        .all(session.id) as any[];
      expect(chunks.length).toBeGreaterThanOrEqual(1);

      // Vectors should exist (one per chunk)
      const vecCount = db
        .prepare("SELECT COUNT(*) as count FROM vec_chunks")
        .get() as { count: number };
      expect(vecCount.count).toBe(chunks.length);
    },
    60000
  );

  it(
    "handleSearch: returns results with correct format for a relevant query",
    async () => {
      const response = await handleSearch(db, {
        query: "JWT authentication refresh tokens",
      });

      expect(response.content).toHaveLength(1);
      expect(response.content[0].type).toBe("text");

      const parsed = JSON.parse(response.content[0].text);
      expect(parsed.status).toBe("ok");
      expect(parsed.query).toBe("JWT authentication refresh tokens");
      expect(typeof parsed.query_time_ms).toBe("number");
      expect(typeof parsed.total_indexed_sessions).toBe("number");
      expect(parsed.total_indexed_sessions).toBeGreaterThanOrEqual(1);
      expect(typeof parsed.result_count).toBe("number");
      expect(Array.isArray(parsed.results)).toBe(true);
      expect(parsed.results.length).toBeGreaterThanOrEqual(1);

      // Validate shape of each result
      for (const r of parsed.results) {
        expect(typeof r.chunk_id).toBe("number");
        expect(typeof r.score).toBe("number");
        expect(typeof r.content).toBe("string");
        expect(typeof r.role).toBe("string");
        expect(typeof r.session_id).toBe("string");
        expect(typeof r.project).toBe("string");
        expect(typeof r.project_name).toBe("string");
        expect(typeof r.turn_range).toBe("string");
        expect(typeof r.has_more_before).toBe("boolean");
        expect(typeof r.has_more_after).toBe("boolean");
      }

      // session_id should match our seeded session
      const ids = parsed.results.map((r: any) => r.session_id);
      expect(ids).toContain(SESSION_ID);

      // Save a chunk_id for the context test
      foundChunkId = parsed.results[0].chunk_id;
    },
    30000
  );

  it(
    "handleGetContext: returns context for a chunk_id from search results",
    async () => {
      // foundChunkId is set by the search test above
      expect(foundChunkId).toBeGreaterThan(0);

      const response = await handleGetContext(db, {
        chunk_id: foundChunkId,
        direction: "both",
        count: 2,
      });

      expect(response.content).toHaveLength(1);
      expect(response.content[0].type).toBe("text");

      const parsed = JSON.parse(response.content[0].text);

      // Anchor chunk must be present
      expect(parsed.anchor).toBeDefined();
      expect(parsed.anchor.chunk_id).toBe(foundChunkId);
      expect(typeof parsed.anchor.content).toBe("string");
      expect(typeof parsed.anchor.role).toBe("string");

      // before/after arrays must exist (may be empty at boundaries)
      expect(Array.isArray(parsed.before)).toBe(true);
      expect(Array.isArray(parsed.after)).toBe(true);

      // session_id and project must be present
      expect(parsed.session_id).toBe(SESSION_ID);
      expect(typeof parsed.project).toBe("string");

      // All chunk objects must have the expected shape
      const allChunks = [parsed.anchor, ...parsed.before, ...parsed.after];
      for (const chunk of allChunks) {
        expect(typeof chunk.chunk_id).toBe("number");
        expect(typeof chunk.content).toBe("string");
        expect(typeof chunk.role).toBe("string");
        expect("timestamp" in chunk).toBe(true);
      }
    },
    10000
  );

  it(
    "handleListSessions: returns session metadata including indexed status",
    async () => {
      const response = await handleListSessions(db, {});

      expect(response.content).toHaveLength(1);
      expect(response.content[0].type).toBe("text");

      const parsed = JSON.parse(response.content[0].text);

      expect(Array.isArray(parsed.sessions)).toBe(true);
      expect(parsed.sessions.length).toBeGreaterThanOrEqual(1);
      expect(typeof parsed.total_sessions).toBe("number");
      expect(typeof parsed.total_indexed).toBe("number");
      expect(parsed.total_indexed).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(parsed.projects)).toBe(true);

      // Find our seeded session
      const s = parsed.sessions.find(
        (sess: any) => sess.session_id === SESSION_ID
      );
      expect(s).toBeDefined();
      expect(typeof s.session_id).toBe("string");
      expect(typeof s.project).toBe("string");
      expect(typeof s.project_name).toBe("string");
      expect(typeof s.branch).toBe("string");
      expect(s.branch).toBe("feature/auth");
      expect(typeof s.model).toBe("string");
      expect(typeof s.indexed).toBe("boolean");
      expect(s.indexed).toBe(true);
      expect(typeof s.chunk_count).toBe("number");
      expect(s.chunk_count).toBeGreaterThanOrEqual(1);

      // Projects summary must include our project
      const proj = parsed.projects.find((p: any) =>
        p.name.includes("jwtapp")
      );
      expect(proj).toBeDefined();
      expect(proj.session_count).toBeGreaterThanOrEqual(1);
    },
    10000
  );
});
