// The dock's "next step" pointer, checked against the real API at every stage of both demo sequences. No browser: the same
// Hono app the UI talks to, in mock mode, on a throwaway World and Charter.
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.hoisted(() => {
  const { mkdtempSync, copyFileSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const d = mkdtempSync(join(tmpdir(), "meridian-dock-"));
  copyFileSync(join(__dirname, "..", "..", "..", "data", "org.baseline.yaml"), join(d, "org.yaml"));
  process.env.DB_PATH = join(d, "world.db"); process.env.CHARTER_PATH = join(d, "org.yaml");
  process.env.MOCK_LLM = "1"; process.env.OPENAI_API_KEY = "";
});

import { app } from "../../../src/server.js";
import type { State } from "../api";
import { steps, arcSteps, worldOf } from "./Simulator";

const post = (path: string, body: unknown = {}) => app.request(`/api${path}`, { method: "POST", headers: { "content-type": "application/json", "x-role": "owner" }, body: JSON.stringify(body) });
const state = async () => (await app.request("/api/state")).json() as Promise<State>;
/** Click the step the dock points at, exactly as the owner would, and return what it points at next. */
async function click(kind: "arc" | "baseline"): Promise<number> {
  const s = await state();
  const { list, next } = kind === "arc" ? arcSteps(s) : steps(s);
  const st = list.find(x => x.n === next)!;
  if (st.who === "you") {
    if (next === 7 || (kind === "baseline" && next === 7)) { const p = s.proposals.find(p => p.status === "proposed")!; expect((await post(`/proposals/${p.id}`, { decision: "merge" })).status).toBe(200); }
    else for (const a of s.approvals.filter(a => a.status === "pending")) expect((await post(`/approvals/${a.id}`, { decision: "approved" })).status).toBe(200);
  } else if (st.per) { for (const id of st.per) expect((await post(st.path!, { order_id: id })).status).toBe(200); }
  else expect((await post(st.path!, st.body)).status, `step ${next} ${st.label}`).toBe(200);
  const after = await state();
  return (kind === "arc" ? arcSteps(after) : steps(after)).next;
}

beforeEach(async () => { await post("/reset", { world: "baseline" }); });

describe("dock", () => {
  it("knows which World is loaded", async () => {
    expect(worldOf(await state())).toBe("baseline");
    await post("/reset", { world: "earned_autonomy" });
    expect(worldOf(await state())).toBe("earned_autonomy");
  });
  it("baseline sequence: the pointer walks 1..7 and lands on complete", async () => {
    const seen = [steps(await state()).next];
    for (let i = 0; i < 12 && seen[seen.length - 1] !== 0; i++) seen.push(await click("baseline"));
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 0]);
  });
  it("earned-autonomy arc: the pointer walks 1..14 in order, never sticks, and the Charter ends at v3 with the shape demoted", async () => {
    await post("/reset", { world: "earned_autonomy" });
    const seen = [arcSteps(await state()).next];
    for (let i = 0; i < 20 && seen[seen.length - 1] !== 0; i++) seen.push(await click("arc"));
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 0]);
    const s = await state();
    expect(s.charter.version).toBe(3);
    expect(s.trust?.find(t => t.shape === "expedite_po:SUP_IRON")).toMatchObject({ status: "demoted", total_autonomous: 1 });
    expect(s.board.every(o => o.days_late === 0)).toBe(true);
    expect(s.ledger.some(l => l.kind === "charter_change" && l.charter_rule === "DEMOTION")).toBe(true);
  });
  it("the pointer reads the World, not a click count: a reload mid-arc points at the same step", async () => {
    await post("/reset", { world: "earned_autonomy" });
    for (let i = 0; i < 7; i++) await click("arc");   // through the merge
    const a = arcSteps(await state()); const b = arcSteps(await state());
    expect(a.next).toBe(8); expect(b.next).toBe(8);
    expect((await state()).charter.version).toBe(2);
  });
});
