# Gate session hygiene — cross-task carryover of reinject evidence (design, 2026-07-25)

**Status: DESIGN + EXPERIMENT SPEC.** Companion to the completion-gate plugin port
(resume queue item 4) and to [`2026-07-24-completion-gate-design.md`](2026-07-24-completion-gate-design.md).
Born from a user-raised gap (2026-07-25): the bench certifies the gate one task per
fresh session, but daily coding sessions run MULTIPLE tasks in one context — and a
reinjected gate message is an ordinary conversation turn that persists after its task
completes.

## 1. The two transfer channels

| Channel | Carrier | Bench visibility |
|---|---|---|
| C1 Generator | template text + mutation-operator roster frozen in code, re-applied identically to every task | Testable by held-out arms (fresh session isolates it) |
| C2 Session carryover | task A's reinject CONTENT (mutation diffs, "not done" verdicts, strengthen directives) alive in context while task B runs | **Structurally invisible to the current bench** — one task per fresh container |

C2 risk shape: stale task-A evidence primes or misleads task B ("double-cancel"
diffs haunting a CSS refactor); could also help (verification priming). Sign and
size unknown — that is the experiment.

## 2. Mitigation mechanisms (REVISED 2026-07-25 after cache-economics check)

0. **Task-boundary session reset** (mitigation zero — industry standard already):
   `/clear` between unrelated tasks is Claude Code's own best-practice guidance;
   a fresh session per task makes C2 nonexistent. Costs nothing. C2 machinery
   below only matters for sessions the human does NOT clear.
1. **Additive countermand marker** (THE default): on gate ACCEPTANCE, append one
   message — "gate for task <id> closed; its fault-injection evidence is obsolete;
   do not apply it to later tasks." Advisory, but counters residue (not an active
   instruction). Zero API needs, cache-neutral, CC-compatible.
2. **Compaction steering** (passive backstop): "drop completed tasks'
   gate/verification transcripts, keep outcomes." Free; fires only at compaction.
3. **Request-time filtering — DEMOTED to evidence-gated last resort.** Cache
   economics (user-challenged, recomputed): removing a mid-context message
   invalidates the prefix from the EARLIEST removed turn — e.g. first reinject at
   30k of a 100k context → ~70k tokens repaid ONCE (~$1 at opus rates; the draft's
   "every subsequent turn repays" was wrong — the prefix re-establishes on the
   next request). Benefit side: stale gate messages (~2–5k tokens) ride at cache-
   HIT price ≈ $0.0075/turn → break-even ≈ 130+ turns. Net-negative in nearly all
   real sessions. Build ONLY if §3 shows marker-resistant contamination with
   material reward cost. Not in default port scope.

Default posture for the port: **recommend /clear at task boundaries; marker at
acceptance; compaction rule. No filter unless the C2 experiment forces it.**

## 3. Experiment spec — C2 arms (multi-task sessions on the bench)

Mechanism exists in minimal already: the reinject path drives `opencode run
--session <id>`, so a two-task session = run task A to completion, then feed task
B's instruction into the SAME session (no fresh container). New run.ts mode
`--then <taskDirB>` (or a small driver script) staging B's fixtures into the same
/app after A's scoring.

Arms (k=10 each, same host/day, adopted base + gate):
- **B-alone** (baseline): task B, fresh session — existing protocol.
- **A→B raw**: task A (gate fires) then B in-session, no hygiene.
- **A→B marker**: same + acceptance marker (mechanism 2).
- (later, port-dependent) **A→B filtered**: same + request-time filter (mechanism 1).

Task pairing: A = a gate-active coding task (real python artifact, reinjects
likely); B = a DIFFERENT-domain task with a stable baseline (e.g. count-dataset-
tokens or sparql — non-async, so A's evidence is maximally irrelevant). One
pairing first; a second pairing only if the first shows signal.

Verify: gate.ts — B-alone vs A→B-raw (carryover cost/benefit, the C2 measurement);
A→B-raw vs A→B-marker (cure size). Forensics: B trajectories grepped for task-A
vocabulary (cancel/cleanup/mutant terms surfacing in B's reasoning = direct
contamination evidence, independent of reward deltas).

Pre-registered expectations: carryover effect small-negative or null on rewards at
k=10 (context-rot dilutes); vocabulary contamination detectable in trajs even when
rewards hold (the leading indicator). Marker halves contamination mentions.

## 4. Port requirements added by this design

- Reinject messages carry a machine-readable scope tag (task id) so filters/markers
  can target them.
- On acceptance, emit the closing marker (mechanism 2) — default ON.
- gate.json: `hygiene: { marker: bool }` (filter knob deferred with mechanism 3).
- Check at port time: opencode message-transform hook availability (only relevant
  if mechanism 3 is ever evidence-forced).

## 5. Standing decisions this design inherits

- Contract text does NOT enter the system prompt (resume item-4 capsule,
  2026-07-25: R7 evidence, truthfulness in ungated sessions, arm integrity,
  enforcement self-refresh).
- Contract text + operator roster are C1 carriers → held-out arms (paused
  2026-07-25, partial: headless a2 pass with one healthy gate round) remain the C1
  test; C2 arms are additive, not a replacement.
