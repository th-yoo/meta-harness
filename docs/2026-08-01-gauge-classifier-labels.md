# Gauge classifier — blind reference labels + the anti-over-extraction traps

Working artifacts from the 2026-08-01 night measurement (resume.md items 11
and 12). Committed because they are the reusable inputs to that work and
cross-host transfer is git-only; they were otherwise stranded in host-local
scratch.

**Nothing here is applied to source.** The trap text below is not in
`buildRefinerPrompt`, and the labels are a reference set, not a verdict.

## The labelled reference set

`docs/2026-08-01-gauge-class-c-blind-labels.json` — 13 records, each with
the full prompt, `floorCheck`, `repoRoot`, and four independent classifications.

Labeller: **opus, fresh context, saw only the rubric and the prompts** — not the
corpus class, not either transport's output, not the controller's labels. The
input file it read carried no `derivation`/`class`/`check`/`state` fields
(verified before dispatch).

| id | blind | CLI (corpus) | SDK | controller |
|---|---|---|---|---|
| 1 | C | C | C | C |
| 2 | C | C | C | C |
| 3 | C | C | C | C |
| 4 | **D** | C | A1 | D |
| 5 | **D** | C | D | D |
| 6 | C | C | **D** | C |
| 7 | **D** | C | **C** | **C** |
| 8 | C | C | C | C |
| 9 | **D** | C | D | **C** |
| 10 | C | C | **D** | C |
| 11 | C | C | C | C |
| 12 | C | C | C | C |
| 13 | C | C | **D** | C |

Scored on C-vs-not-C, which is what pool eligibility turns on:

| | correct | false-C | missed-C |
|---|---|---|---|
| CLI (`claude -p`, the stored corpus) | 9/13 | 4 | 0 |
| SDK (direct API call) | 9/13 | 1 | 3 |
| controller (me, not blind) | 11/13 | 2 | 0 |

**Stored corpus C-precision is 9/13 = 69%.** The class table's `C 13` is really
about 9; the C-rate falls from ~7.4% to ~5.1%. The validity floor is read off
that number.

The two transports **tie**, with opposite error profiles — the CLI over-extracts
(names a path ⇒ calls it C), the SDK under-extracts. An interim claim that the
SDK was more accurate came from a 6-record slice and is retracted.

**Limit to carry forward:** these are opus judgments, not ground truth. Work
optimised against them is distillation, capped at opus accuracy. Never report
agreement with this set as "correctness".

## The anti-over-extraction traps (tested, NOT applied)

Every CLI false positive is the same error in four shapes: *a path appears,
therefore C*. The rule actually requires a stated observable **property** of
that path. Text as tested, inserted immediately before the `Task prompt:` block
in `buildRefinerPrompt`:

```text
NOT class C — shapes that look extractable but are not. Each is D unless some OTHER stated property independently qualifies:
- The prompt names a path but states NO property of it. Reading, viewing, opening, reviewing or looking at a file leaves no filesystem trace, so there is nothing for a check to observe.
- The name looks path-like but is not a filesystem path: a git branch or ref, a URL, a package or module name, a bare identifier. Only a real file or directory path counts.
- A bare filename with no directory, where the prompt never says where it belongs. A check would have to invent the location.
- The prompt says to fill, populate, update or finish a named file without stating what content would make it done. Mere existence is not the criterion the prompt stated.
Naming a path is NEVER sufficient on its own. Ask: what would the file look like afterward that it does not look like now, in words the prompt itself supplies? If you cannot answer from the prompt text alone, the class is D.
```

Measured effect, scored on the blind labels:

| | before | after |
|---|---|---|
| CLI correct | 9/13 | **10/13** |
| CLI false-C | 4 | **0** |
| CLI missed-C | 0 | 3 |
| SDK correct | 9/13 | 9/13 |
| SDK false-C | 1 | **0** |
| SDK missed-C | 3 | 4 |

False-C goes to **zero on both transports** — precision 69% → 100% on the CLI —
at a recall cost of 100% → 67%.

**Known defect in this text.** It overcorrects record 12 (*"create notes.txt
containing one line: demo"*) to D, which is unambiguously C — path and literal
content both stated. Cause: every rule is phrased as a reason to reject, with no
counterweight saying when a named path **is** sufficient. A fix would add that
counterweight — but see below.

**Why it was not iterated further.** The next round would tune wording against
the same 13 records it is scored on. That is overfitting, and it is precisely
how the Gauntlet's `null_precedent` check died — a check refined until it passed
its own examples. Further work wants a held-out split and a pre-registered bar,
which is resume.md item 12's proposal: run the proposer/reviewer/A-B loop on
this prompt rather than hand-tuning it.

## Reproducing the measurement

Transport A/B and patch scoring used the corpus store at `.km/gauge-corpus/`
(host-local — the office host has its own). The SDK path used
`@anthropic-ai/sdk` with the Claude Code keychain OAuth token passed explicitly
as `authToken`; a zero-arg client does **not** inherit CC credentials. Structured
outputs (`output_config.format` + `json_schema`) eliminated every parse failure —
note union type arrays (`["string","null"]`) are rejected, use `anyOf`.
