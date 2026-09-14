import "./env.js";
// Control plane API. Identity = x-role header (owner | viewer). Agents run server-side under their own role identity.
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import { db } from "./db.js";
import { seed } from "./seed.js";
import { loadCharter, rawCharterText, applyCharterPatch, restoreBaselineCharter } from "./charter.js";
import { assessAll, applySupplierSlip, kpis, findAlternatives } from "./world.js";
import { runWatcher, workOpenTasks, ownerDecides, customerConsents, runReviewer, runExpeditor } from "./roles.js";
import { recentLedger, log } from "./ledger.js";
import { MOCK, MODEL } from "./llm.js";

const app = new Hono();
const role = (c: any) => (c.req.header("x-role") ?? "viewer") as string;
const ownerOnly = (c: any) => role(c) === "owner" ? null : c.json({ error: "owner role required (x-role: owner)" }, 403);
let busy = false;
const guard = async (c: any, fn: () => Promise<unknown>) => {
  if (busy) return c.json({ error: "an agent run is already in progress" }, 409);
  busy = true; try { return c.json(await fn()); } catch (e) { return c.json({ error: (e as Error).message }, 500); } finally { busy = false; }
};

if (!existsSync(process.env.DB_PATH ?? "") ) { try { db().prepare("SELECT 1 FROM orders LIMIT 1").get(); } catch { seed(); } }
if ((db().prepare("SELECT COUNT(*) c FROM orders").get() as any).c === 0) seed();

app.get("/api/state", c => {
  const tasksByOrder: Record<string, any> = {};
  for (const t of db().prepare("SELECT * FROM tasks ORDER BY created_at DESC").all() as any[]) tasksByOrder[t.order_id] ??= t;
  const sinceId = Number(c.req.query("since") ?? 0);
  return c.json({
    mode: MOCK ? "mock" : `live:${MODEL}`, busy, charter: loadCharter(), kpis: kpis(),
    board: assessAll().map(r => ({ ...r.order, days_late: r.daysLate, score: r.score, reasons: r.reasons, task: tasksByOrder[r.order.id] ?? null })),
    approvals: db().prepare("SELECT ap.*, a.type action_type, a.order_id, a.cost_usd, a.rationale, a.gate_rule FROM approvals ap JOIN actions a ON a.id=ap.action_id ORDER BY ap.created_at DESC").all(),
    messages: db().prepare("SELECT * FROM messages ORDER BY created_at DESC LIMIT 30").all(),
    proposals: db().prepare("SELECT * FROM charter_proposals ORDER BY created_at DESC").all(),
    runs: db().prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT 20").all(),
    ledger: recentLedger(150, sinceId),
  });
});
app.get("/api/charter/raw", c => c.text(rawCharterText()));
app.get("/api/orders/:id/levers", c => c.json(findAlternatives(c.req.param("id"))));
app.get("/api/ledger", c => c.json(recentLedger(Number(c.req.query("limit") ?? 500))));

app.post("/api/reset", c => { seed(); restoreBaselineCharter(); log({ role: role(c), kind: "observe", summary: "world reset by " + role(c) }); return c.json({ ok: true }); });
app.post("/api/events/slip", async c => {
  const b = await c.req.json().catch(() => ({}));
  const ids = applySupplierSlip(b.supplier_id ?? "SUP_IRON", b.category ?? "frame", Number(b.days ?? 10), b.note ?? "PO acknowledgement variance");
  log({ role: "world", kind: "observe", summary: `event supplier_ack_slip: ${b.supplier_id ?? "SUP_IRON"} ${b.category ?? "frame"} +${b.days ?? 10}d touched ${ids.join(", ")}` });
  return c.json({ touched: ids });
});
app.post("/api/watch", c => c.json(runWatcher()));
app.post("/api/work", c => guard(c, () => workOpenTasks()));
app.post("/api/tasks/:id/work", c => guard(c, () => runExpeditor(c.req.param("id"))));
app.post("/api/approvals/:id", async c => {
  const denied = ownerOnly(c); if (denied) return denied;
  const b = await c.req.json().catch(() => ({}));
  return guard(c, () => ownerDecides(c.req.param("id"), b.decision === "rejected" ? "rejected" : "approved", b.note));
});
app.post("/api/customer/consent", async c => { const b = await c.req.json().catch(() => ({})); return guard(c, () => customerConsents(b.order_id)); });
app.post("/api/review", c => guard(c, () => runReviewer()));
app.post("/api/proposals/:id", async c => {
  const denied = ownerOnly(c); if (denied) return denied;
  const b = await c.req.json().catch(() => ({}));
  const p = db().prepare("SELECT * FROM charter_proposals WHERE id=?").get(c.req.param("id")) as any;
  if (!p || p.status !== "proposed") return c.json({ error: "not a pending proposal" }, 400);
  if (b.decision === "merge") {
    const ch = applyCharterPatch(JSON.parse(p.patch));
    db().prepare("UPDATE charter_proposals SET status='merged', decided_by='owner', decided_at=datetime('now') WHERE id=?").run(p.id);
    log({ role: "owner", kind: "charter_change", refType: "charter_proposal", refId: p.id, summary: `Charter v${ch.version}: ${p.summary}`, detail: JSON.parse(p.patch) });
    return c.json({ merged: true, version: ch.version });
  }
  db().prepare("UPDATE charter_proposals SET status='rejected', decided_by='owner', decided_at=datetime('now') WHERE id=?").run(p.id);
  log({ role: "owner", kind: "reject", refType: "charter_proposal", refId: p.id, summary: `rejected charter proposal: ${p.summary}` });
  return c.json({ merged: false });
});

if (existsSync("web/dist")) { app.use("/*", serveStatic({ root: "./web/dist" })); app.get("*", serveStatic({ path: "./web/dist/index.html" })); }
const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, () => console.log(`Meridian OS on http://localhost:${port}  mode=${MOCK ? "mock" : MODEL}`));
