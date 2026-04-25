import type Database from "better-sqlite3";
import { loadUserConfig, saveUserConfig, CONFIG } from "../config.js";
import { scanProjects, scanSessions, scanCodexProjectsAndSessions } from "../indexer/scanner.js";
import { deleteProjectData } from "../db/queries.js";
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
  const projectsBaseDir = CONFIG.claudeProjectsDir;
  const allProjects = scanProjects(projectsBaseDir);
  const excludedSet = new Set(config.excluded_projects);

  if (params.action === "list") {
    const claudeList = allProjects.map((p) => {
      const sessions = scanSessions(p.dirPath);
      const isExcluded = excludedSet.has(p.dirName);
      return {
        dir_name: p.dirName,
        name: p.name,
        session_count: sessions.length,
        excluded: isExcluded,
      };
    });

    // Include Codex virtual projects in the list
    const codexProjectSessions = scanCodexProjectsAndSessions(CONFIG.codexSessionsDir);
    const codexList = codexProjectSessions.map(({ project, sessions }) => ({
      dir_name: project.dirName,
      name: project.name,
      session_count: sessions.length,
      excluded: excludedSet.has(project.dirName),
    }));

    const projectList = [...claudeList, ...codexList];

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
      hint: "Use 'exclude' to stop indexing a project, 'include' to re-enable it. The 'excluded' boolean indicates current state.",
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

    // Separate matching from DB mutations so we can run deletes in a transaction
    const toExclude: ProjectInfo[] = [];
    for (const match of matched) {
      if (excludedSet.has(match.dirName)) {
        skipped.push(match.dirName);
      } else {
        toExclude.push(match);
      }
    }

    if (toExclude.length > 0) {
      db.transaction(() => {
        for (const match of toExclude) {
          config.excluded_projects.push(match.dirName);
          excludedSet.add(match.dirName);
          sessionsDeleted += deleteProjectData(db, match.dirName);
          excluded.push(match.dirName);
        }
      })();
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
