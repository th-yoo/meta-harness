# Hook-rule P0 — mechanics probes

Gate decision for the hook-rule evolution program
(docs/superpowers/specs/2026-08-14-hook-rule-evolution-design.md §5).
Per F2: commands, exit codes, marker presence, and counts only — no reply
or transcript text is recorded below.

Host: darwin (macOS), podman 5.8.5, image `localhost/mh-bench:latest`
(`claude --version` inside container: `2.1.207 (Claude Code)`).
Container: `hookrule-p0-1786766935`, created/started via
`setup-container.ts` (exact `cmd-run.ts` recipe — `prepareClaudeCodeAuth`
mounts + `buildCreateArgv`, through the `exec.ts` `podman()` funnel).
Model for live calls: `claude-haiku-4-5` (spend authorized 2026-08-15,
"follow the plan"). Run date: 2026-08-15 (KST). Total live calls: 4
(deny, control, warn, compose — Task 3 Step 3 stdout-fallback SKIPPED,
condition unmet).

## Probe A — deny under one-shot `claude -p`

Settings: `assets/pretooluse-probe-settings.json` →
`/app/.claude/settings.json`; hook: `assets/deny-hook.sh` →
`/app/.hookrule-probe/hook.sh` (copy verified by in-container `cat`).
Markers reset (`rm -f HOOK-RAN DENY-MATCHED`) before each live call.

| # | Command | Exit |
|---|---|---|
| 1 | `podman exec <c> mkdir -p /app/.claude /app/.hookrule-probe` | 0 |
| 2 | `podman cp` settings + deny hook, `cat` verify | 0 |
| 3 | deny call: `claude -p` (touch /app/DENY-ME instruction, driver argv shape, haiku) | 0 |
| 4 | control call: `claude -p` (touch /app/ALLOW-OK instruction) | 0 |

Deny-call markers: `HOOK-RAN` present · `DENY-MATCHED` present ·
`/app/DENY-ME` ABSENT · `/app/DENY-OBSERVED` present.
`grep -c HOOKRULE_DENY_FIRED` on the stream: 1. Event-type counts:
6 system, 5 assistant, 2 user, 1 rate_limit_event, 1 result.

Control-call markers: `/app/ALLOW-OK` present · `HOOK-RAN` present ·
`DENY-MATCHED` ABSENT. Event-type counts: 7 system, 3 assistant, 1 user,
1 rate_limit_event, 1 result.

**Verdict A: PreToolUse deny DOES bind under one-shot `claude -p`
(CC 2.1.207) — `DENY-ME` absent with `DENY-MATCHED` present (hook
processed the exact call, tool never executed); denial reason DID reach
the model (`DENY-OBSERVED` created per the reason's instruction). Control
call confirms no over-blocking (`HOOK-RAN` + `ALLOW-OK`, no false match).
Bench deny surface viable — program proceeds.**

## Probe B — dogfood warn channel

Hook swapped to `assets/warn-hook.sh` (allow + `additionalContext`
instructing a follow-up marker touch).

| # | Command | Exit |
|---|---|---|
| 1 | `podman cp` warn hook | 0 |
| 2 | warn call: `claude -p` (touch /app/STEP-ONE instruction) | 0 |

Markers: `/app/STEP-ONE` present (allow path — NOT halted) ·
`/app/WARN-SEEN` present (context delivered and acted on).
`grep -c HOOKRULE_WARN_MARKER` on the stream: 0 (context injected without
appearing as stream-event text). Event-type counts: 9 system, 5 assistant,
2 user, 1 rate_limit_event, 1 result.
Step 3 stdout-fallback variant: SKIPPED (condition `WARN-SEEN absent`
unmet — complete-as-skipped per plan coordination rules).

**Verdict B: dogfood warn channel = `additionalContext` — WORKS on
CC 2.1.207 (non-blocking, reaches the model). Spec §3 warn semantics
stand as spec'd; §8 degrade rule not needed.**

## Probe C — table-eval latency at the 16-rule cap

Fixture: assets/hook-rules-16.json (16 rules, 4 deny, all §2-conformant
except r16 — a deliberate screen-evader included to size the §8 residual).

JS (dogfood surface, bun 1.3.11): {"iters": 2000, "p50_ms": 0.044, "p95_ms": 0.056, "max_ms": 1.194, "r16_worst_input_max_ms": 0, "budget_p95_ms": 5, "pass": true}
Bash 3.2 (bench-evaluator shape): 0.8931 ms mean per-call (GNU bash 3.2.57(1)-release; `real 0m8.931s` / 10000 iters)
Bash 5 (if present): 0.5508 ms mean per-call (GNU bash 5.3.9(1)-release, /usr/local/bin/bash; `real 0m5.508s` / 10000 iters)

**Verdict C: p95 0.056 ms vs 5ms budget — PASS; r16-on-worst-input cost 0.000 ms (pattern is ^-anchored, worst input fails at first char — no backtracking reached).**

Supplementary r16 adversarial measurement (orchestrator, closes the
vacuous-worst-input gap above): input `"a"×n + "z"` against
`^(a+|b+|c+)+(x|y)$` under bun — n=16: 1.1ms · n=18: 3.6ms · n=20: 14.0ms
· n=22: 55.9ms · n=24: 228.3ms. Exponential (~4× per +2 chars);
extrapolates to seconds at n≈30, unbounded beyond. Confirms the spec §8
residual as written: a screen-evading pattern with an adversarial input is
a real single-match hang the in-loop deadline cannot preempt — the §2
subset screen (which rejects r16's nested quantifier) is the actual
defense; the deadline only bounds aggregate well-formed cost.

## Probe D — response composition

Hook swapped to `assets/compose-hook.sh` (single response carrying BOTH
`updatedInput` command rewrite RAW→REWRITTEN AND `additionalContext`
instructing a CTX-SEEN touch).

| # | Command | Exit |
|---|---|---|
| 1 | `podman cp` compose hook | 0 |
| 2 | compose call: `claude -p` (touch /app/RAW instruction) | 0 |

Markers: `/app/REWRITTEN` present (updatedInput honored) · `/app/RAW`
ABSENT (original command replaced) · `/app/CTX-SEEN` present
(additionalContext honored in the SAME response).
`grep -c HOOKRULE_COMPOSE_MARKER`: 1. Event-type counts: 17 system,
5 assistant, 2 user, 1 rate_limit_event, 1 result.

**Verdict D: `additionalContext` + `updatedInput` DO compose in one
PreToolUse response (CC 2.1.207). Spec §3 merge shape confirmed — no
fallback needed.**

## Cleanup

| Command | Exit |
|---|---|
| `podman rm -f -t 0 hookrule-p0-1786766935` (by name, never pkill) | 0 |
| `podman ps -a … \| grep -c ^name$` → 0 matches (container gone) | 1 (grep no-match = confirmation) |
| zero-fill `.credentials.json` (510 bytes, `head -c N /dev/zero >`) then `rm -f` — agent-auth `cleanup()` mechanism | 0 |
| `rm -rf $AUTH_TMP` | 0 |
| `rm -f /tmp/p0-*.ndjson` (4 streams, never committed) | 0 |

## Summary — P0 verdicts → program consequences

| Probe | Verdict | Spec consequence |
|---|---|---|
| A deny-under-`claude -p` | YES — binds, reason reaches model | bench deny surface viable; program proceeds |
| B warn channel | additionalContext works | §3 warn as spec'd; §8 degrade rule not needed |
| C latency @16 | p95 0.056ms JS / 0.89ms bash-3.2 mean vs 5ms | budget holds with ~90× headroom |
| D composition | keys compose | §3 merge shape as spec'd; fallback line stays dormant |

All four verdicts are the good cell. P0 CLOSED — P1 (schema + screening +
shadow evaluator) is unblocked pending user go.
