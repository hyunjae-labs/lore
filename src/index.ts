#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, spawn } from "node:child_process";
import { startServer } from "./server.js";
import { CONFIG } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v") || args.includes("version")) {
  console.log(`getlore v${pkg.version}`);
  process.exit(0);
}

if (args.includes("update")) {
  const current = pkg.version;
  console.log(`Current version: v${current}`);
  console.log("Checking for updates...");

  try {
    const latest = execSync("npm view getlore version", { encoding: "utf-8" }).trim();

    if (latest === current) {
      console.log(`getlore is up to date (v${current})`);
    } else {
      console.log(`New version available: v${current} → v${latest}`);
      console.log("Updating...");
      execSync("npm install -g getlore@latest", { stdio: "inherit" });
      console.log(`Updated to v${latest}`);
    }
  } catch {
    console.error("Update failed. Try manually: npm install -g getlore@latest");
  }
  process.exit(0);
}

if (args[0] === "index") {
  // --background: spawn detached child and exit immediately (for hooks)
  if (args.includes("--background")) {
    const scriptPath = fileURLToPath(import.meta.url);
    const forwardArgs = args.filter((a) => a !== "--background");
    const child = spawn(process.execPath, [scriptPath, ...forwardArgs], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    process.exit(0);
  }

  // Parse CLI flags
  const modeIdx = args.indexOf("--mode");
  const mode = modeIdx !== -1 && args[modeIdx + 1] ? args[modeIdx + 1] as "rebuild" | "cancel" : undefined;
  const projectIdx = args.indexOf("--project");
  const project = projectIdx !== -1 && args[projectIdx + 1] ? args[projectIdx + 1] : undefined;

  const { getDb, closeDb } = await import("./db/index.js");
  const { handleIndex, waitForIndexComplete, getIndexProgress } = await import("./tools/index-tool.js");

  const db = getDb(CONFIG.dbPath);
  const result = await handleIndex(db, { mode, project });

  const resultData = JSON.parse(result.content[0].text);
  console.error(`lore: ${resultData.message || resultData.status}`);

  if (resultData.status === "started") {
    await waitForIndexComplete();
    const final = getIndexProgress();
    console.error(`lore: done — ${final.sessionsIndexed} indexed, ${final.sessionsSkipped} skipped, ${final.chunksCreated} chunks`);
  }

  closeDb();
  process.exit(0);
}

startServer(pkg.version).catch((err) => {
  console.error("Failed to start lore:", err);
  process.exit(1);
});
