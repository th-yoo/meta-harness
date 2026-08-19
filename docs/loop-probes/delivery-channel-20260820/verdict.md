# Delivery-channel check — VERDICT (2026-08-20, `yoo-dev`)

**The channel works, proven. The perception conclusion is RETRACTED — it was
measured with an instrument that penalises exactly the failure mode rung-5
exists to remove.**

> **RETRACTION (2026-08-20, after sibling review).** The first version of this
> verdict concluded "perception fails at trivial difficulty" and recommended
> not building rung-5 at haiku. That recommendation is withdrawn. The channel
> result below is unchanged and stands. The reasoning, the corrected numbers,
> and the pre-registration defect that produced it are in **"Why the
> perception conclusion is retracted"**.

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

**PERCEPTION: NOT MEASURED.** Exact-match was 3/6 across two arms — see the
retraction section for why that number does not bear on the rung-5 decision.

| arm | store/layers | exact | what was written |
|---|---|---|---|
| 1 | `--layers none` | 2/3 | `9R5572` ×2; failure content **unrecoverable** (no traj) |
| 2 | `account-global v999` (traj) | 1/3 | `9R5572` ×1, `9R557Z` ×2 |

The failure is a **single-character misread, and the same one twice**: the
final `2` read as `Z`. Not a refusal, not `UNREADABLE`, not a
transport error — a confident wrong answer, written to `out.txt` and reported
in the final message as if correct (`"Done. The code `9R557Z` has been
written"`).

Zero trials produced `UNREADABLE`. Zero `is_error` / auth / `api_error`
results, so the fifth pre-registered row (transport failure, not evidence)
never fired.

## Why the perception conclusion is retracted

**The metric compounds the errors that rung-5's divide exists to remove.**
Rung-5's whole design is *the harness divides and the agent reads one glyph at
a time* — the rung exists precisely so that per-glyph errors do not multiply
into whole-string failure. My verifier is exact match on a six-character
string, which multiplies them. So the instrument penalises the failure mode
the rung was invented to eliminate, and I then read that penalty as evidence
against building the rung.

The failures were never "unreadable". Every captured failure wrote `9R557Z`
against a token of `9R5572`: five of six characters correct, same character,
same position, same confusion, twice.

**Corrected numbers, and one correction to the reviewer as well.** The
sibling's per-character figure of 33/36 (91.7%) is the *upper bound*, not the
measurement: it assumes arm 1's single failure also wrote `9R557Z`, and arm 1
wrote **no trajectory at all** (the `--layers none` gotcha below), so its
failure content is unrecoverable. What is actually evidenced:

| quantity | value | basis |
|---|---|---|
| arm 2 per-character | **16/18 = 88.9%** | all three trajectories captured |
| arm 2, non-final positions | **15/15 = 100%** | same |
| all six trials, per-character | **28–33 / 36 (77.8–91.7%)** | bounds; arm 1's failure content unrecoverable |
| exact-match (what I reported) | 3/6 = 50% | compounds per-glyph errors |

**Neither half of that exchange is the flattering one.** The refutation did not
rest on the percentage at all — it rests on the *shape* of the failures, which
was fully evidenced: exact match on a six-character string cannot distinguish
"read nothing" from "read five of six", and rung-5 divides precisely so that
distinction matters. But the reviewer led with the number and put 91.7% in the
sentence that did the overturning, so an auditor checking the work would have
found the load-bearing quantity unsupported and been entitled to doubt the
rest. A sound finding can be presented in a way that makes an unsupported
figure carry the argument's weight for anyone auditing it — and that is a
separate defect from the finding being wrong, worth naming because only the
audit surfaces it.

**And the fixture was not easy at its hardest point.** My headline said the
failure came "far below the arm's difficulty". It did not. I excluded `0/O`
and `1/I` from the alphabet as known-confusable and left `2/Z` in — so the one
character that broke is the single adversarial cell in an otherwise
disambiguated fixture, and every non-adversarial character was read correctly
in 30 of 30 opportunities. The probe did not fail an easy test; it failed the
one hard cell of an easy test.

So the honest claim is narrow: **`2/Z` is confusable at this size in this
font.** Not "perception fails at this tier". One confusable pair was sampled
and found confusable.

**The arm difference is not evidence of anything.** 2/3 versus 1/3 is Fisher
exact two-sided p = 1.000. Flagging the untested v17-playbook confound was
right; presenting two rates that cannot differ from chance invites a reader to
see a trend that is not there. Dropped rather than caveated.

## The pre-registration defect, which is the real finding

The decision table in `pre-registration.md` pre-committed the inference:

> token wrong/absent, traj shows a `Read` … → **CHANNEL WORKS, PERCEPTION
> FAILS at this tier.** Strong negative for rung-5.

Fixing that before seeing data is good discipline, and **it did not help**,
because the rule encodes the same assumption as the instrument — that
whole-string exact match proxies for glyph reading. *A decision rule derived
from the same premise as the design it judges cannot contradict that premise.*

That is this arc's law one level up. We spent seven review rounds on
statistics computed from the partition they scored; this is a **decision rule**
computed from the design it evaluates. Pre-registration protects against
post-hoc rationalisation. It does not protect against a rule that was already
wrong when written — and being pre-registered made me *more* willing to apply
it, not less.

## What would actually decide rung-5

Render N single glyphs from the real G-code fixture's own alphabet, hand over
one tile per call, score per glyph. Same divide, same one-at-a-time reading,
same font, same source artifact — the arm's task shape exactly, answering "can
haiku read a glyph tile", which is the question the build turns on and which
**neither probe has asked**. The dry-run measured legibility to an opus reader
with word context; this one measured six-character exact match under a
compounding verifier. The intermediate is the only measurement that maps onto
the arm.

Status after this probe: **channel confirmed, perception not measured.** Not a
go, and not a recommendation against one either.

## Two rig gotchas, both measured here

**`--layers none` silently disables trajectory capture, even with
`--save-all-traj`.** `record.ts:432` writes trajectories inside
`for (const [name, root] of layerStoreRoots(layers, …))`; with `layers=none`
that iterable is empty, so the loop body — and the traj write — never runs.
The first arm produced a result with no mechanism evidence and no warning.

**Its second-order cost is worse than the first, and it is the reason this
trap now sits at the top of `docs/resume.md`.** A silent capture failure does
not merely deprive the person running the arm of mechanism evidence. It leaves
a *hole* in the record, and a hole invites everyone downstream to fill it with
the most plausible assumption and be confident about it. That is exactly what
happened here: the sibling review that overturned this verdict computed a
specific per-character figure of 33/36 by assuming arm 1's unreadable failure
wrote the same string as the two it could read. The number was load-bearing —
it was in the sentence that did the overturning — and it was unknowable. The
conclusion survived only because it also holds at the lower bound, which is
luck rather than method.

So the accurate statement is not "`--layers none` silently loses
trajectories". It is: **a silent capture failure corrupts not just your own
arm but any independent review of it**, because the reviewer cannot see that
the evidence was never captured rather than merely absent.
Probe runs needing transcripts must pin a real layer: `--layers global --pin
account-global=v999` (note the pin layer names are `account-global` /
`project-global` / `account-role` / `project-role`; a bare `global` is
rejected).

**`--layers global` assembles `project-global` too.** Arm 2 recorded into
`project-global v17` (the arena residue) as well as `v999`, so that arm ran
with v17's playbook injected. It is a real confound for anything
playbook-sensitive. I previously wrote that arm 1 "shows the same failure
mode", which I could not know: arm 1 captured no trajectory, so its single
failure's content is unrecoverable. All that is comparable between the arms is
a pass count, and at 2/3 versus 1/3 (Fisher p = 1.000) that comparison carries
no signal. The confound is untested, not absent.

## What this does and does not settle

Settled: the image channel exists and delivers real pixels to the arm's tier.
Any future claim that "the agent cannot see the image" is refuted for this
driver and this configuration.

Not settled, and not worth settling by this route: whether a stronger tier
would read the glyphs. That is a different arm with a different cost, and the
rung-5 premise was specifically *haiku-tier reads one glyph at a time*.

**No recommendation either way.** The first version of this document
recommended not building rung-5 at haiku; that is withdrawn, and nothing here
replaces it with the opposite. Perception at the arm's task shape is
unmeasured, and the per-glyph probe described above is what would measure it.
It needs its own go.

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
