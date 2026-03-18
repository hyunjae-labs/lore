import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL, VEC_TABLE_SQL, FTS_TABLE_SQL } from "./schema.js";

let db: Database.Database | null = null;

export function getDb(dbPath: string): Database.Database {
  if (db) return db;

  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  }

  db = new Database(dbPath);
  sqliteVec.load(db);

  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("cache_size = -65536");
  db.pragma("mmap_size = 268435456");
  db.pragma("busy_timeout = 5000");

  db.exec(SCHEMA_SQL);
  db.exec(VEC_TABLE_SQL);
  db.exec(FTS_TABLE_SQL);

  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
