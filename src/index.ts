#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { startServer } from "./server.js";

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

startServer().catch((err) => {
  console.error("Failed to start lore:", err);
  process.exit(1);
});
