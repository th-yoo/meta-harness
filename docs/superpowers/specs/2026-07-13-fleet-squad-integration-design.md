# Fleet × meta-harness integration — design (WORKING DRAFT)

Status: brainstorm in progress.
Decided: node grammar (D1), orchestration, squad flow, drive platform (D3),
store topology (D6), squad evolution model (D5 core).
Open: D2 prompt ownership, D4 master contract, D5 remainder (exact
event→score table), D7 repo boundary.

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
      "designer":  [["## Decided Design", "## Task DAG"]],
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

Escalation payload types (the ONLY thing that crosses node boundaries
upward): `Clarify | DesignDecision | Exhausted`. Bubbles up the nodePath;
only the root reaches the human (via master).

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

### 3.7 Contracts still to pin in this spec (from design review)

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
events are per-member fitness, already labeled:

| Flow event | Score lands on |
|---|---|
| Gate 1 approve / revise | analyzer |
| Gate 2 decide / revise | designer |
| VERDICT PASS / FAIL-impl | implementer |
| FAIL-design routed upstream | designer (blame), implementer (absolved) |
| redo counts, clean handoffs | emitting slot |
| verdict-vs-merge agreement (later) | evaluator |

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
| Receive escalations (`Clarify \| DesignDecision \| Exhausted`) | terminal point of the bubble-up chain |
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
exit statuses: done | gate | escalation | exhausted
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

## Open decisions (queue)

- **D5 remainder**: exact event->score mapping table (which events are
  scores vs meta-metrics; weights; evaluator meta-scoring).
- **D7 — repo boundary**: oc-test read-only + recipe vs meta-harness writes
  adapters into oc-test (incl. the shell->bash permission-key flag, still
  only recorded meta-harness-side).
