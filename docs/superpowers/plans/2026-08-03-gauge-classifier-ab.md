# Gauge classifier 2×2 A/B — amendment + offline experiment tooling

**Date:** 2026-08-03 (office). **Go:** user direction "we run two arms of
haiku and sonnet for classifier... determine which to use", executed via
SDD. **Decides:** which model (haiku vs sonnet) and which prompt (base vs
the committed anti-over-extraction patch) the gauge refiner uses — by
pre-registered measurement, not opinion. Label spend and arm spend each
need their own sized go at run time; nothing in this build spends.

## Global constraints (binding on every task)

- F1: core/, vendor/, minimal/ files untouchable; gauge/ editable.
- F2: no prompt text ever committed to git or written into any artifact
  destined for git — counts, keys, classes, and metrics only.
- Zero real model calls in the test suite — transport stubbed (existing
  sdk-stub.ts pattern).
- The production corpus store and the production refiner path are never
  mutated by experiment tooling. Experiment state lives under
  `.km/gauge-cls-ab/` (gitignored via `.km/`).
- Every spend subcommand is cost-fenced like `derive --go`: refuses unless
  `--go n` equals the exact pending count.
- Blind-label isolation (hard): the labeler run never reads any arm's
  output or the corpus derivation classes; arm runs never read labels.
  Enforced by construction (separate files, separate subcommands) and
  pinned by tests.
- Model literals: arms use exactly `claude-haiku-4-5` and
  `claude-sonnet-5`; labeler uses exactly `claude-opus-5`. These are
  experiment pins, recorded in every result row.

## Design (pre-registered; constants live in the Task 0 amendment)

- **Sample:** per host, from that host's corpus store: ALL records whose
  stored derivation is nominal class C, plus an equal-size random draw of
  nominal not-C derived records. (Stratification uses the stored CLI-era
  nominal class as an enrichment heuristic only; ground truth comes from
  fresh blind labels.) Office today: 16 C + 16 not-C = 32.
- **Ground truth:** one blind opus label per sampled record — fresh
  context, sees ONLY the classification rubric + the record's prompt
  (+floorCheck), never any arm output, never the stored class. Label =
  C / not-C (+ optional class letter). Registered limit restated: labels
  are opus judgments — arms are scored on agreement-with-opus, capped
  there, never reported as "correctness".
- **Arms (2×2):** {haiku, sonnet} × {base prompt, patched prompt}. The
  patched prompt = base + the four committed anti-over-extraction traps
  (docs/2026-08-01-gauge-classifier-labels.md). Each arm classifies every
  sampled record via the SDK transport. 4 arms × 32 = 128 cheap calls.
- **Metrics per arm:** C-precision, C-recall, F1 vs labels; false-C and
  missed-C counts (error profile).
- **Decision rule (constants pre-registered in Task 0's amendment BEFORE
  any label exists — proposed values, user may re-rule before the label
  go):** incumbent = haiku+base. Winner = argmax F1, adopted ONLY if
  (a) F1_winner − F1_incumbent ≥ 0.10, AND (b) missed-C_winner ≤
  missed-C_incumbent. Otherwise incumbent stays. Ties broken toward the
  cheaper model, then toward the base prompt. Adoption of any non-incumbent
  arm = instrument change: pre-data amendment mechanics already satisfied
  by Task 0; deploy needs a logged boundary ts + model recorded on
  derivations (transport-field precedent).

## Tasks

### Task 0 — pre-registration amendment (doc)

Write `docs/superpowers/specs/2026-08-03-gauge-classifier-ab-preregistration.md`:
the design above, verbatim constants (0.10 F1 margin; missed-C
not-worse; tie-break order), the blind-label protocol, the two registered
limits (opus-judgment ceiling; third lane needs own bar — this IS that
bar), what the experiment CANNOT do (cannot unshadow the gauge, cannot
change §3/§4.3 bars, cannot pool into M1v2, labels never become corpus
records), per-host mechanics (host-bound stores; counts travel via
committed `docs/gauge-cls-ab/<hostname>-*.json`), spend accounting (label
go + arm go, sized, separate), and the falsification clause (if no arm
clears the bar, incumbent haiku+base stands and the result is still a
registered finding). Must state it follows §6c discipline and cite the
GA11 blind-label methodology.

### Task 1 — sampler (`cls-sample`)

`cc-gate-plugin/src/gauge/cls-ab.ts` + dispatch case in replay-cli.ts.
Stratified sample per the design from the real corpus store (read-only;
byte-identical pin), manifest `.km/gauge-cls-ab/manifest.json` (keys +
strata + sampledAt + hostname; keys via exported `recordKey`), a
records file `.km/gauge-cls-ab/records.ndjson` carrying the sampled
records' prompt/floorCheck/key (host-local only, never committed — F2),
refuse-if-exists / `--reset` guarded like pv-sample (reuse
`hasLiveCorpusLock` pattern where applicable). Zero-C → hard error.
Tests: stratification, store non-mutation, refuse/reset, manifest-store
key match, no-prompt-text-in-manifest.

### Task 2 — arm + label runners (`cls-run`, `cls-label`)

Extend cls-ab.ts. `cls-run --arm <haiku|sonnet>-<base|patched> --go n`:
classifies every sampled record via the SDK transport with a model
override (extend transport call signature with an optional model param —
default unchanged = production haiku; production callers untouched,
pinned by test) and the arm's prompt variant; cost fence: n == count of
sampled records not yet classified by THIS arm; results to
`.km/gauge-cls-ab/arm-<name>.ndjson` (key, class, transport, model,
ts — no prompt text). `cls-label --go n`: same mechanics with
`claude-opus-5` + the label rubric; writes `labels.ndjson`; MUST NOT read
arm files or stored derivation classes (pinned by test). Both idempotent
per record (re-run derives only missing). Fail-open per record: a
transport error marks the record failed-this-run, never crashes the
batch, never fabricates a class. Tests: fence arithmetic, model literal
per arm, prompt variant selection, blind isolation, idempotent top-up,
stub transport only.

### Task 3 — scorer (`cls-score`)

Extend cls-ab.ts. Reads manifest + labels + all present arm files;
refuses to score any arm with missing records (explicit per-arm
completeness report); computes the metrics table + error profiles +
decision-rule evaluation with the amendment's constants (constants
imported from one exported object, single source); output: stdout table
+ `.km/gauge-cls-ab/cls-score.json` (counts/metrics/verdict only — F2)
+ a `--emit-doc <path>` flag that writes the committable counts file for
`docs/gauge-cls-ab/`. Never mutates anything else. Tests: metric
arithmetic on fabricated fixtures (incl. zero-division edges), decision
rule paths (adopt / incumbent-stays / tie-breaks), incomplete-arm
refusal, F2 pin on both outputs.

## Out of scope

Running the experiment (label go + arm go, per host). Deploying a winner
(own boundary + amendment mechanics). Any change to the production
refiner prompt or model. Prompt-tuning loops beyond the fixed 2×2.
