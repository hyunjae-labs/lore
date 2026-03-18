#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./server.js";

const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v") || args.includes("version")) {
  // Read version from package.json (SSOT)
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
  console.log(`getlore v${pkg.version}`);
  process.exit(0);
}

startServer().catch((err) => {
  console.error("Failed to start lore:", err);
  process.exit(1);
});
