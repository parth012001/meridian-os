// Tool registry. Each role may only call the tools its Charter entry lists. Enforced in runRole, not by prompt.
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { db, uid, nowIso } from "./db.js";
import { loadCharter, editablePaths, validateCharterPatch, MAX_RECOVERY_PCT, type ActionType } from "./charter.js";
import { log } from "./ledger.js";
import { getOrder, getCustomer, getSupplier, getSku, posForOrder, openingsForOrder, assessOrder, findAlternatives, poArrival, eventsForOrder, today, addDays, listOpenOrders, expediteEligible, supplierReplyOverride } from "./world.js";
import { proposeAction, spentOnOrder, closedLevers } from "./actions.js";

export interface ToolCtx { role: string; taskId?: string; orderId?: string; runId: string }
export interface ToolDef { description: string; parameters: Record<string, unknown>; run: (args: any, ctx: ToolCtx) => unknown | Promise<unknown> }

const orderParam = { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"], additionalProperties: false };

export const TOOLS: Record<string, ToolDef> = {
  list_open_orders: { description: "All open orders with promise dates.", parameters: { type: "object", properties: {}, additionalProperties: false },
    run: () => listOpenOrders().map(o => ({ id: o.id, project: o.project_name, promise_date: o.promise_date, value: o.order_value })) },

  get_order_context: { description: "Everything about one order: customer, openings, POs with expected arrival, days late, recovery spend so far, consent events.", parameters: orderParam,
    run: ({ order_id }) => {
      const o = getOrder(order_id); if (!o) return { error: "unknown order" };
      const risk = assessOrder(o); const pos = posForOrder(order_id);
      return { order: o, customer: getCustomer(o.customer_id), today: today(), days_late: risk.daysLate, risk_reasons: risk.reasons,
        openings: openingsForOrder(order_id).length, fire_rated_openings: openingsForOrder(order_id).filter(x => x.fire_rated).length,
        pos: pos.map(p => ({ id: p.id, sku: p.sku_id, desc: getSku(p.sku_id).description, qty: p.qty, ship: p.current_ship_date, arrives: poArrival(p), late: poArrival(p) > o.promise_date })),
        late_pos: risk.latePOs.map(p => ({ id: p.id, sku: p.sku_id })),
        recovery_spent_usd: spentOnOrder(order_id), recovery_cap_usd: Math.round(o.order_value * MAX_RECOVERY_PCT),
        consent_events: eventsForOrder(order_id, "customer_consent").map(e => JSON.parse(e.payload)) };
    } },

  find_alternatives: { description: "Enumerate recovery levers for an at-risk order, sorted best-first, with cost, new arrival date, whether it closes the gap, and which Charter constraints it touches. MUST be called before propose_action.", parameters: orderParam,
    run: ({ order_id }) => ({ levers: findAlternatives(order_id) }) },

  query_supplier_eta: { description: "Ask the supplier (simulated channel) for the current ship date of a PO and expedite availability.", parameters: { type: "object", properties: { po_id: { type: "string" } }, required: ["po_id"], additionalProperties: false },
    run: ({ po_id }, ctx) => {
      const po = db().prepare("SELECT * FROM purchase_orders WHERE id=?").get(po_id) as any; if (!po) return { error: "unknown PO" };
      const s = getSupplier(po.supplier_id); const sku = getSku(po.sku_id);
      const eligible = expediteEligible(sku, s);
      log({ role: ctx.role, kind: "message", refType: "po", refId: po_id, summary: `supplier channel: asked ${s.name} for ETA on ${po_id}`, detail: { modality: "supplier_portal" } });
      const note = supplierReplyOverride[po_id] ?? (eligible ? "Fast Track available, fee applies, no change orders after confirmation" : "not eligible for Fast Track");
      return { supplier: s.name, po_id, confirmed_ship_date: po.current_ship_date, expedite_available: eligible, expedite_fee_usd: s.expedite_fee_usd,
        expedite_ship_date: addDays(today(), s.expedite_lead_days), supplier_reply: note };
    } },

  propose_action: { description: "Propose one recovery lever. The gate decides: executes inside authority, parks for owner approval, or denies. Returns the verdict and the Charter rule.",
    parameters: { type: "object", properties: { order_id: { type: "string" }, lever_type: { type: "string", enum: ["transfer_stock", "expedite_po", "partial_ship", "substitute_sku", "change_promise_date"] }, po_id: { type: "string" }, rationale: { type: "string" } }, required: ["order_id", "lever_type", "rationale"], additionalProperties: false },
    run: ({ order_id, lever_type, po_id, rationale }, ctx) => {
      if (!ctx.taskId) return { error: "no task in context" };
      if (ctx.orderId && order_id !== ctx.orderId) return { error: `this task is for ${ctx.orderId}; you may not act on ${order_id}` };   // tool results cannot redirect a task
      return proposeAction(ctx.role, ctx.taskId, order_id, lever_type as ActionType, po_id, rationale);
    } },

  no_action_needed: { description: "Escalate to the owner because NO lever closes the gap. Do not use when a lever closes the gap but needs approval or consent; propose that lever instead and the gate will route it.", parameters: { type: "object", properties: { order_id: { type: "string" }, reason: { type: "string" } }, required: ["order_id", "reason"], additionalProperties: false },
    run: ({ order_id, reason }, ctx) => {
      if (ctx.orderId && order_id !== ctx.orderId) return { error: `this task is for ${ctx.orderId}; you may not escalate ${order_id}` };
      const closed = ctx.taskId ? closedLevers(ctx.taskId) : new Set<string>();
      const closers = findAlternatives(order_id).filter(l => l.closes_gap && !closed.has(l.type));
      if (closers.length) return { error: `refused: ${closers.map(l => `${l.type} ($${l.cost_usd}, requires ${l.requires})`).join("; ")} would close the gap. Propose one of them; approval or consent is the gate's job, not a reason to stop.` };
      if (ctx.taskId) db().prepare("UPDATE tasks SET status='escalated' WHERE id=?").run(ctx.taskId);
      log({ role: ctx.role, kind: "outcome", refType: "task", refId: ctx.taskId, summary: `escalated ${order_id} to owner: ${reason}` });
      return { status: "escalated" };
    } },

  draft_customer_message: { description: "Draft a message to the customer. kind=status_update sends immediately; substitution_request and delay_notice require owner review (C5).",
    parameters: { type: "object", properties: { order_id: { type: "string" }, kind: { type: "string", enum: ["status_update", "substitution_request", "delay_notice"] }, subject: { type: "string" }, body: { type: "string" } }, required: ["order_id", "kind", "subject", "body"], additionalProperties: false },
    run: ({ order_id, kind, subject, body }, ctx) => {
      if (ctx.orderId && order_id !== ctx.orderId) return { error: `this run is for ${ctx.orderId}; you may not write to the customer of ${order_id}` };
      const o = getOrder(order_id); if (!o) return { error: "unknown order" };
      const c = getCustomer(o.customer_id); const role = loadCharter().roles[ctx.role];
      const id = uid("msg");
      const auto = role.authority.send_without_review.includes(kind);
      db().prepare("INSERT INTO messages (id, order_id, task_id, kind, to_contact, subject, body, status, sent_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(id, order_id, ctx.taskId ?? null, kind, c.contact, subject, body, auto ? "sent" : "pending_review", auto ? nowIso() : null);
      log({ role: ctx.role, kind: "message", refType: "message", refId: id, charterRule: auto ? "ROLE.send_without_review" : "C5", summary: `${auto ? "sent" : "drafted for owner review"} ${kind} to ${c.name} re ${order_id}`, detail: { modality: "email", subject } });
      return { message_id: id, status: auto ? "sent" : "pending_review" };
    } },

  read_ledger_stats: { description: "Aggregate outcomes from the ledger by action type: executed, approved, rejected, costs, wait times.", parameters: { type: "object", properties: {}, additionalProperties: false },
    run: () => {
      const rows = db().prepare(`SELECT a.type, a.status, a.cost_usd, ap.status ap_status, ap.created_at ap_created, ap.decided_at
                                  FROM actions a LEFT JOIN approvals ap ON ap.action_id=a.id`).all() as any[];
      const by: Record<string, any> = {};
      for (const r of rows) {
        const b = (by[r.type] ??= { proposed: 0, executed: 0, approved: 0, rejected: 0, denied: 0, approved_costs: [] as number[], waits: [] as number[] });
        b.proposed++; if (r.status === "executed") b.executed++; if (r.status === "denied") b.denied++;
        if (r.ap_status === "approved") { b.approved++; b.approved_costs.push(r.cost_usd); if (r.decided_at) b.waits.push((Date.parse(r.decided_at) - Date.parse(r.ap_created + "Z")) / 60000); }
        if (r.ap_status === "rejected") b.rejected++;
      }
      const waits = Object.values(by).flatMap((b: any) => b.waits);
      return { by_type: by, expeditor_limit: loadCharter().roles.expeditor.authority.spend_usd,
        editable_paths: editablePaths(loadCharter()),
        how_to_propose: "call propose_charter_diff with path + value; prose is not a proposal", avg_approval_wait_min: waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : null,
        recovered_orders: (db().prepare("SELECT COUNT(*) c FROM tasks WHERE outcome='recovered'").get() as any).c };
    } },

  propose_charter_diff: { description: "File a proposed change to ONE Charter value, with evidence. Never applies it; the owner merges or rejects. path is a dot path into org.yaml that must already exist, e.g. roles.expeditor.authority.spend_usd or autonomy_levels.substitute_sku.",
    parameters: { type: "object", properties: { summary: { type: "string" }, evidence: { type: "string" }, path: { type: "string" }, value: { type: ["number", "string"] } }, required: ["summary", "evidence", "path", "value"], additionalProperties: false },
    run: ({ summary, evidence, path, value }, ctx) => {
      const parts = String(path).split(".");
      const charter = loadCharter(); const editable = editablePaths(charter);
      if (!editable.includes(path)) return { error: `path ${path} is not editable; proposals may only change: ${editable.join(", ")}` };
      let cur: any = charter;
      for (const k of parts) { if (cur === null || typeof cur !== "object" || !(k in cur)) return { error: `path ${path} does not exist in the Charter; proposals may only change existing values` }; cur = cur[k]; }
      if (typeof cur === "object") return { error: `path ${path} is not a scalar value` };
      if (typeof cur !== typeof value) return { error: `value must be a ${typeof cur} (current: ${JSON.stringify(cur)})` };
      if (typeof value === "number" && !(Number.isFinite(value) && value >= 0)) return { error: "value must be a finite number >= 0" };
      const patch: any = {}; let node = patch;
      parts.forEach((k, i) => { node[k] = i === parts.length - 1 ? value : {}; node = node[k]; });
      const check = validateCharterPatch(patch);   // same validation the merge runs, so the owner never sees a proposal that cannot merge
      if (!check.ok) return { error: `${JSON.stringify(value)} is not a valid value for ${path}: ${check.error}` };
      const id = uid("prop");
      db().prepare("INSERT INTO charter_proposals (id, proposed_by, summary, evidence, patch) VALUES (?,?,?,?,?)").run(id, ctx.role, summary, evidence, JSON.stringify(patch));
      log({ role: ctx.role, kind: "propose", refType: "charter_proposal", refId: id, summary: `charter diff proposed: ${summary} (${path}: ${JSON.stringify(cur)} -> ${JSON.stringify(value)})`, detail: { evidence, patch } });
      return { proposal_id: id, status: "proposed", current: cur, proposed: value };
    } },
};

export function toolSpecsFor(role: string): ChatCompletionTool[] {
  const allowed = loadCharter().roles[role]?.tools ?? [];
  return allowed.filter(n => TOOLS[n]).map(n => ({ type: "function", function: { name: n, description: TOOLS[n].description, parameters: TOOLS[n].parameters } }));
}
