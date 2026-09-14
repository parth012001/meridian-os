// The agent loop with a scripted model: a refusal answered with prose gets exactly one push-back, then the model acts.
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.hoisted(() => {
  const { mkdtempSync, copyFileSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const d = mkdtempSync(join(tmpdir(), "meridian-runrole-"));
  copyFileSync(join(__dirname, "..", "data", "org.baseline.yaml"), join(d, "org.yaml"));
  process.env.DB_PATH = join(d, "world.db"); process.env.CHARTER_PATH = join(d, "org.yaml");
  process.env.MOCK_LLM = "1"; process.env.OPENAI_API_KEY = "";
});

const script: Array<{ tool?: string; args?: Record<string, unknown>; text?: string }> = [];
vi.mock("./llm.js", () => ({
  MOCK: true, MODEL: "scripted",
  chat: async () => {
    const s = script.shift(); if (!s) throw new Error("script exhausted");
    return s.tool
      ? { text: null, toolCalls: [{ id: `c${script.length}`, name: s.tool, args: s.args ?? {} }], tokensIn: 0, tokensOut: 0 }
      : { text: s.text ?? "", toolCalls: [], tokensIn: 0, tokensOut: 0 };
  },
}));

import { db } from "./db.js";
import { seed } from "./seed.js";
import { restoreBaselineCharter } from "./charter.js";
import { applySupplierSlip } from "./world.js";
import { runWatcher, runExpeditor } from "./roles.js";

const one = (sql: string, ...a: unknown[]) => db().prepare(sql).get(...a) as any;
const all = (sql: string, ...a: unknown[]) => db().prepare(sql).all(...a) as any[];

beforeEach(() => { seed(); restoreBaselineCharter(); script.length = 0; });

describe("runRole", () => {
  it("pushes back once when the model answers a refused tool call with prose, and the model then acts", async () => {
    applySupplierSlip("SUP_OAK", "door", 10, "test"); runWatcher();
    const t = one("SELECT * FROM tasks WHERE order_id='ORD-1035'"); expect(t).toBeDefined();
    script.push(
      { tool: "get_order_context", args: { order_id: "ORD-1035" } },
      { tool: "find_alternatives", args: { order_id: "ORD-1035" } },
      { tool: "propose_action", args: { order_id: "ORD-1035", lever_type: "partial_ship", rationale: "ready openings" } },
      { tool: "no_action_needed", args: { order_id: "ORD-1035", reason: "rest is late" } },   // refused: change_promise_date closes the gap
      { text: "Partial ship done; the remaining openings need a promise-date change, which I cannot do." },   // the ORD-1035 live failure
      { tool: "propose_action", args: { order_id: "ORD-1035", lever_type: "change_promise_date", rationale: "only closer" } },
      { text: "Proposed the promise-date change; waiting on the owner." },
    );
    const r = await runExpeditor(t.id);
    expect(r.status).toBe("completed"); expect(script.length).toBe(0);
    expect(one("SELECT status FROM tasks WHERE id=?", t.id).status).toBe("awaiting_approval");
    expect(all("SELECT * FROM approvals ap JOIN actions a ON a.id=ap.action_id WHERE a.task_id=? AND ap.status='pending'", t.id).map(x => x.type)).toEqual(["change_promise_date"]);
    expect(all("SELECT * FROM ledger WHERE summary LIKE '%nudged once to act%'").length).toBe(1);
  });
  it("only nudges once: prose after a second refusal ends the run", async () => {
    applySupplierSlip("SUP_OAK", "door", 10, "test"); runWatcher();
    const t = one("SELECT * FROM tasks WHERE order_id='ORD-1035'");
    script.push(
      { tool: "no_action_needed", args: { order_id: "ORD-1035", reason: "x" } }, { text: "giving up" },
      { tool: "no_action_needed", args: { order_id: "ORD-1035", reason: "x" } }, { text: "still giving up" },
    );
    const r = await runExpeditor(t.id);
    expect(r.finalText).toBe("still giving up"); expect(script.length).toBe(0);
    expect(one("SELECT status FROM tasks WHERE id=?", t.id).status).toBe("open");   // back to open, next work cycle picks it up
  });
  it("does not nudge after a successful final tool call", async () => {
    applySupplierSlip("SUP_IRON", "frame", 10, "test"); runWatcher();
    const t = one("SELECT * FROM tasks WHERE order_id='ORD-1041'");
    script.push({ tool: "propose_action", args: { order_id: "ORD-1041", lever_type: "transfer_stock", rationale: "in stock" } }, { text: "Recovered." });
    const r = await runExpeditor(t.id);
    expect(r.finalText).toBe("Recovered."); expect(script.length).toBe(0);
    expect(one("SELECT status FROM tasks WHERE id=?", t.id).status).toBe("resolved");
  });
});
