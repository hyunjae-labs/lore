# Simplify Project Management & Add Orphan Cleanup

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove exclude/include complexity, add path-based project matching, add orphan session cleanup, and add `scope: "all"` to index tool for one-call full indexing.

**Architecture:** Simplify `manage_projects` to 3 actions (add/remove/list), remove `excluded_projects` config, add orphan prune to incremental/rebuild, and allow `index` to auto-add projects when `project` param is passed. Path-based matching replaces fuzzy matching.

**Tech Stack:** TypeScript, better-sqlite3, sqlite-vec

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/config.ts` | Modify | Remove `excluded_projects` from UserConfig |
| `src/utils/path.ts` | Create | Shared `pathToDirName` utility |
| `src/tools/manage-projects.ts` | Modify | Remove exclude/include, path-based matching, `added` field |
| `src/tools/index-tool.ts` | Modify | Add `scope: "all"`, auto-add on `project`, orphan prune, rebuild cleanup |
| `src/server.ts` | Modify | Update MCP schemas for manage_projects and index |
| `tests/manage-projects.test.ts` | Modify | Remove exclude/include tests, add path-based tests |
| `tests/index-tool.test.ts` | Modify | Add orphan prune tests, update project param tests |
| `tests/integration.test.ts` | Verify | Confirm no `excluded_projects` references (no changes expected) |

## Context: Path → DirName Encoding

Claude Code encodes project paths as directory names under `~/.claude/projects/`:
- `/Users/hyunjaelim/01_projects/lore` → `-Users-hyunjaelim-01-projects-lore`
- Pattern: replace `/`, `_`, `.` with `-`

The `pathToDirName` helper converts a user-provided path to match this encoding:
```typescript
path.replace(/\/+$/, "").replace(/[/_.]/g, "-")
```

---

### Task 1: Remove `excluded_projects` from config + create shared `pathToDirName`

**Files:**
- Modify: `src/config.ts:21-29`
- Create: `src/utils/path.ts`

- [ ] **Step 1: Remove `excluded_projects` from UserConfig interface and defaults**

```typescript
// src/config.ts:21-29
export interface UserConfig {
  indexed_projects: string[];
}

const DEFAULT_USER_CONFIG: UserConfig = {
  indexed_projects: [],
};
```

- [ ] **Step 2: Update `loadUserConfig` to remove `excluded_projects` parsing**

```typescript
// src/config.ts:35-46
export function loadUserConfig(): UserConfig {
  try {
    const raw = readFileSync(getConfigPath(), "utf-8");
    const parsed = JSON.parse(raw);
    return {
      indexed_projects: Array.isArray(parsed.indexed_projects) ? parsed.indexed_projects : [],
    };
  } catch {
    return { ...DEFAULT_USER_CONFIG };
  }
}
```

- [ ] **Step 3: Create shared `pathToDirName` utility**

```typescript
// src/utils/path.ts
/** Convert a project path to Claude Code's dirName encoding */
export function pathToDirName(projectPath: string): string {
  const resolved = projectPath.replace(/\/+$/, "");
  return resolved.replace(/[/_.]/g, "-");
}
```

- [ ] **Step 4: Commit**

```bash
git add src/config.ts src/utils/path.ts
git commit -m "refactor: remove excluded_projects from config, add pathToDirName util"
```

---

### Task 2: Simplify `manage_projects` — remove exclude/include, path-based matching

**Files:**
- Modify: `src/tools/manage-projects.ts`
- Modify: `src/server.ts:104-117`
- Modify: `tests/manage-projects.test.ts`

- [ ] **Step 1: Update tests FIRST — remove exclude/include tests, update assertions**

In `tests/manage-projects.test.ts`:

**Update `beforeEach`** (line 53) — remove `excluded_projects`:
```typescript
saveUserConfig({ indexed_projects: [] });
```

**Update ALL other `saveUserConfig` calls** (lines 131, 151-153, 172-174, 200, 227) — remove `excluded_projects`:
```typescript
// line 131
saveUserConfig({ indexed_projects: ["-Users-test-alpha", "-Users-test-beta"] });
// line 151-153
saveUserConfig({
  indexed_projects: ["-Users-test-alpha", "-Users-test-alpha-extra", "-Users-test-beta"],
});
// line 172-174
saveUserConfig({
  indexed_projects: ["-Users-test-alpha", "-Users-test-beta", "-Users-test-temp-workspace"],
});
// line 200
saveUserConfig({ indexed_projects: ["-Users-test-beta"] });
```

**Delete these tests entirely** (lines 210-286):
- `exclude marks a project as excluded`
- `exclude removes project from indexed_projects if it was registered`
- `list shows excluded: true for excluded projects`
- `include restores an excluded project`
- `include returns not_found when project is not excluded`
- `add removes from excluded_projects when adding a previously excluded project`

**Update existing test assertions:**
- Replace `result.registered` → `result.added`
- Replace `result.registered_count` → `result.added_count`
- Remove all `result.excluded` / `result.excluded_count` assertions

**Add path-based matching test:**
```typescript
it("add accepts full path and converts to dirName", async () => {
  const db = makeDb();
  const response = await handleManageProjects(db, {
    action: "add",
    projects: ["/Users/test/alpha"],
  });
  const result = JSON.parse(response.content[0].text);
  expect(result.added).toContain("-Users-test-alpha");
  db.close();
});

it("add accepts dirName directly", async () => {
  const db = makeDb();
  const response = await handleManageProjects(db, {
    action: "add",
    projects: ["-Users-test-alpha"],
  });
  const result = JSON.parse(response.content[0].text);
  expect(result.added).toContain("-Users-test-alpha");
  db.close();
});
```

**Remove ambiguous tests** — fuzzy matching no longer exists, so the "ambiguous when query matches multiple" tests should be replaced with "not_found when path doesn't match":
```typescript
it("add returns not_found when path doesn't match any project", async () => {
  const db = makeDb();
  const response = await handleManageProjects(db, {
    action: "add",
    projects: ["/nonexistent/path"],
  });
  const result = JSON.parse(response.content[0].text);
  expect(result.not_found).toContain("/nonexistent/path");
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail (implementation not updated yet)**

Run: `npm run build && npx vitest run tests/manage-projects.test.ts`
Expected: Some tests FAIL (exclude/include code still exists but tests removed, new assertions don't match)

- [ ] **Step 3: Replace `resolveProjects`/`formatAmbiguous` with path-based `resolveProjectsByPath`**

Delete `resolveProjects` (lines 22-52) and `formatAmbiguous` (lines 54-61). Add:

```typescript
import { pathToDirName } from "../utils/path.js";

function resolveProjectsByPath(
  queries: string[],
  allProjects: ProjectInfo[]
): { matched: ProjectInfo[]; not_found: string[] } {
  const matched: ProjectInfo[] = [];
  const not_found: string[] = [];
  const projectMap = new Map(allProjects.map((p) => [p.dirName, p]));

  for (const query of queries) {
    // Try exact dirName match first
    const byDirName = projectMap.get(query);
    if (byDirName) {
      matched.push(byDirName);
      continue;
    }
    // Try path → dirName conversion
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
```

- [ ] **Step 4: Update `ManageProjectsParams` — remove exclude/include**

```typescript
export interface ManageProjectsParams {
  action: "add" | "remove" | "list";
  projects?: string[];
}
```

- [ ] **Step 5: Rewrite `list` action — use `added` instead of `registered`/`excluded`**

```typescript
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
```

- [ ] **Step 6: Rewrite `add` action — path-based matching, no excluded_projects**

```typescript
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
```

- [ ] **Step 7: Rewrite `remove` action — path-based matching on registered projects**

```typescript
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
```

- [ ] **Step 8: Delete `exclude`/`include` blocks, update final error**

Remove all code for `params.action === "exclude"` and `params.action === "include"`. Update:
```typescript
return toolError("Invalid action. Use 'add', 'remove', or 'list'.");
```

- [ ] **Step 9: Update MCP schema in server.ts**

```typescript
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
```

- [ ] **Step 10: Build and run tests**

Run: `npm run build && npx vitest run tests/manage-projects.test.ts`
Expected: All manage-projects tests pass

- [ ] **Step 11: Commit**

```bash
git add src/tools/manage-projects.ts src/server.ts tests/manage-projects.test.ts
git commit -m "refactor: simplify manage_projects to add/remove/list with path-based matching"
```

---

### Task 3: Add orphan prune to `index`

**Files:**
- Modify: `src/tools/index-tool.ts`
- Modify: `tests/index-tool.test.ts`

- [ ] **Step 1: Write failing test for orphan prune**

Add to `tests/index-tool.test.ts` inside the existing `handleIndex` describe block. Use the same test setup pattern as existing tests (projectDir, projectDirName, DUMMY_JSONL etc.):

```typescript
it("incremental prunes sessions whose JSONL was deleted from disk", async () => {
  const db = makeDb();
  // 1. Create a session file and index it
  writeFileSync(join(projectDir, "deleted-session.jsonl"), DUMMY_JSONL);
  saveUserConfig({ indexed_projects: [projectDirName] });
  await handleIndex(db, {});
  await waitForIndexComplete(30000);

  // Verify it was indexed
  const before = db.prepare(
    "SELECT COUNT(*) as c FROM sessions WHERE session_id = 'deleted-session'"
  ).get() as { c: number };
  expect(before.c).toBe(1);

  // 2. Delete the file from disk
  unlinkSync(join(projectDir, "deleted-session.jsonl"));

  // 3. Run incremental again
  await handleIndex(db, {});
  await waitForIndexComplete(30000);

  // 4. Session should be pruned from DB
  const orphan = db.prepare(
    "SELECT * FROM sessions WHERE session_id = 'deleted-session'"
  ).get();
  expect(orphan).toBeUndefined();
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/index-tool.test.ts -t "prunes sessions"`
Expected: FAIL — orphan session remains in DB

- [ ] **Step 3: Implement `pruneOrphanSessions` in index-tool.ts**

Add before `runIndexInBackground` (before line 426):

```typescript
/**
 * Remove DB sessions whose JSONL files no longer exist on disk.
 * For each project in the list: readdir → compare with DB → delete orphans.
 * If a project directory is gone, all its sessions are treated as orphans.
 */
function pruneOrphanSessions(
  db: Database.Database,
  projectsToIndex: Array<{ dirName: string; dirPath: string; name: string }>
): number {
  let pruned = 0;

  for (const project of projectsToIndex) {
    const projectRow = db
      .prepare("SELECT id FROM projects WHERE dir_name = ?")
      .get(project.dirName) as { id: number } | undefined;
    if (!projectRow) continue;

    const dbSessions = db
      .prepare("SELECT id, session_id FROM sessions WHERE project_id = ?")
      .all(projectRow.id) as Array<{ id: number; session_id: string }>;
    if (dbSessions.length === 0) continue;

    let diskFiles: Set<string>;
    try {
      const files = readdirSync(project.dirPath)
        .filter((name) => name.endsWith(".jsonl") && !name.startsWith("."));
      diskFiles = new Set(files.map((f) => basename(f, ".jsonl")));
    } catch {
      diskFiles = new Set();
    }

    for (const dbSession of dbSessions) {
      if (!diskFiles.has(dbSession.session_id)) {
        deleteSessionChunks(db, dbSession.id);
        db.prepare("DELETE FROM sessions WHERE id = ?").run(dbSession.id);
        pruned++;
      }
    }
  }

  return pruned;
}
```

- [ ] **Step 4: Call `pruneOrphanSessions` in `runIndexInBackground`**

In `runIndexInBackground`, at line 435 (after `const embedder = await getEmbedder();`):

```typescript
// Prune sessions whose JSONL files no longer exist on disk
const projectInfos = projectSessions.map(({ project }) => project);
pruneOrphanSessions(db, projectInfos);
```

- [ ] **Step 5: Also prune registered projects whose directories are gone**

In `handleIndex`, after building `projectsToIndex` but before counting sessions, add a pass that checks for registered projects not found on disk:

```typescript
// Prune config entries for projects whose directories no longer exist
const allDirNames = new Set(allProjects.map((p) => p.dirName));
const staleProjects = userConfig.indexed_projects.filter((d) => !allDirNames.has(d));
if (staleProjects.length > 0) {
  for (const dirName of staleProjects) {
    const projectRow = db.prepare("SELECT id FROM projects WHERE dir_name = ?").get(dirName) as { id: number } | undefined;
    if (projectRow) {
      const sessions = db.prepare("SELECT id FROM sessions WHERE project_id = ?").all(projectRow.id) as { id: number }[];
      for (const session of sessions) {
        deleteSessionChunks(db, (session as { id: number }).id);
      }
      db.prepare("DELETE FROM sessions WHERE project_id = ?").run(projectRow.id);
      db.prepare("DELETE FROM projects WHERE id = ?").run(projectRow.id);
    }
  }
  userConfig.indexed_projects = userConfig.indexed_projects.filter((d) => allDirNames.has(d));
  saveUserConfig(userConfig);
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/index-tool.test.ts -t "prunes sessions"`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/tools/index-tool.ts tests/index-tool.test.ts
git commit -m "feat: prune orphan sessions and stale projects during index"
```

---

### Task 4: Fix rebuild to clean DB first

**Files:**
- Modify: `src/tools/index-tool.ts`
- Modify: `tests/index-tool.test.ts`

- [ ] **Step 1: Write failing test**

Add inside the existing `handleIndex` describe block, using the same setup as other tests:

```typescript
it("rebuild removes sessions whose JSONL was deleted from disk", async () => {
  const db = makeDb();
  saveUserConfig({ indexed_projects: [projectDirName] });

  // Create an extra session file, index everything
  writeFileSync(join(projectDir, "to-be-deleted.jsonl"), DUMMY_JSONL);
  await handleIndex(db, {});
  await waitForIndexComplete(30000);

  const before = db.prepare(
    "SELECT COUNT(*) as c FROM sessions WHERE session_id = 'to-be-deleted'"
  ).get() as { c: number };
  expect(before.c).toBe(1);

  // Delete the session file from disk
  unlinkSync(join(projectDir, "to-be-deleted.jsonl"));

  // Rebuild
  await handleIndex(db, { mode: "rebuild", confirm: true });
  await waitForIndexComplete(30000);

  // Deleted session should NOT be in DB
  const orphan = db.prepare(
    "SELECT * FROM sessions WHERE session_id = 'to-be-deleted'"
  ).get();
  expect(orphan).toBeUndefined();
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/index-tool.test.ts -t "rebuild removes"`
Expected: FAIL — deleted session still in DB

- [ ] **Step 3: Add per-project DB cleanup before rebuild session loop**

In `runIndexInBackground`, inside `for (const { project, sessions } of projectSessions)`, after `upsertProject` (line 440-444), add:

```typescript
if (forceMode === "rebuild") {
  // Delete all sessions and chunks for this project, then re-index from disk
  const existingSessions = db
    .prepare("SELECT id FROM sessions WHERE project_id = ?")
    .all(projectId) as { id: number }[];
  for (const session of existingSessions) {
    deleteSessionChunks(db, session.id);
  }
  db.prepare("DELETE FROM sessions WHERE project_id = ?").run(projectId);
}
```

Keep the existing per-session `if (forceMode === "rebuild") reindexStrategy = "rebuild"` so each session does a full re-index (not append).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/index-tool.test.ts -t "rebuild removes"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/index-tool.ts tests/index-tool.test.ts
git commit -m "fix: rebuild deletes all project DB data before re-indexing"
```

---

### Task 5: Add `scope: "all"` and auto-add on `project` param to index

**Files:**
- Modify: `src/tools/index-tool.ts:310-314,358-386`
- Modify: `src/server.ts:68-83`
- Modify: `tests/index-tool.test.ts`

- [ ] **Step 1: Write tests for scope "all" and project auto-add**

```typescript
it("scope 'all' registers all projects and indexes them", async () => {
  const db = makeDb();
  // No projects registered initially
  const configBefore = loadUserConfig();
  expect(configBefore.indexed_projects.length).toBe(0);

  const response = await handleIndex(db, { scope: "all" });
  const result = JSON.parse(response.content[0].text);
  expect(result.status).toBe("started");

  await waitForIndexComplete(30000);

  // All projects should now be registered
  const configAfter = loadUserConfig();
  expect(configAfter.indexed_projects.length).toBeGreaterThan(0);
  db.close();
});

it("project param auto-adds and indexes specific project", async () => {
  const db = makeDb();
  const configBefore = loadUserConfig();
  expect(configBefore.indexed_projects).not.toContain(projectDirName);

  await handleIndex(db, { project: projectDirName });
  await waitForIndexComplete(30000);

  const configAfter = loadUserConfig();
  expect(configAfter.indexed_projects).toContain(projectDirName);
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/index-tool.test.ts -t "scope"`
Expected: FAIL

- [ ] **Step 3: Update `IndexParams` type**

```typescript
export interface IndexParams {
  mode?: "rebuild" | "cancel";
  project?: string;
  scope?: "all";
  confirm?: boolean;
}
```

- [ ] **Step 4: Update project selection logic in `handleIndex`**

Replace lines 358-386 with:

```typescript
const allProjects = scanProjects(projectsBaseDir);
const userConfig = loadUserConfig();

let projectsToIndex: typeof allProjects;

if (params.scope === "all") {
  projectsToIndex = allProjects;
  const newlyAdded: string[] = [];
  for (const p of allProjects) {
    if (!userConfig.indexed_projects.includes(p.dirName)) {
      userConfig.indexed_projects.push(p.dirName);
      newlyAdded.push(p.dirName);
    }
  }
  if (newlyAdded.length > 0) {
    saveUserConfig(userConfig);
  }
} else if (params.project) {
  const dirName = pathToDirName(params.project);
  const found = allProjects.find((p) => p.dirName === dirName || p.dirName === params.project);
  if (!found) {
    releaseLock(loreDir);
    return toolResult({
      status: "not_found",
      message: `Project not found: ${params.project}`,
    });
  }
  if (!userConfig.indexed_projects.includes(found.dirName)) {
    userConfig.indexed_projects.push(found.dirName);
    saveUserConfig(userConfig);
  }
  projectsToIndex = [found];
} else if (userConfig.indexed_projects.length > 0) {
  const registered = new Set(userConfig.indexed_projects);
  projectsToIndex = allProjects.filter((p) => registered.has(p.dirName));
} else {
  releaseLock(loreDir);
  return toolResult({
    status: "no_projects_added",
    total_projects_on_disk: allProjects.length,
    message: "No projects are added for indexing. Use manage_projects 'add' or pass scope 'all' to index everything.",
  });
}
```

- [ ] **Step 5: Add import for `pathToDirName` and `saveUserConfig`**

At top of `index-tool.ts`:
```typescript
import { loadUserConfig, saveUserConfig } from "../config.js";
import { pathToDirName } from "../utils/path.js";
```

(Remove the existing `import { loadUserConfig } from "../config.js";` line and consolidate.)

- [ ] **Step 6: Update existing index test that uses fuzzy `project` param**

Find the test at `tests/index-tool.test.ts` that passes `project: "alpha"` (fuzzy match). Update to use dirName or path:

```typescript
// Before: project: "alpha" (fuzzy)
// After: project: projectDirName (exact dirName match)
```

- [ ] **Step 7: Update MCP schema in server.ts**

```typescript
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
```

- [ ] **Step 8: Build and run all tests**

Run: `npm run build && npm test`
Expected: All tests pass

- [ ] **Step 9: Commit**

```bash
git add src/tools/index-tool.ts src/server.ts tests/index-tool.test.ts
git commit -m "feat: add scope 'all' and auto-add on project param to index"
```

---

### Task 6: Final integration verification

- [ ] **Step 1: Verify `tests/integration.test.ts` compiles**

Run: `npx vitest run tests/integration.test.ts`
Expected: Compiles (no `excluded_projects` references)

- [ ] **Step 2: Full build**

Run: `npm run build`
Expected: Clean build, no errors

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: All tests pass (except known sqlite-vec mutex issues)

- [ ] **Step 4: Version bump**

Update `package.json` version patch number.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "v0.2.26: simplify project management, add orphan cleanup"
```
