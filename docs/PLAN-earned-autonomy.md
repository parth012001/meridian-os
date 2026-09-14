# Plan: Earned Autonomy (streaks, replay, demotion)

Status: PLANNED 2026-09-14 ~16:40 EDT, not started. Written for a fresh session.

## Where the repo is

- Repo: `~/Desktop/01 Active/slaterworks-autonomous-org/autonomous-org`, GitHub `parth012001/meridian-os` (public).
- `main` = PR #1 merged (order desk, reviewed, 30 tests).
- `feat/trials` = PR #2 open, awaiting Parth's review: trials harness, 5 scenarios, Trials panel, `docs/TRIALS.md`. 31 tests. Branch this work off `feat/trials` (or off `main` after #2 merges) as `feat/earned-autonomy`.
- Live LLM: OpenAI `gpt-5.4-mini`, key in `.env` (gitignored). `MOCK_LLM=1` for zero-spend runs.
- Verify baseline before touching anything: `pnpm test` (31 pass), `MOCK_LLM=1 pnpm trials` (5/5 pass), `pnpm reset-charter` afterwards because the demo mutates `org.yaml`.
- Read `README.md` first, then `src/charter.ts`, `src/actions.ts`, `src/tools.ts` (the `read_ledger_stats` and `propose_charter_diff` tools), `src/roles.ts` (`runReviewer`, `ownerDecides`), `src/server.ts` (`/api/proposals/:id`), `web/src/main.tsx` (Charter proposals card).

## Why this is the highest-leverage change

The assignment's fifth question: "How can outcomes, feedback, and failures create a self-improving loop without introducing regressions?" Today the answer is one Reviewer run that eyeballs aggregate stats and proposes raising a limit. It works, but it is a guess with evidence attached. This plan makes the loop mechanical: trust is counted per action shape, proposals carry a replay of what would have happened, and a bad outcome revokes autonomy. Same five primitives (Charter, World, Role, Gate, Ledger), same merge path, same gate. Nothing else in the architecture moves.

Prior art is Parth's own: Greenlight (`~/Desktop/01 Active/job-search/skillset/skillset-demo/greenlight`, GitHub `parth012001/greenlight`), an approval-gated IT-support agent with `src/lib/trust.ts` (per-shape streaks, thresholds snapshotted at creation, demotion on failed autonomous run), `src/lib/graduation.ts` (proposal = rule diff + replay over the last 50 actions, "terraform plan for authority"), `src/lib/suggestions.ts` (pattern miner, skip for now). Port the ideas, not the code: Greenlight is Next.js + Prisma; Meridian is Hono + better-sqlite3 with a YAML Charter.

## What to build (three pieces, in order)

### 1. Trust streaks per action shape

Shape = `(action type, supplier_id or null)`. Start with action type only if time is short; supplier makes the demo richer ("Ironline expedites are trusted, Oakridge are not").

New table in `src/schema.sql`:
```sql
CREATE TABLE IF NOT EXISTS trust (
  shape TEXT PRIMARY KEY,            -- e.g. "expedite_po" or "expedite_po:SUP_IRON"
  action_type TEXT NOT NULL,
  streak INTEGER NOT NULL DEFAULT 0, -- consecutive clean owner approvals
  threshold INTEGER NOT NULL,        -- snapshotted from Charter at creation
  total_approved INTEGER NOT NULL DEFAULT 0,
  total_rejected INTEGER NOT NULL DEFAULT 0,
  total_failed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'supervised',  -- supervised | proposed | autonomous | demoted
  evidence TEXT NOT NULL DEFAULT '[]',        -- JSON array of {approval_id, order_id, cost_usd, ts}
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```
Charter addition (`org.yaml` + `data/org.baseline.yaml` + zod in `src/charter.ts`):
```yaml
trust:
  thresholds: { expedite_po: 3, substitute_sku: 5, partial_ship: 2, change_promise_date: 99 }  # 99 = never auto
  demote_on: [expedite_failed, substitution_rejected_by_customer]
```
New file `src/trust.ts`:
- `recordOutcome({shape, outcome: 'approved'|'rejected'|'failed', approvalId, orderId, cost})`: approved and streak < threshold → streak+1, push evidence; rejected → streak 0, if status proposed mark stale; failed → streak 0 and if status autonomous → status demoted + call `demote()`.
- `maybePropose(shape)`: when streak reaches threshold and status is supervised → build proposal (piece 2) and set status proposed.
- `demote(shape)`: writes a Charter patch that lowers `autonomy_levels[action]` back to `recommend` (or `spend_usd` back to the pre-grant value stored in evidence), applies it via `applyCharterPatch` (this is the ONE place an agent-side process writes the Charter, and it only ever tightens; say so in a comment and in the README), logs `charter_change` with role `trust` and the rule `DEMOTION`.
Hook points: `decideApproval` in `src/actions.ts` (approved/rejected) and `executeAction` (failed, see piece 3).

### 2. Proposal = diff + replay

Extend `propose_charter_diff` in `src/tools.ts` and the `charter_proposals` table with a `replay` JSON column:
- For a proposed `spend_usd` raise: scan `actions` joined to `approvals` for that action type; list the ones with `gate_rule IN ('ROLE.spend_usd','C4')` and cost ≤ new limit; report `would_have_auto_executed: n, total_usd, all_approved_by_owner: bool, any_rejected: bool`.
- For an `autonomy_levels` change to `act`: same idea over `gate_rule = 'AUTONOMY.recommend'` or `'C2'`.
- If `any_rejected` is true the proposal is still filed but flagged; the UI shows it in red.
New function `src/trust.ts: buildReplay(patch)`; `maybePropose` calls it and files the proposal with `proposed_by: 'trust'` (not the Reviewer). Keep the Reviewer role; it now reads `trust` rows and explains them rather than inventing thresholds. Simplest: `read_ledger_stats` returns the trust table too, and the Reviewer's task text says "file the proposal the trust ledger has earned, or explain why not."

UI (`web/src/main.tsx`, Charter proposals card): show `streak/threshold`, the evidence approval ids, and the replay line: "Under this change, 3 past approvals ($1,350) would have executed without you. 0 were rejected." Add a small Trust panel (table: shape, streak/threshold, status) next to the org chart.

### 3. Demotion, with a deliberate failure in the World

Today an expedite always works, so nothing ever fails. Add a world event:
- `src/world.ts: applyExpediteMiss(poId)`: the supplier missed Fast Track; set `current_ship_date` back to the pre-expedite date (store `pre_expedite_ship_date` on the PO when expediting), record event `expedite_failed`.
- The watcher then re-flags the order; the task reopens (new task; the old one has outcome recovered, so keep it and open a new one, that is what `runWatcher` already does for resolved tasks).
- Hook: on `expedite_failed`, call `trust.recordOutcome({shape, outcome: 'failed'})`. If the shape was autonomous → demote → Charter tightens → ledger shows `DEMOTION`.
- API `POST /api/events/expedite-miss {po_id}` (owner-only) and a scenario button "Supplier misses Fast Track" in the UI controls.
- New trial scenario `earned_then_lost`: baseline slip → approve expedites ×3 (seed two extra Ironline-frame orders so there are 3 expedite approvals in one run; `seedLoad(2)` from `src/trials/scenarios.ts` does this) → trust proposes → owner merges → next slip auto-executes an expedite → expedite miss → demotion. Graders: `proposal_filed_at_threshold`, `replay_matches_ledger`, `autonomous_execution_after_merge`, `demoted_after_failure`, `charter_version_incremented_twice`, `no_unapproved_execution` still holds.

## Order of work and checkpoints

1. Schema + Charter fields + zod. `pnpm test` still 31 green (flow tests copy `org.baseline.yaml`, so update the baseline).
2. `src/trust.ts` with `recordOutcome` + unit tests (streak up, reset on reject, snapshot threshold, no double count). ~8 tests.
3. Hook into `decideApproval`. Mock trials still 5/5.
4. `buildReplay` + proposal column + UI card. Run live `pnpm trials --only baseline_slip` and confirm the proposal now shows replay.
5. `applyExpediteMiss` + event + API + button + demotion path + test.
6. New trial scenario, run in mock then live.
7. README: replace the "Self-improvement" paragraph with the streak/replay/demotion mechanism; add "the only Charter write an agent-side process can make is a demotion, and it only tightens."
8. Commit in that order, PR #3 `feat/earned-autonomy` → `main`.

## Things that will bite

- `restoreBaselineCharter()` runs on reset and at trial setup; the `trust` table should also reset (it lives in the world DB, `resetDb` drops it; fine). But `trials` is preserved by name in `resetDb`; do not add `trust` to that exclusion.
- `applyCharterPatch` bumps `version` every write; demotion + proposal merges will move it fast in the demo. That is the point; show it.
- `editablePaths()` in `src/charter.ts` decides what a proposal may touch; a demotion patch must pass the same validation. Use `validateCharterPatch` before writing.
- The mock LLM (`src/llm.ts`, reviewer branch) files a proposal by reading `read_ledger_stats`; update it to read the trust rows so mock trials keep passing.
- The gate test file pins the baseline Charter; adding a `trust` block to the schema must keep it optional or update the baseline in the same commit.

## Ideas explicitly parked (do not do unless time remains)

Heartbeat loop (`pnpm heartbeat`: watcher + work + stale-approval re-notify every N seconds), human/agent seat flip (`kind: human` on a live seat routes the work to the inbox, human submission runs the same tool; ledger becomes training material when flipped back), delegation between seats via the queue, playbook table, pattern miner from Greenlight, knowledge graph.
