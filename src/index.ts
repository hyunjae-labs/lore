#!/usr/bin/env node
import { startServer } from "./server.js";

startServer().catch((err) => {
  console.error("Failed to start lore:", err);
  process.exit(1);
});
