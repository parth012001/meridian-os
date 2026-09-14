import "./env.js";
// Control plane API. Identity = x-role header (owner | viewer). Agents run server-side under their own role identity.
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import { db } from "./db.js";
import { seed } from "./seed.js";
import { loadCharter, rawCharterText, restoreBaselineCharter } from "./charter.js";
import { mergeProposal, rejectProposal, trustView, parseReplay } from "./trust.js";
import { assessAll, applySupplierSlip, kpis, findAlternatives, clearSupplierReplyOverrides } from "./world.js";
import { runWatcher, workOpenTasks, ownerDecides, customerConsents, runReviewer, runExpeditor, supplierMissesExpedite } from "./roles.js";
import { recentLedger, log } from "./ledger.js";
import { MOCK, MODEL, MODE } from "./llm.js";
import { runTrials, scorecard } from "./trials/run.js";
import { scenarios, seedExpediteOrders } from "./trials/scenarios.js";

export const app = new Hono();
const role = (c: any) => (c.req.header("x-role") ?? "viewer") as string;
const ownerOnly = (c: any) => role(c) === "owner" ? null : c.json({ error: "owner role required (x-role: owner)" }, 403);
let busy = false;
const guard = async (c: any, fn: () => Promise<unknown>) => {
  if (busy) return c.json({ error: "an agent run is already in progress" }, 409);
  busy = true; try { return c.json(await fn()); } catch (e) { return c.json({ error: (e as Error).message }, (e as any).status ?? 500); } finally { busy = false; }
};

if ((db().prepare("SELECT COUNT(*) c FROM orders").get() as any).c === 0) seed();

app.get("/api/state", c => {
  const tasksByOrder: Record<string, any> = {};
  for (const t of db().prepare("SELECT * FROM tasks ORDER BY created_at DESC, rowid DESC").all() as any[]) tasksByOrder[t.order_id] ??= t;   // rowid breaks same-second ties (a reopened task)
  const sinceId = Number(c.req.query("since") ?? 0);
  return c.json({
    mode: MODE, busy, charter: loadCharter(), kpis: kpis(),
    board: assessAll().map(r => ({ ...r.order, days_late: r.daysLate, score: r.score, reasons: r.reasons, task: tasksByOrder[r.order.id] ?? null })),
    approvals: db().prepare("SELECT ap.*, a.type action_type, a.order_id, a.cost_usd, a.rationale, a.gate_rule FROM approvals ap JOIN actions a ON a.id=ap.action_id ORDER BY ap.created_at DESC").all(),
    messages: db().prepare("SELECT * FROM messages ORDER BY created_at DESC, rowid DESC LIMIT 30").all(),
    proposals: (db().prepare("SELECT * FROM charter_proposals ORDER BY created_at DESC, rowid DESC").all() as any[]).map(p => ({ ...p, replay: parseReplay(p.replay) })),
    trust: trustView(),
    runs: db().prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT 20").all(),
    ledger: recentLedger(150, sinceId),
  });
});
app.get("/api/charter/raw", c => c.text(rawCharterText()));
app.get("/api/trust", c => c.json({ thresholds: loadCharter().trust.thresholds, demote_on: loadCharter().trust.demote_on, shapes: trustView() }));
app.get("/api/orders/:id/levers", c => c.json(findAlternatives(c.req.param("id"))));
app.get("/api/ledger", c => c.json(recentLedger(Number(c.req.query("limit") ?? 500))));

// Scenario controls stand in for the outside world (reset, supplier feed, customer inbox). Owner-only, and never while an agent is mid-run.
/** Named starting Worlds. `baseline` is the seed; `earned_autonomy` adds the three Ironline masonry-frame orders the trial uses, so the
 *  owner can click through the whole arc (three approvals -> trust proposal -> merge -> autonomous expedite -> miss -> demotion). */
const WORLDS: Record<string, { note: string; extra: () => void }> = {
  baseline: { note: "", extra: () => {} },
  earned_autonomy: { note: " (earned_autonomy world: +3 Ironline masonry-frame orders ORD-3001..3003, $25k each)", extra: () => { seedExpediteOrders(2); seedExpediteOrders(1, { from: 3, promise: 30 }); } },
};
app.post("/api/reset", async c => {
  const denied = ownerOnly(c); if (denied) return denied;
  const b = await c.req.json().catch(() => ({}));
  const world = WORLDS[b.world ?? "baseline"];
  if (!world) return c.json({ error: `unknown world; one of ${Object.keys(WORLDS).join(", ")}` }, 400);   // fail closed: never seed something unnamed
  return guard(c, async () => { seed(); world.extra(); restoreBaselineCharter(); clearSupplierReplyOverrides(); log({ role: role(c), kind: "observe", summary: `world reset by ${role(c)}${world.note}` }); return { ok: true, world: b.world ?? "baseline" }; });
});
app.post("/api/events/slip", async c => {
  const denied = ownerOnly(c); if (denied) return denied;
  const b = await c.req.json().catch(() => ({}));
  return guard(c, async () => {
    const ids = applySupplierSlip(b.supplier_id ?? "SUP_IRON", b.category ?? "frame", Number(b.days ?? 10), b.note ?? "PO acknowledgement variance");
    log({ role: "world", kind: "observe", summary: `event supplier_ack_slip: ${b.supplier_id ?? "SUP_IRON"} ${b.category ?? "frame"} +${b.days ?? 10}d touched ${ids.join(", ")}` });
    return { touched: ids };
  });
});
app.post("/api/events/expedite-miss", async c => {
  const denied = ownerOnly(c); if (denied) return denied;
  const b = await c.req.json().catch(() => ({}));
  if (typeof b.po_id !== "string" || !b.po_id) return c.json({ error: "po_id required" }, 400);
  return guard(c, async () => { const r = supplierMissesExpedite(b.po_id); if ("error" in r) throw Object.assign(new Error(r.error), { status: 400 }); return r; });
});
app.post("/api/watch", c => guard(c, async () => runWatcher()));
app.post("/api/work", c => guard(c, () => workOpenTasks()));
app.post("/api/tasks/:id/work", c => guard(c, () => runExpeditor(c.req.param("id"))));
app.post("/api/approvals/:id", async c => {
  const denied = ownerOnly(c); if (denied) return denied;
  const b = await c.req.json().catch(() => ({}));
  if (b.decision !== "approved" && b.decision !== "rejected") return c.json({ error: "decision must be 'approved' or 'rejected'" }, 400);   // fail closed: never infer approval
  return guard(c, () => ownerDecides(c.req.param("id"), b.decision, b.note));
});
app.post("/api/customer/consent", async c => {
  const denied = ownerOnly(c); if (denied) return denied;
  const b = await c.req.json().catch(() => ({}));
  return guard(c, () => customerConsents(b.order_id));
});
app.post("/api/review", c => guard(c, () => runReviewer()));
app.post("/api/proposals/:id", async c => {
  const denied = ownerOnly(c); if (denied) return denied;
  if (busy) return c.json({ error: "an agent run is already in progress" }, 409);   // never change the Charter under a running desk or trial
  const b = await c.req.json().catch(() => ({}));
  try { return c.json(b.decision === "merge" ? mergeProposal(c.req.param("id"), "owner") : rejectProposal(c.req.param("id"), "owner")); }   // a failed merge leaves the proposal 'proposed'
  catch (e) { return c.json({ error: (e as Error).message }, (e as any).status ?? 500); }
});

app.get("/api/trials", c => c.json({ scenarios: scenarios.map(s => ({ id: s.id, title: s.title, why: s.why, checks: s.checks.length })), scorecard: scorecard(),
  recent: db().prepare("SELECT id, scenario, rep, mode, passed, checks, summary, tokens_in, tokens_out, runs, duration_ms, started_at FROM trials ORDER BY started_at DESC LIMIT 8").all().map((r: any) => ({ ...r, checks: JSON.parse(r.checks) })) }));
const MAX_TRIAL_REPS = 5;   // a batch holds `busy` for its whole duration (minutes per rep in live mode)
app.post("/api/trials/run", async c => {
  const denied = ownerOnly(c); if (denied) return denied;
  const b = await c.req.json().catch(() => ({}));
  const n = b.n ?? 1;
  if (!Number.isInteger(n) || n < 1 || n > MAX_TRIAL_REPS) return c.json({ error: `n must be an integer from 1 to ${MAX_TRIAL_REPS}` }, 400);
  if (b.only !== undefined && !scenarios.some(s => s.id === b.only)) return c.json({ error: `unknown scenario; one of ${scenarios.map(s => s.id).join(", ")}` }, 400);
  return guard(c, async () => {
    try { const rows = await runTrials({ n, only: b.only ? [b.only] : [] }); return rows.map(r => ({ id: r.id, scenario: r.scenario, passed: r.passed, summary: r.summary })); }
    finally { restoreBaselineCharter(); clearSupplierReplyOverrides(); }   // the demo World is whatever the last scenario left; the Charter and channels are clean
  });
});

if (existsSync("web/dist")) { app.use("/*", serveStatic({ root: "./web/dist" })); app.get("*", serveStatic({ path: "./web/dist/index.html" })); }
if (process.argv[1] && /server\.(ts|js)$/.test(process.argv[1])) {
  const port = Number(process.env.PORT ?? 3000);
  serve({ fetch: app.fetch, port }, () => console.log(`Meridian OS on http://localhost:${port}  mode=${MOCK ? "mock" : MODEL}`));
}
