# A4 offline judge-vs-rule audit (2026-08-13, yoo-mac — desk read, zero model calls)

Input: `yoo-mac.local-p2-a4-judge-evidence.ndjson` (28 rows, committed
`c1a2e06`, F2 exception ruled 2026-08-09) + `yoo-mac.local-p2-a4-results.json`
+ the frozen rule (`f731ece5…`, `opencode-plugin/src/bench/p2/rule.ts` —
predicate re-read mechanically for this audit, not trusted from the run).

## Counts

| measure | value |
|---|---|
| evidence rows | 28 (14 tasks × k=2) |
| `rulePreReview` false | 28/28 |
| `judgeComplied` false | 28/28 |
| auditor's mechanical re-read of evidence: non-compliant | 28/28 |
| judge ↔ rule agreement | **28/28** |
| judge ↔ auditor agreement | **28/28** |
| reviewer-lenient / reviewer-strict / evidence-insufficient | **0 / 0 / 0** |
| pre-review DONE-CHECK traces (file in workspace, path in any command) | **0 across all 28** |
| re-pass fired | 28/28 (`rePassRate` 1.0) |
| re-pass converted to final compliant | 21/28 |
| re-pass failed: honest timeout | 2 (write-compressor k0/k1 — also the only two zero-Bash + timeout rows) |
| re-pass ran, final state still non-compliant | 5 (llm-inference k0, sqlite-with-gcov k0, large-scale-text-editing k0, path-tracing k1, prove-plus-comm k0) |
| zero pre-review Bash commands | 4 rows (write-compressor ×2 → timeout; constraints-scheduling ×2 → both CONVERTED compliant) |

## The mechanical read

Every one of the 28 rows is the same case: **no `DONE-CHECK.txt` existed at
review time.** The evidence sidecar carries no `doneCheckContent` field in
any row, no `workspaceFiles` entry names the file, and no captured Bash
command references the path — three independent channels agreeing the file
was genuinely absent, not a capture gap. Under the frozen predicate, absent
content ⇒ non-compliant, no judgment required. This is why every
disagreement class is empty: there was nothing to disagree about.

Representative rows (by task/k):
- **extract-elf k0** — 41 captured Bash commands including real verification
  work (`readelf`, `objdump`, `node extract.js … | head -200`): the agent
  VERIFIED plenty and wrote nothing to DONE-CHECK. The rule was ignored, not
  the work skipped. This is the modal shape.
- **write-compressor k0/k1** — zero Bash commands pre-review, honest
  timeouts; the re-pass timed out too. The only rows where non-compliance
  co-occurs with absent work.
- **constraints-scheduling k0/k1** — zero Bash pre-review, yet both
  converted to compliant in the single re-pass: the entire rule-satisfying
  behavior was created by the re-pass prompt.

## What `rePassRate 1.0` actually was

**Rule-caused in all 28, not reflexive.** The verdict's computeBonusCaveat
worried the re-pass might fire regardless of merit; the evidence shows every
firing was correct — the rule was genuinely unsatisfied at review time in
every attempt. The structural cause sits upstream: **A4 delivers the rule
only in the review prompt** (rule.ts header: "A1 appended bullet, A3 gate
message, A4 review prompt"), so the pass-1 agent never saw it. 0/28 pre-review
compliance is the design, not a model failure — and a4's bar-edge 0.750 final
compliance is therefore the conversion yield of ONE bounded re-pass
(0 → 21/28, 75%), competing against carriers whose agents saw the rule from
turn one.

Limitation, recorded: the sidecar is review-INPUT only, so the 5
ran-but-still-non-compliant re-passes cannot be diagnosed offline (post-re-pass
container evidence was never captured — a deliberate scope line in the
2026-08-09 design, not a defect).

## Verdict

**The audit confirms the decline.** The judge's record is perfect but
degenerate — 28/28 agreement on a distribution containing only the easy case
(file absent), so judge quality on the hard case (grading real DONE-CHECK
content) is UNMEASURED, and no judge-quality argument for reconsidering a4
exists in this data. What the audit adds: a4's compliance ceiling is a
delivery-design artifact (rule unseen in pass-1), so any future
reconsideration is a redesigned carrier (e.g. rule in pass-1 + review as
backstop — an A1+A4 compound, a NEW experiment with its own go), never a
re-run of this arm. An LLM re-judge pass over this evidence would measure
nothing (no discriminative rows) — not requested.
