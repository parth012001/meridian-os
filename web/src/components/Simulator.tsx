import type { Act } from "../App";
import type { State } from "../api";

type Step = { n: number; label: string; who: "world" | "org" | "you"; path?: string; body?: unknown; ownerOnly?: boolean; per?: string[] };

/** The demo is a real sequence, so the dock numbers it and points at whichever step the World is ready for. */
function steps(s: State): { list: Step[]; next: number } {
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
  const next = proposal ? 7 : pending ? 4 : awaiting.length ? 5 : openTasks ? 3 : atRiskNoTask ? 2 : settled ? (decidedProposal ? 0 : 6) : tasks.length === 0 && !s.board.some(o => o.days_late > 0) ? 1 : 3;
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
  const { list, next } = steps(s);
  const world = list.filter(x => x.who === "world");
  const expedited = expeditedPOs(s);
  return <div className="dock" role="region" aria-label="Scenario controls">
    <div className="inner">
      <div className="top">
        <span className="label"><b>Outside world</b> and the org's own clocks, in demo order</span>
        <span className="spacer" />
        <span className="next">{!owner && world.length ? "Viewer: the world's events and decisions need the owner." : next === 0 ? <>Scenario complete. <b>Reset world</b> to run it again.</> : ""}</span>
        <button className="btn quiet small" onClick={act("/reset")} disabled={s.busy || !owner} title="Reseed the World and restore the baseline Charter">Reset world</button>
      </div>
      <div className="group">
        {list.map(st => {
          const isNext = st.n === next;
          if (st.who === "you") return <span key={st.n} className={`hint ${isNext ? "next" : ""}`}><span className="n" style={{ fontSize: 11, border: "1px solid currentColor", borderRadius: "50%", width: 16, height: 16, display: "inline-grid", placeItems: "center" }}>{st.n}</span>{st.label}</span>;
          if (st.per) return st.per.length
            ? st.per.map(id => <button key={st.n + id} className={`btn ${isNext ? "primary" : ""}`} disabled={s.busy || (st.ownerOnly && !owner)} onClick={act(st.path!, { order_id: id })}><span className="n">{st.n}</span>{st.label} ({id})</button>)
            : <button key={st.n} className="btn" disabled title="Appears when an order is waiting on a customer"><span className="n">{st.n}</span>{st.label}</button>;
          return <button key={st.n} className={`btn ${isNext ? "primary" : ""}`} disabled={s.busy || (st.ownerOnly && !owner)} onClick={act(st.path!, st.body)} title={st.who === "world" ? "Stands in for the outside world" : "Runs the agent seat"}><span className="n">{st.n}</span>{st.label}</button>;
        })}
      </div>
      {expedited.length > 0 && <div className="group">
        {expedited.map(x => <button key={x.po} className="btn" disabled={s.busy || !owner} title={`The supplier misses the Fast Track date on ${x.po}. ${x.order} goes late again; the trust ledger records the failure.`} onClick={act("/events/expedite-miss", { po_id: x.po })}>Supplier misses Fast Track on {x.po}</button>)}
      </div>}
    </div>
  </div>;
}
