import { Fragment, useState } from "react";
import { usd, words, type AutonomyLevel, type State, type TrustRow } from "../api";

const RUNG: Record<AutonomyLevel, number> = { observe: 0, recommend: 1, act: 2, act_within_limit: 2, act_if_ship_policy_allows: 2 };

/** Scroll to the Charter line a ledger stamp cites and flash it: C1..C5 go to the hard rules, everything else (ROLE.*, AUTONOMY.*, TRUST.*, DEMOTION) to the ladder. */
export function jumpToRule(id: string) {
  const el = document.getElementById(/^C\d+$/.test(id) ? `rule-${id}` : "ladder");
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

const shapeLabel = (t: TrustRow) => t.shape.includes(":") ? t.shape.slice(t.shape.indexOf(":") + 1) : "any supplier";

/** One line per shape: streak pips toward the threshold, and the status once it has moved off supervised. */
function Trust({ rows, threshold }: { rows: TrustRow[]; threshold?: number }) {
  if (!rows.length) {
    if (threshold === undefined) return <span className="trust" />;
    return <span className="trust mute">{threshold >= 99 ? "never automatic" : `after ${threshold} clean approvals`}</span>;
  }
  return <span className="trust" style={{ flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
    {rows.map(t => {
      const max = Math.min(t.threshold, 12);
      return <span key={t.shape} style={{ display: "inline-flex", alignItems: "center", gap: 6 }} title={`${t.shape}: ${t.total_approved} approved, ${t.total_rejected} rejected, ${t.total_failed} failed, ${t.total_autonomous} ran on their own`}>
        <span className="id">{shapeLabel(t)}</span>
        {t.status === "demoted" && <span className="stamp bad">demoted</span>}
        {t.status === "autonomous" && <span className="stamp ok">earned</span>}
        {t.status === "proposed" && <span className="stamp warn">proposed</span>}
        {t.threshold >= 99 ? <span>never automatic</span> : <><span className="pips" aria-hidden="true">{Array.from({ length: max }, (_, i) => <i key={i} className={i < t.streak ? "on" : t.total_rejected || t.total_failed ? "reset" : ""} />)}</span>{t.streak}/{t.threshold}</>}
      </span>;
    })}
  </span>;
}

export function CharterPanel({ s }: { s: State }) {
  const [yaml, setYaml] = useState<string | null>(null);
  const c = s.charter;
  const levels = Object.entries(c.autonomy_levels) as [string, AutonomyLevel][];
  const thresholds = c.trust?.thresholds ?? {};
  const trust = s.trust ?? [];
  const hasTrust = trust.length > 0 || Object.keys(thresholds).length > 0;

  return <section className="panel" aria-label="Charter">
    <div className="head"><h2>What agents may do</h2><span className="sub">from org.yaml, per action class</span><span className="spacer" />
      <button className="btn quiet small" onClick={async () => setYaml(yaml ? null : await (await fetch("/api/charter/raw")).text())}>{yaml ? "Hide org.yaml" : "Show org.yaml"}</button>
    </div>
    <div className="ladder" id="ladder" role="table" aria-label="Autonomy per action class">
      <span className="hdr">action</span>
      <span className="hdr track"><span>observe</span><span>recommend</span><span>act</span></span>
      <span className="hdr trusthdr">{hasTrust ? "trust earned" : ""}</span>
      {levels.map(([action, level]) => {
        const rung = RUNG[level] ?? 1;
        const rows = trust.filter(t => t.action_type === action);
        const cls = rows.some(t => t.status === "demoted") ? "demoted" : rows.some(t => t.status === "autonomous") ? "autonomous" : "";
        return <Fragment key={action}>
          <span className="cls">{words(action)}<span className="q">{qualifier(s, action, level)}</span></span>
          <span className={`track ${cls}`} title={level}>
            <span className="rail" />
            <span className="fill" style={{ width: `calc(${rung * 50}% - ${rung === 2 ? 12 : 6}px)` }} />
            {[0, 1, 2].map(i => <span key={i} className="stop" data-i={i} />)}
            <span className="here" style={{ left: `calc(${rung * 50}% - ${rung === 0 ? 2 : rung === 1 ? 8 : 14}px)` }} />
          </span>
          <Trust rows={rows} threshold={thresholds[action]} />
        </Fragment>;
      })}
    </div>
    {hasTrust && <p className="mute small" style={{ marginTop: 10, maxWidth: "60ch" }}>
      Trust is counted per action shape (type, per supplier). Clean approvals build a streak; at the threshold a Charter change is proposed with a replay; a rejection resets it{c.trust?.demote_on?.length ? `; ${c.trust.demote_on.map(words).join(" or ")} revokes it` : ""}.
    </p>}
    <ul className="rules" aria-label="Hard rules">
      {c.constraints.map(r => <li key={r.id} id={`rule-${r.id}`}><span className="stamp rule">{r.id}</span><span>{r.rule}</span></li>)}
    </ul>
    {yaml && <pre className="yaml">{yaml}</pre>}
  </section>;
}
