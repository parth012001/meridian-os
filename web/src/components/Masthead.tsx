import type { Role, State } from "../api";

export function Masthead({ s, role, setRole, err, dismiss }: { s: State; role: Role; setRole: (r: Role) => void; err: string | null; dismiss: () => void }) {
  return <header className="masthead">
    <h1>{s.charter.company}</h1>
    <span className="mute small">autonomous org control plane</span>
    <span className="stamp">Charter v{s.charter.version}</span>
    <span className={`stamp ${s.mode.startsWith("live") ? "live" : "quiet"}`}>{s.mode}</span>
    {s.busy && <span className="stamp warn">agent running</span>}
    {err && <button className="toast" title="click to dismiss" onClick={dismiss}>{err}</button>}
    <span className="spacer" />
    <label className="role">acting as
      <select value={role} onChange={e => setRole(e.target.value as Role)}>
        <option value="owner">owner (human)</option>
        <option value="viewer">viewer</option>
      </select>
    </label>
    {s.busy && <div className="busyline" aria-hidden="true" />}
  </header>;
}
