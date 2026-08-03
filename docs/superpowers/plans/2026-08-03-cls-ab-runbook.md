# Gauge classifier 2×2 A/B — operator runbook

**Date:** 2026-08-03 (fix-wave F7a, final fix wave of the `gauge-cls-ab`
branch's whole-branch review).
**Operationalizes:** `cc-gate-plugin/src/gauge/cls-ab.ts` (Tasks 1-3, plan
`2026-08-03-gauge-classifier-ab.md`) against the pre-registered spec
`docs/superpowers/specs/2026-08-03-gauge-classifier-ab-preregistration.md`
(spec sections cited inline below — `§2.1` sample, `§2.2` blind labels,
`§2.3` arms, `§3` decision rule, `§6` per-host mechanics, `§7` spend
accounting).

> **SPEND NOTE (binding):** every `cls-label --go`/`cls-run --go` call is a
> real model spend, cost-fenced exactly like `derive --go` (spec §7): it
> refuses unless `--go n` equals the CURRENT exact pending count. This
> document is the procedure, not the permission — each go below still needs
> its own explicit user "go" (repo-wide hard rule).

All commands below run from the repo root (`meta-harness/`), which is also
`cwd` for every `cls-*` subcommand (positional, defaults to
`process.cwd()`).

## 1. Per-host prerequisites (pv-style, spec §6)

Corpus stores are host-bound by design (`.km/gauge-corpus/`, GA9) — so is
`.km/gauge-cls-ab/`, this experiment's own state dir. Consequently every step
in §2-§6 below runs **once per host**, against that host's own corpus store,
producing that host's own `.km/gauge-cls-ab/` tree. Nothing here is
resumable across hosts; only the FINAL committed counts travel (§6 below).

1. `bun install` in `cc-gate-plugin/` if this host has not pulled the SDK
   transport commit before (cross-host gotcha logged in `docs/resume.md`:
   pulling the SDK merge leaves the suite red until `bun install` runs).
2. `bun test` green + `bunx tsc --noEmit` clean in `cc-gate-plugin/` — the
   same token-free gate every other gauge tool build uses before any real
   spend.
3. Confirm the host's real corpus store (`.km/gauge-corpus/`) has at least
   one nominal class-C derived record — `cls-sample` hard-errors otherwise
   (checked before touching `.km/gauge-cls-ab/` at all, so a bad run can
   never discard an in-flight sample).
4. Confirm no other `cls-sample`/`cls-run`/`cls-label`/`cls-score` invocation
   is in flight on this host — the shared lock (`.km/gauge-cls-ab.lock`)
   refuses cleanly if one is, but a stale (>10min) lock takes over
   automatically, so a genuinely-stuck prior invocation does not need manual
   cleanup.

## 2. `cls-sample` — build the experiment sample (model-free)

```bash
cd cc-gate-plugin
bun src/gauge/replay-cli.ts cls-sample
```

Builds `.km/gauge-cls-ab/manifest.json` (keys + strata + per-stratum
transport tally + `sampledAt` + hostname — never prompt text, F2) and
`.km/gauge-cls-ab/records.ndjson` (the sampled records' key/prompt/
floorCheck — host-local only, never committed). Per spec §2.1: every
stored-nominal-class-C derived record, plus an equal-size random draw of
stored-nominal-not-C derived records (ANY transport — unlike
paired-validation's `pv-sample`, the CLI/SDK split is descriptive only
here).

- **Re-running:** refuses if `.km/gauge-cls-ab/` already exists (a re-run
  must never silently replace an in-flight sample). Pass `--reset` to
  discard and rebuild.
- **`--reset` spend guard (fix-wave F6):** if `labels.ndjson` or any
  `arm-*.ndjson` already exists under the experiment dir, `--reset` alone
  REFUSES (prints the exact row count of every file about to be destroyed).
  Add `--discard-spend` to confirm — it prints the same counts, THEN
  destroys them and rebuilds. Never pass `--discard-spend` without reading
  the printed counts first.
- Log line reports `N nominal-C + N nominal-not-C ... -> .km/gauge-cls-ab (2N total)`.
  Record `2N` — it is the exact `--go` size for the label go and each arm go
  below.

## 3. `cls-label` — the blind ground-truth go (spec §2.2, §5, §7)

Sized to the exact count `cls-sample` reported (`2N` above; top-ups use
whatever the refusal message reports as the current pending count):

```bash
bun src/gauge/replay-cli.ts cls-label --go <2N>
```

Model is ALWAYS `claude-opus-5` (labeler literal, never routed through
`KKAMAK_GAUGE_MODEL` — spec §2.3). Blind by construction (spec §5): this
subcommand's only reads are `records.ndjson` and its own `labels.ndjson` —
it never opens `manifest.json` (the stored nominal class) or any
`arm-*.ndjson`, structurally, not by convention.

- **Idempotent top-up:** a transport failure marks that record
  failed-this-run (no row, never a fabricated label) and stays pending; a
  fail-open batch just means the next `cls-label --go <pending>` picks up
  exactly the missing ones. Re-run with the count the refusal/summary line
  reports, never a guessed number.
- Run this BEFORE or interleaved with the arm gos below in any order — the
  label go and each arm go are independent spends (spec §7), none folded
  into another.

## 4. Arm gos — 4 separate sized spends (spec §2.3, §7)

Each of the 4 arms needs its OWN `--go` sized to that arm's own current
pending count (a record that failed in one arm never blocks another arm's
own top-up):

```bash
bun src/gauge/replay-cli.ts cls-run --arm haiku-base    --go <pending for this arm>
bun src/gauge/replay-cli.ts cls-run --arm haiku-patched --go <pending for this arm>
bun src/gauge/replay-cli.ts cls-run --arm sonnet-base    --go <pending for this arm>
bun src/gauge/replay-cli.ts cls-run --arm sonnet-patched --go <pending for this arm>
```

Model literals are experiment pins, recorded verbatim on every row (spec
§2.3): `haiku` = `claude-haiku-4-5`, `sonnet` = `claude-sonnet-5` — never the
CLI-era alias, never a default substitution. `patched` = base prompt + the
four committed anti-over-extraction traps
(`docs/2026-08-01-gauge-classifier-labels.md`); `base` is byte-identical to
the pre-experiment production prompt. Writes `.km/gauge-cls-ab/arm-<name>.ndjson`
(key/class/model/promptVariant/transport/`promptSha256`/ts — no prompt text,
F2; `promptSha256` is a HASH of the exact prompt sent, fix-wave F8
provenance, never the text itself).

`cls-run` structurally never reads `labels.ndjson` (mirrors §3's isolation
in the other direction) — running arms and labeling can happen in any
interleaving without either contaminating the other.

## 5. `cls-score` — metrics + the per-host decision (model-free, read-only)

Once labels are complete and as many arms as this host has run:

```bash
bun src/gauge/replay-cli.ts cls-score --emit-doc ../docs/gauge-cls-ab/<hostname>-cls-score.json
```

(Use this host's actual hostname, e.g. `office-cls-score.json` /
`yoo-mac-cls-score.json` — matches the `docs/gauge-pv/<hostname>-*.json`
naming convention already in use for paired-validation.)

- Refuses (zero writes) if `manifest.json` is missing/malformed or if
  labels are incomplete — labels are the ground truth every arm is scored
  against.
- Per-arm completeness is reported (never silently refuses the whole run) —
  an arm missing even one sampled record is INCOMPLETE, excluded from
  winner selection, but always shown with its exact missing count.
- `provisional: true` (JSON) / a `WARNING: PROVISIONAL` stdout line
  whenever this run was NOT computed over all 4 registered arms fully
  derived, OR any present arm carries a provenance red flag (fix-wave
  F8/F9): `mixedPrompt: true` (an arm's rows were built from differing
  prompt text) or `mismatchedRows > 0` (a row's recorded model/promptVariant
  doesn't match its arm filename's expected literal). Never re-run past a
  PROVISIONAL warning without understanding why it fired.
- The written doc's `decision.scope` is `"per-host"` — this is NOT the
  registered verdict by itself (spec §6: "the decision rule ... is
  evaluated on combined counts across hosts"). Treat a per-host ADOPT/
  INCUMBENT-STAYS as informational until the combine step below runs.
- **Commit the emitted doc** (`docs/gauge-cls-ab/<hostname>-cls-score.json`)
  — this is the only artifact from this whole procedure that travels
  cross-host (CLAUDE.md rule: host-local `.km/` state never transfers,
  git-tracked docs do).

## 6. Cross-host combine (spec §6, fix-wave F3) — once BOTH hosts' docs exist

After every host has committed its own `docs/gauge-cls-ab/<hostname>-cls-score.json`
(step 5, on ALL hosts running this experiment) and those commits are pulled
onto the host doing the combine:

```bash
bun src/gauge/replay-cli.ts cls-score \
  --combine ../docs/gauge-cls-ab/<other-hostname>-cls-score.json \
  --emit-doc ../docs/gauge-cls-ab/cls-score-combined.json
```

- Validates the other host's file shape (integer, non-negative,
  internally-consistent per-arm counts; refuses on a malformed file) and
  refuses a self-combine (same hostname as this host — combining a host
  with itself double-counts its sample).
- Sums per-arm counts field-wise across hosts (valid because per-host
  corpus stores — and therefore per-host samples — are disjoint by
  construction, GA9) and re-evaluates the pre-registered decision rule on
  the SUMMED counts. Writes `.km/gauge-cls-ab/cls-combined.json` (the
  durable local copy) and, because `--emit-doc` was also given, the SAME
  combined content to the emit-doc path — `--emit-doc` targets the COMBINED
  body once `--combine` is present, not the per-host one (the per-host doc
  was already committed separately in step 5).
- `combined.decision.scope` is `"combined"` — THIS is the registered
  verdict (spec §3, evaluated per spec §6).
- **Commit `docs/gauge-cls-ab/cls-score-combined.json`.** This is the
  experiment's terminal artifact.

## 7. Naming conventions (summary)

| artifact | path | committed? |
|---|---|---|
| sample manifest | `.km/gauge-cls-ab/manifest.json` | no (host-local) |
| sampled records (prompt text) | `.km/gauge-cls-ab/records.ndjson` | no, NEVER (F2) |
| blind labels | `.km/gauge-cls-ab/labels.ndjson` | no (host-local) |
| arm outputs | `.km/gauge-cls-ab/arm-<model>-<variant>.ndjson` | no (host-local) |
| per-host score (local copy) | `.km/gauge-cls-ab/cls-score.json` | no (host-local) |
| per-host score (committable) | `docs/gauge-cls-ab/<hostname>-cls-score.json` | **yes** |
| combined score (local copy) | `.km/gauge-cls-ab/cls-combined.json` | no (host-local) |
| combined score (committable) | `docs/gauge-cls-ab/cls-score-combined.json` | **yes** |

`<hostname>` = `os.hostname()` on the machine that ran `cls-sample`/
`cls-score` — matches the convention already established by
`docs/gauge-pv/<hostname>-*.json` (paired-validation lane).

## 8. What this runbook does NOT authorize

Same boundary as the spec's §4 ("what this experiment CANNOT do") and §8
("adoption mechanics ... out of scope for this experiment itself"): running
this procedure produces a registered FINDING, never a production change by
itself. Deploying a winning non-incumbent arm needs its own logged boundary
timestamp in the gauntlet adoption ledger and its own go — this runbook ends
at the committed combined verdict.
