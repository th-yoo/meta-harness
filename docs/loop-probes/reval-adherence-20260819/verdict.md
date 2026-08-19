# Revalidation wire-format adherence probe — verdict (2026-08-19, `yoo-dev`)

Scored against `pre-registration.md` + `amendment-01.md`, both written before
any call. Runner `run-probe.ts`; raw cells `out-{TRAP,CTRL}-r*.json`; voided
cells `out-VOID-gatetask-r*.json`.

**Headline: the arm stays BLOCKED, and the probe found a bigger blocker than the
one it was sent to measure — the shipped lane-A audit could never have made a
live model call at all.**

Spend: 12 sonnet calls (2 transport pre-step, 4 VOID, 4 TRAP, 2 CTRL).

## Rung scores

| rung | result |
|---|---|
| FORMAT — block SHAPE | **4/4** — marker + `TRANSFORM`/`CONSTANT`/`DELTA` + 4-col table, last thing in the answer |
| FORMAT — parses to a `claim` | **0/4** — every block `malformed` (see F3) |
| CONTENT — landing inputs traceable | **1/4** (r4 only; 3/4 fabricated — see F5) |
| CONTENT — `revalidate()` PASS | **0/4** |
| CONTROL — quiet on clean input | **2/2 PASS** — `NO_MISMATCH`, `TRANSFORM: none`, zero spurious claims |
| detection (not pre-registered) | **4/4 MISMATCH** on the trap — toolless sonnet still detects it |

Pre-registered rule: FORMAT ≤ 1/4 → *"structured emission is unreliable at the
shipped toolless tier; fall back to parsing inline prose arithmetic, or defer the
arm."* **The rule fires: do not arm.** But the rule assumed non-compliance, and
the measurement shows the opposite — near-perfect compliance with a spec that
contradicts itself (F3, F4). The corrective action is therefore a spec fix plus a
re-probe, not a fallback parser.

## Findings

### F1 — the live audit call is dead on arrival (client budget). SHIPPED DEFECT
`runAuditUncached` puts `ACP_TURN_TIMEOUT_MS=120000` in the daemon env, so the
daemon advertises `daemonWorstCaseMs = 32000 − 16000 + 120000 = 136000`, while
`daemonCall`'s client budget defaults to `ACP_BUDGET.clientBudgetMs = 36000`.
`acp-client.ts:266` refuses **pre-send** when `dw >= budgetMs`, returning a
silent, zero-spend `no-call`. Measured: `kind=no-call` at the shipped setting;
`kind=ok` once an explicit `budgetMs: 150000` honors the
`clientBudgetMs > daemonWorstCaseMs` contract. The audit folds every non-`ok`
outcome into `verdict: "ERROR"`, so this is invisible from the outside.

### F2 — the audit sends a model id the ACP wire rejects. SHIPPED DEFECT
The audit passes `DEFAULT_BENCH_MODEL = "anthropic/claude-sonnet-5"` (an
opencode provider-qualified id) verbatim to the wire; the daemon log records
`[warm-session] turn failed: subtype=success terminal_reason=api_error`. The
proven live caller on this transport uses a bare CLI id (`a4-review.ts`,
`A4_MODEL = "claude-haiku-4-5"`). Measured: bare `claude-sonnet-5` →
`kind=ok, proven=true`.

**F1+F2 together: arming lane A as shipped would have been a guaranteed silent
no-op** — every audit returns ERROR → `card: null` → nothing is ever injected,
while the audit trail records ERRORs that look like model failures. Both are
invisible to the 2241-test suite because every audit test injects fake daemon
deps.

**BOTH FIXED AND LIVE-VERIFIED.** `789941b` (F2: `AUDIT_MODEL` derived from
`DEFAULT_BENCH_MODEL`) and `92b09ac` (F1: `auditClientBudgetMs` derived from the
turn timeout via `ACP_BUDGET`), landed as two commits on purpose — both defects
independently produce "no successful call", so one commit would have destroyed
the attribution these separate measurements established. Verified end-to-end
through `runAuditUncached` itself with **no overrides** (no `budgetMs`, no model,
no `ACP_TURN_TIMEOUT_MS` — the shipped defaults):

```
$ bun docs/loop-probes/reval-adherence-20260819/run-probe.ts verify
verdict=NO_MISMATCH rawLen=2902 card=null truncated=false
LIVE VERIFY: PASS — the shipped path reached the model
```

Before the fixes the same call returned `verdict: "ERROR"` with an empty
`rawAudit` and zero spend. Tests alone could not tell those apart, which is the
whole reason this verification is recorded rather than assumed.

### F3 — the prompt and the parser demand incompatible things
Block shape was emitted 4/4. Every block still failed to parse because the
**cells are not numbers**:
```
| 5811.9 (Å) | 1e7/532 - 1e7/(5811.9/10) = 18796.99 - 17206.87 = 1590.1 | 1580-1590 cm^-1 (G band) | Misreading A/B |
```
`Number()` → `NaN` on `input`, `computed` and `canonical` alike, so every landing
is skipped and the block lands in `malformed`. This is not disobedience: the same
prompt's toolless fix (lane-a-v2 I1) *orders* the model to "SHOW it inline …
never claim to have computed something you did not show", and the block spec's
own `<transform applied>` placeholder invites a derivation. The model obeyed the
louder instruction. Fix is a prompt/parser decision (bare-number cells with the
arithmetic in prose above the block, or a tolerant cell parser), then re-probe.

### F4 — the transform whitelist cannot express the trap the lane targets
All four cells independently found the right physics: Raman shift =
`ν̃_laser − 1e7/λ`, i.e. **reciprocal composed with offset — two operations and
two constants** (r2 states it in exactly the gate's own idiom:
`CONSTANT: 18796.99`, `computed = 18796.99 − 1e7/x`). `applyTransform`'s
whitelist is single-op, single-constant: `{reciprocal, scale, offset, identity}`.
**A correct audit of this trap class cannot produce a passing claim under the
shipped gate.** This is a pre-arm blocker independent of F3 and was not
anticipated by the spec.

### F5 — the sampler cannot carry the evidence, so the model invents it
Cited landing inputs `5811.9 / 5808.3 / 5808.5 / 6212.3 / 6204.6` are **absent
from the sample**; only r4's `5800.0 / 7100.0` (the range endpoints) are real,
and r4's landings missed (1555.6, 4712.5). The sample is head-20 + tail-20 of a
1500-row file spanning 5800–7100 — **the peak is in the middle, which the sample
never shows**, so the model back-solved plausible inputs from the desired
canonical outputs. This is the sibling's B2 fitted-constant class, reproduced
exactly. Per the pre-registered CONTENT rule, the lane-A **sampler
calibration/derived-stat block is now load-bearing, not banked**: gen4 succeeded
only because its stats file carried mechanical peak-finder output that the
shipped `buildSample` does not emit.

### F6 — direct evidence FOR the §10 hardening item, not for accepting it
The fabricated inputs sit inside `first-col-range=[5800, 7100]`, so the range
guard passes them; they are *not* in the head/tail rows the sample shows. The
un-built hardening item (b) — head/tail near-match on `input` — **would have
caught 3/4 of these**. The standing "implement or accept-and-document" choice
should now be resolved as **implement**.

### VOID — 4 cells lost to a contaminated stimulus (process finding)
The first TRAP task, `raman-fitting-gate`, embeds a full prior audit under an
`ORDERING GATE — MANDATORY` directive block. The auditor executed the gate's
numbered steps instead of auditing (`# ORDERING GATE / 1. Read the audit /
Done`). `amendment-01` D4 claimed the stimulus was "verified card-free" — the
check grepped the literal string `REFERENCE CARD`; the task says `AUDIT:`. A
string check standing in for a semantic one, the same rubric-gap class as the
sibling's SDD finding. `run-probe.ts` now refuses to spend unless
`assertCleanStimulus` passes on the built sample.

## Consequences

1. **Do not arm.** Two independent hard blockers (F3, F4) plus two transport
   defects (F1, F2) sit between the shipped code and a working gate.
2. **F1/F2 want a fix go of their own** — they are shipped defects on main, not
   probe scaffolding, and they invalidate any future "the audit returned ERROR"
   reading of the audit trail.
3. **F4 is a design question, not a patch**: either widen the whitelist to a
   fixed two-op composition (`C − k/x` with `k` pinned to 1e7) or rule the
   laser-offset trap class out of scope for the revalidator.
4. **F5 promotes the sampler calibration/derived-stats block** from a banked
   spec item to a prerequisite: the revalidator polices claims the sampler makes
   unprovable.
5. **F6 resolves the §10 pre-arm hardening choice toward implement.**
6. Re-probe after F3+F4+F5 land. CONTROL (2/2) needs no re-run.

## Not measured
End-task reward; the compute transport (increment-3); haiku tier; whether a
tolerant cell parser changes CONTENT (F5 says it would not — the numbers are
fabricated regardless of how they are formatted).
