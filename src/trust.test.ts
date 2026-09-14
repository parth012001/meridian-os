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
import { applySupplierSlip } from "./world.js";
import { runWatcher, workOpenTasks, ownerDecides } from "./roles.js";
import { decideApproval } from "./actions.js";
import { recordOutcome, trustRows, shapeOf } from "./trust.js";
import { seedExpediteOrders } from "./trials/scenarios.js";

const q = <T = any>(sql: string, ...a: unknown[]) => db().prepare(sql).all(...a) as T[];
const one = <T = any>(sql: string, ...a: unknown[]) => db().prepare(sql).get(...a) as T;
const pending = () => q("SELECT ap.id, ap.kind, a.order_id, a.type FROM approvals ap JOIN actions a ON a.id=ap.action_id WHERE ap.status='pending' ORDER BY ap.rowid");
const trust = (shape: string) => one("SELECT * FROM trust WHERE shape=?", shape);
const slipFrames = () => applySupplierSlip("SUP_IRON", "frame", 10, "test");
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
