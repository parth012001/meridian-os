import "./env.js";
// LLM adapter. Live = OpenAI chat completions with tool calling. Mock = deterministic scripted policy per role.
import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";

export const MOCK = !process.env.OPENAI_API_KEY || process.env.MOCK_LLM === "1";
export const MODEL = process.env.OPENAI_MODEL ?? "gpt-5.4-mini";
export const MODE = MOCK ? "mock" : `live:${MODEL}`;
let client: OpenAI | null = null;

export interface ToolCall { id: string; name: string; args: Record<string, unknown> }
export interface LlmTurn { text: string | null; toolCalls: ToolCall[]; raw?: ChatCompletionMessageParam; tokensIn: number; tokensOut: number }

export async function chat(messages: ChatCompletionMessageParam[], tools: ChatCompletionTool[], role: string): Promise<LlmTurn> {
  if (MOCK) return mockTurn(messages, role);
  client ??= new OpenAI();
  const res = await client.chat.completions.create({ model: MODEL, messages, tools, tool_choice: "auto" });
  const m = res.choices[0].message;
  const toolCalls: ToolCall[] = (m.tool_calls ?? []).flatMap(tc => tc.type === "function"
    ? [{ id: tc.id, name: tc.function.name, args: safeJson(tc.function.arguments) }] : []);
  return { text: m.content, toolCalls, raw: m as ChatCompletionMessageParam, tokensIn: res.usage?.prompt_tokens ?? 0, tokensOut: res.usage?.completion_tokens ?? 0 };
}
function safeJson(s: string): Record<string, unknown> { try { return JSON.parse(s); } catch { return { _unparsed: s }; } }

// ── Mock policy: same tool protocol, scripted decisions. Lets the demo run with zero spend. ──
let n = 0;
const call = (name: string, args: Record<string, unknown>): LlmTurn => ({ text: null, toolCalls: [{ id: `mock_${++n}`, name, args }], tokensIn: 0, tokensOut: 0 });
const done = (text: string): LlmTurn => ({ text, toolCalls: [], tokensIn: 0, tokensOut: 0 });

function lastToolResult(messages: ChatCompletionMessageParam[], name: string): any {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as any;
    if (m.role === "tool" && m.name === name) { try { return JSON.parse(m.content); } catch { return m.content; } }
  }
  return undefined;
}
const calledNames = (messages: ChatCompletionMessageParam[]) => messages.filter((m: any) => m.role === "tool").map((m: any) => m.name as string);

function mockTurn(messages: ChatCompletionMessageParam[], role: string): LlmTurn {
  const user = String((messages.find(m => m.role === "user") as any)?.content ?? "");
  const orderId = /ORD-\d+/.exec(user)?.[0] ?? "";
  const called = calledNames(messages);

  if (role === "expeditor") {
    if (!called.includes("get_order_context")) return call("get_order_context", { order_id: orderId });
    if (!called.includes("find_alternatives")) return call("find_alternatives", { order_id: orderId });
    const alts = lastToolResult(messages, "find_alternatives") as { levers: any[] };
    const ctx = lastToolResult(messages, "get_order_context");
    const firstLatePo = ctx?.late_pos?.[0]?.id;
    if (firstLatePo && !called.includes("query_supplier_eta")) return call("query_supplier_eta", { po_id: firstLatePo });
    const proposals = messages.filter((m: any) => m.role === "tool" && m.name === "propose_action").map((m: any) => JSON.parse(m.content));
    // what we asked for (assistant tool_call args), so a refused proposal counts as tried and is never re-proposed
    const asked = messages.flatMap((m: any) => m.role === "assistant" && m.tool_calls ? m.tool_calls.filter((t: any) => t.function?.name === "propose_action").map((t: any) => safeJson(t.function.arguments)) : []);
    const leverKey = (l: { type?: string; lever_type?: string; po_id?: string }) => `${l.type ?? l.lever_type}:${l.po_id ?? ""}`;
    const tried = new Set(asked.map(leverKey));
    const triedTypes = new Set(asked.map((a: any) => a.lever_type));
    const excluded = new Set<string>(/excluded levers?: ([^\n.]+)/i.exec(user)?.[1]?.split(/,\s*/) ?? []);
    const nextCloser = () => alts.levers.find(l => l.closes_gap && !tried.has(leverKey(l)) && !excluded.has(l.type));
    const last = proposals[proposals.length - 1];
    const lastToolName = called[called.length - 1];
    if (last && (last.status === "executed" || last.status === "awaiting_approval")) {
      if (last.status === "executed" && last.gap_closed === false) {
        // something still late: re-read the levers (the World changed), then take the next one that closes the gap
        if (lastToolName === "propose_action") return call("find_alternatives", { order_id: orderId });
        const next = nextCloser();
        if (next) return call("propose_action", { order_id: orderId, lever_type: next.type, po_id: next.po_id, rationale: `Remaining gap after ${last.lever_type}; ${next.type} on ${next.po_id ?? "order"} closes it.` });
        return call("no_action_needed", { order_id: orderId, reason: "No remaining lever closes the gap." });
      }
      return done(last.status === "executed" ? `Recovered ${orderId} via ${last.lever_type} for $${last.cost_usd}.` : `Proposed ${last.lever_type} for ${orderId}; parked at gate under ${last.gate_rule}, waiting on owner.`);
    }
    if (last && last.error && lastToolName === "propose_action") {
      // refused (does not close the gap, or rejected earlier): take the first closer not yet tried
      const next = nextCloser();
      if (next) return call("propose_action", { order_id: orderId, lever_type: next.type, po_id: next.po_id, rationale: `Previous proposal refused; ${next.type} closes the gap.` });
      return call("no_action_needed", { order_id: orderId, reason: "No lever closes the gap." });
    }
    if (lastToolName === "no_action_needed") {
      const r = lastToolResult(messages, "no_action_needed");
      if (r?.error) { const next = nextCloser(); if (next) return call("propose_action", { order_id: orderId, lever_type: next.type, po_id: next.po_id, rationale: "Escalation refused; proposing the closing lever." }); }
      return done(`Escalated ${orderId} to owner.`);
    }
    const pick = alts.levers.find(l => !tried.has(leverKey(l)) && !excluded.has(l.type) && (l.closes_gap || (l.type === "partial_ship" && !triedTypes.has("partial_ship"))));
    if (!pick) return call("no_action_needed", { order_id: orderId, reason: "No lever closes the gap inside authority; escalating." });
    return call("propose_action", { order_id: orderId, lever_type: pick.type, po_id: pick.po_id,
      rationale: `${pick.type} is the cheapest lever that closes the gap ($${pick.cost_usd}${pick.touches?.length ? `, touches ${pick.touches.join("/")}` : ""}). ${pick.note}` });
  }

  if (role === "customer_comms") {
    if (!called.includes("get_order_context")) return call("get_order_context", { order_id: orderId });
    if (!called.includes("draft_customer_message")) {
      const ctx = lastToolResult(messages, "get_order_context");
      const kind = /kind:\s*(\w+)/.exec(user)?.[1] ?? "status_update";
      const proj = ctx?.order?.project_name ?? orderId;
      const bodies: Record<string, string> = {
        status_update: `Hi ${ctx?.customer?.name ?? "there"},\n\nQuick update on ${proj} (${orderId}): a supplier acknowledgement moved on the frames, and we have already covered it. Your promise date of ${ctx?.order?.promise_date} stands. Nothing needed from you.\n\nMeridian Door & Hardware`,
        substitution_request: `Hi ${ctx?.customer?.name ?? "there"},\n\nOn ${proj} (${orderId}) the specified frames slipped at the manufacturer. We have an equivalent 90-minute labeled frame in stock (same size, same rating, same prep) that keeps your ${ctx?.order?.promise_date} date. Can you confirm you accept the substitution? Reply YES and we ship on time.\n\nMeridian Door & Hardware`,
        delay_notice: `Hi ${ctx?.customer?.name ?? "there"},\n\nOn ${proj} (${orderId}): the openings we can ship now are going out today. The remaining wood doors are with the manufacturer and we have a revised date; your project manager will confirm the new promise date with you.\n\nMeridian Door & Hardware`,
      };
      return call("draft_customer_message", { order_id: orderId, kind, subject: `${proj}: ${kind.replace("_", " ")}`, body: bodies[kind] ?? bodies.status_update });
    }
    return done("Message drafted.");
  }

  if (role === "reviewer") {
    if (!called.includes("read_ledger_stats")) return call("read_ledger_stats", {});
    if (!called.includes("propose_charter_diff")) {
      const s = lastToolResult(messages, "read_ledger_stats");
      const filed = s?.pending_proposals?.find((p: any) => p.proposed_by === "trust");
      if (filed) {
        const t = s.trust?.find((x: any) => x.shape === filed.shape);
        const r = filed.replay ?? {};
        return done(`The trust ledger has earned this one: ${filed.shape} is at ${t?.streak ?? "?"}/${t?.threshold ?? "?"} clean approvals, so the trust engine filed ${filed.id} (${filed.path}: ${filed.from} -> ${filed.to}). Replay: ${r.would_have_auto_executed ?? 0} of ${(r.would_have_auto_executed ?? 0) + (r.still_parked ?? 0)} past approvals ($${r.total_usd ?? 0}) would have executed without you${r.still_parked ? `, ${r.still_parked} would still park under a hard constraint` : ""}${r.any_rejected ? "; WARNING: it would also have executed something you rejected" : "; nothing you rejected"}. Waiting on the owner; no new diff.`);
      }
      const exp = s?.by_type?.expedite_po;
      if (exp && exp.approved > 0 && exp.rejected === 0) {
        return call("propose_charter_diff", {
          summary: `Raise expeditor spend authority from $${s.expeditor_limit} to $${Math.max(...(exp.approved_costs ?? [450]))}`,
          evidence: `${exp.approved} expedite approval(s) were granted and 0 rejected; each waited on the owner for ~${s.avg_approval_wait_min ?? "?"} min. Every approved expedite closed the gap.`,
          path: "roles.expeditor.authority.spend_usd", value: Math.max(...(exp.approved_costs ?? [450])),
        });
      }
      return done("Not enough evidence in the ledger to propose a change. No diff.");
    }
    return done("Proposal filed for owner review.");
  }
  return done("(mock) nothing to do");
}
