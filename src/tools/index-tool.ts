import { openSync, closeSync, unlinkSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
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
import { loadUserConfig } from "../config.js";

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
process.on("exit", () => releaseLock(process.env.LORE_DIR ?? CONFIG.loreDir));
process.on("SIGINT", () => { releaseLock(process.env.LORE_DIR ?? CONFIG.loreDir); process.exit(130); });
process.on("SIGTERM", () => { releaseLock(process.env.LORE_DIR ?? CONFIG.loreDir); process.exit(143); });

// ── JSONL reading ────────────────────────────────────────────────────────────

function readJsonlFromOffset(filePath: string, offset: number): string[] {
  const buffer = readFileSync(filePath);
  const content = buffer.subarray(offset).toString("utf-8");
  return content.split("\n").filter((line) => line.trim().length > 0);
}

// ── Public API ───────────────────────────────────────────────────────────────

let cancelRequested = false;

export function cancelIndex(): boolean {
  if (!progress.running) return false;
  cancelRequested = true;
  return true;
}

export interface IndexParams {
  mode?: "incremental" | "full" | "cancel";
  project?: string;
}

export async function handleIndex(
  db: Database.Database,
  params: IndexParams
): Promise<{ content: Array<{ type: string; text: string }> }> {

  // Cancel running indexing
  if (params.mode === "cancel") {
    if (!progress.running) {
      return { content: [{ type: "text", text: JSON.stringify({ status: "ok", message: "No indexing in progress." }) }] };
    }
    cancelRequested = true;
    return { content: [{ type: "text", text: JSON.stringify({ status: "ok", message: "Cancellation requested. Indexing will stop after current session completes." }) }] };
  }

  if (progress.running) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          status: "already_running",
          ...getIndexProgress(),
          elapsed_ms: Date.now() - progress.startedAt,
          message: `Indexing in progress: ${progress.sessionsIndexed}/${progress.sessionsTotal} sessions. Use list_sessions or search while waiting.`,
        }),
      }],
    };
  }

  const loreDir = process.env.LORE_DIR ?? CONFIG.loreDir;
  const projectsBaseDir = process.env.CLAUDE_PROJECTS_DIR ?? CONFIG.claudeProjectsDir;

  if (!acquireLock(loreDir)) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          status: "locked",
          message: "Another indexing process is running. Check status with list_sessions.",
        }),
      }],
    };
  }

  // Determine which projects to index:
  // 1. If params.project specified → only that project (overrides config)
  // 2. Else if config.indexed_projects is non-empty → only registered projects
  // 3. Else → nothing (user must register projects first)
  const allProjects = scanProjects(projectsBaseDir);
  const userConfig = loadUserConfig();

  let projectsToIndex = allProjects;

  if (params.project) {
    // Explicit project filter — overrides config
    projectsToIndex = allProjects.filter(
      (p) =>
        p.name.toLowerCase().includes(params.project!.toLowerCase()) ||
        p.dirName.toLowerCase().includes(params.project!.toLowerCase())
    );
  } else if (userConfig.indexed_projects.length > 0) {
    // Config-based filter
    const registered = new Set(userConfig.indexed_projects);
    projectsToIndex = allProjects.filter((p) => registered.has(p.dirName));
  } else {
    // No config, no param — show guidance
    releaseLock(loreDir);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          status: "no_projects_registered",
          total_projects_on_disk: allProjects.length,
          message: "No projects are registered for indexing. Use manage_projects with action 'list' to see available projects, then 'add' to register the ones you want to index.",
        }),
      }],
    };
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

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        status: "started",
        sessions_found: totalSessions,
        projects_found: projectSessions.length,
        message: `Indexing started for ${totalSessions} sessions across ${projectSessions.length} projects. Use list_sessions to check progress. You can search while indexing proceeds.`,
      }),
    }],
  };
}

// ── Background indexing ──────────────────────────────────────────────────────

async function runIndexInBackground(
  db: Database.Database,
  params: IndexParams,
  projectSessions: Array<{ project: { dirName: string; dirPath: string; name: string }; sessions: Array<{ sessionId: string; jsonlPath: string; size: number; mtime: number }> }>,
  loreDir: string,
): Promise<void> {
  const forceMode = params.mode ?? "incremental";

  try {
    const embedder = await getEmbedder();

    for (const { project, sessions } of projectSessions) {
      progress.currentProject = project.name;

      const projectId = upsertProject(db, {
        dir_name: project.dirName,
        path: project.dirPath,
        name: project.name,
      });

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

        if (forceMode === "full") {
          reindexStrategy = "full";
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
        if (reindexStrategy === "full") {
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
