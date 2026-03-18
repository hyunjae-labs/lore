import type Database from "better-sqlite3";
import { loadUserConfig } from "../config.js";

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

  let filterClause = "";
  const queryParams: unknown[] = [];

  if (params.project) {
    filterClause = "WHERE p.name LIKE ?";
    queryParams.push(`%${params.project}%`);
  }

  const sessions = db
    .prepare(
      `SELECT s.session_id, p.path as project, p.name as project_name,
              s.branch, s.started_at, s.model, s.intent, s.turn_count,
              s.indexed_at IS NOT NULL as indexed,
              (SELECT COUNT(*) FROM chunks c WHERE c.session_id = s.id) as chunk_count
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
       ${filterClause}
       ORDER BY s.started_at ${sortDir}
       LIMIT ?`
    )
    .all(...queryParams, limit) as any[];

  const totalSessions = (
    db.prepare("SELECT COUNT(*) as count FROM sessions").get() as any
  ).count;

  const totalIndexed = (
    db
      .prepare(
        "SELECT COUNT(*) as count FROM sessions WHERE indexed_at IS NOT NULL"
      )
      .get() as any
  ).count;

  // Project summary with registered status
  const userConfig = loadUserConfig();
  const registeredSet = new Set(userConfig.indexed_projects);

  const projects = db
    .prepare(
      `SELECT p.dir_name, p.name, p.path, COUNT(s.id) as session_count
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
      registered: registeredSet.has(p.dir_name),
    })),
  };

  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}
