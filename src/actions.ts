// Proposal -> Gate -> execute | approval | deny. The only write path from an agent into the World.
import { db, uid, nowIso } from "./db.js";
import { loadCharter, type ActionType } from "./charter.js";
import { gate } from "./gate.js";
import { log } from "./ledger.js";
import { assessOrder, findAlternatives, applyLever, getOrder, getSku, eventsForOrder, type Lever } from "./world.js";

export const spentOnOrder = (orderId: string) =>
  (db().prepare("SELECT COALESCE(SUM(cost_usd),0) v FROM actions WHERE order_id=? AND status='executed'").get(orderId) as any).v as number;
/** Lever types the owner already rejected on this task. A rejection is final for the task; enforced here, not by prompt. */
export const rejectedLevers = (taskId: string) =>
  new Set((db().prepare("SELECT DISTINCT type FROM actions WHERE task_id=? AND status='rejected'").all(taskId) as { type: string }[]).map(r => r.type));
/** Lever types closed for this task: rejected by the owner or denied by the gate. Neither can block the last resort or escalation. */
export const closedLevers = (taskId: string) =>
  new Set((db().prepare("SELECT DISTINCT type FROM actions WHERE task_id=? AND status IN ('rejected','denied')").all(taskId) as { type: string }[]).map(r => r.type));

export function proposeAction(role: string, taskId: string, orderId: string, leverType: ActionType, poId: string | undefined, rationale: string) {
  const order = getOrder(orderId); if (!order) return { error: `unknown order ${orderId}` };
  const rejected = rejectedLevers(taskId);
  if (rejected.has(leverType)) {
    log({ role, kind: "error", refType: "task", refId: taskId, summary: `${role} re-proposed ${leverType} on ${orderId} after the owner rejected it; refused by procedure` });
    return { error: `the owner already rejected ${leverType} on this task. Propose a different lever or call no_action_needed.` };
  }
  const levers = findAlternatives(orderId);
  const lever = levers.find(l => l.type === leverType && (!poId || l.po_id === poId)) ?? levers.find(l => l.type === leverType);
  if (!lever) return { error: `lever ${leverType} is not available for ${orderId}; call find_alternatives` };
  if (!lever.closes_gap && lever.type !== "partial_ship") {
    const better = levers.filter(l => l.closes_gap && !rejected.has(l.type)).map(l => `${l.type} ($${l.cost_usd}, requires ${l.requires})`);
    log({ role, kind: "error", refType: "task", refId: taskId, summary: `${role} proposed ${leverType} on ${orderId} but it does not close the gap; refused by procedure`, detail: { lever } });
    return { error: `${leverType} arrives ${lever.new_arrival} which is still after the promise date; it would spend $${lever.cost_usd} without recovering the order. Levers that close the gap: ${better.join("; ") || "none"}. Propose one of those (approval/consent is handled by the gate), or call no_action_needed.` };
  }

  if (leverType === "change_promise_date") {
    // The outcome is "deliver on the promise date". Moving the date is the last resort, never a shortcut a supplier can talk us into.
    const closed = closedLevers(taskId);
    const keepers = levers.filter(l => l.closes_gap && l.type !== "change_promise_date" && !closed.has(l.type));
    if (keepers.length) {
      log({ role, kind: "error", refType: "task", refId: taskId, summary: `${role} proposed change_promise_date on ${orderId} while ${keepers.map(k => k.type).join("/")} would keep the date; refused by procedure` });
      return { error: `Moving the promise date is the last resort. These levers keep the customer's date: ${keepers.map(l => `${l.type} ($${l.cost_usd}, requires ${l.requires})`).join("; ")}. Propose one of them; only propose change_promise_date when none of them exist, or the owner rejected them, or the gate denied them.` };
    }
  }
  const consent = leverType === "substitute_sku" && eventsForOrder(orderId, "customer_consent").some(e => JSON.parse(e.payload).to_sku === (lever.params as any).to_sku);
  const sameFr = leverType === "substitute_sku" ? (getSku((lever.params as any).from_sku).fire_rating ?? null) === (getSku((lever.params as any).to_sku).fire_rating ?? null) : undefined;
  const verdict = gate(loadCharter(), { role, action: { type: leverType, cost_usd: lever.cost_usd, touches: lever.touches },
    order: { id: order.id, order_value: order.order_value, ship_policy: order.ship_policy },
    spentSoFar: spentOnOrder(orderId), customerConsent: consent, sameFireRating: sameFr });

  const id = uid("act");
  db().prepare(`INSERT INTO actions (id, task_id, order_id, role, type, params, cost_usd, days_saved, rationale, gate_verdict, gate_rule, status)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, taskId, orderId, role, leverType, JSON.stringify({ ...lever.params, po_id: lever.po_id, new_arrival: lever.new_arrival }), lever.cost_usd, lever.days_saved, rationale,
         verdict.verdict, verdict.rule, verdict.verdict === "execute" ? "approved" : verdict.verdict === "approve" ? "awaiting_approval" : "denied");
  log({ role, kind: "propose", refType: "action", refId: id, summary: `${role} proposed ${leverType} on ${orderId} ($${lever.cost_usd})`, detail: { lever, rationale } });
  log({ role: "gate", kind: "gate", refType: "action", refId: id, charterRule: verdict.rule, summary: `gate: ${verdict.verdict.toUpperCase()} ${leverType} on ${orderId} [${verdict.rule}] ${verdict.reason}` });

  if (verdict.verdict === "execute") {
    const r = executeAction(id, role);
    return { action_id: id, lever_type: leverType, cost_usd: lever.cost_usd, status: "executed", gate_rule: verdict.rule, gap_closed: r.gapClosed, order_days_late_now: r.daysLate };
  }
  if (verdict.verdict === "approve") {
    const apId = uid("apr");
    const summary = `${role} wants to ${leverType.replace("_", " ")} on ${orderId}: $${lever.cost_usd}, ${lever.note}. Gate: ${verdict.reason}.`;
    db().prepare("INSERT INTO approvals (id, action_id, requested_of, kind, summary) VALUES (?,?,?,?,?)").run(apId, id, loadCharter().escalation.default, verdict.approvalKind ?? leverType, summary);
    db().prepare("UPDATE tasks SET status='awaiting_approval' WHERE id=?").run(taskId);
    log({ role, kind: "propose", refType: "approval", refId: apId, charterRule: verdict.rule, summary: `approval requested of owner: ${summary}` });
    return { action_id: id, approval_id: apId, lever_type: leverType, cost_usd: lever.cost_usd, status: "awaiting_approval", gate_rule: verdict.rule, reason: verdict.reason };
  }
  return { action_id: id, lever_type: leverType, status: "denied", gate_rule: verdict.rule, reason: verdict.reason };
}

/** Executes an approved action against the World. Idempotent on action id. */
export function executeAction(actionId: string, by: string, onBehalfOf?: string) {
  const a = db().prepare("SELECT * FROM actions WHERE id=?").get(actionId) as any;
  if (!a) throw new Error(`no action ${actionId}`);
  if (a.status === "executed") return { already: true, gapClosed: assessOrder(getOrder(a.order_id)!).daysLate === 0, daysLate: 0 };
  const p = JSON.parse(a.params);
  const lever: Lever = { type: a.type, po_id: p.po_id, params: p, cost_usd: a.cost_usd, days_saved: a.days_saved, closes_gap: true, touches: [], requires: "nothing", note: "" };
  applyLever(lever, a.order_id);
  db().prepare("UPDATE actions SET status='executed', executed_at=? WHERE id=?").run(nowIso(), actionId);
  const risk = assessOrder(getOrder(a.order_id)!);
  log({ role: by, onBehalfOf, kind: "execute", refType: "action", refId: actionId, summary: `executed ${a.type} on ${a.order_id} ($${a.cost_usd}); order now ${risk.daysLate ? risk.daysLate + "d late" : "on time"}` });
  if (risk.daysLate === 0) {
    db().prepare("UPDATE tasks SET status='resolved', outcome='recovered', closed_at=? WHERE id=?").run(nowIso(), a.task_id);
    log({ role: by, kind: "outcome", refType: "task", refId: a.task_id, summary: `task ${a.task_id} resolved: ${a.order_id} recovered` });
  } else {
    // approved but the gap is still open: hand the task back to the expeditor instead of leaving it parked
    db().prepare("UPDATE tasks SET status='open' WHERE id=? AND status='awaiting_approval'").run(a.task_id);
  }
  return { gapClosed: risk.daysLate === 0, daysLate: risk.daysLate };
}

export function decideApproval(approvalId: string, decision: "approved" | "rejected", by: string, note?: string) {
  const ap = db().prepare("SELECT * FROM approvals WHERE id=?").get(approvalId) as any;
  if (!ap) throw new Error("no such approval");
  if (ap.status !== "pending") return { already: ap.status };
  db().prepare("UPDATE approvals SET status=?, decided_by=?, decided_at=?, note=? WHERE id=?").run(decision, by, nowIso(), note ?? null, approvalId);
  const a = db().prepare("SELECT * FROM actions WHERE id=?").get(ap.action_id) as any;
  log({ role: by, kind: decision === "approved" ? "approve" : "reject", refType: "approval", refId: approvalId, summary: `${by} ${decision} ${ap.kind} on ${a.order_id}${note ? `: "${note}"` : ""}` });
  if (decision === "approved") {
    db().prepare("UPDATE actions SET status='approved' WHERE id=?").run(a.id);
    return { action: a, executed: ap.kind === "substitution" ? null : executeAction(a.id, "system", by) };
  }
  db().prepare("UPDATE actions SET status='rejected' WHERE id=?").run(a.id);
  db().prepare("UPDATE tasks SET status='open' WHERE id=?").run(a.task_id);
  return { action: a, executed: null };
}
