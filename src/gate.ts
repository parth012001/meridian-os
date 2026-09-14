// THE GATE. One pure function every consequential action passes through.
// Deterministic. Fails closed. Never consults an LLM. Returns the Charter rule that decided.
import type { Charter, ActionType } from "./charter.js";
import { MAX_RECOVERY_PCT } from "./charter.js";

export interface GateInput {
  role: string;
  action: { type: ActionType; cost_usd: number; touches?: string[] };
  order: { id: string; order_value: number; ship_policy: "complete" | "partial_ok"; hasFireRatedOpenings?: boolean };
  /** Sum of already-executed recovery spend on this order. */
  spentSoFar: number;
  /** Set true when a customer_msg event with consent exists for this substitution. */
  customerConsent?: boolean;
  /** For substitutions: do the from/to SKUs share a fire rating? */
  sameFireRating?: boolean;
}
export type Verdict = "execute" | "approve" | "deny";
export interface GateResult { verdict: Verdict; rule: string; reason: string; approvalKind?: string }

export function gate(charter: Charter, input: GateInput): GateResult {
  try {
    const role = charter.roles[input.role];
    if (!role) return { verdict: "deny", rule: "ROLE", reason: `unknown role ${input.role}` };
    if (role.kind === "human") return { verdict: "execute", rule: "HUMAN", reason: "human principal acting directly" };
    const a = role.authority; const t = input.action.type;

    // 1. hard constraints (deny list) - checked before anything the role says
    if (t === "substitute_sku" && input.sameFireRating === false)
      return { verdict: "deny", rule: "C3", reason: "substitution across fire ratings is never allowed" };
    if (a.may_not.includes(t))
      return t === "change_promise_date" || t === "discount"
        ? { verdict: "approve", rule: t === "discount" ? "ROLE.may_not" : "C1", reason: `${input.role} may not ${t}; routed to owner`, approvalKind: t }
        : { verdict: "deny", rule: "ROLE.may_not", reason: `${input.role} may not ${t}` };

    // 2. autonomy level for this action class
    const level = charter.autonomy_levels[t] ?? "observe";
    if (level === "observe") return { verdict: "deny", rule: "AUTONOMY", reason: `${t} is observe-only` };
    if (level === "recommend" || a.recommend_only.includes(t)) {
      if (t === "substitute_sku") {
        if (!input.customerConsent) return { verdict: "approve", rule: "C2", reason: "substitution needs recorded customer consent", approvalKind: "substitution" };
        // consent recorded: fall through to spend checks
      } else {
        return { verdict: "approve", rule: "AUTONOMY.recommend", reason: `${t} is recommend-only`, approvalKind: t };
      }
    }
    if (level === "act_if_ship_policy_allows" && input.order.ship_policy !== "partial_ok")
      return { verdict: "deny", rule: "SHIP_POLICY", reason: "order requires complete shipment" };

    // 3. role permission
    if (!a.may.includes(t) && !(t === "substitute_sku" && input.customerConsent))
      return { verdict: "deny", rule: "ROLE.may", reason: `${input.role} is not permitted to ${t}` };

    // 4. spend vs role authority
    if (input.action.cost_usd > a.spend_usd)
      return { verdict: "approve", rule: "ROLE.spend_usd", reason: `$${input.action.cost_usd} exceeds ${input.role} limit $${a.spend_usd}`, approvalKind: "expedite_over_limit" };

    // 5. C4: per-order recovery budget
    const cap = input.order.order_value * MAX_RECOVERY_PCT;
    if (input.spentSoFar + input.action.cost_usd > cap)
      return { verdict: "approve", rule: "C4", reason: `$${input.spentSoFar + input.action.cost_usd} would exceed 2% of order value ($${cap.toFixed(0)})`, approvalKind: "expedite_over_limit" };

    return { verdict: "execute", rule: level === "act" ? "AUTONOMY.act" : "AUTONOMY.act_within_limit", reason: "within authority" };
  } catch (e) {
    return { verdict: "deny", rule: "GATE_ERROR", reason: `gate error, failing closed: ${(e as Error).message}` };
  }
}
