import { useState } from "react";
import type { Act } from "../App";
import { usd, words, type Approval, type Charter, type Proposal, type Replay, type State } from "../api";
import { jumpToRule } from "./CharterPanel";

const RuleStamp = ({ id }: { id: string | null }) => id ? <button className="stamp rule" title="show this rule" onClick={() => jumpToRule(id)}>{id}</button> : null;

function ApprovalCard({ a, owner, busy, act }: { a: Approval; owner: boolean; busy: boolean; act: Act }) {
  const [note, setNote] = useState("");
  const pending = a.status === "pending";
  return <div className={`card ${pending ? "pending" : "done"}`}>
    <div className="top">
      <span className="title">{words(a.kind)}</span>
      <span className="id">{a.order_id}</span>
      <RuleStamp id={a.gate_rule} />
      <span className="stamp">{usd(a.cost_usd)}</span>
      <span className="spacer" />
      <span className={`stamp ${a.status === "approved" ? "ok" : a.status === "rejected" ? "bad" : "warn"}`}>{a.status}</span>
    </div>
    <div className="body">{a.summary}</div>
    {a.rationale && <div className="why"><b>Agent's reasoning</b> {a.rationale}</div>}
    {pending && owner && <div className="decide">
      <input placeholder="Note for the ledger (optional)" value={note} onChange={e => setNote(e.target.value)} aria-label="Decision note" />
      <button className="btn approve" disabled={busy} onClick={act(`/approvals/${a.id}`, { decision: "approved", note })}>Approve</button>
      <button className="btn reject" disabled={busy} onClick={act(`/approvals/${a.id}`, { decision: "rejected", note })}>Reject</button>
    </div>}
    {pending && !owner && <div className="why">Switch to owner to decide.</div>}
    {a.note && <div className="why"><b>Note</b> {a.note}</div>}
  </div>;
}

/** Flatten a JSON patch like {"roles":{"expeditor":{"authority":{"spend_usd":450}}}} into [path, newValue] pairs and read the current value at each path. */
function diffLines(patch: string, charter: Charter): { path: string; before: unknown; after: unknown }[] {
  let obj: unknown; try { obj = JSON.parse(patch); } catch { return []; }
  const out: { path: string; before: unknown; after: unknown }[] = [];
  const walk = (node: unknown, cur: unknown, path: string[]) => {
    if (node && typeof node === "object" && !Array.isArray(node)) {
      for (const [k, v] of Object.entries(node)) walk(v, cur && typeof cur === "object" ? (cur as Record<string, unknown>)[k] : undefined, [...path, k]);
    } else out.push({ path: path.join("."), before: cur, after: node });
  };
  walk(obj, charter, []);
  return out;
}
const show = (v: unknown) => v === undefined ? "unset" : typeof v === "object" ? JSON.stringify(v) : String(v);

/** The replay is the backend's terraform-plan for authority: the same gate, run over past decisions under the patched Charter. */
function ReplayView({ r }: { r: Replay | null | undefined }) {
  if (!r) return null;
  const asked = r.rows.filter(x => x.decision === "approved" && x.before_verdict === "approve").length;
  const flag = r.rejected_would_have_executed > 0;
  const parkedUnder = [...new Set(r.rows.filter(x => !x.flips && x.after_verdict === "approve").map(x => x.after_rule))].join(", ");
  return <div className={`replay ${flag ? "flag" : ""}`}>
    <div>Under this change, <b>{r.would_have_auto_executed}</b> of {asked} past {asked === 1 ? "approval" : "approvals"} ({usd(r.total_usd)}) would have executed without you.
      {r.still_parked > 0 && <> {r.still_parked} would still park under {parkedUnder}.</>}
      {flag && <> <b>{r.rejected_would_have_executed} you rejected would have executed too.</b></>}
    </div>
    {r.rows.length > 0 && <details className="decided"><summary>{r.rows.length} past {r.rows.length === 1 ? "decision" : "decisions"} replayed</summary>
      <div className="tablewrap"><table>
        <thead><tr><th>order</th><th>action</th><th className="num">cost</th><th>you said</th><th>gate now</th><th>gate after</th></tr></thead>
        <tbody>{r.rows.map(x => <tr key={x.action_id}>
          <td className="id">{x.order_id}</td><td>{words(x.type)}</td><td className="num">{usd(x.cost_usd)}</td>
          <td>{x.decision}</td>
          <td><span className="id">{x.before_verdict}</span> <span className="mute small">{x.before_rule}</span></td>
          <td><span className={`id ${x.flips ? "" : "mute"}`} style={x.flips ? { fontWeight: 600 } : undefined}>{x.after_verdict}</span> <span className="mute small">{x.after_rule}</span></td>
        </tr>)}</tbody>
      </table></div>
    </details>}
  </div>;
}

function ProposalCard({ p, owner, busy, act, charter }: { p: Proposal; owner: boolean; busy: boolean; act: Act; charter: Charter }) {
  const open = p.status === "proposed";
  const lines = diffLines(p.patch, charter);
  return <div className={`card ${open ? "pending" : "done"}`}>
    <div className="top">
      <span className="title">{p.summary}</span>
      <span className="spacer" />
      {p.proposed_by && <span className="stamp quiet">by {p.proposed_by === "trust" ? "trust ledger" : words(p.proposed_by)}</span>}
      {p.replay?.streak && <span className="stamp" title={p.replay.streak.shape}>{p.replay.streak.streak}/{p.replay.streak.threshold} clean approvals</span>}
      <span className={`stamp ${p.status === "merged" ? "ok" : p.status === "rejected" ? "bad" : "warn"}`}>{p.status}</span>
    </div>
    {lines.length > 0
      ? <div className="diff">{lines.map(l => <span key={l.path} style={{ display: "contents" }}><span className="path">{l.path}</span><span className="old">{open ? show(l.before) : ""}</span><span className="mute">{open ? "→" : p.status === "merged" ? "now" : "stays"}</span><span className="new">{open || p.status === "merged" ? show(l.after) : show(l.before)}</span></span>)}</div>
      : <pre className="small">{p.patch}</pre>}
    <div className="why"><b>Evidence</b> {p.replay ? p.evidence.replace(/\s*Under this change[^]*$/, "") : p.evidence}</div>
    <ReplayView r={p.replay} />
    {open && owner && <div className="decide">
      <button className="btn approve" disabled={busy} onClick={act(`/proposals/${p.id}`, { decision: "merge" })}>Merge into Charter</button>
      <button className="btn reject" disabled={busy} onClick={act(`/proposals/${p.id}`, { decision: "reject" })}>Reject</button>
    </div>}
    {open && !owner && <div className="why">Switch to owner to decide.</div>}
  </div>;
}

export function Desk({ s, owner, act }: { s: State; owner: boolean; act: Act }) {
  const pending = s.approvals.filter(a => a.status === "pending");
  const decided = s.approvals.filter(a => a.status !== "pending");
  const open = s.proposals.filter(p => p.status === "proposed");
  const closed = s.proposals.filter(p => p.status !== "proposed");
  return <section className="panel" aria-label="Owner's desk">
    <div className="head"><h2>{owner ? "Your desk" : "Owner's desk"}</h2><span className="sub">{pending.length ? `${pending.length} waiting on you` : "nothing waiting on you"}</span></div>
    {pending.length === 0 && <div className="empty">Agents are working inside their authority. Anything the Charter routes to a human lands here.</div>}
    {pending.map(a => <ApprovalCard key={a.id} a={a} owner={owner} busy={s.busy} act={act} />)}
    {decided.length > 0 && <details className="decided"><summary>{decided.length} decided</summary>{decided.map(a => <ApprovalCard key={a.id} a={a} owner={owner} busy={s.busy} act={act} />)}</details>}

    <div className="head" style={{ marginTop: 18 }}><h2>Charter proposals</h2><span className="sub">agents propose, only you merge</span></div>
    {open.length === 0 && closed.length === 0 && <div className="empty">Nothing proposed yet. The weekly Reviewer files one change with evidence from the ledger.</div>}
    {open.map(p => <ProposalCard key={p.id} p={p} owner={owner} busy={s.busy} act={act} charter={s.charter} />)}
    {closed.length > 0 && <details className="decided"><summary>{closed.length} decided</summary>{closed.map(p => <ProposalCard key={p.id} p={p} owner={owner} busy={s.busy} act={act} charter={s.charter} />)}</details>}
  </section>;
}
