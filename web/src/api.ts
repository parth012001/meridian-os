// Typed view of /api/state and /api/trials. Fields marked optional are appended by the backend as they land (see notes/API-CONTRACT.md).

export type Role = "owner" | "viewer";
export type AutonomyLevel = "act" | "act_within_limit" | "act_if_ship_policy_allows" | "recommend" | "observe";

export interface CharterRole {
  kind: "human" | "agent"; status?: "live" | "declared"; title: string; horizon?: string; goal?: string;
  tools: string[]; approves?: string[];
  authority: { spend_usd: number; may: string[]; may_not: string[]; recommend_only: string[]; send_without_review: string[]; needs_review: string[] };
}
export interface Charter {
  company: string; version: number;
  outcome: { id: string; statement: string };
  kpis: Record<string, { formula: string; target?: string; constraint?: string }>;
  constraints: { id: string; rule: string }[];
  autonomy_levels: Partial<Record<string, AutonomyLevel>>;
  roles: Record<string, CharterRole>;
  escalation: { default: string; approval_timeout_hours: number };
  trust?: { thresholds?: Record<string, number>; demote_on?: string[] };
}
export interface Kpis {
  open_orders: number; at_risk: number; revenue_at_risk: number; projected_on_time_rate: number;
  historical_on_time_rate: number | null; revenue_protected: number; recovery_cost: number; pending_approvals: number;
}
export interface Task { id: string; order_id: string; status: string; outcome: string | null; reason: string; days_late: number; risk_score: number; created_at: string }
export interface BoardRow {
  id: string; customer_id: string; project_name: string; promise_date: string; status: string; order_value: number;
  margin_pct: number; ship_policy: string; branch: string; days_late: number; score: number; reasons: string[]; task: Task | null;
}
export interface Approval {
  id: string; action_id: string; kind: string; status: string; summary: string; decided_by: string | null; decided_at: string | null;
  note: string | null; created_at: string; action_type: string; order_id: string; cost_usd: number; rationale: string | null; gate_rule: string | null;
}
export interface Message { id: string; order_id: string; kind: string; to_contact: string; subject: string; body: string; status: string; created_at: string }
export interface Evidence { approval_id: string; action_id: string; order_id: string; cost_usd: number; gate_rule: string | null; ts: string }
export interface Grant { path: string; before: unknown; after: unknown; proposal_id: string; charter_version: number; granted_at: string }
export interface ReplayRow { action_id: string; approval_id: string; order_id: string; type: string; cost_usd: number; decision: "approved" | "rejected"; before_verdict: string; before_rule: string; after_verdict: string; after_rule: string; flips: boolean }
/** Every parked action the owner decided, re-run through the gate under the current Charter and under the patched one. Built by src/trust.ts. */
export interface Replay {
  path: string; before: unknown; after: unknown; window: number; evaluated: number; skipped: number;
  would_have_auto_executed: number; total_usd: number; still_parked: number; rejected_would_have_executed: number; any_rejected: boolean;
  rows: ReplayRow[]; computed_at: string;
  streak?: { shape: string; streak: number; threshold: number; evidence: Evidence[] };
}
export interface Proposal {
  id: string; proposed_by: string; summary: string; evidence: string; patch: string; status: string; decided_by: string | null; created_at: string;
  shape?: string | null; replay?: Replay | null;
}
export interface Run { id: string; role: string; task_id: string | null; status: string; turns: number; tokens_in: number; tokens_out: number; started_at: string; ended_at: string | null; error: string | null }
export interface LedgerRow {
  id: number; ts: string; role: string; on_behalf_of: string | null; kind: string; ref_type: string | null; ref_id: string | null;
  summary: string; detail: string | null; charter_rule: string | null;
}
/** Trust is earned per action shape (type, optionally per supplier), never per agent. */
export interface TrustRow {
  shape: string; action_type: string; streak: number; threshold: number;
  total_approved: number; total_rejected: number; total_failed: number; total_autonomous: number;
  status: "supervised" | "proposed" | "autonomous" | "demoted"; evidence: Evidence[]; grant: Grant | null; updated_at: string;
}
export interface State {
  mode: string; busy: boolean; charter: Charter; kpis: Kpis; board: BoardRow[]; approvals: Approval[]; messages: Message[];
  proposals: Proposal[]; runs: Run[]; ledger: LedgerRow[]; trust?: TrustRow[];
}
export interface Lever {
  type: string; po_id?: string; params: Record<string, unknown>; cost_usd: number; new_arrival?: string; days_saved: number;
  closes_gap: boolean; touches: string[]; requires: string; note: string;
}
export interface Scorecard { scenario: string; mode: string; reps: number; passed: number; aborted: number; checks: Record<string, { pass: number; total: number; lastFail?: string }>; avg_ms: number; tokens: number }
export interface TrialRun { id: string; scenario: string; rep: number; mode: string; passed: number; checks: { id: string; pass: boolean; detail: string }[]; summary: string; tokens_in: number; tokens_out: number; runs: number; duration_ms: number; started_at: string }
export interface Trials { scenarios: { id: string; title: string; why: string; checks: number }[]; scorecard: Scorecard[]; recent: TrialRun[] }

export const api = async (path: string, body?: unknown, role: Role = "owner") => {
  const r = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-role": role },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return r.json();
};

export const usd = (n: number) => `$${Math.round(n).toLocaleString()}`;
export const words = (s: string) => s.replace(/_/g, " ");
export const clock = (ts: string) => ts.slice(11, 19);
