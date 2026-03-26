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
  action: "exclude" | "include" | "list";
  projects?: string[];
}

export async function handleManageProjects(
  db: Database.Database,
  params: ManageProjectsParams
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const config = loadUserConfig();
  const projectsBaseDir = process.env.CLAUDE_PROJECTS_DIR ?? CONFIG.claudeProjectsDir;
  const allProjects = scanProjects(projectsBaseDir);
  const excludedSet = new Set(config.excluded_projects);

  if (params.action === "list") {
    const projectList = allProjects.map((p) => {
      const sessions = scanSessions(p.dirPath);
      const isExcluded = excludedSet.has(p.dirName);
      return {
        dir_name: p.dirName,
        name: p.name,
        session_count: sessions.length,
        status: isExcluded ? "excluded" as const : "indexed" as const,
        excluded: isExcluded,
      };
    });

    projectList.sort((a, b) => {
      if (a.excluded !== b.excluded) return a.excluded ? 1 : -1;
      return b.session_count - a.session_count;
    });

    const visible = projectList.filter((p) => p.session_count > 0 || p.excluded);
    const hidden = projectList.length - visible.length;

    return toolResult({
      total_projects: visible.length,
      excluded_count: visible.filter((p) => p.excluded).length,
      hidden_empty: hidden > 0 ? `${hidden} projects with 0 sessions hidden` : undefined,
      projects: visible,
      hint: "Use action 'exclude' to stop indexing a project, 'include' to undo an exclusion.",
    });
  }

  if (params.action === "exclude") {
    if (!params.projects || params.projects.length === 0) {
      return toolError("projects parameter is required for 'exclude' action");
    }

    if (getIndexProgress().running) {
      return toolError("Cannot exclude projects while indexing is in progress.");
    }

    // Resolve against ALL discovered projects
    const { matched, not_found } = resolveProjectsByPath(params.projects, allProjects);

    const excluded: string[] = [];
    const skipped: string[] = [];
    let sessionsDeleted = 0;

    for (const match of matched) {
      if (excludedSet.has(match.dirName)) {
        skipped.push(match.dirName);
        continue;
      }
      config.excluded_projects.push(match.dirName);
      excludedSet.add(match.dirName);

      // Clean DB data (chunks, sessions, project) but NEVER touch .jsonl files
      const project = db.prepare("SELECT id FROM projects WHERE dir_name = ?").get(match.dirName) as { id: number } | undefined;
      if (project) {
        const sessions = db.prepare("SELECT id FROM sessions WHERE project_id = ?").all(project.id) as { id: number }[];
        for (const session of sessions) {
          deleteSessionChunks(db, session.id);
        }
        sessionsDeleted += sessions.length;
        db.prepare("DELETE FROM sessions WHERE project_id = ?").run(project.id);
        db.prepare("DELETE FROM projects WHERE id = ?").run(project.id);
      }
      excluded.push(match.dirName);
    }

    if (excluded.length > 0) {
      saveUserConfig(config);
    }

    return toolResult({
      status: "ok",
      excluded,
      skipped,
      not_found,
      sessions_deleted: sessionsDeleted,
      total_excluded: config.excluded_projects.length,
      message: `Excluded ${excluded.length} project(s) and deleted ${sessionsDeleted} session(s) from index.`,
    });
  }

  if (params.action === "include") {
    if (!params.projects || params.projects.length === 0) {
      return toolError("projects parameter is required for 'include' action");
    }

    // Resolve against the excluded list
    const excludedProjects = config.excluded_projects.map((dirName) => {
      const proj = allProjects.find((p) => p.dirName === dirName);
      return { dirName, dirPath: proj?.dirPath || "", name: proj?.name || dirName };
    });

    const { matched, not_found } = resolveProjectsByPath(params.projects, excludedProjects);

    const included: string[] = [];

    for (const { dirName } of matched) {
      config.excluded_projects = config.excluded_projects.filter((d) => d !== dirName);
      included.push(dirName);
    }

    if (included.length > 0) {
      saveUserConfig(config);
    }

    return toolResult({
      status: "ok",
      included,
      not_found,
      total_excluded: config.excluded_projects.length,
      message: `Included ${included.length} project(s). They will be indexed on the next index run.`,
    });
  }

  return toolError("Invalid action. Use 'exclude', 'include', or 'list'.");
}
