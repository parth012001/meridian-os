// The trust engine. Trust is earned per action SHAPE (action type, per supplier where the action names one), never per agent.
// Every shape starts supervised. Consecutive clean owner approvals build a streak toward the Charter threshold; a rejection resets
// it. At threshold the engine files a Charter proposal with a replay of what the change would have done to past approvals.
// Only the owner merges. A failure named in the Charter's demote_on revokes autonomy with a Charter patch that only tightens.
// Every row here is a materialized view of the ledger: evidence and grants point back at approvals, proposals and ledger rows.
import { db, uid, nowIso } from "./db.js";
import { loadCharter, previewCharterPatch, validateCharterPatch, applyCharterPatch, type Charter } from "./charter.js";
import { gate, type GateInput } from "./gate.js";
import { log } from "./ledger.js";
import { getSku, eventsForOrder } from "./world.js";

export interface ActionRow { id: string; type: string; params: string; order_id: string; cost_usd: number; gate_rule: string | null; role: string }
export interface TrustRow {
  shape: string; action_type: string; streak: number; threshold: number;
  total_approved: number; total_rejected: number; total_failed: number; total_autonomous: number;
  status: "supervised" | "proposed" | "autonomous" | "demoted"; evidence: string; grant: string | null; updated_at: string;
}
export interface Evidence { approval_id: string; action_id: string; order_id: string; cost_usd: number; gate_rule: string | null; ts: string }
export interface Grant { path: string; before: unknown; after: unknown; proposal_id: string; charter_version: number; granted_at: string }

/** "expedite_po:SUP_IRON" for an expedite, "transfer_stock" for a lever with no supplier. Throws on malformed params (callers fail closed). */
export function shapeOf(a: Pick<ActionRow, "type" | "params">): string {
  const p = JSON.parse(a.params);
  const supplier = p && typeof p === "object" && typeof p.supplier_id === "string" ? p.supplier_id : null;
  return supplier ? `${a.type}:${supplier}` : a.type;
}
export const trustRows = () => db().prepare("SELECT * FROM trust ORDER BY updated_at DESC, shape").all() as TrustRow[];
export const trustRow = (shape: string) => db().prepare("SELECT * FROM trust WHERE shape=?").get(shape) as TrustRow | undefined;
const parseEvidence = (row: TrustRow): Evidence[] => { try { const v = JSON.parse(row.evidence); return Array.isArray(v) ? v : []; } catch { return []; } };
const parseGrant = (row: TrustRow): Grant | null => { try { const g = row.grant ? JSON.parse(row.grant) : null; return g && typeof g.path === "string" ? g : null; } catch { return null; } };
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
export type OutcomeResult = { shape: string; streak: number; threshold: number; status: TrustRow["status"]; proposal_id?: string; demoted?: boolean; charter_version?: number } | { skipped: string };

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
    const proposalId = maybePropose(shape);
    return { ...done(), ...(proposalId ? { proposal_id: proposalId } : {}) };
  }
  if (input.outcome === "rejected") {
    update(shape, { streak: 0, total_rejected: row.total_rejected + 1, evidence: "[]", status: row.status === "proposed" ? "supervised" : row.status });
    log({ role: "trust", kind: "observe", refType: "approval", refId: input.approvalId, summary: `trust ${shape}: streak reset to 0/${row.threshold} (${input.by ?? "owner"} rejected ${input.action.type} on ${input.action.order_id})` });
    if (row.status === "proposed") staleProposals(shape, `the owner rejected ${input.action.type} on ${input.action.order_id} while the proposal was pending`);
    return done();
  }
  return done();
}

/** A pending proposal's evidence no longer holds (a rejection or a failure landed while it waited). It goes stale, never merged. */
function staleProposals(shape: string, why: string) {
  const rows = db().prepare("SELECT id FROM charter_proposals WHERE shape=? AND status='proposed'").all(shape) as { id: string }[];
  for (const r of rows) {
    db().prepare("UPDATE charter_proposals SET status='stale', decided_by='trust', decided_at=datetime('now') WHERE id=?").run(r.id);
    log({ role: "trust", kind: "reject", refType: "charter_proposal", refId: r.id, charterRule: "TRUST.stale", summary: `proposal ${r.id} for ${shape} is stale: ${why}` });
  }
}

// ── Proposal = Charter diff + replay ─────────────────────────────────────────
export const REPLAY_WINDOW = 50;
export interface ReplayRow { action_id: string; approval_id: string; order_id: string; type: string; cost_usd: number; decision: "approved" | "rejected"; before_verdict: string; before_rule: string; after_verdict: string; after_rule: string; flips: boolean }
export interface Replay {
  path: string; before: unknown; after: unknown; window: number; evaluated: number; skipped: number;
  would_have_auto_executed: number; total_usd: number; still_parked: number; rejected_would_have_executed: number; any_rejected: boolean;
  rows: ReplayRow[]; computed_at: string;
  streak?: { shape: string; streak: number; threshold: number; evidence: Evidence[] };
}
/** The single dot path a one-value patch changes, e.g. roles.expeditor.authority.spend_usd. */
export function pathOf(patch: Record<string, unknown>): { path: string; value: unknown } | null {
  const parts: string[] = []; let node: any = patch;
  while (node && typeof node === "object" && !Array.isArray(node)) {
    const keys = Object.keys(node); if (keys.length !== 1) return null;
    parts.push(keys[0]); node = node[keys[0]];
  }
  return parts.length ? { path: parts.join("."), value: node } : null;
}
export function valueAt(c: Charter, path: string): unknown {
  let cur: any = c; for (const k of path.split(".")) { if (cur === null || typeof cur !== "object" || !(k in cur)) return undefined; cur = cur[k]; } return cur;
}
const patchFor = (path: string, value: unknown) => { const patch: any = {}; let node = patch; const parts = path.split("."); parts.forEach((k, i) => { node[k] = i === parts.length - 1 ? value : {}; node = node[k]; }); return patch as Record<string, unknown>; };

/** Terraform plan for authority: every parked action the owner decided, re-run through the same gate under the current Charter and
 *  under the patched one. Nothing is inferred from the stored verdict; the gate is pure, so the replay is the truth. Null on a
 *  patch that does not parse (fail closed: no replay, no proposal). */
export function buildReplay(patch: Record<string, unknown>): Replay | null {
  const target = pathOf(patch); if (!target) return null;
  const current = loadCharter(); const next = previewCharterPatch(patch); if (!next) return null;
  const rows = db().prepare(`SELECT a.rowid rid, a.*, ap.id approval_id, ap.status decision, o.order_value, o.ship_policy FROM actions a
                             JOIN approvals ap ON ap.action_id=a.id JOIN orders o ON o.id=a.order_id
                             WHERE a.gate_verdict='approve' AND ap.status IN ('approved','rejected') ORDER BY a.rowid DESC LIMIT ?`).all(REPLAY_WINDOW) as any[];
  const r: Replay = { path: target.path, before: valueAt(current, target.path), after: target.value, window: REPLAY_WINDOW, evaluated: 0, skipped: 0,
    would_have_auto_executed: 0, total_usd: 0, still_parked: 0, rejected_would_have_executed: 0, any_rejected: false, rows: [], computed_at: nowIso() };
  for (const a of rows) {
    try {
      const p = JSON.parse(a.params);
      const spentSoFar = (db().prepare("SELECT COALESCE(SUM(cost_usd),0) v FROM actions WHERE order_id=? AND status='executed' AND rowid<?").get(a.order_id, a.rid) as any).v;
      const input: GateInput = { role: a.role, action: { type: a.type, cost_usd: a.cost_usd }, order: { id: a.order_id, order_value: a.order_value, ship_policy: a.ship_policy }, spentSoFar };
      if (a.type === "substitute_sku") {
        input.customerConsent = eventsForOrder(a.order_id, "customer_consent").some(e => JSON.parse(e.payload).to_sku === p.to_sku);
        input.sameFireRating = (getSku(p.from_sku)?.fire_rating ?? null) === (getSku(p.to_sku)?.fire_rating ?? null);
      }
      const was = gate(current, input); const would = gate(next, input);
      const flips = was.verdict === "approve" && would.verdict === "execute";
      r.evaluated++;
      if (flips && a.decision === "approved") { r.would_have_auto_executed++; r.total_usd += a.cost_usd; }
      if (flips && a.decision === "rejected") { r.rejected_would_have_executed++; r.any_rejected = true; }
      if (!flips && would.verdict === "approve") r.still_parked++;
      r.rows.push({ action_id: a.id, approval_id: a.approval_id, order_id: a.order_id, type: a.type, cost_usd: a.cost_usd, decision: a.decision, before_verdict: was.verdict, before_rule: was.rule, after_verdict: would.verdict, after_rule: would.rule, flips });
    } catch { r.skipped++; }
  }
  return r;
}
const stillParkedUnder = (r: Replay) => [...new Set(r.rows.filter(x => !x.flips && x.after_verdict === "approve").map(x => x.after_rule))].join("/");
export const replayLine = (r: Replay) => {
  const n = r.rows.filter(x => x.decision === "approved" && x.before_verdict === "approve").length;   // approvals the current Charter would still ask for
  const base = `Under this change, ${r.would_have_auto_executed} of ${n} past approval(s) ($${r.total_usd.toLocaleString("en-US")}) would have executed without you`;
  const parked = r.still_parked ? `; ${r.still_parked} would still park under ${stillParkedUnder(r)}` : "";
  const rej = r.rejected_would_have_executed ? `; ${r.rejected_would_have_executed} you REJECTED would have executed too` : "";
  return `${base}${parked}${rej}.`;
};

/** The one filing path for Charter proposals, whoever proposes (reviewer tool or trust engine). Validates the patch the way the
 *  merge does, refuses a second pending proposal on the same path, attaches the replay, logs. Never applies anything. */
export type Filed = { error: string } | { proposal_id: string; status: "proposed"; current: unknown; proposed: unknown; replay: string | null };
export function fileProposal(input: { by: string; summary: string; evidence: string; patch: Record<string, unknown>; shape?: string; replay?: Replay | null }): Filed {
  const target = pathOf(input.patch); if (!target) return { error: "a proposal changes exactly one Charter value" };
  const check = validateCharterPatch(input.patch);
  if (!check.ok) return { error: `${JSON.stringify(target.value)} is not a valid value for ${target.path}: ${check.error}` };
  const dup = (db().prepare("SELECT id, patch FROM charter_proposals WHERE status='proposed'").all() as any[]).find(p => { try { return pathOf(JSON.parse(p.patch))?.path === target.path; } catch { return false; } });
  if (dup) return { error: `a proposal for ${target.path} is already awaiting the owner (${dup.id}); explain it or wait for the owner's decision, do not file another` };
  const replay = input.replay === undefined ? buildReplay(input.patch) : input.replay;
  const current = valueAt(loadCharter(), target.path);
  const id = uid("prop");
  db().prepare("INSERT INTO charter_proposals (id, proposed_by, summary, evidence, patch, shape, replay) VALUES (?,?,?,?,?,?,?)")
    .run(id, input.by, input.summary, input.evidence, JSON.stringify(input.patch), input.shape ?? null, replay ? JSON.stringify(replay) : null);
  log({ role: input.by, kind: "propose", refType: "charter_proposal", refId: id, charterRule: input.shape ? "TRUST.threshold" : undefined,
    summary: `charter diff proposed: ${input.summary} (${target.path}: ${JSON.stringify(current)} -> ${JSON.stringify(target.value)})${replay ? ` | ${replayLine(replay)}` : ""}`, detail: { evidence: input.evidence, patch: input.patch, shape: input.shape, replay } });
  return { proposal_id: id, status: "proposed" as const, current, proposed: target.value, replay: replay ? replayLine(replay) : null };
}

/** The streak reached its threshold: work out which editable Charter value would have released these approvals, replay it, and file
 *  if it would have changed anything. Hard constraints (C1, C2, C4) have no editable value, so a streak parked under them earns a
 *  ledger line, not a proposal. Returns the proposal id when one was filed. */
function maybePropose(shape: string): string | undefined {
  const row = trustRow(shape); if (!row || (row.status !== "supervised" && row.status !== "demoted") || row.streak < row.threshold) return undefined;
  const ev = parseEvidence(row); const rules = new Set(ev.map(e => e.gate_rule));
  const charter = loadCharter();
  const role = (db().prepare("SELECT role FROM actions WHERE id=?").get(ev[ev.length - 1]?.action_id ?? "") as any)?.role ?? "expeditor";
  const skip = (why: string) => { log({ role: "trust", kind: "observe", refType: "trust", refId: shape, summary: `trust ${shape} reached ${row.streak}/${row.threshold} but no proposal was filed: ${why}` }); return undefined; };
  let path: string, value: unknown;
  if ([...rules].every(r => r === "ROLE.spend_usd" || r === "C4")) {
    path = `roles.${role}.authority.spend_usd`;
    const limit = charter.roles[role]?.authority.spend_usd ?? 0; const max = Math.max(...ev.map(e => e.cost_usd));
    if (!(max > limit)) return skip(`every approval was parked under C4 (the 2% per-order cap), which no Charter value can raise`);
    value = max;
  } else if ([...rules].every(r => r === "AUTONOMY.recommend")) {
    path = `autonomy_levels.${row.action_type}`; value = "act";
  } else return skip(`parked under ${[...rules].join("/")}, hard constraints with no editable Charter value`);
  const patch = patchFor(path, value);
  const replay = buildReplay(patch); if (!replay) return skip(`patch ${path}=${JSON.stringify(value)} does not produce a valid Charter`);
  if (replay.would_have_auto_executed === 0) return skip(`${path}=${JSON.stringify(value)} would have released none of them (${replay.still_parked} still park under ${stillParkedUnder(replay)})`);
  replay.streak = { shape, streak: row.streak, threshold: row.threshold, evidence: ev };
  const before = valueAt(charter, path);
  const summary = `Trust: ${path.endsWith("spend_usd") ? `raise ${role} spend limit $${before} -> $${value}` : `${row.action_type} from ${before} to ${value}`} (${shape}, ${row.streak}/${row.threshold} clean approvals)`;
  const evidence = `${row.streak} consecutive owner approvals of ${shape} with none rejected: ${ev.map(e => `${e.approval_id} (${e.order_id}, $${e.cost_usd})`).join(", ")}. ${replayLine(replay)}`;
  const filed = fileProposal({ by: "trust", summary, evidence, patch, shape, replay });
  if ("error" in filed) return skip(filed.error);
  update(shape, { status: "proposed" });
  return filed.proposal_id;
}

// ── The owner's decision on a proposal ───────────────────────────────────────
const bad = (msg: string) => Object.assign(new Error(msg), { status: 400 });
/** Merge = apply exactly the patch that was reviewed. The only Charter write besides demotion, and it is the owner's. A trust-filed
 *  proposal also grants the shape autonomy and records what the grant replaced, so a demotion can put it back. */
export function mergeProposal(id: string, by = "owner") {
  const p = db().prepare("SELECT * FROM charter_proposals WHERE id=?").get(id) as any;
  if (!p || p.status !== "proposed") throw bad("not a pending proposal");
  const patch = JSON.parse(p.patch); const target = pathOf(patch);
  const before = target ? valueAt(loadCharter(), target.path) : undefined;
  let ch: Charter;
  try { ch = applyCharterPatch(patch); } catch (e) { throw bad(`patch no longer applies to the current Charter: ${(e as Error).message}`); }
  db().prepare("UPDATE charter_proposals SET status='merged', decided_by=?, decided_at=datetime('now') WHERE id=?").run(by, id);
  log({ role: by, kind: "charter_change", refType: "charter_proposal", refId: id, summary: `Charter v${ch.version}: ${p.summary}`, detail: patch });
  if (p.shape && target) {
    if (trustRow(p.shape)) {
      const grant: Grant = { path: target.path, before, after: target.value, proposal_id: id, charter_version: ch.version, granted_at: nowIso() };
      update(p.shape, { status: "autonomous", grant: JSON.stringify(grant) });
      log({ role: "trust", kind: "outcome", refType: "trust", refId: p.shape, summary: `trust ${p.shape}: autonomous (owner merged ${id}; ${target.path} ${JSON.stringify(before)} -> ${JSON.stringify(target.value)}, Charter v${ch.version})` });
    } else log({ role: "trust", kind: "error", refType: "charter_proposal", refId: id, summary: `merged ${id} names shape ${p.shape} which has no trust row; Charter changed, no autonomy recorded` });
  }
  return { merged: true as const, version: ch.version, shape: p.shape ?? undefined };
}
/** Reject = "not yet". A trust-filed shape re-earns the whole streak; there is no fast lane back. */
export function rejectProposal(id: string, by = "owner") {
  const p = db().prepare("SELECT * FROM charter_proposals WHERE id=?").get(id) as any;
  if (!p || p.status !== "proposed") throw bad("not a pending proposal");
  db().prepare("UPDATE charter_proposals SET status='rejected', decided_by=?, decided_at=datetime('now') WHERE id=?").run(by, id);
  log({ role: by, kind: "reject", refType: "charter_proposal", refId: id, summary: `rejected charter proposal: ${p.summary}` });
  if (p.shape && trustRow(p.shape)) {
    update(p.shape, { status: "supervised", streak: 0, evidence: "[]", grant: null });
    log({ role: "trust", kind: "observe", refType: "trust", refId: p.shape, summary: `trust ${p.shape}: proposal rejected by ${by}; streak reset to 0, starts over` });
  }
  return { merged: false as const, shape: p.shape ?? undefined };
}
/** Trust rows with evidence and grant parsed, for the API and the reviewer. */
export const trustView = () => trustRows().map(r => ({ ...r, evidence: parseEvidence(r), grant: parseGrant(r) }));
export const parseReplay = (s: string | null): Replay | null => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
