import type Database from "better-sqlite3";
import { loadUserConfig, saveUserConfig, CONFIG } from "../config.js";
import { scanProjects, scanSessions } from "../indexer/scanner.js";
import { deleteSessionChunks } from "../db/queries.js";
import { getIndexProgress } from "./index-tool.js";

export interface ManageProjectsParams {
  action: "add" | "remove" | "list" | "exclude" | "include";
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
      const isExcluded = config.excluded_projects.includes(p.dirName);
      return {
        dir_name: p.dirName,
        name: p.name,
        session_count: sessions.length,
        registered: isRegistered,
        excluded: isExcluded,
      };
    });

    // Sort: registered first, then excluded, then by session count
    projectList.sort((a, b) => {
      if (a.registered !== b.registered) return a.registered ? -1 : 1;
      if (a.excluded !== b.excluded) return a.excluded ? -1 : 1;
      return b.session_count - a.session_count;
    });

    // Hide projects with 0 sessions (unless registered or excluded)
    const visible = projectList.filter((p) => p.session_count > 0 || p.registered || p.excluded);
    const hidden = projectList.length - visible.length;

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          total_projects: visible.length,
          registered_count: visible.filter((p) => p.registered).length,
          excluded_count: visible.filter((p) => p.excluded).length,
          hidden_empty: hidden > 0 ? `${hidden} projects with 0 sessions hidden` : undefined,
          projects: visible,
          hint: "Use action 'add' to register for indexing, 'remove' to unregister, 'exclude' to intentionally exclude, 'include' to restore an excluded project.",
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

    // Remove from excluded if present
    config.excluded_projects = config.excluded_projects.filter((d) => d !== match.dirName);
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

    // Find candidates: exact match first, then fuzzy
    const registeredProjects = config.indexed_projects
      .map((dirName) => ({ dirName, proj: allProjects.find((p) => p.dirName === dirName) }))
      .map(({ dirName, proj }) => ({ dirName, name: proj?.name || dirName }));

    const exactMatches = registeredProjects.filter(
      ({ dirName, name }) =>
        dirName === params.project! ||
        name.toLowerCase() === params.project!.toLowerCase()
    );
    const candidates = exactMatches.length > 0
      ? exactMatches
      : registeredProjects.filter(
          ({ dirName, name }) =>
            name.toLowerCase().includes(params.project!.toLowerCase()) ||
            dirName.toLowerCase().includes(params.project!.toLowerCase())
        );

    if (candidates.length === 0) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "ok",
            removed_count: 0,
            message: "No matching projects found in the registered list.",
          }),
        }],
      };
    }

    // Multiple fuzzy matches — require user to be more specific
    if (exactMatches.length === 0 && candidates.length > 1) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "multiple_matches",
            message: `"${params.project}" matched ${candidates.length} registered projects. Please be more specific or use the exact dir_name.`,
            matches: candidates.map(({ dirName, name }) => ({ dir_name: dirName, name })),
          }),
        }],
      };
    }

    // Remove the matched projects
    const removedDirNames = candidates.map(({ dirName }) => dirName);
    config.indexed_projects = config.indexed_projects.filter(
      (dirName) => !removedDirNames.includes(dirName)
    );
    saveUserConfig(config);

    // Delete indexed data from DB for removed projects
    let sessionsDeleted = 0;
    for (const dirName of removedDirNames) {
      const project = db.prepare("SELECT id FROM projects WHERE dir_name = ?").get(dirName) as { id: number } | undefined;
      if (project) {
        const sessions = db.prepare("SELECT id FROM sessions WHERE project_id = ?").all(project.id) as { id: number }[];
        for (const session of sessions) {
          deleteSessionChunks(db, session.id);
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
          message: `Removed ${removedDirNames.length} project(s) and deleted ${sessionsDeleted} session(s) from index.`,
        }),
      }],
    };
  }

  if (params.action === "exclude") {
    if (!params.project) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "project parameter is required for 'exclude' action" }) }],
      };
    }

    // Exact match first, then fuzzy
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
          text: JSON.stringify({ error: `No project matching "${params.project}" found.` }),
        }],
      };
    }

    if (exact.length === 0 && matches.length > 1) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "multiple_matches",
            message: `"${params.project}" matched ${matches.length} projects. Please be more specific or use the exact dir_name.`,
            matches: matches.map((m) => ({ dir_name: m.dirName, name: m.name })),
          }),
        }],
      };
    }

    const match = matches[0];

    if (config.excluded_projects.includes(match.dirName)) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ status: "ok", message: `${match.name} is already excluded.` }),
        }],
      };
    }

    // Remove from indexed if registered
    config.indexed_projects = config.indexed_projects.filter((d) => d !== match.dirName);
    config.excluded_projects.push(match.dirName);
    saveUserConfig(config);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          status: "ok",
          excluded: match.dirName,
          message: `${match.name} is now excluded from indexing. Use 'include' to restore it.`,
        }),
      }],
    };
  }

  if (params.action === "include") {
    if (!params.project) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "project parameter is required for 'include' action" }) }],
      };
    }

    const excludedProjects = config.excluded_projects
      .map((dirName) => ({ dirName, proj: allProjects.find((p) => p.dirName === dirName) }))
      .map(({ dirName, proj }) => ({ dirName, name: proj?.name || dirName }));

    const exactMatches = excludedProjects.filter(
      ({ dirName, name }) =>
        dirName === params.project! ||
        name.toLowerCase() === params.project!.toLowerCase()
    );
    const candidates = exactMatches.length > 0
      ? exactMatches
      : excludedProjects.filter(
          ({ dirName, name }) =>
            name.toLowerCase().includes(params.project!.toLowerCase()) ||
            dirName.toLowerCase().includes(params.project!.toLowerCase())
        );

    if (candidates.length === 0) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ error: `No excluded project matching "${params.project}" found.` }),
        }],
      };
    }

    if (exactMatches.length === 0 && candidates.length > 1) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "multiple_matches",
            message: `"${params.project}" matched ${candidates.length} excluded projects. Please be more specific.`,
            matches: candidates.map(({ dirName, name }) => ({ dir_name: dirName, name })),
          }),
        }],
      };
    }

    const match = candidates[0];
    config.excluded_projects = config.excluded_projects.filter((d) => d !== match.dirName);
    saveUserConfig(config);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          status: "ok",
          included: match.dirName,
          message: `${match.name} is no longer excluded. Use 'add' to register it for indexing.`,
        }),
      }],
    };
  }

  return {
    content: [{ type: "text", text: JSON.stringify({ error: "Invalid action. Use 'add', 'remove', 'list', 'exclude', or 'include'." }) }],
  };
}
