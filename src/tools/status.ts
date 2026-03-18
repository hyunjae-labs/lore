import type Database from "better-sqlite3";
import { statSync } from "node:fs";
import { CONFIG } from "../config.js";
import { getIndexProgress } from "./index-tool.js";

export async function handleStatus(
  db: Database.Database
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const progress = getIndexProgress();

  const totalSessions = (db.prepare("SELECT COUNT(*) as c FROM sessions").get() as any).c;
  const indexedSessions = (db.prepare("SELECT COUNT(*) as c FROM sessions WHERE indexed_at IS NOT NULL").get() as any).c;
  const totalChunks = (db.prepare("SELECT COUNT(*) as c FROM chunks").get() as any).c;

  let dbSizeMb = 0;
  try {
    dbSizeMb = Math.round(statSync(CONFIG.dbPath).size / 1024 / 1024 * 10) / 10;
  } catch { /* db might not exist yet */ }

  const result: any = {
    indexing: progress.running
      ? (() => {
          const elapsed = Date.now() - progress.startedAt;
          const done = progress.sessionsIndexed + progress.sessionsSkipped;
          const rate = done > 0 ? elapsed / done : 0;
          const remaining = progress.sessionsTotal - done;
          const etaMs = rate > 0 ? Math.round(remaining * rate) : null;
          const etaStr = etaMs !== null
            ? etaMs < 60000 ? `${Math.round(etaMs / 1000)}s` : `${Math.round(etaMs / 60000)}m`
            : "calculating...";
          return {
            status: "running",
            progress: `${progress.sessionsIndexed}/${progress.sessionsTotal} sessions`,
            current_project: progress.currentProject,
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

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}
