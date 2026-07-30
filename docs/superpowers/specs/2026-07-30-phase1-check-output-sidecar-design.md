# Phase 1 design — block-output sidecar + proposer excerpt rendering

**Date:** 2026-07-30 · **Status:** approved (user "go", this session)
**Origin:** `docs/2026-07-30-enhancement-roadmap.md` Phase 1 (architect-reviewed
scope; NO spec amendment needed — gate-outcomes stream untouched by
construction). Estimate ~1.5–2d.

## Problem

The block branch (`core/stop.ts` → `hook-cli.ts`) already sees the failing
check output (`decision.rawOut`, 64KB-capped at the round.ts tee) but
**discards it** after delivering it to the agent. The proposer's evidence
input is counts-plus-log — too thin to derive non-junk candidates (round-1
rejection history). Capturing excerpts turns "5 catches" into "3 of 5 are the
same missing-await pattern".

## Binding constraints (from roadmap)

- **F1** — no commit may touch `MECHANISM_PATHS`
  (`minimal/complete-gate.ts`, `minimal/mutate.ts`, `minimal/spec-probe.ts`,
  `minimal/session2.ts`, `cc-gate-plugin/src/core`, `cc-gate-plugin/vendor`);
  doing so stales the §4.3 calibration registry. All capture lives at the
  `hook-cli.ts` seam / new modules outside those paths.
- **F2** — sidecar data must never reach `gate-outcomes.ndjson` or the
  `km-sensors-sync.sh` `FILES` export list (snapshot one-way door: exported
  lines can never be retroactively stripped). Sidecar is a separate,
  never-exported file, asserted by test.

## A. Capture (cc-gate-plugin)

- New module `cc-gate-plugin/src/sidecar.ts` (src root, NOT `core/`), called
  from `hook-cli.ts`'s Stop branch after the decision is final and state is
  persisted: `decision.kind === "block"` → append one ndjson line to
  `<cwd>/.km/check-output.ndjson`:

  ```json
  {"ts": 1753900000000, "sessionID": "…", "round": 1, "roundsMax": 2,
   "check": "bun test", "excerpt": "…", "truncatedBytes": 12345}
  ```

- **Excerpt cap 8KB: head 2KB + tail 6KB** with a splice marker
  (`\n…[kkamak sidecar: N bytes elided]…\n`); compile errors sit at the head,
  test summaries at the tail. Source text: `decision.rawOut ?? decision.evidence`.
  `truncatedBytes` present only when elision happened.
- Path is the fixed default `.km/check-output.ndjson` relative to cwd —
  deliberately independent of a `gate.json` `sensor` override (all live repos
  use the default; keeping it fixed avoids a second configurable path).
- **Fail-open** exactly like `appendSensor`: mkdir-p + append, any failure
  logged to stderr and swallowed — a sidecar-write problem never changes the
  emitted decision or output.
- **Known limitation:** the exhausted FINAL round is not captured — its
  rawOut never leaves `core/stop.ts` (the `allow-exhausted` decision carries
  no rawOut), and adding it would touch a MECHANISM_PATH (F1). Rounds
  1..r of an exhausted cycle ARE captured.

## B. Consumption (km-crank)

- New pure module `km-crank/src/check-output.ts`: locally re-declared record
  type (standalone-package rule, same as `scan.ts`), shape-guarded ndjson
  parser (skip malformed, never throw), and `joinBySession()` grouping
  records to sensor lines by `sessionID`.
- `crank.ts` reads each repo's `.km/check-output.ndjson` whole-file (no
  byte-offset bookkeeping — the file grows slowly and the join filters to
  notable sessionIDs anyway). Missing file → no excerpts, no error.
- `evidence.ts`: `RepoEvidence` gains optional per-notable-session excerpts;
  render up to **2 excerpts per session, ≤1200 chars each**, latest rounds
  first, in fenced blocks under the notable-session bullet. Absent sidecar
  (kernel-emitted repos, pre-Phase-1 data) renders exactly as today.
- Cross-host caveat (accepted in roadmap): sidecar is host-local; the
  proposer runs where the live `.km/` is.

## C. Guards

- **F2 test:** grep-assert `scripts/km-sensors-sync.sh`'s `FILES=(…)` line
  contains no `check-output` (lives beside the existing repos-parity guard
  in km-crank's suite).
- **F1 test:** assert the sidecar writer module's path is outside every
  `MECHANISM_PATHS` entry (import-path check). Plus a review-step
  verification per task: `git log <base>.. -- <MECHANISM_PATHS>` empty — a
  pure test cannot know the branch base, so this half stays procedural.

## D. Registration

Evidence-only docs note (this file + a HISTORY entry at seal). No 5th
pre-data amendment: the gate-outcomes stream and every §4.3 verdict input
are untouched by construction.

## Rejected in-design (do not resurrect silently)

- Excerpts into `gate-outcomes.ndjson` — F2 one-way door.
- Capture at the `core/round.ts` tee — F1 violation.
- Per-block loose files `.km/check-output/<sessionID>-<round>.txt` —
  unbounded file count, worse join, no single cap point.

## Out of scope

- Kernel (`~/z2/kkamak`) sidecar parity — the installed plugin emits the
  sidecar in every armed repo already; kernel parity is dogfood-repo
  backlog.
- Exhausted-final-round capture (see A, F1).
- Any change to sensor-line schema, scan.ts parsing semantics, or §4.3
  verdict machinery.

## Success criteria

1. A blocked round in any armed repo appends exactly one sidecar record;
   allow/exhaust/internal-error paths append none.
2. Sidecar write failure provably cannot change hook output (test).
3. km-crank evidence markdown shows excerpts beside notable sessions when
   sidecar data exists, and is byte-identical to today's output when it
   doesn't.
4. F1: `git log` over MECHANISM_PATHS unchanged across the whole phase.
   F2: sync-script FILES list untouched, asserted by test.
5. All suites green (cc-gate-plugin 385+, km-crank 189+).
