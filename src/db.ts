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
  addColumns(_db);
  return _db;
}
/** Columns added after a World was first built. CREATE TABLE IF NOT EXISTS does not touch an existing table, so a long-lived
 *  data/world.db gets them here; a fresh seed gets them from schema.sql. */
const ADDED: Array<[table: string, column: string, ddl: string]> = [
  ["purchase_orders", "pre_expedite_ship_date", "TEXT"],
  ["purchase_orders", "expedite_missed", "INTEGER NOT NULL DEFAULT 0"],
  ["charter_proposals", "shape", "TEXT"],
  ["charter_proposals", "replay", "TEXT"],
];
function addColumns(d: Database.Database) {
  for (const [table, column, ddl] of ADDED) {
    const cols = (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name);
    if (!cols.includes(column)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

export function resetDb(): Database.Database {
  if (_db) { _db.close(); _db = null; }
  const d = new Database(DB_PATH);
  const tables = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'trials'").all() as { name: string }[];
  d.pragma("foreign_keys = OFF");
  for (const t of tables) d.exec(`DROP TABLE IF EXISTS ${t.name}`);
  d.close();
  return db();
}

export const nowIso = () => new Date().toISOString();
export const uid = (p: string) => `${p}_${Math.random().toString(36).slice(2, 8)}`;
