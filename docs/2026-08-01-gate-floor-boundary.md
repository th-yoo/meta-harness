# The gate's floor — measured boundary, and what is being built to raise it

**Status:** finding, recorded 2026-08-01 (MacBook dogfood day). Not a defect
report — the gate behaved correctly throughout. This documents where its value
stops, why, and which work already in flight addresses it.

## The observation

Seven gate cycles on the `~/z2/kkamak` dogfood session, 2026-08-01. **Zero
blocks. Zero failed rounds.** kkamak never caught or guided the sonnet session,
not once.

```
15:38:26  rounds ["accepted"]   17.0s   gauge D / not-extractable
15:57:02  rounds ["accepted"]   17.7s   gauge B / floor-covered
16:18:35  rounds ["accepted"]   14.3s   gauge ABSENT (instrument disarmed)
16:30:29  rounds ["accepted"]   19.9s   gauge ABSENT (instrument disarmed)
16:40:22  rounds ["accepted"]           gauge D / not-extractable
17:11:52  rounds []                     gauge D / not-extractable
17:20:09  rounds ["accepted"]           gauge present:false / no-record
```

## Why — structural, not a malfunction

The gate enforces **"your configured check passed"**, not **"your work is
correct."** Its value scales exactly with what the configured check can detect.
That day's check was `bun test`; the work was documentation. Every real error
the session made was invisible to it:

| what the session got wrong | would `bun test` catch it? |
|---|---|
| runbook procedure that produces no evidence when followed | no — prose |
| claimed `accepted: false`, a value the code never emits | no — prose about code |
| — | tests stayed 311 green throughout |

Every one of those was caught by the **opus review layer**, not the gate. The
gate ran seven times, passed seven times, and was right to each time — the code
really was fine.

**The one real catch that day went the other way.** The meta-harness gate
refused *the orchestrating session's* turn on a `reinject.test.ts` hermeticity
failure, handed back the failing output, and would not let the turn finish
until it was fixed. The gate caught the supervisor, not the subject — because
the supervisor was editing code, where the floor check can see.

## The honest statement of the boundary

kkamak is a **floor**. A floor that cannot be gamed is worth having precisely
*because* it is narrow: it makes one claim and that claim is always true. On
code work with a real test suite the floor sits high. On doc-shaped work with a
test-suite check, the floor is on the ground.

The failure that day was not the gate's. It was **routing work whose success
condition the floor could not express, and then reading the resulting silence
as approval.**

## What the gauge already tells us about this

The gauge exists to measure exactly this gap: whether a turn's real criterion is
something the floor check could adjudicate. On the cycles above it returned
`B / floor-covered` once and `D / not-extractable` otherwise — the instrument
correctly reporting that these prompts' success conditions were not things
`bun test` could decide.

Two corpus consequences, both load-bearing:

- **Doc work cannot produce blocks.** Routing documentation to a dogfood
  session grows the accepted-cycle count while the blocked-cycle pool stays at
  zero. TDD code work is the only reliable generator of blocked cycles, and
  blocked cycles are what fixture-refs and the pool need.
- **Cycle harvest is bounded by turn boundaries and edit-tool use**, not by work
  done — see `docs/resume.md` queue item 1.

## What is being built to raise the floor

Recorded so the boundary above reads as *known and worked*, not as an
unexamined flaw. None of these is finished.

1. **Per-turn checks (the gauge's class C).** The gauge already derives a
   candidate check from the turn's own prompt — real ones, e.g.
   `git log -1 --format=%s | grep -qi 'task 3'`. Today they run in shadow and
   are never armed. Arming them is the §4.3 program: it replaces "did your
   standing check pass" with "did *this turn's* stated criterion hold".
2. **Fail-loud instrumentation (shipped 2026-08-01, §6b amendment).** The gauge
   now emits `{present:false, offReason}` instead of omitting the field, so a
   disarmed instrument can no longer be mistaken for a starved one. The
   incident that forced it is in the gauntlet ledger.
3. **Classifier accuracy.** Blind opus labels put stored corpus C-precision at
   **9/13 = 69%** — the class table's `C 13` is really ~9, and the C-rate falls
   from 7.4% to ~5.1%. An anti-over-extraction prompt patch drove false-C to
   zero on both transports (precision 69% → 100%) at recall cost
   (100% → 67%). Not applied; details in `docs/resume.md` item 11.
4. **Proposer loop on the refiner prompt** (proposed, undecided —
   `docs/resume.md` item 12). Hand-tuning a classifier prompt against a labelled
   set is exactly what the project's proposer/reviewer/A-B machinery exists to
   do, and the gauge lane is better instrumented than the TB2 lane it was built
   for: ~3s trials versus 30-60min containers, 176 records versus 7-14 tasks.
5. **Model-as-checker for non-shell-verifiable criteria** (discussed, not
   registered). For class-D criteria — the majority — no shell command can
   adjudicate, so the checker would have to be a model. Measured cost is not the
   obstacle: a capped verdict call ran at ~9s median against a floor check that
   already costs 14-20s. The obstacles are non-determinism, spurious blocks
   (the project's own spurious-refusal tax is unmeasured), and provenance —
   model-checked cycles are a different population and must be marked as such
   on the sensor line.

## What would falsify the framing above

If armed per-turn checks produce blocks that a reviewer judges wrong more often
than they judge them right, then "raise the floor" is the wrong direction and
the gate should stay narrow and deterministic, with judgment left entirely to
the review layer. That is a real possible outcome and the §4.3 bars exist to
detect it.
