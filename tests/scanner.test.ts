import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  scanProjects,
  scanSessions,
  needsReindex,
} from "../src/indexer/scanner.js";
import { CONFIG } from "../src/config.js";

describe("CONFIG.codexSessionsDir", () => {
  it("defaults to ~/.codex/sessions", () => {
    delete process.env.CODEX_SESSIONS_DIR;
    expect(CONFIG.codexSessionsDir).toContain(".codex/sessions");
  });

  it("respects CODEX_SESSIONS_DIR env var", () => {
    process.env.CODEX_SESSIONS_DIR = "/tmp/test-codex";
    expect(CONFIG.codexSessionsDir).toBe("/tmp/test-codex");
    delete process.env.CODEX_SESSIONS_DIR;
  });
});

let tempDir: string;

beforeEach(() => {
  tempDir = join(tmpdir(), `lore-scanner-test-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("scanProjects", () => {
  it("discovers project directories", () => {
    mkdirSync(join(tempDir, "-Users-testuser-01-projects-my-webapp"));
    mkdirSync(join(tempDir, "-Users-testuser-01-projects-temp-workspace2"));

    const projects = scanProjects(tempDir);
    expect(projects).toHaveLength(2);

    const names = projects.map((p) => p.dirName).sort();
    expect(names).toContain("-Users-testuser-01-projects-my-webapp");
    expect(names).toContain("-Users-testuser-01-projects-temp-workspace2");
  });

  it("ignores dot-prefixed directories", () => {
    mkdirSync(join(tempDir, "-Users-testuser-01-projects-myapp"));
    mkdirSync(join(tempDir, ".hidden-dir"));

    const projects = scanProjects(tempDir);
    expect(projects).toHaveLength(1);
    expect(projects[0].dirName).toBe("-Users-testuser-01-projects-myapp");
  });

  it("populates dirPath and name fields", () => {
    mkdirSync(join(tempDir, "-Users-testuser-01-projects-my-webapp"));

    const projects = scanProjects(tempDir);
    expect(projects).toHaveLength(1);
    const expectedPath = join(tempDir, "-Users-testuser-01-projects-my-webapp");
    expect(projects[0].dirPath).toBe(expectedPath);
    expect(projects[0].name).toBe(expectedPath);
  });

  it("returns empty array when base dir does not exist", () => {
    const result = scanProjects(join(tempDir, "nonexistent"));
    expect(result).toEqual([]);
  });

  it("ignores files (only returns directories)", () => {
    mkdirSync(join(tempDir, "-Users-testuser-projects-myapp"));
    writeFileSync(join(tempDir, "some-file.txt"), "data");

    const projects = scanProjects(tempDir);
    expect(projects).toHaveLength(1);
    expect(projects[0].dirName).toBe("-Users-testuser-projects-myapp");
  });
});

describe("scanSessions", () => {
  it("discovers .jsonl files", () => {
    const projectDir = join(tempDir, "my-project");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "04ccff03-abcd-1234-efgh-000000000001.jsonl"), '{"type":"user"}');
    writeFileSync(join(projectDir, "7c05ea9a-abcd-1234-efgh-000000000002.jsonl"), '{"type":"assistant"}');

    const sessions = scanSessions(projectDir);
    expect(sessions).toHaveLength(2);

    const ids = sessions.map((s) => s.sessionId).sort();
    expect(ids).toContain("04ccff03-abcd-1234-efgh-000000000001");
    expect(ids).toContain("7c05ea9a-abcd-1234-efgh-000000000002");
  });

  it("ignores non-jsonl files", () => {
    const projectDir = join(tempDir, "my-project");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "session.jsonl"), "{}");
    writeFileSync(join(projectDir, "README.md"), "# docs");
    writeFileSync(join(projectDir, "data.json"), "{}");

    const sessions = scanSessions(projectDir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe("session");
  });

  it("ignores dot-prefixed .jsonl files", () => {
    const projectDir = join(tempDir, "my-project");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "valid-session.jsonl"), "{}");
    writeFileSync(join(projectDir, ".hidden.jsonl"), "{}");

    const sessions = scanSessions(projectDir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe("valid-session");
  });

  it("returns size and mtime metadata", () => {
    const projectDir = join(tempDir, "my-project");
    mkdirSync(projectDir);
    const content = '{"type":"user","message":{"role":"user","content":"hello"}}';
    writeFileSync(join(projectDir, "abc-123.jsonl"), content);

    const sessions = scanSessions(projectDir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].size).toBe(Buffer.byteLength(content));
    expect(sessions[0].mtime).toBeGreaterThan(0);
    expect(sessions[0].jsonlPath).toBe(join(projectDir, "abc-123.jsonl"));
  });

  it("returns empty array when project dir does not exist", () => {
    const result = scanSessions(join(tempDir, "nonexistent"));
    expect(result).toEqual([]);
  });
});

describe("needsReindex", () => {
  const makeSession = (size: number, mtime: number) => ({
    sessionId: "test-session",
    jsonlPath: "/tmp/test.jsonl",
    size,
    mtime,
  });

  it('returns "rebuild" for new sessions (existingSize null)', () => {
    const session = makeSession(1000, Date.now());
    expect(needsReindex(session, null, null, 0)).toBe("rebuild");
  });

  it('returns "rebuild" when file shrunk below existing offset', () => {
    const session = makeSession(500, Date.now());
    // existingOffset is 800, but new file is 500 bytes — it shrunk
    expect(needsReindex(session, 800, Date.now(), 800)).toBe("rebuild");
  });

  it('returns "append" when file grew (size changed)', () => {
    const now = Date.now();
    const session = makeSession(2000, now);
    // previously was 1000 bytes at same mtime
    expect(needsReindex(session, 1000, now, 1000)).toBe("append");
  });

  it('returns "append" when mtime changed significantly', () => {
    const session = makeSession(1000, Date.now());
    const oldMtime = Date.now() - 5000; // 5 seconds ago
    expect(needsReindex(session, 1000, oldMtime, 0)).toBe("append");
  });

  it('returns "skip" when size and mtime are unchanged', () => {
    const now = Date.now();
    const session = makeSession(1000, now);
    expect(needsReindex(session, 1000, now, 500)).toBe("skip");
  });

  it('returns "skip" when mtime differs by less than 1000ms', () => {
    const base = Date.now();
    const session = makeSession(1000, base);
    // mtime differs by 500ms — within tolerance
    expect(needsReindex(session, 1000, base - 500, 500)).toBe("skip");
  });
});
