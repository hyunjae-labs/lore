import type Database from "better-sqlite3";
import { CONFIG } from "../config.js";
import { getEmbedder } from "../embedder/index.js";
import { getIndexedSessionCount } from "../db/queries.js";
import { vectorSearch } from "../db/queries.js";
import type { SearchResult } from "../db/queries.js";
import { scanProjects, scanSessions } from "../indexer/scanner.js";
import { handleIndex, waitForIndexComplete, indexStaleSessions } from "./index-tool.js";
import { toolResult, toolError } from "./helpers.js";

export interface SearchParams {
  query: string;
  project?: string;
  session?: string;
  branch?: string;
  after?: string;
  before?: string;
  limit?: number;
}

interface SearchResponse {
  status: "ok" | "index_required";
  message?: string;
  sessions_found?: number;
  query?: string;
  query_time_ms?: number;
  total_indexed_sessions?: number;
  result_count?: number;
  results?: FormattedResult[];
  note?: string;
}

interface FormattedResult {
  chunk_id: number;
  score: number;
  content: string;
  role: string;
  session_id: string;
  project: string;
  project_name: string;
  branch: string | null;
  timestamp: string | null;
  model: string | null;
  intent: string | null;
  turn_range: string;
  has_more_before: boolean;
  has_more_after: boolean;
}

function formatResult(r: SearchResult): FormattedResult {
  return {
    chunk_id: r.id,
    score: r.score,
    content: r.content,
    role: r.role,
    session_id: r.session_uuid,
    project: r.project_path,
    project_name: r.project_name,
    branch: r.branch,
    timestamp: r.timestamp,
    model: r.model,
    intent: r.intent,
    turn_range: r.turn_range,
    has_more_before: r.has_more_before,
    has_more_after: r.has_more_after,
  };
}

function countSessionsOnDisk(): number {
  const projectsBaseDir =
    process.env.CLAUDE_PROJECTS_DIR ?? CONFIG.claudeProjectsDir;
  const projects = scanProjects(projectsBaseDir);
  let total = 0;
  for (const project of projects) {
    total += scanSessions(project.dirPath).length;
  }
  return total;
}

export async function handleSearch(
  db: Database.Database,
  params: SearchParams
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const startTime = Date.now();

  // 1. Validate query
  if (!params.query || params.query.trim().length === 0) {
    return toolError("query parameter is required and must be non-empty");
  }

  // 2. Clamp limit
  const limit = Math.min(
    params.limit ?? CONFIG.searchDefaultLimit,
    CONFIG.searchMaxLimit
  );

  // 3. Check if we have any indexed data
  let indexedCount = getIndexedSessionCount(db);

  if (indexedCount === 0) {
    // First time: must index before searching (no existing data to search)
    const sessionsOnDisk = countSessionsOnDisk();
    if (sessionsOnDisk <= CONFIG.autoIndexThreshold) {
      await handleIndex(db, {});
      await waitForIndexComplete(30000);
      indexedCount = getIndexedSessionCount(db);
    } else {
      const response: SearchResponse = {
        status: "index_required",
        message: `No sessions have been indexed yet. Found ${sessionsOnDisk} sessions on disk. Run the index tool first.`,
        sessions_found: sessionsOnDisk,
      };
      return toolResult(response);
    }
  }

  // 4. Embed the query with the required prefix
  const embedder = await getEmbedder();
  const embedding = await embedder.embed("query: " + params.query);

  // 5. Hybrid search (vector + FTS5/BM25 with RRF)
  const results = vectorSearch(db, {
    embedding,
    query: params.query,
    limit,
    projectName: params.project,
    sessionId: params.session,
    branch: params.branch,
    after: params.after,
    before: params.before,
  });

  // 6. Format results
  const formatted = results.map(formatResult);

  // 7. Check for stale sessions
  const sessionsOnDiskNow = countSessionsOnDisk();
  const unindexedCount = sessionsOnDiskNow - indexedCount;

  let note: string | undefined;
  if (unindexedCount > 0) {
    note = `${unindexedCount} session(s) on disk are not yet indexed. Run the index tool to include them in searches.`;
  }

  const queryTimeMs = Date.now() - startTime;

  const response: SearchResponse = {
    status: "ok",
    query: params.query,
    query_time_ms: queryTimeMs,
    total_indexed_sessions: indexedCount,
    result_count: formatted.length,
    results: formatted,
    ...(note ? { note } : {}),
  };

  // 8. Fire-and-forget: index current session in background for next search
  indexStaleSessions(db).catch(() => {});

  return toolResult(response);
}
