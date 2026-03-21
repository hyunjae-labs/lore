import type Database from "better-sqlite3";
import { loadUserConfig, saveUserConfig, CONFIG } from "../config.js";
import { scanProjects, scanSessions } from "../indexer/scanner.js";
import { deleteSessionChunks } from "../db/queries.js";
import { getIndexProgress } from "./index-tool.js";
import { toolResult, toolError } from "./helpers.js";

// ── Shared project matching helper ──────────────────────────────────────────

interface ProjectInfo {
  dirName: string;
  name: string;
  [key: string]: any;
}

interface ResolveResult<T extends ProjectInfo> {
  matched: T[];
  ambiguous: Array<{ query: string; candidates: T[] }>;
  not_found: string[];
}

function resolveProjects<T extends ProjectInfo>(queries: string[], candidates: T[]): ResolveResult<T> {
  const matched: T[] = [];
  const ambiguous: Array<{ query: string; candidates: T[] }> = [];
  const not_found: string[] = [];

  for (const query of queries) {
    const exact = candidates.filter(
      (p) =>
        p.dirName === query ||
        p.name.toLowerCase() === query.toLowerCase()
    );
    if (exact.length === 1) {
      matched.push(exact[0]);
      continue;
    }
    const fuzzy = candidates.filter(
      (p) =>
        p.dirName.toLowerCase().includes(query.toLowerCase()) ||
        p.name.toLowerCase().includes(query.toLowerCase())
    );
    if (fuzzy.length === 1) {
      matched.push(fuzzy[0]);
    } else if (fuzzy.length > 1) {
      ambiguous.push({ query, candidates: fuzzy });
    } else {
      not_found.push(query);
    }
  }

  return { matched, ambiguous, not_found };
}

/** Format ambiguous results for JSON response output */
function formatAmbiguous(ambiguous: Array<{ query: string; candidates: ProjectInfo[] }>) {
  if (ambiguous.length === 0) return undefined;
  return ambiguous.map((a) => ({
    query: a.query,
    matches: a.candidates.map((m) => ({ dir_name: m.dirName, name: m.name })),
  }));
}

// ── Types ───────────────────────────────────────────────────────────────────

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

    return toolResult({
      total_projects: visible.length,
      registered_count: visible.filter((p) => p.registered).length,
      excluded_count: visible.filter((p) => p.excluded).length,
      hidden_empty: hidden > 0 ? `${hidden} projects with 0 sessions hidden` : undefined,
      projects: visible,
      hint: "Use action 'add' to register for indexing, 'remove' to unregister, 'exclude' to intentionally exclude, 'include' to restore an excluded project.",
    });
  }

  if (params.action === "add") {
    if (!params.projects || params.projects.length === 0) {
      return toolError("projects parameter is required for 'add' action");
    }

    const { matched, ambiguous, not_found } = resolveProjects(params.projects, allProjects);

    const added: string[] = [];
    const skipped: string[] = [];

    for (const match of matched) {
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

    return toolResult({
      status: "ok",
      added,
      skipped,
      not_found,
      ambiguous: formatAmbiguous(ambiguous),
      total_registered: config.indexed_projects.length,
      message: `Added ${added.length} project(s). Run 'index' to start indexing.`,
    });
  }

  if (params.action === "remove") {
    if (!params.projects || params.projects.length === 0) {
      return toolError("projects parameter is required for 'remove' action");
    }

    // Block remove during active indexing to prevent DB conflicts
    if (getIndexProgress().running) {
      return toolError("Cannot remove projects while indexing is in progress. Wait for indexing to complete or check status.");
    }

    const registeredProjects = config.indexed_projects
      .map((dirName) => ({ dirName, proj: allProjects.find((p) => p.dirName === dirName) }))
      .map(({ dirName, proj }) => ({ dirName, name: proj?.name || dirName }));

    const { matched, ambiguous, not_found } = resolveProjects(params.projects, registeredProjects);

    const removed: string[] = [];
    let sessionsDeleted = 0;

    for (const { dirName } of matched) {
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

    if (removed.length > 0) {
      saveUserConfig(config);
    }

    return toolResult({
      status: "ok",
      removed,
      not_found,
      ambiguous: formatAmbiguous(ambiguous),
      sessions_deleted: sessionsDeleted,
      total_registered: config.indexed_projects.length,
      message: `Removed ${removed.length} project(s) and deleted ${sessionsDeleted} session(s) from index.`,
    });
  }

  if (params.action === "exclude") {
    if (!params.projects || params.projects.length === 0) {
      return toolError("projects parameter is required for 'exclude' action");
    }

    const { matched, ambiguous, not_found } = resolveProjects(params.projects, allProjects);

    const excluded: string[] = [];
    const skipped: string[] = [];

    for (const match of matched) {
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

    return toolResult({
      status: "ok",
      excluded,
      skipped,
      not_found,
      ambiguous: formatAmbiguous(ambiguous),
      message: `Excluded ${excluded.length} project(s). Use 'include' to restore.`,
    });
  }

  if (params.action === "include") {
    if (!params.projects || params.projects.length === 0) {
      return toolError("projects parameter is required for 'include' action");
    }

    const excludedProjects = config.excluded_projects
      .map((dirName) => ({ dirName, proj: allProjects.find((p) => p.dirName === dirName) }))
      .map(({ dirName, proj }) => ({ dirName, name: proj?.name || dirName }));

    const { matched, ambiguous, not_found } = resolveProjects(params.projects, excludedProjects);

    const included: string[] = [];

    for (const match of matched) {
      config.excluded_projects = config.excluded_projects.filter((d) => d !== match.dirName);
      included.push(match.name);
    }

    if (included.length > 0) {
      saveUserConfig(config);
    }

    return toolResult({
      status: "ok",
      included,
      not_found,
      ambiguous: formatAmbiguous(ambiguous),
      message: `Restored ${included.length} project(s) from exclusion list.`,
    });
  }

  return toolError("Invalid action. Use 'add', 'remove', 'list', 'exclude', or 'include'.");
}
