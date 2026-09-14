import { clock, words, type State } from "../api";

export function Outbox({ s }: { s: State }) {
  return <section className="panel" aria-label="Outbox">
    <div className="head"><h2>Customer messages</h2><span className="sub">what left the building</span></div>
    {s.messages.length === 0 && <div className="empty">No messages yet. Status updates send on their own; delay notices and substitution requests wait for you.</div>}
    {s.messages.map(m => <details key={m.id} className="msg">
      <summary><span className={`stamp ${m.status === "sent" ? "ok" : m.status === "blocked" ? "bad" : "warn"}`}>{m.status}</span><b>{words(m.kind)}</b><span className="mute small">to {m.to_contact}</span><span className="subj">{m.subject}</span><span className="mute small id">{clock(m.created_at)}</span></summary>
      <pre>{m.body}</pre>
    </details>)}
  </section>;
}
