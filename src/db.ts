import "./env.js";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const DB_PATH = process.env.DB_PATH ?? join(here, "..", "data", "world.db");

let _db: Database.Database | null = null;

export function db(): Database.Database {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.exec(readFileSync(join(here, "schema.sql"), "utf8"));
  return _db;
}

export function resetDb(): Database.Database {
  if (_db) { _db.close(); _db = null; }
  const d = new Database(DB_PATH);
  const tables = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  d.pragma("foreign_keys = OFF");
  for (const t of tables) d.exec(`DROP TABLE IF EXISTS ${t.name}`);
  d.close();
  return db();
}

export const nowIso = () => new Date().toISOString();
export const uid = (p: string) => `${p}_${Math.random().toString(36).slice(2, 8)}`;
