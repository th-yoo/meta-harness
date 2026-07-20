# Next Direction — from prompt-tuning to failure-analysis + workflow (2026-07-20)

## TL;DR
The improvement loop is **validated** (it correctly rejects non-improvements) but the
**target has no headroom**: we've been tuning a thin playbook on an already-capable
agent. v0→v3 = 3 iterations, **0 pass-rate lift**. The pivot: stop tuning prompt-bullets,
start **analyzing failures** and building **enforced workflows** (verify-retry, spec-
extraction, tool-feedback) — the lever prompting structurally can't reach — and/or point
the same loop at a **target with real headroom** (raw model, stronger model, routing).

## Where we are (verified this session)
- **Loop machinery works.** propose→ab→activate with paired McNemar + held-out fold +
  sentinels + speed-tiebreak + budget-identity gating correctly rejects. v1/v2/v3 all
  rejected/inconclusive. v3 killed mid-held-out (2 pass-regressions on prove-plus-comm +
  tune-mjcf, zero pass-improvement, speed win only on a *tie* → negative held-in delta
  −0.08 blocked the tiebreak). **Not accepting garbage is the hard part, and it holds.**
- **Instruments are honest.** env-fidelity fix (v0 inflated 12/14 → honest 8/14),
  recordTimeouts, measured load-aware scheduler, staging-retry — all shipped.
- **But the results are flat.** No task-pass lift across the whole project.

## Why the target has no headroom (verified live)
The bench agent = **opencode + haiku, MINIMAL config, NO MCP, NO Claude Code.** Verified
by exec into a live bench container: one `opencode run … --model haiku` process, config =
`{"plugin":["opencode-claude-auth@latest"]}` (plugin-only, no `mcp:`). The
`claude-code-auth` plugin supplies only the oauth **token** (CC subscription credential) —
it does **not** run Claude Code or its MCP servers. (The Serena/MCP you see interactively
is your separate `claude -r` sessions, not opencode; interactive opencode loads its own
`mcp:[playwright]`, but the bench strips all of it.)

So our account-global playbook is a thin **additive** `AGENTS.md` on top of opencode's own
capable system-prompt + read/write/edit/bash loop. Largely **redundant** with what
opencode already does → near-zero marginal effect → the plateau.

## The diagnostic pivot: read WHY haiku fails, don't guess prompts
Failures split into classes, and the class determines the lever. Read the saved
trajectories (`candidates/vN/traj/*.ndjson`) — the agent's real actions — not the metadata.

- **spec-precision — WORKFLOW-FIXABLE (VERIFIED, openssl-selfsigned-cert).** haiku *had*
  the required values in the prompt (`instruction.md`: `dev-internal.company.local`,
  `devops team`, exactly 365 days), generated a *valid but generic* cert (invented subject
  `O = Dev…`), self-verified against its **own interpretation** ("Perfect!"), and scored 0.
  Not capability — it can make a cert. The **one-shot, no-feedback loop** is the failure.
  A passive prompt bullet ("verify against criteria", v3's rule) did **not** fix it (v3
  still 0/5): **advice ≠ enforcement.**
- **capability — NOT fixable by prompt or workflow** (likely: path-tracing, tune-mjcf,
  prove-plus-comm). Hard algorithmic / formal / numerical; haiku can't produce the
  solution regardless. Needs a stronger model or task-specific tools.
- **comprehension — TBD** (misread the task) → decomposition scaffold.

## Next direction (concrete)
1. **Build the full failure taxonomy first — no new runs.** Read every failing task's
   `traj/*.ndjson`, classify each as spec-precision / capability / comprehension. Output =
   the **addressable fraction**: how many band failures a workflow could flip vs how many
   are hard-capped. This decides whether a workflow intervention is worth building.
2. **Shift the optimization surface: prompt-bullets → WORKFLOW (enforced structure).**
   The loop's real product isn't a playbook; it's:
   - **verify-retry loop** — harness runs the check, feeds the failure back, agent fixes,
     loops (the openssl fix; tension: give the agent the SPEC/criteria, not the answer key
     — the env-fidelity fix removed both, needs a legitimate spec channel).
   - **extract-spec checklist** — force literal-requirement extraction → verify each item
     against actual output before "done."
   - **tool-feedback** — give the agent the objective signal it lacks (image-diff score for
     path-tracing, sim-time for tune-mjcf) so it can iterate to the target.
   - **best-of-k selection** — only for variance-bound (not systematic) failures; useless
     for spec-mismatch (all k attempts miss the same detail).
3. **OR change the target for headroom** (orthogonal, higher-leverage than v4/v5):
   - **raw model** (prompt = the whole scaffold) — the clean self-improvement experiment;
   - **stronger model** (haiku→sonnet) — different capability ceiling;
   - **task-routed rules** (the generality axis) — a rule that helps one task without
     fighting another.
4. **Cheapest gate before spending on v4: no-injection vs v0 diagnostic.** If they score
   the same, the playbook contributes ≈0 on opencode and *no* vN moves pass-rate — proving
   the veneer hypothesis and forcing the pivot.

## Reframe of success
On a near-ceiling target, the loop's honest output is **convergence + speed-wins +
not-regressing** (correctly plateau), NOT monotonic pass gains. The validated **loop
machinery is the reusable asset** — point it at a surface with real mass (workflow, or a
headroom target), not at feathers (a playbook on an already-good agent).

## Status at time of writing
- v3 ab killed after held-in (not accepted; active stays v0). Held-in result checkpointed
  to git (`71b3cf5`). All code pushed; podman reboot-fix permanent (`events_logger=file`).
