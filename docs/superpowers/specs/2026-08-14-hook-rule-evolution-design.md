# Hook-enforced rule-table evolution — design

**Date:** 2026-08-14 · **Status:** DESIGN (user-approved brainstorm; pending spec review)
**Program:** route proposer output into hook ENFORCEMENT (PreToolUse deny/warn +
corrective feedback), not just prose bullets. Builds on a3 rule routing (Stop-gate
shadow evaluator, `ruleChecks` telemetry, live in cc-gate-plugin 0.4.6) and the P2
actuator findings (A3 enforcement ≫ A1 prose; A4 bounded re-pass).

## 0. User-ruled forks (brainstorm, 2026-08-14)

1. **Surface: BOTH at once** — dogfood CC sessions (dispatch.ts) and bench subject
   containers (a3 settings asset), one rule-table format, two consumers.
2. **Ramp: evidence-staged** — every rule born SHADOW; promotions earn evidence;
   demotion automatic; the trial/ab gate measures mode changes.
3. **Rule form: declarative matchers only** — regex on one canonical input field;
   no shell predicates in v1 (per-call latency + attack surface).
4. **Object model: field on the playbook bullet** — like `check{cmd}`; one
   evolution object, existing gate/curator/ledger machinery reused wholesale.

## 1. Rule shape

Rides the bullet, exactly as `check` does:

```json
{ "op": "add",
  "text": "When a shell step would install packages, do not use npm/yarn — use bun.",
  "check": { "cmd": "…", "timeoutMs": 30000 },
  "hookRule": {
    "event": "PreToolUse",
    "toolMatcher": "Bash",
    "inputPattern": "^(npm|yarn)\\s+(install|add)\\b",
    "feedback": "This repo uses bun. Re-run with bun add/install.",
    "mode": "shadow"
  } }
```

- `event`: v1 = `"PreToolUse"` only (Stop is already served by a3 checks; other
  events are future scope).
- `toolMatcher`: exact tool name from a whitelist (v1: `Bash`, `Edit`, `Write`,
  `Read`, `Glob`, `Grep`; extension = spec revision).
- `inputPattern`: anchored regex applied to ONE canonical field per tool:
  `Bash`→`command`, `Edit`/`Write`/`Read`→`file_path`, else the
  JSON-serialized tool input. **Match = violation.**
- `feedback`: corrective text shown on warn/deny (≤200 chars, screened §2).
- `mode`: `"shadow" | "warn" | "deny"`. **NOT proposer-settable** — the review
  gate coerces any proposed value to `"shadow"` at birth. Later values are
  ramp-state transitions (§4) recorded as store transitions, never proposals.
- A `hookRule` may coexist with a `check` (Stop-side) on the same bullet; they
  are independent mechanisms sharing the bullet's lifecycle.

## 2. Birth screening (review-gate tier, check-screen precedent)

A proposed `hookRule` passes ALL of, else review-gate rejection with a named
violation (repair-eligible, same loop as `mechanize_instead`):

- regex compiles; length ≤ 200 chars; anchored (`^` or a documented reason
  pattern class); passes a backtracking-safety heuristic (no nested unbounded
  quantifiers — linear-time subset check, not full re2 equivalence);
- `toolMatcher` in the whitelist;
- `feedback` ≤ 200 chars, non-empty, screened for instruction-injection tier
  (no "ignore previous", no tool-directive phrasing beyond the correction —
  content heuristics listed in the plan; feedback is proposer-authored and IS
  an injection surface into future agent turns);
- dedup: no existing active bullet carries a hookRule with identical
  (toolMatcher, inputPattern).

## 3. Runtime — one evaluator, two consumers

**Compiled table.** `.km/hook-rules.json` written on every playbook-mutating
store transition (exact `.km/rule-checks.json` producer precedent): active
bullets' hookRules flattened to `[{id, event, toolMatcher, inputPattern,
feedback, mode}]`, pre-validated so consumers never re-screen.

**Dogfood (dispatch.ts PreToolUse).** Reads compiled table (hook process is
short-lived; read per event, table is small), pure-regex evaluation:

- `shadow` match → sensor-line outcome only (§5), allow.
- `warn` match → allow + feedback injected as hook additionalContext
  (exact channel confirmed by P0 probe).
- `deny` match → decision block with feedback as the reason.
- **FAIL-OPEN always**: evaluator exception, malformed table, missing file =
  allow with zero user impact (hook prime directive). Deny only on an
  affirmative match by a well-formed rule.
- Caps: `HOOK_RULES_MAX = 16` total; deny-mode subset ≤ 4. Over-cap rules
  beyond the limit are ignored deterministically (stable order by bullet id)
  and the truncation is logged.

**Bench (a3 settings asset).** `stop-gate-settings.json` gains a PreToolUse
hook entry invoking the same evaluator script container-side; the candidate's
compiled table is podman-cp'd in (existing rule-checks copy-in pattern). Same
shadow/warn/deny semantics; outcomes land in the bench annotation channel.

## 4. Ramp state machine (per rule, evidence-staged)

```
shadow ──(≥N obs across ≥K sessions AND FP-proxy ≤ θ)──▶ warn
warn ──(bench ab arm: candidate carries rule at deny; adopt on
        non-regression + target-failure reduction)──▶ deny
deny ──(FP-threshold breach OR implicated bad score)──▶ shadow  [automatic]
```

- FP proxy: fraction of matched sessions that still scored good/passed — a
  match inside a passing session is false-positive evidence. KNOWN WEAKNESS:
  sparse for rarely-matched rules; promotion simply waits for N (no shortcut).
  Initial thresholds (plan-tunable, recorded per transition): N=20, K=5,
  θ=0.25.
- warn→deny is a measured treatment: the ab arm's ONLY delta is the mode flip.
- Global kill-switch: config flag zeroes all deny modes instantly (evaluator
  treats deny as warn when set) — dogfood safety valve.
- Every transition = ledger entry + store transition with evidence summary
  (counts, rates, session ids), audited like activation.

## 5. Measurement + instrument discipline

- **P0 probe FIRST** (probe-the-consequence rule), before any build:
  (a) does PreToolUse deny actually bind under one-shot `claude -p` in the
  bench container (Task-1/a3 precedent — hook mechanics are never assumed);
  (b) dogfood warn-channel mechanics: additionalContext vs block-with-message
  — which surfaces feedback to the agent without halting;
  (c) per-call latency of compiled-table eval at the 16-rule cap (budget:
  ≤5ms p95, pure regex).
- **Telemetry**: sensor line gains OPTIONAL `hookRules` outcomes
  `{id, matched, mode, ms}` — F2: never input text, never cmd text. Contract
  rev = kkamak golden vector + conformance check + boundary ts (the 0.4.6
  `ruleChecks` playbook rerun, both repos in one window).
- **FP adjudication sidecar**: judging whether a deny was correct needs the
  matched input — bounded evidence sidecar, BENCH-ONLY, under
  `docs/loop-probes/`, A4-sidecar F2-exception precedent. Dogfood sessions
  get NO input capture (id/mode/ms only). **Needs explicit user ruling at
  spec review.**
- **Boundaries**: first enforcement activation (any rule leaves shadow on any
  surface) = actuator-class boundary ts in the adoption ledger.

## 6. Phasing (each phase = its own plan + gate)

| Phase | Content | Spend |
|---|---|---|
| P0 | Mechanics probes (deny-under-`claude -p`, warn channel, latency) | small probe runs |
| P1 | Schema + screening + shadow-mode evaluator, both surfaces | none (shadow) |
| P2 | Telemetry contract rev (sensor `hookRules`, golden vector, boundary) | none |
| P3 | Ramp machinery + ab gate arms + kill-switch | none until arms run |
| P4 | First promotions (shadow→warn→deny) | ab spend, explicit go |

## 7. Non-goals

- No Stop-event hookRules (a3 checks own Stop).
- No shell-predicate rules (declarative only; revisit only with a concrete
  rule that regex cannot express).
- No CC tool-definition modification (impossible; wrap-around only).
- No dogfood input capture (F2).
- No separate rule-table store artifact (bullet-attached only).

## 8. Known weaknesses (accepted at design time)

- FP proxy sparse for rare tools — promotions are slow there by construction.
- Feedback text is a screened but real injection surface (tiered screening §2;
  screening heuristics will lag adversarial phrasing — deny cap of 4 bounds
  blast radius).
- Warn-channel mechanics unverified until P0 — if CC offers no non-blocking
  feedback channel on PreToolUse, warn degrades to shadow on dogfood (bench
  unaffected: container settings support block-with-message).
