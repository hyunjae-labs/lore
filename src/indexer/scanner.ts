import { readdirSync, statSync, openSync, closeSync, readSync } from "node:fs";
import { join, basename } from "node:path";
import { CONFIG } from "../config.js";
import { pathToDirName } from "../utils/path.js";

export interface ProjectInfo {
  dirName: string;        // e.g., "-Users-username-01-projects-my-webapp"
  dirPath: string;        // full path to project dir
  name: string;           // full dirPath (unique, no collisions)
}

export interface SessionInfo {
  sessionId: string;      // UUID from filename (without .jsonl)
  jsonlPath: string;      // full path to .jsonl file
  size: number;           // file size in bytes
  mtime: number;          // modification time (ms since epoch)
  format?: "claude" | "codex";  // undefined means "claude" (backward compat)
}

export function scanProjects(baseDir?: string): ProjectInfo[] {
  const dir = baseDir || CONFIG.claudeProjectsDir;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];  // dir doesn't exist = no projects
  }

  return entries
    .filter((name) => {
      try {
        return statSync(join(dir, name)).isDirectory() && !name.startsWith(".");
      } catch { return false; }
    })
    .map((dirName) => ({
      dirName,
      dirPath: join(dir, dirName),
      name: join(dir, dirName),
    }));
}

export function scanSessions(projectDir: string): SessionInfo[] {
  let entries: string[];
  try {
    entries = readdirSync(projectDir);
  } catch {
    return [];
  }

  return entries
    .filter((name) => name.endsWith(".jsonl") && !name.startsWith("."))
    .map((name) => {
      const fullPath = join(projectDir, name);
      try {
        const stat = statSync(fullPath);
        return {
          sessionId: basename(name, ".jsonl"),
          jsonlPath: fullPath,
          size: stat.size,
          mtime: stat.mtimeMs,
        };
      } catch { return null; }
    })
    .filter((s): s is SessionInfo => s !== null);
}

export function needsReindex(
  session: SessionInfo,
  existingSize: number | null,
  existingMtime: number | null,
  existingOffset: number
): "rebuild" | "append" | "skip" {
  // New session
  if (existingSize === null) return "rebuild";

  // File shrunk — needs full re-index
  if (session.size < existingOffset) return "rebuild";

  // File changed (size or mtime differ)
  if (session.size !== existingSize || Math.abs(session.mtime - (existingMtime || 0)) > 1000) {
    return "append";
  }

  return "skip";
}

/**
 * Read the first line of a Codex session file and extract cwd from session_meta.
 * Reads in 16KB chunks until a newline is found (Codex `instructions` field can
 * push the first line past 25KB). Hard limit 1MB to bound runaway files.
 */
export function extractCodexCwd(filePath: string): string | null {
  const CHUNK = 16384;
  const MAX_BYTES = 1024 * 1024;
  let fd: number | null = null;
  try {
    fd = openSync(filePath, "r");
    let collected = Buffer.alloc(0);
    let pos = 0;
    let newlineIdx = -1;
    while (newlineIdx === -1 && collected.length < MAX_BYTES) {
      const chunk = Buffer.alloc(CHUNK);
      const n = readSync(fd, chunk, 0, CHUNK, pos);
      if (n === 0) break;
      collected = Buffer.concat([collected, chunk.subarray(0, n)]);
      newlineIdx = collected.indexOf(0x0a);
      pos += n;
    }
    const firstLineBuf = newlineIdx === -1 ? collected : collected.subarray(0, newlineIdx);
    const firstLine = firstLineBuf.toString("utf-8");
    if (!firstLine) return null;
    const obj = JSON.parse(firstLine);
    if (obj?.type === "session_meta") {
      return obj?.payload?.cwd || null;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/** Recursively find all rollout-*.jsonl files under dir. */
function findCodexFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    try {
      const s = statSync(full);
      if (s.isDirectory()) {
        results.push(...findCodexFiles(full));
      } else if (entry.startsWith("rollout-") && entry.endsWith(".jsonl")) {
        results.push(full);
      }
    } catch { /* ignore */ }
  }
  return results;
}

/**
 * Scan ~/.codex/sessions, group sessions by cwd into virtual ProjectInfo entries.
 * dirName = "codex-" + pathToDirName(cwd)
 */
export function scanCodexProjectsAndSessions(codexSessionsDir: string): Array<{
  project: ProjectInfo;
  sessions: SessionInfo[];
}> {
  const files = findCodexFiles(codexSessionsDir);
  if (files.length === 0) return [];

  const byCwd = new Map<string, string[]>();
  for (const filePath of files) {
    const cwd = extractCodexCwd(filePath) ?? "__unknown__";
    if (!byCwd.has(cwd)) byCwd.set(cwd, []);
    byCwd.get(cwd)!.push(filePath);
  }

  return Array.from(byCwd.entries()).map(([cwd, filePaths]) => {
    const dirName = "codex-" + pathToDirName(cwd);
    const virtualPath = join(codexSessionsDir, dirName);

    const project: ProjectInfo = {
      dirName,
      dirPath: virtualPath,
      name: virtualPath,
    };

    const sessions: SessionInfo[] = filePaths
      .map((filePath): SessionInfo | null => {
        try {
          const s = statSync(filePath);
          return {
            sessionId: basename(filePath, ".jsonl"),
            jsonlPath: filePath,
            size: s.size,
            mtime: s.mtimeMs,
            format: "codex" as const,
          };
        } catch {
          return null;
        }
      })
      .filter((s): s is SessionInfo => s !== null);

    return { project, sessions };
  });
}
