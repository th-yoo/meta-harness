# Fleet × meta-harness integration — design

Status: all design decisions closed (D1–D9); self-review done. Pending:
user review gate, then writing-plans.
Decided: D1 node grammar, D2 prompt ownership (store is truth), D3 drive
platform, D4 master contract + OpenClaw seat, D5 squad evolution + full
event→score mapping + escalation taxonomy + communication grammar, D6
store topology, D7 repo boundary; **D8 master lifecycle & scaling (singleton
authority + composite scheduling, multi-project namespace, two-axis lifetime;
§9.4), D9 crash-consistency (atomic commit boundaries + restart reconciliation;
§9.5)** — both prior-art validated (`ai-dev-automation-survey.md`);
orchestration; squad flow; SquadDef schema.

Companion: [improvement-loops.md](../../improvement-loops.md) — how the
existing static & dynamic improvement loops work; this design plugs the fleet
in as a third regime.

---

## 0. What integrates with what

meta-harness today = one evolution core (store / compose / propose / judge)
with **two evaluation regimes**:

- **static** — TB2 bench (`runner.ts`, podman, verifier, k-trials, McNemar ab).
  Objective, repeatable, expensive. Feeds account layers.
- **dynamic** — runtime hosts (opencode plugin, cc-adapter). Live sessions,
  judge-prefilled human scores, trial gate. Free but weak-stats. Feeds
  project layers.

**The fleet does not exist yet.** When it does, it becomes a **third regime,
dynamic-class**: headless runtime like the plugin, but with denser and
better-labeled signal (typed failure routes, per-gate events instead of one
human score per session). Its role prompts are additionally grounded on the
static side (TB2) for statistical power.

Deliberate independence: the fleet must run with meta-harness absent (static
personas, no plugin in fleet targets) and meta-harness must prove its loop on
the bench alone. Integration = composition through two thin interfaces
(render, score), not mutual dependency.

## 1. Node grammar (DECIDED — D1)

Filesystem analogy: the **fleet is the root directory**.

```
node := agent | squad
agent := leaf executor (may own PRIVATE sub-agents — internal machinery,
         invisible to fleet topology, never separately scored)
squad := { Analyzer, Designer, Implementer, Evaluator }
         where EVERY slot is itself a node (agent or squad) → recursion
```

- 4-role squad: Analyzer / Designer split (oc-test's fused `architect`
  doctrine = legacy to migrate).
- `nodePath` = filesystem-style path (`root/slice-42/implementer.squad/analyzer`),
  recorded as provenance on every score record. Never a store split.
- Node interface, uniform at every depth:

```
run(input) -> payload | escalation
```

A parent cannot tell whether a slot is an agent or a whole squad behind it.

**Contract constraint (decided):** the node interface stays
**AgentDriver-compatible** — a squad node must be driveable as a bench arm
(task in, payload + telemetry out, classifiable failure) without bench
modification. No squad-on-bench machinery is built now; this one-paragraph
alignment keeps it a later adapter instead of a rewrite. Trigger to build:
tier-2 policy evolution needs referee-grade gating, or compositional
role-prompt effects need measuring.

## 1.5 Squad definition (DECIDED)

**Definition vs instance** (program vs process): a **SquadDef** is the
declarative, versioned artifact — the squad's evolvable "system prompt"
(§6 channel 2). A **squad instance** = SquadDef + nodePath + slice +
workspace, created at run time, never persisted as definition.

```jsonc
// store: squads/standard/candidates/vN/squad.json  (active pointer, same as layers)
{
  "type": "standard",              // store key: squad:standard
  "slots": {
    "analyzer":    { "kind": "agent", "role": "mh-analyzer",    "platform": "opencode",    "model": "anthropic/claude-haiku-4-5" },
    "designer":    { "kind": "agent", "role": "mh-designer",    "platform": "opencode",    "model": "anthropic/claude-sonnet-4-6" },
    "implementer": { "kind": "agent", "role": "mh-implementer", "platform": "claude-code", "model": "anthropic/claude-sonnet-4-6" },
    "evaluator":   { "kind": "agent", "role": "mh-evaluator",   "platform": "opencode",    "model": "anthropic/claude-haiku-4-5" }
    // recursion: { "kind": "squad", "type": "standard" } in any slot
  },
  "flow": {
    "bounds": { "R1": 2, "R2": 1, "R3": 3, "globalBudgetSteps": 40 },
    "gatePolicy": { "gate1": "auto", "gate2": "auto" },   // root instance overrides to human
    "reentry": "delta"                                    // {prior artifact + question} -> revision
  },
  "wire": {
    "headings": {
      "analyzer":  [["## Use Cases", "## Functional Spec"], ["## Clarify"]],
      "designer":  [["## Alternatives", "## Recommended"]],
      // decided design.md + task DAG = Gate 2 OUTPUT (runner materializes
      // the chosen alternative), not a designer payload heading
      "evaluator": [["## Test Spec"], ["VERDICT:"]]
    },
    "verdictRe": "^VERDICT: (PASS|FAIL)"
  }
}
```

Rules:

1. **`type` = the store key** (`squad:standard`, §7). Evolve the def → all
   instances of that type inherit on next render. Instances distinguished by
   nodePath provenance only.
2. **Slot binding owns platform/model** (§5's per-slot config). The slot's
   `role` names which role store renders the persona.
3. **`wire` = the inter-role protocol, owned by its consumer.** The squad is
   what breaks when members stop speaking its protocol, so required headings
   + verdict regex live here, not in the role manifest. Render-time lint
   checks role candidates against the CONSUMING squad's wire block.
   (Consequence: T1's `FLEET_ROLES` shrinks to frontmatter/permission
   templates; headings move here.)
4. **Gate policy in the def is the default; instance position overrides** —
   a root instance forces human gates, inner instances keep the def's auto.
5. **Recursion = one line**: slot kind `squad` + type. No new schema.

### 1.5.1 What `flow` is — and is not

`flow` = the knobs of §3's state machine, never the machine:

- **Runner CODE (structure — tier 3, frozen):** states, edges (rules 1–14),
  escalation types, the slot pattern. Changing these = harness-code
  evolution = explicitly-not-now.
- **`flow` block (parameters — tier 2, evolvable):** what those rules read:

| Field | Parameterizes | §3 rules |
|---|---|---|
| `bounds.R1` | in-slot retries (self-check redo, syntax redo) | 1, 4, 8, 9 |
| `bounds.R2` | upstream hops (ambiguity, design-decision, FAIL-design/intent) | 5, 7, 11, 12 |
| `bounds.R3` | macro loop (FAIL-impl → Implementer) | 10 |
| `bounds.globalBudgetSteps` | whole-squad hard cap (ping-pong backstop) | 14 |
| `gatePolicy.*` | who decides at gates | §3.4 |
| `reentry` | delta (revise) vs full (regenerate) re-entry | §3.7-2 |

Whether an edge EXISTS is code's decision; how often it may fire, who
approves, and what re-entry carries are flow's decisions. Evolution can
safely turn knobs (bad R3=7 wastes tokens → selection rejects it — bounded
blast radius) but cannot rewrite topology (bad edge = infinite loop or
skipped verification — unbounded). This schema line IS §4's tier-2/tier-3
boundary, made physical.

## 2. Orchestration (DECIDED)

**Deterministic runner per squad.** No LLM orchestrator. A→D→I→E is a fixed
state machine in code; gate behavior is policy config; every loop has a
counter bound. Root master (OpenClaw) remains the only special node: human IO
(Slack), remote git, human gates.

The determinism is load-bearing for evolution: internal events stay
observable and stamp-attributed, so credit assignment (see §6) never has to
guess which member caused an outcome.

## 3. The squad flow (DECIDED — full state machine)

### 3.1 Universal slot pattern

Every slot runs the same micro-loop shape (the fractal, one level down):

```
[work step(s)] -> [self-check] -> route:
    ADVANCE   (downstream: next slot / squad output)
  | REDO      (internal retry, bounded R1)
  | UPSTREAM  (re-enter an earlier slot, bounded R2)
  | ESCALATE  (out of the squad, up the nodePath)
```

### 3.2 Flow diagram (ASCII)

```
 slice in
    |
    v
+-------------------- ANALYZER ---------------------+
| 1. analyze: slice -> use cases + functional spec  |
| 2. self-check: well-formed? intent clear?         |
|      malformed (<=R1) ----> goto 1                |
+---------------------------------------------------+
    |                       |
    | intent fork           | pass
    | ("## Clarify")        v
    +--> ESCALATE ^    {Gate 1: intent}  root: human / inner: auto
                        |         |
                 revise |         | approve
                 (goto Analyzer.1)|
                        +---------+-------------------------+
                                  |                         |
                                  v                         v
                    +--------- DESIGNER ---------+   +-- EVALUATOR (spec) --+
                    | 1. design: spec -> OOD     |   | author test-spec     |
                    |    alternatives+trade-offs |   | from functional spec |
                    | 2. self-check: interfaces? |   | (never from code)    |
                    |    test plan? covers all   |   +----------------------+
                    |    use cases?              |        (held for verdict)
                    |     incomplete (<=R1)->1   |
                    +----------------------------+
                        |                |
        spec ambiguous  |                | pass
        (<=R2)          v                v
        --> Analyzer.1  {Gate 2: OOD decide}  root: human / inner: auto-pick
                                 |            recommended
                          revise | decided design + task DAG
                          (goto  |
                        Designer.1)
                                 v
                    +-------- IMPLEMENTER ---------------------+
                    | 1. analyze-implementation:               |
                    |    design -> concrete edit plan          |
                    |      design decision needed (<=R2)       |
                    |      ------------------> Designer.1      |
                    | 2. implement                             |
                    |      inconsistency/design smell -> 1     |
                    | 3. dev-test: compile/syntax/lint ONLY    |
                    |      syntax error (<=R1) -> 2            |
                    +------------------------------------------+
                                 | pass
                                 v
                    +------- EVALUATOR (verdict) --------------+
                    | run test-spec + build + lint             |
                    | + adversarial diff review vs intent      |
                    |   and design                             |
                    | VERDICT:                                 |
                    |   FAIL impl   (<=R3) -> Implementer.1    |
                    |   FAIL design (<=R2) -> Designer.1       |
                    |   FAIL intent (<=R2) -> Analyzer.1       |
                    |   PASS -> payload out                    |
                    +------------------------------------------+
                                 | PASS
                                 v
                     payload (diff + report) -> parent node
                     at root: master -> human merge gate

 any bound exhausted anywhere --> ESCALATE up the nodePath
                                  with failure report (never silent-loop)
```

### 3.3 Routing rules

| # | From | Condition | To | Bound |
|---|---|---|---|---|
| 1 | Analyzer self-check | malformed payload | Analyzer.1 | R1 (default 2) |
| 2 | Analyzer self-check | genuine intent fork (`## Clarify`) | ESCALATE | immediate |
| 3 | Gate 1 | revise | Analyzer.1 | human gates: own counter (see 3.7) |
| 4 | Designer self-check | design incomplete | Designer.1 | R1 |
| 5 | Designer self-check | spec ambiguous | Analyzer.1 | R2 (upstream-hop cap, default 1) |
| 6 | Gate 2 | revise | Designer.1 | human gates: own counter |
| 7 | Implementer.1 | design decision needed | Designer.1 | R2 |
| 8 | Implementer.2 | inconsistency found | Implementer.1 | R1 |
| 9 | Implementer.3 dev-test | syntax/compile error | Implementer.2 | R1 |
| 10 | Verdict | FAIL — implementation | Implementer.1 | R3 (macro loop, default 3) |
| 11 | Verdict | FAIL — design flaw | Designer.1 | R2 |
| 12 | Verdict | FAIL — intent | Analyzer.1 | R2; invalidates test-spec (see 3.7) |
| 13 | any | bound exhausted | ESCALATE `Exhausted` + failure report | — |
| 14 | any squad total | global step/token budget exhausted | ESCALATE `Exhausted` | hard cap |

### 3.3.1 Escalation taxonomy (DECIDED — final)

Escalations are the ONLY thing that crosses node boundaries upward. They
bubble up the nodePath; only the root reaches the human (via master).

```
Clarify        { question }                     need info: intent fork
DesignDecision { question, options? }           need info: design fork
Exhausted      { bounds, failure report }       ran out of budget trying
Infeasible     { reason, evidence, suggestion? } reasoned: won't work as specified
Refused        { category: harm|policy, reason } alignment: won't ever
```

| | retry by runner | human override | scoring |
|---|---|---|---|
| Clarify / DesignDecision | resume with answer | n/a (it IS a question) | neutral (asking ≠ failing); meta-metric rate |
| Exhausted | no — more budget might help, human's call | rescope or re-run with bigger bounds | bad → squad def |
| Infeasible | no — reasoned conclusion | legitimate: abandon \| rescope \| override ("proceed anyway", rationale recorded) | human confirms → GOOD (correct rejection saves doomed slices); human overrides → bad |
| Refused | **never** — no R1, no re-drive (retry-pressure on a safety refusal is a harness bug) | **not a thing** — resume-directive disabled; human may only rescope; forcing is impossible (model refuses again) | **excluded from automatic scoring** — meta-metric + human-review flag only |

Emitters: any slot, post-analysis (Infeasible after real work, not
first-glance reflex). `Refused` originates in the underlying model's
alignment — the harness recognizes it (`classifyAttempt` types it as an
outcome, never a transient error), routes it, and stays out of its way.

**Safety-design rule:** `Refused` events never enter fitness. If refusals
could score bad, evolution would select for refusal-suppressing prompt
wording — the fitness gradient must never point across the safety boundary.
Over-refusal from clumsy prompts is fixed by human-initiated candidates,
never by automatic selection pressure. (Same principle as master invariants
in the shell: evolution touches eloquence, never obedience.)

Defense-in-depth for harmful instructions (e.g. "turn off the ECMO"):
(1) capability scoping — permission-scoped worktrees, no device/network
reach, tier-3 code; (2) model alignment refuses; (3) taxonomy carries the
refusal cleanly to the human. The flow never relies on (3) alone.

### 3.4 Gate policy

Gates are **policy, not structure**: `gatePolicy: human | auto` per node.

- Root squad: Gate 1 (intent), Gate 2 (OOD decision), merge gate — human,
  via master in Slack.
- Inner squads (depth >= 1): auto — Gate 1 approves any well-formed intent,
  Gate 2 picks the designer's recommended alternative.

### 3.5 Key properties

1. **Same loop at every scale.** Slot micro-loop == squad macro-loop ==
   fleet level. `run(input) -> payload | escalation` is function-call
   semantics: escalation = typed exception, nodePath = stack trace.
2. **Upstream edges make it a feedback system, not a waterfall** — and every
   one is bounded, so every execution terminates in PASS-out or ESCALATE-up.
3. **Typed backward edges = built-in credit assignment.** FAIL-impl vs
   FAIL-design vs FAIL-intent arrive pre-labeled with which role owns the
   failure — richer diagnosis than any single PASS/FAIL.
4. **Anti-circularity preserved.** Evaluator authors the test-spec from the
   functional spec right after Gate 1 — before any code exists.
5. **Private sub-agents stay private.** Runner neither sees nor scores them.
6. **Cost-staged verification.** Syntax-only dev-test before the expensive
   evaluator.

### 3.6 Sample trace

```
Analyzer pass -> Gate1 approve -> [Evaluator writes test-spec]
Designer pass -> Gate2 decide
Implementer.1: missing design decision -> Designer.1 (R2: 1 spent)
Designer pass -> Gate2 (auto) -> Implementer.1 -> .2 -> .3 syntax error
  -> .2 -> .3 pass
Verdict: FAIL impl -> Implementer.1 (R3: 1 spent) -> ... -> Verdict PASS
payload -> parent (root: master -> human merge gate)
```

### 3.7 Pinned contracts (from design review)

1. **Self-check depth boundary.** Slot self-check = FORM only (payload
   headings, schema — mechanical lint, code not LLM where possible).
   Substance belongs to the Evaluator + tests. If self-check grows judgment,
   grade-own-homework circularity returns.
2. **Re-entry contract.** Upstream re-entry delivers
   `{prior artifact + specific question}` and expects a REVISION, not a
   from-scratch rewrite (else churn burns R2 without converging).
3. **Artifact versioning.** design.md v2 after re-entry: define what
   survives (task-DAG diff); rule 12 invalidates the test-spec — Evaluator
   re-authors after any Analyzer re-pass.
4. **Global budget.** Per-edge bounds don't cap compound cycles
   (I→D→I→D ping-pong); rule 14's per-squad step/token budget is the
   backstop.
5. **Human-gate counters separate from machine counters.** Human revisions
   at root gates must not exhaust machine retry bounds.

### 3.8 Communication grammar (DECIDED) — star per squad, no sibling channels

- **Vertical (parent ⇄ child):** duplex over process boundaries,
  request/response only — invocation input + `--resume --gate-answer/
  --directive` down; payload / typed escalation up (§9.1, §3.3.1). No live
  socket; a child never chats mid-drive.
- **Horizontal (slot ⇄ slot): none.** All sibling communication = typed
  artifact exchange routed through the runner: spec via Gate 1, design.md
  via Gate 2, re-entry `{prior artifact + question}` for design gaps,
  test-spec/VERDICT via rules 10–12. The payload IS the message; wire
  headings are the message format.

Why no direct channel (each load-bearing): (1) credit assignment — an
unlogged sibling DM makes FAIL attribution undecidable; scoring (§6)
presumes runner-mediated influence; (2) artifact truth — Q&A forced through
re-entry lands every clarification in design.md, so approved design ==
built design; (3) wire lint runs at runner boundaries, DMs bypass it;
(4) node opacity — a sibling may be a whole squad, "chat" is undefined,
artifact exchange stays well-defined; (5) determinism/replay.

Re-entry cost mitigations: `reentry: delta`; inner gates auto; optional
later flow knob — Gate 2 distinguishing material-change (re-gate) vs
clarification-annotation (auto).

**Peer collaboration = composition, not messaging:** if two roles ever need
to genuinely collaborate (pair-programming pattern), the pair becomes a
sub-squad node. Every level stays a star.

## 4. Evolution surface — what meta-harness improves here

Three tiers, decreasing directness:

**Tier 1 — role prompts (NOW; this is the T1–T6 plan):**

| Flow element | Meta-harness piece |
|---|---|
| Slot prompt bodies (A/D/I/E) | 4-layer store per role name; compose renders agent files |
| Which version ran | render stamp -> pins -> exact-candidate attribution |
| Gate/verdict events | scores into role stores (see §6) |
| Failure runs | NDJSON trajectories -> proposer diagnosis |
| Candidate gating | TB2 ab (solo role grounding) or trial gate (live fleet) |
| Slot self-check | mh-judge + judge-audit (calibration built in) |

**Tier 2 — flow parameters (config-as-text, cheap addition):** bounds
R1/R2/R3, gate policy, self-check lint rules, re-entry templates — rendered
per squad like a layer, versioned in the same store, evolved under the same
selection gate. Signal: per-slice meta-metrics (redo counts, upstream hops,
tokens, escalation rate, merge rate). Trial-gate stats until squad-on-bench
exists.

**Tier 3 — flow STRUCTURE (edges, steps, state machine): explicitly not
now.** Harness-code evolution, red zone in explicitly-not-now.md. Reopen
trigger: report-loop plateau on tiers 1–2.

**Reverse direction:** the flow improves meta-harness — typed backward edges
hand the proposer LABELED failure attribution (which role failed, how),
richer than TB2's binary pass/fail.

## 5. Drive platform (DECIDED — D3)

**Both platforms, via the existing AgentDriver seam; host excluded.**

```
AgentNode(role, platform, model).run(input):
  render   role layers -> platform persona file      [compose / T1 render]
  spawn    platform driver argv on host workspace    [AgentDriver seam]
  parse    driver.parseOutput -> payload + telemetry
  classify driver.classifyAttempt -> advance | redo | escalate
  record   recordToStores(stamp pins, nodePath env)  [T4 score path]
```

- Squad runner sits ABOVE the driver: never knows which platform a slot ran
  on. Mixed squads legal (e.g. haiku-opencode analyzer + sonnet-CC
  implementer).
- Platform + model = per-slot manifest config, overridable per drive.
- **HarnessHost is deliberately excluded from fleet targets** (plugin-off
  requirement): a leaf node is pure caller semantics (drive/parse/classify),
  the host is callee semantics (live in a platform's event loop). The two
  seams converge only at recordToStores.
- opencode = first-proven path (T0). **CC persona probe = precondition
  task** before the CC leaf lands: prove headless persona injection
  (.claude/agents/*.md vs --append-system-prompt) and per-platform
  permission rendering (opencode frontmatter `permission:` vs CC settings).

## 6. Squad evolution — how a squad improves without a central prompt (DECIDED — D5 core)

**Principle: every node owns exactly ONE evolvable artifact.**

- Agent node: its `system.md`.
- Squad node: its **manifest + flow policy** (slot->role mapping,
  model/platform per slot, bounds, gate policy, re-entry templates). That IS
  the squad's "system prompt": the behavior-determining text that lives in no
  member. Tier-2 artifact, same store machinery.

**Channel 1 — members improve via INTERNAL signal.** The runner's typed
events are per-member fitness, already labeled.

**Granularity rule: one score per DRIVE (slot invocation), adjudicated by
the drive's natural judge.** Slot micro-loop steps are the agent's internal
business inside one session; the runner scores only what it can adjudicate:
gates, verdicts, lint. A revise scores that drive bad; the re-drive is a new
session scored on its own outcome. Matches per-session store machinery
exactly.

Full event -> score mapping (DECIDED — D5):

| Event | Artifact scored | Score |
|---|---|---|
| payload lint fail (wire headings) | that slot's role | bad — automatic, objective |
| Gate 1 approve / revise | analyzer | good / bad |
| Gate 2 decided / revise | designer | good / bad |
| VERDICT PASS | implementer | good |
| VERDICT FAIL-impl | implementer | bad |
| VERDICT FAIL-design | implementer NEUTRAL (absolved); designer's revision drive scored at its own Gate 2 | — |
| evaluator payload well-formed (spec + verdict) | evaluator | good / bad (v1, lint-grade) |
| root merge accept / reject | squad def (channel 2); merge-reject also flags the implementer's VERDICT-PASS for evaluator-v2 accounting | good / bad |
| `Exhausted` | squad def | bad |
| `Infeasible` — human confirms / overrides | analyzer (or emitting slot) | good / bad |
| `Refused` | — | NEVER scored (§3.3.1 safety rule) |
| inner-squad payload at outer gate/verdict | inner squad def | good / bad (parent's judge scores the child-squad) |

**Meta-metrics, NOT scores** (proposer diagnosis + plateau + tier-2
fitness): redo counts, upstream hops `{from,to,reason}`, Clarify rate (also
the master slice-quality proxy), dev-test retry counts, tokens/cost per
drive and slice, human gate latency, bound exhaustion locations, FAIL-cause
distribution, Refused occurrences (flagged for human review).

Three deliberate calls:

1. **No retroactive scoring.** A later-discovered design gap lands as an
   upstream-hop meta-metric; the design REVISION gets its own score. Scores
   stay append-only, attribution unambiguous.
2. **Clarify = neutral, never bad.** Punishing escalation of genuine
   ambiguity trains analyzers to guess.
3. **No weights.** Binary good/bad into existing nPass/nFail. Weighting =
   premature sophistication with zero evidence.

**Evaluator v2 (deferred until merge outcomes accumulate):**
confusion-matrix scoring against downstream truth — PASS+merge-accept =
good, PASS+merge-reject = bad (missed defect), FAIL+human-override = bad
(false alarm), FAIL+fix-confirms = good. Same trick as judge-audit:
calibrate the gate against the oracle behind it.

Each slot scored at its own gates -> recordToStores with stamp pins -> the
role-name store — identical to a lone agent. Members get their own reviews,
not just the company's stock price.

**Channel 2 — squad-level score improves the squad's OWN artifact.** Parent
gate on the squad's payload + slice meta-metrics (cost, iterations,
escalation rate, merge outcome) = fitness for manifest/policy candidates.
Trial-gate stats now; referee-grade later via squad-on-bench (§1 contract).

Squad-level scores also flow down as a weak tiebreaker (participating
versions logged in provenance), but primary member signal = local gates.

**Fractal consistency:** "one node = one artifact + a score channel for its
children" recurses — a sub-squad in the implementer slot owns its policy,
its members their prompts, and its VERDICT feeds the outer implementer-slot
score.

## 7. Store topology (DECIDED — D6, reaffirmed)

One evolvable store per role NAME across all depths. `nodePath` is
provenance on records, never a store split — depth-3 analyzer and depth-1
analyzer pool learning. Squad policies get store names by squad type (e.g.
`squad:standard`), instances distinguished by nodePath provenance.

## 8. Ordering constraint (Gall)

The base evolution loop has produced zero accepted candidates end-to-end.
Sequence, non-negotiable:

1. **Close the simplest working loop first**: k=5 store-writing baseline ->
   one propose -> one ab -> one accept/reject. (Also seeds the proposer:
   old baselines were --no-store, the store holds no trajectories yet.)
2. Depth-1 squad E2E, opencode-only, plain agents in all 4 slots,
   demo-script master (existing T1–T5 plan).
3. Live fleet scores accumulate; CC leaf after its probe.
4. Recursion when a real slice needs a sub-squad — not before.
5. Tier-2 policy evolution after tier-1 accepts candidates.
6. Mixed-platform squads later still.

Recursion stays cheap the whole time because it's an interface property
(uniform node contract), not machinery.

## 9. Master — the boundary layer (DECIDED — D4)

**Self-orchestrating squads demote the master from orchestrator to boundary
layer**: the shell between human and fleet. (Filesystem analogy: squads =
directories, agents = files, master = the shell that spawns root and relays
its IO to the human.)

Irreducible master jobs — everything that cannot move into the runner:

| Job | Why it stays |
|---|---|
| Slack dialogue, slice intake (backlog -> slice text) | needs LLM + human conversation — the one legitimately LLM-ish part |
| Invoke root node `run(slice)` | someone must call root |
| Answer root gates (1, 2, merge) | human decisions, async via Slack |
| Receive escalations (all five §3.3.1 types) | terminal point of the bubble-up chain |
| Remote git: push, PR | side-effect owner — sole-remote-writer invariant survives |
| Emit merge-gate score (role-score) | fitness for the squad artifact |
| Re-run roles-render on activation | keeps personas current |
| `.fleet/state.json` | cross-slice memory |

### 9.1 Gate mechanism — checkpoint/resume, no callbacks

```
squad-run --project X --slice s.md --gate-policy root=human
  -> runs until Gate 1 -> writes state checkpoint -> exits
     {status: "gate", gate: "gate1", payload: <analyzer output>}
master relays to Slack; human answers
squad-run --resume --gate-answer approve
  -> continues to next pause point
exit statuses: done | gate | escalation   (escalation payload carries its
                                           §3.3.1 type — Exhausted is a type,
                                           not a separate status)
```

Same idiom as `ab --resume` (proven in-codebase). Inner squads never pause
(auto gates); only root exits-and-waits. Escalations use the identical
mechanism. Master shells exactly four subcommands: `roles-render`,
`squad-run`, `role-run` (single-node drives / debugging), `role-score`.

Interim (Gall): the T5 demo script is the master stand-in — auto-answers
gates, prints escalations. OpenClaw wiring happens fleet-side, later,
against this frozen contract.

### 9.2 Master platform (DECIDED): OpenClaw

The master's defining requirement is **inbound-event residency**: it must
wake on a human Slack reply days later — a persistent, messaging-native
daemon. That is OpenClaw's architecture. opencode/CC are structurally the
wrong shape for this seat: ephemeral sessions, no inbound-message trigger
(gluing them in = rebuilding OpenClaw poorly around `claude -p` one-shots).

The stack asymmetry is principled, one tool per layer:

- **Nodes** = caller semantics -> AgentDriver -> opencode / claude-code.
- **Master** = callee-of-human semantics (host-nature w.r.t. Slack) ->
  OpenClaw.

oc-test's existing OpenClaw investment (doctrine, installer, Slack Socket
Mode, gh-guard plugin enforcing sole-remote-writer) carries over. Pin the
OpenClaw version like any other platform dependency.

> ⚠️ **TRANSPORT NOTE (2026-07-16 research, `docs/master-open-questions-research.md` R1):**
> **Slack Socket Mode has NO offline durability** — a human gate reply arriving
> while the master daemon is DOWN is silently dropped (Slack docs: "you may lose
> events"). For an *unattended* master this needs a durable inbox. But ours is
> **human-directed**, so the mitigation is cheaper: the human is the durability
> layer — a down master fails to ack (→ human re-sends), and the human's workflow
> **asks the master to confirm prior instructions were processed** (catching the
> acked-then-crashed case too). **REQUIRED: the master must expose its
> processed-instruction / pending-gate state** so the human can verify + re-send
> drops. Prefer **Telegram getUpdates** or **Slack-HTTP + Delayed Events** over
> Socket Mode so a re-sent reply reliably lands. Durable inbox + persist-before-ack
> = optional hardening, deferred until the master is unattended / higher-volume.

### 9.3 Improving the master itself

Master = two materials:

1. **Shell (code, tier 3 — never evolved):** subcommand calls,
   checkpoint/resume relay, git mechanics, state. **Safety invariants live
   here**: halt-on-PASS, sole-remote-writer, human-owns-outward-actions.
   The persona can phrase and propose; every side effect goes through shell
   functions that enforce the halt. Persona proposes, shell disposes —
   evolution can degrade master's eloquence at worst, never its obedience.
2. **Persona (text — evolvable, `mh-master` role store):** slice
   formulation, gate-question phrasing, escalation summarization, PR
   descriptions.

Fitness signal, three sources:

1. **Human scores via the existing dynamic loop** — master sessions are
   human-facing conversations, exactly what capture -> judge -> /mh-score
   was built for. Mechanically requires an OpenClaw HarnessHost adapter
   (third host; the seam exists for this).
2. **Downstream proxies (objective-ish, free):** slices carry the master
   version stamp -> analyzer Clarify/escalation rate ON THOSE SLICES =
   slice-quality signal. Same trick as evaluator's verdict-vs-merge:
   judge a boundary role by what happens across the boundary.
3. **Merge-gate friction** — human revise rate at gates master presented.
   Confounded; tiebreaker only.

**Automation order (risk-sorted; master deliberately LAST):**

```
implementer, evaluator   verifier-groundable       -> automate first
analyzer, designer       gate-scored               -> next
squad policy (tier 2)    slice meta-metrics        -> after tier-1 accepts
master persona           human scores + proxies    -> LAST (hold)
```

Held last: weakest signal (subjective), highest blast radius (human trust +
outward actions). Evolving the human interface before the loop proves itself
on verifier-grounded roles = maximum risk, minimum evidence.

### 9.4 Master lifecycle & scaling (DECIDED — D8)

Formalizes the master↔node asymmetry §9.2 asserts, and how one master scales
to many projects. **Prior-art validated** (2026-07-16 survey, `ai-dev-automation-survey.md`):
persistent-supervisor + ephemeral-workers is the dominant production pattern
(Fortune-500 supervisor-worker, Temporal durable-execution namespaces,
OpenHands DAG, MS orchestrator-subagent); OpenClaw itself is one persistent
Gateway daemon spawning ephemeral `claude -p` workers, resumed by stored
session IDs — the exact shape of this seat.

**Two orthogonal axes — separate them or the model gets muddled:**
- **Authority** (permission, credential root, human-gateway, the must-never-self-widen part) vs **skill** (LLM domain work). Master carries authority + *deterministic* orchestration; skill lives in the LLM leaves. Master has no OOA/OOD of its own — it delegates decomposition to a Designer-node (self-hosting N4) and only schedules. Keep the master deterministic (no LLM planner) — that is what buys "predictable/debuggable/accountable" over autonomous swarms.
- **Process-lifetime** (ephemeral ↔ daemon) vs **state-durability** (always durable/resumable). These are independent. State-durability is **universal** — every node is resumable (park & reopen) via the opencode/CC session store + the squad checkpoint; §9.1 exit-and-wait already rides it. Process-lifetime is a **per-node policy** (default *ephemeral*; master = *daemon*; a node is *promotable to daemon* for interactive-latency or an event-reactive "patrol"). Lifetime joins gate-policy + credential-scope as a per-node evolvable policy attribute.

> Substrate verified from source (2026-07-16, `~/z2/opencode/packages/opencode/src/cli/cmd/run.ts`): headless `opencode run` **persists sessions by default** — its `session()` resolver's default path is `sdk.session.create(...)` (line ~519), producing a listable/gettable/forkable session. Resume: `--continue`/`-c` (most-recent root session, via `session.list().find(!parentID)`), `--session`/`-s <id>` (`session.get` — missing id → "Session not found" + `exit 1`), `--fork` (fork before continuing), `--replay` (replay history on resume). We already capture each drive's `ses_…` (`run.ts` `extractSessionId`). Today park/reopen re-drives from the **squad checkpoint** with a fresh session (correct-by-construction), NOT via opencode's own `-s` resume. Using `-s` to skip the re-drive is a *future cost optimization*, gated on: pass `--dir = worktreeDir` explicitly (opencode #28581 — `-s` can bind to the launch dir, not the session's stored dir) and clear `OPENCODE_SERVER_{PASSWORD,USERNAME}` (opencode #28407 — set by the desktop app, they break headless `run`'s in-process HTTP client → the same "Session not found"). So the *substrate* exists; we deliberately rely on our own checkpoint until that optimization is worth it.

**D8 decisions:**

| # | Decision | Rationale |
|---|---|---|
| D8.1 | **Master = persistent singleton *authority*** — a thin coordinator + durable log, NOT a busy executor. Skill in leaves; orchestration deterministic. | Singleton = one logical authority/namespace, not one process. Scaled by externalized state (§9.1 checkpoint, D6 store, self-hosting `runtimeRoot`), so it is restart-safe, not a throughput bottleneck. Matches OpenClaw's single Gateway hub. |
| D8.2 | **Singleton authority + *composite* scheduling** — one master; sub-fleets = composites of nodes driven by *ephemeral sub-schedulers*, never persistent sub-masters. | Structure + orchestration recurse (the fractal); *authority* does not. Composite authority = N persistent daemons + N credential roots = fragmented durable state + a larger security surface, for no gain. |
| D8.3 | **Multi-project under one master** via a **project namespace**: per-project isolation of store-slice / worktrees / integration-branch / credential-scope / gate-policy, plus **fair-share scheduling under one global resource cap** (shared LLM rate-limit / disk / API quota — the real noisy-neighbor risk). | OpenClaw runs many isolated agents on one Gateway (own workspace/agentDir/creds, "never share"); Temporal namespaces many workflows on one service. Project count does NOT force composite. |
| D8.4 | **Lifetime = two axes** (above): state-durability universal; process-lifetime a per-node policy, default ephemeral. | Ephemeral process + durable state = the Temporal principle: resume-from-durable beats holding a live process (disk not RAM at scale; less retained state = lower security surface; restart-safe). |
| D8.5 | **Composite / per-tenant sub-master DEFERRED** to a **trust-boundary** trigger — projects with a different owner/org/host/credential domain, or an availability SLA a restartable singleton can't meet. Multi-*tenant* triggers it; multi-*project* does not. | Register in `explicitly-not-now.md` (§2.15). Same-owner many-projects → singleton is correct + simpler. |

**D8.3 does NOT reopen D6.** The "per-project store-slice" is the *existing*
account/project store-layer boundary (the outer scope axis) — projects were
always separate stores. D6 ("one store per role NAME across all depths,
nodePath = provenance") governs *intra*-project pooling across squad depth and
is untouched: within a project, all depth-N `implementer`s still share one
role store. Project namespace = outer layer; D6 = inner pooling. No new
store-splitting axis.

### 9.5 Crash-consistency — ephemeral nodes vs system-down (DECIDED — D9)

Ephemeral node processes are safe against a mid-run crash NOT because nothing
is lost, but because **incomplete work is discarded, not consumed** — the
system only ever advances past an **atomic commit boundary**. A crash costs
the in-flight step's compute (re-run it, ≤ the concurrency cap), never a
corrupt or half-merged artifact. This is the durable-execution guarantee
(Temporal replays incomplete activities; Gas Town: Git-backed state, resume
from last checkpoint; LangGraph durable-checkpoint/resume).

**Atomic boundaries (already the design's shape):** worktree edits are real
only after `git commit`; a node is done only after its checkpoint + score are
written; a merge is real only after its merge commit exists. Anything before
its boundary sits outside the durable record → thrown away on restart, never
consumed. **git itself is the crash-consistent artifact store** (objects
durable once written; ref update = lockfile+rename, atomic) — the integration
branch's commits ARE the durable truth of completed nodes.

**D9 requires (land with self-hosting N1b/N5a). Current atomicity is uneven (verified):**
`saveCheckpoint` (`squad-cli.ts:83-88`) and the squad-def score channel
(`squad-def.ts:348`) already use `writeJsonAtomic` (temp+rename,
`bench/util.ts:68-74`); the **role-store `score.json`** (`harness-store.ts`
`writeJson:476-479`, via `recordSession`/`createCandidate`) is a plain
`writeFileSync` — **NOT atomic**. So:
1. **Atomic durable-state writes.** Make the **role-store `score.json`** atomic, and write the **new N5a DAG-scheduler-state** via `writeJsonAtomic` from the start (a torn DAG-state file = an unrecoverable run). Checkpoint + squad-def score already comply. **Also fsync-harden**: `writeJsonAtomic` does temp+rename but **no `fsync`** — it survives a torn write / process crash but not a power-loss before the rename is flushed. Add `fsync(file)` + `fsync(dir)` to the shared writer for true system-down durability (currently absent everywhere).
2. **Restart reconciliation** in the scheduler: on launch, reconcile persisted *intent* against *git truth* — abort any in-progress merge (`MERGE_HEAD` present), treat a node whose commit-SHA is on the integration branch as done, re-drive nodes that were live at crash, discard their partial worktrees. Idempotent (re-merging an applied commit = no-op).
3. **Per-phase completion flag** in the checkpoint so resume re-runs only the in-flight phase, not completed ones.

Crash blast radius is bounded to the nodes live at crash; completed nodes'
commits + the DAG-state survive. This is another argument for the self-hosting
**N1b** decision (durable ledger in `runtimeRoot`, never the throwaway worktree).

## 10. Prompt ownership (DECIDED — D2): the store is truth

oc-test `doctrine/*.md` is imported ONCE (`roles-import` -> account-role v1);
after that the meta-harness store owns all role-prompt truth. Platform
persona files (opencode agents-md, CC agents, master doctrine) are RENDERED
outputs.

Why not the alternatives:

- *Doctrine-as-truth*: a PR round-trip per candidate kills automated
  trial/ab cycles; attribution breaks; the store degrades to a cache with
  drift.
- *Split truth (identity in doctrine, guidance in store)*: the protection it
  seeks already exists structurally — manifest owns frontmatter
  (permissions/mode/model) as code, squad-def wire lint blocks
  contract-breaking bodies, master invariants live in the shell. Only body
  guidance evolves, and it is gated.

Riders:

1. **Rendered persona files are committed into fleet targets** — the fleet
   runs standalone; the store is needed to CHANGE prompts, not to run them
   (§0 independence).
2. **Human edits are first-class**: manual candidate -> activate -> render.
   Hand fixes enter the same attribution stream as proposer output — a
   regressive hand edit is caught by the same gates.
3. After import, oc-test doctrine = bootstrap artifact (mark legacy or
   delete in the fleet-side rework; delivery mechanics = D7).

---

## 11. Repo boundary (DECIDED — D7)

**oc-test stays read-only for ALL integration code**, with exactly one
bounded exception executed immediately: a docs-only commit to oc-test
(`KNOWN-ISSUES.md`) delivering the shell->bash permission-key bug flag —
safety-relevant knowledge does not wait on a rework schedule; bug delivery
is not integration coupling.

Everything else flows one way:

- meta-harness ships the recipe (`docs/fleet-integration.md`, T6) +
  this spec's frozen contracts (node interface, 4 subcommands,
  checkpoint/resume statuses, SquadDef schema, wire lint).
- Fleet-side sessions (in oc-test, later) do: 4-role doctrine split for
  import, master shell wiring against the frozen contract, doctrine
  retirement after `roles-import` verifies (doctrine/ -> legacy/ or
  delete), installer rework.
- meta-harness also fixes its own stale `fleet-context.md` pointers (dead
  branch, dead plan file, 4-role-as-existing description) — done with this
  decision.

## Open decisions (queue)

None — all decisions (D1–D9) closed (D8 master lifecycle & scaling, D9
crash-consistency added 2026-07-16, §9.4/§9.5). Next: spec self-review, user
review gate, then writing-plans.

## Pre-registered future experiment: Gauntlet-shaped Evaluator (added 2026-08-01)

Registered BEFORE any fleet build (Gauntlet adoption loop, phase 2 —
`docs/superpowers/plans/2026-08-01-gauntlet-adoption-loop.md`). When the
fleet exists: A/B two squad variants as bench arms (both AgentDriver-
compatible per §1's contract, so no bench modification): (a) plain
Evaluator per this spec; (b) Gauntlet-shaped Evaluator — wire adds a
concrete reference-bar input the Evaluator must compare the artifact
against, verdict payload adds a single ranked biggest-gap sentence that
`reentry: "delta"` feeds back to the producing slot. Same slots, models,
bounds otherwise. Verdict machinery: TB2 paired k-trials + McNemar, same
standard as harness candidates. Decision rule frozen now: adopt (b) into
SquadDef default only on a certified win; otherwise plain Evaluator stands
and the comparison records as evidence. No spend authorized here.
