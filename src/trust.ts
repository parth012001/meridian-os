// The trust engine. Trust is earned per action SHAPE (action type, per supplier where the action names one), never per agent.
// Every shape starts supervised. Consecutive clean owner approvals build a streak toward the Charter threshold; a rejection resets
// it. At threshold the engine files a Charter proposal with a replay of what the change would have done to past approvals.
// Only the owner merges. A failure named in the Charter's demote_on revokes autonomy with a Charter patch that only tightens.
// Every row here is a materialized view of the ledger: evidence and grants point back at approvals, proposals and ledger rows.
import { db, nowIso } from "./db.js";
import { loadCharter } from "./charter.js";
import { log } from "./ledger.js";

export interface ActionRow { id: string; type: string; params: string; order_id: string; cost_usd: number; gate_rule: string | null; role: string }
export interface TrustRow {
  shape: string; action_type: string; streak: number; threshold: number;
  total_approved: number; total_rejected: number; total_failed: number; total_autonomous: number;
  status: "supervised" | "proposed" | "autonomous" | "demoted"; evidence: string; grant: string | null; updated_at: string;
}
export interface Evidence { approval_id: string; action_id: string; order_id: string; cost_usd: number; gate_rule: string | null; ts: string }

/** "expedite_po:SUP_IRON" for an expedite, "transfer_stock" for a lever with no supplier. Throws on malformed params (callers fail closed). */
export function shapeOf(a: Pick<ActionRow, "type" | "params">): string {
  const p = JSON.parse(a.params);
  const supplier = p && typeof p === "object" && typeof p.supplier_id === "string" ? p.supplier_id : null;
  return supplier ? `${a.type}:${supplier}` : a.type;
}
export const trustRows = () => db().prepare("SELECT * FROM trust ORDER BY updated_at DESC, shape").all() as TrustRow[];
export const trustRow = (shape: string) => db().prepare("SELECT * FROM trust WHERE shape=?").get(shape) as TrustRow | undefined;
const parseEvidence = (row: TrustRow): Evidence[] => { try { const v = JSON.parse(row.evidence); return Array.isArray(v) ? v : []; } catch { return []; } };
const update = (shape: string, fields: Record<string, unknown>) => {
  const keys = Object.keys(fields);
  db().prepare(`UPDATE trust SET ${keys.map(k => `${k}=?`).join(", ")}, updated_at=? WHERE shape=?`).run(...keys.map(k => fields[k]), nowIso(), shape);
};

/** The row for a shape, created on first sight with the threshold snapshotted from the Charter. Null (and a ledger error) when the
 *  Charter names no threshold for the action type: such a shape is supervised forever. */
function rowFor(action: ActionRow): TrustRow | null {
  const shape = shapeOf(action);
  const existing = trustRow(shape); if (existing) return existing;
  const threshold = (loadCharter().trust.thresholds as Record<string, number | undefined>)[action.type];
  if (typeof threshold !== "number") {
    log({ role: "trust", kind: "error", refType: "action", refId: action.id, summary: `no trust threshold for ${action.type} in the Charter; ${shape} is not counted (supervised forever)` });
    return null;
  }
  db().prepare("INSERT INTO trust (shape, action_type, threshold, updated_at) VALUES (?,?,?,?)").run(shape, action.type, threshold, nowIso());
  return trustRow(shape)!;
}

export type Outcome = "approved" | "rejected" | "failed";
export interface OutcomeInput { action: ActionRow; outcome: Outcome; approvalId?: string; by?: string; event?: string }
export type OutcomeResult = { shape: string; streak: number; threshold: number; status: TrustRow["status"]; proposal_id?: string; demoted?: boolean } | { skipped: string };

/** Called after every owner decision on a parked action, and on every failure event the Charter says revokes trust. Never throws. */
export function recordOutcome(input: OutcomeInput): OutcomeResult {
  try {
    return recordOutcomeUnsafe(input);
  } catch (e) {
    const msg = (e as Error).message;
    log({ role: "trust", kind: "error", refType: "action", refId: input.action.id, summary: `trust could not record ${input.outcome} for action ${input.action.id}: ${msg.includes("JSON") ? "malformed action params" : msg}` });
    return { skipped: msg.includes("JSON") ? `malformed action params: ${msg}` : msg };
  }
}
function recordOutcomeUnsafe(input: OutcomeInput): OutcomeResult {
  const row = rowFor(input.action);
  if (!row) return { skipped: `no trust threshold for ${input.action.type}` };
  const { shape } = row;
  const done = (): OutcomeResult => { const r = trustRow(shape)!; return { shape, streak: r.streak, threshold: r.threshold, status: r.status }; };

  if (input.outcome === "approved") {
    const ev = parseEvidence(row);
    if (row.status === "autonomous") { update(shape, { total_approved: row.total_approved + 1 }); return done(); }   // parked by a hard constraint after the grant: counts, earns nothing
    const streak = Math.min(row.threshold, row.streak + 1);
    if (streak > row.streak) ev.push({ approval_id: input.approvalId ?? "", action_id: input.action.id, order_id: input.action.order_id, cost_usd: input.action.cost_usd, gate_rule: input.action.gate_rule, ts: nowIso() });
    update(shape, { streak, total_approved: row.total_approved + 1, evidence: JSON.stringify(ev) });
    log({ role: "trust", kind: "observe", refType: "approval", refId: input.approvalId, summary: `trust ${shape}: ${streak}/${row.threshold} clean approvals (${input.by ?? "owner"} approved $${input.action.cost_usd} on ${input.action.order_id})` });
    return done();
  }
  if (input.outcome === "rejected") {
    update(shape, { streak: 0, total_rejected: row.total_rejected + 1, evidence: "[]" });
    log({ role: "trust", kind: "observe", refType: "approval", refId: input.approvalId, summary: `trust ${shape}: streak reset to 0/${row.threshold} (${input.by ?? "owner"} rejected ${input.action.type} on ${input.action.order_id})` });
    return done();
  }
  return done();
}
