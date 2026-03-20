import { readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { CONFIG } from "../config.js";

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
