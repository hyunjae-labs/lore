import type Database from "better-sqlite3";
import { loadUserConfig, saveUserConfig, CONFIG } from "../config.js";
import { scanProjects, scanSessions } from "../indexer/scanner.js";
import { deleteSessionChunks } from "../db/queries.js";
import { getIndexProgress } from "./index-tool.js";

export interface ManageProjectsParams {
  action: "add" | "remove" | "list" | "exclude" | "include";
  projects?: string[];
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
    const inputs = params.projects;
    if (!inputs || inputs.length === 0) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "projects parameter is required for 'add' action" }) }],
      };
    }

    const added: string[] = [];
    const skipped: string[] = [];
    const not_found: string[] = [];
    const ambiguous: Array<{ query: string; matches: Array<{ dir_name: string; name: string }> }> = [];

    for (const query of inputs) {
      // Exact match first (by dir_name or name)
      const exact = allProjects.filter(
        (p) =>
          p.dirName === query ||
          p.name.toLowerCase() === query.toLowerCase()
      );
      const matches = exact.length > 0 ? exact : allProjects.filter(
        (p) =>
          p.name.toLowerCase().includes(query.toLowerCase()) ||
          p.dirName.toLowerCase().includes(query.toLowerCase())
      );

      if (matches.length === 0) {
        not_found.push(query);
        continue;
      }

      if (matches.length > 1) {
        ambiguous.push({
          query,
          matches: matches.map((m) => ({ dir_name: m.dirName, name: m.name })),
        });
        continue;
      }

      const match = matches[0];
      if (config.indexed_projects.includes(match.dirName)) {
        skipped.push(match.name);
        continue;
      }

      config.excluded_projects = config.excluded_projects.filter((d) => d !== match.dirName);
      config.indexed_projects.push(match.dirName);
      added.push(match.name);
    }

    if (added.length > 0) {
      saveUserConfig(config);
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          status: "ok",
          added,
          skipped,
          not_found,
          ambiguous: ambiguous.length > 0 ? ambiguous : undefined,
          total_registered: config.indexed_projects.length,
          message: `Added ${added.length} project(s). Run 'index' to start indexing.`,
        }),
      }],
    };
  }

  if (params.action === "remove") {
    const inputs = params.projects;
    if (!inputs || inputs.length === 0) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "projects parameter is required for 'remove' action" }) }],
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

    const registeredProjects = config.indexed_projects
      .map((dirName) => ({ dirName, proj: allProjects.find((p) => p.dirName === dirName) }))
      .map(({ dirName, proj }) => ({ dirName, name: proj?.name || dirName }));

    const removed: string[] = [];
    const not_found: string[] = [];
    const ambiguous: Array<{ query: string; matches: Array<{ dir_name: string; name: string }> }> = [];
    let sessionsDeleted = 0;

    for (const query of inputs) {
      const exactMatches = registeredProjects.filter(
        ({ dirName, name }) =>
          dirName === query ||
          name.toLowerCase() === query.toLowerCase()
      );
      const candidates = exactMatches.length > 0
        ? exactMatches
        : registeredProjects.filter(
            ({ dirName, name }) =>
              name.toLowerCase().includes(query.toLowerCase()) ||
              dirName.toLowerCase().includes(query.toLowerCase())
          );

      if (candidates.length === 0) {
        not_found.push(query);
        continue;
      }

      if (exactMatches.length === 0 && candidates.length > 1) {
        ambiguous.push({
          query,
          matches: candidates.map(({ dirName, name }) => ({ dir_name: dirName, name })),
        });
        continue;
      }

      for (const { dirName } of candidates) {
        config.indexed_projects = config.indexed_projects.filter((d) => d !== dirName);
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
        removed.push(dirName);
      }
    }

    if (removed.length > 0) {
      saveUserConfig(config);
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          status: "ok",
          removed,
          not_found,
          ambiguous: ambiguous.length > 0 ? ambiguous : undefined,
          sessions_deleted: sessionsDeleted,
          total_registered: config.indexed_projects.length,
          message: `Removed ${removed.length} project(s) and deleted ${sessionsDeleted} session(s) from index.`,
        }),
      }],
    };
  }

  if (params.action === "exclude") {
    const inputs = params.projects;
    if (!inputs || inputs.length === 0) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "projects parameter is required for 'exclude' action" }) }],
      };
    }

    const excluded: string[] = [];
    const skipped: string[] = [];
    const not_found: string[] = [];
    const ambiguous: Array<{ query: string; matches: Array<{ dir_name: string; name: string }> }> = [];

    for (const query of inputs) {
      const exact = allProjects.filter(
        (p) =>
          p.dirName === query ||
          p.name.toLowerCase() === query.toLowerCase()
      );
      const matches = exact.length > 0 ? exact : allProjects.filter(
        (p) =>
          p.name.toLowerCase().includes(query.toLowerCase()) ||
          p.dirName.toLowerCase().includes(query.toLowerCase())
      );

      if (matches.length === 0) {
        not_found.push(query);
        continue;
      }

      if (exact.length === 0 && matches.length > 1) {
        ambiguous.push({
          query,
          matches: matches.map((m) => ({ dir_name: m.dirName, name: m.name })),
        });
        continue;
      }

      const match = matches[0];
      if (config.excluded_projects.includes(match.dirName)) {
        skipped.push(match.name);
        continue;
      }

      config.indexed_projects = config.indexed_projects.filter((d) => d !== match.dirName);
      config.excluded_projects.push(match.dirName);
      excluded.push(match.name);
    }

    if (excluded.length > 0) {
      saveUserConfig(config);
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          status: "ok",
          excluded,
          skipped,
          not_found,
          ambiguous: ambiguous.length > 0 ? ambiguous : undefined,
          message: `Excluded ${excluded.length} project(s). Use 'include' to restore.`,
        }),
      }],
    };
  }

  if (params.action === "include") {
    const inputs = params.projects;
    if (!inputs || inputs.length === 0) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "projects parameter is required for 'include' action" }) }],
      };
    }

    const excludedProjects = config.excluded_projects
      .map((dirName) => ({ dirName, proj: allProjects.find((p) => p.dirName === dirName) }))
      .map(({ dirName, proj }) => ({ dirName, name: proj?.name || dirName }));

    const included: string[] = [];
    const not_found: string[] = [];
    const ambiguous: Array<{ query: string; matches: Array<{ dir_name: string; name: string }> }> = [];

    for (const query of inputs) {
      const exactMatches = excludedProjects.filter(
        ({ dirName, name }) =>
          dirName === query ||
          name.toLowerCase() === query.toLowerCase()
      );
      const candidates = exactMatches.length > 0
        ? exactMatches
        : excludedProjects.filter(
            ({ dirName, name }) =>
              name.toLowerCase().includes(query.toLowerCase()) ||
              dirName.toLowerCase().includes(query.toLowerCase())
          );

      if (candidates.length === 0) {
        not_found.push(query);
        continue;
      }

      if (exactMatches.length === 0 && candidates.length > 1) {
        ambiguous.push({
          query,
          matches: candidates.map(({ dirName, name }) => ({ dir_name: dirName, name })),
        });
        continue;
      }

      const match = candidates[0];
      config.excluded_projects = config.excluded_projects.filter((d) => d !== match.dirName);
      included.push(match.name);
    }

    if (included.length > 0) {
      saveUserConfig(config);
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          status: "ok",
          included,
          not_found,
          ambiguous: ambiguous.length > 0 ? ambiguous : undefined,
          message: `Restored ${included.length} project(s) from exclusion list.`,
        }),
      }],
    };
  }

  return {
    content: [{ type: "text", text: JSON.stringify({ error: "Invalid action. Use 'add', 'remove', 'list', 'exclude', or 'include'." }) }],
  };
}
