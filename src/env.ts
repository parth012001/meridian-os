// Minimal .env loader (no dependency). Existing environment wins.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const p = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");
if (existsSync(p)) for (const line of readFileSync(p, "utf8").split("\n")) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line); if (!m || line.trim().startsWith("#")) continue;
  if (process.env[m[1]] === undefined && m[2] !== "") process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
