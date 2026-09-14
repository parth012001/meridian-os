import { usd, type State } from "../api";

// The hero: the outcome sentence humans wrote, the one number it is measured by, and where the org stands right now.
export function Outcome({ s }: { s: State }) {
  const k = s.kpis; const c = s.charter;
  const pct = Math.round(k.projected_on_time_rate * 100);
  const targetText = c.kpis.on_time_rate?.target ?? ">= 0.95";
  const target = Math.round(parseFloat(targetText.replace(/[^\d.]/g, "")) * 100) || 95;
  const tone = pct >= target ? "ok" : k.at_risk ? "bad" : "";
  const tasks = s.board.filter(o => o.task);
  const recovered = tasks.filter(o => o.task!.outcome === "recovered").length;
  const pending = s.approvals.filter(a => a.status === "pending").length;
  const waitingCustomer = tasks.filter(o => o.task!.status === "awaiting_customer").length;
  const proposals = s.proposals.filter(p => p.status === "proposed").length;

  return <section className="outcome" aria-label="Outcome">
    <div>
      <h2 className="statement"><span className="id">{c.outcome.id.replace(/_/g, " ")}</span>{c.outcome.statement.trim()}</h2>
      <p className="status">
        {k.at_risk ? <><b>{k.at_risk} {k.at_risk === 1 ? "order" : "orders"}</b> will miss {k.at_risk === 1 ? "its" : "their"} promise date ({usd(k.revenue_at_risk)}). </> : <>Every open order is on its promise date. </>}
        {recovered > 0 && <><b>{recovered}</b> recovered for <b>{usd(k.recovery_cost)}</b>. </>}
        {pending > 0 && <span className="needs">{pending} {pending === 1 ? "decision waits" : "decisions wait"} on you. </span>}
        {waitingCustomer > 0 && <>{waitingCustomer} {waitingCustomer === 1 ? "order waits" : "orders wait"} on a customer reply. </>}
        {proposals > 0 && <span className="needs">{proposals} Charter {proposals === 1 ? "proposal" : "proposals"} to merge or reject. </span>}
      </p>
    </div>
    <div className="gauge">
      <div className={`n ${tone}`}><b>{pct}%</b><span>projected on time</span></div>
      <div className="bar" role="img" aria-label={`${pct} percent projected on time, target ${target}`}>
        <div className={`fill ${tone}`} style={{ width: `${pct}%` }} />
        <div className="target" style={{ left: `${target}%` }} data-label={`target ${target}%`} />
      </div>
      <div className="kpis">
        <div><b>{k.open_orders}</b>open orders</div>
        <div><b className={k.at_risk ? "bad" : ""}>{k.at_risk}</b>at risk</div>
        <div><b className={k.revenue_protected ? "ok" : ""}>{usd(k.revenue_protected)}</b>revenue protected</div>
        <div><b>{usd(k.recovery_cost)}</b>recovery spend</div>
      </div>
    </div>
  </section>;
}
