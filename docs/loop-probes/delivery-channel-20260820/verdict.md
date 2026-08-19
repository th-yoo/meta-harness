# Delivery-channel check — VERDICT (2026-08-20, `yoo-dev`)

**The channel works. Perception is the wall — and it fails at a difficulty far
below what rung-5 requires.**

This is the gate the rung-5 dry-run named as mandatory before any build spend.
Scored against `pre-registration.md`, fixed before the task was built and
before any model call.

## Result

**CHANNEL WORKS — proven, 3/3 trials.** Every trial called `Read` on
`/app/token.png`, and the tool returned actual image content:

```
{"t":"tool","tool":"Read","args":"{\"file_path\":\"/app/token.png\"}",
 "output":"[{\"type\":\"image\",\"source\":{\"type\":\"base64\",\"data\":\"iVBORw0KGgo…
```

Decoded from the trajectory rather than assumed: PNG magic valid, dimensions
**1200×400**, matching the on-disk fixture exactly. Real pixels reach a
haiku-tier agent under the bench's `claude-code` driver. The rung-5 dry-run's
delivery assumption is **confirmed**, and the first row of the
pre-registered table applies.

**PERCEPTION FAILS AT TRIVIAL DIFFICULTY — 3/6 exact across two arms.**

| arm | store/layers | exact | what was written |
|---|---|---|---|
| 1 | `--layers none` | 2/3 | `9R5572` ×2, one miss |
| 2 | `account-global v999` (traj) | 1/3 | `9R5572` ×1, `9R557Z` ×2 |

The failure is a **single-character misread, and the same one twice**: the
final `2` read as `Z`. Not a refusal, not `UNREADABLE`, not a
transport error — a confident wrong answer, written to `out.txt` and reported
in the final message as if correct (`"Done. The code `9R557Z` has been
written"`).

Zero trials produced `UNREADABLE`. Zero `is_error` / auth / `api_error`
results, so the fifth pre-registered row (transport failure, not evidence)
never fired.

## Why this is the informative direction

The rung-5 dry-run passed its screen and I recorded that as the *un*informative
outcome: a necessary-condition test carries information when it FAILS. **This
one failed**, and it fails at a difficulty deliberately set far below the arm's.

The token was rendered at ~200px cap height, pure black on white, six
well-separated characters, no G-code involvement — chosen so that a failure
would indict the channel rather than perception. The channel turned out fine
and the *image* was still misread. Against that, the rung-5 arm asks the same
tier to read 26 glyphs reconstructed from extrusion paths, where the dry-run
already measured genuine ambiguity (`0`/`O` undecidable from a tile,
underscores indistinguishable from hyphens without a baseline).

**Reading: rung-5 as designed — harness divides, haiku-tier agent reads one
glyph at a time — has a measured perception ceiling that the arm cannot clear.**
Building it would spend ~2-3h to measure a wall this check just measured for
six model calls.

## The alphabet oversight, which produced the best evidence

The token generator excluded `0/O/1/I` as known-ambiguous. It did **not**
exclude `2/Z`, and that is exactly the pair that broke. The oversight was mine
and it is the most useful part of the probe: had the alphabet been fully
disambiguated, the check would have returned a clean pass and I would have
recorded "channel works, perception fine at trivial difficulty" — a true
statement that would have licensed the build. The accident supplied the
adversarial case the design forgot to.

Worth stating as the general form, because it is the same law this arc keeps
producing: **a fixture that excludes the confusable cases cannot measure
confusion.** The exclusions I chose were downstream of my own assumption about
which characters are hard.

## Two rig gotchas, both measured here

**`--layers none` silently disables trajectory capture, even with
`--save-all-traj`.** `record.ts:432` writes trajectories inside
`for (const [name, root] of layerStoreRoots(layers, …))`; with `layers=none`
that iterable is empty, so the loop body — and the traj write — never runs.
The first arm produced a result with no mechanism evidence and no warning.
Probe runs needing transcripts must pin a real layer: `--layers global --pin
account-global=v999` (note the pin layer names are `account-global` /
`project-global` / `account-role` / `project-role`; a bare `global` is
rejected).

**`--layers global` assembles `project-global` too.** Arm 2 recorded into
`project-global v17` (the arena residue) as well as `v999`, so that arm ran
with v17's playbook injected. It is a real confound for anything
playbook-sensitive; for glyph reading it is very unlikely to matter, and arm 1
(no layers, no playbook) shows the same failure mode, which is the reason to
believe the confound is not driving the result.

## What this does and does not settle

Settled: the image channel exists and delivers real pixels to the arm's tier.
Any future claim that "the agent cannot see the image" is refuted for this
driver and this configuration.

Not settled, and not worth settling by this route: whether a stronger tier
would read the glyphs. That is a different arm with a different cost, and the
rung-5 premise was specifically *haiku-tier reads one glyph at a time*.

**Recommendation, which is a recommendation and not a go:** do not build
rung-5 at haiku. If the idea is kept, the honest next question is whether the
harness can supply the *answer* to the perception step rather than the image —
i.e. hand over text, at which point the arm is no longer testing perception
and the original research question has changed.

## Reproduce

```
TB_ROOT=/home/th-yoo/z2/terminal-bench-2 bash term-bench2/probe-tasks/install.sh
KKAMAK_HOME=$PWD/.kkamak TB_ROOT=/home/th-yoo/z2/terminal-bench-2 \
  bun term-bench2/runner.ts run --tasks image-channel-probe \
  --model anthropic/claude-haiku-4-5 --k 3 --layers global \
  --pin account-global=v999 --driver claude-code --save-all-traj \
  --no-pack-measured
```

Task at `term-bench2/probe-tasks/image-channel-probe/`. Token `9R5572`, fixed
seed 20260820, present only in the image's pixels and in `tests/` +
`solution/` (neither reaches the agent's container). Oracle passes 1/1, which
validates the verifier and plumbing and says nothing about the channel.

Spend: 6 haiku calls across two arms, plus one oracle run with no model call.
