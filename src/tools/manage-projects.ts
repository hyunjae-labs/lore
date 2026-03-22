import type Database from "better-sqlite3";
import { loadUserConfig, saveUserConfig, CONFIG } from "../config.js";
import { scanProjects, scanSessions } from "../indexer/scanner.js";
import { deleteSessionChunks } from "../db/queries.js";
import { getIndexProgress } from "./index-tool.js";
import { toolResult, toolError } from "./helpers.js";
import { pathToDirName } from "../utils/path.js";

// ── Shared project matching helper ──────────────────────────────────────────

interface ProjectInfo {
  dirName: string;
  name: string;
  [key: string]: any;
}

function resolveProjectsByPath(
  queries: string[],
  allProjects: ProjectInfo[]
): { matched: ProjectInfo[]; not_found: string[] } {
  const matched: ProjectInfo[] = [];
  const not_found: string[] = [];
  const projectMap = new Map(allProjects.map((p) => [p.dirName, p]));

  for (const query of queries) {
    const byDirName = projectMap.get(query);
    if (byDirName) {
      matched.push(byDirName);
      continue;
    }
    const converted = pathToDirName(query);
    const byPath = projectMap.get(converted);
    if (byPath) {
      matched.push(byPath);
      continue;
    }
    not_found.push(query);
  }

  return { matched, not_found };
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface ManageProjectsParams {
  action: "add" | "remove" | "list";
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
      const isAdded = config.indexed_projects.includes(p.dirName);
      return {
        dir_name: p.dirName,
        name: p.name,
        session_count: sessions.length,
        added: isAdded,
      };
    });

    projectList.sort((a, b) => {
      if (a.added !== b.added) return a.added ? -1 : 1;
      return b.session_count - a.session_count;
    });

    const visible = projectList.filter((p) => p.session_count > 0 || p.added);
    const hidden = projectList.length - visible.length;

    return toolResult({
      total_projects: visible.length,
      added_count: visible.filter((p) => p.added).length,
      hidden_empty: hidden > 0 ? `${hidden} projects with 0 sessions hidden` : undefined,
      projects: visible,
      hint: "Use action 'add' with project paths to register for indexing, 'remove' to unregister.",
    });
  }

  if (params.action === "add") {
    if (!params.projects || params.projects.length === 0) {
      return toolError("projects parameter is required for 'add' action");
    }

    const { matched, not_found } = resolveProjectsByPath(params.projects, allProjects);

    const added: string[] = [];
    const skipped: string[] = [];

    for (const match of matched) {
      if (config.indexed_projects.includes(match.dirName)) {
        skipped.push(match.dirName);
        continue;
      }
      config.indexed_projects.push(match.dirName);
      added.push(match.dirName);
    }

    if (added.length > 0) {
      saveUserConfig(config);
    }

    return toolResult({
      status: "ok",
      added,
      skipped,
      not_found,
      total_added: config.indexed_projects.length,
      message: `Added ${added.length} project(s). Run 'index' to start indexing.`,
    });
  }

  if (params.action === "remove") {
    if (!params.projects || params.projects.length === 0) {
      return toolError("projects parameter is required for 'remove' action");
    }

    if (getIndexProgress().running) {
      return toolError("Cannot remove projects while indexing is in progress.");
    }

    const registeredProjects = config.indexed_projects.map((dirName) => {
      const proj = allProjects.find((p) => p.dirName === dirName);
      return { dirName, dirPath: proj?.dirPath || "", name: proj?.name || dirName };
    });

    const { matched, not_found } = resolveProjectsByPath(params.projects, registeredProjects);

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
      sessions_deleted: sessionsDeleted,
      total_added: config.indexed_projects.length,
      message: `Removed ${removed.length} project(s) and deleted ${sessionsDeleted} session(s) from index.`,
    });
  }

  return toolError("Invalid action. Use 'add', 'remove', or 'list'.");
}
