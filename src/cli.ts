import "./env.js";
// End-to-end demo in the terminal. `pnpm demo` (mock) or with OPENAI_API_KEY set (live).
import { seed } from "./seed.js";
import { db } from "./db.js";
import { applySupplierSlip, kpis, assessAll } from "./world.js";
import { runWatcher, workOpenTasks, ownerDecides, customerConsents, runReviewer } from "./roles.js";
import { MOCK, MODEL } from "./llm.js";
import { loadCharter, applyCharterPatch, restoreBaselineCharter } from "./charter.js";
import { log } from "./ledger.js";

const hr = (s: string) => console.log(`\n\x1b[1m── ${s} ──\x1b[0m`);
const board = () => console.table(assessAll().map(r => ({ order: r.order.id, promise: r.order.promise_date, value: r.order.order_value, days_late: r.daysLate, risk: r.score })));
const approvals = () => db().prepare("SELECT id, kind, summary FROM approvals WHERE status='pending'").all() as any[];
const tail = (n: number) => (db().prepare("SELECT ts, role, kind, charter_rule, summary FROM ledger ORDER BY id DESC LIMIT ?").all(n) as any[]).reverse().forEach(l => console.log(`  ${l.ts.slice(11, 19)} ${l.role.padEnd(14)} ${l.kind.padEnd(9)} ${(l.charter_rule ?? "").padEnd(10)} ${l.summary}`));

async function main() {
  console.log(`mode: ${MOCK ? "MOCK (deterministic, $0)" : `LIVE ${MODEL}`}`);
  hr("0. seed World"); seed(); restoreBaselineCharter(); board();
  hr("1. event: Ironline acknowledges +10 days on hollow metal frames");
  console.log("touched:", applySupplierSlip("SUP_IRON", "frame", 10, "Ironline PO ack variance: frame line backlog"));
  hr("2. Ops Manager watch cycle"); console.log(runWatcher()); board();
  hr("3. Expeditor works every open task"); for (const r of await workOpenTasks()) console.log(r.task, r.status, "|", r.finalText);
  board(); console.log("KPIs:", kpis());
  hr("4. Owner inbox"); for (const a of approvals()) console.log(`  [${a.id}] ${a.kind}: ${a.summary}`);
  hr("5. Owner approves everything pending");
  for (const a of approvals()) { console.log(`  approve ${a.id} (${a.kind}) ->`, await ownerDecides(a.id, "approved", "ok, keep the date")); }
  board();
  hr("6. Customer replies YES to the substitution request (ORD-1043)"); console.log(await customerConsents("ORD-1043")); board();
  hr("7. KPIs"); console.log(kpis());
  hr("8. Reviewer proposes a Charter diff"); console.log((await runReviewer()).finalText);
  const props = db().prepare("SELECT * FROM charter_proposals WHERE status='proposed'").all() as any[];
  for (const p of props) console.log(`  [${p.id}] ${p.summary}\n     evidence: ${p.evidence}\n     patch: ${p.patch}`);
  if (props[0]) {
    hr("9. Owner merges the proposal");
    const c = applyCharterPatch(JSON.parse(props[0].patch));
    db().prepare("UPDATE charter_proposals SET status='merged', decided_by='owner', decided_at=datetime('now') WHERE id=?").run(props[0].id);
    log({ role: "owner", kind: "charter_change", refType: "charter_proposal", refId: props[0].id, summary: `Charter v${c.version}: ${props[0].summary}` });
    console.log("Charter now v" + loadCharter(true).version, "expeditor spend_usd =", loadCharter().roles.expeditor.authority.spend_usd);
  }
  hr("Ledger (last 40)"); tail(40);
  hr("Messages"); for (const m of db().prepare("SELECT order_id, kind, status, to_contact, subject FROM messages").all() as any[]) console.log(`  ${m.order_id} ${m.kind.padEnd(20)} ${m.status.padEnd(15)} -> ${m.to_contact}  "${m.subject}"`);
}
main().catch(e => { console.error(e); process.exit(1); });
