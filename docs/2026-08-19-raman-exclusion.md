# Decision record: raman-fitting excluded from the TB2 board (2026-08-19)

**Ruling:** user, 2026-08-19. `term-bench2/target-tasks.txt` 31 → 30 tasks.
Same mechanism as the 2026-08-16 drops (build-cython-ext, qemu-startup,
qemu-alpine-ssh). Learnings retained in full; the task survives only as a
mechanism-scored probe instrument.

## Why

The verifier's 2D gamma (±1) and offset (±10%) bars grade **reproduction of
an unstated fitting procedure**, not accuracy — so the task's reward mixes
a real capability signal with a procedure-guessing lottery, and a lottery
component in a board task corrupts every decision the board feeds
(candidate adoption, version comparison, loop reward).

Measured basis (full evidence: `docs/2026-08-19-raman-verifier-report.md`,
arc: `docs/loop-probes/rep-audit-20260819/verdict.md`):

1. **The expected values are a script artifact.** They are the output of
   `solution/solve.sh` (Lorentz + constant on hard-coded windows, 2D:
   2500–2900 cm⁻¹) — a procedure the instruction never states (no window,
   no model, no units).
2. **The barred quantity has no true value.** Offset vs fit-window sweep
   never plateaus (126→1578 across half-width 50→500; same under a linear-
   background model). The ±10% band corresponds to half-width ≈130–190
   only: narrower windows fail low, wider — textbook best practice —
   fail HIGH (+21…27%). Model-free side-band estimation gives ~1360–1700,
   above the expected 1239.
3. **Correct answers coin-flip.** With the representation trap solved by
   card injection (6/6 trials, x0 within 0.05 cm⁻¹), pass rate was 3/6 —
   every failure the offset/gamma pair; the passing trials sat at
   −8.7…−9.3% offset, scraping the bar. Identical agent quality, random
   verdicts.
4. **The field shows the same signature.** TB2 leaderboard (10-agent
   snapshot): seven stacks at 0, survivors at 0.2/0.4/0.8, none at 1.0 —
   zeros-and-fractions, the shape of a trap-plus-lottery task.
5. **The lottery is unfixable from our side without cheating.** The only
   reliable pass strategy is cropping round windows around canonical
   positions — the grader's unstated norm. Injecting that into agent
   guidance would be oracle-procedure overfitting, which we refuse
   (verdict round-7 production rule).

## What is kept

- All arc learnings (representation-trap mechanism, card-injection chain,
  failure ladder, session laws) — banked in the probe arc + attack doc.
- Probe tasks (`term-bench2/probe-tasks/raman-*`) — mechanism-scored
  (x0 rung), immune to the flawed bars.
- Historical 31-task rows — comparable to 30-task rows by dropping the
  raman row from both sides.
- The upstream report — documented, deliberately not filed
  (`docs/2026-08-19-raman-verifier-report.md`).

## Census consequence

Before any leaderboard task feeds the loop, it gets the bar-soundness
audit that exposed raman: are the graded quantities data-determined
(stable across defensible procedures), or procedure-determined? The
zeros-and-fractions leaderboard signature is the cheap screening heuristic.
