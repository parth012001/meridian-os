import { useMemo, useState } from "react";
import { clock, words, type LedgerRow, type State } from "../api";
import { jumpToRule } from "./CharterPanel";

const FILTERS: Record<string, string[] | null> = {
  everything: null,
  decisions: ["gate", "approve", "reject", "charter_change"],
  actions: ["propose", "execute", "outcome", "message"],
  problems: ["error"],
};
const FOLDED = new Set(["tool_call", "llm"]);

interface Block { role: string; ts: string; rows: LedgerRow[] }

/** Consecutive rows from the same role read as one block (one run, one watch cycle, one owner decision). Rows arrive newest first. */
function blocks(rows: LedgerRow[]): Block[] {
  const out: Block[] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    // The gate's verdict belongs to the run that proposed the action, so a gate row never starts its own block.
    if (last && (last.role === r.role || r.role === "gate")) last.rows.push(r);
    else if (last && last.role === "gate") { last.role = r.role; last.rows.push(r); }
    else out.push({ role: r.role, ts: r.ts, rows: [r] });
  }
  return out;
}

function Entry({ l }: { l: LedgerRow }) {
  // "gate: DENY ... [C2] reason" already carries the rule inline; strip the bracket so the stamp is the one place it appears.
  const text = l.charter_rule ? l.summary.replace(` [${l.charter_rule}]`, "") : l.summary;
  return <div className={`entry ${l.kind}`}>
    <span className="kind">{words(l.kind)}</span>
    <span className="what">{l.charter_rule && <button className="stamp rule" style={{ marginRight: 6 }} title="show this rule" onClick={() => jumpToRule(l.charter_rule!)}>{l.charter_rule}</button>}{text}{l.on_behalf_of && <span className="mute"> (for {l.on_behalf_of})</span>}</span>
  </div>;
}

function BlockView({ b }: { b: Block }) {
  const shown = b.rows.filter(r => !FOLDED.has(r.kind));
  const folded = b.rows.filter(r => FOLDED.has(r.kind));
  return <div className="block">
    <div className="who"><b>{words(b.role)}</b><span className="ts">{clock(b.ts)}</span></div>
    {shown.map(l => <Entry key={l.id} l={l} />)}
    {folded.length > 0 && <details className="fold"><summary>{folded.length} tool {folded.length === 1 ? "call" : "calls"}</summary>{folded.map(l => <Entry key={l.id} l={l} />)}</details>}
  </div>;
}

export function Ledger({ s }: { s: State }) {
  const [filter, setFilter] = useState<keyof typeof FILTERS>("everything");
  const rows = useMemo(() => { const k = FILTERS[filter]; return k ? s.ledger.filter(l => k.includes(l.kind)) : s.ledger; }, [s.ledger, filter]);
  const groups = useMemo(() => blocks(rows), [rows]);
  return <section className="panel" aria-label="Ledger">
    <div className="head"><h2>Ledger</h2><span className="sub">every observation, verdict, approval and action, newest first</span><span className="spacer" />
      <div className="filters" role="tablist">{Object.keys(FILTERS).map(f => <button key={f} role="tab" aria-selected={filter === f} className={`stamp ${filter === f ? "" : "quiet"}`} onClick={() => setFilter(f)}>{f}</button>)}</div>
    </div>
    <div className="ledger">
      {groups.length === 0 && <div className="empty">Nothing recorded yet.</div>}
      {groups.map((b, i) => <BlockView key={`${b.rows[0].id}-${i}`} b={b} />)}
    </div>
  </section>;
}
