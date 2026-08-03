# Process gate: mechanically checkable "review artifact exists" — draft (2026-08-03)

**Status:** ARMED on meta-harness 2026-08-03 late evening (user "go";
boundary ts `1785732646822`, gauntlet ledger "Process-gate arming
boundary"). All 7 rulings decided (§7). Effective-tip amendment (§1)
ACKED by the same go. Enforcement point = `scripts/merge-with-gate.sh`
(workflow-level, the spec-recommended placement; a `pre-merge-commit`
git hook is provably unsound — see ledger entry). Falsification window
§6 OPEN, attempts ledger below. Purpose per resume.md
queue item (7b): convert the mandatory-per-task-review discipline from
convention into a mechanical floor, with zero judgment inside the gate
itself — the same floor/judgment split the gate-floor-boundary doc
(`docs/2026-08-01-gate-floor-boundary.md`) already draws between kkamak
(floor: "your check passed") and the opus review layer (judgment: "your
work is correct").

## 1. The central design problem

A review is, by construction, a thing that happens **after** the work it
reviews. But the mechanism available to enforce it — kkamak's Stop hook —
fires at **turn end**, and only arms when that same turn used an edit tool
(resume.md, "CYCLE-HARVEST MECHANICS": PostToolUse matches
`Edit|MultiEdit|Write|NotebookEdit`, gate fires at the Stop hook of that
turn). A turn that writes code cannot, within that same turn, also possess
a review artifact of the work it just wrote — the artifact does not exist
yet. Naively wiring "review artifact exists for HEAD" into the existing
turn-level gate would therefore block **every** editing turn, permanently,
by construction — not a floor, a wall. This is the problem this document
has to solve before any constant is worth ruling on.

Three placements were considered:

**(a) Turn-level with lag (ratchet).** Keep the check inside the existing
Stop-hook gate, but change what it asserts: not "HEAD has a review" but "no
commit older than N turns/commits is missing a review artifact." The
current turn's own fresh commit is exempt; the check only looks backward
past the lag window. This preserves the existing enforcement point (no new
hook, no new trigger) but inherits every turn-boundary quirk resume.md
already documents for this project (one cycle per turn, commit-only turns
produce no cycle at all, multi-task turns collapse to one check) — the
ratchet's "age" unit is turns-with-cycles, not wall-clock or commit count,
which is a second-order distortion on top of the primary lag problem.

**(b) Repo-level pre-merge gate.** A check that runs once, at merge time
(not at every turn), asserting a review artifact exists naming every commit
in the branch being merged (or naming the merge-base..HEAD range). This
matches how review actually happens in this project today: the SDD/
finishing-a-development-branch workflow already puts a fresh-context
reviewer pass **before** merge as standard practice (see the corpus-replay
GA9 build: "fable final whole-branch review... then merge"; the SDK-
transport build: "REVIEWED... re-verified MERGE-READY. MERGED"). The review
artifact predates the gate check by the time the gate runs, because the
workflow already sequences them that way — there is no same-turn race to
solve. The gate becomes a mechanical restatement of a discipline the
project already practices, not a new discipline.

**(c) Commit-hook level.** A pre-commit or post-commit hook asserting a
review artifact for the commit being made. Inherits the same after-the-work
race as (a) at even finer grain — nearly every commit in this project's
history is itself the *output* of doing the work, with review happening in
a later commit or not committed at all (per-task reviews are frequently
verbal/transcript, not always a committed artifact per resume.md's SDD
ledgers). Rejected for the same structural reason as (a), with no
compensating advantage.

**Recommendation: (b), repo-level pre-merge gate.** It is the only
placement where "review artifact exists" is true by the time the check
runs without redefining what the check asserts into a ratchet. It also
matches this project's actual branch discipline (`docs/superpowers/specs/`
+ `finishing-a-development-branch` skill: work happens on a branch, review
happens before merge, merge is a distinct, checkable event) rather than
fighting the turn-level Stop-hook's timing.

**PROPOSED check command for (b)** (illustrative, not wired):

```
scripts/check-review-artifact.sh <merge-base-sha> <head-sha>
```

Pseudo-logic (PROPOSED): for the commit range `<merge-base-sha>..<head-sha>`,
resolve the branch's own HEAD short-sha; require a file matching
`docs/reviews/<short-sha-of-HEAD>-*.md` to exist and be committed on the
branch, containing a `reviewed-range:` field whose value's endpoints
resolve (via `git merge-base --is-ancestor` both directions, or exact
string match on the recorded shas) to `<merge-base-sha>..<head-sha>`. Exit
non-zero (block the merge) if no such file exists or the field does not
match. This would run as a pre-merge CI-style check or as the last step of
`finishing-a-development-branch`, never as a per-turn hook.

**Effective-tip amendment (pre-data, recorded at build time 2026-08-03,
implemented in `scripts/check-review-artifact.ts`):** the literal form
above is unsatisfiable — committing the review artifact moves the branch
HEAD, so the artifact can never name the final HEAD (§1's own central
design problem, resurfacing at merge level). Mechanical resolution:
trailing commits whose diffs touch ONLY `docs/reviews/**` are exempt from
the "reviewed" requirement; the **effective reviewed tip** = the newest
non-exempt commit in the range; the artifact filename and its
`reviewed-range`/`reviewed-commit` field must name
`<merge-base>..<effective-tip>`. Any non-exempt commit after the reviewed
tip therefore fails the check (sneak-code stays closed — only review
artifacts may follow the reviewed tip). A range containing only
`docs/reviews/**` commits passes vacuously (nothing to review). User ack
of this amendment: pending (flagged in the build report); until acked it
binds the implementation, not the registered constants.

## 2. Artifact format

**PROPOSED path convention:** `docs/reviews/<short-sha>-<slug>.md`, where
`<short-sha>` is the short sha of the reviewed HEAD (or, for a range, of
the tip commit reviewed) and `<slug>` is a free-text branch/topic tag. Must
be a **committed file** — CLAUDE.md's rule ("shareable artifacts... under
the git-tracked repo, not host-local paths") applies directly: a review
that lives only in a transcript or a host-local `.km/` file does not travel
and cannot be checked on another host or in CI.

**PROPOSED required fields** (front-matter or a fixed labeled-line block,
machine-parseable):

- `reviewed-commit:` or `reviewed-range:` — exact sha or `sha1..sha2`. The
  gate reads this, does not infer it.
- `reviewer:` — a stated identity string (e.g. `fresh-context-agent`,
  `opus-5-reviewer`). See §3 — this field is an **attestation**, not proof.
- `fresh-context:` — boolean/statement that the reviewer began without
  prior context on this diff. **Honest limit, stated here and not
  softened:** this can only be *attested*, not mechanically proven. A gate
  can check the field is present and says "true"; it cannot check that it
  is true. The same limit the gate-floor-boundary doc already draws for
  code correctness ("your check passed" not "your work is correct")
  applies one level up: "a freshness field is present" not "the review was
  fresh."
- `verdict:` — one of a small closed set (PROPOSED: `approved` /
  `fix-first` / `blocked`), a single line, mechanically greppable.
- `findings-count:` — integer, PROPOSED >= 0. Presence checked, value not
  judged (a `findings-count: 0` is not treated as suspicious by the gate;
  see §6 on gaming).

**What the gate checks:** file existence at the expected path, presence of
every required field, and that `reviewed-commit`/`reviewed-range` resolves
to (matches or is an ancestor-inclusive range of) the sha(s) being merged.
**What the gate never checks:** whether the verdict was warranted, whether
`findings-count` is plausible, whether the prose under the fields says
anything true. Content quality stays entirely in the judgment layer — this
is the same floor/judgment split as kkamak's existing `bun test` check.

## 3. No-self-review rule

**Mechanically checkable here (PROPOSED):** the `reviewer:` attestation
field must name an identity distinct from the commit author(s) in the
reviewed range — a string-inequality check the gate CAN run (`reviewer:`
value != `git log` author emails/names in range). This catches the
crude case (someone typing their own name into the field, or leaving it
templated to the author).

**NOT mechanically checkable, stated honestly:** actual independence — that
the reviewer did not see the author's reasoning, did not rubber-stamp,
was not the same *agent* running under a different label, or genuinely
started from a fresh context window rather than a continued one. All of
these are exactly the kind of thing the artifact's `fresh-context:` field
can only assert. A determined gamer can fill in any string. The gate closes
the "nobody typed anything" failure mode; it does not and cannot close the
"someone typed a false attestation" failure mode. See §6.

## 4. Staleness

The artifact must name the **exact** commit or commit range reviewed. Any
amendment, rebase, or force-push that changes the sha of a reviewed commit
invalidates the artifact for that commit — the gate's sha-match check
(§1, §2) fails closed: a stale artifact naming a sha no longer reachable
from `<head-sha>`'s ancestry does not satisfy the check, and a fresh
artifact is required. **PROPOSED:** no fuzzy/partial match, no "close
enough" tolerance — exact match on the recorded sha(s) only, since this is
precisely the class of check a machine can do perfectly and should not
soften.

## 5. What this cannot do

This floors exactly one claim: **"a review artifact exists, is committed,
and its recorded fields match the merged range."** It cannot verify:

- that the review was thorough,
- that the review was good (caught real problems, or would have),
- that the review was actually independent (§3),
- that the review is not a copy-paste template with fields filled in
  mechanically to pass the gate.

**Gaming vector, stated plainly:** a fabricated artifact — a file at the
right path, with the right sha, `verdict: approved`, `findings-count: 0`,
and a `reviewer:` string that isn't the author's — satisfies every check in
§2 and §3 while representing zero minutes of actual review. This is not a
hypothetical edge case; it is the direct, cheap way to satisfy a purely
mechanical existence-and-field check. **The review layer itself is the
detector for this**, not the gate — exactly as the gate-floor-boundary doc
already establishes for code quality (the gate catches "check passed",
the opus review layer catches "work is correct"). Here the review layer
has to catch one level further up: whether the review itself was real.
This is a known, accepted, un-closed gap in this design, not an oversight.
A future model-as-checker rung (resume.md 7d, gated on its own
falsification bar) could eventually score review-artifact plausibility,
but that is out of scope for this floor and carries its own spurious-block
risk per the gate-floor-boundary falsification framing.

## 6. Falsification clause

If, once armed, artifact-existence blocks turn out to be **spurious** (the
work had an adequate review by some channel the gate could not see — e.g.
a verbal/transcript review, per resume.md's note that per-task reviews are
"frequently verbal/transcript, not always a committed artifact") at a rate
above a pre-registered bar, the gate does not get progressively loosened
piece by piece — **the gate stays as-is** (narrow, mechanical, floor-only)
and the fix, if any, happens at the workflow level (make review artifacts
the actual practice, not the gate's leniency). This mirrors the
gate-floor-boundary doc's own falsification framing verbatim: "if armed
per-turn checks produce blocks that a reviewer judges wrong more often than
right, ... the gate should stay narrow and deterministic, with judgment
left entirely to the review layer."

**§6 falsification-window ledger (opened 2026-08-03, ts 1785732646822;
append one row per merge attempt through the armed gate, stop judging at
N=10):**

| # | date | branch | outcome (pass/block) | if block: spurious? (user/reviewer judged) |
|---|------|--------|----------------------|--------------------------------------------|
| 1 | 2026-08-03 | gauge-channel-ladder | pass (artifact d213353-gauge-channel-ladder.md, checker OK) | — |
| 2 | 2026-08-03 | transport-dedup | pass (artifact 1c917fa-transport-dedup.md, checker OK) | — |

**Spurious-block-rate bar (constant, RULED 2026-08-03 = as proposed):**
measure over the first N merge attempts after arming — PROPOSED N = 10 —
the fraction judged spurious by a human/reviewer read of each block.
PROPOSED bar: spurious-rate <= 0.20 (i.e., at most 1 in 5 blocks may be a
false positive) for the gate to be judged sound at that rate; above it, the
finding is registered (per the same discipline as the gate-floor-boundary
doc's own falsification clause) but the gate STILL does not loosen — it
stays as-is, and the registered finding instead argues for not expanding
its rollout further. This is deliberately asymmetric: failing the bar
does not unwind the gate, it only caps its spread. (Both N and the 0.20
threshold are PROPOSED, not decided.)

## 7. Rulings — DECIDED 2026-08-03 (user, interactive session)

All seven rulings taken; each = the draft's recommended option. These are
now spec constants (spec-is-law: pre-data amendments only, and the gate is
pre-arming — nothing measured yet).

1. **Placement = (b) repo-level pre-merge.** Check runs once at merge
   time; review artifact must exist naming merge-base..HEAD. Never a
   per-turn hook.
2. **Artifact path = `docs/reviews/<short-sha>-<slug>.md`**, committed on
   the branch.
3. **Field set = the five fields in §2** (`reviewed-commit`/
   `reviewed-range`, `reviewer`, `fresh-context`, `verdict`,
   `findings-count`). No timestamp, no diff link.
4. **Verdict vocabulary = `approved` / `fix-first` / `blocked`** (closed
   set).
5. **Spurious-block bar = first N=10 merge attempts after arming, rate
   <= 0.20** (§6 asymmetry stands: failing the bar caps rollout, never
   loosens the gate).
6. **Rollout = meta-harness only, staged.** kkamak dogfood repo later on
   its own ruling.
7. **No-self-review = string-inequality** on `reviewer:` vs commit-author
   names/emails in the reviewed range. No roster.

**BUILT 2026-08-03 evening (user go "do this in this box"):**
`scripts/check-review-artifact.ts` (+`.test.ts`, 13 tests) — TypeScript
per repo convention (7a's doc-check.ts pattern; the spec's `.sh` name was
marked illustrative). Implements §1 incl. the effective-tip amendment, §2
field checks, §3 string-inequality, §4 exact-sha staleness. Usage:
`bun scripts/check-review-artifact.ts <merge-base-sha> <head-sha>`.
**NOT ARMED:** arming = running it at every merge of this repo + starting
the N=10 falsification window — own user go.
