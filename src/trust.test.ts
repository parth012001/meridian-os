// The trust engine: streaks per action shape, thresholds snapshotted at creation, proposals with a replay at threshold,
// autonomy granted only by the owner's merge, and revoked by a Charter patch that only ever tightens.
import { vi, describe, it, expect, beforeEach } from "vitest";
import { writeFileSync, readFileSync, utimesSync } from "node:fs";

vi.hoisted(() => {
  const { mkdtempSync, copyFileSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const d = mkdtempSync(join(tmpdir(), "meridian-trust-"));
  copyFileSync(join(__dirname, "..", "data", "org.baseline.yaml"), join(d, "org.yaml"));
  process.env.DB_PATH = join(d, "world.db"); process.env.CHARTER_PATH = join(d, "org.yaml");
  process.env.MOCK_LLM = "1"; process.env.OPENAI_API_KEY = "";
});

import { db } from "./db.js";
import { seed } from "./seed.js";
import { loadCharter, restoreBaselineCharter } from "./charter.js";
import { applySupplierSlip, applyExpediteMiss, findAlternatives, assessOrder, getOrder } from "./world.js";
import { runWatcher, workOpenTasks, ownerDecides, supplierMissesExpedite } from "./roles.js";
import { decideApproval } from "./actions.js";
import { recordOutcome, trustRows, shapeOf, buildReplay, mergeProposal, rejectProposal, fileProposal } from "./trust.js";
import { TOOLS } from "./tools.js";
import { runReviewer } from "./roles.js";
import { app } from "./server.js";
import { seedExpediteOrders } from "./trials/scenarios.js";

const q = <T = any>(sql: string, ...a: unknown[]) => db().prepare(sql).all(...a) as T[];
const one = <T = any>(sql: string, ...a: unknown[]) => db().prepare(sql).get(...a) as T;
const pending = () => q("SELECT ap.id, ap.kind, a.order_id, a.type FROM approvals ap JOIN actions a ON a.id=ap.action_id WHERE ap.status='pending' ORDER BY ap.rowid");
const trust = (shape: string) => one("SELECT * FROM trust WHERE shape=?", shape);
const slipFrames = () => applySupplierSlip("SUP_IRON", "frame", 10, "test");
const proposals = (where = "1=1") => q(`SELECT * FROM charter_proposals WHERE ${where} ORDER BY rowid`);
const approveAll = async (filter: (a: any) => boolean = () => true) => { for (const a of pending().filter(filter)) await ownerDecides(a.id, "approved"); };
/** Three Ironline expedite approvals in one pass: ORD-1042 plus two $25k orders of the same shape. */
const earnThree = async () => { seedExpediteOrders(2); slipFrames(); runWatcher(); await workOpenTasks(); await approveAll(a => a.type === "expedite_po"); };
const post = (path: string, body: unknown = {}, role?: string) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json", ...(role ? { "x-role": role } : {}) }, body: JSON.stringify(body) });
const get = (path: string) => app.request(path);
const editCharter = (from: string | RegExp, to: string) => {
  const p = process.env.CHARTER_PATH!;
  writeFileSync(p, readFileSync(p, "utf8").replace(from, to));
  const future = new Date(Date.now() + 5000); utimesSync(p, future, future);
};

beforeEach(() => { seed(); restoreBaselineCharter(); });

describe("streaks", () => {
  it("an owner approval of a parked expedite opens a per-supplier shape with the threshold snapshotted and evidence pointing at the approval", async () => {
    slipFrames(); runWatcher(); await workOpenTasks();
    const ap = pending().find(a => a.order_id === "ORD-1042")!; expect(ap.type).toBe("expedite_po");
    expect(trust("expedite_po:SUP_IRON")).toBeUndefined();
    await ownerDecides(ap.id, "approved");
    const row = trust("expedite_po:SUP_IRON");
    expect(row).toMatchObject({ action_type: "expedite_po", streak: 1, threshold: 3, total_approved: 1, total_rejected: 0, status: "supervised" });
    const ev = JSON.parse(row.evidence);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ approval_id: ap.id, order_id: "ORD-1042", cost_usd: 450, gate_rule: "ROLE.spend_usd" });
    expect(q("SELECT 1 FROM ledger WHERE role='trust' AND summary LIKE '%expedite_po:SUP_IRON%1/3%'").length).toBe(1);
  });
  it("a rejection resets the streak and is counted", async () => {
    slipFrames(); runWatcher(); await workOpenTasks();
    const ap = pending().find(a => a.order_id === "ORD-1042")!;
    await ownerDecides(ap.id, "rejected", "too expensive");
    expect(trust("expedite_po:SUP_IRON")).toMatchObject({ streak: 0, total_approved: 0, total_rejected: 1, status: "supervised", evidence: "[]" });
  });
  it("the threshold is snapshotted at creation; a later Charter edit does not move the goalposts", async () => {
    slipFrames(); runWatcher(); await workOpenTasks();
    await ownerDecides(pending().find(a => a.order_id === "ORD-1042")!.id, "approved");
    editCharter("expedite_po: 3", "expedite_po: 1");
    expect(loadCharter().trust.thresholds.expedite_po).toBe(1);
    seedExpediteOrders(1); applySupplierSlip("SUP_IRON", "frame", 10, "again"); runWatcher(); await workOpenTasks();
    await ownerDecides(pending().find(a => a.order_id === "ORD-3001")!.id, "approved");
    expect(trust("expedite_po:SUP_IRON")).toMatchObject({ streak: 2, threshold: 3, status: "supervised" });   // still 2/3, not promoted at the new 1
  });
  it("deciding the same approval twice never double counts", async () => {
    slipFrames(); runWatcher(); await workOpenTasks();
    const ap = pending().find(a => a.order_id === "ORD-1042")!;
    await ownerDecides(ap.id, "approved");
    expect(decideApproval(ap.id, "approved", "owner")).toEqual({ already: "approved" });
    expect(trust("expedite_po:SUP_IRON")).toMatchObject({ streak: 1, total_approved: 1 });
  });
  it("shapes are per supplier: an approval at one supplier does not move another's streak", () => {
    const a = { id: "act_x", type: "expedite_po", params: JSON.stringify({ po_id: "PO-1", supplier_id: "SUP_OAK" }), order_id: "ORD-1035", cost_usd: 600, gate_rule: "ROLE.spend_usd", role: "expeditor" };
    expect(shapeOf(a)).toBe("expedite_po:SUP_OAK");
    expect(shapeOf({ ...a, type: "transfer_stock", params: "{}" })).toBe("transfer_stock");
    recordOutcome({ action: a, outcome: "approved", approvalId: "apr_x", by: "owner" });
    expect(trust("expedite_po:SUP_OAK")).toMatchObject({ streak: 1 });
    expect(trust("expedite_po:SUP_IRON")).toBeUndefined();
  });
  it("fails closed: a shape without a Charter threshold is not counted, and malformed params never throw", () => {
    editCharter(", change_promise_date: 99", "");
    expect(loadCharter().trust.thresholds.change_promise_date).toBeUndefined();
    const a = { id: "act_y", type: "change_promise_date", params: "{}", order_id: "ORD-1035", cost_usd: 0, gate_rule: "C1", role: "expeditor" };
    expect(recordOutcome({ action: a, outcome: "approved", approvalId: "apr_y", by: "owner" })).toMatchObject({ skipped: expect.stringMatching(/threshold/) });
    expect(trust("change_promise_date")).toBeUndefined();
    expect(q("SELECT 1 FROM ledger WHERE role='trust' AND kind='error' AND summary LIKE '%no trust threshold%change_promise_date%'").length).toBe(1);
    const bad = { ...a, id: "act_z", type: "expedite_po", params: "not json" };
    expect(recordOutcome({ action: bad, outcome: "approved", approvalId: "apr_z", by: "owner" })).toMatchObject({ skipped: expect.stringMatching(/params/) });
    expect(q("SELECT 1 FROM ledger WHERE role='trust' AND kind='error' AND summary LIKE '%act_z%'").length).toBe(1);
    expect(trustRows()).toEqual([]);
  });
  it("a Charter without a trust block still parses, and nothing is ever counted", () => {
    editCharter(/\ntrust:\n(  .*\n)+/, "\n");
    expect(loadCharter().trust).toEqual({ thresholds: {}, demote_on: ["expedite_failed"] });
  });
});

describe("replay", () => {
  const raise = { roles: { expeditor: { authority: { spend_usd: 450 } } } };
  it("re-runs the gate over past parked actions under the patched Charter; a hard constraint still parks what it parked", async () => {
    slipFrames(); runWatcher(); await workOpenTasks();
    await ownerDecides(pending().find(a => a.order_id === "ORD-1042")!.id, "approved");
    const r = buildReplay(raise)!;
    expect(r).toMatchObject({ path: "roles.expeditor.authority.spend_usd", before: 250, after: 450, evaluated: 1, would_have_auto_executed: 0, total_usd: 0, still_parked: 1, any_rejected: false });
    expect(r.rows[0]).toMatchObject({ order_id: "ORD-1042", cost_usd: 450, decision: "approved", before_rule: "ROLE.spend_usd", after_verdict: "approve", after_rule: "C4", flips: false });   // $450 > 2% of $18,500
  });
  it("counts the approvals that would have executed without the owner, and their dollars", async () => {
    await earnThree();
    const r = buildReplay(raise)!;
    expect(r).toMatchObject({ evaluated: 3, would_have_auto_executed: 2, total_usd: 900, still_parked: 1, rejected_would_have_executed: 0, any_rejected: false });
    expect(r.rows.filter(x => x.flips).map(x => x.order_id).sort()).toEqual(["ORD-3001", "ORD-3002"]);
    for (const x of r.rows.filter(x => x.flips)) expect(one("SELECT status FROM approvals WHERE id=?", x.approval_id).status).toBe("approved");
  });
  it("flags a change that would have executed something the owner rejected", async () => {
    seedExpediteOrders(1); slipFrames(); runWatcher(); await workOpenTasks();
    await ownerDecides(pending().find(a => a.order_id === "ORD-3001")!.id, "rejected", "not this one");
    const r = buildReplay(raise)!;
    expect(r).toMatchObject({ would_have_auto_executed: 0, rejected_would_have_executed: 1, any_rejected: true });
  });
  it("fails closed on a patch that does not parse as a Charter", () => {
    expect(buildReplay({ autonomy_levels: { expedite_po: "yolo" } })).toBeNull();
    expect(buildReplay({})).toBeNull();
  });
});

describe("proposals from trust", () => {
  it("at threshold the engine files a proposal with the replay, marks the shape proposed, and files no second one", async () => {
    await earnThree();
    const row = trust("expedite_po:SUP_IRON"); expect(row).toMatchObject({ streak: 3, threshold: 3, status: "proposed" });
    const p = proposals("proposed_by='trust'"); expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ status: "proposed", shape: "expedite_po:SUP_IRON", patch: JSON.stringify({ roles: { expeditor: { authority: { spend_usd: 450 } } } }) });
    const replay = JSON.parse(p[0].replay);
    expect(replay).toMatchObject({ would_have_auto_executed: 2, total_usd: 900, still_parked: 1, any_rejected: false, streak: { shape: "expedite_po:SUP_IRON", streak: 3, threshold: 3 } });
    expect(replay.streak.evidence.map((e: any) => e.approval_id)).toEqual(JSON.parse(row.evidence).map((e: any) => e.approval_id));
    expect(p[0].evidence).toMatch(/2 of 3 .*would have executed without you/);
    expect(q("SELECT 1 FROM ledger WHERE role='trust' AND kind='propose' AND charter_rule='TRUST.threshold' AND ref_id=?", p[0].id).length).toBe(1);
    // a fourth clean approval of the same shape counts, but does not file again
    seedExpediteOrders(1, { from: 3 }); applySupplierSlip("SUP_IRON", "frame", 10, "again"); runWatcher(); await workOpenTasks();
    await ownerDecides(pending().find(a => a.order_id === "ORD-3003")!.id, "approved");
    expect(trust("expedite_po:SUP_IRON")).toMatchObject({ streak: 3, total_approved: 4, status: "proposed" });
    expect(proposals("proposed_by='trust'")).toHaveLength(1);
  });
  it("a rejection while the proposal is pending makes it stale and the shape starts over", async () => {
    await earnThree();
    seedExpediteOrders(1, { from: 3 }); applySupplierSlip("SUP_IRON", "frame", 10, "again"); runWatcher(); await workOpenTasks();
    await ownerDecides(pending().find(a => a.order_id === "ORD-3003")!.id, "rejected", "no");
    expect(proposals("proposed_by='trust'")[0].status).toBe("stale");
    expect(trust("expedite_po:SUP_IRON")).toMatchObject({ streak: 0, status: "supervised", evidence: "[]" });
    expect(q("SELECT 1 FROM ledger WHERE role='trust' AND charter_rule='TRUST.stale'").length).toBe(1);
    expect((await post(`/api/proposals/${proposals()[0].id}`, { decision: "merge" }, "owner")).status).toBe(400);   // stale cannot be merged
  });
  it("when no editable Charter value would release the streak's approvals, nothing is filed and the ledger says why", async () => {
    seedExpediteOrders(3, { value: 10000 });   // 2% cap $200: every $450 expedite stays parked under C4 whatever the role limit
    slipFrames(); runWatcher(); await workOpenTasks(); await approveAll(a => a.type === "expedite_po" && a.order_id !== "ORD-1042");
    expect(trust("expedite_po:SUP_IRON")).toMatchObject({ streak: 3, status: "supervised" });
    expect(proposals()).toEqual([]);
    expect(q("SELECT summary FROM ledger WHERE role='trust' AND kind='observe' AND summary LIKE '%3/3 but no proposal was filed%' AND summary LIKE '%C4%'").length).toBe(1);
  });
  it("the owner's merge grants autonomy and records what it replaced; the owner's rejection starts the shape over", async () => {
    await earnThree();
    const p = proposals("proposed_by='trust'")[0];
    expect(mergeProposal(p.id, "owner")).toMatchObject({ merged: true, version: 2, shape: "expedite_po:SUP_IRON" });
    expect(loadCharter().roles.expeditor.authority.spend_usd).toBe(450);
    const row = trust("expedite_po:SUP_IRON");
    expect(row.status).toBe("autonomous");
    expect(JSON.parse(row.grant)).toMatchObject({ path: "roles.expeditor.authority.spend_usd", before: 250, after: 450, proposal_id: p.id, charter_version: 2 });
    expect(one("SELECT status, decided_by FROM charter_proposals WHERE id=?", p.id)).toEqual({ status: "merged", decided_by: "owner" });
    expect(q("SELECT 1 FROM ledger WHERE role='owner' AND kind='charter_change' AND ref_id=?", p.id).length).toBe(1);
    expect(() => mergeProposal(p.id, "owner")).toThrow(/not a pending proposal/);
    // and rejection
    seed(); restoreBaselineCharter(); await earnThree();
    const p2 = proposals("proposed_by='trust'")[0];
    expect(rejectProposal(p2.id, "owner")).toMatchObject({ merged: false, shape: "expedite_po:SUP_IRON" });
    expect(trust("expedite_po:SUP_IRON")).toMatchObject({ status: "supervised", streak: 0, evidence: "[]", grant: null });
    expect(loadCharter().version).toBe(1);
  });
  it("merging a reviewer proposal changes the Charter but grants no shape autonomy", async () => {
    slipFrames(); runWatcher(); await workOpenTasks(); await approveAll(a => a.order_id === "ORD-1042");
    await runReviewer();
    const p = proposals("proposed_by='reviewer'")[0]; expect(p.shape).toBeNull();
    expect(JSON.parse(p.replay)).toMatchObject({ evaluated: 1, would_have_auto_executed: 0, still_parked: 1 });   // the replay is attached whoever files
    expect(mergeProposal(p.id, "owner")).toMatchObject({ merged: true, version: 2 });
    expect(trust("expedite_po:SUP_IRON")).toMatchObject({ status: "supervised", streak: 1 });
  });
  it("one pending proposal per Charter path: the reviewer cannot file a duplicate of what trust already filed", async () => {
    await earnThree();
    const r = TOOLS.propose_charter_diff.run({ summary: "s", evidence: "e", path: "roles.expeditor.authority.spend_usd", value: 500 }, { role: "reviewer", runId: "r" }) as any;
    expect(r.error).toMatch(/already awaiting the owner/);
    expect(proposals()).toHaveLength(1);
  });
  it("the filing path itself refuses a non-editable Charter value, whoever proposes", () => {
    expect(fileProposal({ by: "trust", summary: "s", evidence: "e", patch: { constraints: { 0: { rule: "anything goes" } } } })).toMatchObject({ error: expect.stringMatching(/not editable/) });
    expect(fileProposal({ by: "trust", summary: "s", evidence: "e", patch: { trust: { thresholds: { expedite_po: 1 } } } })).toMatchObject({ error: expect.stringMatching(/not editable/) });
    expect(fileProposal({ by: "trust", summary: "s", evidence: "e", patch: { roles: { owner: { kind: "agent" } } } })).toMatchObject({ error: expect.stringMatching(/not editable/) });
    expect(fileProposal({ by: "trust", summary: "s", evidence: "e", patch: { a: 1, b: 2 } })).toMatchObject({ error: expect.stringMatching(/exactly one/) });
    expect(proposals()).toEqual([]);
    expect(fileProposal({ by: "trust", summary: "s", evidence: "e", patch: { roles: { expeditor: { authority: { spend_usd: 300 } } } } })).toMatchObject({ status: "proposed" });
  });
  it("the mock reviewer explains a pending trust proposal instead of filing another", async () => {
    await earnThree();
    const r = await runReviewer();
    expect(r.finalText).toMatch(/expedite_po:SUP_IRON/); expect(r.finalText).toMatch(/2 of 3/);
    expect(proposals()).toHaveLength(1);
    const stats = TOOLS.read_ledger_stats.run({}, { role: "reviewer", runId: "r" }) as any;
    expect(stats.trust[0]).toMatchObject({ shape: "expedite_po:SUP_IRON", streak: 3, threshold: 3, status: "proposed" });
    expect(stats.pending_proposals[0]).toMatchObject({ proposed_by: "trust", path: "roles.expeditor.authority.spend_usd", from: 250, to: 450, replay: { would_have_auto_executed: 2, total_usd: 900 } });
  });
});

describe("trust api", () => {
  it("state and /api/trust expose the shapes and parsed replays; a malformed replay is null, never a 500", async () => {
    await earnThree();
    const s = await (await get("/api/state")).json() as any;
    expect(s.trust[0]).toMatchObject({ shape: "expedite_po:SUP_IRON", streak: 3, status: "proposed" });
    expect(s.trust[0].evidence).toHaveLength(3);
    expect(s.proposals[0].replay).toMatchObject({ would_have_auto_executed: 2 });
    db().prepare("UPDATE charter_proposals SET replay='{not json'").run();
    const s2 = await get("/api/state"); expect(s2.status).toBe(200);
    expect((await s2.json() as any).proposals[0].replay).toBeNull();
    const t = await (await get("/api/trust")).json() as any;
    expect(t.shapes[0]).toMatchObject({ shape: "expedite_po:SUP_IRON", grant: null });
    expect(t.shapes[0].evidence[0]).toMatchObject({ order_id: expect.any(String), approval_id: expect.any(String) });
  });
});

describe("demotion", () => {
  /** Earn, merge, and let the next Ironline expedite run without the owner. Returns the PO that was auto-expedited. */
  const earnAndAutoExecute = async () => {
    await earnThree();
    mergeProposal(proposals("proposed_by='trust'")[0].id, "owner");
    seedExpediteOrders(1, { from: 3 }); applySupplierSlip("SUP_IRON", "frame", 10, "Ironline slips again"); runWatcher(); await workOpenTasks();
    const a = one("SELECT * FROM actions WHERE order_id='ORD-3003' AND type='expedite_po'");
    expect(a).toMatchObject({ gate_verdict: "execute", gate_rule: "AUTONOMY.act_within_limit", status: "executed", cost_usd: 450 });
    expect(q("SELECT 1 FROM approvals ap JOIN actions a ON a.id=ap.action_id WHERE a.order_id='ORD-3003'")).toEqual([]);
    expect(trust("expedite_po:SUP_IRON")).toMatchObject({ status: "autonomous", total_autonomous: 1 });
    return "PO-8003";
  };
  it("the world can record a missed Fast Track: the PO falls back to its pre-expedite date, the order is late again, and the expedite is not offered twice", async () => {
    slipFrames(); runWatcher(); await workOpenTasks(); await approveAll(a => a.order_id === "ORD-1042");
    const po = one("SELECT * FROM purchase_orders WHERE id='PO-7103'"); expect(po.expedited).toBe(1); expect(po.pre_expedite_ship_date).toBeTruthy();
    expect(assessOrder(getOrder("ORD-1042")!).daysLate).toBe(0);
    expect(applyExpediteMiss("PO-7104")).toMatchObject({ error: expect.stringMatching(/not an open expedited PO/) });
    expect(applyExpediteMiss("PO-nope")).toMatchObject({ error: expect.stringMatching(/unknown PO/) });
    const r = applyExpediteMiss("PO-7103") as any;
    expect(r).toMatchObject({ po_id: "PO-7103", order_id: "ORD-1042", supplier_id: "SUP_IRON", days_late: 5 });
    expect(one("SELECT * FROM purchase_orders WHERE id='PO-7103'")).toMatchObject({ current_ship_date: po.pre_expedite_ship_date, expedited: 0, expedite_missed: 1 });
    expect(assessOrder(getOrder("ORD-1042")!).daysLate).toBe(5);
    expect(q("SELECT 1 FROM events WHERE type='expedite_failed' AND order_id='ORD-1042'").length).toBe(1);
    expect(findAlternatives("ORD-1042").some(l => l.type === "expedite_po")).toBe(false);
    const eta = TOOLS.query_supplier_eta.run({ po_id: "PO-7103" }, { role: "expeditor", runId: "r" }) as any;
    expect(eta.expedite_available).toBe(false); expect(eta.supplier_reply).toMatch(/missed/i);
    expect(applyExpediteMiss("PO-7103")).toMatchObject({ error: expect.any(String) });   // a miss is recorded once
  });
  it("a missed expedite on an autonomous shape revokes it: the Charter tightens back to the pre-grant value under rule DEMOTION", async () => {
    const po = await earnAndAutoExecute();
    expect(loadCharter().version).toBe(2); expect(loadCharter().roles.expeditor.authority.spend_usd).toBe(450);
    const oldTask = one("SELECT * FROM tasks WHERE order_id='ORD-3003'"); expect(oldTask.outcome).toBe("recovered");
    const r = supplierMissesExpedite(po) as any;
    expect(r).toMatchObject({ order_id: "ORD-3003", days_late: 5, trust: { shape: "expedite_po:SUP_IRON", status: "demoted", demoted: true, charter_version: 3 } });
    expect(loadCharter().version).toBe(3); expect(loadCharter().roles.expeditor.authority.spend_usd).toBe(250);
    expect(trust("expedite_po:SUP_IRON")).toMatchObject({ status: "demoted", streak: 0, total_failed: 1, evidence: "[]", grant: null });
    const led = one("SELECT * FROM ledger WHERE kind='charter_change' AND charter_rule='DEMOTION'");
    expect(led).toMatchObject({ role: "trust", ref_type: "trust", ref_id: "expedite_po:SUP_IRON" }); expect(led.summary).toMatch(/Charter v3/); expect(led.summary).toMatch(/450 -> 250/);
    expect(one("SELECT outcome FROM tasks WHERE id=?", oldTask.id).outcome).toBe("recovery_failed");
    // the watcher reopens the order; the expeditor cannot expedite again, so the last resort goes to the owner under C1
    runWatcher(); await workOpenTasks();
    const t = one("SELECT * FROM tasks WHERE order_id='ORD-3003' ORDER BY rowid DESC LIMIT 1"); expect(t.id).not.toBe(oldTask.id);
    expect(pending().find(a => a.order_id === "ORD-3003")).toMatchObject({ type: "change_promise_date" });
    // and the next expedite of that shape parks again at $250
    seedExpediteOrders(1, { from: 4 }); applySupplierSlip("SUP_IRON", "frame", 10, "third"); runWatcher(); await workOpenTasks();
    expect(one("SELECT gate_verdict, gate_rule FROM actions WHERE order_id='ORD-3004' AND type='expedite_po'")).toEqual({ gate_verdict: "approve", gate_rule: "ROLE.spend_usd" });
  });
  it("a missed expedite on a supervised shape resets the streak and stales a pending proposal; the Charter is untouched", async () => {
    await earnThree();
    expect(trust("expedite_po:SUP_IRON").status).toBe("proposed");
    const r = supplierMissesExpedite("PO-8001") as any;
    expect(r.trust).toMatchObject({ status: "supervised", streak: 0 });
    expect(trust("expedite_po:SUP_IRON")).toMatchObject({ status: "supervised", streak: 0, total_failed: 1, evidence: "[]" });
    expect(proposals("proposed_by='trust'")[0].status).toBe("stale");
    expect(loadCharter().version).toBe(1);
    expect(q("SELECT 1 FROM ledger WHERE charter_rule='DEMOTION'")).toEqual([]);
  });
  it("demotion only ever tightens: if the owner already hand-tightened below the pre-grant value, the Charter is left alone", async () => {
    const po = await earnAndAutoExecute();
    editCharter("spend_usd: 450", "spend_usd: 200");
    expect(loadCharter().roles.expeditor.authority.spend_usd).toBe(200);
    const r = supplierMissesExpedite(po) as any;
    expect(r.trust).toMatchObject({ status: "demoted", demoted: true }); expect(r.trust.charter_version).toBeUndefined();
    expect(loadCharter().version).toBe(2); expect(loadCharter().roles.expeditor.authority.spend_usd).toBe(200);
    expect(q("SELECT 1 FROM ledger WHERE charter_rule='DEMOTION' AND kind='charter_change'")).toEqual([]);
    expect(q("SELECT 1 FROM ledger WHERE role='trust' AND summary LIKE '%already at or below%'").length).toBe(1);
  });
  it("the Charter decides which failures revoke trust: a miss not named in demote_on changes the world but not the shape", async () => {
    const po = await earnAndAutoExecute();
    editCharter("demote_on: [expedite_failed]", "demote_on: []");
    expect(loadCharter().trust.demote_on).toEqual([]);
    const r = supplierMissesExpedite(po) as any;
    expect(r).toMatchObject({ order_id: "ORD-3003", days_late: 5, trust: { status: "autonomous" } });
    expect(trust("expedite_po:SUP_IRON")).toMatchObject({ status: "autonomous", total_failed: 0 });
    expect(loadCharter().version).toBe(2);
    expect(q("SELECT 1 FROM ledger WHERE role='trust' AND summary LIKE '%not in trust.demote_on%'").length).toBe(1);
  });
  it("a demoted shape re-earns the full streak and can be proposed again", async () => {
    const po = await earnAndAutoExecute(); supplierMissesExpedite(po);
    seedExpediteOrders(3, { from: 5 }); applySupplierSlip("SUP_IRON", "frame", 10, "again"); runWatcher(); await workOpenTasks();
    await approveAll(a => a.type === "expedite_po" && a.order_id.startsWith("ORD-300"));
    expect(trust("expedite_po:SUP_IRON")).toMatchObject({ status: "proposed", streak: 3 });
    expect(proposals("proposed_by='trust' AND status='proposed'")).toHaveLength(1);
  });
  it("POST /api/events/expedite-miss is owner-only and fails closed on a bad PO", async () => {
    const po = await earnAndAutoExecute();
    expect((await post("/api/events/expedite-miss", { po_id: po })).status).toBe(403);
    expect((await post("/api/events/expedite-miss", { po_id: po }, "viewer")).status).toBe(403);
    expect((await post("/api/events/expedite-miss", {}, "owner")).status).toBe(400);
    expect((await post("/api/events/expedite-miss", { po_id: "PO-7104" }, "owner")).status).toBe(400);
    expect(loadCharter().version).toBe(2);
    const res = await post("/api/events/expedite-miss", { po_id: po }, "owner"); expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ order_id: "ORD-3003", trust: { status: "demoted", charter_version: 3 } });
    expect((await post("/api/events/expedite-miss", { po_id: po }, "owner")).status).toBe(400);
  });
});

describe("the arc through the API, as the dock drives it", () => {
  const state = async () => (await get("/api/state")).json() as Promise<any>;
  const approveAllPending = async () => { for (const a of (await state()).approvals.filter((x: any) => x.status === "pending")) expect((await post(`/api/approvals/${a.id}`, { decision: "approved" }, "owner")).status).toBe(200); };
  it("reset accepts a named world, owner-only, and fails closed on an unknown one", async () => {
    expect((await post("/api/reset", { world: "earned_autonomy" }, "viewer")).status).toBe(403);
    const bad = await post("/api/reset", { world: "nope" }, "owner");
    expect(bad.status).toBe(400); expect(((await bad.json()) as any).error).toMatch(/unknown world/);
    expect((await state()).board.some((o: any) => o.id === "ORD-3001")).toBe(false);
    expect((await post("/api/reset", { world: "earned_autonomy" }, "owner")).status).toBe(200);
    const s = await state();
    expect(s.board.filter((o: any) => o.id.startsWith("ORD-300")).map((o: any) => o.id).sort()).toEqual(["ORD-3001", "ORD-3002", "ORD-3003"]);
    expect(s.charter.version).toBe(1); expect(s.trust).toEqual([]);
    expect(s.board.filter((o: any) => o.id.startsWith("ORD-300")).every((o: any) => o.days_late === 0)).toBe(true);   // ORD-1035 is amber in the seed by design
    expect(q("SELECT 1 FROM ledger WHERE summary LIKE 'world reset by owner%earned_autonomy%'").length).toBe(1);
    expect((await post("/api/reset", {}, "owner")).status).toBe(200);   // default stays the baseline world
    expect((await state()).board.some((o: any) => o.id === "ORD-3001")).toBe(false);
    expect((await post("/api/reset", { world: "baseline" }, "owner")).status).toBe(200);
  });
  it("earn, merge, act alone, fail, demoted: every step is an existing endpoint", async () => {
    expect((await post("/api/reset", { world: "earned_autonomy" }, "owner")).status).toBe(200);
    expect((await post("/api/events/slip", { supplier_id: "SUP_IRON", category: "frame", days: 10 }, "owner")).status).toBe(200);
    expect((await post("/api/watch", {}, "owner")).status).toBe(200);
    expect((await post("/api/work", {}, "owner")).status).toBe(200);
    let s = await state();
    expect(s.approvals.filter((a: any) => a.status === "pending" && a.action_type === "expedite_po").map((a: any) => a.order_id).sort()).toEqual(["ORD-1042", "ORD-3001", "ORD-3002"]);
    await approveAllPending();
    expect((await post("/api/customer/consent", { order_id: "ORD-1043" }, "owner")).status).toBe(200);   // dock step 5
    s = await state();
    expect(s.trust.find((t: any) => t.shape === "expedite_po:SUP_IRON")).toMatchObject({ streak: 3, threshold: 3, status: "proposed" });
    const prop = s.proposals.find((p: any) => p.proposed_by === "trust" && p.status === "proposed");
    expect(prop.replay).toMatchObject({ would_have_auto_executed: 2, total_usd: 900 });
    expect((await post("/api/review", {}, "owner")).status).toBe(200);
    expect((await state()).proposals.filter((p: any) => p.status === "proposed")).toHaveLength(1);   // the reviewer explained, did not duplicate
    expect(await (await post(`/api/proposals/${prop.id}`, { decision: "merge" }, "owner")).json()).toMatchObject({ merged: true, version: 2, shape: "expedite_po:SUP_IRON" });
    expect((await state()).trust.find((t: any) => t.shape === "expedite_po:SUP_IRON").status).toBe("autonomous");
    // the world moves again: only ORD-3003's PO is still open and unexpedited
    expect((await post("/api/events/slip", { supplier_id: "SUP_IRON", category: "frame", days: 15, note: "Ironline slips again" }, "owner")).status).toBe(200);
    s = await state(); expect(s.board.filter((o: any) => o.days_late > 0).map((o: any) => o.id)).toEqual(["ORD-3003"]);
    expect((await post("/api/watch", {}, "owner")).status).toBe(200);
    expect((await post("/api/work", {}, "owner")).status).toBe(200);
    s = await state();
    expect(s.board.find((o: any) => o.id === "ORD-3003").task).toMatchObject({ status: "resolved", outcome: "recovered" });
    expect(s.approvals.filter((a: any) => a.order_id === "ORD-3003")).toEqual([]);   // executed alone
    expect(s.trust.find((t: any) => t.shape === "expedite_po:SUP_IRON").total_autonomous).toBe(1);
    const miss = await post("/api/events/expedite-miss", { po_id: "PO-8003" }, "owner");
    expect(miss.status).toBe(200); expect(await miss.json()).toMatchObject({ order_id: "ORD-3003", trust: { status: "demoted", charter_version: 3 } });
    s = await state(); expect(s.charter.version).toBe(3); expect(s.charter.roles.expeditor.authority.spend_usd).toBe(250);
    expect(s.board.find((o: any) => o.id === "ORD-3003").days_late).toBeGreaterThan(0);
    expect((await post("/api/watch", {}, "owner")).status).toBe(200);
    expect((await post("/api/work", {}, "owner")).status).toBe(200);
    s = await state();
    expect(s.approvals.filter((a: any) => a.status === "pending").map((a: any) => `${a.order_id}:${a.action_type}`)).toEqual(["ORD-3003:change_promise_date"]);
    await approveAllPending();
    s = await state();
    expect(s.board.find((o: any) => o.id === "ORD-3003")).toMatchObject({ days_late: 0, task: { status: "resolved", outcome: "recovered" } });
    expect(s.board.every((o: any) => o.days_late === 0)).toBe(true);
    expect(s.ledger.some((l: any) => l.kind === "charter_change" && l.charter_rule === "DEMOTION")).toBe(true);
    expect(s.trust.find((t: any) => t.shape === "expedite_po:SUP_IRON")).toMatchObject({ status: "demoted", streak: 0 });
  });
});
