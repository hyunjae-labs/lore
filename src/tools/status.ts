import type Database from "better-sqlite3";
import { statSync } from "node:fs";
import { CONFIG } from "../config.js";
import { getIndexProgress } from "./index-tool.js";
import { getSessionCount, getIndexedSessionCount } from "../db/queries.js";
import { toolResult } from "./helpers.js";

export async function handleStatus(
  db: Database.Database
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const progress = getIndexProgress();

  const totalSessions = getSessionCount(db);
  const indexedSessions = getIndexedSessionCount(db);
  const totalChunks = (db.prepare("SELECT COUNT(*) as c FROM chunks").get() as any).c;

  let dbSizeMb = 0;
  try {
    dbSizeMb = Math.round(statSync(CONFIG.dbPath).size / 1024 / 1024 * 10) / 10;
  } catch { /* db might not exist yet */ }

  const result: any = {
    indexing: progress.running
      ? (() => {
          const elapsed = Date.now() - progress.startedAt;
          // ETA based on chunks processed (more accurate than session count)
          const totalChunksProcessed = progress.chunksCreated + progress.currentSessionChunks;
          const chunksPerMs = totalChunksProcessed > 0 ? totalChunksProcessed / elapsed : 0;
          // Estimate remaining: current session remaining + unprocessed sessions (estimate avg chunks/session)
          const currentRemaining = progress.currentSessionTotal - progress.currentSessionChunks;
          const processedSessions = progress.sessionsIndexed + progress.sessionsSkipped;
          const remainingSessions = progress.sessionsTotal - processedSessions - 1; // -1 for current
          const avgChunksPerSession = processedSessions > 0 ? progress.chunksCreated / Math.max(progress.sessionsIndexed, 1) : 0;
          const estimatedRemainingChunks = currentRemaining + (remainingSessions * avgChunksPerSession);
          const etaMs = chunksPerMs > 0 ? Math.round(estimatedRemainingChunks / chunksPerMs) : null;
          const etaStr = etaMs !== null
            ? etaMs < 60000 ? `${Math.round(etaMs / 1000)}s` : `${Math.round(etaMs / 60000)}m`
            : "calculating...";
          return {
            status: "running",
            progress: `${progress.sessionsIndexed}/${progress.sessionsTotal} sessions`,
            current_project: progress.currentProject,
            current_session: progress.currentSessionTotal > 0
              ? `embedding ${progress.currentSessionChunks}/${progress.currentSessionTotal} chunks`
              : undefined,
            chunks_created: progress.chunksCreated,
            elapsed_ms: elapsed,
            eta: etaStr,
          };
        })()
      : progress.completedAt
        ? {
            status: "idle",
            last_run: `${progress.sessionsIndexed} sessions indexed, ${progress.sessionsSkipped} skipped, ${progress.chunksCreated} chunks in ${progress.completedAt - progress.startedAt}ms`,
            error: progress.error,
            ...(progress.sessionsSkipped > 0 ? { skip_reasons: progress.skipReasons } : {}),
          }
        : { status: "never_run" },
    db: {
      total_sessions: totalSessions,
      indexed_sessions: indexedSessions,
      empty_sessions: (db.prepare("SELECT COUNT(*) as c FROM sessions s WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.session_id = s.id)").get() as any).c,
      total_chunks: totalChunks,
      size_mb: dbSizeMb,
    },
  };

  return toolResult(result);
}
