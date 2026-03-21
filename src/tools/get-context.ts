import type Database from "better-sqlite3";
import { getAdjacentChunks } from "../db/queries.js";
import type { ChunkRow } from "../db/queries.js";
import { toolResult, toolError } from "./helpers.js";

export interface GetContextParams {
  chunk_id: number;
  direction?: "before" | "after" | "both";
  count?: number;
}

export async function handleGetContext(
  db: Database.Database,
  params: GetContextParams
): Promise<{ content: Array<{ type: string; text: string }> }> {
  if (!params.chunk_id) {
    return toolError("chunk_id is required");
  }

  const direction = params.direction || "both";
  const count = Math.min(params.count || 3, 10);

  // Look up the anchor chunk
  const anchor = db
    .prepare(
      "SELECT id, session_id, chunk_index, role, content, timestamp, turn_start, turn_end, token_count FROM chunks WHERE id = ?"
    )
    .get(params.chunk_id) as ChunkRow | undefined;

  if (!anchor) {
    return toolError("Chunk not found");
  }

  // Fetch adjacent chunks according to direction
  const beforeCount = direction === "after" ? 0 : count;
  const afterCount = direction === "before" ? 0 : count;

  const { before, after } = getAdjacentChunks(db, {
    session_id: anchor.session_id,
    chunk_index: anchor.chunk_index,
    before: beforeCount,
    after: afterCount,
  });

  // Get session info for the anchor chunk
  const session = db
    .prepare(
      `SELECT s.session_id, p.path as project
       FROM sessions s JOIN projects p ON p.id = s.project_id
       WHERE s.id = ?`
    )
    .get(anchor.session_id) as { session_id: string; project: string } | undefined;

  const result = {
    anchor: {
      chunk_id: anchor.id,
      content: anchor.content,
      timestamp: anchor.timestamp,
      role: anchor.role,
    },
    before: before.map((c) => ({
      chunk_id: c.id,
      content: c.content,
      timestamp: c.timestamp,
      role: c.role,
    })),
    after: after.map((c) => ({
      chunk_id: c.id,
      content: c.content,
      timestamp: c.timestamp,
      role: c.role,
    })),
    session_id: session?.session_id || "",
    project: session?.project || "",
  };

  return toolResult(result);
}
