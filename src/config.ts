import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

export const CONFIG = {
  loreDir: process.env.LORE_DIR || join(homedir(), ".lore"),
  dbPath: process.env.LORE_DB || join(homedir(), ".lore", "lore.db"),
  claudeProjectsDir: process.env.CLAUDE_PROJECTS_DIR || join(homedir(), ".claude", "projects"),
  embeddingModel: "Xenova/multilingual-e5-small",
  embeddingDimensions: 384,
  maxChunkTokens: 1000,
  shortTurnThreshold: 50,
  searchDefaultLimit: 10,
  searchMaxLimit: 50,
  indexBatchSize: 32,
  autoIndexThreshold: 20,
} as const;

// ── User config (persisted in ~/.lore/config.json) ───────────────────────

export interface UserConfig {
  indexed_projects: string[];
}

const DEFAULT_USER_CONFIG: UserConfig = {
  indexed_projects: [],
};

function getConfigPath(): string {
  return join(CONFIG.loreDir, "config.json");
}

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

export function saveUserConfig(config: UserConfig): void {
  const dir = CONFIG.loreDir;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}
