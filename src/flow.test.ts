// End-to-end flow tests against a throwaway World and Charter, in mock mode. These pin the state machine:
// what the watcher counts as active, what an approval does when the gap stays open, what may be re-proposed, and what the API refuses.
import { vi, describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, copyFileSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = vi.hoisted(() => {
  const { mkdtempSync, copyFileSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const d = mkdtempSync(join(tmpdir(), "meridian-test-"));
  copyFileSync(join(__dirname, "..", "data", "org.baseline.yaml"), join(d, "org.yaml"));
  process.env.DB_PATH = join(d, "world.db"); process.env.CHARTER_PATH = join(d, "org.yaml");
  process.env.MOCK_LLM = "1"; process.env.OPENAI_API_KEY = ""; process.env.PORT = "0";
  return d;
});

import { db } from "./db.js";
import { seed } from "./seed.js";
import { loadCharter, restoreBaselineCharter } from "./charter.js";
import { applySupplierSlip, findAlternatives, assessOrder, getOrder, poArrival, posForOrder } from "./world.js";
import { runWatcher, workOpenTasks, ownerDecides, customerConsents, runExpeditor } from "./roles.js";
import { proposeAction, rejectedLevers } from "./actions.js";
import { TOOLS } from "./tools.js";
import { app } from "./server.js";

const q = <T = any>(sql: string, ...args: unknown[]) => db().prepare(sql).all(...args) as T[];
const one = <T = any>(sql: string, ...args: unknown[]) => db().prepare(sql).get(...args) as T;
const pending = () => q("SELECT ap.*, a.type action_type, a.order_id FROM approvals ap JOIN actions a ON a.id=ap.action_id WHERE ap.status='pending'");
const taskFor = (orderId: string) => one("SELECT * FROM tasks WHERE order_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1", orderId);
const slipFrames = () => applySupplierSlip("SUP_IRON", "frame", 10, "test");
const post = (path: string, body: unknown = {}, role?: string) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json", ...(role ? { "x-role": role } : {}) }, body: JSON.stringify(body) });

beforeEach(() => { seed(); restoreBaselineCharter(); });

describe("watcher", () => {
  it("does not open a second task for an order that is waiting on the customer", async () => {
    slipFrames(); runWatcher(); await workOpenTasks();
    const ap = pending().find(a => a.kind === "substitution")!;
    expect(await ownerDecides(ap.id, "approved")).toEqual({ awaiting: "customer_consent" });
    expect(taskFor("ORD-1043").status).toBe("awaiting_customer");
    const before = q("SELECT id FROM tasks WHERE order_id='ORD-1043'").length;
    runWatcher(); await workOpenTasks();
    expect(q("SELECT id FROM tasks WHERE order_id='ORD-1043'").length).toBe(before);
    expect(q("SELECT * FROM approvals WHERE kind='substitution'").length).toBe(1);
  });
});

describe("levers", () => {
  it("change_promise_date proposes the latest late arrival, so approving it closes the gap", () => {
    slipFrames(); applySupplierSlip("SUP_IRON", "door", 30, "test");
    const late = assessOrder(getOrder("ORD-1042")!).latePOs; expect(late.length).toBe(2);
    const lever = findAlternatives("ORD-1042").find(l => l.type === "change_promise_date")!;
    expect(lever.params.new_promise_date).toBe(late.map(poArrival).sort().at(-1));
  });
  it("never offers an expedite the supplier will not honour (fire-rated wood doors at Oakridge)", () => {
    applySupplierSlip("SUP_OAK", "door", 10, "test");
    const po = posForOrder("ORD-1038").find(p => p.sku_id === "WD-3070-BIRCH-20")!;
    expect(poArrival(po) > getOrder("ORD-1038")!.promise_date).toBe(true);
    expect(findAlternatives("ORD-1038").some(l => l.type === "expedite_po" && l.po_id === po.id)).toBe(false);
    expect((TOOLS.query_supplier_eta.run({ po_id: po.id }, { role: "expeditor", runId: "r" }) as any).expedite_available).toBe(false);
  });
});

describe("approvals", () => {
  it("an approved action that does not close the gap hands the task back to the expeditor", async () => {
    slipFrames(); applySupplierSlip("SUP_IRON", "door", 30, "test"); runWatcher(); await workOpenTasks();
    const first = pending().find(a => a.order_id === "ORD-1042")!; expect(first.action_type).toBe("expedite_po");
    const r = await ownerDecides(first.id, "approved") as any;
    expect(r.executed.gapClosed).toBe(false); expect(r.rerun).toBe(true);
    // the re-run proposed the expedite for the second late PO; a new approval is waiting, nothing is orphaned
    const second = pending().find(a => a.order_id === "ORD-1042")!;
    expect(second).toBeDefined(); expect(second.id).not.toBe(first.id);
    expect(taskFor("ORD-1042").status).toBe("awaiting_approval");
    expect((await ownerDecides(second.id, "approved") as any).executed.gapClosed).toBe(true);
    expect(taskFor("ORD-1042")).toMatchObject({ status: "resolved", outcome: "recovered" });
    // invariant: a task is never parked in awaiting_approval without a pending approval
    const parked = q("SELECT t.id FROM tasks t WHERE t.status='awaiting_approval' AND NOT EXISTS (SELECT 1 FROM approvals ap JOIN actions a ON a.id=ap.action_id WHERE a.task_id=t.id AND ap.status='pending')");
    expect(parked).toEqual([]);
  });
  it("a rejected lever cannot be proposed again on the same task", async () => {
    slipFrames(); runWatcher(); await workOpenTasks();
    const ap = pending().find(a => a.order_id === "ORD-1042")!; expect(ap.action_type).toBe("expedite_po");
    await ownerDecides(ap.id, "rejected", "too expensive");
    const t = taskFor("ORD-1042");
    expect(rejectedLevers(t.id).has("expedite_po")).toBe(true);
    // the re-run picked a different lever; the rejected one was not re-filed
    const kinds = pending().filter(a => a.order_id === "ORD-1042").map(a => a.action_type);
    expect(kinds).toEqual(["change_promise_date"]);   // the only closer left once the date-keeping lever was rejected, parked under C1
    expect(one("SELECT gate_rule FROM actions WHERE order_id='ORD-1042' AND type='change_promise_date'").gate_rule).toBe("C1");
    const r = proposeAction("expeditor", t.id, "ORD-1042", "expedite_po", undefined, "try again") as any;
    expect(r.error).toMatch(/already rejected/);
    expect(q("SELECT * FROM actions WHERE task_id=? AND type='expedite_po'", t.id).length).toBe(1);
    // and no_action_needed no longer counts the rejected lever as a closer
    const n = TOOLS.no_action_needed.run({ order_id: "ORD-1042", reason: "owner declined" }, { role: "expeditor", taskId: t.id, runId: "r" }) as any;
    expect(n.error ?? "").not.toMatch(/expedite_po/);
  });
  it("the expeditor refuses to re-run a resolved task, and consent is refused when nothing is awaiting it", async () => {
    slipFrames(); runWatcher(); await workOpenTasks();
    const t = taskFor("ORD-1041"); expect(t.status).toBe("resolved");
    await expect(runExpeditor(t.id)).rejects.toThrow(/resolved/);
    expect(await customerConsents("ORD-1043")).toMatchObject({ error: expect.stringMatching(/awaiting customer consent/) });
    const ap = pending().find(a => a.kind === "substitution")!;
    await ownerDecides(ap.id, "approved");
    expect((await customerConsents("ORD-1043") as any).daysLate).toBe(0);
    expect(taskFor("ORD-1043").status).toBe("resolved");
    expect(await customerConsents("ORD-1043")).toMatchObject({ error: expect.any(String) });
    expect(q("SELECT * FROM events WHERE order_id='ORD-1043' AND type='customer_consent'").length).toBe(1);
  });
});

describe("charter", () => {
  const ctx = { role: "reviewer", runId: "r" };
  const propose = (path: string, value: unknown) => TOOLS.propose_charter_diff.run({ summary: "s", evidence: "e", path, value }, ctx) as any;
  it("proposals are limited to editable paths and schema-valid values", () => {
    expect(propose("roles.expeditor.kind", "human").error).toMatch(/not editable/);
    expect(propose("roles.owner.kind", "agent").error).toMatch(/not editable/);
    expect(propose("roles.expeditor.tools.0", "propose_charter_diff").error).toMatch(/not editable/);
    expect(propose("autonomy_levels.expedite_po", "yolo").error).toMatch(/not a valid value/);
    expect(propose("roles.expeditor.authority.spend_usd", -5).error).toMatch(/>= 0/);
    expect(propose("roles.expeditor.authority.spend_usd", 450)).toMatchObject({ status: "proposed", current: 250, proposed: 450 });
    expect(propose("autonomy_levels.substitute_sku", "act")).toMatchObject({ status: "proposed" });
    expect(q("SELECT * FROM charter_proposals").length).toBe(2);
  });
  it("a hand edit to org.yaml reaches the gate without a restart", () => {
    expect(loadCharter().roles.expeditor.authority.spend_usd).toBe(250);
    const p = process.env.CHARTER_PATH!;
    writeFileSync(p, readFileSync(p, "utf8").replace("spend_usd: 250", "spend_usd: 100"));
    const future = new Date(Date.now() + 5000); utimesSync(p, future, future);   // same-millisecond writes must still invalidate
    expect(loadCharter().roles.expeditor.authority.spend_usd).toBe(100);
  });
  it("a missing autonomy_levels entry means observe, not a broken Charter", async () => {
    const p = process.env.CHARTER_PATH!;
    writeFileSync(p, readFileSync(p, "utf8").replace(/\n  discount: recommend/, ""));
    const future = new Date(Date.now() + 5000); utimesSync(p, future, future);
    expect(loadCharter().autonomy_levels.discount).toBeUndefined();
    const { gate } = await import("./gate.js");
    expect(gate(loadCharter(), { role: "expeditor", action: { type: "transfer_stock", cost_usd: 0 }, order: { id: "O", order_value: 1, ship_policy: "complete" }, spentSoFar: 0 }).verdict).toBe("execute");
  });
});

describe("api", () => {
  it("approval decisions fail closed", async () => {
    slipFrames(); runWatcher(); await workOpenTasks();
    const ap = pending()[0];
    for (const body of [{}, { decision: "deny" }, { decision: "reject" }, { decision: "yes" }]) {
      expect((await post(`/api/approvals/${ap.id}`, body, "owner")).status).toBe(400);
    }
    expect(one("SELECT status FROM approvals WHERE id=?", ap.id).status).toBe("pending");
    expect((await post(`/api/approvals/${ap.id}`, { decision: "rejected" }, "viewer")).status).toBe(403);
    expect((await post(`/api/approvals/${ap.id}`, { decision: "rejected", note: "no" }, "owner")).status).toBe(200);
    expect(one("SELECT status FROM approvals WHERE id=?", ap.id).status).toBe("rejected");
  });
  it("scenario controls are owner-only", async () => {
    expect((await post("/api/reset")).status).toBe(403);
    // the org's own clocks too: a viewer cannot open work or make a seat spend inside its authority
    slipFrames();
    for (const path of ["/api/watch", "/api/work", "/api/review"]) for (const role of [undefined, "viewer"]) expect((await post(path, {}, role)).status, `${role ?? "no role"} ${path}`).toBe(403);
    expect(q("SELECT 1 FROM tasks").length).toBe(0);
    expect((await post("/api/watch", {}, "owner")).status).toBe(200);
    const t = taskFor("ORD-1041");
    expect((await post(`/api/tasks/${t.id}/work`, {}, "viewer")).status).toBe(403);
    expect(q("SELECT 1 FROM actions").length).toBe(0);
    seed();
    expect((await post("/api/reset", {}, "viewer")).status).toBe(403);
    expect((await post("/api/customer/consent", { order_id: "ORD-1043" }, "viewer")).status).toBe(403);
    expect((await post("/api/events/slip", { supplier_id: "SUP_IRON", category: "frame", days: 10 })).status).toBe(403);
    expect(q("SELECT * FROM events WHERE type='customer_consent'").length).toBe(0);
    expect(assessOrder(getOrder("ORD-1042")!).daysLate).toBe(0);
    expect((await post("/api/events/slip", { supplier_id: "SUP_IRON", category: "frame", days: 10 }, "owner")).status).toBe(200);
    expect(assessOrder(getOrder("ORD-1042")!).daysLate).toBeGreaterThan(0);
    expect((await post("/api/reset", {}, "owner")).status).toBe(200);
    expect(assessOrder(getOrder("ORD-1042")!).daysLate).toBe(0);
  });
  it("world mutations wait for a running agent", async () => {
    slipFrames(); runWatcher();
    const work = post("/api/work", {}, "owner");
    const [reset, slip, watch] = await Promise.all([post("/api/reset", {}, "owner"), post("/api/events/slip", {}, "owner"), post("/api/watch", {}, "owner")]);
    expect([reset.status, slip.status, watch.status]).toEqual([409, 409, 409]);
    expect((await work).status).toBe(200);
    expect((await post("/api/watch", {}, "owner")).status).toBe(200);
  });
  it("trials endpoint is owner-only and fails closed on bad input", async () => {
    db().exec("DELETE FROM trials");
    expect((await post("/api/trials/run", { n: 1 })).status).toBe(403);
    expect((await post("/api/trials/run", { n: 1 }, "viewer")).status).toBe(403);
    for (const body of [{ n: 0 }, { n: -3 }, { n: 99 }, { n: "Infinity" }, { n: 1.5 }, { only: "does_not_exist" }]) expect((await post("/api/trials/run", body, "owner")).status, JSON.stringify(body)).toBe(400);
    expect(q("SELECT 1 FROM trials").length).toBe(0);
  });
  it("working a parked task is a 409, not a 500", async () => {
    slipFrames(); runWatcher(); await workOpenTasks();
    const parked = taskFor("ORD-1042"); expect(parked.status).toBe("awaiting_approval");
    const res = await post(`/api/tasks/${parked.id}/work`, {}, "owner");
    expect(res.status).toBe(409); expect((await res.json() as any).error).toMatch(/awaiting_approval/);
    expect((await post("/api/tasks/nope/work", {}, "owner")).status).toBe(500);
  });
  it("a merge that no longer applies is refused, and the proposal stays open", async () => {
    const r = TOOLS.propose_charter_diff.run({ summary: "s", evidence: "e", path: "autonomy_levels.substitute_sku", value: "act" }, { role: "reviewer", runId: "r" }) as any;
    db().prepare("UPDATE charter_proposals SET patch=? WHERE id=?").run(JSON.stringify({ autonomy_levels: { substitute_sku: "yolo" } }), r.proposal_id);
    const res = await post(`/api/proposals/${r.proposal_id}`, { decision: "merge" }, "owner");
    expect(res.status).toBe(400);
    expect(one("SELECT status FROM charter_proposals WHERE id=?", r.proposal_id).status).toBe("proposed");
    expect(loadCharter().version).toBe(1);
  });
});

describe("procedures", () => {
  it("refuses a promise-date change while a lever that keeps the date exists", () => {
    slipFrames(); runWatcher();
    const t = taskFor("ORD-1042");
    const r = proposeAction("expeditor", t.id, "ORD-1042", "change_promise_date", undefined, "supplier said so") as any;
    expect(r.error).toMatch(/last resort/);
    expect(q("SELECT 1 FROM actions WHERE order_id='ORD-1042'").length).toBe(0);
  });
});
