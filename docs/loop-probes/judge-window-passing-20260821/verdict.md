# VERDICT — outcome A on 1 of 3. The window DOES under-credit success.

Registered prediction was **B** ("both PASS, no under-crediting at these
lengths"). **Refuted.** Fourth refuted prediction of the day against two correct.

## Result — ground truth PASS on all three (`reward.txt` = 1)

| session | OLD (8k) | NEW (full) | |
|---|---|---|---|
| dna-assembly | false | false | both wrong |
| **llm-inference** | **false** | **true** | **fix corrects it** |
| sanitize-git | false | false | both wrong |

**`llm-inference` is outcome A, under control.** OLD: *"truncated mid-session …
No evidence the agent modified optimized_packer.py, ran the optimized version, or
achieved thresholds."* NEW: *"Agent found pre-existing optimized_packer.py, ran
it, and verified via actual cost_model.py evaluation that both buckets pass all
required thresholds."*

The work existed; the window hid it; the judge reported its absence; the fix
recovered it. That is the historical judge=FAIL / human=PASS signature reproduced
under control — the thing the previous paired probe could not test because all
its sessions had failed.

## Third independent confirmation of the ∃/∀ rule

**All three OLD reasons are absence claims**: "No evidence of final delivery",
"No evidence the agent modified optimized_packer.py", "no evidence of actual
remediation". A windowed witness cannot testify to absence, and all three did.

## The other two are a DIFFERENT finding, not window damage

NEW still says fail on dna-assembly and sanitize-git, but with substantive,
checkable objections: *"MATCH: False for the full assembled sequence vs output,
only matching as a circular rotation"*; *"secrets remain fully exposed in git
history (multiple commits with plaintext tokens/keys found via git log)."*

Those are the judge holding a **stricter bar than `reward.txt`**, with full
context. That is judge-verifier disagreement on the merits and deserves its own
probe — it is not evidence about the window either way, and must not be counted
as such.

## Standing of the fix after this arm

- **Direct evidence it corrects a real scoring error: 1/3.** Not a rate; one
  demonstrated instance under control.
- Previous arm (all-failing sessions): verdicts nulled, reasons 2/3 false.
- Combined: the window damages **reasons** reliably and **verdicts** sometimes —
  and the proposer consumes reasons.

## Registered limit, restated

Truncation here is mild (judge saw ~45-55%). **No passing trajectory exists
anywhere in the store in the 43k-79k regime**, where the failing set sat at
12-38% visibility. The severe-truncation-plus-success case remains untested and
is untestable from this archive.
