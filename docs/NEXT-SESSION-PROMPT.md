# Prompt for the next session (backend: earned autonomy)

Copy everything below the line into a fresh Claude Code session started in
`~/Desktop/01 Active/slaterworks-autonomous-org/autonomous-org`.

---

You are continuing a take-home for SlaterWorks: an "autonomous organization" prototype for a door, frame and hardware distributor, called Meridian OS. Repo is this directory, GitHub `parth012001/meridian-os` (public). Read, in this order, before writing any code:

1. `README.md` (thesis, five primitives, six answers, trials section)
2. `docs/PLAN-earned-autonomy.md` (the full spec for what you are building; follow it)
3. `docs/TRIALS.md` (what the live trials found)
4. `src/charter.ts`, `src/gate.ts`, `src/actions.ts`, `src/tools.ts`, `src/roles.ts`, `src/trials/*.ts`
5. Greenlight, my earlier project the ideas come from: `~/Desktop/01 Active/job-search/skillset/skillset-demo/greenlight/src/lib/trust.ts`, `graduation.ts`, `suggestions.ts`. Port the ideas (per-shape approval streaks with thresholds snapshotted at creation, proposal = Charter diff + replay of past actions, demotion on a failed autonomous run, evidence rows that point back into the ledger, pattern-mined suggestions if time allows). Do not port the code; Greenlight is Next.js + Prisma, Meridian is Hono + better-sqlite3 + a YAML Charter.

## State of the repo when this prompt was written (2026-09-14 ~17:00 EDT)

- `main`: PR #1 merged (order desk).
- `feat/trials`: PR #2, review fixes committed and pushed (commit c1dd116). Parth may have merged it by the time you start. Check with `gh pr view 2 --json state`. If merged, branch off `main`; if not, branch off `feat/trials`. Either way your branch is `feat/earned-autonomy`.
- 42 tests pass (`pnpm test`), mock trials pass 5/5 (`MOCK_LLM=1 pnpm trials`). Run both before you change anything and confirm those numbers. Run `pnpm reset-charter` after any demo or trial, they mutate `org.yaml`.
- Live model: OpenAI `gpt-5.4-mini`, key already in `.env` (gitignored). Live trials cost about 50k tokens and 35 seconds per scenario.
- A second session is working on the frontend in a separate git worktree at `../meridian-web` on branch `feat/web`. **Do not edit anything under `web/` in this session.** Where the plan says to add UI (Trust panel, proposal card with replay), instead: expose the data through the API, and append the API contract to `docs/API-CONTRACT.md` (endpoint, method, role required, request, response example). The frontend session builds against that file.

## What to build

Everything in `docs/PLAN-earned-autonomy.md`, all three pieces, complete. Not a slice, not a stub:

1. Trust streaks per action shape (`trust` table, `src/trust.ts`, Charter `trust:` block, hooks in `decideApproval` and `executeAction`).
2. Proposals that carry a replay ("under this change, N past approvals worth $X would have executed without you, M were rejected"), filed by the trust engine at threshold, explained by the Reviewer, merged only by the owner.
3. Demotion: a deliberate world event where the supplier misses Fast Track, the order goes late again, the shape's autonomy is revoked by a Charter patch that only ever tightens, and the ledger shows it under rule `DEMOTION`.
4. A new trial scenario `earned_then_lost` that proves the whole arc live, with the graders listed in the plan.
5. README updated: the self-improvement answer now describes streaks, replay, demotion, and the one-way rule (agent-side processes can only tighten the Charter).

## How to work

- **Tests first, every step.** Before implementing each piece, write the failing tests for it (vitest, same style as `src/flow.test.ts`: temp DB, baseline Charter copied, mock LLM). Run them, watch them fail, implement, watch them pass, then run the whole suite and the mock trials. Never move to the next piece with anything red.
- Commit after every green step with a message that names the piece. Small commits, in the order of the plan. Attribution lines as in earlier commits.
- After piece 4, run the new scenario live at least three times (`pnpm trials --n 3 --only earned_then_lost`) and put the numbers in `docs/TRIALS.md`. If a live run fails, treat it like the earlier findings: fix in code, add a test, keep the failing row in the scorecard, write it down.
- Keep the five primitives. If you find yourself adding a sixth concept, stop and re-read the plan.
- The gate stays deterministic and unchanged. If a piece seems to need the gate to change, it is designed wrong.
- Fail closed everywhere: unknown shape, missing threshold, malformed replay, all deny or skip with a ledger error, never throw out of a request.
- When done: push, open PR #3 `feat/earned-autonomy` → `main` with a body in the same shape as PR #2 (what it adds, review order, live results, what the trials found). Update the memory file for this project with the outcome.

## Definition of done

- All tests green, mock trials 6/6, live `earned_then_lost` passes 3/3 or the failure is documented with a fix and a test.
- `pnpm demo` still runs end to end and now shows the trust ledger and a replay in step 8.
- `docs/API-CONTRACT.md` lists every new or changed endpoint.
- No file under `web/` touched.
- PR #3 open. Summary to Parth: what changed, the numbers, where it still fails.
