# Review artifact — p2-judge-logging + sidecar integrity fix

reviewed-range: 083aa0769f326d4c30a4624e74b2af6621e0af9d..68d3b6c4a13b20482954a59deac11559f2160b1b
reviewer: fresh-context-sonnet-code-reviewer
fresh-context: true
verdict: approved
findings-count: 3

**NOT MERGED AS OF THIS WRITING — held on one outstanding USER RULING. See "Blocking" below.**

Two authors. The "minimal" session wrote the P2 judge-audit amendment
(`4bc9051`, `6b93281`) and the lineage merge `bc7b558` resolving its conflict with main's
truncation work. This session then fixed three silent data-integrity defects a
fresh-context review found in it (`68d3b6c`). Both reviews were fresh-context; neither
author reviewed their own code.

## The amendment (theirs) — reviewed, sound

Logs the a4 judge's verdict (`judgeComplied`) alongside the deterministic rule's own
verdict (`rulePreReview`) on the SAME attempt, so a judge can be audited against the rule
offline, plus a bounded-evidence sidecar so a stronger judge tier can be re-scored on the
same inputs with zero re-runs.

The judgment call worth recording: `judgeComplied` is `null` on truncation, not just on a
failed parse. `A4ReviewTruncated` carries no `complied` field, so recording a verdict
would mean inventing one from a reply the api lane severed mid-object — a fabricated row
in the judge-vs-rule table, which is precisely the confusion `reviewTruncated` exists to
prevent. Verified independently: `null` stays unambiguous because `reviewTruncated` sits
beside it in the committed results; `rulePreReview` is computed before the review runs and
is recorded on BOTH failure paths; `compliant` follows the rule, never the absent judge.
The union merge dropped nothing from either side. The pre-data claim holds — no P2 results
exist yet on this host. `judgeEvidence` is sidecar-only and never enters the results
`errors[]` label.

## The three defects (fixed here) — all SILENT, which is why they mattered

Every one of these fails without an error, without a red test, and without any signal at
read time. The artifact just quietly becomes untrustworthy — in an artifact whose entire
purpose is to be trustworthy later.

1. **Sidecar was append-only, never reset per invocation.** The results file is fully
   overwritten each run (atomic temp+rename) and there is no `--resume`, so a restart
   yields a clean results.json. The sidecar did not get that treatment. READINESS
   documents a FIXED per-host/per-arm filename and the a4 arm is estimated at up to ~7.8h
   serial, so restart-after-kill is the expected operator action, not an exotic one —
   stale rows from the aborted invocation would interleave with the new run's, with no
   run-id to separate them. Fixed by truncating fresh at the top of `cmdP2` via
   `writeTextAtomic`, mirroring the results file's own overwrite semantics. Chosen over a
   run-id stamp deliberately: the sidecar's schema is under the pending ruling below, and
   a lifecycle fix changes no field.
2. **Sidecar row omitted `reviewTruncated`.** The results file distinguishes "the judge
   said no" from "the judge's own reply was cut off by the token cap"; the sidecar folded
   both into `reviewFailed`, defeating its stated purpose of being self-contained for
   offline re-judging. Fixed by adding exactly one boolean.
3. **`judgeEvidencePath` silently returned the RESULTS path.** `resolveP2ResultsFile`
   fences the directory but not the `-results.json` suffix, so on a non-conforming name
   the `.replace()` no-opped and evidence lines were appended into the results JSON, then
   destroyed by the next atomic overwrite — total, silent evidence loss. Fixed to `die()`
   naming the offending path, matching the file's existing fence idiom, and the check now
   runs before any container work rather than after hours of it.

Reviewer verified all three against the pre-fix baseline: the truncate is
unconditional-per-invocation with no path that skips it, `writeTextAtomic` genuinely
replaces rather than appends, the a4 gating opens no hole (results-file names are
arm-specific by convention, and the truncate is unconditional within an a4 run), and four
of the five new tests fail against pre-fix code.

**Minor, recorded not fixed:** the a1/a3 "no stray sidecar" test passes against both
pre- and post-fix code — pre-fix had no truncation logic at all, so it never created one
either. It is a legitimate regression guard against a hypothetical unconditional-truncate
implementation, but it was not "confirmed red" like the other four. Framing nit, not a
functional gap.

**Schema discipline held:** the sidecar row gained exactly one boolean and nothing else
was added, renamed, widened, or restructured. The `A4Evidence` struct — the actual subject
of the pending ruling — is untouched.

## BLOCKING — user ruling required before merge

The amendment's own plan doc states, verbatim: **"F2 EXCEPTION — EXPLICIT, AND NEEDING THE
USER'S RULING, not merely this record."** F2 restricts recorded artifacts to
"counts/booleans/a content-hash/an error-classification string, never transcript or
finding text". The two annotation booleans sit inside F2. The evidence sidecar does not:
it stores the bounded `A4Evidence` struct verbatim — DONE-CHECK file content, the
attempt's Bash-command list, workspace file names. The doc argues both sides (agent-authored
output from a clean-room container on public TB2 tasks, never a transcript, written only
for a4 under `docs/loop-probes/p2/` — against F2's letter that bash-command text is
trajectory-derived) and defers to the user. The code implements the exception
unconditionally, with no flag or gate pending that ruling.

This range does not merge until that ruling exists. The fixes above are correct
regardless of how it goes; if the ruling is against, the sidecar write itself needs
gating or removing, not just fixing.

Verified: `opencode-plugin` tsc clean, 1887 pass / 1 skip / 0 fail (1882 baseline on
`bc7b558` + 5 new). Nothing under `cc-gate-plugin/` touched; judge logic,
`judgeComplied`/`rulePreReview`, and truncation detection all untouched by the fix commit.
