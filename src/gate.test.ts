import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { gate } from "./gate.js";
import { loadCharterFrom } from "./charter.js";

// Tests pin to the baseline Charter so a merged proposal in org.yaml cannot change test outcomes.
const charter = loadCharterFrom(fileURLToPath(new URL("../data/org.baseline.yaml", import.meta.url)));
const order = { id: "O", order_value: 10000, ship_policy: "complete" as const };

describe("gate", () => {
  it("executes a stock transfer inside authority", () => {
    const r = gate(charter, { role: "expeditor", action: { type: "transfer_stock", cost_usd: 150 }, order, spentSoFar: 0 });
    expect(r.verdict).toBe("execute");
  });
  it("routes an expedite over the role spend limit to the owner", () => {
    const r = gate(charter, { role: "expeditor", action: { type: "expedite_po", cost_usd: 450 }, order, spentSoFar: 0 });
    expect(r).toMatchObject({ verdict: "approve", rule: "ROLE.spend_usd" });
  });
  it("enforces C4 per-order 2% cap even when each action is under the role limit", () => {
    const r = gate(charter, { role: "expeditor", action: { type: "expedite_po", cost_usd: 120 }, order, spentSoFar: 100 });
    expect(r).toMatchObject({ verdict: "approve", rule: "C4" });
  });
  it("substitution without consent goes to approval under C2", () => {
    const r = gate(charter, { role: "expeditor", action: { type: "substitute_sku", cost_usd: 42 }, order, spentSoFar: 0, sameFireRating: true });
    expect(r).toMatchObject({ verdict: "approve", rule: "C2" });
  });
  it("substitution with consent executes", () => {
    const r = gate(charter, { role: "expeditor", action: { type: "substitute_sku", cost_usd: 42 }, order, spentSoFar: 0, sameFireRating: true, customerConsent: true });
    expect(r.verdict).toBe("execute");
  });
  it("denies substitution across fire ratings regardless of consent (C3)", () => {
    const r = gate(charter, { role: "expeditor", action: { type: "substitute_sku", cost_usd: 0 }, order, spentSoFar: 0, sameFireRating: false, customerConsent: true });
    expect(r).toMatchObject({ verdict: "deny", rule: "C3" });
  });
  it("promise date change is never executed by an agent (C1)", () => {
    const r = gate(charter, { role: "expeditor", action: { type: "change_promise_date", cost_usd: 0 }, order, spentSoFar: 0 });
    expect(r).toMatchObject({ verdict: "approve", rule: "C1" });
  });
  it("partial ship denied when order requires complete shipment", () => {
    const r = gate(charter, { role: "expeditor", action: { type: "partial_ship", cost_usd: 120 }, order, spentSoFar: 0 });
    expect(r).toMatchObject({ verdict: "deny", rule: "SHIP_POLICY" });
  });
  it("partial ship executes when policy allows", () => {
    const r = gate(charter, { role: "expeditor", action: { type: "partial_ship", cost_usd: 120 }, order: { ...order, ship_policy: "partial_ok" }, spentSoFar: 0 });
    expect(r.verdict).toBe("execute");
  });
  it("a role with no spend authority cannot act", () => {
    const r = gate(charter, { role: "ops_manager", action: { type: "transfer_stock", cost_usd: 0 }, order, spentSoFar: 0 });
    expect(r.verdict).toBe("deny");
  });
  it("unknown role fails closed", () => {
    const r = gate(charter, { role: "intern", action: { type: "transfer_stock", cost_usd: 0 }, order, spentSoFar: 0 });
    expect(r).toMatchObject({ verdict: "deny", rule: "ROLE" });
  });
});
