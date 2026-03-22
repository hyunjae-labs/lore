import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v3";
import { getDb } from "./db/index.js";
import { CONFIG } from "./config.js";
import { handleSearch } from "./tools/search.js";
import { handleGetContext } from "./tools/get-context.js";
import { handleIndex } from "./tools/index-tool.js";
import { handleListSessions } from "./tools/list-sessions.js";
import { handleStatus } from "./tools/status.js";
import { handleManageProjects } from "./tools/manage-projects.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolResult = any;

export async function startServer(): Promise<void> {
  const db = getDb(CONFIG.dbPath);

  const server = new McpServer({
    name: "lore",
    version: "0.1.0",
  });

  // search tool
  server.tool(
    "search",
    "Search through past Claude Code conversations across all projects. Use when the user asks about previous discussions, past decisions, or anything from a prior conversation.",
    {
      query: z.string(),
      project: z.string().optional(),
      session: z.string().optional().describe("Filter by session ID (UUID). Use list_sessions to find session IDs."),
      branch: z.string().optional(),
      after: z.string().optional(),
      before: z.string().optional(),
      limit: z.number().optional(),
    },
    async (args): Promise<ToolResult> => {
      return handleSearch(db, {
        query: args.query,
        project: args.project,
        session: args.session,
        branch: args.branch,
        after: args.after,
        before: args.before,
        limit: args.limit,
      });
    }
  );

  // get_context tool
  server.tool(
    "get_context",
    "Retrieve more conversation context around a specific search result. Use ONLY after calling search, when you need to see what was discussed before or after a result.",
    {
      chunk_id: z.number(),
      direction: z.enum(["before", "after", "both"]).optional(),
      count: z.number().optional(),
    },
    async (args): Promise<ToolResult> => {
      return handleGetContext(db, {
        chunk_id: args.chunk_id,
        direction: args.direction,
        count: args.count,
      });
    }
  );

  server.tool(
    "index",
    "Index Claude Code sessions for search. No params = update added projects. Pass 'project' with a path to auto-add and index a specific project. Pass scope 'all' to add and index all projects.",
    {
      mode: z.enum(["rebuild", "cancel"]).optional(),
      project: z.string().optional().describe("Project path (e.g., '/Users/me/my-app') or dir_name to auto-add and index."),
      scope: z.enum(["all"]).optional().describe("Set to 'all' to register and index all projects."),
      confirm: z.boolean().optional().describe("Confirmation flag for rebuild. Only set true when instructed by a previous response."),
    },
    async (args): Promise<ToolResult> => {
      return handleIndex(db, {
        mode: args.mode,
        project: args.project,
        scope: args.scope,
        confirm: args.confirm,
      });
    }
  );

  // list_sessions tool
  server.tool(
    "list_sessions",
    "List all indexed Claude Code sessions. Use when the user wants to browse conversation history or find sessions by project/date.",
    {
      project: z.string().optional(),
      limit: z.number().optional(),
      sort: z.enum(["recent", "oldest"]).optional(),
    },
    async (args): Promise<ToolResult> => {
      return handleListSessions(db, {
        project: args.project,
        limit: args.limit,
        sort: args.sort,
      });
    }
  );

  // manage_projects tool
  server.tool(
    "manage_projects",
    "Manage which projects are registered for indexing. Use 'list' to see all projects and their added status. Use 'add' with project paths to register. Use 'remove' to unregister and clean up indexed data.",
    {
      action: z.enum(["add", "remove", "list"]),
      projects: z.array(z.string()).optional().describe("Project paths (e.g., '/Users/me/my-app') or dir_names. Supports batch."),
    },
    async (args): Promise<ToolResult> => {
      return handleManageProjects(db, {
        action: args.action,
        projects: args.projects,
      });
    }
  );

  // status tool
  server.tool(
    "status",
    "Check the health and progress of lore indexing. Shows indexing status, session counts, DB size. Use this to monitor indexing progress after calling index.",
    {},
    async (): Promise<ToolResult> => {
      return handleStatus(db);
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
