import type { Act } from "../App";
import { clock, type State, type Trials } from "../api";

export function TrialsPanel({ s, trials, owner, act }: { s: State; trials: Trials | null; owner: boolean; act: Act }) {
  if (!trials) return null;
  const runAll = () => {
    if (!s.mode.startsWith("live") || confirm("Live mode: about 9 minutes and roughly 1.3M tokens. Every scenario resets the World and the Charter reverts to baseline. Continue?")) act("/trials/run", { n: 1 })();
  };
  return <section className="panel" aria-label="Trials">
    <div className="head"><h2>Trials</h2><span className="sub">the org on probation: same work repeated, graded by code, plus a few traps</span></div>
    <div className="scenarios">
      {trials.scenarios.map(sc => <button key={sc.id} className="btn" disabled={s.busy || !owner} title={sc.why} onClick={act("/trials/run", { only: sc.id, n: 1 })}>{sc.title}</button>)}
      <button className="btn primary" disabled={s.busy || !owner} onClick={runAll}>Run all</button>
      <span className="mute small">{owner ? "Each run resets the World, plays the owner and the customer, then grades the ledger." : "Switch to owner to run trials."}</span>
    </div>
    {trials.scorecard.length > 0 && <div className="tablewrap" style={{ marginBottom: 12 }}>
      <table>
        <thead><tr><th>scenario</th><th>mode</th><th className="num">reps</th><th className="num">passed</th><th className="num">aborted</th><th className="num">avg time</th><th className="num">tokens</th><th>checks failing</th></tr></thead>
        <tbody>{trials.scorecard.map(r => {
          const failing = Object.entries(r.checks).filter(([, v]) => v.pass < v.total);
          return <tr key={r.scenario + r.mode}>
            <td className="id">{r.scenario}</td><td className="id">{r.mode}</td><td className="num">{r.reps}</td>
            <td className="num"><b style={{ color: r.passed === r.reps ? "var(--green)" : "var(--primer)" }}>{r.passed}/{r.reps}</b></td>
            <td className="num mute" title="runs that threw (model call, network); not graded">{r.aborted || ""}</td>
            <td className="num">{(r.avg_ms / 1000).toFixed(1)}s</td><td className="num">{r.tokens.toLocaleString()}</td>
            <td className="mute small" style={{ overflowWrap: "anywhere" }}>{failing.length ? failing.map(([k, v]) => <div key={k}><span className="id">{k}</span> ({v.pass}/{v.total}): {v.lastFail}</div>) : "none"}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>}
    <div className="head"><h2 style={{ fontSize: 14 }}>Recent runs</h2></div>
    {trials.recent.length === 0 && <div className="empty">No trials yet. Run one.</div>}
    {trials.recent.map(t => <details key={t.id} className="run">
      <summary>
        <span className={`stamp ${t.passed ? "ok" : "bad"}`}>{t.passed ? "pass" : "fail"}</span><b>{t.scenario}</b>
        <span className="mute small">{t.summary} · {(t.duration_ms / 1000).toFixed(1)}s · {t.runs} agent runs · <span className="id">{t.mode}</span> · {clock(t.started_at)}</span>
      </summary>
      <table><tbody>{t.checks.map(c => <tr key={c.id}><td className={`check ${c.pass ? "ok" : "bad"}`}>{c.pass ? "✓" : "✗"}</td><td className="id nowrap">{c.id}</td><td className="mute small" style={{ overflowWrap: "anywhere" }}>{c.detail}</td></tr>)}</tbody></table>
    </details>)}
  </section>;
}
