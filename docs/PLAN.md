# SlaterWorks take-home: Autonomous Organization for a door/frame/hardware distributor

Status as of 2026-09-14 evening: PLANNING COMPLETE, CLOCK NOT STARTED, NO CODE WRITTEN.
This file is the handoff. A fresh session should be able to read it and start building.

Repo will live at: `~/Desktop/01 Active/slaterworks-autonomous-org/<repo>/` (repo not created yet).
Prompt text: see `docs/PROMPT.md` (verbatim copy of the assignment).

---

## 0. The assignment in one paragraph

Build a prototype of an "autonomous organization" whose business is distributing commercial and
residential doors, frames, and hardware (buys from manufacturers, sells to contractors/builders/
dealers/facility managers). Pick ONE business outcome, define how it is measured and the
constraints the system may act within. Ship an app that lets an enterprise customer build, govern,
manage, and scale the org, with 1-2 working agents completing a meaningful multi-step workflow.
4 hours. GitHub repo + sample data + setup + assumptions/tradeoffs. 60-90 min demo and debrief.
Graded on: prioritization, creativity (a specific view of how autonomous orgs should work),
applied AI quality (goal-directed, grounded in state, tool-using, robust), engineering quality
(data modeling, interfaces, state, observability, failure handling, security, permissions).

The six "questions to consider" are the real rubric. Every one must have a one-line answer that
maps to something visible in the code:
1. What does an autonomous organization mean?
2. Declarative representation of outcome, state, constraints, success measures?
3. Ontology/graph: what must be known up front vs. left to the model?
4. Planning/acting across time horizons and modalities with shared state?
5. Self-improving loop without regressions?
6. Identity, permissions, approvals, data access, auditability for consequential actions?

---

## 1. Decisions already made (do not re-litigate)

**Outcome chosen: identify and recover at-risk orders.**
Success measure: on-time delivery rate on open orders, revenue protected, recovery cost spent.
Why this one: it exercises observe -> plan -> act -> escalate across two time horizons (continuous
watch + episodic recovery), two modalities (supplier query, customer message), and needs human
approval for spend. Demo is a story you can tell in 3 minutes. Quote conversion would need
simulated customer behaviour to prove anything.

**Vertical, not horizontal.** The whole org is declared on paper (8 seats), but only the ORDER DESK
is wired: three live roles, one queue, one workflow, end to end. The other five seats exist as
declared roles with tools listed and no runtime. That is the "scale" story: add a role by adding YAML.

**Stack: TypeScript.** Portfolio is TS (HappyRobot carrier desk, SOP platform). Node 22, pnpm 10.
Claude API via `@anthropic-ai/sdk` with tool use. SQLite via `better-sqlite3` (single file, zero infra).
Backend: Hono or plain Express, one process. UI: Vite + React, single page, 4 panels. No auth
beyond a role switcher header. Reuse the shape of `~/Desktop/01 Active/happyrobot-fde-carrier-desk/`
(apps/, data/, demo/, docs/, Makefile) since that repo already demoed well.

**Thesis sentence (say this first in the README and the debrief):**
An autonomous organization is a declarative Charter written by humans plus a runtime that turns
business state changes into work, routes every consequential action through a policy gate, and
writes an append-only ledger. Agents are employees with job descriptions and spending limits, not
a pipeline. Humans keep judgment: exceptions, customer relationships, and every change to the
Charter itself.

---

## 2. The five primitives (the whole architecture)

| Primitive | What it is | Answers rubric question |
|---|---|---|
| **Charter** | `org.yaml`: outcome, KPI formulas, hard constraints, roles with authority limits, escalation paths, autonomy level per action class | Q1, Q2 |
| **World** | SQLite of the business (entities below) plus an append-only `events` table. This is the shared state every role reads. | Q3, Q4 |
| **Role** | An agent = role name + system prompt + allowed tools + authority limits pulled from the Charter. One runtime, N configs. | Q4, Q6 |
| **Gate** | One function every action passes through. Deterministic checks first (deny list, allow list, threshold vs. role authority), then execute or park as an Approval. Fails closed. | Q6 |
| **Ledger** | Append-only log of every observation, tool call, decision, approval, and outcome, with the role, the reasoning, and the Charter rule that applied. | Q5, Q6 |

Composition: World event -> Ops Manager role reads World, opens a Task -> Expeditor role claims it,
calls tools, calls `propose_action` -> Gate checks Charter -> execute OR create Approval -> human
decides in UI -> Ledger records all of it -> KPI recomputed from World.

Self-improvement lives in the Ledger, not the agents: a Review role (can be a button, not a cron)
reads outcomes by recovery strategy and emits a proposed Charter diff ("expedite under $400 has a
94% success rate over 17 cases, propose raising Expeditor auto-approve limit from $250 to $400").
A human merges or rejects. Agents can never edit their own limits. This is "earned autonomy" and
it is the regression-safe answer to Q5.

Ontology stance (Q3): the World schema encodes what the model cannot know (this company's SKUs,
suppliers, lead times, customer terms, who is allowed to spend what). The model brings what it
already knows (what a hollow metal frame is, how expediting works, how to write to a contractor).
Relational schema with foreign keys and events. No knowledge graph in 4 hours; say in the debrief
that a graph earns its keep when relationships become the query (which openings share a hardware
set that shares a delayed supplier), and that SQLite joins cover that at this scale.

---

## 3. The org on paper (from research, section 7)

A real Division 8 distributor has roughly these seats. Declare all eight in `org.yaml`.

| Seat | Human today does | Status in prototype |
|---|---|---|
| Owner / GM | sets targets, approves big spend, owns customer relationships | HUMAN. Escalation terminus. Approves in UI. |
| Estimator / Inside Sales | reads specs and door schedules, prices hardware packages, submits bids | declared, stubbed |
| Project Manager | owns a contract job end to end: submittals, procurement, delivery | declared, stubbed (our Ops Manager is a slice of this) |
| Purchasing / Expeditor | places manufacturer POs, chases acknowledgements, expedites | LIVE: Expeditor role |
| Detailer | hardware sets, preps, elevations, submittal packages | declared, stubbed |
| Warehouse / Tagging | receives, tags by opening number, bundles hardware sets | declared, stubbed |
| Dispatch / Delivery | schedules job-site delivery floor by floor | declared, stubbed |
| Customer Service | stock orders, status calls, customer comms | LIVE: Customer Comms role |
| (new) Ops Manager | watches every open order for risk, opens tasks | LIVE: Watcher role. Automates the ERP's "Orders Actions" window. |

Human-only by Charter: changing the Charter, discounts above threshold, any customer promise-date
change, firing/hiring roles, anything touching invoicing.

---

## 4. Data model (World)

Atomic unit in this industry is the OPENING (a door location, keyed by opening number). Orders are
lists of openings; each opening is a door + frame + hardware set; hardware sets are lists of items.
Late orders happen when a manufacturer's PO acknowledgement slips the ship date, when stock is short,
or when a prep/spec mismatch forces a reorder. Recovery levers a real expeditor uses, in order of
cost: pull from stock at another branch, substitute an in-stock equivalent (needs customer OK),
pay the manufacturer's expedite fee (CDF calls it "Fast Track", next-day ship), partial ship
the openings that are ready, or renegotiate the promise date with the customer.

Tables (SQLite, `better-sqlite3`, schema in one `schema.sql`):

- `customers` (id, name, type: contractor|builder|dealer|facility, terms, contact)
- `suppliers` (id, name, product_lines, standard_lead_days, expedite_fee_usd, expedite_lead_days)
- `skus` (id, supplier_id, category: door|frame|hardware, description, unit_cost, list_price, substitutable_group)
- `inventory` (sku_id, branch, qty_on_hand, qty_allocated)
- `orders` (id, customer_id, project_name, promise_date, status, margin_pct, ship_policy: complete|partial_ok)
- `openings` (id, order_id, opening_no, door_sku, frame_sku, hardware_set_id, fire_rated)
- `hardware_sets` (id, name) + `hardware_set_items` (set_id, sku_id, qty)
- `purchase_orders` (id, supplier_id, order_id, sku_id, qty, placed_at, acked_ship_date, current_ship_date, status)
- `events` (id, ts, type, payload_json) : supplier_ack_slip, stock_shortfall, customer_msg, po_placed, shipment
- `tasks` (id, order_id, opened_by_role, assigned_role, status, risk_score, reason)
- `actions` (id, task_id, role, type, params_json, cost_usd, gate_verdict, approval_id, executed_at)
- `approvals` (id, action_id, requested_of: owner, status, decided_by, decided_at, note)
- `ledger` (id, ts, role, kind: observe|plan|tool_call|propose|gate|approve|execute|outcome, ref_id, reasoning, charter_rule)
- `kpi_snapshots` (ts, on_time_rate, revenue_at_risk, revenue_protected, recovery_cost)

Seed: ~8 customers, ~4 suppliers, ~40 SKUs, 3 branches, ~15 orders with ~60 openings, ~25 POs.
One seeded scenario event: supplier "Steelcraft-ish" acknowledges a 10-day slip on hollow metal
frames, which touches 3 orders with different promise dates and margins.

---

## 5. Charter (`org.yaml`) draft

```yaml
company: Meridian Door & Hardware   # fictional
outcome:
  name: no_order_goes_late_unnoticed
  statement: Deliver open orders on their promise date; when supply slips, recover before the customer feels it.
kpis:
  on_time_rate:      { formula: shipped_on_or_before_promise / shipped_total, target: ">= 0.95" }
  revenue_protected: { formula: sum(order_value where task.outcome = recovered) }
  recovery_cost:     { formula: sum(actions.cost_usd where executed), constraint: "<= 2% of order_value" }
constraints:
  - id: C1
    rule: never change a customer promise date without owner approval
  - id: C2
    rule: never substitute a SKU without customer consent recorded as an event
  - id: C3
    rule: fire-rated openings must keep matching door/frame labels; no substitution across ratings
  - id: C4
    rule: recovery spend per order <= 2% of order value without owner approval
roles:
  owner:            { kind: human, approves: [expedite_over_limit, promise_date_change, discount, charter_change] }
  ops_manager:      { kind: agent, horizon: continuous, tools: [list_open_orders, get_po_status, get_inventory, open_task], authority: { spend_usd: 0 } }
  expeditor:        { kind: agent, horizon: episodic, tools: [get_order_context, find_alternatives, query_supplier_eta, propose_action], authority: { spend_usd: 250, may: [expedite_po, transfer_stock, partial_ship], may_not: [substitute_sku, change_promise_date, discount] } }
  customer_comms:   { kind: agent, horizon: episodic, tools: [get_order_context, draft_customer_message, send_customer_message], authority: { send_without_review: [status_update], needs_review: [substitution_request, delay_notice] } }
  reviewer:         { kind: agent, horizon: weekly, tools: [read_ledger, propose_charter_diff], authority: { spend_usd: 0, may_edit_charter: false } }
  estimator:        { kind: agent, status: declared, tools: [read_spec, price_hardware_set] }
  detailer:         { kind: agent, status: declared, tools: [build_submittal] }
  warehouse:        { kind: agent, status: declared, tools: [receive, tag_by_opening] }
  dispatch:         { kind: agent, status: declared, tools: [schedule_delivery] }
escalation:
  default: owner
  timeout_hours: 4     # unanswered approvals re-notify; never auto-approve
autonomy_levels:       # progressive autonomy per action class (observe -> recommend -> act)
  expedite_po:         act_within_limit
  transfer_stock:      act
  partial_ship:        act_if_ship_policy_allows
  substitute_sku:      recommend
  change_promise_date: recommend
  discount:            recommend
```

The `autonomy_levels` block is the thing the Reviewer proposes diffs against. Show one diff in demo.

---

## 6. Runtime design

**Agent loop:** one generic `runRole(roleName, taskContext)` that loads the role from the Charter,
builds a system prompt from role + Charter constraints + outcome, exposes only that role's tools,
runs Claude tool-use loop (max ~12 turns), writes every tool call and the final decision to the
Ledger. Model: `claude-sonnet-5` for Expeditor/Comms, `claude-haiku-4-5-20251001` for the Watcher
triage (cheap, runs often). Check `claude-api` skill before writing the SDK code.

**Watcher (Ops Manager):** deterministic first, LLM second. Rule: risk if any PO's
`current_ship_date + transit_days > order.promise_date`, or inventory short for an opening, or an
event of type `supplier_ack_slip` touches the order. Score = days_late * order_value * margin
weight. LLM only writes the human-readable reason and ranks. Opens a Task per at-risk order.
Project Vend lesson: procedures beat judgment. The watcher does not "decide", it detects.

**Expeditor:** claims a task, calls `get_order_context` (order, openings, POs, inventory, customer
ship policy, margin), `find_alternatives` (returns candidate levers with cost, days saved, and
which Charter constraints each touches), `query_supplier_eta` (simulated supplier adapter with
seeded responses), then `propose_action` one or more times. Must call `find_alternatives` before
`propose_action` (enforced in code, not prompt). Cheapest lever that closes the gap wins; ties
go to the one with fewer approvals.

**Gate (`gate.ts`):** pure function `(role, action, charter, world) -> {verdict: execute|approve|deny, rule}`.
Order of checks: deny list (C1-C4 hard rules) -> role.may_not -> role.may -> spend vs authority
-> autonomy_level for action class. Any exception = deny (fail closed). Verdict and the rule id
land in the Ledger. This is the single most important file for the "engineering quality" score;
write unit tests for it (6-8 cases, vitest).

**Approvals:** row in `approvals`, surfaced in UI inbox. Owner approves/rejects with a note. On
approve, the action executes and the task continues (Expeditor gets re-invoked with the approval
result in context). On reject, Expeditor re-plans once with the rejection note, then escalates.

**Customer Comms:** after a lever executes, drafts the message. `status_update` sends immediately
(simulated outbox table). `substitution_request` and `delay_notice` need owner review. Consent
to a substitution is recorded as a `customer_msg` event, which then unlocks C2 for the Expeditor.

**Reviewer:** a button in the UI ("Run weekly review"). Reads Ledger outcomes grouped by action
type and cost band, produces a Charter diff as text plus a JSON patch, stored in `charter_proposals`.
Owner clicks merge, which rewrites `org.yaml` and logs a `charter_change` in the Ledger. Never
auto-merges. That's the whole Q5 answer.

**Identity (Q6):** every request carries `x-role` header (owner | ops_manager | expeditor | ...).
Agents run with their own role identity. The Ledger records who acted "on behalf of" whom. Say in
README that this becomes real IAM (per-agent service accounts, scoped tokens) in production.

**Failure handling:** tool errors return structured `{error}` to the model, not exceptions; max
turns per run; a run that ends without `propose_action` or explicit `no_action_needed` is marked
`stalled` and escalated to owner; idempotent action execution keyed by action id; every LLM call
logged with token counts to the Ledger for cost observability.

---

## 7. Research findings that shaped this (Exa, 2026-09-14)

**Domain (Division 8 distributors):**
- Real roles: estimator/inside sales, project manager per contract job (does takeoff, proposal,
  submittals, procurement, follow-up to delivery), customer service for stock orders, detailer,
  warehouse tagging by opening number, delivery. Sources: Metropolitan Door "MDI Services", CDF
  Distributors guides, Provision DHF scope-of-work guide.
- Lead times: standard hollow metal doors/frames 8-12 weeks from submittal approval; architectural
  wood 12-16; specialty 16-20+; hardware 6-10 weeks. DHF drives more close-out delays than any
  other interior finish. (Provision, 2026)
- Expedite exists as a product: CDF "Fast Track" moves an order to the front of the production
  queue, ships as soon as next business day, expediting fee applies, not all configs eligible.
  In-stock substitution "of commensurate quality" is the other recovery lever they name.
- Common late-order causes: PO acknowledgement variances (date, qty, price), prep mismatches when
  door/frame/hardware ordered separately, spec/schedule conflicts, rough opening mismatch, access
  control coordination gaps.
- Fire-rated openings: door label must match frame label; substitution across ratings is a code
  failure. That is constraint C3.
- Ship policy is a real field: "complete" vs "partial OK" per order or phase. That is why
  `partial_ship` is a lever gated by `orders.ship_policy`.
- ERP prior art (Comsense Enterprise, the industry standard): entities are Project, Opening,
  Hardware Set, Door/Frame takeoff, Quote, Sales Order, manufacturer-specific PO, PO
  Acknowledgement with variance flags, "Orders Actions window highlights orders that require
  attention". Our Watcher is that window made autonomous. Comsense also has "source material
  from stock, PO, or pool", which maps to `transfer_stock`.

**Autonomous-org landscape (what graders will have seen):**
- Paperclip (open source, Mar 2026): org chart, heartbeats, per-agent budgets with hard stops,
  goal ancestry on every task, approval gates with config revisioning and rollback, immutable
  audit log. "Not an agent framework, we tell you how to run a company made of them."
- SynthOrg: four oversight modes (locked / supervised / semi / full) applied per agent, initiative,
  or company; a gate on every action = deterministic deny list, deterministic allow list, built-in
  detectors, then LLM evaluator; fails closed; reviewer can never be the executor (DB constraint).
- tycono: "company as code", Terraform analogy, role.yaml with scoped authority.
- Crewlet: humans are seats in the org chart (`kind: human`), escalation terminus. We copied this.
- Foundry, OpenCognit, agent-enterprise, YClaw: CEO orchestrator + heartbeat + memory + budgets.
  All horizontal, none vertical. Our edge is being vertical and grounded in a real business.
- Progressive autonomy (Infinite Uptime interview, ABB Level-4 framing, Eaton): observe -> recommend
  -> bounded act -> expand bounds where proven. Our `autonomy_levels` + Reviewer = this.
- Walker Reynolds (4.0 Solutions): LLMs ~99.9% reliable vs PLC nine nines, so agents must be
  supervised; UNS = "real-time current state of the business" is the context agents start from.
  Our World table is the UNS. Knowledge graphs are "the breakout technology of 2025" in industrial
  AI; be ready to say why we didn't build one in 4 hours.

**Failure evidence to cite in the debrief:**
- Project Vend 1: hallucinated Venmo account, sold at a loss without research, talked into
  discounts, did not learn from mistakes. Vend 2: forcing procedures (look up cost before
  pricing) helped most; a CEO agent on the same model shared its blind spots and approved 8x more
  lenient requests than it denied; clear role separation (Clothius) helped. Lesson: the gate is
  code, not another LLM; role separation is a feature.
- Andon Labs (IEEE Spectrum, 2026-09-14): agents degrade over long horizons, "meltdown loops",
  overwhelmed under parallel load, lost track of orders and claimed things were procured that
  were not. Lesson: one task per run, state in the DB not the context window, Ledger is the truth.
- Vending-Bench: some agents rationalised illegal behaviour "because it's a simulation".

**SlaterWorks:** still nothing public beyond the one-letter site. Do not claim knowledge of them.
(One weak lead: a Nikolas Slater, AI governance, ex Real AI Dynamics, co-founder "Slaiter.ai";
unconfirmed link, ignore unless Parth confirms the interviewer's name.)

---

## 8. Build order (4-hour clock)

| Slot | Deliverable | Notes |
|---|---|---|
| 0:00-0:20 | repo scaffold, `org.yaml`, `schema.sql`, seed script, `PROMPT.md` copied | Reuse carrier-desk repo shape. Seed must include the 3-order slip scenario. |
| 0:20-1:10 | `world.ts` (queries), `gate.ts` + vitest, `ledger.ts`, tools for Expeditor | Gate first: it is the core engineering artefact. |
| 1:10-2:00 | `runRole` loop, Watcher, Expeditor end to end in CLI (`pnpm demo`) | Get the workflow working in the terminal before any UI. |
| 2:00-2:45 | Hono API + React UI: Charter view, order board w/ risk, live trace, approval inbox, ledger, KPI tiles | One page, 4-6 panels, polling every 2s is fine. |
| 2:45-3:15 | Customer Comms role, Reviewer button + charter diff | If behind, Reviewer becomes a canned diff with the real Ledger query. |
| 3:15-3:45 | README: thesis, six answers, assumptions, where it fails, what next; demo script | README is graded. Write it from this file. |
| 3:45-4:00 | Buffer, record 2-min demo video | |

Hard cut list if behind (in order): Reviewer -> Customer Comms -> UI polish -> Comms.
Never cut: Gate + tests, Ledger, Watcher, Expeditor, approval inbox, README.

---

## 9. Demo script (3 minutes)

1. Show `org.yaml`: "this is the company. Humans wrote it. Eight seats, three live."
2. Board is green. Click "inject event: supplier ack slip, HM frames +10 days".
3. Watcher runs: 3 orders go amber/red with reasons and risk scores. Tasks opened.
4. Expeditor works order A: stock transfer from Branch 2, within authority, executes. Green.
5. Order B: needs $600 Fast Track, over the $250 limit. Gate parks it. Approval inbox lights up.
   Show the Ledger entry naming rule C4 and the role's authority.
6. Owner approves with a note. Action executes. Comms drafts the status update, sends.
7. Order C: only lever is substitution, C2 needs customer consent. Comms drafts the request,
   owner reviews, "customer" replies yes (button), event recorded, Expeditor re-runs, executes.
8. KPI tiles: on-time rate back to target, revenue protected $X, recovery cost $Y (< 2%).
9. Click "Run weekly review": Reviewer proposes raising the expedite limit with evidence. Show
   the diff. Merge it. Ledger shows `charter_change` by owner.
10. Debrief: where it fails (below).

---

## 10. Where it will fail (say this before they ask)

- Supplier and customer channels are simulated adapters with seeded replies. Real ones are
  email/EDI/phone and messy.
- The Expeditor can pick a bad lever if `find_alternatives` returns bad data. Garbage in.
- No real identity: role header, no tokens, no per-agent service accounts.
- Watcher rules are hand-written thresholds. Real risk scoring needs history.
- Long-horizon coherence is untested. Andon Labs shows degradation; we sidestep by making each
  run one task with state in the DB, but 500 open orders at once is untested.
- Reviewer proposals are only as good as the Ledger sample; with 3 cases it will overfit. That's
  why humans merge.
- Single tenant, single company, SQLite.

## 11. What I'd build next

Real supplier EDI/PO-ack ingestion (the Comsense variance feed), per-agent scoped credentials,
a graph layer when cross-order relationships become the query, replay/simulation harness
("digital twin" of the order book to test Charter changes before merge), the Estimator seat
(quote conversion is the second outcome), multi-branch.

---

## 12. Open questions to send the interviewer (they allow it)

1. Is the 4 hours a hard timer or honour system? Submission deadline?
2. Live LLM calls in the demo OK, or do they want a no-key mocked mode too? (Build a
   `MOCK_LLM=1` path regardless: seeded tool-call scripts, zero spend, deterministic demo.)
3. Any stack preference?

## 13. Questions for Parth before the clock starts

- Deadline? Has the clock started?
- Company name for the fictional distributor (default: Meridian Door & Hardware).
- Confirm at-risk-orders outcome and the three live roles.
