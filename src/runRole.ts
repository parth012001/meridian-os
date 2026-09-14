// One generic agent loop. Role identity, tools, and authority all come from the Charter.
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { db, uid, nowIso } from "./db.js";
import { loadCharter, rawCharterText } from "./charter.js";
import { chat, MOCK, MODEL } from "./llm.js";
import { TOOLS, toolSpecsFor, type ToolCtx } from "./tools.js";
import { log } from "./ledger.js";

const MAX_TURNS = 12;

export function systemPrompt(role: string): string {
  const c = loadCharter(); const r = c.roles[role];
  return [
    `You are the ${r.title} at ${c.company}, an autonomous role inside a human-governed organization.`,
    `Company outcome: ${c.outcome.statement.trim()}`,
    `Your goal: ${r.goal ?? ""}`,
    `Your authority (enforced by a code gate, not by you): ${JSON.stringify(r.authority)}`,
    `Hard constraints you must respect: ${c.constraints.map(x => `${x.id}: ${x.rule}`).join("; ")}`,
    `Autonomy levels: ${JSON.stringify(c.autonomy_levels)}`,
    `Rules of engagement:`,
    `- Read state with tools before deciding. Never invent prices, dates, or stock. Call find_alternatives before propose_action.`,
    `- Pick the cheapest lever with closes_gap=true. A lever that needs owner approval or customer consent is still the right proposal: propose it, the gate routes it. Constraints are handled by the gate, not by you avoiding them.`,
    `- Never propose a lever with closes_gap=false except partial_ship. partial_ship only helps the openings that are ready; after it, propose the lever that closes the remaining gap.`,
    `- If the gate returns awaiting_approval, stop and summarize in 2-3 lines. Do not try other levers to route around a constraint.`,
    `- Call no_action_needed only when no lever closes the gap.`,
    `- Be brief.`,
  ].join("\n");
}

export async function runRole(role: string, task: string, ctx: Omit<ToolCtx, "role" | "runId">) {
  const runId = uid("run");
  db().prepare("INSERT INTO runs (id, role, task_id) VALUES (?,?,?)").run(runId, role, ctx.taskId ?? null);
  log({ role, kind: "plan", refType: "run", refId: runId, summary: `${role} run started${ctx.orderId ? ` on ${ctx.orderId}` : ""}: ${task.slice(0, 120)}`, detail: { mock: MOCK, model: MOCK ? "mock" : MODEL } });
  const allowed = new Set(loadCharter().roles[role]?.tools ?? []);
  const messages: ChatCompletionMessageParam[] = [{ role: "system", content: systemPrompt(role) }, { role: "user", content: task }];
  const tctx: ToolCtx = { ...ctx, role, runId };
  let tokensIn = 0, tokensOut = 0, turns = 0, finalText = "", status = "completed";
  try {
    while (turns < MAX_TURNS) {
      turns++;
      const turn = await chat(messages, toolSpecsFor(role), role);
      tokensIn += turn.tokensIn; tokensOut += turn.tokensOut;
      if (!MOCK) log({ role, kind: "llm", refType: "run", refId: runId, summary: `${MODEL} turn ${turns}: ${turn.toolCalls.length ? turn.toolCalls.map(t => t.name).join(", ") : "final"}`, tokensIn: turn.tokensIn, tokensOut: turn.tokensOut });
      if (turn.toolCalls.length === 0) { finalText = turn.text ?? ""; break; }
      messages.push(turn.raw ?? { role: "assistant", content: turn.text, tool_calls: turn.toolCalls.map(t => ({ id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args) } })) } as any);
      for (const tc of turn.toolCalls) {
        let result: unknown;
        if (!allowed.has(tc.name) || !TOOLS[tc.name]) {
          result = { error: `tool ${tc.name} is not in ${role}'s Charter tool list` };
          log({ role, kind: "error", refType: "run", refId: runId, summary: `${role} tried ${tc.name}, not permitted` });
        } else {
          const entry = log({ role, kind: "tool_call", refType: "run", refId: runId, summary: `${role} -> ${tc.name}(${JSON.stringify(tc.args).slice(0, 140)})`, detail: { args: tc.args } });
          try { result = await TOOLS[tc.name].run(tc.args, tctx); }
          catch (e) { result = { error: (e as Error).message }; log({ role, kind: "error", refType: "run", refId: runId, summary: `${tc.name} failed: ${(e as Error).message}` }); }
          db().prepare("UPDATE ledger SET detail=? WHERE id=?").run(JSON.stringify({ args: tc.args, result }), entry);
        }
        messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result), name: tc.name } as any);
      }
    }
    if (turns >= MAX_TURNS && !finalText) { status = "stalled"; log({ role, kind: "error", refType: "run", refId: runId, summary: `${role} hit ${MAX_TURNS} turns without finishing; escalated` }); if (ctx.taskId) db().prepare("UPDATE tasks SET status='escalated' WHERE id=?").run(ctx.taskId); }
    else log({ role, kind: "outcome", refType: "run", refId: runId, summary: finalText || `${role} finished`, tokensIn, tokensOut });
  } catch (e) {
    status = "failed";
    log({ role, kind: "error", refType: "run", refId: runId, summary: `${role} run failed: ${(e as Error).message}` });
    if (ctx.taskId) db().prepare("UPDATE tasks SET status='escalated' WHERE id=?").run(ctx.taskId);
  }
  db().prepare("UPDATE runs SET status=?, turns=?, tokens_in=?, tokens_out=?, ended_at=? WHERE id=?").run(status, turns, tokensIn, tokensOut, nowIso(), runId);
  return { runId, status, turns, finalText, tokensIn, tokensOut };
}
