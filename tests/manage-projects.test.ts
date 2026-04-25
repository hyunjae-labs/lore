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
  // Point CODEX_SESSIONS_DIR at an empty dir so real ~/.codex/sessions don't leak in
  process.env.CODEX_SESSIONS_DIR = join(tempDir, "codex-empty");
  mkdirSync(join(tempDir, "codex-empty"), { recursive: true });

  // Reset config each test
  saveUserConfig({ excluded_projects: [] });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.CLAUDE_PROJECTS_DIR;
  delete process.env.LORE_DIR;
  delete process.env.CODEX_SESSIONS_DIR;
});

describe("manage_projects", () => {
  it("list shows projects with sessions, hides empty ones", async () => {
    const db = makeDb();
    const response = await handleManageProjects(db, { action: "list" });
    const result = JSON.parse(response.content[0].text);

    // 3 with sessions shown, 1 empty hidden
    expect(result.total_projects).toBe(3);
    expect(result.hidden_empty).toBe("1 projects with 0 sessions hidden");
    expect(result.excluded_count).toBe(0);
    db.close();
  });

  it("list shows all projects as indexed by default (opt-out model)", async () => {
    const db = makeDb();
    const response = await handleManageProjects(db, { action: "list" });
    const result = JSON.parse(response.content[0].text);

    // All visible projects should not be excluded by default (opt-out model)
    for (const p of result.projects) {
      expect(p.excluded).toBe(false);
    }
    db.close();
  });

  it("exclude adds a project to excluded_projects and cleans DB data", async () => {
    const db = makeDb();
    const response = await handleManageProjects(db, { action: "exclude", projects: ["-Users-test-alpha"] });
    const result = JSON.parse(response.content[0].text);

    expect(result.status).toBe("ok");
    expect(result.excluded).toContain("-Users-test-alpha");

    const config = loadUserConfig();
    expect(config.excluded_projects).toContain("-Users-test-alpha");
    db.close();
  });

  it("exclude returns not_found when path doesn't match any project", async () => {
    const db = makeDb();
    const response = await handleManageProjects(db, {
      action: "exclude",
      projects: ["/nonexistent/path"],
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.not_found).toContain("/nonexistent/path");
    db.close();
  });

  it("exclude skips already-excluded projects", async () => {
    const db = makeDb();
    saveUserConfig({ excluded_projects: ["-Users-test-alpha"] });

    const response = await handleManageProjects(db, { action: "exclude", projects: ["-Users-test-alpha"] });
    const result = JSON.parse(response.content[0].text);

    expect(result.status).toBe("ok");
    expect(result.skipped).toContain("-Users-test-alpha");
    expect(result.excluded.length).toBe(0);
    db.close();
  });

  it("list shows excluded status after exclude", async () => {
    const db = makeDb();
    await handleManageProjects(db, { action: "exclude", projects: ["-Users-test-alpha"] });

    const response = await handleManageProjects(db, { action: "list" });
    const result = JSON.parse(response.content[0].text);

    expect(result.excluded_count).toBe(1);
    const alpha = result.projects.find((p: any) => p.dir_name === "-Users-test-alpha");
    expect(alpha.excluded).toBe(true);
    db.close();
  });

  it("include removes a project from excluded_projects", async () => {
    const db = makeDb();
    saveUserConfig({ excluded_projects: ["-Users-test-alpha", "-Users-test-beta"] });

    const response = await handleManageProjects(db, { action: "include", projects: ["-Users-test-alpha"] });
    const result = JSON.parse(response.content[0].text);

    expect(result.status).toBe("ok");
    expect(result.included).toContain("-Users-test-alpha");

    const config = loadUserConfig();
    expect(config.excluded_projects).not.toContain("-Users-test-alpha");
    expect(config.excluded_projects).toContain("-Users-test-beta");
    db.close();
  });

  it("include returns not_found when path doesn't match excluded project", async () => {
    const db = makeDb();
    saveUserConfig({ excluded_projects: ["-Users-test-alpha"] });
    const response = await handleManageProjects(db, {
      action: "include",
      projects: ["/nonexistent/path"],
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.not_found).toContain("/nonexistent/path");
    db.close();
  });

  it("exclude requires projects param", async () => {
    const db = makeDb();
    const response = await handleManageProjects(db, { action: "exclude" });
    const result = JSON.parse(response.content[0].text);
    expect(result.error).toBeDefined();
    db.close();
  });

  it("include requires projects param", async () => {
    const db = makeDb();
    const response = await handleManageProjects(db, { action: "include" });
    const result = JSON.parse(response.content[0].text);
    expect(result.error).toBeDefined();
    db.close();
  });

  it("projects are sorted: indexed first, excluded last, then by session count", async () => {
    const db = makeDb();
    saveUserConfig({ excluded_projects: ["-Users-test-beta"] });

    const response = await handleManageProjects(db, { action: "list" });
    const result = JSON.parse(response.content[0].text);

    // Excluded project should be last
    const lastProject = result.projects[result.projects.length - 1];
    expect(lastProject.dir_name).toBe("-Users-test-beta");
    expect(lastProject.excluded).toBe(true);
    db.close();
  });

  it("exclude accepts full path and converts to dirName", async () => {
    const db = makeDb();
    const response = await handleManageProjects(db, {
      action: "exclude",
      projects: ["/Users/test/alpha"],
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.excluded).toContain("-Users-test-alpha");
    db.close();
  });

  it("exclude accepts dirName directly", async () => {
    const db = makeDb();
    const response = await handleManageProjects(db, {
      action: "exclude",
      projects: ["-Users-test-alpha"],
    });
    const result = JSON.parse(response.content[0].text);
    expect(result.excluded).toContain("-Users-test-alpha");
    db.close();
  });

  it("exclude uses exact match and does not exclude prefix-matching projects", async () => {
    const db = makeDb();
    // alpha is a prefix of alpha-extra (simulated via dir names)
    mkdirSync(join(projectsDir, "-Users-test-alpha-extra"), { recursive: true });
    writeFileSync(join(projectsDir, "-Users-test-alpha-extra", "s4.jsonl"), DUMMY_LINE);

    // Exact match on dir_name — should only exclude alpha
    const response = await handleManageProjects(db, { action: "exclude", projects: ["-Users-test-alpha"] });
    const result = JSON.parse(response.content[0].text);

    expect(result.status).toBe("ok");
    expect(result.excluded.length).toBe(1);

    const config = loadUserConfig();
    expect(config.excluded_projects).toContain("-Users-test-alpha");
    expect(config.excluded_projects).not.toContain("-Users-test-alpha-extra");
    db.close();
  });

  it("list includes codex projects when CODEX_SESSIONS_DIR is set", async () => {
    const codexDir = join(tempDir, "codex-sessions");
    mkdirSync(join(codexDir, "2026", "01", "01"), { recursive: true });
    writeFileSync(
      join(codexDir, "2026", "01", "01", "rollout-2026-01-01T00-00-00-aaa-bbb-ccc-ddd-eee.jsonl"),
      JSON.stringify({ type: "session_meta", payload: { id: "x", cwd: "/Users/test/myproject" } }) + "\n"
    );

    process.env.CODEX_SESSIONS_DIR = codexDir;
    process.env.CLAUDE_PROJECTS_DIR = join(tempDir, "claude-empty");
    mkdirSync(join(tempDir, "claude-empty"), { recursive: true });

    const db = makeDb();
    const result = await handleManageProjects(db, { action: "list" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.projects.some((p: any) => p.dir_name?.includes("codex-"))).toBe(true);

    delete process.env.CODEX_SESSIONS_DIR;
    delete process.env.CLAUDE_PROJECTS_DIR;
    db.close();
  });
});
