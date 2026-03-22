import { openSync, closeSync, readSync, unlinkSync, readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import type Database from "better-sqlite3";
import { CONFIG } from "../config.js";
import {
  upsertProject,
  upsertSession,
  insertChunkWithVector,
  updateSessionMetadata,
  deleteSessionChunks,
} from "../db/queries.js";
import type { SessionRow } from "../db/queries.js";
import { parseLine } from "../indexer/parser.js";
import { groupIntoLogicalTurns, chunkTurns } from "../indexer/chunker.js";
import { getEmbedder } from "../embedder/index.js";
import { scanProjects, scanSessions, needsReindex } from "../indexer/scanner.js";
import type { SessionInfo } from "../indexer/scanner.js";
import { loadUserConfig, saveUserConfig } from "../config.js";
import { pathToDirName } from "../utils/path.js";
import { toolResult } from "./helpers.js";

// ── Background indexing state ────────────────────────────────────────────────

export interface SkipReasons {
  no_parseable_content: number;
  empty_file: number;
  read_error: number;
  no_chunks_after_processing: number;
}

export interface IndexProgress {
  running: boolean;
  sessionsScanned: number;
  sessionsIndexed: number;
  sessionsSkipped: number;
  sessionsTotal: number;
  chunksCreated: number;
  currentProject: string;
  currentSessionChunks: number;  // chunks in current session being processed
  currentSessionTotal: number;   // total chunks to embed for current session
  startedAt: number;
  completedAt: number | null;
  error: string | null;
  skipReasons: SkipReasons;
}

const progress: IndexProgress = {
  running: false,
  sessionsScanned: 0,
  sessionsIndexed: 0,
  sessionsSkipped: 0,
  sessionsTotal: 0,
  chunksCreated: 0,
  currentProject: "",
  currentSessionChunks: 0,
  currentSessionTotal: 0,
  startedAt: 0,
  completedAt: null,
  error: null,
  skipReasons: { no_parseable_content: 0, empty_file: 0, read_error: 0, no_chunks_after_processing: 0 },
};

export function getIndexProgress(): IndexProgress {
  return { ...progress };
}

/** Wait for background indexing to complete (for testing only) */
export async function waitForIndexComplete(timeoutMs = 60000): Promise<void> {
  const start = Date.now();
  while (progress.running && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ── Advisory lock (PID-based) ────────────────────────────────────────────────

function acquireLock(loreDir: string): boolean {
  const lockPath = join(loreDir, "index.lock");
  try {
    // Check if existing lock is stale
    const content = readFileSync(lockPath, "utf-8");
    const pid = parseInt(content, 10);
    if (pid && !isProcessAlive(pid)) {
      unlinkSync(lockPath); // stale lock
    } else {
      return false; // active lock
    }
  } catch {
    // No lock file — proceed
  }
  try {
    writeFileSync(lockPath, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

function releaseLock(loreDir: string): void {
  const lockPath = join(loreDir, "index.lock");
  try { unlinkSync(lockPath); } catch { /* ignore */ }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Clean up lock on exit
process.on("exit", () => releaseLock(CONFIG.loreDir));
process.on("SIGINT", () => { releaseLock(CONFIG.loreDir); process.exit(130); });
process.on("SIGTERM", () => { releaseLock(CONFIG.loreDir); process.exit(143); });

// ── Lightweight single-session indexing (for search-time auto-index) ─────────

/**
 * Find only the sessions worth stat()ing: new files not in DB + the most recently active known session.
 * This avoids stat()ing every JSONL file on every search — only O(new_files + 1) stats instead of O(all).
 */
function findCandidateSessions(db: Database.Database, projectDir: string, projectId: number): SessionInfo[] {
  // 1. readdir (no stat, fast)
  let files: string[];
  try {
    files = readdirSync(projectDir).filter(name => name.endsWith(".jsonl") && !name.startsWith("."));
  } catch {
    return [];
  }

  // 2. Get all known session IDs for this project from DB
  const knownRows = db
    .prepare("SELECT session_id, jsonl_mtime FROM sessions WHERE project_id = ?")
    .all(projectId) as Array<{ session_id: string; jsonl_mtime: number | null }>;
  const knownSet = new Set(knownRows.map(r => r.session_id));

  const candidates: SessionInfo[] = [];

  // 3. New sessions (not in DB) — must stat to get size/mtime
  for (const name of files) {
    const sessionId = basename(name, ".jsonl");
    if (!knownSet.has(sessionId)) {
      const fullPath = join(projectDir, name);
      try {
        const stat = statSync(fullPath);
        candidates.push({ sessionId, jsonlPath: fullPath, size: stat.size, mtime: stat.mtimeMs });
      } catch { /* skip unreadable files */ }
    }
  }

  // 4. Most recently active known session — stat only this one
  if (knownRows.length > 0) {
    const mostRecent = knownRows.reduce((a, b) =>
      (a.jsonl_mtime ?? 0) > (b.jsonl_mtime ?? 0) ? a : b
    );
    const fullPath = join(projectDir, mostRecent.session_id + ".jsonl");
    try {
      const stat = statSync(fullPath);
      candidates.push({ sessionId: mostRecent.session_id, jsonlPath: fullPath, size: stat.size, mtime: stat.mtimeMs });
    } catch { /* file may have been deleted */ }
  }

  return candidates;
}

export async function indexStaleSessions(db: Database.Database): Promise<number> {
  const userConfig = loadUserConfig();
  if (userConfig.indexed_projects.length === 0) return 0;

  const allProjects = scanProjects(CONFIG.claudeProjectsDir);
  const registered = new Set(userConfig.indexed_projects);
  const projectsToIndex = allProjects.filter((p) => registered.has(p.dirName));

  let totalIndexed = 0;
  const embedder = await getEmbedder();

  for (const project of projectsToIndex) {
    const projectId = upsertProject(db, {
      dir_name: project.dirName,
      path: project.dirPath,
      name: project.name,
    });

    // Only stat candidates: new sessions + the most recently active session
    const candidates = findCandidateSessions(db, project.dirPath, projectId);

    for (const sessionInfo of candidates) {
      const existingSession = db
        .prepare("SELECT * FROM sessions WHERE session_id = ?")
        .get(sessionInfo.sessionId) as SessionRow | undefined;

      const existingSize = existingSession?.jsonl_size ?? null;
      const existingMtime = existingSession?.jsonl_mtime ?? null;
      const existingOffset = existingSession?.indexed_offset ?? 0;

      const strategy = needsReindex(sessionInfo, existingSize, existingMtime, existingOffset);
      if (strategy === "skip") continue;

      const sessionDbId = upsertSession(db, {
        project_id: projectId,
        session_id: sessionInfo.sessionId,
        jsonl_path: sessionInfo.jsonlPath,
        jsonl_size: sessionInfo.size,
        jsonl_mtime: sessionInfo.mtime,
      });

      let readOffset = existingOffset;
      if (strategy === "rebuild") {
        deleteSessionChunks(db, sessionDbId);
        readOffset = 0;
      }

      let lines: string[];
      try {
        lines = readJsonlFromOffset(sessionInfo.jsonlPath, readOffset);
      } catch { continue; }
      if (lines.length === 0) continue;

      const records = lines.map((line) => parseLine(line)).filter((r) => r !== null);
      if (records.length === 0) continue;

      let intent: string | null = null;
      let branch: string | null = null;
      let model: string | null = null;
      let startedAt: string | null = null;
      let endedAt: string | null = null;

      for (const record of records) {
        if (record.timestamp) {
          if (!startedAt) startedAt = record.timestamp;
          endedAt = record.timestamp;
        }
        if (intent === null && record.type === "user" && !record.isToolResult && record.text) {
          intent = record.text.slice(0, 200);
        }
        if (branch === null && record.gitBranch) branch = record.gitBranch;
        if (model === null && record.model) model = record.model;
      }

      const turns = groupIntoLogicalTurns(records);
      const chunks = chunkTurns(turns, CONFIG.maxChunkTokens, CONFIG.shortTurnThreshold);
      if (chunks.length === 0) continue;

      const textsToEmbed = chunks.map((chunk) => `passage: ${chunk.content}`);
      const embeddings = await embedder.embedBatch(textsToEmbed);

      let chunkIndexOffset = 0;
      if (strategy === "append" && existingSession) {
        const maxChunkRow = db
          .prepare("SELECT MAX(chunk_index) as max_idx FROM chunks WHERE session_id = ?")
          .get(sessionDbId) as { max_idx: number | null };
        chunkIndexOffset = (maxChunkRow.max_idx ?? -1) + 1;
      }

      const insertAllChunks = db.transaction(() => {
        for (let i = 0; i < chunks.length; i++) {
          insertChunkWithVector(db, {
            session_id: sessionDbId,
            chunk_index: chunkIndexOffset + i,
            role: chunks[i].role,
            content: chunks[i].content,
            timestamp: chunks[i].timestamp || null,
            turn_start: chunks[i].turnStart,
            turn_end: chunks[i].turnEnd,
            token_count: chunks[i].tokenCount,
            embedding: embeddings[i],
          });
        }
      });
      insertAllChunks();

      const newOffset = statSync(sessionInfo.jsonlPath).size;
      updateSessionMetadata(db, {
        session_id: sessionDbId,
        indexed_offset: newOffset,
        indexed_at: new Date().toISOString(),
        turn_count: turns.length,
        started_at: startedAt,
        ended_at: endedAt,
        branch,
        model,
        intent,
        jsonl_size: sessionInfo.size,
        jsonl_mtime: sessionInfo.mtime,
      });

      totalIndexed++;
    }
  }

  return totalIndexed;
}

// ── Orphan pruning ───────────────────────────────────────────────────────────

/**
 * Remove DB sessions whose JSONL files no longer exist on disk.
 * For each project: readdir -> compare with DB -> delete orphans.
 * If directory is gone, all sessions for that project are orphans.
 */
function pruneOrphanSessions(
  db: Database.Database,
  projectsToIndex: Array<{ dirName: string; dirPath: string; name: string }>
): number {
  let pruned = 0;

  for (const project of projectsToIndex) {
    const projectRow = db
      .prepare("SELECT id FROM projects WHERE dir_name = ?")
      .get(project.dirName) as { id: number } | undefined;
    if (!projectRow) continue;

    const dbSessions = db
      .prepare("SELECT id, session_id FROM sessions WHERE project_id = ?")
      .all(projectRow.id) as Array<{ id: number; session_id: string }>;
    if (dbSessions.length === 0) continue;

    let diskFiles: Set<string>;
    try {
      const files = readdirSync(project.dirPath)
        .filter((name) => name.endsWith(".jsonl") && !name.startsWith("."));
      diskFiles = new Set(files.map((f) => basename(f, ".jsonl")));
    } catch {
      diskFiles = new Set();
    }

    for (const dbSession of dbSessions) {
      if (!diskFiles.has(dbSession.session_id)) {
        deleteSessionChunks(db, dbSession.id);
        db.prepare("DELETE FROM sessions WHERE id = ?").run(dbSession.id);
        pruned++;
      }
    }
  }

  return pruned;
}

// ── JSONL reading ────────────────────────────────────────────────────────────

function readJsonlFromOffset(filePath: string, offset: number): string[] {
  const fd = openSync(filePath, "r");
  try {
    const fileSize = statSync(filePath).size;
    if (offset >= fileSize) return [];
    const length = fileSize - offset;
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, offset);
    return buffer.toString("utf-8").split("\n").filter(Boolean);
  } finally {
    closeSync(fd);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

let cancelRequested = false;

export interface IndexParams {
  mode?: "rebuild" | "cancel";
  project?: string;
  scope?: "all";
  confirm?: boolean;
}

export async function handleIndex(
  db: Database.Database,
  params: IndexParams
): Promise<{ content: Array<{ type: string; text: string }> }> {

  // Rebuild requires explicit confirmation (safety gate)
  // confirm is intentionally excluded from the tool schema so LLMs cannot bypass the gate on first call
  if (params.mode === "rebuild" && !params.confirm) {
    return toolResult({
      status: "confirmation_required",
      message: "⚠️ Rebuild will delete ALL indexed data and re-index from scratch. This can take several minutes. To proceed, call index again with mode 'rebuild' and confirm set to true.",
    });
  }

  // Cancel running indexing
  if (params.mode === "cancel") {
    if (!progress.running) {
      return toolResult({ status: "ok", message: "No indexing in progress." });
    }
    cancelRequested = true;
    return toolResult({ status: "ok", message: "Cancellation requested. Indexing will stop after current session completes." });
  }

  if (progress.running) {
    return toolResult({
      status: "already_running",
      ...getIndexProgress(),
      elapsed_ms: Date.now() - progress.startedAt,
      message: `Indexing in progress: ${progress.sessionsIndexed}/${progress.sessionsTotal} sessions. Use list_sessions or search while waiting.`,
    });
  }

  const loreDir = CONFIG.loreDir;
  const projectsBaseDir = CONFIG.claudeProjectsDir;

  if (!acquireLock(loreDir)) {
    return toolResult({
      status: "locked",
      message: "Another indexing process is running. Check status with list_sessions.",
    });
  }

  // Determine which projects to index:
  // 1. scope "all" → register all projects and index them
  // 2. params.project → auto-register that project and index it
  // 3. config.indexed_projects non-empty → only registered projects
  // 4. nothing → show guidance
  const allProjects = scanProjects(projectsBaseDir);
  const userConfig = loadUserConfig();

  let projectsToIndex: typeof allProjects;

  if (params.scope === "all") {
    projectsToIndex = allProjects;
    const newlyAdded: string[] = [];
    for (const p of allProjects) {
      if (!userConfig.indexed_projects.includes(p.dirName)) {
        userConfig.indexed_projects.push(p.dirName);
        newlyAdded.push(p.dirName);
      }
    }
    if (newlyAdded.length > 0) {
      saveUserConfig(userConfig);
    }
  } else if (params.project) {
    const dirName = pathToDirName(params.project);
    const found = allProjects.find((p) => p.dirName === dirName || p.dirName === params.project);
    if (!found) {
      releaseLock(loreDir);
      return toolResult({
        status: "not_found",
        message: `Project not found: ${params.project}`,
      });
    }
    if (!userConfig.indexed_projects.includes(found.dirName)) {
      userConfig.indexed_projects.push(found.dirName);
      saveUserConfig(userConfig);
    }
    projectsToIndex = [found];
  } else if (userConfig.indexed_projects.length > 0) {
    const registered = new Set(userConfig.indexed_projects);
    projectsToIndex = allProjects.filter((p) => registered.has(p.dirName));
  } else {
    releaseLock(loreDir);
    return toolResult({
      status: "no_projects_added",
      total_projects_on_disk: allProjects.length,
      message: "No projects are added for indexing. Use manage_projects 'add' or pass scope 'all' to index everything.",
    });
  }

  // Prune config entries for projects whose directories no longer exist
  const allDirNames = new Set(allProjects.map((p) => p.dirName));
  const staleProjects = userConfig.indexed_projects.filter((d) => !allDirNames.has(d));
  if (staleProjects.length > 0) {
    for (const dirName of staleProjects) {
      const projectRow = db.prepare("SELECT id FROM projects WHERE dir_name = ?").get(dirName) as { id: number } | undefined;
      if (projectRow) {
        const sessions = db.prepare("SELECT id FROM sessions WHERE project_id = ?").all(projectRow.id) as { id: number }[];
        for (const session of sessions) {
          deleteSessionChunks(db, session.id);
        }
        db.prepare("DELETE FROM sessions WHERE project_id = ?").run(projectRow.id);
        db.prepare("DELETE FROM projects WHERE id = ?").run(projectRow.id);
      }
    }
    userConfig.indexed_projects = userConfig.indexed_projects.filter((d) => allDirNames.has(d));
    saveUserConfig(userConfig);
  }

  let totalSessions = 0;
  const projectSessions: Array<{ project: typeof allProjects[0]; sessions: ReturnType<typeof scanSessions> }> = [];
  for (const project of projectsToIndex) {
    const sessions = scanSessions(project.dirPath);
    totalSessions += sessions.length;
    projectSessions.push({ project, sessions });
  }

  // Reset progress
  progress.running = true;
  progress.sessionsScanned = 0;
  progress.sessionsIndexed = 0;
  progress.sessionsSkipped = 0;
  progress.sessionsTotal = totalSessions;
  progress.chunksCreated = 0;
  progress.currentProject = "";
  progress.startedAt = Date.now();
  progress.completedAt = null;
  progress.error = null;
  progress.skipReasons = { no_parseable_content: 0, empty_file: 0, read_error: 0, no_chunks_after_processing: 0 };

  // Return immediately, run indexing in background
  runIndexInBackground(db, params, projectSessions, loreDir).catch((err) => {
    progress.error = String(err);
    progress.running = false;
    releaseLock(loreDir);
  });

  return toolResult({
    status: "started",
    sessions_found: totalSessions,
    projects_found: projectSessions.length,
    message: `Indexing started for ${totalSessions} sessions across ${projectSessions.length} projects. Use list_sessions to check progress. You can search while indexing proceeds.`,
  });
}

// ── Background indexing ──────────────────────────────────────────────────────

async function runIndexInBackground(
  db: Database.Database,
  params: IndexParams,
  projectSessions: Array<{ project: { dirName: string; dirPath: string; name: string }; sessions: Array<{ sessionId: string; jsonlPath: string; size: number; mtime: number }> }>,
  loreDir: string,
): Promise<void> {
  const forceMode = params.mode ?? "default";

  try {
    const embedder = await getEmbedder();

    // Prune sessions whose JSONL files no longer exist on disk
    const projectInfos = projectSessions.map(({ project }) => project);
    pruneOrphanSessions(db, projectInfos);

    for (const { project, sessions } of projectSessions) {
      progress.currentProject = project.name;

      const projectId = upsertProject(db, {
        dir_name: project.dirName,
        path: project.dirPath,
        name: project.name,
      });

      if (forceMode === "rebuild") {
        // Delete all sessions and chunks for this project before re-indexing from disk
        const existingSessions = db
          .prepare("SELECT id FROM sessions WHERE project_id = ?")
          .all(projectId) as { id: number }[];
        for (const session of existingSessions) {
          deleteSessionChunks(db, session.id);
        }
        db.prepare("DELETE FROM sessions WHERE project_id = ?").run(projectId);
      }

      for (const sessionInfo of sessions) {
        // Check for cancellation between sessions
        if (cancelRequested) {
          cancelRequested = false;
          progress.error = "Cancelled by user";
          return;
        }
        progress.sessionsScanned++;

        const existingSession = db
          .prepare("SELECT * FROM sessions WHERE session_id = ?")
          .get(sessionInfo.sessionId) as SessionRow | undefined;

        const existingSize = existingSession?.jsonl_size ?? null;
        const existingMtime = existingSession?.jsonl_mtime ?? null;
        const existingOffset = existingSession?.indexed_offset ?? 0;

        let reindexStrategy = needsReindex(
          sessionInfo,
          existingSize,
          existingMtime,
          existingOffset
        );

        if (forceMode === "rebuild") {
          reindexStrategy = "rebuild";
        }

        if (reindexStrategy === "skip") {
          progress.sessionsSkipped++;
          continue;
        }

        const sessionDbId = upsertSession(db, {
          project_id: projectId,
          session_id: sessionInfo.sessionId,
          jsonl_path: sessionInfo.jsonlPath,
          jsonl_size: sessionInfo.size,
          jsonl_mtime: sessionInfo.mtime,
        });

        let readOffset = existingOffset;
        if (reindexStrategy === "rebuild") {
          deleteSessionChunks(db, sessionDbId);
          readOffset = 0;
        }

        let lines: string[];
        try {
          lines = readJsonlFromOffset(sessionInfo.jsonlPath, readOffset);
        } catch {
          progress.sessionsSkipped++;
          progress.skipReasons.read_error++;
          continue;
        }

        if (lines.length === 0) {
          progress.sessionsSkipped++;
          progress.skipReasons.empty_file++;
          continue;
        }

        const records = lines.map((line) => parseLine(line)).filter((r) => r !== null);

        if (records.length === 0) {
          progress.sessionsSkipped++;
          progress.skipReasons.no_parseable_content++;
          continue;
        }

        // Extract metadata
        let intent: string | null = null;
        let branch: string | null = null;
        let model: string | null = null;
        let startedAt: string | null = null;
        let endedAt: string | null = null;

        for (const record of records) {
          if (record.timestamp) {
            if (!startedAt) startedAt = record.timestamp;
            endedAt = record.timestamp;
          }
          if (intent === null && record.type === "user" && !record.isToolResult && record.text) {
            intent = record.text.slice(0, 200);
          }
          if (branch === null && record.gitBranch) branch = record.gitBranch;
          if (model === null && record.model) model = record.model;
        }

        const turns = groupIntoLogicalTurns(records);
        const chunks = chunkTurns(turns, CONFIG.maxChunkTokens, CONFIG.shortTurnThreshold);

        if (chunks.length === 0) {
          progress.sessionsSkipped++;
          progress.skipReasons.no_chunks_after_processing++;
          continue;
        }

        const textsToEmbed = chunks.map((chunk) => `passage: ${chunk.content}`);
        progress.currentSessionChunks = 0;
        progress.currentSessionTotal = chunks.length;
        const embeddings = await embedder.embedBatch(textsToEmbed, (done) => {
          progress.currentSessionChunks = done;
        });

        let chunkIndexOffset = 0;
        if (reindexStrategy === "append" && existingSession) {
          const maxChunkRow = db
            .prepare("SELECT MAX(chunk_index) as max_idx FROM chunks WHERE session_id = ?")
            .get(sessionDbId) as { max_idx: number | null };
          chunkIndexOffset = (maxChunkRow.max_idx ?? -1) + 1;
        }

        const insertAllChunks = db.transaction(() => {
          for (let i = 0; i < chunks.length; i++) {
            insertChunkWithVector(db, {
              session_id: sessionDbId,
              chunk_index: chunkIndexOffset + i,
              role: chunks[i].role,
              content: chunks[i].content,
              timestamp: chunks[i].timestamp || null,
              turn_start: chunks[i].turnStart,
              turn_end: chunks[i].turnEnd,
              token_count: chunks[i].tokenCount,
              embedding: embeddings[i],
            });
            progress.chunksCreated++;
          }
        });
        insertAllChunks();

        const newOffset = statSync(sessionInfo.jsonlPath).size;
        updateSessionMetadata(db, {
          session_id: sessionDbId,
          indexed_offset: newOffset,
          indexed_at: new Date().toISOString(),
          turn_count: turns.length,
          started_at: startedAt,
          ended_at: endedAt,
          branch,
          model,
          intent,
          jsonl_size: sessionInfo.size,
          jsonl_mtime: sessionInfo.mtime,
        });

        progress.sessionsIndexed++;
      }
    }
  } finally {
    progress.running = false;
    progress.completedAt = Date.now();
    releaseLock(loreDir);
  }
}
