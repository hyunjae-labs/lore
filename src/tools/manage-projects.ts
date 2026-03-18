import type Database from "better-sqlite3";
import { loadUserConfig, saveUserConfig, CONFIG } from "../config.js";
import { scanProjects, scanSessions } from "../indexer/scanner.js";
import { deleteSessionChunks } from "../db/queries.js";
import { getIndexProgress } from "./index-tool.js";

export interface ManageProjectsParams {
  action: "add" | "remove" | "list";
  project?: string;
}

export async function handleManageProjects(
  db: Database.Database,
  params: ManageProjectsParams
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const config = loadUserConfig();
  const projectsBaseDir = process.env.CLAUDE_PROJECTS_DIR ?? CONFIG.claudeProjectsDir;
  const allProjects = scanProjects(projectsBaseDir);

  if (params.action === "list") {
    const projectList = allProjects.map((p) => {
      const sessions = scanSessions(p.dirPath);
      const isRegistered = config.indexed_projects.includes(p.dirName);
      return {
        dir_name: p.dirName,
        name: p.name,
        session_count: sessions.length,
        registered: isRegistered,
      };
    });

    // Sort: registered first, then by session count
    projectList.sort((a, b) => {
      if (a.registered !== b.registered) return a.registered ? -1 : 1;
      return b.session_count - a.session_count;
    });

    // Hide projects with 0 sessions (unless registered)
    const visible = projectList.filter((p) => p.session_count > 0 || p.registered);
    const hidden = projectList.length - visible.length;

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          total_projects: visible.length,
          registered_count: visible.filter((p) => p.registered).length,
          hidden_empty: hidden > 0 ? `${hidden} projects with 0 sessions hidden` : undefined,
          projects: visible,
          hint: "Use action 'add' with a project name to register for indexing. Use 'remove' to unregister.",
        }, null, 2),
      }],
    };
  }

  if (params.action === "add") {
    if (!params.project) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "project parameter is required for 'add' action" }) }],
      };
    }

    // Exact match first (by dir_name or name)
    const exact = allProjects.filter(
      (p) =>
        p.dirName === params.project! ||
        p.name.toLowerCase() === params.project!.toLowerCase()
    );
    const matches = exact.length > 0 ? exact : allProjects.filter(
      (p) =>
        p.name.toLowerCase().includes(params.project!.toLowerCase()) ||
        p.dirName.toLowerCase().includes(params.project!.toLowerCase())
    );

    if (matches.length === 0) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: `No project matching "${params.project}" found.`,
            available: allProjects.filter((p) => scanSessions(p.dirPath).length > 0).map((p) => p.name),
          }),
        }],
      };
    }

    // If multiple matches, don't auto-add — return candidates for user to pick
    if (matches.length > 1) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "multiple_matches",
            message: `"${params.project}" matched ${matches.length} projects. Please be more specific or use the exact dir_name.`,
            matches: matches.map((m) => ({
              dir_name: m.dirName,
              name: m.name,
              session_count: scanSessions(m.dirPath).length,
            })),
          }),
        }],
      };
    }

    // Exactly 1 match — add it
    const match = matches[0];
    if (config.indexed_projects.includes(match.dirName)) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ status: "ok", message: `${match.name} is already registered.`, total_registered: config.indexed_projects.length }),
        }],
      };
    }

    config.indexed_projects.push(match.dirName);
    saveUserConfig(config);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          status: "ok",
          added: [match.name],
          total_registered: config.indexed_projects.length,
          message: `Added ${match.name} to indexing list. Run 'index' to start indexing.`,
        }),
      }],
    };
  }

  if (params.action === "remove") {
    if (!params.project) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "project parameter is required for 'remove' action" }) }],
      };
    }

    // Block remove during active indexing to prevent DB conflicts
    if (getIndexProgress().running) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: "Cannot remove projects while indexing is in progress. Wait for indexing to complete or check status.",
          }),
        }],
      };
    }

    // Find which dir_names will be removed
    const removedDirNames: string[] = [];
    config.indexed_projects = config.indexed_projects.filter(
      (dirName) => {
        const proj = allProjects.find((p) => p.dirName === dirName);
        const name = proj?.name || dirName;
        const shouldRemove =
          name.toLowerCase().includes(params.project!.toLowerCase()) ||
          dirName.toLowerCase().includes(params.project!.toLowerCase());
        if (shouldRemove) removedDirNames.push(dirName);
        return !shouldRemove;
      }
    );

    saveUserConfig(config);

    // Delete indexed data from DB for removed projects
    let chunksDeleted = 0;
    let sessionsDeleted = 0;
    for (const dirName of removedDirNames) {
      const project = db.prepare("SELECT id FROM projects WHERE dir_name = ?").get(dirName) as { id: number } | undefined;
      if (project) {
        const sessions = db.prepare("SELECT id FROM sessions WHERE project_id = ?").all(project.id) as { id: number }[];
        for (const session of sessions) {
          deleteSessionChunks(db, session.id);
          chunksDeleted++;
        }
        sessionsDeleted += sessions.length;
        db.prepare("DELETE FROM sessions WHERE project_id = ?").run(project.id);
        db.prepare("DELETE FROM projects WHERE id = ?").run(project.id);
      }
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          status: "ok",
          removed_count: removedDirNames.length,
          sessions_deleted: sessionsDeleted,
          total_registered: config.indexed_projects.length,
          message: removedDirNames.length > 0
            ? `Removed ${removedDirNames.length} project(s) and deleted ${sessionsDeleted} session(s) from index.`
            : "No matching projects found in the registered list.",
        }),
      }],
    };
  }

  return {
    content: [{ type: "text", text: JSON.stringify({ error: "Invalid action. Use 'add', 'remove', or 'list'." }) }],
  };
}
