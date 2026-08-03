# Paired-validation shadow-store tooling (§6c) — build plan

**Date:** 2026-08-03 (office). **Go:** user, "build the paired-validation
script", 08-03 morning. **Spec authority:** §6c amendment, APPROVED
`c22fbd0` — `docs/superpowers/specs/2026-07-29-km-gauge-v2-extractor-
preregistration.md` lines 443-529. This plan adds NO semantics; where the
spec is silent, rulings are recorded here as build annotations (GA9
precedent).

## What it does

Two model-free subcommands + the existing fenced deriver do the spend:

1. `pv-sample [cwd]` — from the host's REAL corpus store, select **every
   CLI-derived class-C record** + an **equal-size random draw of
   CLI-derived not-C** records; build a SHADOW store containing exactly
   those records reset to stage `"mined"`; write a sample manifest.
   Model-free.
2. (spend, existing tool) `derive --go <n>` run WITH CWD CONTEXT pointing
   at the shadow store — the §6c deriver is already SDK-transport; its
   cost fence (`go === pending.length`) holds because the shadow store's
   pending set IS the sample. The fenced deriver is NOT modified (spec).
3. `pv-compare [cwd]` — join real-store CLI classifications with
   shadow-store SDK classifications per record key; emit counts +
   pre-registered bar verdict. Model-free, read-only on both stores.

## Build rulings (spec-silent points, decided pre-build)

- **R1 — shadow store contains ONLY the sampled records.** The spec says
  "copy the store, reset the sampled records to mined". A full copy would
  carry the office store's 112 already-mined records as pending, breaking
  the fence arithmetic (go would have to be 112+n) and spending on
  non-sample records. Sample-only copy satisfies the spec's intent (the
  fenced deriver untouched; shadow derivations never pooled) and makes
  `--go n` exactly the sample size. The real store is opened read-only in
  `pv-sample`; a byte-identical-store test pins it.
- **R2 — "CLI-derived" predicate:** record has a derivation AND its
  transport field is `"cli"` or absent (absent = pre-boundary CLI, per
  §6c provenance rule). Records with `transport:"sdk"` are excluded from
  sampling entirely (they are post-boundary and have no CLI arm to pair
  with).
- **R3 — not-C draw is recorded, not seeded.** Plain `Math.random`
  shuffle; reproducibility comes from the MANIFEST (sampled keys +
  stratum written to the shadow dir), not from a deterministic seed. The
  comparison joins on manifest keys, so a re-run of `pv-sample` never
  silently changes an in-flight sample: `pv-sample` REFUSES to run if a
  shadow store already exists (explicit `--reset` to discard).
- **R4 — shadow store location:** `.km/gauge-corpus-shadow/` (repo-root
  `.km/`, gitignored like the real store; F2 untouched — never in
  km-sensors-sync FILES, never committed). Same records.ndjson layout so
  the existing store/deriver code reads it unchanged.
- **R5 — outputs are counts + keys only.** The compare artifact
  (`pv-counts.json` in the shadow dir + stdout report) carries counts,
  the bar arithmetic, and record KEYS — never prompt text (F2:
  code-bearing text never travels). Cross-host combining = evaluating the
  bar on summed counts; `pv-compare --combine <other-host-counts.json>`
  accepts the other host's committed counts file.
- **R6 — CLI wiring:** two new subcommands on the existing
  `replay-cli.ts` dispatcher (same UX as mine/derive/resolve/report).
  Logic lives in a new `src/gauge/paired-validation.ts`; `replay-cli.ts`
  gains only dispatch lines. No core/, vendor/, minimal/ files touched
  (F1).

## Bar (verbatim from spec, constants pre-registered)

- Positive agreement: `|C_cli ∩ C_sdk| / |C_cli ∪ C_sdk| ≥ 0.80`, AND
- Missed-C: `|C_cli \ C_sdk| ≤ ceil(0.10 × |C_cli|)`.
- Both hold → pooling permitted (split still reported). Either fails →
  split for the life of the window. Expected: FAIL (13-slice at 54%).

## Tasks

- **T1 — `pv-sample`:** stratified selection (R2), shadow-store build
  (R1, R4), manifest, refuse-if-exists (R3). Tests: stratification
  counts, transport-field filtering (cli/absent in, sdk out), real store
  byte-identical after run, shadow pending == sample size, refuse/reset
  behavior, C-count < 1 edge (error: nothing to validate).
- **T2 — `pv-compare` (+ `--combine`):** key join (manifest-driven),
  counts, bar arithmetic incl. ceil edge cases, verdict line, combine
  path summing counts before the bar. Tests: agreement/missed-C math on
  fabricated stores, undecided records (shadow derive failed → record
  excluded from both strata with an explicit `undecided` count, never
  silently dropped), combine arithmetic, read-only pin on both stores.
- Per-task fresh-context review + fix wave; final whole-branch review;
  merge via finishing-a-development-branch. Suite: zero real model calls
  (transport stubbed via existing sdk-stub.ts pattern).

## Post-build annotations (final whole-branch review, 2026-08-03 — shipped
## behavior where it extends or deviates from the text above)

- **Counts travel channel (review finding 1, REQUIRED):** the shadow dir is
  gitignored, so `pv-counts.json` / `pv-combined.json` do NOT travel by
  sitting there. Operator step: copy the artifact(s) to
  **`docs/gauge-pv/<hostname>-pv-counts.json`** (and
  `docs/gauge-pv/pv-combined.json` from whichever host ran `--combine`)
  and commit. That committed copy is the file the OTHER host feeds to
  `pv-compare --combine`, and the audit trail for the window ruling.
- **R4 layout (as shipped):** records nest at
  `.km/gauge-corpus-shadow/.km/gauge-corpus/records.ndjson` so the
  UNMODIFIED deriver resolves the store; manifest + counts artifacts sit
  at the shadow root top.
- **R5 (as shipped):** a successful `--combine` additionally writes
  `pv-combined.json` (both hosts' counts + combined bar verdict) — the
  durable cross-host decision artifact.
- **T2 (as shipped):** a `wrongTransport` bucket (shadow derivation not
  `transport:"sdk"`, or real arm failing the CLI predicate) blocks bar
  evaluation exactly like undecided/missing — the instrument detects its
  own miswiring.
- **T1 (as shipped):** `--reset` refuses while the SHADOW store's lock is
  live (store's own staleness rule) — an in-flight shadow derive cannot be
  destroyed.
- **R1 status note (review finding 4):** R1 (sample-only copy) deviates
  from the spec's LETTER ("copy the store") with recorded rationale —
  pre-registered in this plan before build, so a deviation on record, not
  silent drift.

## Out of scope

Any spend (sample derive batches = own sized go per host, after merge).
Any change to runDerive, the fence, transports, or classifications. Any
pooling of shadow derivations into readings (spec: never).
