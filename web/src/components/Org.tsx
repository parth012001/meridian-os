import { usd, type CharterRole, type State } from "../api";

function Seat({ id, r }: { id: string; r: CharterRole }) {
  const live = r.kind === "agent" && r.status === "live";
  return <div className={`seat ${r.kind} ${r.status ?? ""}`}>
    <span className="t">{r.title}<span className="k">{r.kind === "human" ? "human" : r.status}{r.horizon ? `, ${r.horizon}` : ""}</span></span>
    <span className="mute small id">{id}</span>
    {r.kind === "human" && <span className="auth">Escalation terminus. Approves: {(r.approves ?? []).map(a => a.replace(/_/g, " ")).join(", ")}.</span>}
    {live && <span className="auth">Spend up to {usd(r.authority.spend_usd)}. May {r.authority.may.length ? r.authority.may.map(a => a.replace(/_/g, " ")).join(", ") : "not act"}{r.authority.recommend_only.length ? `; recommends ${r.authority.recommend_only.map(a => a.replace(/_/g, " ")).join(", ")}` : ""}{r.authority.may_not.length ? `; never ${r.authority.may_not.map(a => a.replace(/_/g, " ")).join(", ")}` : ""}.</span>}
    {r.tools.length > 0 && <span className="tools">{r.tools.join("  ")}</span>}
  </div>;
}

export function Org({ s }: { s: State }) {
  const roles = Object.entries(s.charter.roles);
  const order = (r: CharterRole) => r.kind === "human" ? 0 : r.status === "live" ? 1 : 2;
  const sorted = [...roles].sort((a, b) => order(a[1]) - order(b[1]));
  const live = roles.filter(([, r]) => r.kind === "agent" && r.status === "live").length;
  const declared = roles.filter(([, r]) => r.status === "declared").length;
  return <section className="panel" aria-label="Organization">
    <div className="head"><h2>Seats</h2><span className="sub">1 human, {live} live agents, {declared} declared</span></div>
    <div className="seats">{sorted.map(([id, r]) => <Seat key={id} id={id} r={r} />)}</div>
  </section>;
}
