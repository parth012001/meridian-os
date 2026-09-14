import type { Act } from "../App";
import type { State } from "../api";

type Step = { n: number; label: string; who: "world" | "org" | "you"; path?: string; body?: unknown; ownerOnly?: boolean; per?: string[] };

/** The demo is a real sequence, so the dock numbers it and points at whichever step the World is ready for. */
export function steps(s: State): { list: Step[]; next: number } {
  const tasks = s.board.filter(o => o.task);
  const atRiskNoTask = s.board.some(o => o.days_late > 0 && !o.task);
  const openTasks = tasks.some(o => o.task!.status === "open");
  const pending = s.approvals.some(a => a.status === "pending");
  const awaiting = s.board.filter(o => o.task?.status === "awaiting_customer").map(o => o.id);
  const proposal = s.proposals.some(p => p.status === "proposed");
  const settled = tasks.length > 0 && tasks.every(o => ["resolved", "escalated"].includes(o.task!.status));
  const list: Step[] = [
    { n: 1, label: "Supplier slips: Ironline frames +10 days", who: "world", path: "/events/slip", body: { supplier_id: "SUP_IRON", category: "frame", days: 10, note: "Ironline PO ack variance" }, ownerOnly: true },
    { n: 2, label: "Ops Manager watch cycle", who: "org", path: "/watch" },
    { n: 3, label: "Expeditor works open tasks", who: "org", path: "/work" },
    { n: 4, label: "Decide at your desk", who: "you" },
    { n: 5, label: "Customer replies yes", who: "world", path: "/customer/consent", ownerOnly: true, per: awaiting },
    { n: 6, label: "Weekly Reviewer", who: "org", path: "/review" },
    { n: 7, label: "Merge or reject the proposal", who: "you" },
  ];
  const decidedProposal = s.proposals.some(p => p.status !== "proposed");
  // The seed has one order late already (ORD-1035), so "something is late" is not the signal for step 1; the slip event is.
  const next = proposal ? 7 : pending ? 4 : awaiting.length ? 5 : openTasks ? 3 : !slipped(s) ? 1 : atRiskNoTask ? 2 : settled ? (decidedProposal ? 0 : 6) : 3;
  return { list, next };
}
/** Has the outside world slipped yet? Read from the ledger the UI already has (the slip is among the first rows of a fresh World). */
const slipped = (s: State) => s.ledger.some(l => l.role === "world" && l.summary.startsWith("event supplier_ack_slip")) || s.board.some(o => o.task);

export type World = "baseline" | "earned_autonomy";
/** Which starting World is loaded. The earned-autonomy World adds ORD-3001..3003 (POST /api/reset {world}). */
export const worldOf = (s: State): World => (s.board.some(o => o.id === "ORD-3003") ? "earned_autonomy" : "baseline");

const TERMINAL = new Set(["resolved", "escalated"]);
/** The earned-autonomy arc, in the order the trial proves it: three approvals of one shape earn a Charter proposal with a replay,
 *  the owner merges, the next expedite runs alone, the supplier misses, the shape is demoted and the Charter tightens back.
 *  `next` is read off the World the same way the baseline steps are; the Charter version says which phase the org is in. */
export function arcSteps(s: State): { list: Step[]; next: number } {
  const late = s.board.filter(o => o.days_late > 0);
  const lateNoTask = late.some(o => !o.task || TERMINAL.has(o.task.status));   // a task can be resolved while its order is late again (a missed expedite)
  const openTasks = s.board.some(o => o.task?.status === "open");
  const pending = s.approvals.some(a => a.status === "pending");
  const awaiting = s.board.filter(o => o.task?.status === "awaiting_customer").map(o => o.id);
  const trustProposal = s.proposals.find(p => p.proposed_by === "trust");
  const reviewerRan = s.runs.some(r => r.role === "reviewer");
  const version = s.charter.version;
  const shape = s.trust?.find(t => t.shape === "expedite_po:SUP_IRON");
  const d = s.board.find(o => o.id === "ORD-3003");
  const dRecoveredAlone = d?.task?.status === "resolved" && d.task.outcome === "recovered" && d.days_late === 0 && shape?.status === "autonomous";
  const settled = s.board.filter(o => o.task).every(o => TERMINAL.has(o.task!.status));
  const list: Step[] = [
    { n: 1, label: "Supplier slips: Ironline frames +10 days", who: "world", path: "/events/slip", body: { supplier_id: "SUP_IRON", category: "frame", days: 10, note: "Ironline PO ack variance" }, ownerOnly: true },
    { n: 2, label: "Ops Manager watch cycle", who: "org", path: "/watch" },
    { n: 3, label: "Expeditor works open tasks", who: "org", path: "/work" },
    { n: 4, label: "Approve the three Ironline expedites at your desk", who: "you" },
    { n: 5, label: "Customer replies yes", who: "world", path: "/customer/consent", ownerOnly: true, per: awaiting },
    { n: 6, label: "Weekly Reviewer explains what trust filed", who: "org", path: "/review" },
    { n: 7, label: "Merge the trust proposal", who: "you" },
    { n: 8, label: "Ironline slips again: +15 days", who: "world", path: "/events/slip", body: { supplier_id: "SUP_IRON", category: "frame", days: 15, note: "Ironline slips again on the frame line" }, ownerOnly: true },
    { n: 9, label: "Ops Manager watch cycle", who: "org", path: "/watch" },
    { n: 10, label: "Expeditor works: the expedite runs alone", who: "org", path: "/work" },
    { n: 11, label: "Supplier misses Fast Track on PO-8003", who: "world", path: "/events/expedite-miss", body: { po_id: "PO-8003" }, ownerOnly: true },
    { n: 12, label: "Ops Manager watch cycle", who: "org", path: "/watch" },
    { n: 13, label: "Expeditor works: the last resort goes to you", who: "org", path: "/work" },
    { n: 14, label: "Approve the new promise date at your desk", who: "you" },
  ];
  let next: number;
  if (version >= 3 || shape?.status === "demoted") {                                     // phase C: demoted
    next = pending ? 14 : lateNoTask ? 12 : openTasks ? 13 : settled ? 0 : 13;
  } else if (version === 2) {                                                             // phase B: autonomous
    next = pending ? 4 : dRecoveredAlone ? 11 : lateNoTask ? 9 : openTasks ? 10 : 8;
  } else {                                                                                // phase A: earning
    next = pending ? 4 : awaiting.length ? 5 : trustProposal?.status === "proposed" ? (reviewerRan ? 7 : 6)
      : openTasks ? 3 : !slipped(s) ? 1 : lateNoTask ? 2 : settled ? (reviewerRan ? 0 : 6) : 3;   // settled with nothing filed: let the Reviewer say why
  }
  return { list, next };
}

/** Open expedited POs, read from the ledger: a proposed expedite whose action later executed and has not since missed. The World keeps this on the PO row; the ledger is what the UI can see. */
function expeditedPOs(s: State): { po: string; order: string }[] {
  const executed = new Set(s.ledger.filter(l => l.kind === "execute" && l.ref_type === "action").map(l => l.ref_id));
  const missed = new Set(s.ledger.filter(l => l.kind === "observe" && l.summary.startsWith("event expedite_failed")).map(l => l.ref_id));
  const out: { po: string; order: string }[] = [];
  for (const l of s.ledger) {
    if (l.kind !== "propose" || l.ref_type !== "action" || !executed.has(l.ref_id) || !l.detail) continue;
    try {
      const d = JSON.parse(l.detail); const lever = d?.lever;
      if (lever?.type === "expedite_po" && typeof lever.po_id === "string" && !missed.has(lever.po_id) && !out.some(x => x.po === lever.po_id)) out.push({ po: lever.po_id, order: /on (\S+) \(/.exec(l.summary)?.[1] ?? "" });
    } catch { /* not a lever row */ }
  }
  return out;
}

export function Simulator({ s, owner, act }: { s: State; owner: boolean; act: Act }) {
  const world = worldOf(s);
  const arc = world === "earned_autonomy";
  const { list, next } = arc ? arcSteps(s) : steps(s);
  const expedited = arc ? [] : expeditedPOs(s);   // in the arc, step 11 is the miss; the generic buttons would only add noise
  const done = arc ? <>Arc complete: the shape earned autonomy, used it once, and lost it. Charter v{s.charter.version}. <b>Reset</b> to run it again.</> : <>Scenario complete. <b>Reset</b> to run it again.</>;
  return <div className="dock" role="region" aria-label="Scenario controls">
    <div className="inner">
      <div className="top">
        <span className="label"><b>Outside world</b> and the org's own clocks, in demo order{arc ? <>: <b>earned autonomy</b>, the arc the trial grades</> : ""}</span>
        <span className="spacer" />
        <span className="next">{!owner ? "Viewer: the world's events and decisions need the owner." : next === 0 ? done : ""}</span>
        <span className="label" style={{ marginLeft: 8 }}>World</span>
        <button className={`btn small ${!arc ? "primary" : "quiet"}`} onClick={act("/reset", { world: "baseline" })} disabled={s.busy || !owner} title="Reseed the baseline World (three orders hit by one slip) and restore the Charter">Baseline</button>
        <button className={`btn small ${arc ? "primary" : "quiet"}`} onClick={act("/reset", { world: "earned_autonomy" })} disabled={s.busy || !owner} title="Reseed with three extra $25k Ironline orders so one shape can earn autonomy, use it, and lose it; restores the Charter">Earned autonomy</button>
      </div>
      <div className="group">
        {list.map(st => {
          const isNext = st.n === next;
          if (st.who === "you") return <span key={st.n} className={`hint ${isNext ? "next" : ""}`}><span className="n" aria-hidden="true" style={{ fontSize: 11, border: "1px solid currentColor", borderRadius: "50%", width: 16, height: 16, display: "inline-grid", placeItems: "center" }}>{st.n}</span>{st.label}</span>;
          if (st.per) return st.per.length
            ? st.per.map(id => <button key={st.n + id} className={`btn ${isNext ? "primary" : ""}`} disabled={s.busy || (st.ownerOnly && !owner)} onClick={act(st.path!, { order_id: id })}><span className="n" aria-hidden="true">{st.n}</span>{st.label} ({id})</button>)
            : <button key={st.n} className="btn" disabled title="Appears when an order is waiting on a customer"><span className="n" aria-hidden="true">{st.n}</span>{st.label}</button>;
          return <button key={st.n} className={`btn ${isNext ? "primary" : ""}`} disabled={s.busy || (st.ownerOnly && !owner)} onClick={act(st.path!, st.body)} title={st.who === "world" ? "Stands in for the outside world" : "Runs the agent seat"}><span className="n" aria-hidden="true">{st.n}</span>{st.label}</button>;
        })}
      </div>
      {expedited.length > 0 && <div className="group">
        {expedited.map(x => <button key={x.po} className="btn" disabled={s.busy || !owner} title={`The supplier misses the Fast Track date on ${x.po}. ${x.order} goes late again; the trust ledger records the failure.`} onClick={act("/events/expedite-miss", { po_id: x.po })}>Supplier misses Fast Track on {x.po}</button>)}
      </div>}
    </div>
  </div>;
}
