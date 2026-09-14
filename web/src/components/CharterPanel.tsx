import { Fragment, useState } from "react";
import { usd, words, type AutonomyLevel, type State, type TrustRow } from "../api";

const RUNG: Record<AutonomyLevel, number> = { observe: 0, recommend: 1, act: 2, act_within_limit: 2, act_if_ship_policy_allows: 2 };

/** Scroll the hard-rules list to a rule id and flash it. Used by the ledger's rule stamps. */
export function jumpToRule(id: string) {
  const el = document.getElementById(`rule-${id.split(".")[0]}`);
  if (!el) return;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.remove("hit"); void el.offsetWidth; el.classList.add("hit");
}

function qualifier(s: State, action: string, level: AutonomyLevel) {
  if (level === "act_within_limit") {
    const holder = Object.values(s.charter.roles).find(r => r.kind === "agent" && r.authority?.may?.includes(action));
    return holder ? `acts up to ${usd(holder.authority.spend_usd)}, owner above` : "acts within limit";
  }
  if (level === "act_if_ship_policy_allows") return "acts when the order's ship policy allows";
  if (level === "recommend") return "recommends, a human decides";
  if (level === "observe") return "observes only";
  return "acts on its own";
}

function Trust({ rows, action, threshold }: { rows: TrustRow[] | undefined; action: string; threshold?: number }) {
  const row = rows?.find(t => t.action_type === action) ?? null;
  const max = row?.threshold ?? threshold;
  if (!row && !max) return <span className="trust" />;
  const streak = row?.streak ?? 0; const n = Math.min(max ?? 0, 12);
  return <span className="trust" title={row ? `${row.total_approved} approved, ${row.total_rejected} rejected, ${row.total_failed} failed` : undefined}>
    {row?.status === "demoted" && <span className="stamp bad">demoted</span>}
    {row?.status === "autonomous" && <span className="stamp ok">earned</span>}
    {row?.status === "proposed" && <span className="stamp warn">proposed</span>}
    {max && max < 99 ? <><span className="pips" aria-hidden="true">{Array.from({ length: n }, (_, i) => <i key={i} className={i < streak ? "on" : ""} />)}</span>{streak}/{max}</> : <span>never automatic</span>}
  </span>;
}

export function CharterPanel({ s }: { s: State }) {
  const [yaml, setYaml] = useState<string | null>(null);
  const c = s.charter;
  const levels = Object.entries(c.autonomy_levels) as [string, AutonomyLevel][];
  const thresholds = c.trust?.thresholds ?? {};
  const hasTrust = !!(s.trust?.length || Object.keys(thresholds).length);

  return <section className="panel" aria-label="Charter">
    <div className="head"><h2>What agents may do</h2><span className="sub">from org.yaml, per action class</span><span className="spacer" />
      <button className="btn quiet small" onClick={async () => setYaml(yaml ? null : await (await fetch("/api/charter/raw")).text())}>{yaml ? "Hide org.yaml" : "Show org.yaml"}</button>
    </div>
    <div className="ladder" role="table" aria-label="Autonomy per action class">
      <span className="hdr">action</span>
      <span className="hdr track"><span>observe</span><span>recommend</span><span>act</span></span>
      <span className={`hdr trusthdr ${hasTrust ? "" : "mute"}`}>{hasTrust ? "trust" : ""}</span>
      {levels.map(([action, level]) => {
        const rung = RUNG[level] ?? 1;
        const trust = s.trust?.find(t => t.action_type === action);
        const cls = trust?.status === "demoted" ? "demoted" : trust?.status === "autonomous" ? "autonomous" : "";
        return <Fragment key={action}>
          <span className="cls">{words(action)}<span className="q">{qualifier(s, action, level)}</span></span>
          <span className={`track ${cls}`} title={level}>
            <span className="rail" />
            <span className="fill" style={{ width: `calc(${rung * 50}% - ${rung === 2 ? 12 : 6}px)` }} />
            {[0, 1, 2].map(i => <span key={i} className="stop" data-i={i} />)}
            <span className="here" style={{ left: `calc(${rung * 50}% - ${rung === 0 ? 2 : rung === 1 ? 8 : 14}px)` }} />
          </span>
          <Trust rows={s.trust} action={action} threshold={thresholds[action]} />
        </Fragment>;
      })}
    </div>
    <ul className="rules" aria-label="Hard rules">
      {c.constraints.map(r => <li key={r.id} id={`rule-${r.id}`}><span className="stamp rule">{r.id}</span><span>{r.rule}</span></li>)}
    </ul>
    {yaml && <pre className="yaml">{yaml}</pre>}
  </section>;
}
