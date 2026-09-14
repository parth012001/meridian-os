import { Fragment, useEffect, useState } from "react";
import { usd, words, type BoardRow, type Lever, type State } from "../api";

interface Recovery { lever: string; cost: number }

/** What actually ran on each order, read from the ledger's execute rows (the ledger is the record; agents do not report this). */
function recoveries(s: State): Record<string, Recovery[]> {
  const out: Record<string, Recovery[]> = {};
  for (const l of [...s.ledger].reverse()) {
    if (l.kind !== "execute") continue;
    const m = /^executed (\w+) on (\S+) \(\$([\d.,]+)\)/.exec(l.summary); if (!m) continue;
    (out[m[2]] ??= []).push({ lever: m[1], cost: Number(m[3].replace(/,/g, "")) });
  }
  return out;
}

function taskTone(o: BoardRow) {
  const t = o.task;
  if (!t) return o.days_late ? "bad" : "ok";
  if (t.status === "resolved" && t.outcome === "recovered") return "ok";
  if (t.status === "escalated" || (t.outcome ?? "").includes("failed")) return "bad";
  return o.days_late ? (t.status === "open" ? "bad" : "warn") : "ok";
}
const taskLabel = (o: BoardRow) => o.task ? `${words(o.task.status)}${o.task.outcome ? `, ${words(o.task.outcome)}` : ""}` : "";

function Drawer({ id }: { id: string }) {
  const [levers, setLevers] = useState<Lever[] | null>(null);
  useEffect(() => { let on = true; fetch(`/api/orders/${id}/levers`).then(r => r.json()).then(l => { if (on) setLevers(l); }); return () => { on = false; }; }, [id]);
  if (!levers) return <span className="mute small">Reading levers…</span>;
  if (!levers.length) return <span className="mute small">No levers: nothing on this order is late.</span>;
  return <div className="levers">
    <div className="mute small" style={{ marginBottom: 4 }}>Levers the Expeditor can reach for, cheapest first. Struck ones do not close the gap.</div>
    {[...levers].sort((a, b) => Number(b.closes_gap) - Number(a.closes_gap) || a.cost_usd - b.cost_usd).map((l, i) => <div className="lever" key={i}>
      <span className={`t ${l.closes_gap ? "" : "no"}`}>{words(l.type)}</span>
      <span>{usd(l.cost_usd)}</span>
      <span className="note">{l.requires !== "nothing" && <span className="stamp rule" style={{ marginRight: 6 }}>{l.requires}</span>}{l.touches.length > 0 && <span className="mute">touches {l.touches.join(", ")} · </span>}{l.note}</span>
    </div>)}
  </div>;
}

export function Board({ s }: { s: State }) {
  const [open, setOpen] = useState<string | null>(null);
  const rec = recoveries(s);
  const atRisk = s.board.filter(o => o.days_late > 0).length;
  return <section className="panel board" aria-label="Order board">
    <div className="head"><h2>Open orders</h2><span className="sub">{atRisk ? `${atRisk} at risk of missing their promise date` : "all on their promise date"} · click an order for its levers</span></div>
    <div className="tablewrap">
      <table>
        <thead><tr><th>order</th><th>project</th><th>promise</th><th className="num">value</th><th className="num">late</th><th>recovery</th><th>task</th></tr></thead>
        <tbody>
          {s.board.map(o => {
            const tone = taskTone(o); const r = rec[o.id] ?? []; const isOpen = open === o.id;
            return <Fragment key={o.id}>
              <tr className={`order ${isOpen ? "open" : ""}`} onClick={() => setOpen(isOpen ? null : o.id)} tabIndex={0} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(isOpen ? null : o.id); } }} aria-expanded={isOpen}>
                <td className="nowrap"><span className={`mark ${tone}`} aria-hidden="true" /><span className="id">{o.id}</span></td>
                <td><div className="proj">{o.project_name}</div>{o.reasons[0] && <div className="reason narrow">{o.reasons[0]}</div>}</td>
                <td className="id nowrap">{o.promise_date}</td>
                <td className="num nowrap">{usd(o.order_value)}</td>
                <td className={`num nowrap ${o.days_late ? "" : "mute"}`}>{o.days_late ? `${o.days_late}d` : "on time"}</td>
                <td className="recovery">{r.length ? r.map((x, i) => <div key={i}><b>{words(x.lever)}</b> for {usd(x.cost)}</div>) : ""}</td>
                <td>{o.task && <span className={`stamp ${tone === "ok" ? "ok" : tone === "bad" ? "bad" : "warn"}`}>{taskLabel(o)}</span>}</td>
              </tr>
              {isOpen && <tr className="drawer"><td colSpan={7}><Drawer id={o.id} /></td></tr>}
            </Fragment>;
          })}
        </tbody>
      </table>
    </div>
  </section>;
}
