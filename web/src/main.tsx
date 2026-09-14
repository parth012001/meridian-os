import React, { useEffect, useState, useCallback } from "react";
import { createRoot } from "react-dom/client";

type State = any;
const api = async (path: string, body?: unknown, role = "owner") => {
  const r = await fetch(`/api${path}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-role": role }, body: body === undefined ? undefined : JSON.stringify(body) });
  return r.json();
};

function App() {
  const [s, setS] = useState<State | null>(null);
  const [role, setRole] = useState<"owner" | "viewer">("owner");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [charter, setCharter] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const refresh = useCallback(async () => setS(await api("/state")), []);
  useEffect(() => { refresh(); const i = setInterval(refresh, 1500); return () => clearInterval(i); }, [refresh]);
  if (!s) return <div style={{ padding: 20 }}>loading…</div>;
  const act = (p: string, b?: unknown) => async () => { const r = await api(p, b ?? {}, role); setErr(r?.error ?? null); refresh(); };
  const owner = role === "owner";
  const k = s.kpis; const c = s.charter;
  const pend = s.approvals.filter((a: any) => a.status === "pending");
  const color = (d: number) => d === 0 ? "g" : d < 4 ? "a" : "r";
  const awaitingConsent = s.board.filter((o: any) => o.task?.status === "awaiting_customer");

  return <>
    <header>
      <h1>{c.company} <span className="sub">· autonomous org control plane</span></h1>
      <span className={`badge ${s.mode.startsWith("live") ? "live" : ""}`}>{s.mode}</span>
      <span className="badge">Charter v{c.version}</span>
      {s.busy && <span className="badge">agent running…</span>}
      {err && <span className="badge" style={{ color: "var(--bad)" }} title="click to dismiss" onClick={() => setErr(null)}>{err}</span>}
      <span style={{ flex: 1 }} />
      <span className="mute">acting as</span>
      <select value={role} onChange={e => setRole(e.target.value as any)} style={{ background: "#232838", color: "#fff", border: "1px solid #333", borderRadius: 6, padding: 4 }}>
        <option value="owner">owner (human)</option><option value="viewer">viewer</option>
      </select>
    </header>
    <main>
      <div className="kpis">
        <div className="kpi"><b>{k.open_orders}</b><span>open orders</span></div>
        <div className="kpi"><b style={{ color: k.at_risk ? "var(--bad)" : "var(--ok)" }}>{k.at_risk}</b><span>at risk</span></div>
        <div className="kpi"><b>{Math.round(k.projected_on_time_rate * 100)}%</b><span>projected on-time (target ≥95%)</span></div>
        <div className="kpi"><b>${k.revenue_at_risk.toLocaleString()}</b><span>revenue at risk</span></div>
        <div className="kpi"><b style={{ color: "var(--ok)" }}>${k.revenue_protected.toLocaleString()}</b><span>revenue protected</span></div>
        <div className="kpi"><b>${k.recovery_cost.toLocaleString()}</b><span>recovery spend</span></div>
      </div>

      <section className="wide">
        <h2>Scenario controls</h2>
        <div className="row">
          <button onClick={act("/reset")} disabled={s.busy || !owner}>↺ Reset world</button>
          <button className="primary" onClick={act("/events/slip", { supplier_id: "SUP_IRON", category: "frame", days: 10, note: "Ironline PO ack variance" })} disabled={s.busy || !owner}>⚡ Inject event: Ironline frames slip +10d</button>
          <button onClick={act("/watch")} disabled={s.busy}>👁 Run Ops Manager (watch cycle)</button>
          <button onClick={act("/work")} disabled={s.busy}>🔧 Expeditor: work open tasks</button>
          {awaitingConsent.map((o: any) => <button key={o.id} onClick={act("/customer/consent", { order_id: o.id })} disabled={s.busy || !owner}>✉️ Customer replies YES ({o.id})</button>)}
          <button onClick={act("/review")} disabled={s.busy}>📈 Run weekly Reviewer</button>
          <button onClick={async () => setCharter(charter ? null : await (await fetch("/api/charter/raw")).text())}>{charter ? "hide" : "view"} org.yaml</button>
        </div>
        {charter && <pre className="mono" style={{ marginTop: 8, maxHeight: 300, overflow: "auto" }}>{charter}</pre>}
      </section>

      <section>
        <h2>Order board · {c.outcome.id}</h2>
        <table><thead><tr><th></th><th>order</th><th>project</th><th>promise</th><th>value</th><th>late</th><th>task</th></tr></thead><tbody>
          {s.board.map((o: any) => <tr key={o.id}>
            <td><span className={`dot ${color(o.days_late)}`} /></td><td className="mono">{o.id}</td><td>{o.project_name}<div className="mute" style={{ fontSize: 11 }}>{o.reasons[0]}</div></td>
            <td className="mono">{o.promise_date}</td><td>${o.order_value.toLocaleString()}</td><td>{o.days_late ? `${o.days_late}d` : "—"}</td>
            <td>{o.task ? <span className="badge">{o.task.status}{o.task.outcome ? ` · ${o.task.outcome}` : ""}</span> : ""}</td>
          </tr>)}
        </tbody></table>
      </section>

      <section>
        <h2>Owner inbox · {pend.length} pending</h2>
        {pend.length === 0 && <div className="mute">Nothing waiting on you.</div>}
        {s.approvals.map((a: any) => <div key={a.id} className={`ap ${a.status !== "pending" ? "done" : ""}`}>
          <div className="row"><b>{a.kind.replace(/_/g, " ")}</b><span className="mono">{a.order_id}</span><span className="badge">gate: {a.gate_rule}</span><span className="badge">${a.cost_usd}</span><span style={{ flex: 1 }} /><span className="badge">{a.status}</span></div>
          <div style={{ margin: "4px 0" }}>{a.summary}</div>
          <div className="mute" style={{ fontSize: 11 }}>agent rationale: {a.rationale}</div>
          {a.status === "pending" && role === "owner" && <div className="row" style={{ marginTop: 6 }}>
            <input placeholder="note (optional)" value={notes[a.id] ?? ""} onChange={e => setNotes({ ...notes, [a.id]: e.target.value })} style={{ width: 260 }} />
            <button className="primary" disabled={s.busy} onClick={act(`/approvals/${a.id}`, { decision: "approved", note: notes[a.id] })}>Approve</button>
            <button className="danger" disabled={s.busy} onClick={act(`/approvals/${a.id}`, { decision: "rejected", note: notes[a.id] })}>Reject</button>
          </div>}
          {a.status === "pending" && role !== "owner" && <div className="mute">switch to owner to decide</div>}
          {a.note && <div className="mute">note: {a.note}</div>}
        </div>)}
        <h2 style={{ marginTop: 12 }}>Charter proposals</h2>
        {s.proposals.length === 0 && <div className="mute">Reviewer has not proposed anything yet.</div>}
        {s.proposals.map((p: any) => <div key={p.id} className={`ap ${p.status !== "proposed" ? "done" : ""}`}>
          <div className="row"><b>{p.summary}</b><span style={{ flex: 1 }} /><span className="badge">{p.status}</span></div>
          <div className="mute">{p.evidence}</div><pre className="mono">{p.patch}</pre>
          {p.status === "proposed" && role === "owner" && <div className="row" style={{ marginTop: 6 }}>
            <button className="primary" onClick={act(`/proposals/${p.id}`, { decision: "merge" })}>Merge into Charter</button>
            <button className="danger" onClick={act(`/proposals/${p.id}`, { decision: "reject" })}>Reject</button></div>}
        </div>)}
      </section>

      <section>
        <h2>Organization · roles from org.yaml</h2>
        <div className="org">
          {Object.entries<any>(c.roles).map(([id, r]) => <div key={id} className={`role ${r.kind} ${r.status ?? ""}`}>
            <b>{r.title}</b><span className="mute">{r.kind === "human" ? "human · escalation terminus" : `${r.status} · ${r.horizon ?? ""}`}</span>
            {r.kind === "agent" && r.status === "live" && <div className="mute" style={{ fontSize: 11 }}>spend ≤ ${r.authority.spend_usd} · may: {r.authority.may.join(", ") || "—"}</div>}
            <div className="mono mute" style={{ fontSize: 10 }}>{(r.tools ?? []).join(" · ")}</div>
          </div>)}
        </div>
        <h2 style={{ marginTop: 12 }}>Outbox · customer messages</h2>
        {s.messages.map((m: any) => <details key={m.id}><summary><span className="badge">{m.status}</span> <b>{m.kind}</b> → {m.to_contact} · {m.subject}</summary><pre>{m.body}</pre></details>)}
      </section>

      <section>
        <h2>Ledger · every observation, decision, gate verdict, action</h2>
        <div className="ledger">
          {s.ledger.map((l: any) => <div key={l.id}><span className="mono mute">{l.ts.slice(11, 19)}</span><span className="mono">{l.role}</span><span className={l.kind}>{l.kind}</span><span>{l.charter_rule && <span className="rule mono">[{l.charter_rule}] </span>}{l.summary}</span></div>)}
        </div>
      </section>
    </main>
  </>;
}
createRoot(document.getElementById("root")!).render(<App />);
