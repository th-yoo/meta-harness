# Pre-registration — debt-instrument probe (2026-08-22)

**Question.** Two proposed fixes for the measured escape class "known-open debt
living only in documents" (gen: kkamak known-issue #8 root-cause analysis,
2026-08-22): (1) debt-in-suite — partial fixes/deferrals must land a
`test.skip`/`test.todo` naming the open hole; (2) revisit-condition watchers —
deferrals with stated conditions become mechanically-checked rule-checks.
Before building either, measure whether the target class actually recurs and
whether the fixes could express it.

**Frozen decision rule (written before any census entry was read; this file
commits before results):**

- BUILD fix 1 + fix 2 iff ALL of:
  - (i) ≥3 items open TODAY across both repos are skip-expressible (probe B),
  - (ii) ≥1 historical instance BEYOND known-issue #8/D1 where a stated revisit
    condition fired before the item was actually revisited (probe A),
  - (iii) probe C's inexpressible classes are <50% of the documented-residual
    census (probe B denominator).
- If (i) holds but (ii) fails: build fix 1 only (skip-markers), drop fix 2
  (watchers have no second confirmed target — n=1 pattern-match).
- If (i) fails: build neither; the root-cause story was overfit to #8 and the
  writeup records that.
- Probe D (invariant-obligation A/B, model spend) runs only if fix 3 remains
  live after A–C, under its own go.

**Census integrity rules.** Collection is performed by a fresh-context agent
that has NOT seen this session's root-cause analysis or this file's decision
rule — it enumerates and quotes, no judgments. Classification against the
rubrics below happens second, in the controller session, with each verdict
recorded beside the collector's raw quote. Anything ambiguous is counted
AGAINST the fix (conservative direction).

## Probe A — deferral census

**Environment (exact corpus):**
- `~/z2/kkamak/docs/known-issues.md` (all issues, all statuses)
- `~/z2/kkamak/docs/superpowers/plans/2026-07-30-kernel-review-remediation.md`
- `~/z2/kkamak/docs/superpowers/plans/2026-08-05-kkamak-0.4.1-review-debt.md`
- `~/z2/kkamak/docs/dogfood-log.md` (deferral mentions only)
- `/Users/yoo/z2/meta-harness/docs/resume.md` (recorded-open / standing /
  deferred / HELD / parked mentions in the 2026-08 blocks)
- git history of BOTH repos for dating (git log --follow on the files above;
  commit dates = when conditions fired / items resolved)

**Collected per item (raw, no judgment):** id/name · repo · where recorded ·
status today · verbatim deferral text · stated revisit condition (verbatim, or
"none stated") · if conditioned: what event satisfies it + date that event
happened (git evidence) + date actually revisited (git evidence, or "not yet").

**Classification (controller, after collection):** condition mechanically
checkable? (file-exists / grep-shaped / version-comparison = yes; judgment
calls = no) · condition fired before revisit? · silent-window length.

## Probe B — skip-expressibility census

**Environment:** the same collected item table (no second collection pass).

**Classification rubric (frozen):** an item is skip-expressible iff at the
moment it was documented, a runnable test could have been written that (a)
names the specific hole, (b) would FAIL (or is forced-skip) while the hole
exists, and (c) needs no environment the suite lacks (no second OS process,
no external network, no human). Wishes/feature-wants are NOT holes and count
inexpressible. Each verdict cites the item's verbatim text.

## Probe C — falsification of the fix

**Environment:** probe B's inexpressible list.

**Method:** classify inexpressibles into named classes (wish / env-dependent /
cross-repo / other-new). If a NEW class emerges that neither fix covers and it
dominates, that is the fix failing its own falsification probe — recorded as
such. Denominator check for decision-rule (iii).

## Outputs

- `census.md` — collector's raw table (committed verbatim, unedited)
- `verdict.md` — per-item classifications + decision-rule evaluation + verdict
