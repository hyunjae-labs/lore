import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { SCHEMA_SQL, VEC_TABLE_SQL, FTS_TABLE_SQL } from "../src/db/schema.js";
import { handleManageProjects } from "../src/tools/manage-projects.js";
import { loadUserConfig, saveUserConfig } from "../src/config.js";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  sqliteVec.load(db);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA_SQL);
  db.exec(VEC_TABLE_SQL);
  db.exec(FTS_TABLE_SQL);
  return db;
}

const DUMMY_LINE = JSON.stringify({
  type: "user", sessionId: "dummy", timestamp: "2024-01-01T00:00:00Z",
  message: { role: "user", content: "test" },
}) + "\n";

let tempDir: string;
let projectsDir: string;
let loreDir: string;

beforeEach(() => {
  const ts = Date.now();
  tempDir = join(tmpdir(), `lore-manage-test-${ts}`);
  projectsDir = join(tempDir, "projects");
  loreDir = join(tempDir, "lore");

  mkdirSync(projectsDir, { recursive: true });
  mkdirSync(loreDir, { recursive: true });

  // Create projects with sessions
  mkdirSync(join(projectsDir, "-Users-test-alpha"), { recursive: true });
  mkdirSync(join(projectsDir, "-Users-test-beta"), { recursive: true });
  mkdirSync(join(projectsDir, "-Users-test-temp-workspace"), { recursive: true });
  mkdirSync(join(projectsDir, "-Users-test-empty-project"), { recursive: true }); // no sessions

  writeFileSync(join(projectsDir, "-Users-test-alpha", "s1.jsonl"), DUMMY_LINE);
  writeFileSync(join(projectsDir, "-Users-test-beta", "s2.jsonl"), DUMMY_LINE);
  writeFileSync(join(projectsDir, "-Users-test-temp-workspace", "s3.jsonl"), DUMMY_LINE);

  process.env.CLAUDE_PROJECTS_DIR = projectsDir;
  process.env.LORE_DIR = loreDir;

  // Reset config each test
  saveUserConfig({ indexed_projects: [] });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.CLAUDE_PROJECTS_DIR;
  delete process.env.LORE_DIR;
});

describe("manage_projects", () => {
  it("list shows projects with sessions, hides empty ones", async () => {
    const db = makeDb();
    const response = await handleManageProjects(db, { action: "list" });
    const result = JSON.parse(response.content[0].text);

    // 3 with sessions shown, 1 empty hidden
    expect(result.total_projects).toBe(3);
    expect(result.hidden_empty).toBe("1 projects with 0 sessions hidden");
    expect(result.registered_count).toBe(0);
    db.close();
  });

  it("add registers a project when exactly 1 match", async () => {
    const db = makeDb();
    // "alpha" matches only "-Users-test-alpha"
    const response = await handleManageProjects(db, { action: "add", project: "test-alpha" });
    const result = JSON.parse(response.content[0].text);

    expect(result.status).toBe("ok");
    expect(result.added).toContain("test-alpha");

    const config = loadUserConfig();
    expect(config.indexed_projects).toContain("-Users-test-alpha");
    db.close();
  });

  it("add returns multiple_matches when ambiguous", async () => {
    const db = makeDb();
    // "test" matches all 3 projects
    const response = await handleManageProjects(db, { action: "add", project: "test" });
    const result = JSON.parse(response.content[0].text);

    expect(result.status).toBe("multiple_matches");
    expect(result.matches.length).toBeGreaterThan(1);

    // Nothing should be registered
    const config = loadUserConfig();
    expect(config.indexed_projects.length).toBe(0);
    db.close();
  });

  it("add returns error when no project matches", async () => {
    const db = makeDb();
    const response = await handleManageProjects(db, { action: "add", project: "nonexistent" });
    const result = JSON.parse(response.content[0].text);

    expect(result.error).toBeDefined();
    db.close();
  });

  it("list shows registered status after add", async () => {
    const db = makeDb();
    await handleManageProjects(db, { action: "add", project: "test-alpha" });

    const response = await handleManageProjects(db, { action: "list" });
    const result = JSON.parse(response.content[0].text);

    expect(result.registered_count).toBe(1);
    const alpha = result.projects.find((p: any) => p.dir_name === "-Users-test-alpha");
    expect(alpha.registered).toBe(true);
    db.close();
  });

  it("remove unregisters a project and deletes DB data", async () => {
    const db = makeDb();
    saveUserConfig({ indexed_projects: ["-Users-test-alpha", "-Users-test-beta"] });

    const response = await handleManageProjects(db, { action: "remove", project: "test-alpha" });
    const result = JSON.parse(response.content[0].text);

    expect(result.status).toBe("ok");
    expect(result.removed_count).toBe(1);

    const config = loadUserConfig();
    expect(config.indexed_projects).not.toContain("-Users-test-alpha");
    expect(config.indexed_projects).toContain("-Users-test-beta");
    db.close();
  });

  it("add requires project param", async () => {
    const db = makeDb();
    const response = await handleManageProjects(db, { action: "add" });
    const result = JSON.parse(response.content[0].text);
    expect(result.error).toBeDefined();
    db.close();
  });

  it("projects are sorted: registered first, then by session count", async () => {
    const db = makeDb();
    saveUserConfig({ indexed_projects: ["-Users-test-beta"] });

    const response = await handleManageProjects(db, { action: "list" });
    const result = JSON.parse(response.content[0].text);

    expect(result.projects[0].dir_name).toBe("-Users-test-beta");
    expect(result.projects[0].registered).toBe(true);
    db.close();
  });
});
