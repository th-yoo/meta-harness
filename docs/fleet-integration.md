# Fleet × meta-harness integration — recipe (T6)

This is the recipe for wiring a real dev-fleet (a `master` orchestrator plus
an opencode squad of `analyzer`/`designer`/`implementer`/`evaluator` roles)
onto meta-harness's evolvable-prompt store. It sources content from, and
never overrides:

- the frozen design spec —
  [`docs/superpowers/specs/2026-07-13-fleet-squad-integration-design.md`](superpowers/specs/2026-07-13-fleet-squad-integration-design.md)
  (D1–D7, all decisions closed);
- the meta-harness-side implementation plan —
  [`docs/fleet-integration-plan.md`](fleet-integration-plan.md) (T0–T6, live
  probe results);
- [`docs/fleet-context.md`](fleet-context.md) — background on the fleet
  itself (`~/z2/oc-test`).

**Repo boundary (spec §11, D7):** `oc-test` stays read-only for all of this
integration code. Meta-harness ships this recipe plus the frozen contracts
(node interface, subcommands, checkpoint/resume statuses, SquadDef schema,
wire lint); the fleet-side rework (4-role doctrine split, master shell
wiring, doctrine retirement, installer rework) happens later, in `oc-test`,
against the contracts frozen here. The one bounded exception: a docs-only
`KNOWN-ISSUES.md` commit in `oc-test` (`711298b`) flagging a bug found
during this integration's T0 probe (§3 below) — it exists in `oc-test`
already.

## 1. Node / squad grammar (spec §1, §1.5)

Filesystem analogy: **the fleet is the root directory.**

```
node := agent | squad
agent := leaf executor (may own PRIVATE sub-agents — internal machinery,
         invisible to fleet topology, never separately scored)
squad := { Analyzer, Designer, Implementer, Evaluator }
         where EVERY slot is itself a node (agent or squad) → recursion
```

Every node, at any depth, exposes the same interface:

```
run(input) -> payload | escalation
```

A parent cannot tell whether a slot is a single agent or a whole squad
behind it — that opacity is what makes recursion "one line" in the schema
(a slot's binding becomes `{ kind: "squad", type: "standard" }` instead of
`{ kind: "agent", ... }`; §4 below describes the SquadDef shape this lives
in, §10 below covers where recursion actually stands in the current
runtime) rather than new machinery.

**`nodePath`** is a filesystem-style path recorded as **provenance only** on
every score record — e.g. `root/demo-slice/analyzer`, or, at depth 2,
`root/slice-42/implementer.squad/analyzer`. It is never a store split: one
evolvable store exists per role **name** across every depth (spec §7, D6) —
a depth-3 analyzer and a depth-1 analyzer pool learning into the same
`account-role` store for `mh-analyzer`. This repo's current wiring
(`opencode-plugin/src/fleet/squad.ts`) drives exactly one depth (a single
standard squad, sequential A→D→I→E) — see §10 "known v1 limitations" for what
recursion needs before it's real.

The convention this repo's runner emits: `root/<sliceId>/<phase>`, where
`<phase>` is one of `analyzer | evaluator-spec | designer | implementer |
evaluator-verdict` (the two evaluator-invoking phases share the `evaluator`
role/wire slot but are distinct nodePath entries).

## 2. Subcommands & exit statuses (spec §9.1)

Two one-time setup commands, run once per account / per target repo:

| Command | When | Notes |
|---|---|---|
| `squad-def-init` | once per account | writes+activates the `standard` SquadDef v1. Idempotent-refuse (dies) if already active — safe to re-run, just tolerate the nonzero exit. |
| `roles-import --from DIR [--map SRC=DEST1,DEST2]... [--force]` | once, ever (spec §10) | seeds each role's `account-role` v1 from a source doctrine directory. After this, **the store owns truth** — re-running needs `--force` and is a deliberate reset, not routine. |

The **master's four subcommands** (spec §9.1: *"Master shells exactly four
subcommands"*) — the ones a running fleet actually shells per slice:

| Command | Purpose |
|---|---|
| `roles-render --project DIR [--role R]... [--pin LAYER=vN]... [--force]` | compose each role's 4-layer store into `<project>/.opencode/agents/mh-<role>.md`, stamped. Re-run on every store activation (idempotent — a byte-identical re-render is a no-op). |
| `squad-run --project DIR --slice-id S (--slice "text" \| --slice-file F) [--resume --gate-answer approve\|revise] [--gate-policy root-human\|auto] [--squad-type T] [--json]` | drive one squad leg to its next non-running outcome; checkpoint to disk; print the outcome JSON. |
| `role-run --project DIR --role R [--model M] [--node-path P] [--slice-id S] [--timeout-sec N] [--json] (--input-file F \| "input")` | single-node drive — debugging / manual intervention, not part of the normal squad loop. |
| `role-score --project DIR --id ID good\|bad [--note S] [--node-path P] [--gate gate1\|gate2\|verdict\|merge\|lint\|infeasible]` | manual fitness entry — normally `squad-run` scores gates/verdicts itself; this is for the merge gate (root-only, master-owned) and any out-of-band correction. **`--gate merge` is special**: `squad-run`'s own evaluator-verdict PASS branch already auto-scores the implementer good/verdict *before* printing `done` (§5 below), so by the time the master calls `role-score --gate merge` the implementer's session has already been archived out of `pending/`. A merge-gate score therefore reads (and re-marks) the archived copy instead of dying "no pending fleet session" — it is a deliberate SECOND score of the same session. Refused on a THIRD attempt: merge-scoring the same id twice dies ("already merge-scored"). Every other gate keeps the original pending-only, single-score contract unchanged. |

**Checkpoint/resume, no callbacks** (spec §9.1):

```
squad-run --project X --slice-id s --gate-policy root-human
  -> runs until Gate 1 -> writes state checkpoint -> exits
     {status: "gate", gate: "gate1", payload: <analyzer output>}
master relays to Slack; human answers
squad-run --project X --slice-id s --resume --gate-answer approve
  -> continues to the next pause point
```

**Exit statuses: `done` | `gate` | `escalation`** — `Exhausted` is one of the
five §3.3.1 escalation *types*, carried inside the `escalation` status, never
a separate exit status. This repo's CLI (`squad-cli.ts`'s `cmdSquadRun`)
returns **process exit code 0 for all three** — the status distinction lives
entirely in the printed outcome JSON on stdout, not in the shell exit code.
A caller must parse the JSON to tell `done` from `gate` from `escalation`.

**Outcome JSON, with the `implementerSessionId` field (additive):**

```jsonc
// status: "done"
{"status": "done", "payload": "## Implementation Report\n...", "implementerSessionId": "ses_..."}
// status: "gate" — unchanged, no implementer drive to name yet
{"status": "gate", "gate": "gate1", "payload": "## Use Cases\n..."}
// status: "escalation" — implementerSessionId present only if an
// implementer drive ran before the escalation fired (e.g. R3 exhaustion
// mid FAIL-impl loop); absent for an analyzer-phase Clarify, etc.
{"status": "escalation", "escalation": {"type": "Exhausted", "body": "..."}, "implementerSessionId": "ses_..."}
```

`implementerSessionId` names the **implementer's** own drive id (`SquadState.
lastImplementerDriveId`, maintained independently of the generic
`lastDriveId` which gets overwritten by every analyzer/designer/implementer
transition) — never the evaluator's, even though the evaluator-verdict drive
is what actually ran last and closed the slice. This is what makes the
master's merge-gate scoring (`role-score --id <SESSION_ID> good|bad --gate
merge`, §2 table above) invocable at all from outcome data: the id doesn't
otherwise appear anywhere in the printed outcome JSON. The field is omitted
(not `null`) when no implementer drive has happened yet on this slice.

Inner squads (depth ≥ 1) never pause — their gates are always `auto`
(`gate-policy` defaults to `root-human`, which is an *instance-position*
override forcing both gates human regardless of what the SquadDef itself
says; pass `--gate-policy auto` to leave the def's own policy — `standard`'s
default is auto/auto — untouched, e.g. for a hermetic/inner run).

Interim (Gall, spec §9.1): there is no master yet. A demo script
(`smoke/fleet/squad-demo.sh`, §9 below) stands in — it auto-answers gates by
passing `--gate-policy auto`, and simply prints escalations rather than
routing them to a human.

## 3. Target-repo prerequisites

1. **`opencode.json` needs a provider block, and NO meta-harness plugin.**
   The plugin's headless-session capture path discards sessions after a
   5-minute score timeout and never exposes the session id — useless for
   fleet drives (`docs/fleet-integration-plan.md`'s "Decisive facts").
   Fleet targets are driven exclusively via `role-run`/`squad-run`'s own
   headless `opencode run --agent ... --format json` spawn
   (`opencode-plugin/src/fleet/run.ts`), which bypasses the plugin
   entirely — a plugin present in the target's `opencode.json` risks
   double-injection and an idle-hang hazard, and buys nothing.
2. **Host auth**: whatever host runs `role-run`/`squad-run` must have
   `opencode` on `PATH` and already authed (subscription token or
   `*_API_KEY`) — there is no separate fleet auth path.
3. **Rendered personas live at `<project>/.opencode/agents/mh-<role>.md`
   (plural `agents/`).** This is meta-harness's own render target
   (`render.ts`) and matches what a live T0 probe confirmed opencode reads
   headlessly. Note the naming mismatch with `oc-test`'s *existing*,
   pre-integration doctrine convention, which uses a **singular**
   `agents-fleet/opencode/agent/*.md` (see `docs/fleet-context.md`) — that
   directory is not consumed by this integration at all; once a target repo
   is fleet-managed, its personas live under the plural `agents/` path.
4. **Permission keys are `bash`/`edit`/`write` — never `shell`.** Verified
   live (T0 probe, §7 below): `permission: { shell: deny }` is **silently
   ignored** by opencode; only `bash: deny` actually holds under `--auto`.
   Full detail and impact: the fleet repo's own `KNOWN-ISSUES.md`
   ("opencode permission key is `bash`, not `shell`") — the one docs-only
   `oc-test` commit this integration made (spec §11's bounded exception).
   `opencode-plugin/src/fleet/roles.ts`'s manifest already uses the correct
   keys; this note is for anyone hand-editing or reviving older doctrine
   text that still says `shell:`.

## 4. SquadDef + wire contract-change procedure

A **SquadDef** (`opencode-plugin/src/fleet/squad-def.ts`) is the squad's
*one* evolvable non-prompt artifact — slot bindings, flow bounds, gate
policy, and the wire protocol (required payload headings + verdict regex)
its members must speak. It is versioned exactly like a role's system.md:
`squads/<type>/candidates/vN/squad.json` + an `active` pointer, under the
account root.

**Flow knobs** (the *parameters* of the fixed A→D→I→E state machine — the
edges themselves are frozen tier-3 code, never evolved; spec §1.5.1):

| Field | Parameterizes | §3 rules |
|---|---|---|
| `bounds.R1` | in-slot retries (self-check redo, syntax redo) | 1, 4, 8, 9 |
| `bounds.R2` | upstream hops (ambiguity, design-decision, FAIL-design/intent) | 5, 7, 11, 12 |
| `bounds.R3` | macro loop (FAIL-impl → Implementer) | 10 |
| `bounds.globalBudgetSteps` | whole-squad hard cap (ping-pong backstop) | 14 |
| `gatePolicy.*` | who decides at gates | §3.4 |
| `reentry` | delta (revise) vs full (regenerate) re-entry | §3.7-2 — **not yet consumed by the runner; see §10** |

**Changing the wire contract** (required payload headings a role must speak,
or the verdict regex) is a **deliberate, gated** act, not a routine edit:

1. Edit the def as a **new candidate** version (never mutate `active` in
   place) — e.g. bump `squads/standard/candidates/v2/squad.json`'s
   `wire.headings` or `wire.verdictRe`, then activate it.
2. Re-render every role against the new def:
   `roles-render --project DIR --force`. `--force` is required the moment a
   role's *current* stored body doesn't yet teach the new heading(s) —
   render lint (`render.ts`, spec §1.5 rule 3) refuses silently-broken
   contracts by default: *"render lint: mh-`<role>` body never mentions its
   wire headings ... — fix the prompt or pass `--force`"*.
3. Prefer fixing the role's prompt (new candidate, selection-gated) over
   leaning on `--force` long-term — `--force` is an escape hatch for a
   deliberate, human-reviewed contract migration, not a way to silence the
   lint permanently.

## 5. Event → score mapping (spec §6, D5 — verbatim)

**Granularity rule: one score per DRIVE (slot invocation), adjudicated by
the drive's natural judge.**

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

Every score routes through `recordToStores` on the **stamped** version
(the exact candidate that ran — `render.ts`'s stamp → `score.ts`'s pins),
immune to activation drift between render time and score time.

## 6. Escalation taxonomy (spec §3.3.1 — verbatim)

Escalations are the ONLY thing that crosses node boundaries upward. They
bubble up the `nodePath`; only the root reaches the human (via master).

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

**Safety-design rule:** `Refused` never enters fitness — enforced twice in
code (`score.ts`'s explicit guard die()s before any store write; `squad.ts`
detects and bubbles escalations, `Refused` included, *before* any `score()`
call is reachable on that payload).

## 7. T0 live-probe results (from `fleet-integration-plan.md`, run 2026-07-13, ~$0.03)

Run once, before any fleet code was written, against a scratch dir + minimal
`opencode.json` (provider only, no plugin):

1. **PASS** — agent-md body IS the system prompt headlessly (a marker
   planted in `.opencode/agents/mh-probe.md`'s body was obeyed under
   `opencode run --agent mh-probe --format json "say hi"`). Render targets
   md bodies directly; no `opencode.json agent.prompt` fallback needed.
2. **PASS** — CLI `--model` beats the frontmatter-pinned model (proven via
   `step_finish` cost math: haiku pricing on a sonnet-pinned agent).
   Manifest frontmatter = truth; `role-run --model` = explicit override.
3. **PASS, with a correction** — `permission: deny` holds under `--auto`,
   but the enforced key is **`bash`, not `shell`** (§3 above,
   `oc-test/KNOWN-ISSUES.md`).
4. **Bonus** — every `--format json` NDJSON event carries opencode's real
   `sessionID` (`ses_…`), and `step_finish` events carry per-step `tokens` +
   `cost`. `run.ts` uses this real id (falling back to a synthesized
   `fleet-<role>-<epochSec>-<hex>` only if extraction somehow fails) and
   rides the free token/cost telemetry into the pending file.

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `no rendered persona at <project>/.opencode/agents/mh-<role>.md — run roles-render first` | `role-run`/`squad-run` driven before `roles-render` ever ran for this project | run `roles-render --project DIR` first (and again after any store activation) |
| `auth error driving mh-<role>: the model credential was rejected ...` | host `opencode` isn't authed, or the token expired | refresh auth (`opencode auth login`, or a fresh host `opencode run`) or set a long-lived `*_API_KEY` — see §3.2 |
| `no checkpoint for slice '<id>' at <path>` | `--resume` passed but this project/slice-id never had a fresh `squad-run`, or the checkpoint file was moved/deleted | run the fresh (non-`--resume`) `squad-run` first; checkpoints live at `<project>/.meta-harness/runtime/fleet/squad-<slice-id>.json` |
| `--resume requires --gate-answer approve\|revise` | resumed without (or with a malformed) `--gate-answer` | pass exactly `--gate-answer approve` or `--gate-answer revise` |
| squad def / role store commands silently touch the wrong account root, or a **real** account store goes missing after running a script | **migration hazard** (see below) | read the next paragraph before setting `META_HARNESS_HOME` to a custom path on a machine that has never run any `runner.ts` command before |

**Migration hazard, in detail:** every `term-bench2/runner.ts` invocation
calls `migrateAccountRoot()` (`harness-store.ts`) once, which — the first
time an account root is resolved and the legacy, opencode-owned location
(`~/.config/opencode/.meta-harness`) still exists as a real (non-symlink)
directory — **moves** that legacy directory into place at the resolved new
root and leaves a symlink behind. This is a one-time, one-directional move.
The hazard: if you point `META_HARNESS_HOME` at a *new*, purpose-specific
root (e.g. an isolated smoke-test root) on a machine where that one-time
migration has never happened, the first `runner.ts` invocation will move the
**real** account store into that purpose-specific root instead of its
proper home. `smoke/fleet/squad-demo.sh` (§9) guards against this
explicitly; the same guard pattern (checking whether
`~/.config/opencode/.meta-harness` is already a symlink before setting a
custom `META_HARNESS_HOME`) should be copied by any other script that wants
an isolated account root.

## 9. Live smoke script

`smoke/fleet/squad-demo.sh` is the acceptance-level, real-tokens companion
to the hermetic pipeline test
(`opencode-plugin/test/fleet-e2e.test.ts`) — it shells the real
`squad-def-init` → `roles-import` (from this repo's test fixtures, **not**
`oc-test` — the fleet repo stays read-only) → `roles-render` →
`squad-run --gate-policy auto --json` chain against a throwaway git-init'd
project, using real opencode drives (3 haiku, 2 sonnet — per FLEET_ROLES
models), then prints the outcome
JSON and each role store's `score.json` `nPass`/`nFail` counts. It is
controller-run only (not part of CI — it spends real tokens) and carries its
own copy of the migration-hazard guard from §8. It is deliberately **not**
executed as part of this integration's own verification (no live tokens
spent by this repo's automated checks) — `bash -n` syntax-checked only.

## 10. Known v1 limitations

1. **Delta re-entry is unimplemented.** The SquadDef schema carries a
   `flow.reentry: "delta" | "full"` knob (spec §3.7-2: an upstream re-entry
   should deliver `{prior artifact + specific question}` and expect a
   revision, not a from-scratch regeneration), but the current runner
   (`squad.ts`) does not read `reentry` at all — every upstream re-entry
   (Designer.1 on a spec-ambiguous self-check, Analyzer.1 on FAIL-intent,
   etc.) re-drives the producer phase via the same full-input builder
   (`inputFor`) used for a first pass. In practice every re-entry today
   behaves as `"full"` regardless of what the def says. Closing this gap is
   future work, not part of this integration slice.
2. **`squad-run --json` is currently a no-op.** `cmdSquadRun` always prints
   the final outcome JSON to stdout unconditionally (matches the frozen
   contract's "on any non-running outcome, print outcome JSON to stdout,"
   which isn't `--json`-gated) — passing `--json` changes nothing
   observable today. It's accepted (and forwarded to `role-run --json`
   nowhere internally) so it typechecks as a reserved flag; treat it as a
   future extension point, not a working format switch, until it's wired to
   something.
3. **Recursion (a squad-kind slot binding) and the claude-code leaf are
   typed but not runtime-reachable in v1** — correcting an assumption from
   this task's own brief: there is **no `die()` guard** anywhere in the
   fleet module rejecting either. `SquadDef.slots`'s type
   (`squad-def.ts`) documents both possibilities (`{ kind: "squad", type }`
   for recursion; `platform: "claude-code"` for the CC leaf) as the
   DECIDED, forward-compatible schema shape (spec §1.5 rule 5, §5) — but
   the current runner (`squad.ts`, `squad-cli.ts`, `run.ts`) never reads
   `def.slots` at all. The state machine's five driving phases are
   hardcoded to `roleSpec`/`FLEET_ROLES` (`roles.ts`), which only ever
   describes the 4 fixed wire-slot roles on a single platform
   (`opencode`, hardcoded into `run.ts`'s `argv`). So neither recursion nor
   a claude-code slot has a code path to reach *at all* today — not
   rejected loudly, simply not wired up yet. Per spec §8's ordering
   (recursion "when a real slice needs a sub-squad — not before"; CC leaf
   "after its probe"), this is deliberate sequencing, not a bug — but a
   caller should not expect either a graceful `die()` message or working
   behavior if a SquadDef candidate is hand-edited to declare a `squad`-kind
   slot or a `claude-code` platform today.
