import type Database from "better-sqlite3";
import { toolResult } from "./helpers.js";

export interface ListSessionsParams {
  project?: string;
  limit?: number;
  sort?: "recent" | "oldest";
}

export async function handleListSessions(
  db: Database.Database,
  params: ListSessionsParams
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const limit = Math.min(params.limit || 20, 100);
  const sortDir = params.sort === "oldest" ? "ASC" : "DESC";

  const filterConditions: string[] = [
    "sc.chunk_count > 0",
  ];
  const queryParams: unknown[] = [];

  if (params.project) {
    filterConditions.push("p.name LIKE ?");
    queryParams.push(`%${params.project}%`);
  }

  const filterClause = "WHERE " + filterConditions.join(" AND ");

  const sessions = db
    .prepare(
      `WITH sc AS (
         SELECT session_id, COUNT(*) as chunk_count
         FROM chunks GROUP BY session_id
       )
       SELECT s.session_id, p.path as project, p.name as project_name,
              s.branch, s.started_at, s.model, s.intent, s.turn_count,
              s.indexed_at IS NOT NULL as indexed,
              sc.chunk_count
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
       JOIN sc ON sc.session_id = s.id
       ${filterClause}
       ORDER BY s.started_at ${sortDir}
       LIMIT ?`
    )
    .all(...queryParams, limit) as any[];

  const totalSessions = (
    db.prepare("SELECT COUNT(*) as count FROM sessions s WHERE EXISTS (SELECT 1 FROM chunks c WHERE c.session_id = s.id)").get() as any
  ).count;

  const totalIndexed = (
    db
      .prepare(
        "SELECT COUNT(*) as count FROM sessions s WHERE s.indexed_at IS NOT NULL AND EXISTS (SELECT 1 FROM chunks c WHERE c.session_id = s.id)"
      )
      .get() as any
  ).count;

  // Project summary
  const projects = db
    .prepare(
      `SELECT p.name, p.path, COUNT(s.id) as session_count
       FROM projects p
       LEFT JOIN sessions s ON s.project_id = p.id
       GROUP BY p.id
       ORDER BY session_count DESC`
    )
    .all() as any[];

  const result = {
    sessions: sessions.map((s: any) => ({
      ...s,
      indexed: Boolean(s.indexed),
    })),
    total_sessions: totalSessions,
    total_indexed: totalIndexed,
    projects: projects.map((p: any) => ({
      name: p.name,
      path: p.path,
      session_count: p.session_count,
    })),
  };

  return toolResult(result);
}
