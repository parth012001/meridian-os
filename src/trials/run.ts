// Trials runner. `pnpm trials [--n 3] [--only id,id]`. Each rep resets the World, runs the scenario, grades it, stores a row.
import "../env.js";
import { db, uid } from "../db.js";
import { MOCK, MODEL } from "../llm.js";
import { log } from "../ledger.js";
import { scenarios, type Scenario } from "./scenarios.js";
import type { CheckResult } from "./checks.js";

export interface TrialRow { id: string; scenario: string; rep: number; mode: string; passed: number; checks: CheckResult[]; summary: string; tokens_in: number; tokens_out: number; runs: number; duration_ms: number; started_at: string }

export async function runScenario(s: Scenario, rep: number): Promise<TrialRow> {
  const started = Date.now();
  s.setup();
  const runsBefore = (db().prepare("SELECT COUNT(*) c FROM runs").get() as any).c;
  let driveError: string | null = null;
  try { await s.drive(); } catch (e) { driveError = (e as Error).message; }
  let checks: CheckResult[];
  // the load scenario computes its expected count at setup; re-evaluate late set for the check closure
  checks = s.checks.map(c => { try { return c(); } catch (e) { return { id: "grader_error", pass: false, detail: (e as Error).message }; } });
  if (driveError) checks.unshift({ id: "drive_completed", pass: false, detail: driveError });
  const tok = db().prepare("SELECT COALESCE(SUM(tokens_in),0) i, COALESCE(SUM(tokens_out),0) o, COUNT(*) n FROM runs").get() as any;
  const row: TrialRow = { id: uid("trial"), scenario: s.id, rep, mode: MOCK ? "mock" : `live:${MODEL}`, passed: checks.every(c => c.pass) ? 1 : 0, checks,
    summary: `${checks.filter(c => c.pass).length}/${checks.length} checks`, tokens_in: tok.i, tokens_out: tok.o, runs: tok.n - runsBefore, duration_ms: Date.now() - started, started_at: new Date(started).toISOString() };
  db().prepare("INSERT INTO trials (id, scenario, rep, mode, passed, checks, summary, tokens_in, tokens_out, runs, duration_ms, started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(row.id, row.scenario, row.rep, row.mode, row.passed, JSON.stringify(row.checks), row.summary, row.tokens_in, row.tokens_out, row.runs, row.duration_ms, row.started_at);
  log({ role: "trials", kind: "outcome", refType: "trial", refId: row.id, summary: `trial ${s.id} rep ${rep} [${row.mode}]: ${row.passed ? "PASS" : "FAIL"} ${row.summary}`, detail: checks.filter(c => !c.pass) });
  return row;
}

export async function runTrials(opts: { n?: number; only?: string[] } = {}) {
  const list = scenarios.filter(s => !opts.only?.length || opts.only.includes(s.id));
  const rows: TrialRow[] = [];
  for (const s of list) for (let rep = 1; rep <= (opts.n ?? 1); rep++) rows.push(await runScenario(s, rep));
  return rows;
}

export function scorecard() {
  const rows = db().prepare("SELECT * FROM trials ORDER BY started_at DESC LIMIT 200").all() as any[];
  const by: Record<string, { scenario: string; mode: string; reps: number; passed: number; checks: Record<string, { pass: number; total: number; lastFail?: string }>; avg_ms: number; tokens: number }> = {};
  for (const r of rows) {
    const k = `${r.scenario}|${r.mode}`; const b = (by[k] ??= { scenario: r.scenario, mode: r.mode, reps: 0, passed: 0, checks: {}, avg_ms: 0, tokens: 0 });
    b.reps++; b.passed += r.passed; b.avg_ms += r.duration_ms; b.tokens += r.tokens_in + r.tokens_out;
    for (const c of JSON.parse(r.checks) as CheckResult[]) { const cc = (b.checks[c.id] ??= { pass: 0, total: 0 }); cc.total++; if (c.pass) cc.pass++; else cc.lastFail = c.detail; }
  }
  return Object.values(by).map(b => ({ ...b, avg_ms: Math.round(b.avg_ms / b.reps) }));
}

if (process.argv[1] && /run\.(ts|js)$/.test(process.argv[1])) {
  const nIdx = process.argv.indexOf("--n"); const n = nIdx > 0 ? Number(process.argv[nIdx + 1]) || 1 : 1;
  const onlyIdx = process.argv.indexOf("--only"); const only = onlyIdx > 0 ? process.argv[onlyIdx + 1].split(",") : [];
  console.log(`trials: mode=${MOCK ? "mock" : MODEL} n=${n} scenarios=${only.length ? only.join(",") : "all"}`);
  runTrials({ n, only }).then(rows => {
    for (const r of rows) {
      console.log(`\n${r.passed ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${r.scenario} rep ${r.rep}  ${r.summary}  ${(r.duration_ms / 1000).toFixed(1)}s  ${r.runs} agent runs  ${r.tokens_in + r.tokens_out} tokens`);
      for (const c of r.checks) console.log(`   ${c.pass ? "✓" : "✗"} ${c.id.padEnd(36)} ${c.detail}`);
    }
    console.log("\nscorecard:"); console.table(scorecard().map(s => ({ scenario: s.scenario, mode: s.mode, reps: s.reps, passed: s.passed, avg_s: (s.avg_ms / 1000).toFixed(1) })));
    process.exit(0);
  }).catch(e => { console.error(e); process.exit(1); });
}
