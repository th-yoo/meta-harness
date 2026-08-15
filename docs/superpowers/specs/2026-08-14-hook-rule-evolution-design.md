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
    "inputPattern": "^(npm|yarn) +(install|add)( |$)",
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
  JSON-serialized tool input. **Match = violation.** Restricted to the
  portable subset (§2) so both engines (§3) agree.
- `feedback`: corrective text shown on warn/deny (≤200 chars, screened §2).
- `mode`: `"shadow" | "warn" | "deny"`. **NOT proposer-settable — a proposal
  whose `hookRule` carries `mode` at all is REJECTED** with a named violation
  (`hook-screen:mode-not-proposer-set`) and a ledger entry, exactly the
  `check-screen:state-not-proposer-set` precedent (`review-gate.ts:116-124`
  rejects, never silently coerces). The store stamps `mode: "shadow"` at
  birth. Later values are ramp transitions (§4), system-applied via the
  transition writer — never proposer-authored.
- **Update-op semantics: tri-state, mirroring `check`**
  (`harness-store.ts:1068-1073` — that tri-state was a shipped bugfix, do not
  regress it): on `op:"update"`, `hookRule` omitted = keep existing (including
  its current store-owned `mode`); `hookRule: null` = drop; `hookRule` object
  = replace. **Any replace restarts the ramp** — the new rule is born `shadow`
  regardless of the predecessor's mode (edited pattern = unproven pattern).
- A `hookRule` may coexist with a `check` (Stop-side) on the same bullet; they
  are independent mechanisms sharing the bullet's lifecycle.

## 2. Birth screening (review-gate tier, check-screen precedent)

A proposed `hookRule` passes ALL of, else review-gate rejection with a named
violation (repair-eligible, same loop as `mechanize_instead`):

- regex is in the **portable subset** (not merely "compiles"): literals,
  character classes `[...]`, alternation `|`, grouping `(...)`, anchors —
  `^` leading only; `$` either pattern-terminal or as an alternative in a
  terminal group (`(x|$)`), the only two placements the screen accepts
  (strict POSIX leaves mid-pattern `$` implementation-defined; both accepted
  placements are anchor-semantics on the actual engine pair in use, JS
  `RegExp` + glibc ERE, which is what parity targets) —
  quantifiers `*` `+` `?` `{m,n}`, the bare `.` wildcard (JS and POSIX ERE
  agree on it), escaped metacharacters. FORBIDDEN:
  backreferences, lookaround, lazy quantifiers, inline flags, and the
  Perl-class shorthands `\d`/`\w`/`\s`/`\b` (screen rejects with the expansion
  named in the violation message, e.g. `\d`→`[0-9]` — POSIX ERE has no `\b`;
  word-boundary intent must be rewritten as an explicit class or dropped).
  Also forbidden: ANY backslash escape inside a bracket expression (JS reads
  `[\t]` as tab, POSIX ERE as literal `\`+`t` — silent divergence; use the
  literal character or a named class instead).
  This subset behaves identically under JS `RegExp` and POSIX ERE (§3's two
  engines) — the screen enforces parity, the evaluators assume it;
- length ≤ 200 chars; anchored (`^` or a documented reason pattern class);
  passes a backtracking-safety heuristic (no nested unbounded quantifiers —
  linear-time subset check, not full re2 equivalence; residual risk bounded
  by the runtime deadline, §3);
- `toolMatcher` in the whitelist;
- `mode` absent — presence is the `hook-screen:mode-not-proposer-set`
  rejection (§1), before any LLM screening spend;
- `feedback` ≤ 200 chars, non-empty, screened for instruction-injection tier
  (no "ignore previous", no tool-directive phrasing beyond the correction —
  content heuristics listed in the plan; feedback is proposer-authored and IS
  an injection surface into future agent turns);
- dedup: no existing active bullet carries a hookRule with identical
  (toolMatcher, inputPattern). Exact-string only — overlapping-but-unequal
  patterns are accepted scope for v1 (birth-time nuisance, not a runtime
  correctness issue).

## 3. Runtime — one evaluator, two consumers

**Compiled table.** `.km/hook-rules.json` written at every active-playbook-swap
site — activation, trial start, trial confirm/revert, gate-trial resolution —
mirroring `exportRuleChecks`'s call-site list exactly
(`rule-checks-export.ts`; NOT candidate creation — candidates aren't active):
active bullets' hookRules flattened to `[{id, event, toolMatcher,
inputPattern, feedback, mode}]` plus a top-level `killSwitch: boolean`,
pre-validated so consumers never re-screen. The ramp transition writer (§4)
is an additional producer call site.

**Dogfood (dispatch.ts PreToolUse).** Reads compiled table (hook process is
short-lived; read per event, table is small), JS `RegExp` evaluation over the
screened portable subset (§2):

- `shadow` match → sensor-line outcome only (§5), allow.
- `warn` match → allow + feedback injected as hook additionalContext
  (exact channel confirmed by P0 probe).
- `deny` match → decision block with feedback as the reason.
- **Composition with the existing `PreToolUse(Bash)` handler**
  (`dispatch.ts:234-252`, the bash-timeout `updatedInput` knob) — one JSON
  response per event, so ordering is explicit: hookRule evaluation runs
  FIRST; a `deny` short-circuits (no timeout adjustment on a call that won't
  run); `warn`/`shadow`/no-match fall through to the timeout knob, and a warn
  response merges `additionalContext` alongside `updatedInput` in the single
  `hookSpecificOutput`. Whether CC honors both keys in one response is P0
  probe (d); if not, `updatedInput` wins and warn degrades to shadow for that
  call (fail-open bias).
- **Per-call deadline**: total table evaluation carries a wall-clock budget
  (5ms target, hard bound 50ms checked between rules — an in-loop poll,
  deliberately, because a worker-thread/subprocess-per-match with hard
  terminate is disproportionate for a hook that must answer in
  single-digit ms). Budget breach = fail-open for the remaining rules + a
  log line naming the rule id that was mid-evaluation. HONEST LIMIT: an
  in-loop poll cannot preempt a single synchronous match that is itself
  pathological — it bounds aggregate time across rules, not one
  catastrophic `RegExp.test()`/`[[ =~ ]]` call. Single-match blowup is
  accepted residual risk (§8), narrowed by the §2 subset (no nesting, no
  backreferences, ≤200 chars) rather than eliminated.
- **FAIL-OPEN always**: evaluator exception, malformed table, missing file,
  deadline breach = allow with zero user impact (hook prime directive). Deny
  only on an affirmative match by a well-formed rule within budget.
- Caps: `HOOK_RULES_MAX = 16` total; deny-mode subset ≤ 4. Over-cap rules
  beyond the limit are ignored deterministically (stable order by bullet id).
  Truncation and deadline breaches are logged by the compiled-table writer /
  evaluator local log — NOT the sensor stream (keeps the §5 contract rev
  minimal, no F2 entanglement).

**Bench (a3 settings asset).** The settings builder `buildRuleGateSettings()`
(`rule-gate.ts:242-263`) remains the SINGLE owner of the container
`settings.json` and is extended: when the candidate's compiled table carries
hookRules, the returned object gains a `hooks.PreToolUse` block alongside the
existing `hooks.Stop` — one builder, one file, no second generator to race
the copy-in (existing `podman cp` write-in unchanged). The container-side
evaluator is a **pure-bash POSIX ERE (`[[ =~ ]]`) reimplementation** — bench
task images cannot be assumed to carry node/bun (`rule-gate.ts:33-45`
rationale, unchanged). Engine parity is guaranteed by the §2 portable subset,
enforced at birth screening; the evaluators do not re-negotiate it. Same
shadow/warn/deny semantics and per-call deadline; outcomes land in the bench
annotation channel.

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
- **Transition writer (the mechanism — new machinery, no existing precedent
  for automatic active-bullet mutation, and this spec says so plainly):**
  a `hookRuleTransition` store function that mutates ONLY the `mode` field of
  one active bullet's hookRule, writes the ledger entry, and re-exports the
  compiled table — it does NOT go through `applyPlaybookOps`, the proposal
  pipeline, or `review-gate.ts` (nothing proposer-authored changes; text,
  pattern, feedback are untouched by construction). It runs under the same
  per-root store lock the proposer/curator take (`proposer.ts` sanitizeRoot /
  lock-per-root); if the lock is held, the transition is skipped and retried
  at the next trigger — transitions are idempotent evidence re-checks, never
  queued writes.
- **Trigger for shadow→warn and automatic deny→shadow demotion:** the ramp
  scan runs at sensor-flush time (session close, where FP-proxy inputs are
  appended anyway) and re-evaluates thresholds from aggregated telemetry.
  No cron, no daemon: evidence only changes when a session lands, so that is
  the only trigger needed.
- **warn→deny is a measured treatment** routed through the EXISTING ab gate:
  the ramp engine constructs a system-generated transition candidate whose
  ONLY delta is the mode flip. The transition writer checks the deny cap
  (§3: deny subset ≤ 4) BEFORE constructing a warn→deny candidate — an arm
  that would exceed the cap is never built (no point measuring a flip the
  table would truncate); the export-time cap remains the backstop, so
  stored bullet state never exceeds it via this path. It carries a `transition` provenance marker,
  SKIPS review-gate screening (screening exists to check proposer-authored
  content; a mode flip contains none — this carve-out is explicit and the
  marker is what authorizes it), and then runs the standard k-trial ab arm.
  Adopt on non-regression + target-failure reduction → the transition writer
  applies the flip. §1's "never proposer-authored" is about WHO can set
  `mode`; system transition candidates are the sanctioned other path.
- Global kill-switch: `killSwitch: true` in `.km/hook-rules.json` itself
  (rides the existing copy-in — no second channel), honored by BOTH
  evaluators: deny is treated as warn while set. Applies to bench too — an
  ab-arm deny trial gone wrong has the same emergency stop.
- Every transition = ledger entry + store transition with evidence summary
  (counts, rates, session ids), audited like activation.

## 5. Measurement + instrument discipline

- **P0 probe FIRST** (probe-the-consequence rule), before any build
  (RUN 2026-08-15, CC 2.1.207 — full evidence in
  `docs/loop-probes/hook-rule-p0/PROBE.md`):
  (a) does PreToolUse deny actually bind under one-shot `claude -p` in the
  bench container (Task-1/a3 precedent — hook mechanics are never assumed)
  → P0 result (2026-08-15, CC 2.1.207): YES — binds, and the denial reason
  reaches the model;
  (b) dogfood warn-channel mechanics: additionalContext vs block-with-message
  — which surfaces feedback to the agent without halting
  → P0 result: `additionalContext` works — non-blocking, reaches the model;
  (c) per-call latency of compiled-table eval at the 16-rule cap (budget:
  ≤5ms p95, pure regex)
  → P0 result: p95 0.056ms JS / 0.89ms bash-3.2 mean — ~90× headroom;
  (d) response composition: can one PreToolUse `hookSpecificOutput` carry
  `additionalContext` AND `updatedInput` together (warn + bash-timeout knob
  on the same call, §3) — if not, `updatedInput` wins and warn degrades to
  shadow for that call
  → P0 result: they COMPOSE — both honored in one response; fallback stays
  dormant.
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
- Warn-channel mechanics: VERIFIED by P0 (2026-08-15, CC 2.1.207) —
  `additionalContext` is a working non-blocking feedback channel; the
  degrade rule (warn == shadow on dogfood) stays in the design as the
  documented fallback for future CC versions where the channel breaks, but
  is not active.
- Backtracking screen is a heuristic, not re2 equivalence — a pathological
  pattern can clear birth screening. The §3 deadline (in-loop poll) bounds
  aggregate evaluation time, NOT a single catastrophic match — one
  pathological `RegExp.test()`/`[[ =~ ]]` call can hang the hook past the
  50ms bound until it returns. Accepted residual availability risk,
  narrowed (not eliminated) by the §2 subset restrictions: no nested
  unbounded quantifiers, no backreferences, pattern length ≤ 200. Revisit
  with out-of-band preemption (worker/subprocess per match) only if a real
  hang is ever observed.
- Engine parity rests on the §2 portable subset being enforced correctly at
  screening — a screen bug could admit a pattern that matches differently
  under JS RegExp vs POSIX ERE. Divergence is shadow-visible in telemetry
  (dogfood/bench outcome asymmetry) before any deny rides on it.
- Dedup is exact-string; overlapping patterns on the same (toolMatcher,
  field) are accepted v1 scope.
