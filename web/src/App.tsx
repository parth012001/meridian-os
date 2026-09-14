import { useCallback, useEffect, useState } from "react";
import { api, type Role, type State, type Trials } from "./api";
import { Masthead } from "./components/Masthead";
import { Outcome } from "./components/Outcome";
import { CharterPanel } from "./components/CharterPanel";
import { Desk } from "./components/Desk";
import { Board } from "./components/Board";
import { Ledger } from "./components/Ledger";
import { Org } from "./components/Org";
import { Outbox } from "./components/Outbox";
import { TrialsPanel } from "./components/Trials";
import { Simulator } from "./components/Simulator";

export type Act = (path: string, body?: unknown) => () => Promise<void>;

export function App() {
  const [s, setS] = useState<State | null>(null);
  const [trials, setTrials] = useState<Trials | null>(null);
  const [role, setRole] = useState<Role>("owner");
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [state, tr] = await Promise.all([api("/state"), api("/trials")]);
    setS(state); setTrials(tr);
  }, []);
  useEffect(() => { refresh(); const i = setInterval(refresh, 1500); return () => clearInterval(i); }, [refresh]);

  // Every control on the page goes through here: POST as the current role, surface the error, re-read the World.
  const act: Act = (path, body) => async () => { const r = await api(path, body ?? {}, role); setErr(r?.error ?? null); refresh(); };

  if (!s) return <div className="page" style={{ paddingTop: 40 }}><span className="mute">Loading the World…</span></div>;
  const owner = role === "owner";

  return <>
    <div className="page">
      <Masthead s={s} role={role} setRole={setRole} err={err} dismiss={() => setErr(null)} />
      <Outcome s={s} />
      <div className="band split-5-7">
        <CharterPanel s={s} />
        <Desk s={s} owner={owner} act={act} />
      </div>
      <div className="band">
        <Board s={s} />
      </div>
      <div className="band split-7-5">
        <Ledger s={s} />
        <div className="stack">
          <Org s={s} />
          <Outbox s={s} />
        </div>
      </div>
      <div className="band">
        <TrialsPanel s={s} trials={trials} owner={owner} act={act} />
      </div>
    </div>
    <Simulator s={s} owner={owner} act={act} />
  </>;
}
