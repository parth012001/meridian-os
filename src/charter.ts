import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
export const CHARTER_PATH = process.env.CHARTER_PATH ?? join(here, "..", "org.yaml");

export const ActionType = z.enum(["transfer_stock", "expedite_po", "partial_ship", "substitute_sku", "change_promise_date", "discount"]);
export type ActionType = z.infer<typeof ActionType>;

const Role = z.object({
  kind: z.enum(["human", "agent"]),
  status: z.enum(["live", "declared"]).optional(),
  title: z.string(),
  horizon: z.string().optional(),
  model_tier: z.enum(["cheap", "standard"]).optional(),
  goal: z.string().optional(),
  tools: z.array(z.string()).default([]),
  approves: z.array(z.string()).optional(),
  authority: z.object({
    spend_usd: z.number().default(0),
    may: z.array(ActionType).default([]),
    may_not: z.array(z.string()).default([]),
    recommend_only: z.array(ActionType).default([]),
    send_without_review: z.array(z.string()).default([]),
    needs_review: z.array(z.string()).default([]),
    may_edit_charter: z.boolean().default(false),
  }).prefault({}),
});

export const Charter = z.object({
  company: z.string(),
  version: z.number(),
  outcome: z.object({ id: z.string(), statement: z.string() }),
  kpis: z.record(z.string(), z.object({ formula: z.string(), target: z.string().optional(), constraint: z.string().optional() })),
  constraints: z.array(z.object({ id: z.string(), rule: z.string() })),
  autonomy_levels: z.record(ActionType, z.enum(["act", "act_within_limit", "act_if_ship_policy_allows", "recommend", "observe"])),
  roles: z.record(z.string(), Role),
  escalation: z.object({ default: z.string(), approval_timeout_hours: z.number() }),
});
export type Charter = z.infer<typeof Charter>;
export type RoleDef = z.infer<typeof Role>;

export const MAX_RECOVERY_PCT = 0.02; // C4

let cached: Charter | null = null;
export function loadCharter(force = false): Charter {
  if (cached && !force) return cached;
  cached = Charter.parse(YAML.parse(readFileSync(CHARTER_PATH, "utf8")));
  return cached;
}
export function loadCharterFrom(path: string): Charter { return Charter.parse(YAML.parse(readFileSync(path, "utf8"))); }
export function rawCharterText(): string { return readFileSync(CHARTER_PATH, "utf8"); }

/** The only write path to the Charter. Called by the owner's merge endpoint, never by an agent.
 *  Applies a patch by path (roles.expeditor.authority.spend_usd, autonomy_levels.expedite_po, ...)
 *  so comments and formatting in org.yaml survive. Validates the result before writing. */
export function applyCharterPatch(patch: Record<string, unknown>): Charter {
  const doc = YAML.parseDocument(readFileSync(CHARTER_PATH, "utf8"));
  const walk = (obj: Record<string, unknown>, path: string[]) => {
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === "object" && !Array.isArray(v)) walk(v as Record<string, unknown>, [...path, k]);
      else doc.setIn([...path, k], v);
    }
  };
  walk(patch, []);
  doc.set("version", (doc.get("version") as number) + 1);
  const next = Charter.parse(doc.toJS());   // validate before touching disk
  writeFileSync(CHARTER_PATH, doc.toString({ lineWidth: 0, flowCollectionPadding: false }));
  cached = null;
  return next;
}
export function restoreBaselineCharter(): void {
  const base = join(here, "..", "data", "org.baseline.yaml");
  writeFileSync(CHARTER_PATH, readFileSync(base, "utf8"));
  cached = null;
}
