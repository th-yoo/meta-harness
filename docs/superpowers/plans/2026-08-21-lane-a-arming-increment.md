# Lane A Arming Increment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bypassed `revalidate()` gate in the shipped audit path with the closed spec's machinery — a chi²-vs-noise merge predicate over a harness-enumerated full anchor set (§6, §8.2) plus the §8.8 value-truth ladder, so numeric injection requires CROSSCHECKED and everything else is criteria-class only.

**Architecture:** Five new pure modules under `opencode-plugin/src/bench/` (`noise-sigma.ts`, `eligibility.ts`, `source-crosscheck.ts`, `numeric-literal.ts`, `value-truth.ts`), a tracked-peak addition to `series-peaks.ts`, a chi² predicate replacing the R-ratio in `reval-fit.ts`, and a rewritten claim contract in `convention-audit.ts` + its prompt. The harness enumerates anchors and derives every tolerance; the model supplies only world knowledge (which family, what each anchor's canonical value is). Nothing changes the default: `conventionAudit` stays default-false — **arming the flag is a separate go.**

**Tech Stack:** Bun + TypeScript, bun:test, stdlib only. No new dependencies. Zero model-token spend anywhere in this plan.

**Spec:** `docs/superpowers/specs/2026-08-20-dnc-design.md` — §6 (merge conditions 1–5, threat split), §8.2 clauses (a)–(c), §8.8 rules (i)–(v) + authority ladder.

**Reference implementation (the port's oracle):** `docs/loop-probes/derived-thresholds-20260821/derive.py`. Verified reproducing 11/11 on 2026-08-21 via `python3 -B docs/loop-probes/derived-thresholds-20260821/derive.py`. Every numeric expectation in this plan was read off that run, not invented.

---

## What this increment does NOT buy

State this before anyone reads further, so no one expects a lift that the spec forbids:

- **raman stays criteria-class.** raman-fitting is single-artifact (`value-truth-census-20260821/census.md`), therefore structurally NO-SOURCE, therefore never CROSSCHECKED, therefore never numeric-injected. That is the ladder working as designed, not a defect to engineer around.
- **Value truth is still not established for NO-SOURCE tasks.** §6 rejects ERROR, never DECEPTION (probe V5 `value-fab` ACCEPTS by construction — that is the measured T6 boundary, reproduced in this plan's Task 8).
- **The executable-evaluator subclass of L-A is not implemented here** (Task 11 returns `undecidable` for it). Implementing it needs a uniform invocation contract; inventing per-task adapters is the named cheating class. Named as follow-on, not silently skipped.
- **Nothing arms.** `conventionAudit` default stays `false` in `cmd-run.ts`. Flipping it is its own go with its own evidence.

## Cross-lane review reconciliation (2026-08-21, both passes blind)

The plan at `bd99201` was reviewed twice independently: by lane A (self-audit,
recorded before the reply landed) and by `meta-harness-1e`. Neither saw the
other's findings first. The diff is method evidence and is recorded because it
is more informative than either list alone.

| Finding | Lane A self-audit | Cross-lane | Status |
|---|---|---|---|
| Literal checker quantifies over a CLAIMANT-SUPPLIED value set | **MISSED** | **F1 CRITICAL** | fixed, Task 12 |
| `EXECUTABLE_EXT` is a fail-open incident registry | S1 | F2 HIGH | fixed, Task 11 |
| `REL_TOL` author-supplied, violates §8.8(iii) | S2 | F3 | fixed (derived from source precision), Task 11 |
| `MIN_SERIES_ROWS = 64` justification is false | S4 | F3 | fixed (= `MAX_SMOOTH_WINDOW`), Tasks 2 + 7 |
| `SCALE_FACTORS` fixed list, fails open | S3 | — | fixed (mantissa comparison), Task 4 |
| Bad set shares an author with the checker | S5 | Q3 caveat | recorded, follow-on |
| Detector quartet asserted-stable, never swept | — | F3 | new Task 16 |
| Partial-match veto is a hair-trigger | — | F4 | fixed, Task 11 |
| Family choice selects between two domain boundaries | — | Q4 residual | fixed (both families must be in domain), Task 13 |
| `reject-degenerate` conflates attacked with uncheckable | — | LOW | recorded, manifest |

**The one that matters.** Lane A's self-audit found four constants and a list —
and missed the critical, which was not a constant at all but a **quantifier**.
§8.8(iv)'s enforcement asked "does the card state THESE numbers?", where THESE
came from the model's own claim block. Answering `FAMILY: none` emptied the set,
and every decoder ran against nothing. The self-audit had scrutinised the
decoders and the fixture — the removal ritual performed on one object while a
different object supplied the answer, which is the failure the resume banner
already names and which was still not visible from the inside.

Worse, and worth keeping: **lane A's own test blessed the hole.** The T4 case
"an empty value list makes every card literal-free (nothing to smuggle)" asserted
the vacuous behaviour as correct. A check that cannot fail was not merely
present; it had a passing test certifying it.

Standing prediction for the next review, from the same evidence: look at
QUANTIFIERS and their domains before looking at constants. Both passes found
constants easily; only the second pass found the quantifier, and only because it
was asked to attack the enforcement rather than the values.

## Global Constraints

- **Zero model-token spend.** Every task here is pure functions + fixtures + `bun test`. No `daemonCall`, no live audit, no bench run.
- **Default OFF.** No task may change `conventionAudit`'s default in `cmd-run.ts` or any driver. The audit path is rewritten; it is not switched on.
- Work directly on `main`. **NO branch or worktree operations** — shared checkout with a sibling session (`meta-harness-1e`); a checkout squats HEAD under them (measured 2026-08-20).
- **Never `git add docs/resume.md` or `minimal/HISTORY.md` bare** — `git add -p` then `git diff --cached` (a bare add stages the sibling lane's in-flight work under your authorship; measured twice, `8d09f7c`).
- **Do NOT push.** 19 commits are already unpushed; pushing is its own go.
- Full suite green at every task boundary: `cd opencode-plugin && bun test` (baseline 2026-08-21: **2279 pass, 1 skip, 0 fail, 148 files**). `bun scripts/gate-check.ts` from repo root green before every commit.
- **Never edit committed verdict or pre-registration files** under `docs/loop-probes/` — addenda only, new files only.
- The fit family is frozen at exactly `u ∈ {x, 1/x}` (spec §6.2). No additions in this plan. Any future member needs its own T1-style attack input — `FIT_FAMILY`'s type already enforces that.
- **The registered level is `0.999`.** Sensitivity across 0.99 / 0.999 / 0.9999 was measured non-load-bearing (derive.py run, all three give identical V1–V6). Name it `REG_LEVEL` so no reader mistakes it for a tuned knob.
- **The validated noise domain is `sigma_fraction <= 0.01`.** Outside it the gate returns `uncheckable`, never a verdict. Measured degradation past the domain is FALSE REJECT, never false accept (V7: 2% → 10/200 honest false-rejects, 5% → 182/200; shifted false-accepts 0/200 at every sigma). Exceeding the domain is conservative; that is *why* `uncheckable` is safe and *why* extrapolating would not be.
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## Pre-flight conflict scan (SDD)

Every identifier or format crossing a task boundary, with its **owner** named. A row without an owner is how the rung-4 seam gate burned two calls.

| Crossing | Owner (defines it) | Consumers | Conflict risk if unowned |
|---|---|---|---|
| `PeakTrack {pos, track}` | `series-peaks.ts` (T2) | `noise-sigma.ts` (T5), `convention-audit.ts` (T12) | T5 invents its own track shape; sigma silently derived from the wrong scale list |
| Anchor array ordering | `reval-fit.ts` (T6) — `mergeAccept` sorts `us`,`cs`,`sigmas` **together** internally | all callers pass parallel unsorted arrays | caller sorts `us` but not `sigmas` → per-anchor sigma attaches to the wrong anchor, predicate silently wrong |
| `REG_LEVEL = 0.999` | `reval-fit.ts` (T3) | T6, T8, T9, T11 | a second literal drifts off the validated level |
| `VALIDATED_SIGMA_FRACTION = 0.01` | `noise-sigma.ts` (T5) | `mergeGate` (T9) | domain bound duplicated, one copy tuned to keep a verdict |
| `ANCHOR CLAIM:` block grammar | `convention-audit-prompt.txt` **and** the parser in `convention-audit.ts` — **one shared exported regex, same commit** (T12) | T13 | parsed-but-not-stripped → claim block leaks into the SUT instruction; the exact failure `REVAL_MARKER` was introduced to prevent |
| `AUDIT_PROMPT_VERSION` | `convention-audit.ts` (T12) | audit trail readers | prompt bytes change without the version → trail attributes v6 behavior to v5 |
| Eligible-source set | `eligibility.ts` (T1) — single enumerator | `series-source` selection (T7), `source-crosscheck.ts` (T11) | two enumerators disagree → the series the gate anchors on is not the source the crosscheck reads |
| "numeric literal" definition | `numeric-literal.ts` (T4) | `value-truth.ts` (T13) | ladder enforces a weaker definition than the checker tests |
| `CrosscheckVerdict` union | `source-crosscheck.ts` (T11) | `value-truth.ts` (T13) | `undecidable` treated as evidence or as a veto — spec (ii) says it is neither |

**Zero-cost mock dry-run (mandatory before T12/T13 implementation):** hand-write one fake `ANCHOR CLAIM:` block, run it through the T12 parser and the T12 stripper, and assert (a) it parses and (b) the stripped card contains none of the block. Do this against the real regex before wiring anything live. This is the bar the SDD scan gap cost two calls on.

## Task DAG

```
G1 (independent — parallelizable in principle):
  T1 eligibility.ts        T2 series-peaks tracked      T3 chi² predicate      T4 numeric-literal
G2:
  T5 noise-sigma (T2)      T6 mergeAccept (T3)          T7 series selection (T1)
G3:
  T8 11-case equivalence regression (T5+T6)
G4:
  T9 mergeGate + UNCHECKABLE + scale attacks (T8)       T11 source-crosscheck (T1+T3)
G5:
  T10 anchor claim contract: prompt v6 + parser (T7+T9)
  T13 value-truth ladder (T9+T11+T4)
G6:
  T12 wire the gate into runAuditUncached (T10+T13)
G7:
  T14 real-fixture end-to-end (T12)                     T16 constant sweeps (T2, may run any time after)
G8:
  T15 docs + regression manifest (T14+T16)
```

**Execution note:** the shared checkout serializes implementers — **never dispatch two in parallel**; same working tree, same suite. The DAG is a dispatch ORDER constraint showing what *could* parallelize under future worktree isolation. Within G1, T2+T3 are one dispatch candidate (both touch only `reval-fit.ts`/`series-peaks.ts` and share no identifiers).

---

### Task 1: eligibility.ts — SUT-visibility manifest, strict and fail-closed

Spec §8.8 (ii)+(v). Eligibility is a POSITIVE structural criterion — **an artifact is L-A-eligible iff it is visible to the SUT inside the task container** — never a ban list. Grader-private material is excluded automatically by not being copied in.

**Why a new parser and not `parseCopySources`:** `convention-audit.ts:95`'s parser is documented best-effort — it silently skips glob sources and unmodellable flags. Best-effort is correct for a *sampler* and fatally wrong for an *eligibility manifest*, where an incompletely resolved set must fail closed (§8.8 ii: "an unresolvable eligible set → fail-closed NO-SOURCE"). `staging.ts`'s `parseTaskDockerfile` `die()`s on unclassified directives, which is fatal for arbitrary tasks. Neither is reusable; the spec names this.

**Directive handling is grammar-driven, not incident-driven:** the parser recognizes the Dockerfile format's own fixed directive set. `COPY`/`ADD` bring files in and are modelled. Every other standard directive is pure metadata w.r.t. the host `environment/` tree and is ignored. **Any directive the parser does not recognize, any glob source, any `--from=`, and any continuation it cannot join makes the whole manifest `unresolvable`.** The recognized set comes from the file format, predates every attack, and never grows in response to one. Files fetched at `RUN` time are out of scope by construction: they are not task-owned artifacts under `environment/`.

**Files:**
- Create: `opencode-plugin/src/bench/eligibility.ts`
- Test: `opencode-plugin/test/bench-eligibility.test.ts`

**Interfaces:**
- Consumes: `BenchPaths` from `./paths.ts` (field `tbRoot`).
- Produces:
  - `export type EligibleSet = { ok: true; root: string; files: string[] } | { ok: false; reason: "unresolvable" | "no-environment" }`
  - `export function eligibleArtifacts(paths: BenchPaths, task: string): EligibleSet` — `files` are absolute paths, sorted, deduped; reads the **pristine task-definition tree** (`paths.tbRoot/<task>/environment`), never a live container.
  - `export function parseCopyManifest(dockerfileText: string): { ok: true; sources: string[] } | { ok: false }` — strict; exported for direct testing.

- [ ] **Step 1: Write the failing tests**

Create `opencode-plugin/test/bench-eligibility.test.ts`:

```ts
import { test, expect } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseCopyManifest, eligibleArtifacts } from "../src/bench/eligibility.ts"

test("strict manifest resolves plain COPY sources", () => {
  const r = parseCopyManifest("FROM x\nWORKDIR /app\nCOPY task-deps /app/task-deps\nCOPY a.txt b.txt /app/\n")
  expect(r.ok).toBe(true)
  expect(r.ok && r.sources).toEqual(["task-deps", "a.txt", "b.txt"])
})

test("ADD is modelled like COPY (it also brings files in)", () => {
  const r = parseCopyManifest("FROM x\nADD data.csv /app/data.csv\n")
  expect(r.ok && r.sources).toEqual(["data.csv"])
})

test("a glob source makes the manifest UNRESOLVABLE, never a silent skip", () => {
  // convention-audit's sampler skips these; an eligibility manifest may not.
  expect(parseCopyManifest("FROM x\nCOPY *.dat /app/\n").ok).toBe(false)
})

test("--from= makes the manifest UNRESOLVABLE", () => {
  expect(parseCopyManifest("FROM x AS b\nCOPY --from=b /out /app/out\n").ok).toBe(false)
})

test("an unrecognized directive makes the manifest UNRESOLVABLE", () => {
  expect(parseCopyManifest("FROM x\nFROBNICATE thing\n").ok).toBe(false)
})

test("recognized metadata directives do not block resolution", () => {
  const src = "FROM x\nARG A=1\nENV B=2\nRUN echo hi\nUSER root\nLABEL l=1\nEXPOSE 80\n" +
    "VOLUME /v\nSHELL [\"/bin/sh\"]\nSTOPSIGNAL SIGTERM\nHEALTHCHECK NONE\nONBUILD RUN true\n" +
    "CMD [\"true\"]\nENTRYPOINT [\"true\"]\nWORKDIR /app\nCOPY x.txt /app/\n"
  const r = parseCopyManifest(src)
  expect(r.ok && r.sources).toEqual(["x.txt"])
})

test("a line continuation is joined before parsing", () => {
  const r = parseCopyManifest("FROM x\nCOPY a.txt \\\n  b.txt /app/\n")
  expect(r.ok && r.sources).toEqual(["a.txt", "b.txt"])
})

test("eligibleArtifacts enumerates COPY-reachable files from the pristine tree", () => {
  const tb = mkdtempSync(join(tmpdir(), "elig-"))
  const env = join(tb, "t1", "environment")
  mkdirSync(join(env, "task-deps"), { recursive: true })
  writeFileSync(join(env, "Dockerfile"), "FROM x\nCOPY task-deps /app/task-deps\n")
  writeFileSync(join(env, "task-deps", "a.dat"), "1 2\n")
  writeFileSync(join(env, "task-deps", "b.txt"), "hi\n")
  writeFileSync(join(env, "not-copied.txt"), "invisible to the SUT\n")
  const r = eligibleArtifacts({ tbRoot: tb } as any, "t1")
  expect(r.ok).toBe(true)
  expect(r.ok && r.files.map((f) => f.slice(env.length + 1)).sort())
    .toEqual(["task-deps/a.dat", "task-deps/b.txt"])
})

test("a file under environment/ that is never COPYed is NOT eligible", () => {
  // SUT-visibility is the criterion; presence on the host disk is not.
  const tb = mkdtempSync(join(tmpdir(), "elig2-"))
  const env = join(tb, "t2", "environment")
  mkdirSync(env, { recursive: true })
  writeFileSync(join(env, "Dockerfile"), "FROM x\nCOPY a.txt /app/a.txt\n")
  writeFileSync(join(env, "a.txt"), "seen\n")
  writeFileSync(join(env, "secret.txt"), "unseen\n")
  const r = eligibleArtifacts({ tbRoot: tb } as any, "t2")
  expect(r.ok && r.files.some((f) => f.endsWith("secret.txt"))).toBe(false)
})

test("a COPY source escaping environment/ fails the whole manifest closed", () => {
  const tb = mkdtempSync(join(tmpdir(), "elig3-"))
  const env = join(tb, "t3", "environment")
  mkdirSync(env, { recursive: true })
  mkdirSync(join(tb, "t3", "tests"), { recursive: true })
  writeFileSync(join(tb, "t3", "tests", "answer.txt"), "26\n")
  writeFileSync(join(env, "Dockerfile"), "FROM x\nCOPY ../tests/answer.txt /app/\n")
  const r = eligibleArtifacts({ tbRoot: tb } as any, "t3")
  expect(r).toEqual({ ok: false, reason: "unresolvable" })
})

test("a missing environment/ is no-environment, not a throw", () => {
  const tb = mkdtempSync(join(tmpdir(), "elig4-"))
  mkdirSync(join(tb, "t4"), { recursive: true })
  expect(eligibleArtifacts({ tbRoot: tb } as any, "t4")).toEqual({ ok: false, reason: "no-environment" })
})
```

- [ ] **Step 2: Run the tests, confirm they fail**

Run: `cd opencode-plugin && bun test test/bench-eligibility.test.ts`
Expected: FAIL — `Cannot find module '../src/bench/eligibility.ts'`.

- [ ] **Step 3: Implement `eligibility.ts`**

```ts
/** L-A eligibility manifest — spec §8.8 (ii)+(v). An artifact is eligible iff
 * it is VISIBLE TO THE SUT INSIDE THE TASK CONTAINER: reachable from a COPY/ADD
 * source rooted at the task's environment/ tree. SUT-visible artifacts cannot be
 * secret answer keys — the task already exposes them, so consuming them adds
 * zero answer knowledge beyond the task's own surface. Grader-private material
 * (tests/, solution/, hidden checkers) is excluded by NOT BEING NAMED: it simply
 * is not copied in. That is the point — a ban list would be the incident
 * registry re-grown at the source boundary.
 *
 * STRICT, unlike convention-audit.ts's deliberately best-effort parseCopySources
 * and unlike staging.ts's die()-on-unknown parseTaskDockerfile (spec: neither is
 * reusable here). Anything this parser cannot fully model makes the WHOLE
 * manifest unresolvable, because §8.8 (ii) requires the claim to be checked
 * against EVERY eligible source — a partial enumeration is a cherry-picked one.
 *
 * PRISTINE (v): reads the task-definition tree only. Several census tasks mutate
 * their own candidate sources at run time (db-wal-recovery, data-merger); a
 * post-run read would compare the claim against its own downstream effect. */
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs"
import { join, sep } from "node:path"
import type { BenchPaths } from "./paths.ts"

/** The Dockerfile format's own directive set. Grammar-driven, not attack-driven:
 * it predates every attack and never grows in response to one. COPY/ADD bring
 * files in and are modelled; the rest are metadata w.r.t. the host environment/
 * tree. Files a RUN fetches are out of scope by construction — not task-owned
 * artifacts under environment/. Anything NOT here fails the manifest closed. */
const METADATA_DIRECTIVES = new Set([
  "FROM", "RUN", "CMD", "LABEL", "MAINTAINER", "EXPOSE", "ENV", "ENTRYPOINT",
  "VOLUME", "USER", "WORKDIR", "ARG", "ONBUILD", "STOPSIGNAL", "HEALTHCHECK", "SHELL",
])

export function parseCopyManifest(dockerfileText: string): { ok: true; sources: string[] } | { ok: false } {
  // join continuations first — a source split across lines must not read as a directive
  const joined = dockerfileText.replace(/\\[ \t]*\r?\n/g, " ")
  const sources: string[] = []
  for (const raw of joined.split("\n")) {
    const line = raw.trim()
    if (line === "" || line.startsWith("#")) continue
    const m = /^(\S+)\s*(.*)$/.exec(line)
    if (!m) return { ok: false }
    const directive = m[1]!.toUpperCase()
    const body = m[2]!
    if (METADATA_DIRECTIVES.has(directive)) continue
    if (directive !== "COPY" && directive !== "ADD") return { ok: false }
    if (/--from=/.test(body)) return { ok: false } // another build stage, not a host path
    const tokens = body.split(/\s+/).filter((t) => t.length > 0)
    const parts = tokens.filter((t) => !t.startsWith("--"))
    if (parts.length < 2) return { ok: false } // JSON-array form or malformed — cannot model
    for (const s of parts.slice(0, -1)) {
      if (/[*?[\]]/.test(s)) return { ok: false } // glob — enumeration would be partial
      sources.push(s)
    }
  }
  return { ok: true, sources }
}

export type EligibleSet =
  | { ok: true; root: string; files: string[] }
  | { ok: false; reason: "unresolvable" | "no-environment" }

function collectFiles(p: string): string[] {
  const st = statSync(p)
  if (st.isFile()) return [p]
  if (!st.isDirectory()) return []
  const out: string[] = []
  for (const e of [...readdirSync(p, { withFileTypes: true })].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = join(p, e.name)
    if (e.isDirectory()) out.push(...collectFiles(full))
    else if (e.isFile()) out.push(full)
  }
  return out
}

export function eligibleArtifacts(paths: BenchPaths, task: string): EligibleSet {
  const envDir = join(paths.tbRoot, task, "environment")
  let root: string
  try {
    root = realpathSync(envDir)
  } catch {
    return { ok: false, reason: "no-environment" }
  }
  let dockerfileText: string
  try {
    dockerfileText = readFileSync(join(root, "Dockerfile"), "utf-8")
  } catch {
    return { ok: false, reason: "no-environment" }
  }
  const parsed = parseCopyManifest(dockerfileText)
  if (!parsed.ok) return { ok: false, reason: "unresolvable" }

  const files = new Set<string>()
  for (const src of parsed.sources) {
    let cand: string
    try {
      cand = realpathSync(join(root, src))
    } catch {
      return { ok: false, reason: "unresolvable" }
    }
    if (!(cand === root || cand.startsWith(root + sep))) return { ok: false, reason: "unresolvable" }
    for (const f of collectFiles(cand)) {
      if (f !== join(root, "Dockerfile")) files.add(f)
    }
  }
  return { ok: true, root, files: [...files].sort() }
}
```

- [ ] **Step 4: Run the tests, confirm they pass**

Run: `cd opencode-plugin && bun test test/bench-eligibility.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Confirm the whole suite is still green and commit**

```bash
cd opencode-plugin && bun test 2>&1 | tail -5
cd .. && bun scripts/gate-check.ts
git add opencode-plugin/src/bench/eligibility.ts opencode-plugin/test/bench-eligibility.test.ts
git commit -m "$(cat <<'EOF'
feat(lane-a): SUT-visibility eligibility manifest (spec 8.8 ii/v)

Strict Dockerfile COPY/ADD manifest over the pristine task-definition tree.
Eligibility is a positive structural criterion — visible to the SUT inside the
container — so grader-private material is excluded without being enumerated.
Anything the parser cannot fully model (glob, --from=, unknown directive,
escaping source) fails the whole manifest closed: a partial enumeration is a
cherry-picked one, and 8.8(ii) requires checking against every eligible source.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: series-peaks.ts — expose per-anchor scale tracks

The sigma estimator (§8.2 c) needs each surviving peak's matched position at every persistent scale. `detectPeaks` currently discards them. Add a tracked variant and derive the existing function from it, so the two can never diverge.

**Files:**
- Modify: `opencode-plugin/src/bench/series-peaks.ts`
- Test: `opencode-plugin/test/bench-series-peaks.test.ts` (append)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export interface PeakTrack { pos: number; track: number[] }` — `pos` is the index in `ys` at the finest scale; `track` is the matched index at each persistent scale, `track[0] === pos`.
  - `export function detectPeaksTracked(ys: number[]): PeakTrack[]`
  - `export function detectPeaks(ys: number[]): number[]` — unchanged signature and unchanged output, now `detectPeaksTracked(ys).map(t => t.pos)`.

- [ ] **Step 1: Write the failing tests**

Append to `opencode-plugin/test/bench-series-peaks.test.ts`:

```ts
import { detectPeaksTracked } from "../src/bench/series-peaks.ts"
import { readSeriesFile } from "../src/bench/series-source.ts"

test("detectPeaks is exactly detectPeaksTracked's positions (no divergence possible)", () => {
  const ys = Array.from({ length: 400 }, (_, i) =>
    Math.exp(-((i - 80) ** 2) / 50) + 0.8 * Math.exp(-((i - 250) ** 2) / 90) + 0.02 * Math.sin(i))
  expect(detectPeaks(ys)).toEqual(detectPeaksTracked(ys).map((t) => t.pos))
})

test("each track starts at its own position and has one entry per persistent scale", () => {
  const ys = Array.from({ length: 400 }, (_, i) =>
    Math.exp(-((i - 80) ** 2) / 50) + 0.8 * Math.exp(-((i - 250) ** 2) / 90))
  for (const t of detectPeaksTracked(ys)) {
    expect(t.track[0]).toBe(t.pos)
    expect(t.track.length).toBeGreaterThanOrEqual(5) // persistence floor
    expect(t.track.length).toBeLessThanOrEqual(49)   // windows 5..101 step 2
  }
})

test("real graphene fixture: 17 tracked anchors, matching the probe's D3 result", () => {
  const root = "term-bench2/probe-tasks/raman-fitting-audit/environment"
  const { ys } = readSeriesFile(`${root}/task-deps/graphene.dat`, root)
  expect(detectPeaksTracked(ys).length).toBe(17)
})
```

- [ ] **Step 2: Run the tests, confirm they fail**

Run: `cd opencode-plugin && bun test test/bench-series-peaks.test.ts`
Expected: FAIL — `detectPeaksTracked` is not exported.

- [ ] **Step 3: Implement the tracked variant**

Replace the body of `opencode-plugin/src/bench/series-peaks.ts` below its existing header comment with:

```ts
/** The detector's smoothing-window sweep bounds — EXPORTED because other modules
 * derive their own floors from the detector's geometry (series-source's
 * MIN_SERIES_ROWS) and a restated copy is a constant waiting to drift. */
export const MIN_SMOOTH_WINDOW = 5
export const MAX_SMOOTH_WINDOW = 101

export interface PeakTrack {
  /** index into ys at the finest scale */
  pos: number
  /** matched index at each persistent scale; track[0] === pos */
  track: number[]
}

/** Tracked form of the §6.1 divide step. The per-scale matched positions are
 * the ONLY answer-free evidence of an anchor's positional uncertainty, which is
 * what the §8.2(c) sigma estimator consumes; discarding them would force sigma
 * to come from outside the artifact. Parameters are the probe's pre-registered
 * values and are NEVER tuned against an expected peak count or identity. */
export function detectPeaksTracked(ys: number[]): PeakTrack[] {
  const perScale: number[][] = []
  for (let w = MIN_SMOOTH_WINDOW; w <= MAX_SMOOTH_WINDOW; w += 2) {
    const half = (w / 2) | 0
    const sm: number[] = []
    for (let i = 0; i < ys.length; i++) {
      const lo = Math.max(0, i - half)
      const hi = Math.min(ys.length, i + half + 1)
      let s = 0
      for (let j = lo; j < hi; j++) s += ys[j]!
      sm.push(s / (hi - lo))
    }
    const thresh = [...sm].sort((a, b) => a - b)[(0.9 * sm.length) | 0]!
    const peaks: number[] = []
    for (let i = 1; i < sm.length - 1; i++) {
      if (sm[i]! > sm[i - 1]! && sm[i]! >= sm[i + 1]! && sm[i]! > thresh) peaks.push(i)
    }
    perScale.push(peaks)
  }
  const survivors: PeakTrack[] = []
  for (const p of perScale[0]!) {
    let pos = p
    const track = [p]
    for (let s = 1; s < perScale.length; s++) {
      const match = perScale[s]!.find((q) => Math.abs(q - pos) <= 3)
      if (match === undefined) break
      pos = match
      track.push(match)
    }
    if (track.length >= 5) survivors.push({ pos: p, track })
  }
  const merged: PeakTrack[] = []
  for (const t of survivors.sort((a, b) => a.pos - b.pos)) {
    if (merged.length && t.pos - merged[merged.length - 1]!.pos <= 3) continue
    merged.push(t)
  }
  return merged
}

/** Positions only — DERIVED from detectPeaksTracked so the two can never
 * disagree about which peaks survived. */
export function detectPeaks(ys: number[]): number[] {
  return detectPeaksTracked(ys).map((t) => t.pos)
}
```

- [ ] **Step 4: Run the tests, confirm they pass**

Run: `cd opencode-plugin && bun test test/bench-series-peaks.test.ts test/bench-dnc-integration.test.ts`
Expected: PASS. `bench-dnc-integration.test.ts`'s existing "n=17 persistent peaks" assertion must still hold — it is the regression that proves the refactor changed nothing.

- [ ] **Step 5: Commit**

```bash
cd opencode-plugin && bun test 2>&1 | tail -5
cd .. && bun scripts/gate-check.ts
git add opencode-plugin/src/bench/series-peaks.ts opencode-plugin/test/bench-series-peaks.test.ts
git commit -m "$(cat <<'EOF'
feat(lane-a): expose per-anchor scale tracks from the peak detector

detectPeaks is now derived from detectPeaksTracked, so positions and tracks
cannot diverge. The per-scale matched positions are the only answer-free
evidence of positional uncertainty, which the 8.2(c) sigma estimator consumes;
discarding them would force sigma to come from outside the artifact.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: reval-fit.ts — chi² quantile + noise-floor predicate

Port of `derive.py:chi2_q` (lines 17–20) and `derive.py:predicate` (lines 62–69).

**Files:**
- Modify: `opencode-plugin/src/bench/reval-fit.ts` (append; touch nothing existing)
- Test: `opencode-plugin/test/bench-reval-fit.test.ts` (append)

**Interfaces:**
- Consumes: `fitAffine`, `EPS` (already in the file).
- Produces:
  - `export const CHI2_LEVELS: Record<number, number>` — `{0.99: 2.326, 0.999: 3.090, 0.9999: 3.719}` (z-quantiles).
  - `export const REG_LEVEL = 0.999`
  - `export function chi2Quantile(p: number, k: number): number` — Wilson–Hilferty.
  - `export interface PredicateResult { pass: boolean; x2: number }`
  - `export function chiSquarePredicate(us: number[], cs: number[], sigmas: number[], level: number): PredicateResult` — `us` assumed already sorted with `cs`/`sigmas` in the same order (the caller that sorts is `mergeAccept`, Task 6 — see the conflict scan).

- [ ] **Step 1: Write the failing tests**

Append to `opencode-plugin/test/bench-reval-fit.test.ts`:

```ts
import { chi2Quantile, chiSquarePredicate, REG_LEVEL, CHI2_LEVELS } from "../src/bench/reval-fit.ts"

test("chi2Quantile matches the reference Wilson-Hilferty values", () => {
  // computed from derive.py's chi2_q with the same z-quantile table, verified
  // against python3 on 2026-08-21 — do not adjust these to match a failing port
  expect(chi2Quantile(0.999, 3)).toBeCloseTo(16.5489, 3)
  expect(chi2Quantile(0.999, 15)).toBeCloseTo(37.8391, 3)
  expect(chi2Quantile(0.99, 3)).toBeCloseTo(11.367, 3)
})

test("chi2Quantile is monotone in both level and dof", () => {
  expect(chi2Quantile(0.9999, 5)).toBeGreaterThan(chi2Quantile(0.999, 5))
  expect(chi2Quantile(0.999, 6)).toBeGreaterThan(chi2Quantile(0.999, 5))
})

test("REG_LEVEL is a key of the level table (no drift off the validated set)", () => {
  expect(CHI2_LEVELS[REG_LEVEL]).toBeDefined()
  expect(REG_LEVEL).toBe(0.999)
})

test("an exact affine claim passes the predicate with X2 = 0", () => {
  const us = [1.0, 2.3, 2.9, 5.1, 7.8]
  const cs = us.map((u) => 100 + 40 * u)
  const r = chiSquarePredicate(us, cs, us.map(() => 1), REG_LEVEL)
  expect(r.pass).toBe(true)
  expect(r.x2).toBeCloseTo(0, 9)
})

test("residuals far above sigma fail the predicate", () => {
  const us = [1.0, 2.3, 2.9, 5.1, 7.8]
  const truth = us.map((u) => 100 + 40 * u)
  const shifted = [...truth.slice(1), truth[4]! + 40]
  expect(chiSquarePredicate(us, shifted, us.map(() => 1), REG_LEVEL).pass).toBe(false)
})

test("the SAME residuals pass once sigma is large enough — the predicate is noise-relative", () => {
  const us = [1.0, 2.3, 2.9, 5.1, 7.8]
  const truth = us.map((u) => 100 + 40 * u)
  const shifted = [...truth.slice(1), truth[4]! + 40]
  expect(chiSquarePredicate(us, shifted, us.map(() => 1e6), REG_LEVEL).pass).toBe(true)
})

test("n < 3 fails closed (no dof for a 2-parameter fit)", () => {
  const r = chiSquarePredicate([1, 2], [3, 5], [1, 1], REG_LEVEL)
  expect(r.pass).toBe(false)
  expect(r.x2).toBe(Infinity)
})

test("a zero sigma is floored at EPS and never divides by zero", () => {
  const us = [1, 2.3, 5]
  const cs = us.map((u) => 3 + 2 * u)
  expect(Number.isFinite(chiSquarePredicate(us, cs, [0, 0, 0], REG_LEVEL).x2)).toBe(true)
})
```

- [ ] **Step 2: Run the tests, confirm they fail**

Run: `cd opencode-plugin && bun test test/bench-reval-fit.test.ts`
Expected: FAIL — `chi2Quantile` is not exported.

- [ ] **Step 3: Implement — append to `reval-fit.ts`**

```ts
/** z-quantiles for the Wilson–Hilferty chi-square approximation. Three levels
 * were swept in the §8.2 derivation and LEVEL was measured NON-LOAD-BEARING —
 * V1..V6 are identical across all three (derive.py sensitivity lines). The
 * table exists to make that sweep re-runnable, not to offer a knob. */
export const CHI2_LEVELS: Record<number, number> = { 0.99: 2.326, 0.999: 3.090, 0.9999: 3.719 }

/** The registered level (§8.2). Named so no reader mistakes it for a tuned
 * constant: moving it does not move the verdicts, which is exactly why it is
 * safe to fix and exactly why fixing it is not fitting. */
export const REG_LEVEL = 0.999

/** Wilson–Hilferty approximation of the chi-square quantile — deterministic,
 * closed form, no tables and no dependency. */
export function chi2Quantile(p: number, k: number): number {
  const z = CHI2_LEVELS[p]
  if (z === undefined) throw new RangeError(`chi2Quantile: unregistered level ${p}`)
  return k * (1 - 2 / (9 * k) + z * Math.sqrt(2 / (9 * k))) ** 3
}

export interface PredicateResult { pass: boolean; x2: number }

/** §8.2 noise-floor predicate: X² = Σ(r_i / sigma_i)² against chi2(level, n−2).
 * ONE predicate does both jobs — the claim must pass it and every alternate
 * pairing must fail it (see mergeAccept) — which is what let it replace the R
 * ratio, its placeholder, and delta_fit together.
 *
 * `sigma` is the artifact's OWN derived noise (noise-sigma.ts), never a
 * claimant- or model-supplied tolerance: a tolerance the audited party chooses
 * is two of the three degrees of freedom the old revalidator handed away.
 *
 * PRECONDITION: us/cs/sigmas are already in a common sort order. mergeAccept
 * owns that sort (conflict scan); calling this directly with us sorted and
 * sigmas unsorted attaches each anchor's noise to the wrong anchor. */
export function chiSquarePredicate(us: number[], cs: number[], sigmas: number[], level: number): PredicateResult {
  const n = us.length
  if (n < 3 || cs.length !== n || sigmas.length !== n) return { pass: false, x2: Infinity }
  const { a, b } = fitAffine(us, cs)
  let x2 = 0
  for (let i = 0; i < n; i++) {
    const r = a + b * us[i]! - cs[i]!
    x2 += (r / Math.max(sigmas[i]!, EPS)) ** 2
  }
  return { pass: x2 <= chi2Quantile(level, n - 2), x2 }
}
```

- [ ] **Step 4: Run the tests, confirm they pass**

Run: `cd opencode-plugin && bun test test/bench-reval-fit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd opencode-plugin && bun test 2>&1 | tail -5
cd .. && bun scripts/gate-check.ts
git add opencode-plugin/src/bench/reval-fit.ts opencode-plugin/test/bench-reval-fit.test.ts
git commit -m "$(cat <<'EOF'
feat(lane-a): chi-square noise-floor predicate (spec 8.2)

Port of derive.py's chi2_q + predicate. One predicate serves both jobs — the
claim must pass, every alternate pairing must fail — which is what let it
replace the R ratio, the R=3 placeholder, and delta_fit together. Sigma is the
artifact's own derived noise, never a claimant-supplied tolerance.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: numeric-literal.ts — the literal-free checker and its adversarial input

Spec §8.8 (iv). A non-CROSSCHECKED card must be **numeric-literal-free by construction**, mechanically checked before injection against the claim's own numeric fields. The spec is explicit that a digit-run regex is "the same in-costume smuggling one encoding over" — spelled-out numerals, evaluating expressions, and unit-relocated forms must all be caught. **The adversarial card is built in this task, alongside the checker, not after it** (project method rule: to test whether a check can fail, build the input that should break it).

**Files:**
- Create: `opencode-plugin/src/bench/numeric-literal.ts`
- Create: `opencode-plugin/test/fixtures/evasion-cards.json`
- Test: `opencode-plugin/test/bench-numeric-literal.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export interface LiteralHit { encoding: "digits" | "words" | "expression" | "scaled"; text: string; value: number }`
  - `export function findAnyNumbers(card: string): LiteralHit[]` — **the primary entry point**, used by the ladder. Decodes every number the card states, in any encoding. Takes no target list, so no caller can shrink the checked set (F1).
  - `export function findValueMentions(card: string, values: number[]): LiteralHit[]` — targeted form, retained because it is how the evasion fixture tests that a decoder resolves to the *right value*, not merely that it fired.
  - `export function isLiteralFree(card: string, values: number[]): boolean`

**Decimal relocation is computed, not enumerated.** An earlier draft carried `SCALE_FACTORS = [1e-6 … 1e6]` — a hand-picked list whose omissions fail open. Replaced by mantissa comparison: normalize both numbers to `[1,10)` and require the base-10 exponent difference to be an integer. That covers every decimal relocation with no list to forget.

**Standing caveat on this task's bad set (S5, unfixable by editing).** `evasion-cards.json` and the decoders share an author and a sitting, so the fixture cannot falsify the checker — both encode one person's list of encodings. This is the shared-prior argument that got L-B demoted, applied to us. The real bad set needs **generator diversity**: a different generator producing smuggling attempts against a checker it can see. That is spend, so it is a named follow-on with its own go, and the manifest must not claim coverage this fixture does not establish.

- [ ] **Step 1: Write the adversarial fixture FIRST**

Create `opencode-plugin/test/fixtures/evasion-cards.json`. Each entry is a card that *states* the value 1580.6 without writing `1580.6`. This is the bad set; the checker is built to catch it, and any future encoding gets appended here rather than being handled by a new special case in the checker.

```json
{
  "target": 1580.6,
  "mustCatch": [
    { "why": "plain digits", "card": "The conversion lands at 1580.6 inverse centimetres." },
    { "why": "comma decimal", "card": "The conversion lands at 1580,6 inverse centimetres." },
    { "why": "thousands separator", "card": "The conversion lands at 1,580.6 inverse centimetres." },
    { "why": "spelled-out integer part", "card": "The peak sits near one thousand five hundred eighty point six." },
    { "why": "scientific notation", "card": "The peak sits at 1.5806e3 in the converted axis." },
    { "why": "unit-relocated (nm-scale)", "card": "Expressed in the other unit convention it is 0.15806e4." },
    { "why": "evaluating expression", "card": "The value is 1e7/6327.285 in the converted axis." },
    { "why": "evaluating expression, product form", "card": "The value is 790.3*2 in the converted axis." },
    { "why": "tolerance dressing", "card": "The value is 1580.6 +/- 0 in the converted axis." },
    { "why": "digit words separated by hyphens", "card": "It is fifteen-hundred-eighty point six." }
  ],
  "mustNotCatch": [
    { "why": "unrelated number", "card": "Column 1 holds the raw axis; there are 2 columns." },
    { "why": "genuinely criteria-class prose", "card": "The first column is not in the unit the task's acceptance criteria name; convert it before reporting, and state which convention you used." },
    { "why": "an order of magnitude away", "card": "The axis spans roughly 158 units." },
    { "why": "a different peak entirely", "card": "A second feature appears near 2700 in the converted axis." }
  ]
}
```

- [ ] **Step 2: Write the failing tests**

Create `opencode-plugin/test/bench-numeric-literal.test.ts`:

```ts
import { test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { findValueMentions, isLiteralFree, findAnyNumbers } from "../src/bench/numeric-literal.ts"

const FIX = JSON.parse(readFileSync("test/fixtures/evasion-cards.json", "utf-8"))

test("every adversarial evasion encoding is caught", () => {
  const missed = FIX.mustCatch.filter((c: any) => isLiteralFree(c.card, [FIX.target]))
  expect(missed.map((c: any) => c.why)).toEqual([])
})

test("cards that do not state the value are NOT flagged", () => {
  const falsePos = FIX.mustNotCatch.filter((c: any) => !isLiteralFree(c.card, [FIX.target]))
  expect(falsePos.map((c: any) => c.why)).toEqual([])
})

test("a digit-run regex alone would have missed the word and expression forms", () => {
  // the spec's own warning, kept as an executable claim rather than a comment
  const digitsOnly = (s: string) => /\d/.test(s)
  const wordCard = FIX.mustCatch.find((c: any) => c.why === "spelled-out integer part").card
  expect(digitsOnly(wordCard)).toBe(false)          // a digit regex sees nothing
  expect(isLiteralFree(wordCard, [FIX.target])).toBe(false) // the checker does
})

test("hits report which encoding matched", () => {
  const hits = findValueMentions("The value is 1e7/6327.285 here.", [1580.6])
  expect(hits.length).toBeGreaterThan(0)
  expect(hits[0]!.encoding).toBe("expression")
})

test("multiple claim values are all checked", () => {
  expect(isLiteralFree("Peaks at 1580.6 and 2700.", [42])).toBe(true)
  expect(isLiteralFree("Peaks at 1580.6 and 2700.", [42, 2700])).toBe(false)
})

// --- findAnyNumbers: the untargeted primitive the ladder uses ---------------

test("findAnyNumbers needs no target list and catches every encoding", () => {
  expect(findAnyNumbers("plain 1580.6").length).toBeGreaterThan(0)
  expect(findAnyNumbers("one thousand five hundred eighty point six").length).toBeGreaterThan(0)
  expect(findAnyNumbers("1e7/6327.285").length).toBeGreaterThan(0)
  expect(findAnyNumbers("Convert before reporting; state your convention.")).toEqual([])
})

test("findAnyNumbers takes exactly one argument — no set for a caller to shrink", () => {
  // F1 structural guard: the bypass was a claimant-emptied target list
  expect(findAnyNumbers.length).toBe(1)
})

test("decimal relocation is computed from the mantissa, not matched to a scale list", () => {
  // every one of these is 1580.6 relocated; none needs an entry anywhere
  for (const s of ["1.5806e3", "0.15806e4", "15806000e-4", "1.5806e-9"]) {
    expect(isLiteralFree(`value ${s}`, [1580.6])).toBe(false)
  }
  // a different mantissa is NOT a relocation
  expect(isLiteralFree("value 1.5807e3", [1580.6])).toBe(true)
})

test("a NON-empty value list is still required for the targeted form to fire", () => {
  // the targeted form is a decoder test, not a gate — the gate is findAnyNumbers.
  // This asserts the OLD vacuous behavior is confined to the non-gating path.
  expect(isLiteralFree("anything at all, 1580.6", [])).toBe(true)
  expect(findAnyNumbers("anything at all, 1580.6").length).toBeGreaterThan(0)
})
```

- [ ] **Step 3: Run the tests, confirm they fail**

Run: `cd opencode-plugin && bun test test/bench-numeric-literal.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `numeric-literal.ts`**

```ts
/** §8.8 (iv): a non-CROSSCHECKED card must be NUMERIC-LITERAL-FREE BY
 * CONSTRUCTION w.r.t. the claim's own numeric fields. A prose card that smuggles
 * the number is a numeric injection wearing the criteria-class label.
 *
 * The design constraint the spec states outright: a digit-run regex is the same
 * smuggling one encoding over. So the checker EXTRACTS CANDIDATE VALUES from the
 * card by every encoding it can decode, then compares those values numerically
 * to the claim's values. Adding an encoding means adding a decoder, never adding
 * a value to a list — the bad set (test/fixtures/evasion-cards.json) is what
 * proves a decoder earns its place.
 *
 * Scope, stated: this rejects the encodings a model actually emits. It is not a
 * general steganography detector and does not pretend to be — a determined
 * channel (first letters of each sentence) is out of reach and out of scope.
 * What it closes is the accidental and the lightly-dressed case. */

export interface LiteralHit {
  encoding: "digits" | "words" | "expression" | "scaled"
  text: string
  value: number
}

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
}
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
}
const SCALES: Record<string, number> = { hundred: 100, thousand: 1000, million: 1e6, billion: 1e9 }

/** Decode runs of English number words, including "fifteen-hundred-eighty" and
 * a trailing "point six" fractional tail. */
function decodeWordNumbers(text: string): { text: string; value: number }[] {
  const tokens = text.toLowerCase().split(/([a-z]+)/).filter((t) => t.length > 0)
  const out: { text: string; value: number }[] = []
  let i = 0
  while (i < tokens.length) {
    if (!isWordy(tokens[i]!)) { i++; continue }
    let total = 0
    let current = 0
    let seen = false
    let j = i
    const parts: string[] = []
    while (j < tokens.length) {
      const t = tokens[j]!
      if (!/^[a-z]+$/.test(t)) {
        if (/^[\s-]+$/.test(t)) { parts.push(t); j++; continue }
        break
      }
      if (t === "and" && seen) { parts.push(t); j++; continue }
      if (UNITS[t] !== undefined) { current += UNITS[t]!; seen = true }
      else if (TENS[t] !== undefined) { current += TENS[t]!; seen = true }
      else if (SCALES[t] !== undefined) {
        const s = SCALES[t]!
        if (s === 100) current = (current || 1) * 100
        else { total += (current || 1) * s; current = 0 }
        seen = true
      } else break
      parts.push(t)
      j++
    }
    if (!seen) { i++; continue }
    let value = total + current
    // optional "point <digits-as-words>" fractional tail
    const rest = tokens.slice(j).join("")
    const pm = /^[\s-]*point((?:[\s-]+[a-z]+)+)/.exec(rest)
    if (pm) {
      const digits = pm[1]!.trim().split(/[\s-]+/).map((w) => UNITS[w])
      if (digits.every((d) => d !== undefined && d < 10)) {
        value += Number(`0.${digits.join("")}`)
        parts.push(pm[0]!)
      }
    }
    out.push({ text: parts.join("").trim(), value })
    i = j
  }
  return out
}

function isWordy(t: string): boolean {
  return UNITS[t] !== undefined || TENS[t] !== undefined || SCALES[t] !== undefined
}

/** Plain numerals: digit groups with optional thousands separators, decimal dot
 * OR decimal comma, and optional exponent. */
function decodeNumerals(text: string): { text: string; value: number }[] {
  const out: { text: string; value: number }[] = []
  for (const m of text.matchAll(/-?\d[\d,]*(?:\.\d+)?(?:[eE][-+]?\d+)?/g)) {
    const raw = m[0]!
    // "1,580.6" -> thousands separators; "1580,6" -> decimal comma
    const norm = /,\d{3}(?:\D|$)/.test(raw + " ") || /\d,\d{3}/.test(raw)
      ? raw.replace(/,/g, "")
      : raw.replace(/,(\d+)$/, ".$1")
    const v = Number(norm)
    if (Number.isFinite(v)) out.push({ text: raw, value: v })
  }
  return out
}

/** Two-operand arithmetic between numerals — the "1e7/6327.285" and "790.3*2"
 * forms. Deliberately not a general evaluator: no eval, no precedence, no
 * parentheses. A model that needs three operations to hide a number has left
 * the encoding class this checker claims. */
function decodeExpressions(text: string): { text: string; value: number }[] {
  const out: { text: string; value: number }[] = []
  const num = String.raw`-?\d[\d,]*(?:\.\d+)?(?:[eE][-+]?\d+)?`
  for (const m of text.matchAll(new RegExp(`(${num})\\s*([*/+\\-])\\s*(${num})`, "g"))) {
    const l = Number(m[1]!.replace(/,/g, ""))
    const r = Number(m[3]!.replace(/,/g, ""))
    if (!Number.isFinite(l) || !Number.isFinite(r)) continue
    let v: number
    switch (m[2]) {
      case "*": v = l * r; break
      case "/": v = r === 0 ? NaN : l / r; break
      case "+": v = l + r; break
      default: v = l - r
    }
    if (Number.isFinite(v)) out.push({ text: m[0]!, value: v })
  }
  return out
}

const REL_TOL = 1e-3

/** Is `got` the same number as `want`, up to a relative tolerance? */
function near(got: number, want: number, relTol: number): boolean {
  if (!Number.isFinite(got) || !Number.isFinite(want)) return false
  const scale = Math.max(Math.abs(want), 1e-12)
  return Math.abs(got - want) / scale <= relTol
}

/** Same number up to a DECIMAL RELOCATION — "1580.6", "1.5806e3" and "0.15806e4"
 * are one value wearing three costumes. Computed from the mantissa rather than
 * matched against a list of scale factors: a list's omissions fail open, and
 * there is no principled place to stop enumerating. */
function sameMantissa(got: number, want: number, relTol: number): boolean {
  if (!Number.isFinite(got) || !Number.isFinite(want)) return false
  if (got === 0 || want === 0) return got === want
  const exp = Math.log10(Math.abs(got)) - Math.log10(Math.abs(want))
  const k = Math.round(exp)
  if (Math.abs(exp - k) > 1e-9) return false
  return near(got / 10 ** k, want, relTol) && Math.sign(got) === Math.sign(want)
}

/** Every number the card states, in every encoding this module can decode.
 * NO TARGET LIST — that is the point (F1). §8.8(iv)'s enforcement previously
 * quantified over the claim's own numeric fields, so a claimant answering
 * `FAMILY: none` emptied the set and walked the value through in prose while
 * every decoder was asked to look for nothing. "Every number" is a set nobody
 * supplies and therefore nobody can shrink. */
export function findAnyNumbers(card: string): LiteralHit[] {
  return [
    ...decodeNumerals(card).map((d) => ({ encoding: "digits" as const, ...d })),
    ...decodeWordNumbers(card).map((d) => ({ encoding: "words" as const, ...d })),
    ...decodeExpressions(card).map((d) => ({ encoding: "expression" as const, ...d })),
  ]
}

/** Targeted form: does the card state one of THESE values? Retained because it
 * is how the evasion fixture proves a decoder resolves to the right VALUE, not
 * merely that it fired. The ladder uses findAnyNumbers, never this. */
export function findValueMentions(card: string, values: number[]): LiteralHit[] {
  if (values.length === 0) return []
  const hits: LiteralHit[] = []
  for (const d of findAnyNumbers(card)) {
    for (const want of values) {
      if (near(d.value, want, REL_TOL)) { hits.push(d); break }
      if (sameMantissa(d.value, want, REL_TOL)) { hits.push({ ...d, encoding: "scaled" }); break }
    }
  }
  return hits
}

export function isLiteralFree(card: string, values: number[]): boolean {
  return findValueMentions(card, values).length === 0
}
```

- [ ] **Step 5: Run the tests; iterate on the DECODERS until green**

Run: `cd opencode-plugin && bun test test/bench-numeric-literal.test.ts`
Expected: PASS, 6 tests.

If a `mustCatch` entry escapes, fix the decoder that should have decoded it. **Never** fix it by adding the specific string to a list — that is the incident registry the spec names. If a `mustNotCatch` entry trips, the tolerance or the scale-factor set is too loose; tighten the decoder, do not exempt the string.

- [ ] **Step 6: Commit**

```bash
cd opencode-plugin && bun test 2>&1 | tail -5
cd .. && bun scripts/gate-check.ts
git add opencode-plugin/src/bench/numeric-literal.ts opencode-plugin/test/bench-numeric-literal.test.ts opencode-plugin/test/fixtures/evasion-cards.json
git commit -m "$(cat <<'EOF'
feat(lane-a): numeric-literal checker with its adversarial bad set (spec 8.8 iv)

Decodes candidate values out of the card by every encoding it can read — digits,
comma decimals, thousands separators, English number words, two-operand
expressions, decimal-scale relocations — then compares numerically. A digit-run
regex would miss the word and expression forms; a test asserts exactly that.
The evasion fixture is the bad set and ships with the checker, not after it.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: noise-sigma.ts — the artifact's own noise estimator

Spec §8.2 (c). Port of `derive.py:series_sigmas` (lines 150–166). **This estimator is the predicate's single external input** and carries the second-fixture caveat's weight — it enters the transfer register in its own right.

**Two things the implementer must not "improve":**
1. `derive.py` computes `sigma_y` (MAD of smoothing residuals) and **does not feed it to the predicate** — only the per-anchor position spread `sigma_u` reaches `chiSquarePredicate` (via `sigma_c = |b| * sigma_u`). Port that exactly. `sigmaY` is returned for the audit trail and for the transfer register, and wiring it into the predicate would be an unvalidated change to a mechanism validated 11/11.
2. The validated-domain ratio is computed in **u-space** (`max sigma_u / span(u)`), not against the claim's canonical span. Under the affine fit the two are algebraically equal (`sigma_c/span(c) = |b|sigma_u/(|b|span(u))`), so this is faithful to the measured domain — and u-space is the form that is **claim-free**, so the claimant cannot move the domain boundary by choosing values. Task 9 tests exactly that.

**Files:**
- Create: `opencode-plugin/src/bench/noise-sigma.ts`
- Test: `opencode-plugin/test/bench-noise-sigma.test.ts`

**Interfaces:**
- Consumes: `PeakTrack` from `./series-peaks.ts` (Task 2).
- Produces:
  - `export const VALIDATED_SIGMA_FRACTION = 0.01`
  - `export interface SeriesNoise { us: number[]; sigmaU: number[]; sigmaY: number }`
  - `export function deriveSeriesNoise(xs: number[], ys: number[], tracks: PeakTrack[], u: (x: number) => number): SeriesNoise`
  - `export function sigmaFraction(us: number[], sigmaU: number[]): number` — `max(sigmaU) / (max(us) - min(us))`; `Infinity` when the span is 0.

- [ ] **Step 1: Write the failing tests**

Create `opencode-plugin/test/bench-noise-sigma.test.ts`:

```ts
import { test, expect } from "bun:test"
import { deriveSeriesNoise, sigmaFraction, VALIDATED_SIGMA_FRACTION } from "../src/bench/noise-sigma.ts"
import { detectPeaksTracked } from "../src/bench/series-peaks.ts"
import { readSeriesFile } from "../src/bench/series-source.ts"

const GRAPHENE_ROOT = "term-bench2/probe-tasks/raman-fitting-audit/environment"

test("graphene fixture: reproduces derive.py's n=17 anchors and sigma_y", () => {
  const { xs, ys } = readSeriesFile(`${GRAPHENE_ROOT}/task-deps/graphene.dat`, GRAPHENE_ROOT)
  const noise = deriveSeriesNoise(xs, ys, detectPeaksTracked(ys), (x) => x)
  expect(noise.us.length).toBe(17)
  expect(noise.sigmaY).toBeCloseTo(104.1, 0) // derive.py V11: sigma_y=104.1
})

test("second fixture: reproduces derive.py's n=6 anchors and sigma_y", () => {
  const root = "docs/loop-probes/dnc-second-fixture-20260820"
  const { xs, ys } = readSeriesFile(`${root}/fixture.dat`, root)
  const noise = deriveSeriesNoise(xs, ys, detectPeaksTracked(ys), (x) => x)
  expect(noise.us.length).toBe(6)
  expect(noise.sigmaY).toBeCloseTo(25.2, 0) // derive.py V8: sigma_y=25.2
})

test("every sigmaU is strictly positive (a zero would make the predicate vacuous)", () => {
  const { xs, ys } = readSeriesFile(`${GRAPHENE_ROOT}/task-deps/graphene.dat`, GRAPHENE_ROOT)
  const noise = deriveSeriesNoise(xs, ys, detectPeaksTracked(ys), (x) => x)
  expect(noise.sigmaU.every((s) => s > 0)).toBe(true)
})

test("the 1/x family member transforms both the anchors and their sigma", () => {
  const { xs, ys } = readSeriesFile(`${GRAPHENE_ROOT}/task-deps/graphene.dat`, GRAPHENE_ROOT)
  const inv = deriveSeriesNoise(xs, ys, detectPeaksTracked(ys), (x) => 1 / x)
  const plain = deriveSeriesNoise(xs, ys, detectPeaksTracked(ys), (x) => x)
  expect(inv.us.every((u, i) => Math.abs(u - 1 / plain.us[i]!) < 1e-12)).toBe(true)
  // 1/x compresses a large-x axis, so its per-anchor sigma must shrink with it
  expect(Math.max(...inv.sigmaU)).toBeLessThan(Math.max(...plain.sigmaU))
})

test("sigmaFraction is claim-free: it reads only anchors and their sigma", () => {
  expect(sigmaFraction([0, 10], [0.05, 0.05])).toBeCloseTo(0.005, 9)
  expect(sigmaFraction([5, 5], [1, 1])).toBe(Infinity) // zero span
})

test("the validated domain bound is the measured one", () => {
  expect(VALIDATED_SIGMA_FRACTION).toBe(0.01)
})
```

- [ ] **Step 2: Run the tests, confirm they fail**

Run: `cd opencode-plugin && bun test test/bench-noise-sigma.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `noise-sigma.ts`**

```ts
/** §8.2(c) sigma estimator — the predicate's SINGLE external input, and
 * therefore the piece that carries the second-fixture caveat's weight: the next
 * fixture class (heteroscedastic / peak-correlated noise) tests THIS, not just
 * the predicate. Port of derive.py:series_sigmas, validated 11/11.
 *
 * Everything here comes from the artifact: the noise scale from the series'
 * own smoothing residuals, each anchor's positional uncertainty from how far
 * that peak wandered across the persistent scales. Nothing is supplied by the
 * claimant, which is the whole point — a tolerance the audited party chooses
 * cannot audit them. */
import type { PeakTrack } from "./series-peaks.ts"

/** §8.2(b): the predicate is exact through this noise level and is NOT
 * extrapolated past it. Past the domain the measured failure is FALSE REJECT
 * (V7: 2% -> 10/200 honest rejects, 5% -> 182/200; shifted false-accepts 0/200
 * at every level), so refusing to rule outside the domain is the conservative
 * direction, not a hole. */
export const VALIDATED_SIGMA_FRACTION = 0.01

export interface SeriesNoise {
  /** anchor positions in u-space, in detection order */
  us: number[]
  /** per-anchor positional uncertainty in u-space */
  sigmaU: number[]
  /** MAD-scaled noise of the series' own smoothing residuals. Reported for the
   * audit trail and the transfer register; NOT an input to the predicate —
   * derive.py's validated path feeds only sigmaU through. Wiring it in would be
   * an unvalidated change to a mechanism validated 11/11. */
  sigmaY: number
}

function smooth(ys: number[], w: number): number[] {
  const half = (w / 2) | 0
  const out: number[] = []
  for (let i = 0; i < ys.length; i++) {
    const lo = Math.max(0, i - half)
    const hi = Math.min(ys.length, i + half + 1)
    let s = 0
    for (let j = lo; j < hi; j++) s += ys[j]!
    out.push(s / (hi - lo))
  }
  return out
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

function pstdev(v: number[]): number {
  const m = v.reduce((s, x) => s + x, 0) / v.length
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length)
}

export function deriveSeriesNoise(
  xs: number[], ys: number[], tracks: PeakTrack[], u: (x: number) => number,
): SeriesNoise {
  const sm = smooth(ys, 5)
  const resid = ys.map((y, i) => y - sm[i]!)
  const med = median(resid)
  const sigmaY = 1.4826 * median(resid.map((r) => Math.abs(r - med)))
  const step = Math.abs(xs[1]! - xs[0]!)
  const us: number[] = []
  const sigmaU: number[] = []
  for (const t of tracks) {
    const x = xs[t.pos]!
    us.push(u(x))
    // positional spread across the persistent scales, in x units, carried into
    // u units through the family member's own transform (local derivative)
    const px = t.track.map((i) => xs[i]!)
    const sx = px.length > 1 ? pstdev(px) : step
    const du = Math.abs(u(x + Math.max(sx, step)) - u(x))
    sigmaU.push(Math.max(du, 1e-9))
  }
  return { us, sigmaU, sigmaY }
}

/** Noise-to-span ratio, computed entirely from the ARTIFACT (anchors + their
 * derived sigma). Deliberately NOT sigma_c/span(claimed canonicals): under the
 * affine fit the two are algebraically equal, so this is faithful to the
 * measured domain, but only this form denies the claimant any influence over
 * where the validated-domain boundary sits. */
export function sigmaFraction(us: number[], sigmaU: number[]): number {
  const span = Math.max(...us) - Math.min(...us)
  if (!(span > 0)) return Infinity
  return Math.max(...sigmaU) / span
}
```

- [ ] **Step 4: Run the tests, confirm they pass**

Run: `cd opencode-plugin && bun test test/bench-noise-sigma.test.ts`
Expected: PASS, 6 tests. If `sigmaY` misses, print it against `python3 -B docs/loop-probes/derived-thresholds-20260821/derive.py` and diff the smoothing window (must be 5) and the MAD constant (1.4826) before touching anything else.

- [ ] **Step 5: Commit**

```bash
cd opencode-plugin && bun test 2>&1 | tail -5
cd .. && bun scripts/gate-check.ts
git add opencode-plugin/src/bench/noise-sigma.ts opencode-plugin/test/bench-noise-sigma.test.ts
git commit -m "$(cat <<'EOF'
feat(lane-a): artifact-derived noise estimator (spec 8.2 c)

Port of derive.py:series_sigmas, reproducing sigma_y on both real fixtures.
Per-anchor sigma comes from how far each peak wandered across the persistent
scales; nothing is claimant-supplied. sigmaFraction is computed in u-space so
the claimant cannot move the validated-domain boundary by choosing values.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: reval-fit.ts — mergeAccept replaces the R-ratio conditioning check

Port of `derive.py:merge_accept` (lines 72–93). The chi² predicate does both jobs, so `R_THRESHOLD_PLACEHOLDER` and `conditioningCheck`'s R ratio are **deleted**, not deprecated — the spec says the derived predicate *replaces* them, and a dead placeholder is a constant waiting to be re-tuned.

`enumerateAutomorphisms` stays exactly as it is: it is the DERIVED component of §6.4 and this task does not touch it.

**Files:**
- Modify: `opencode-plugin/src/bench/reval-fit.ts`
- Modify: `opencode-plugin/test/bench-reval-fit.test.ts` (migrate the floor tests)

**Interfaces:**
- Consumes: `fitAffine`, `enumerateAutomorphisms`, `chiSquarePredicate`, `REG_LEVEL` (same file).
- Produces:
  - `export type MergeAcceptVerdict = "accept" | "reject-residual" | "reject-degenerate"`
  - `export interface MergeAcceptResult { verdict: MergeAcceptVerdict; x2: number }`
  - `export function mergeAccept(us: number[], cs: number[], sigmas: number[], level?: number): MergeAcceptResult` — **owns the sort**: sorts `us`, `cs`, `sigmas` together by `us` before doing anything (conflict scan row 2). `level` defaults to `REG_LEVEL`.
- Removes: `R_THRESHOLD_PLACEHOLDER`, `conditioningCheck`, `ConditioningResult`. `mergeCheck` keeps working (it is the delta-based §6 form and remains the library's coverage/degeneracy path) but **loses its `conditioningCheck` call** — replace that call with `mergeAccept` on unit sigmas so `mergeCheck` and `mergeAccept` cannot disagree about geometry.

- [ ] **Step 1: Migrate the floor tests, then add the new ones**

In `opencode-plugin/test/bench-reval-fit.test.ts`: change the import line

```ts
import { enumerateAutomorphisms, conditioningCheck, R_THRESHOLD_PLACEHOLDER } from "../src/bench/reval-fit.ts"
```

to

```ts
import { enumerateAutomorphisms, mergeAccept } from "../src/bench/reval-fit.ts"
```

Rewrite the two floor tests (currently at lines 63 and 82) and add the sort-ownership test:

```ts
test("T1 floor: identity shift on equal-spaced constellation is REJECTED", () => {
  const us = [1, 2, 3, 4, 5]
  const truth = us.map((u) => 100 + 40 * u)
  const shifted = [...truth.slice(1), truth[4]! + 40]
  // rms = 0 under the affine family (the intercept absorbs the shift), so only
  // the alternate-pairing half of the predicate can catch it
  expect(mergeAccept(us, shifted, us.map(() => 1e-9)).verdict).toBe("reject-degenerate")
})

test("T10 floor: reversal on SYMMETRIC irregular constellation is REJECTED (derived mirror alternate)", () => {
  const us = [1, 2, 6, 10, 11]
  const truth = us.map((u) => 100 + 40 * u)
  expect(mergeAccept(us, [...truth].reverse(), us.map(() => 1e-9)).verdict).toBe("reject-degenerate")
})

test("mergeAccept OWNS the sort: unsorted input gives the same verdict as sorted", () => {
  // the conflict-scan hazard — a caller sorting us but not sigmas attaches each
  // anchor's noise to the wrong anchor and the predicate goes silently wrong
  const us = [7.8, 1.0, 5.1, 2.9, 2.3]
  const cs = us.map((u) => 100 + 40 * u)
  const sig = [9, 1, 5, 3, 2].map((s) => s * 1e-3)
  const unsorted = mergeAccept(us, cs, sig)
  const order = us.map((_, i) => i).sort((i, j) => us[i]! - us[j]!)
  const sorted = mergeAccept(order.map((i) => us[i]!), order.map((i) => cs[i]!), order.map((i) => sig[i]!))
  expect(unsorted.verdict).toBe(sorted.verdict)
  expect(unsorted.x2).toBeCloseTo(sorted.x2, 12)
})

test("an honest claim on asymmetric geometry is ACCEPTED (no automorphisms to trip on)", () => {
  const us = [1.0, 2.3, 2.9, 5.1, 7.8]
  const cs = us.map((u) => 100 + 40 * u)
  expect(mergeAccept(us, cs, us.map(() => 1e-9)).verdict).toBe("accept")
})

test("a bad-fit claim reports reject-residual, never reject-degenerate", () => {
  const us = [1.0, 2.3, 2.9, 5.1, 7.8]
  const truth = us.map((u) => 100 + 40 * u)
  const shifted = [...truth.slice(1), truth[4]! + 40]
  expect(mergeAccept(us, shifted, us.map(() => 1e-9)).verdict).toBe("reject-residual")
})
```

- [ ] **Step 2: Run the tests, confirm they fail**

Run: `cd opencode-plugin && bun test test/bench-reval-fit.test.ts`
Expected: FAIL — `mergeAccept` is not exported.

- [ ] **Step 3: Implement `mergeAccept`; delete the placeholder**

In `opencode-plugin/src/bench/reval-fit.ts`: delete `R_THRESHOLD_PLACEHOLDER`, `ConditioningResult`, and `conditioningCheck` entirely. Add:

```ts
export type MergeAcceptVerdict = "accept" | "reject-residual" | "reject-degenerate"
export interface MergeAcceptResult { verdict: MergeAcceptVerdict; x2: number }

/** §8.2 acceptance: ONE predicate, both jobs. The claim must pass the
 * noise-floor predicate, and EVERY alternate pairing must fail it.
 *
 * The "every alternate" quantifier is BOUND (§8.2 a) to two components with
 * distinct jobs and neither grows by incident:
 *   (1) the DERIVED automorphisms of the constellation — the symmetry defence.
 *       Correctly EMPTY on asymmetric geometry: a wrong pairing can only fit
 *       well by composing with a symmetry, so no symmetry means no attack
 *       surface in that class.
 *   (2) the FIXED +/-1 index shift — the minimal-misassignment
 *       distinguishability reference, fixed before any attack existed.
 * Binding it to a FIXED ATTACK LIST instead would inherit the incident-registry
 * hole through the quantifier, where no T-matrix could show it.
 *
 * OWNS THE SORT: us, cs and sigmas are reordered together by us before any
 * arithmetic, so a caller can never attach one anchor's noise to another. */
export function mergeAccept(
  us: number[], cs: number[], sigmas: number[], level: number = REG_LEVEL,
): MergeAcceptResult {
  const n = us.length
  if (n < 3 || cs.length !== n || sigmas.length !== n) return { verdict: "reject-residual", x2: Infinity }
  const order = us.map((_, i) => i).sort((i, j) => us[i]! - us[j]!)
  const su = order.map((i) => us[i]!)
  const sc = order.map((i) => cs[i]!)
  const ss = order.map((i) => sigmas[i]!)

  const claim = chiSquarePredicate(su, sc, ss, level)
  if (!claim.pass) return { verdict: "reject-residual", x2: claim.x2 }

  if (n - 1 >= 3) {
    const up = chiSquarePredicate(su.slice(0, -1), sc.slice(1), ss.slice(0, -1), level)
    const down = chiSquarePredicate(su.slice(1), sc.slice(0, -1), ss.slice(1), level)
    if (up.pass || down.pass) return { verdict: "reject-degenerate", x2: claim.x2 }
  }
  for (const perm of enumerateAutomorphisms(su)) {
    if (chiSquarePredicate(su, perm.map((p) => sc[p]!), ss, level).pass) {
      return { verdict: "reject-degenerate", x2: claim.x2 }
    }
  }
  return { verdict: "accept", x2: claim.x2 }
}
```

Then in `mergeCheck`, replace

```ts
  const cond = conditioningCheck(su, sc)
  if (!cond.ok) return { ok: false, reason: "degenerate-constellation", a: fit.a, b: fit.b, delta, R: cond.R }
  return { ok: true, a: fit.a, b: fit.b, delta, R: cond.R }
```

with

```ts
  // Geometry question, delegated to the ONE acceptance predicate so mergeCheck
  // and mergeAccept can never disagree about what "degenerate" means. Unit
  // sigmas: mergeCheck is the delta-based form and carries no noise model — its
  // residual gate above already ran.
  const acc = mergeAccept(su, sc, su.map(() => EPS))
  if (acc.verdict !== "accept") return { ok: false, reason: "degenerate-constellation", a: fit.a, b: fit.b, delta }
  return { ok: true, a: fit.a, b: fit.b, delta }
```

and drop `R?: number` from `MergeResult`.

- [ ] **Step 4: Run the tests, confirm they pass**

Run: `cd opencode-plugin && bun test test/bench-reval-fit.test.ts test/bench-dnc-integration.test.ts`
Expected: PASS. Then `grep -rn "R_THRESHOLD_PLACEHOLDER\|conditioningCheck" opencode-plugin/src opencode-plugin/test` must return nothing.

- [ ] **Step 5: Commit**

```bash
cd opencode-plugin && bun test 2>&1 | tail -5
cd .. && bun scripts/gate-check.ts
git add opencode-plugin/src/bench/reval-fit.ts opencode-plugin/test/bench-reval-fit.test.ts
git commit -m "$(cat <<'EOF'
feat(lane-a)!: mergeAccept replaces the R-ratio conditioning check

Port of derive.py:merge_accept. One chi-square predicate does both jobs, so the
R ratio and its R=3 placeholder are deleted rather than deprecated — a dead
placeholder is a constant waiting to be re-tuned. The alternate quantifier stays
bound to derived automorphisms plus the fixed +/-1 shift; binding it to an
attack list would hide the incident-registry growth inside the quantifier.
mergeAccept owns the us/cs/sigmas sort so no caller can misalign per-anchor noise.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: series selection — which eligible artifact is the numeric series

Spec §8.9. The divide step needs the full numeric series; the audit sample truncates to head/tail-20 by design. The harness must pick the series file **structurally**, never from a per-task mapping (a mapping is the per-domain registry the spec names as cheating).

**Rule, fail-closed:** among the eligible artifacts, an artifact *is* a candidate series iff it parses as two numeric columns with at least `MIN_SERIES_ROWS` rows (= the detector's widest smoothing window, imported from `series-peaks.ts`) and at least 90% of its non-blank lines parsing. **Exactly one candidate** ⇒ that is the series. Zero or more than one ⇒ `no-series`, and the gate grants no numeric authority. Ambiguity is refused, not resolved by a heuristic.

**Files:**
- Modify: `opencode-plugin/src/bench/series-source.ts` (append)
- Test: `opencode-plugin/test/bench-series-source.test.ts` (append)

**Interfaces:**
- Consumes: `eligibleArtifacts`, `EligibleSet` from `./eligibility.ts` (Task 1); `parseSeries` (same file).
- Produces:
  - `export const MIN_SERIES_ROWS: number` — `= MAX_SMOOTH_WINDOW` from `series-peaks.ts` (101), never a restated literal
  - `export type SeriesSelection = { ok: true; path: string; xs: number[]; ys: number[] } | { ok: false; reason: "no-series" | "ambiguous" | "no-eligible-set" }`
  - `export function selectSeries(elig: EligibleSet): SeriesSelection`

- [ ] **Step 1: Write the failing tests**

Append to `opencode-plugin/test/bench-series-source.test.ts`:

```ts
import { selectSeries, MIN_SERIES_ROWS } from "../src/bench/series-source.ts"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

function twoCol(n: number): string {
  return Array.from({ length: n }, (_, i) => `${i} ${Math.sin(i / 7) + 2}`).join("\n") + "\n"
}

test("exactly one two-column numeric artifact is selected", () => {
  const d = mkdtempSync(join(tmpdir(), "sel-"))
  writeFileSync(join(d, "data.dat"), twoCol(200))
  writeFileSync(join(d, "readme.txt"), "prose, not a series\n")
  const r = selectSeries({ ok: true, root: d, files: [join(d, "data.dat"), join(d, "readme.txt")] })
  expect(r.ok).toBe(true)
  expect(r.ok && r.path.endsWith("data.dat")).toBe(true)
  expect(r.ok && r.xs.length).toBe(200)
})

test("TWO candidate series is AMBIGUOUS — refused, never heuristically resolved", () => {
  const d = mkdtempSync(join(tmpdir(), "sel2-"))
  writeFileSync(join(d, "a.dat"), twoCol(200))
  writeFileSync(join(d, "b.dat"), twoCol(300))
  const r = selectSeries({ ok: true, root: d, files: [join(d, "a.dat"), join(d, "b.dat")] })
  expect(r).toEqual({ ok: false, reason: "ambiguous" })
})

test("a short two-column file is not a series", () => {
  const d = mkdtempSync(join(tmpdir(), "sel3-"))
  writeFileSync(join(d, "tiny.dat"), twoCol(MIN_SERIES_ROWS - 1))
  expect(selectSeries({ ok: true, root: d, files: [join(d, "tiny.dat")] })).toEqual({ ok: false, reason: "no-series" })
})

test("a mostly-prose file with a few numeric pairs is not a series", () => {
  const d = mkdtempSync(join(tmpdir(), "sel4-"))
  const mixed = Array.from({ length: 200 }, (_, i) => (i % 10 === 0 ? `${i} ${i * 2}` : "some prose line here")).join("\n")
  writeFileSync(join(d, "mixed.txt"), mixed + "\n")
  expect(selectSeries({ ok: true, root: d, files: [join(d, "mixed.txt")] })).toEqual({ ok: false, reason: "no-series" })
})

test("an unresolvable eligible set yields no-eligible-set, never a guess", () => {
  expect(selectSeries({ ok: false, reason: "unresolvable" })).toEqual({ ok: false, reason: "no-eligible-set" })
})

test("a binary artifact is skipped without throwing", () => {
  const d = mkdtempSync(join(tmpdir(), "sel5-"))
  writeFileSync(join(d, "blob.bin"), Buffer.from([0, 1, 2, 0, 255, 0]))
  writeFileSync(join(d, "data.dat"), twoCol(200))
  const r = selectSeries({ ok: true, root: d, files: [join(d, "blob.bin"), join(d, "data.dat")] })
  expect(r.ok && r.path.endsWith("data.dat")).toBe(true)
})
```

- [ ] **Step 2: Run the tests, confirm they fail**

Run: `cd opencode-plugin && bun test test/bench-series-source.test.ts`
Expected: FAIL — `selectSeries` is not exported.

- [ ] **Step 3: Implement — append to `series-source.ts`**

```ts
import type { EligibleSet } from "./eligibility.ts"
import { MAX_SMOOTH_WINDOW } from "./series-peaks.ts"

/** Floored at the detector's own WIDEST SMOOTHING WINDOW, imported rather than
 * restated so there is exactly one owner. Below that, the widest scale spans the
 * whole series and the persistence test is degenerate — the floor is genuinely
 * dictated by the detector's geometry.
 *
 * An earlier draft wrote 64 and justified it with this same sentence. It does
 * not follow: the detector sweeps windows to 101, and 64 < 101. A round number
 * wearing a derivation's clothes is worse than an admitted arbitrary constant,
 * because the false derivation stops the next reader from checking. */
export const MIN_SERIES_ROWS = MAX_SMOOTH_WINDOW

export type SeriesSelection =
  | { ok: true; path: string; xs: number[]; ys: number[] }
  | { ok: false; reason: "no-series" | "ambiguous" | "no-eligible-set" }

/** Pick the numeric series STRUCTURALLY from the eligible set (§8.9). An
 * artifact qualifies iff it parses as two numeric columns over at least
 * MIN_SERIES_ROWS rows with >=90% of its non-blank lines parsing.
 *
 * Exactly one candidate wins. Zero or several is REFUSED — ambiguity resolved
 * by a heuristic ("the biggest one", "the .dat one") is a per-task mapping
 * wearing a rule's clothes, and the spec names per-domain registries as
 * cheating. Refusing costs coverage; guessing costs the guarantee. */
export function selectSeries(elig: EligibleSet): SeriesSelection {
  if (!elig.ok) return { ok: false, reason: "no-eligible-set" }
  const candidates: { path: string; xs: number[]; ys: number[] }[] = []
  for (const path of elig.files) {
    let text: string
    try {
      const buf = readFileSync(path)
      if (buf.subarray(0, 8000).includes(0)) continue // binary
      text = buf.toString("utf-8")
    } catch {
      continue
    }
    const nonBlank = text.split("\n").filter((l) => l.trim().length > 0).length
    if (nonBlank < MIN_SERIES_ROWS) continue
    const { xs, ys } = parseSeries(text)
    if (xs.length < MIN_SERIES_ROWS) continue
    if (xs.length / nonBlank < 0.9) continue
    candidates.push({ path, xs, ys })
  }
  if (candidates.length === 0) return { ok: false, reason: "no-series" }
  if (candidates.length > 1) return { ok: false, reason: "ambiguous" }
  return { ok: true, ...candidates[0]! }
}
```

- [ ] **Step 4: Run the tests, confirm they pass**

Run: `cd opencode-plugin && bun test test/bench-series-source.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd opencode-plugin && bun test 2>&1 | tail -5
cd .. && bun scripts/gate-check.ts
git add opencode-plugin/src/bench/series-source.ts opencode-plugin/test/bench-series-source.test.ts
git commit -m "$(cat <<'EOF'
feat(lane-a): structural series selection from the eligible set (spec 8.9)

An artifact is the series iff it parses as two numeric columns over >=64 rows
with >=90% line coverage, and exactly one candidate exists. Zero or several is
refused: resolving ambiguity by a heuristic would be a per-task mapping wearing
a rule's clothes. Refusing costs coverage; guessing costs the guarantee.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: the 11-case equivalence regression — TS must reproduce derive.py exactly

This is the regression set the arming spec names. It pins the TS port to the validated reference case-for-case; if the port drifts, this fails before anything downstream can be wrong quietly.

**Files:**
- Create: `opencode-plugin/test/bench-derived-thresholds.test.ts`

**Interfaces:**
- Consumes: `mergeAccept`, `REG_LEVEL` (Task 6); `deriveSeriesNoise` (Task 5); `detectPeaksTracked` (Task 2); `readSeriesFile` (existing).
- Produces: nothing importable — it is the pin.

- [ ] **Step 1: Write the test file (all 11 cases at once — it IS the deliverable)**

Create `opencode-plugin/test/bench-derived-thresholds.test.ts`:

```ts
/** The §8.2 derived-threshold regression set. Every expectation was read off a
 * verified run of docs/loop-probes/derived-thresholds-20260821/derive.py
 * (11/11, 2026-08-21) — the TS gate is a PORT of that reference, and this file
 * is what makes the port falsifiable. Do not "fix" a failure here by adjusting
 * an expectation; re-run derive.py and fix the port. */
import { test, expect } from "bun:test"
import { mergeAccept } from "../src/bench/reval-fit.ts"
import { deriveSeriesNoise } from "../src/bench/noise-sigma.ts"
import { detectPeaksTracked } from "../src/bench/series-peaks.ts"
import { readSeriesFile } from "../src/bench/series-source.ts"
import { readFileSync } from "node:fs"

const EPSS = 1e-9
const truth = (us: number[]) => us.map((u) => 100 + 40 * u)
const eq = [1, 2, 3, 4, 5]
const ir = [1.0, 2.3, 2.9, 5.1, 7.8]
const sym = [1, 2, 6, 10, 11]
const flat = (us: number[]) => us.map(() => EPSS)

test("V1 eq+shift -> reject-degenerate", () => {
  const t = truth(eq)
  expect(mergeAccept(eq, [...t.slice(1), t[4]! + 40], flat(eq)).verdict).toBe("reject-degenerate")
})

test("V2 eq honest -> reject-degenerate (equal spacing is UNCHECKABLE geometry, not wrong)", () => {
  expect(mergeAccept(eq, truth(eq), flat(eq)).verdict).toBe("reject-degenerate")
})

test("V3 ir honest -> accept", () => {
  expect(mergeAccept(ir, truth(ir), flat(ir)).verdict).toBe("accept")
})

test("V4 ir shifted -> reject-residual", () => {
  const t = truth(ir)
  expect(mergeAccept(ir, [...t.slice(1), t[4]! + 40], flat(ir)).verdict).toBe("reject-residual")
})

test("V5 value-fab -> accept (the MEASURED T6 boundary: geometry cannot reject DECEPTION)", () => {
  // an invented (a,b) applied consistently passes every geometric check by
  // construction. This test PASSING is the reason §8.8's ladder exists; if it
  // ever fails, the gate has started claiming a guarantee it does not have.
  expect(mergeAccept(ir, ir.map((u) => 7 + 3 * u), flat(ir)).verdict).toBe("accept")
})

test("V6 sym reversal -> reject-degenerate", () => {
  expect(mergeAccept(sym, [...truth(sym)].reverse(), flat(sym)).verdict).toBe("reject-degenerate")
})

test("V7 noise sweep: exact through 1%, false-accepts 0 at every sigma", () => {
  // same generator, seeds, sigmas and trial count as derive.py's V7 block
  function prng(seed: number) {
    let s0 = (seed >>> 0) || 1
    let s1 = ((seed * 2654435761) >>> 0) || 2
    return () => {
      let x = s0
      const y = s1
      s0 = y
      x = (x ^ (x << 23)) >>> 0
      s1 = (x ^ y ^ (x >>> 17) ^ (y >>> 26)) >>> 0
      return ((s1 + y) >>> 0) / 4294967296
    }
  }
  const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(Math.max(r(), 1e-12))) * Math.cos(2 * Math.PI * r())
  const T = truth(ir)
  const SH = [...T.slice(1), T[4]! + 40]
  const span = Math.max(...T) - Math.min(...T)
  const expected: Record<string, [number, number]> = {
    "0.001": [0, 0], "0.005": [0, 0], "0.01": [0, 0], "0.02": [10, 0], "0.05": [182, 0],
  }
  const fracs = [0.001, 0.005, 0.01, 0.02, 0.05]
  fracs.forEach((frac, si) => {
    const sAbs = frac * span
    let falseReject = 0
    let falseAccept = 0
    for (let seed = 1; seed <= 200; seed++) {
      const r = prng(seed + si * 1000)
      const noise = () => gauss(r) * sAbs
      const sig = ir.map(() => sAbs)
      if (mergeAccept(ir, T.map((c) => c + noise()), sig).verdict !== "accept") falseReject++
      if (mergeAccept(ir, SH.map((c) => c + noise()), sig).verdict === "accept") falseAccept++
    }
    expect([falseReject, falseAccept]).toEqual(expected[String(frac)]!)
  })
})

// --- real-fixture cases: the series-side derivation feeds the predicate ------

function fixtureNoise(path: string, root: string) {
  const { xs, ys } = readSeriesFile(path, root)
  return deriveSeriesNoise(xs, ys, detectPeaksTracked(ys), (x) => x)
}

const FX2 = "docs/loop-probes/dnc-second-fixture-20260820"
const GRA = "term-bench2/probe-tasks/raman-fitting-audit/environment"

test("V8 fixture-2 oracle -> accept (n=6)", () => {
  const tr = JSON.parse(readFileSync(`${FX2}/truth.json`, "utf-8"))
  const { us, sigmaU } = fixtureNoise(`${FX2}/fixture.dat`, FX2)
  expect(us.length).toBe(6)
  const sigC = sigmaU.map((s) => Math.abs(tr.b) * s)
  expect(mergeAccept(us, us.map((u) => tr.a + tr.b * u), sigC).verdict).toBe("accept")
})

test("V9 fixture-2 quadratic -> reject-residual (F1 closure: out-of-family IS rejected)", () => {
  const tr = JSON.parse(readFileSync(`${FX2}/truth.json`, "utf-8"))
  const { us, sigmaU } = fixtureNoise(`${FX2}/fixture.dat`, FX2)
  const sigC = sigmaU.map((s) => Math.abs(tr.b) * s)
  expect(mergeAccept(us, us.map((u) => 20 + 0.5 * u * u), sigC).verdict).toBe("reject-residual")
})

test("V10 fixture-2 shifted and reversed are both rejected", () => {
  const tr = JSON.parse(readFileSync(`${FX2}/truth.json`, "utf-8"))
  const { us, sigmaU } = fixtureNoise(`${FX2}/fixture.dat`, FX2)
  const sigC = sigmaU.map((s) => Math.abs(tr.b) * s)
  const oracle = us.map((u) => tr.a + tr.b * u)
  expect(mergeAccept(us, [...oracle.slice(1), oracle[oracle.length - 1]! + tr.b], sigC).verdict).toBe("reject-residual")
  expect(mergeAccept(us, [...oracle].reverse(), sigC).verdict).not.toBe("accept")
})

test("V11 graphene honest -> accept (n=17)", () => {
  const { us, sigmaU } = fixtureNoise(`${GRA}/task-deps/graphene.dat`, GRA)
  expect(us.length).toBe(17)
  const sigC = sigmaU.map((s) => 2.0 * s)
  expect(mergeAccept(us, us.map((u) => 10 + 2.0 * u), sigC).verdict).toBe("accept")
})

test("LEVEL is non-load-bearing: V1..V6 identical at 0.99 / 0.999 / 0.9999", () => {
  for (const lvl of [0.99, 0.999, 0.9999]) {
    const t = truth(eq)
    expect(mergeAccept(eq, [...t.slice(1), t[4]! + 40], flat(eq), lvl).verdict).toBe("reject-degenerate")
    expect(mergeAccept(eq, truth(eq), flat(eq), lvl).verdict).toBe("reject-degenerate")
    expect(mergeAccept(ir, truth(ir), flat(ir), lvl).verdict).toBe("accept")
    const ti = truth(ir)
    expect(mergeAccept(ir, [...ti.slice(1), ti[4]! + 40], flat(ir), lvl).verdict).toBe("reject-residual")
    expect(mergeAccept(ir, ir.map((u) => 7 + 3 * u), flat(ir), lvl).verdict).toBe("accept")
    expect(mergeAccept(sym, [...truth(sym)].reverse(), flat(sym), lvl).verdict).toBe("reject-degenerate")
  }
})
```

- [ ] **Step 2: Run it**

Run: `cd opencode-plugin && bun test test/bench-derived-thresholds.test.ts`
Expected: PASS, 12 tests.

If V7's counts differ, the PRNG port is wrong, not the predicate: Python's `>> 26` on a masked 32-bit int is `>>> 26` in JS, and every intermediate must be re-masked to 32 bits. Diff a few raw `prng` draws against Python before touching `mergeAccept`.

- [ ] **Step 3: Commit**

```bash
cd opencode-plugin && bun test 2>&1 | tail -5
cd .. && bun scripts/gate-check.ts
git add opencode-plugin/test/bench-derived-thresholds.test.ts
git commit -m "$(cat <<'EOF'
test(lane-a): pin the TS port to derive.py's 11 validated cases

The §8.2 regression set: V1-V11 plus the level-insensitivity sweep, expectations
read off a verified derive.py run. V5 asserting ACCEPT is deliberate — it is the
measured T6 boundary, and if it ever flips the gate has started claiming a
guarantee against DECEPTION that it does not have.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: mergeGate — the UNCHECKABLE branch and the scale attacks

Spec §8.2 (b). Outside the validated noise domain the gate returns `uncheckable`, never a verdict. And because §8.2's domain bound is a ratio, the adversarial question is whether the claimant can move the boundary — so the attacks get built here, alongside the branch.

**Files:**
- Create: `opencode-plugin/src/bench/merge-gate.ts`
- Test: `opencode-plugin/test/bench-merge-gate.test.ts`

**Interfaces:**
- Consumes: `mergeAccept`, `REG_LEVEL` (Task 6); `sigmaFraction`, `VALIDATED_SIGMA_FRACTION`, `SeriesNoise` (Task 5).
- Produces:
  - `export type GateVerdict = "accept" | "reject-residual" | "reject-degenerate" | "uncheckable"`
  - `export interface GateResult { verdict: GateVerdict; x2: number; sigmaFraction: number; n: number }`
  - `export function mergeGate(noise: SeriesNoise, canonicals: number[], slope?: number): GateResult` — `slope` defaults to the claim's own fitted `|b|`, used only to carry `sigmaU` into c-space.

- [ ] **Step 1: Write the failing tests, attacks first**

Create `opencode-plugin/test/bench-merge-gate.test.ts`:

```ts
import { test, expect } from "bun:test"
import { mergeGate } from "../src/bench/merge-gate.ts"
import type { SeriesNoise } from "../src/bench/noise-sigma.ts"

const ir = [1.0, 2.3, 2.9, 5.1, 7.8]
const span = Math.max(...ir) - Math.min(...ir)
const noiseAt = (frac: number): SeriesNoise => ({ us: ir, sigmaU: ir.map(() => frac * span), sigmaY: 0 })

test("inside the validated domain the gate rules normally", () => {
  const r = mergeGate(noiseAt(0.005), ir.map((u) => 100 + 40 * u))
  expect(r.verdict).toBe("accept")
})

test("at exactly the domain bound the gate still rules", () => {
  expect(mergeGate(noiseAt(0.01), ir.map((u) => 100 + 40 * u)).verdict).toBe("accept")
})

test("past the validated domain the gate returns UNCHECKABLE, never a verdict", () => {
  const r = mergeGate(noiseAt(0.05), ir.map((u) => 100 + 40 * u))
  expect(r.verdict).toBe("uncheckable")
  expect(r.sigmaFraction).toBeGreaterThan(0.01)
})

// --- the attacks: can the claimant move the domain boundary or the verdict? --

test("ATTACK scale-invariance: multiplying every canonical by 1000 changes nothing", () => {
  const cs = ir.map((u) => 100 + 40 * u)
  const base = mergeGate(noiseAt(0.005), cs)
  const scaled = mergeGate(noiseAt(0.005), cs.map((c) => c * 1000))
  expect(scaled.verdict).toBe(base.verdict)
  expect(scaled.x2).toBeCloseTo(base.x2, 6)
})

test("ATTACK span inflation: a huge claimed span cannot buy entry to the domain", () => {
  // sigmaFraction reads only anchors + derived sigma, so the claim is not in it
  const wide = mergeGate(noiseAt(0.05), ir.map((u) => 1e9 * u))
  expect(wide.verdict).toBe("uncheckable")
  expect(wide.sigmaFraction).toBeCloseTo(0.05, 9)
})

test("ATTACK slope inflation: a steeper claim does not loosen the predicate", () => {
  // sigma_c = |b| * sigma_u scales with the claim's own slope, and so do the
  // residuals — the ratio is invariant, which is what makes the estimator sound
  const shifted = (k: number) => {
    const t = ir.map((u) => 100 + k * u)
    return [...t.slice(1), t[4]! + k]
  }
  expect(mergeGate(noiseAt(0.005), shifted(40)).verdict).toBe("reject-residual")
  expect(mergeGate(noiseAt(0.005), shifted(4e6)).verdict).toBe("reject-residual")
})

test("fewer than 3 anchors is uncheckable, not accept", () => {
  const n: SeriesNoise = { us: [1, 2], sigmaU: [0.01, 0.01], sigmaY: 0 }
  expect(mergeGate(n, [141, 181]).verdict).toBe("uncheckable")
})

test("a canonical count that does not match the anchor count is uncheckable", () => {
  // §6.5 full coverage: the claimant never picks WHICH anchors are graded
  expect(mergeGate(noiseAt(0.005), [141, 192, 216]).verdict).toBe("uncheckable")
})

test("a zero-span constellation is uncheckable, not wrong", () => {
  const n: SeriesNoise = { us: [3, 3, 3], sigmaU: [0.01, 0.01, 0.01], sigmaY: 0 }
  expect(mergeGate(n, [1, 2, 3]).verdict).toBe("uncheckable")
})
```

- [ ] **Step 2: Run the tests, confirm they fail**

Run: `cd opencode-plugin && bun test test/bench-merge-gate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `merge-gate.ts`**

```ts
/** The armed §6+§8.2 gate: full-coverage anchor set, artifact-derived noise,
 * one acceptance predicate, and a hard refusal outside the validated domain.
 *
 * FAIL-CLOSED IS THE DEFAULT DIRECTION. Every branch that cannot rule returns
 * `uncheckable` — degenerate constellations, short anchor sets, partial
 * coverage, and noise past §8.2(b)'s validated range are UNCHECKABLE, NOT
 * WRONG, and never a pass. */
import { fitAffine, mergeAccept, REG_LEVEL } from "./reval-fit.ts"
import { sigmaFraction, VALIDATED_SIGMA_FRACTION, type SeriesNoise } from "./noise-sigma.ts"

export type GateVerdict = "accept" | "reject-residual" | "reject-degenerate" | "uncheckable"

export interface GateResult {
  verdict: GateVerdict
  x2: number
  sigmaFraction: number
  n: number
}

export function mergeGate(noise: SeriesNoise, canonicals: number[], slope?: number): GateResult {
  const n = noise.us.length
  // §6.5: the merge consumes the ENTIRE harness survivor set. A claim covering
  // a subset is a claimant choosing which anchors get graded, which is freedom
  // to construct a fabricated value on a compliant subset.
  const frac = sigmaFraction(noise.us, noise.sigmaU)
  const base: GateResult = { verdict: "uncheckable", x2: Infinity, sigmaFraction: frac, n }
  if (canonicals.length !== n || n < 3) return base
  if (!Number.isFinite(frac)) return base
  // §8.2(b): never extrapolate the predicate past its evidence. Measured
  // degradation outside the domain is FALSE REJECT (V7), so refusing is the
  // conservative direction — but refusing is still refusing, not accepting.
  if (frac > VALIDATED_SIGMA_FRACTION) return base

  // carry the anchors' positional uncertainty into canonical space through the
  // fit's own slope; residuals scale with the same slope, so the ratio the
  // predicate tests is invariant to how the claimant scales the values
  const b = slope ?? Math.abs(fitAffine(noise.us, canonicals).b)
  const sigmaC = noise.sigmaU.map((s) => Math.max(Math.abs(b) * s, 1e-12))
  const r = mergeAccept(noise.us, canonicals, sigmaC, REG_LEVEL)
  return { verdict: r.verdict, x2: r.x2, sigmaFraction: frac, n }
}
```

- [ ] **Step 4: Run the tests, confirm they pass**

Run: `cd opencode-plugin && bun test test/bench-merge-gate.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
cd opencode-plugin && bun test 2>&1 | tail -5
cd .. && bun scripts/gate-check.ts
git add opencode-plugin/src/bench/merge-gate.ts opencode-plugin/test/bench-merge-gate.test.ts
git commit -m "$(cat <<'EOF'
feat(lane-a): merge gate with the UNCHECKABLE branch (spec 8.2 b)

Outside the validated noise domain the gate refuses to rule rather than
extrapolating. Three attacks ship with the branch: uniform scaling, span
inflation, and slope inflation all leave the verdict unchanged, because
sigmaFraction reads only the artifact and sigma_c scales with the same slope as
the residuals. Partial anchor coverage and n<3 are uncheckable, never accept.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: the ANCHOR CLAIM contract — prompt v6 + parser + stripper

Replaces the `REVALIDATION:` block. The old block let the model supply `canonical`, `delta`, and which landings to report — two of the three degrees of freedom belonged to the audited party. The new block asks for exactly one thing the harness cannot know: the family choice and one canonical value **per harness-enumerated anchor**.

**The mock dry-run in the conflict scan is mandatory before Step 3 of this task.**

**Files:**
- Modify: `opencode-plugin/src/bench/convention-audit-prompt.txt`
- Modify: `opencode-plugin/src/bench/convention-audit.ts`
- Test: `opencode-plugin/test/bench-convention-audit.test.ts` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces (from `convention-audit.ts`):
  - `export const ANCHOR_MARKER = /^ANCHOR CLAIM:\s*$/m` — **the single shared marker**; the parser and the stripper both use this constant and nothing else.
  - `export type ParsedAnchorClaim = { kind: "none" } | { kind: "absent" } | { kind: "malformed" } | { kind: "claim"; family: "x" | "inv-x"; canonicals: number[] }`
  - `export function parseAnchorClaim(raw: string): ParsedAnchorClaim`
  - `export function stripAnchorClaim(raw: string): string`
  - `export function anchorPromptBlock(xs: number[]): string`
  - `AUDIT_PROMPT_VERSION` bumped to `"lane-a-v6"` **in this same commit as the prompt text change.**

- [ ] **Step 1: Write the failing tests**

Append to `opencode-plugin/test/bench-convention-audit.test.ts`:

```ts
import { parseAnchorClaim, stripAnchorClaim, anchorPromptBlock, ANCHOR_MARKER, AUDIT_PROMPT_VERSION } from "../src/bench/convention-audit.ts"

const GOOD = `Some prose about the convention.

ANCHOR CLAIM:
FAMILY: inv-x
CANONICALS: 1580.6, 2700.1, 1350.0
`

test("MOCK DRY-RUN: the fixture block both parses and strips against the shared marker", () => {
  const p = parseAnchorClaim(GOOD)
  expect(p.kind).toBe("claim")
  const stripped = stripAnchorClaim(GOOD)
  expect(stripped).not.toContain("ANCHOR CLAIM")
  expect(stripped).not.toContain("1580.6")
  expect(ANCHOR_MARKER.test(stripped)).toBe(false)
})

test("a well-formed claim yields family + canonicals in order", () => {
  const p = parseAnchorClaim(GOOD)
  expect(p.kind === "claim" && p.family).toBe("inv-x")
  expect(p.kind === "claim" && p.canonicals).toEqual([1580.6, 2700.1, 1350.0])
})

test("FAMILY: none is the criteria-class abstention", () => {
  expect(parseAnchorClaim("ANCHOR CLAIM:\nFAMILY: none\n").kind).toBe("none")
})

test("no marker is absent, not malformed", () => {
  expect(parseAnchorClaim("just prose").kind).toBe("absent")
})

test("an unknown family is malformed, never coerced to a default", () => {
  expect(parseAnchorClaim("ANCHOR CLAIM:\nFAMILY: quadratic\nCANONICALS: 1, 2, 3\n").kind).toBe("malformed")
})

test("a non-numeric canonical makes the whole block malformed", () => {
  expect(parseAnchorClaim("ANCHOR CLAIM:\nFAMILY: x\nCANONICALS: 1, two, 3\n").kind).toBe("malformed")
})

test("a blank CANONICALS entry is malformed, not Number('')===0", () => {
  // the parseRevalBlock lesson: blank cells coerce to 0 and fabricate a value
  expect(parseAnchorClaim("ANCHOR CLAIM:\nFAMILY: x\nCANONICALS: 1, , 3\n").kind).toBe("malformed")
})

test("fewer than 3 canonicals is malformed (n<3 has no dof)", () => {
  expect(parseAnchorClaim("ANCHOR CLAIM:\nFAMILY: x\nCANONICALS: 1, 2\n").kind).toBe("malformed")
})

test("a second stray block cannot be stitched into the first claim", () => {
  const two = "ANCHOR CLAIM:\nFAMILY: x\nCANONICALS: 1, 2, 3\n\nANCHOR CLAIM:\nFAMILY: inv-x\nCANONICALS: 9, 9, 9\n"
  const p = parseAnchorClaim(two)
  expect(p.kind === "claim" && p.canonicals).toEqual([1, 2, 3])
})

test("the stripper over-strips rather than leaking (block to end of string)", () => {
  const s = stripAnchorClaim("card text\n\nANCHOR CLAIM:\nFAMILY: x\nCANONICALS: 1, 2, 3\n\ntrailing prose")
  expect(s).toBe("card text")
})

test("anchorPromptBlock enumerates every anchor, numbered, for full coverage", () => {
  const b = anchorPromptBlock([100.5, 200.25, 300])
  expect(b).toContain("1: 100.5")
  expect(b).toContain("3: 300")
  expect(b).toContain("3 anchors")
})

test("the prompt version is bumped with the prompt text", () => {
  expect(AUDIT_PROMPT_VERSION).toBe("lane-a-v6")
})
```

- [ ] **Step 2: Run the tests, confirm they fail**

Run: `cd opencode-plugin && bun test test/bench-convention-audit.test.ts`
Expected: FAIL — `parseAnchorClaim` is not exported.

- [ ] **Step 3: Implement the contract in `convention-audit.ts`**

Bump the version and add the block, alongside the existing reval code (Task 12 removes the old path):

```ts
export const AUDIT_PROMPT_VERSION = "lane-a-v6"

/** The ONE marker both the parser and the stripper use. Two regexes here is how
 * a block gets parsed-but-not-stripped and leaks into the SUT instruction — the
 * exact hazard REVAL_MARKER was introduced to close. No /g flag: no lastIndex
 * state leaks across independent .match() calls. */
export const ANCHOR_MARKER = /^ANCHOR CLAIM:\s*$/m

export type ParsedAnchorClaim =
  | { kind: "none" }
  | { kind: "absent" }
  | { kind: "malformed" }
  | { kind: "claim"; family: "x" | "inv-x"; canonicals: number[] }

const FAMILIES = new Set(["x", "inv-x"])

/** Parse the imposed ANCHOR CLAIM block. Four-way and fail-closed. The model
 * supplies exactly two things the harness cannot know — which family member,
 * and the canonical value of EACH enumerated anchor. It no longer supplies a
 * tolerance, a constant, or which anchors get graded: those were two of the
 * three degrees of freedom that made the old revalidator bypassable. */
export function parseAnchorClaim(raw: string): ParsedAnchorClaim {
  const marker = raw.match(ANCHOR_MARKER)
  if (!marker) return { kind: "absent" }
  const start = marker.index!
  const blank = raw.indexOf("\n\n", start)
  const body = blank === -1 ? raw.slice(start) : raw.slice(start, blank)
  const fam = body.match(/^FAMILY:\s*(\S+)/m)?.[1]?.toLowerCase()
  if (fam === "none") return { kind: "none" }
  if (!fam || !FAMILIES.has(fam)) return { kind: "malformed" }
  const csRaw = body.match(/^CANONICALS:\s*(.+)$/m)?.[1]
  if (!csRaw) return { kind: "malformed" }
  const cells = csRaw.split(",").map((c) => c.trim())
  // a blank cell coerces via Number("") === 0 — reject BEFORE Number(), or a
  // missing value silently becomes a claimed 0
  if (cells.some((c) => c.length === 0)) return { kind: "malformed" }
  const canonicals = cells.map(Number)
  if (canonicals.some((v) => !Number.isFinite(v))) return { kind: "malformed" }
  if (canonicals.length < 3) return { kind: "malformed" }
  return { kind: "claim", family: fam as "x" | "inv-x", canonicals }
}

/** Remove the ANCHOR CLAIM block (marker -> end of string) so it is never
 * injected into the task instruction. Biases toward over-stripping: a block
 * leaking into the SUT is worse than losing trailing prose. */
export function stripAnchorClaim(raw: string): string {
  const m = raw.match(ANCHOR_MARKER)
  if (!m) return raw.trim()
  return raw.slice(0, m.index).trim()
}

/** The harness's enumerated anchor set, rendered for the prompt. Enumerating
 * ALL of them is §6.5: the claimant never selects which anchors are graded,
 * because freedom to pick 3 of 17 is freedom to fabricate a value on a
 * compliant subset. */
export function anchorPromptBlock(xs: number[]): string {
  const lines = xs.map((x, i) => `  ${i + 1}: ${x}`)
  return [
    `The harness detected ${xs.length} anchors in the task's numeric series, at these first-column positions:`,
    ...lines,
    "",
    "You must report a canonical value for EVERY anchor listed, in this order.",
  ].join("\n")
}
```

- [ ] **Step 4: Rewrite the prompt's claim section**

In `opencode-plugin/src/bench/convention-audit-prompt.txt`, replace the `REVALIDATION:` instructions with:

```
If the mismatch you found is a UNIT or SCALE convention on the numeric series,
end your answer with a block in exactly this form:

ANCHOR CLAIM:
FAMILY: <x | inv-x | none>
CANONICALS: <one number per anchor, comma separated, in the listed order>

FAMILY names how the reported axis relates to the first column: `x` if the
canonical value is an affine function of the raw position, `inv-x` if it is an
affine function of its reciprocal. Use `none` if the mismatch is not a numeric
convention at all — that is a valid and useful answer, not a failure.

Report a canonical value for EVERY anchor listed above, in that order. Do not
report a tolerance; do not report a constant; do not omit anchors you are less
sure about. If you cannot give a value for every anchor, answer `FAMILY: none`.
```

**Do not describe the harness's checks in this file.** Probe F3's O4 arm measured that announcing the cross-check made constant-consistency rise while derivations began contradicting their own cells — the announced metric improved as the behavior degraded. Checks run harness-side, never announced.

- [ ] **Step 5: Run the tests, confirm they pass**

Run: `cd opencode-plugin && bun test test/bench-convention-audit.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd opencode-plugin && bun test 2>&1 | tail -5
cd .. && bun scripts/gate-check.ts
git add opencode-plugin/src/bench/convention-audit.ts opencode-plugin/src/bench/convention-audit-prompt.txt opencode-plugin/test/bench-convention-audit.test.ts
git commit -m "$(cat <<'EOF'
feat(lane-a): ANCHOR CLAIM contract replaces the REVALIDATION block

The model now supplies only what the harness cannot know: which frozen family
member, and one canonical per harness-enumerated anchor. Tolerance, constant,
and anchor selection are gone from the claim — those were two of the three
degrees of freedom that made the old revalidator bypassable. Prompt version
bumped to lane-a-v6 in the same commit as the prompt bytes. Parser and stripper
share one marker constant; the prompt never describes the harness's checks (F3
O4: announcing the cross-check improved the metric and degraded the behavior).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: source-crosscheck.ts — L-A per-source verdicts and the combination rule

Spec §8.8 (ii)+(iii). Full-source coverage: the harness enumerates every eligible artifact and checks the claim against **all** of them; the claimant never selects the checked source.

**Honest scope, stated in code:** this task implements the **numeric-source** comparison only. The executable-evaluator subclass returns `undecidable`, because running a task's own tool needs a uniform invocation contract and the spec forbids growing per-task adapters. That is a named follow-on, not a silent omission.

**Files:**
- Create: `opencode-plugin/src/bench/source-crosscheck.ts`
- Test: `opencode-plugin/test/bench-source-crosscheck.test.ts`

**Interfaces:**
- Consumes: `EligibleSet` (Task 1); `chiSquarePredicate`, `REG_LEVEL` (Task 3); `parseSeries` (`series-source.ts`).
- Produces:
  - `export type SourceVerdict = "consistent" | "inconsistent" | "undecidable"`
  - `export interface SourceCheck { path: string; verdict: SourceVerdict; why: string }`
  - `export type LAVerdict = "CONSISTENT" | "INCONSISTENT" | "NO-SOURCE"`
  - `export function combineSourceVerdicts(checks: SourceCheck[]): LAVerdict`
  - `export function crosscheckClaim(elig: EligibleSet, claimValues: number[], excludePath?: string): { verdict: LAVerdict; checks: SourceCheck[] }`

- [ ] **Step 1: Write the failing tests**

Create `opencode-plugin/test/bench-source-crosscheck.test.ts`:

```ts
import { test, expect } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { combineSourceVerdicts, crosscheckClaim } from "../src/bench/source-crosscheck.ts"

// --- the combination rule (§8.8 ii) -----------------------------------------

test("ANY inconsistent source vetoes, even alongside consistent ones", () => {
  expect(combineSourceVerdicts([
    { path: "a", verdict: "consistent", why: "" },
    { path: "b", verdict: "inconsistent", why: "" },
  ])).toBe("INCONSISTENT")
})

test("CONSISTENT needs at least one deterministically consistent source and no inconsistent one", () => {
  expect(combineSourceVerdicts([
    { path: "a", verdict: "consistent", why: "" },
    { path: "b", verdict: "undecidable", why: "" },
  ])).toBe("CONSISTENT")
})

test("undecidable sources are never evidence — all-undecidable is NO-SOURCE", () => {
  expect(combineSourceVerdicts([
    { path: "a", verdict: "undecidable", why: "" },
    { path: "b", verdict: "undecidable", why: "" },
  ])).toBe("NO-SOURCE")
})

test("an empty source set is NO-SOURCE", () => {
  expect(combineSourceVerdicts([])).toBe("NO-SOURCE")
})

test("undecidable is not a veto either — it is simply not a witness", () => {
  // the spec's exact wording; asserted so a future refactor cannot quietly
  // promote undecidable to either role
  expect(combineSourceVerdicts([{ path: "a", verdict: "undecidable", why: "" }])).toBe("NO-SOURCE")
})

// --- the numeric comparison (§8.8 iii) --------------------------------------

function fixture(files: Record<string, string>) {
  const d = mkdtempSync(join(tmpdir(), "xchk-"))
  const paths: string[] = []
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(d, name), body)
    paths.push(join(d, name))
  }
  return { ok: true as const, root: d, files: paths }
}

test("a data-shaped source that agrees with the claim is CONSISTENT", () => {
  const e = fixture({ "reference.dat": "1580.6 1.0\n2700.1 0.5\n1350.0 0.2\n" })
  expect(crosscheckClaim(e, [1580.6, 2700.1]).verdict).toBe("CONSISTENT")
})

test("JSON metadata is a recognized data grammar", () => {
  const e = fixture({ "meta.json": JSON.stringify({ peaks: [1580.6, 2700.1] }) })
  expect(crosscheckClaim(e, [1580.6, 2700.1]).verdict).toBe("CONSISTENT")
})

test("a data-shaped source that contradicts the claim is INCONSISTENT", () => {
  const e = fixture({ "reference.dat": "1580.6 1.0\n2700.1 0.5\n" })
  expect(crosscheckClaim(e, [1580.6, 999.9]).verdict).toBe("INCONSISTENT")
})

test("tolerance comes from the SOURCE token's printed precision, not a constant", () => {
  // "1580.6" asserts one decimal -> half-ulp is 0.05
  const e = fixture({ "ref.dat": "1580.6 1.0\n0.0 0.0\n" })
  expect(crosscheckClaim(e, [1580.62]).checks[0]!.verdict).toBe("consistent")
  expect(crosscheckClaim(e, [1580.8]).checks[0]!.verdict).toBe("undecidable")
  // a source printing more digits asserts more, and tightens the comparison
  const e2 = fixture({ "ref.dat": "1580.600000 1.0\n0.0 0.0\n" })
  expect(crosscheckClaim(e2, [1580.62]).checks[0]!.verdict).toBe("undecidable")
})

test("F2: a program's source is undecidable REGARDLESS of extension", () => {
  // the fail-open incident registry this replaces would have missed .lua and
  // .jl entirely, letting an embedded constant manufacture CROSSCHECKED
  for (const name of ["eval.py", "eval.lua", "eval.jl", "runner"]) {
    const e = fixture({ [name]: "THRESHOLD = 1580.6\nprint('ok')\n" })
    const c = crosscheckClaim(e, [1580.6]).checks[0]!
    expect(c.verdict).toBe("undecidable")
    expect(c.why).toContain("not data-shaped")
  }
})

test("prose mentioning the value is undecidable, not consistent (accepted coverage cost)", () => {
  const e = fixture({ "notes.md": "The expected peak is around 1580.6 for this material.\n" })
  expect(crosscheckClaim(e, [1580.6]).verdict).toBe("NO-SOURCE")
})

test("F4: a prose file can no longer veto an otherwise consistent claim", () => {
  const e = fixture({
    "ref.dat": "1580.6 1.0\n2700.1 0.5\n",
    "README.md": "Serve on port 8080. Released 2019. See 1580.6 in the notes.\n",
  })
  expect(crosscheckClaim(e, [1580.6, 2700.1]).verdict).toBe("CONSISTENT")
})

test("the series the claim was derived FROM is excluded — it is the claim's own input", () => {
  // the downstream-of-decision law: a source that IS the claim's input cannot
  // contradict the claim
  const e = fixture({ "series.dat": "1 2\n2 3\n", "ref.dat": "1580.6 1.0\n0.0 0.0\n" })
  const r = crosscheckClaim(e, [1580.6], e.files[0])
  expect(r.checks.some((c) => c.path.endsWith("series.dat"))).toBe(false)
  expect(r.verdict).toBe("CONSISTENT")
})

test("an unresolvable eligible set is NO-SOURCE — never partially checked", () => {
  expect(crosscheckClaim({ ok: false, reason: "unresolvable" }, [1580.6]).verdict).toBe("NO-SOURCE")
})

test("EVERY eligible source is checked — the claimant never selects one", () => {
  const e = fixture({
    "a.dat": "1580.6 1.0\n0.0 0.0\n",
    "b.dat": "1580.6 2.0\n0.0 0.0\n",
    "c.dat": "1580.6 1.0\n9999.9 0.0\n",
  })
  const r = crosscheckClaim(e, [1580.6, 2700.1])
  expect(r.checks.length).toBe(3)
  expect(r.verdict).toBe("INCONSISTENT") // none carries 2700.1; partial match vetoes
})
```

- [ ] **Step 2: Run the tests, confirm they fail**

Run: `cd opencode-plugin && bun test test/bench-source-crosscheck.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `source-crosscheck.ts`**

```ts
/** §8.8 L-A source_crosscheck — the PRIMARY value-truth layer. It checks the
 * claim against task-owned artifacts INDEPENDENT of the audited claim's inputs.
 * That independence is the whole mechanism: the downstream-of-decision law says
 * a statistic computed from the thing it audits cannot contradict it, so the
 * escape has to be a prior from OUTSIDE the claim — here, the task's own source.
 *
 * SCOPE HONESTY: this verifies FAITHFULNESS-TO-SOURCE, not truth. A stale or
 * wrong source passes. That is a smaller guarantee than "the value is correct",
 * and the ladder is built on the smaller one.
 *
 * NOT IMPLEMENTED HERE: the executable-evaluator subclass (replay the task's own
 * tool). Running it needs a uniform invocation contract; per-task adapters are
 * the named cheating class, so those sources return `undecidable` and the
 * subclass is a named follow-on. Fail-closed beats a per-task registry. */
import { readFileSync } from "node:fs"
import type { EligibleSet } from "./eligibility.ts"

export type SourceVerdict = "consistent" | "inconsistent" | "undecidable"
export interface SourceCheck { path: string; verdict: SourceVerdict; why: string }
export type LAVerdict = "CONSISTENT" | "INCONSISTENT" | "NO-SOURCE"

/** DECIDABILITY IS A POSITIVE DATA-SHAPE CRITERION (F2, found independently by
 * both lanes). An earlier draft classified sources by an extension denylist
 * (.py|.sh|.c|…) — an incident registry that grows one entry per language
 * encountered, and which fails OPEN in the worst direction: an eval.lua, an
 * eval.jl or an extensionless script misses the regex, falls through to the
 * numeric comparison, and a threshold constant embedded in that PROGRAM'S
 * SOURCE manufactures `consistent` -> CONSISTENT -> CROSSCHECKED -> numeric
 * injection. The list was the only thing enforcing §8.8's rule that the
 * executable subclass needs EXECUTION and never text judgment over source, and
 * it enforced it by enumeration.
 *
 * Inverted: a source is decidable iff it PARSES AS DATA — valid JSON, or a
 * strong majority of non-blank lines that are numeric-token lines. Everything
 * else is undecidable by default, so an unlisted language lands where it belongs
 * without anyone having to have remembered it. Same shape as Task 1's
 * eligibility criterion and Task 7's series selection.
 *
 * Two grammars are recognized, and a grammar is not a fact: a parser either
 * succeeds on the bytes or it does not, and anything unrecognized is
 * undecidable. Adding a data FORMAT later is adding a parser, exactly as adding
 * an encoding to Task 4 is adding a decoder — mechanism growth with a
 * fail-closed default, not an entry in a registry.
 *
 * NOTE THE COVERAGE COST, and do not soften it: prose that merely MENTIONS a
 * number is now undecidable, not consistent. Grepping a value out of a README is
 * as weak as grepping a constant out of source — the number could be a version,
 * a year, a port, an example. This pushes real L-A coverage BELOW the census's
 * 34%, and the manifest says so. */
const DATA_LINE_FRACTION = 0.9

function isDataShaped(text: string): boolean {
  try {
    const v = JSON.parse(text)
    if (v !== null && typeof v === "object") return true
  } catch {
    /* not JSON — fall through to the numeric-table grammar */
  }
  const lines = text.split("\n").filter((l) => l.trim().length > 0)
  if (lines.length === 0) return false
  const numericLines = lines.filter((l) => {
    const toks = l.trim().split(/[\s,;|]+/).filter((t) => t.length > 0)
    return toks.length > 0 && toks.every((t) => Number.isFinite(Number(t.replace(",", "."))))
  }).length
  return numericLines / lines.length >= DATA_LINE_FRACTION
}

/** §8.8 (ii) combination rule. Inconsistency VETOES. CONSISTENT requires at
 * least one deterministically consistent source and no inconsistent one.
 * Undecidable sources are never evidence and never a veto — they simply are not
 * witnesses. */
export function combineSourceVerdicts(checks: SourceCheck[]): LAVerdict {
  if (checks.some((c) => c.verdict === "inconsistent")) return "INCONSISTENT"
  if (checks.some((c) => c.verdict === "consistent")) return "CONSISTENT"
  return "NO-SOURCE"
}

function numbersIn(text: string): { value: number; text: string }[] {
  const out: { value: number; text: string }[] = []
  for (const m of text.matchAll(/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g)) {
    const v = Number(m[0])
    if (Number.isFinite(v)) out.push({ value: v, text: m[0] })
  }
  return out
}

/** §8.8(iii): "tolerance derived from the source artifact, never claimant- or
 * model-supplied." A bare REL_TOL would be author-supplied — the L-A analogue of
 * the delta we spent a week deriving out of the merge gate. Derived instead from
 * the SOURCE TOKEN'S OWN PRINTED PRECISION: a source that writes `1580.6`
 * asserts one decimal place, so agreement means agreement to half an ulp of that
 * representation. Reading the tolerance off the artifact is the whole point. */
function toleranceOf(token: string): number {
  const m = /\.(\d+)/.exec(token)
  const decimals = m ? m[1]!.length : 0
  // written case-insensitively rather than as a character class: `[eE](` reads
  // as a markdown link to the repo's doc-check, which scans inside code fences
  const expM = /e([-+]?\d+)/i.exec(token)
  const exp = expM ? Number(expM[1]) : 0
  return 0.5 * 10 ** (-decimals + exp)
}

function checkOne(path: string, claimValues: number[]): SourceCheck {
  let text: string
  try {
    const buf = readFileSync(path)
    if (buf.subarray(0, 8000).includes(0)) return { path, verdict: "undecidable", why: "binary source" }
    text = buf.toString("utf-8")
  } catch {
    return { path, verdict: "undecidable", why: "unreadable" }
  }
  // F2: decidable iff it parses as DATA. A program's source is undecidable here
  // whatever its extension — deciding it requires EXECUTION under a uniform
  // contract (§8.8), and reading constants out of source would be exactly the
  // pattern-matching-dressed-as-verification this module refuses.
  if (!isDataShaped(text)) {
    return { path, verdict: "undecidable", why: "not data-shaped: needs execution under a uniform contract (§8.8), not implemented" }
  }
  const found = numbersIn(text)
  if (found.length === 0) return { path, verdict: "undecidable", why: "no numeric content" }

  // §8.8 (iii): decided DETERMINISTICALLY harness-side. A model judging
  // claim-vs-source consistency is itself a downstream-of-decision statistic and
  // is never the sole arbiter of CROSSCHECKED.
  const matched = claimValues.filter((v) =>
    found.some((f) => Math.abs(f.value - v) <= toleranceOf(f.text)))
  if (matched.length === claimValues.length) {
    return { path, verdict: "consistent", why: `all ${claimValues.length} claim values appear in source` }
  }
  if (matched.length === 0) {
    return { path, verdict: "undecidable", why: "source numbers are unrelated to the claim" }
  }
  // F4: a veto is only credible from a data-shaped source, which is all that
  // reaches here now. A prose README mentioning one of 17 claim values (a port,
  // a year, a version) would otherwise convert into a veto against an otherwise
  // CONSISTENT claim — safe in direction, but it would make L-A fragile in
  // exactly the 34% of tasks where it exists at all.
  return { path, verdict: "inconsistent", why: `${matched.length}/${claimValues.length} claim values appear; source disagrees on the rest` }
}

/** Check the claim against EVERY eligible source (§8.8 ii, symmetric to §6.5).
 * The claimant never selects the checked source — source cherry-picking is
 * anchor cherry-picking one layer up. An unresolvable eligible set is
 * NO-SOURCE, never a partial check.
 *
 * `excludePath` drops the artifact the claim was DERIVED from: it is the
 * claim's own input, so it cannot contradict the claim (downstream-of-decision). */
export function crosscheckClaim(
  elig: EligibleSet, claimValues: number[], excludePath?: string,
): { verdict: LAVerdict; checks: SourceCheck[] } {
  if (!elig.ok) return { verdict: "NO-SOURCE", checks: [] }
  if (claimValues.length === 0) return { verdict: "NO-SOURCE", checks: [] }
  const checks = elig.files
    .filter((f) => f !== excludePath)
    .map((f) => checkOne(f, claimValues))
  return { verdict: combineSourceVerdicts(checks), checks }
}
```

- [ ] **Step 4: Run the tests, confirm they pass**

Run: `cd opencode-plugin && bun test test/bench-source-crosscheck.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
cd opencode-plugin && bun test 2>&1 | tail -5
cd .. && bun scripts/gate-check.ts
git add opencode-plugin/src/bench/source-crosscheck.ts opencode-plugin/test/bench-source-crosscheck.test.ts
git commit -m "$(cat <<'EOF'
feat(lane-a): L-A source crosscheck with full-source coverage (spec 8.8 ii/iii)

Every eligible artifact is checked; the claimant never selects the source.
Inconsistency vetoes; CONSISTENT needs one deterministically consistent source
and no inconsistent one; undecidable is neither evidence nor veto. Comparison is
deterministic harness-side — a model judging claim-vs-source consistency is
itself downstream of the decision. The claim's own input artifact is excluded.
Executable evaluators return undecidable: replay needs a uniform contract, and
per-task adapters are the named cheating class.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: value-truth.ts — CROSSCHECKED and the authority ladder

Spec §8.8 (i)+(iv) and the authority policy. **CROSSCHECKED is DEFINED as the conjunction** `mergeCheck.ok AND L-A verdict CONSISTENT` — one name, one predicate. The regression test asserting **each half alone is insufficient** is the point of the task: the F1/F2 wiring-bug class is a precondition that was implied rather than stated.

**Files:**
- Create: `opencode-plugin/src/bench/value-truth.ts`
- Test: `opencode-plugin/test/bench-value-truth.test.ts`

**Interfaces:**
- Consumes: `GateVerdict` (Task 9); `LAVerdict` (Task 11); `isLiteralFree` (Task 4).
- Produces:
  - `export type Authority = "numeric" | "criteria-class"`
  - `export interface LadderInput { gate: GateVerdict; la: LAVerdict; card: string }`
  - `export interface LadderResult { crosschecked: boolean; authority: Authority; inject: boolean; reason: string }`
  - `export function isCrosschecked(gate: GateVerdict, la: LAVerdict): boolean`
  - `export function applyLadder(input: LadderInput): LadderResult`

**F1 — the fix this task exists to carry (cross-lane review, CONFIRMED critical).** An earlier draft passed `claimValues` into the literal check, taking them from the model's own ANCHOR CLAIM block. That made §8.8(iv)'s enforcement **quantify over a set the audited party supplies** — the downstream-of-decision law at a fourth address, with the removal ritual performed on the DECODERS while the VALUE SET stayed claimant-owned. Zero-sophistication bypass: answer `FAMILY: none` (so `claimValues` is empty) and put the number in the prose. Every decoder is bypassed because the checker is asked to look for nothing.

**So a non-CROSSCHECKED card must contain NO decodable number at all.** The checked set is "every number", which nobody supplies. `claimValues` is gone from this module's inputs — not defaulted, not optional, gone.

**Why the harness-derived-set alternative was rejected** (anchor positions under both families ∪ claimed values): on the raman fixture it appears to work, because `1580.6` and the anchor's `1/x` value `1.5806e-4` share a mantissa, so decimal-relocation matching catches it. That is an arithmetic coincidence of *this fixture's* `1e7` relationship. Give the family a nonzero intercept and the mantissa relation vanishes along with the catch. A defence that works on the fixture we have and not on the general case is the §1 pattern; it was rejected on those grounds, not on cost.

**Accepted cost, stated honestly:** legitimate criteria cards can no longer say "there are 2 columns". Task 10's prompt is amended to ask for numeral-free criteria prose, which aligns the model's incentive instead of fighting it. The failure direction is refusal-to-inject — the conservative one.

- [ ] **Step 1: Write the failing tests**

Create `opencode-plugin/test/bench-value-truth.test.ts`:

```ts
import { test, expect } from "bun:test"
import { isCrosschecked, applyLadder } from "../src/bench/value-truth.ts"

const CLEAN = "Convert the first column before reporting; state which convention you used."
const DIRTY = "The peak is at 1580.6 in the converted axis."

// --- (i): CROSSCHECKED is the stated CONJUNCTION ----------------------------

test("CROSSCHECKED requires BOTH halves", () => {
  expect(isCrosschecked("accept", "CONSISTENT")).toBe(true)
})

test("the merge half ALONE is insufficient", () => {
  expect(isCrosschecked("accept", "NO-SOURCE")).toBe(false)
  expect(isCrosschecked("accept", "INCONSISTENT")).toBe(false)
})

test("the source half ALONE is insufficient", () => {
  expect(isCrosschecked("reject-residual", "CONSISTENT")).toBe(false)
  expect(isCrosschecked("reject-degenerate", "CONSISTENT")).toBe(false)
  expect(isCrosschecked("uncheckable", "CONSISTENT")).toBe(false)
})

// --- the authority ladder ---------------------------------------------------

test("CROSSCHECKED permits numeric injection", () => {
  const r = applyLadder({ gate: "accept", la: "CONSISTENT", card: DIRTY })
  expect(r.crosschecked).toBe(true)
  expect(r.authority).toBe("numeric")
  expect(r.inject).toBe(true)
})

test("NOT crosschecked forces criteria-class, and a numeric card is REFUSED", () => {
  const r = applyLadder({ gate: "accept", la: "NO-SOURCE", card: DIRTY })
  expect(r.authority).toBe("criteria-class")
  expect(r.inject).toBe(false)
  expect(r.reason).toContain("numeric literal")
})

test("NOT crosschecked with a genuinely literal-free card DOES inject", () => {
  const r = applyLadder({ gate: "uncheckable", la: "NO-SOURCE", card: CLEAN })
  expect(r.authority).toBe("criteria-class")
  expect(r.inject).toBe(true)
})

test("(iv) content enforcement uses the evasion-aware checker, not a digit regex", () => {
  const spelled = "The peak sits near one thousand five hundred eighty point six."
  expect(applyLadder({ gate: "accept", la: "NO-SOURCE", card: spelled }).inject).toBe(false)
})

// --- F1: the checked set is not the claimant's ------------------------------

test("F1 REGRESSION: FAMILY:none plus a numeric card cannot smuggle the value", () => {
  // the confirmed critical. The old signature took the claim's own value list,
  // so answering FAMILY:none emptied it and every decoder was asked to look for
  // nothing. There is now no input by which a caller can empty the checked set.
  const r = applyLadder({ gate: "uncheckable", la: "NO-SOURCE", card: DIRTY })
  expect(r.inject).toBe(false)
})

test("F1 REGRESSION: applyLadder has no claim-supplied value input at all", () => {
  // asserted structurally, so a future refactor cannot reintroduce the
  // quantifier by adding an optional parameter
  expect(applyLadder.length).toBe(1)
  const probe: Record<string, unknown> = { gate: "accept", la: "NO-SOURCE", card: DIRTY, claimValues: [] }
  expect(applyLadder(probe as any).inject).toBe(false) // an ignored extra field changes nothing
})

test("a decoy number unrelated to any claim still refuses a criteria-class card", () => {
  const r = applyLadder({ gate: "uncheckable", la: "NO-SOURCE", card: "Report the value 4242 in the converted axis." })
  expect(r.inject).toBe(false)
})

test("REPLICATED-only is not a status this ladder can express — numeric requires CROSSCHECKED, full stop", () => {
  // L-B is demoted and confers no numeric authority; there is deliberately no
  // input by which a caller could grant it
  const keys = Object.keys(applyLadder({ gate: "accept", la: "CONSISTENT", card: CLEAN }))
  expect(keys).toEqual(["crosschecked", "authority", "inject", "reason"])
})

test("an empty card never injects", () => {
  expect(applyLadder({ gate: "accept", la: "CONSISTENT", card: "   " }).inject).toBe(false)
})
```

- [ ] **Step 2: Run the tests, confirm they fail**

Run: `cd opencode-plugin && bun test test/bench-value-truth.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `value-truth.ts`**

```ts
/** §8.8 authority policy — the fail-closed ladder.
 *
 * CROSSCHECKED is DEFINED as the conjunction: mergeCheck.ok AND L-A verdict
 * CONSISTENT. One name, one predicate. The pairing check is never an implied
 * precondition — that implication is the F1/F2 wiring-bug class, where a gate
 * everyone believed was in the path was not.
 *
 * NUMERIC INJECTION REQUIRES CROSSCHECKED, FULL STOP. Everything else —
 * REPLICATED-only included — is criteria-class only. There is deliberately no
 * input by which a caller can grant numeric authority any other way: L-B
 * replication was DEMOTED because prior-driven fabrication is a stable
 * generator, so k same-draws are one witness, not k. Re-instating it needs the
 * registered falsifier probe, not a parameter.
 *
 * The coverage cost is accepted knowingly. The census says 34% of tasks have any
 * eligible second source at all; raman has none. A gate honest about where it
 * cannot act is worth more than one that acts everywhere. */
import type { GateVerdict } from "./merge-gate.ts"
import type { LAVerdict } from "./source-crosscheck.ts"
import { findAnyNumbers } from "./numeric-literal.ts"

export type Authority = "numeric" | "criteria-class"

export interface LadderInput {
  gate: GateVerdict
  la: LAVerdict
  card: string
}

export interface LadderResult {
  crosschecked: boolean
  authority: Authority
  inject: boolean
  reason: string
}

export function isCrosschecked(gate: GateVerdict, la: LAVerdict): boolean {
  return gate === "accept" && la === "CONSISTENT"
}

export function applyLadder(input: LadderInput): LadderResult {
  const crosschecked = isCrosschecked(input.gate, input.la)
  const authority: Authority = crosschecked ? "numeric" : "criteria-class"
  if (input.card.trim().length === 0) {
    return { crosschecked, authority, inject: false, reason: "empty card" }
  }
  if (crosschecked) {
    return { crosschecked, authority, inject: true, reason: `CROSSCHECKED (gate=${input.gate}, L-A=${input.la})` }
  }
  // §8.8 (iv): a non-CROSSCHECKED card must be numeric-literal-free BY
  // CONSTRUCTION. The checked set is EVERY decodable number, not the claim's own
  // fields: quantifying over a claimant-supplied set let `FAMILY: none` empty it
  // and walk the value through in prose (F1). Nobody supplies "every number", so
  // nobody can shrink it.
  const hits = findAnyNumbers(input.card)
  if (hits.length > 0) {
    return {
      crosschecked,
      authority,
      inject: false,
      reason: `criteria-class card states a numeric literal (${hits[0]!.encoding}: "${hits[0]!.text}") — refused`,
    }
  }
  return { crosschecked, authority, inject: true, reason: `criteria-class (gate=${input.gate}, L-A=${input.la})` }
}
```

- [ ] **Step 4: Run the tests, confirm they pass**

Run: `cd opencode-plugin && bun test test/bench-value-truth.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
cd opencode-plugin && bun test 2>&1 | tail -5
cd .. && bun scripts/gate-check.ts
git add opencode-plugin/src/bench/value-truth.ts opencode-plugin/test/bench-value-truth.test.ts
git commit -m "$(cat <<'EOF'
feat(lane-a): CROSSCHECKED conjunction and the authority ladder (spec 8.8)

CROSSCHECKED is defined as mergeCheck.ok AND L-A CONSISTENT — one name, one
predicate, with regression tests asserting each half alone is insufficient (the
F1/F2 implied-precondition class). Numeric injection requires CROSSCHECKED, full
stop; there is deliberately no input by which a caller could grant numeric
authority from replication alone. Non-CROSSCHECKED cards are checked
literal-free with the evasion-aware decoder before injection.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: wire the gate into `runAuditUncached`

Replace the `revalidate()` path with: read the series → detect anchors → put them in the prompt → parse the ANCHOR CLAIM → derive noise → `mergeGate` → `crosscheckClaim` → `applyLadder`. Delete the old `revalidate`, `RevalClaim`, `RevalLanding`, `applyTransform`, `RevalTransform`, `parseRevalBlock`, `stripRevalBlock`, `REVAL_MARKER`, and their tests.

**Deleting rather than deprecating is deliberate:** `revalidate()` has a demonstrated total bypass (`canonical = computed` passes anything). Leaving it importable leaves the bypass one call site away.

**Files:**
- Modify: `opencode-plugin/src/bench/convention-audit.ts`
- Modify: `opencode-plugin/test/bench-convention-audit.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1, 2, 5, 7, 9, 11, 12.
- Produces:
  - `AuditResult` gains `gate?: GateVerdict`, `la?: LAVerdict`, `authority?: Authority`, `ladderReason?: string`; `reval`/`revalReason` are removed.
  - `export function buildAnchorContext(paths: BenchPaths, task: string): { block: string; noise: SeriesNoise; seriesPath: string } | null` — `null` when no unambiguous series exists.

- [ ] **Step 1: Write the failing integration tests**

Append to `opencode-plugin/test/bench-convention-audit.test.ts`. Follow the file's existing fake-daemon pattern (`deps: { call, ensure, close }`).

```ts
import { runAuditUncached, _resetAuditCache } from "../src/bench/convention-audit.ts"

function fakeDeps(replyText: string) {
  return {
    ensure: async () => ({}) as any,
    close: async () => {},
    call: async () => ({
      kind: "ok" as const, text: replyText, sessionId: "s1",
      stopReason: "end_turn", model: "claude-sonnet-5", canonicalModel: "claude-sonnet-5",
    }) as any,
  }
}

test("a NO-SOURCE task with a numeric card is REFUSED at the ladder", async () => {
  _resetAuditCache()
  // raman-class: one artifact, so L-A is structurally NO-SOURCE
  const reply = "CONTENT VERDICT: MISMATCH\nThe axis is at 1580.6.\n\nANCHOR CLAIM:\nFAMILY: inv-x\nCANONICALS: 1580.6, 2700.1, 1350.0\n"
  const r = await runAuditUncached(PATHS, "raman-fitting-audit", {}, fakeDeps(reply))
  expect(r.card).toBe(null)
  expect((r as any).authority).toBe("criteria-class")
})

test("a criteria-class abstention still injects when the card is literal-free", async () => {
  _resetAuditCache()
  const reply = "CONTENT VERDICT: MISMATCH\nState which unit convention you report in.\n\nANCHOR CLAIM:\nFAMILY: none\n"
  const r = await runAuditUncached(PATHS, "raman-fitting-audit", {}, fakeDeps(reply))
  expect(r.card).not.toBe(null)
  expect(r.card).not.toContain("ANCHOR CLAIM")
})

test("the ANCHOR CLAIM block never reaches the injected card", async () => {
  _resetAuditCache()
  const reply = "CONTENT VERDICT: MISMATCH\nConvert before reporting.\n\nANCHOR CLAIM:\nFAMILY: none\n"
  const r = await runAuditUncached(PATHS, "raman-fitting-audit", {}, fakeDeps(reply))
  expect(r.card ?? "").not.toContain("FAMILY")
})

test("revalidate and its whitelist are GONE (the bypass cannot be reached)", async () => {
  const mod: any = await import("../src/bench/convention-audit.ts")
  for (const gone of ["revalidate", "applyTransform", "parseRevalBlock", "stripRevalBlock", "REVAL_MARKER"]) {
    expect(mod[gone]).toBeUndefined()
  }
})

test("the audit trail records gate, L-A and authority", async () => {
  _resetAuditCache()
  const reply = "CONTENT VERDICT: MISMATCH\nConvert before reporting.\n\nANCHOR CLAIM:\nFAMILY: none\n"
  const r = await runAuditUncached(PATHS, "raman-fitting-audit", {}, fakeDeps(reply))
  expect((r as any).la).toBeDefined()
  expect((r as any).authority).toBeDefined()
})
```

Define `PATHS` the way the existing tests in this file already do — reuse that helper rather than inventing a second one.

- [ ] **Step 2: Run the tests, confirm they fail**

Run: `cd opencode-plugin && bun test test/bench-convention-audit.test.ts`
Expected: FAIL — `revalidate` still exported; `authority` undefined.

- [ ] **Step 3: Rewrite the audit path**

In `convention-audit.ts`: delete `RevalTransform`, `applyTransform`, `RevalLanding`, `RevalClaim`, `RevalOutcome`, `revalidate`, `ParsedReval`, `REVAL_TRANSFORMS`, `REVAL_MARKER`, `parseRevalBlock`, `stripRevalBlock`. Point `cardFrom` at `stripAnchorClaim`. Add:

```ts
import { eligibleArtifacts } from "./eligibility.ts"
import { selectSeries } from "./series-source.ts"
import { detectPeaksTracked, type PeakTrack } from "./series-peaks.ts"
import { FIT_FAMILY } from "./reval-fit.ts"
import { deriveSeriesNoise, sigmaFraction, VALIDATED_SIGMA_FRACTION, type SeriesNoise } from "./noise-sigma.ts"
import { mergeGate, type GateVerdict } from "./merge-gate.ts"
import { crosscheckClaim, type LAVerdict } from "./source-crosscheck.ts"
import { applyLadder, type Authority } from "./value-truth.ts"

/** Harness-side anchor enumeration (§6.1 + §8.9). Reads the FULL numeric series
 * from the single unambiguous eligible artifact — separate from the audit
 * sample, which truncates to head/tail by design and cannot support a detector.
 * Returns null when no unambiguous series exists; the caller then runs the audit
 * with no anchor block and can only reach criteria-class. */
export function buildAnchorContext(
  paths: BenchPaths, task: string,
): { block: string; noise: SeriesNoise; seriesPath: string } | null {
  const elig = eligibleArtifacts(paths, task)
  const sel = selectSeries(elig)
  if (!sel.ok) return null
  const tracks = detectPeaksTracked(sel.ys)
  if (tracks.length < 3) return null
  const noise = deriveSeriesNoise(sel.xs, sel.ys, tracks, (x) => x)
  return { block: anchorPromptBlock(noise.us), noise, seriesPath: sel.path }
}
```

Then in `runAuditUncached`, replace the revalidation gate block (currently `convention-audit.ts:459-470`) with:

```ts
    const anchors = buildAnchorContext(paths, task)
    const parsed = parseAnchorClaim(outcome.text)
    const card = cardFrom(outcome.text)

    // Family choice selects the u transform; the family is FROZEN at two
    // members (§6.2) and a wrong choice is residual-visible, which is why it can
    // stay frozen instead of growing per task.
    let gate: GateVerdict = "uncheckable"
    let claimValues: number[] = []
    if (parsed.kind === "claim" && anchors) {
      claimValues = parsed.canonicals
      // Q4 residual, closed: sigmaFraction is claim-free per family, but the
      // CLAIMANT PICKS THE FAMILY, so it selects between two artifact-derived
      // boundary ratios — a claim uncheckable under x could be checkable under
      // inv-x. Bounded (a binary choice among harness-derived quantities, no
      // influence on values), but free is free. Require the validated domain
      // under BOTH frozen members before grading under the claimed one, and the
      // choice buys nothing.
      const perFamily = FIT_FAMILY.map((f) =>
        deriveSeriesNoise(anchors.xs, anchors.ys, anchors.tracks, f.u))
      const allInDomain = perFamily.every(
        (nz) => sigmaFraction(nz.us, nz.sigmaU) <= VALIDATED_SIGMA_FRACTION)
      if (allInDomain) {
        const u = parsed.family === "inv-x" ? (x: number) => 1 / x : (x: number) => x
        const noise = deriveSeriesNoise(anchors.xs, anchors.ys, anchors.tracks, u)
        gate = mergeGate(noise, parsed.canonicals).verdict
      }
    }

    const la = anchors
      ? crosscheckClaim(eligibleArtifacts(paths, task), claimValues, anchors.seriesPath).verdict
      : ("NO-SOURCE" as LAVerdict)

    const ladder = applyLadder({ gate, la, card })
    if (!ladder.inject) {
      return {
        card: null, rawAudit: outcome.text, verdict: "MISMATCH",
        gate, la, authority: ladder.authority, ladderReason: ladder.reason, sample, truncated,
      }
    }
    return {
      card, rawAudit: outcome.text, verdict: "MISMATCH",
      gate, la, authority: ladder.authority, ladderReason: ladder.reason, sample, truncated,
    }
```

`buildAnchorContext` must also return the raw `xs`, `ys` and `tracks` so the family-specific noise can be re-derived — widen its return type to `{ block: string; noise: SeriesNoise; seriesPath: string; xs: number[]; ys: number[]; tracks: PeakTrack[] }` and read `anchorXs`/`anchorYs`/`anchorTracks` from it.

Append `anchors.block` to the prompt at the call site:

```ts
    const anchorSuffix = anchors ? "\n\n" + anchors.block : ""
    const outcome = await call(auditPrompt() + "\n\n" + sample + anchorSuffix, AUDIT_MODEL, auditEnv, { ... })
```

Update `AuditResult` and `writeAuditTrail` to carry `gate`, `la`, `authority`, `ladderReason` in place of `reval`/`revalReason`.

- [ ] **Step 4: Run the tests, confirm they pass**

Run: `cd opencode-plugin && bun test test/bench-convention-audit.test.ts`
Expected: PASS. Then `grep -rn "revalidate\|REVAL_MARKER\|applyTransform" opencode-plugin/src` must return nothing.

- [ ] **Step 5: Confirm nothing armed**

Run: `grep -n "conventionAudit" opencode-plugin/src/bench/cmd-run.ts opencode-plugin/src/bench/cli.ts`
Expected: the default is still `false` / `undefined`. **If this task changed it, revert that change** — arming is its own go.

- [ ] **Step 6: Commit**

```bash
cd opencode-plugin && bun test 2>&1 | tail -5
cd .. && bun scripts/gate-check.ts
git add opencode-plugin/src/bench/convention-audit.ts opencode-plugin/test/bench-convention-audit.test.ts
git commit -m "$(cat <<'EOF'
feat(lane-a)!: replace revalidate() with the merge gate + value-truth ladder

The audit path now enumerates anchors harness-side from the full series, grades
the claim with the chi-square predicate over the FULL anchor set, crosschecks
against every eligible source, and gates injection on the CROSSCHECKED
conjunction. revalidate() and its transform whitelist are DELETED, not
deprecated: the bypass is demonstrated (canonical = computed passes anything),
so leaving it importable leaves the bypass one call site away.

conventionAudit stays default-off. Arming is a separate go.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: real-fixture end-to-end — the gate on raman and on a multi-source task

The unit tests prove each piece. This proves the composition on real task trees, and pins the honest outcome: **raman gets criteria-class, never numeric.**

**Files:**
- Modify: `opencode-plugin/test/bench-dnc-integration.test.ts` (append)

**Interfaces:**
- Consumes: `buildAnchorContext`, `applyLadder`, `crosscheckClaim`, `eligibleArtifacts`, `mergeGate`.
- Produces: nothing importable.

- [ ] **Step 1: Write the tests**

Append to `opencode-plugin/test/bench-dnc-integration.test.ts`:

```ts
import { buildAnchorContext } from "../src/bench/convention-audit.ts"
import { eligibleArtifacts } from "../src/bench/eligibility.ts"
import { crosscheckClaim } from "../src/bench/source-crosscheck.ts"
import { mergeGate } from "../src/bench/merge-gate.ts"
import { applyLadder } from "../src/bench/value-truth.ts"

const PROBE_ROOT = "term-bench2/probe-tasks"

test("raman: the harness enumerates 17 anchors from the real fixture", () => {
  const ctx = buildAnchorContext({ tbRoot: PROBE_ROOT } as any, "raman-fitting-audit")
  expect(ctx).not.toBeNull()
  expect(ctx!.noise.us.length).toBe(17)
  expect(ctx!.block).toContain("17 anchors")
})

test("raman is structurally NO-SOURCE, so an honest claim is STILL criteria-class only", () => {
  // the honest outcome of this whole increment, pinned. A gate that granted
  // numeric authority here would be claiming a guarantee §6 does not have.
  const ctx = buildAnchorContext({ tbRoot: PROBE_ROOT } as any, "raman-fitting-audit")!
  const honest = ctx.noise.us.map((u) => 10 + 2.0 * u)
  const gate = mergeGate(ctx.noise, honest).verdict
  const la = crosscheckClaim(eligibleArtifacts({ tbRoot: PROBE_ROOT } as any, "raman-fitting-audit"), honest, ctx.seriesPath).verdict
  expect(la).toBe("NO-SOURCE")
  const r = applyLadder({ gate, la, card: "Convert before reporting." })
  expect(r.crosschecked).toBe(false)
  expect(r.authority).toBe("criteria-class")
})

test("F1 STANDING REGRESSION on the real tree: FAMILY:none cannot smuggle a value", () => {
  // the confirmed critical, end to end. FAMILY:none leaves the gate uncheckable
  // and L-A NO-SOURCE; the card must still be refused for stating the number.
  const r = applyLadder({
    gate: "uncheckable", la: "NO-SOURCE",
    card: "The converted axis places the main feature at 1580.6.",
  })
  expect(r.inject).toBe(false)
  expect(r.reason).toContain("numeric literal")
})

test("a fabricated-but-consistent claim reaches the SAME criteria-class ceiling", () => {
  // V5's value-fab, end to end: geometry accepts it, the ladder still refuses
  // numeric authority. This is §6's threat split doing its job.
  const ctx = buildAnchorContext({ tbRoot: PROBE_ROOT } as any, "raman-fitting-audit")!
  const fabricated = ctx.noise.us.map((u) => 4242 + 7 * u)
  const gate = mergeGate(ctx.noise, fabricated).verdict
  const r = applyLadder({ gate, la: "NO-SOURCE", card: "Convert before reporting." })
  expect(r.authority).toBe("criteria-class")
  expect(r.inject).toBe(true) // the card is literal-free, so the criteria card ships
})

test("a shifted claim is rejected by the gate before the ladder is consulted", () => {
  const ctx = buildAnchorContext({ tbRoot: PROBE_ROOT } as any, "raman-fitting-audit")!
  const honest = ctx.noise.us.map((u) => 10 + 2.0 * u)
  const shifted = [...honest.slice(1), honest[honest.length - 1]! + 2.0]
  expect(mergeGate(ctx.noise, shifted).verdict).not.toBe("accept")
})

test("a partial anchor claim is uncheckable — §6.5 full coverage enforced end to end", () => {
  const ctx = buildAnchorContext({ tbRoot: PROBE_ROOT } as any, "raman-fitting-audit")!
  const three = ctx.noise.us.slice(0, 3).map((u) => 10 + 2.0 * u)
  expect(mergeGate(ctx.noise, three).verdict).toBe("uncheckable")
})
```

- [ ] **Step 2: Run them**

Run: `cd opencode-plugin && bun test test/bench-dnc-integration.test.ts`
Expected: PASS.

Facts about this fixture the implementer will otherwise rediscover the hard way (all verified 2026-08-21): its Dockerfile is `FROM` + `WORKDIR` + `COPY task-deps/ ./`, so the eligible set is exactly `{graphene.dat}` and the crosscheck — which excludes the claim's own input — sees an EMPTY source list, which is why raman is NO-SOURCE. `graphene.dat` is 3565 rows, TAB-separated, uses **EU decimal commas** (`47183,554644`), and its x column **descends**. `parseSeries` splits on `\s+` and `numToken` handles the comma; `deriveSeriesNoise` takes `|xs[1]-xs[0]|` and `mergeAccept` sorts by `us`, so descent is already handled — do not "fix" it by reversing the series.

If `buildAnchorContext` returns `null` for `raman-fitting-audit`, print `eligibleArtifacts(...)` and `selectSeries(...)` for that task and read the reason before changing any threshold. A `no-series` or `ambiguous` here is a real finding about the probe task's tree, not a number to tune — record it in the Task 15 addendum.

- [ ] **Step 3: Commit**

```bash
cd opencode-plugin && bun test 2>&1 | tail -5
cd .. && bun scripts/gate-check.ts
git add opencode-plugin/test/bench-dnc-integration.test.ts
git commit -m "$(cat <<'EOF'
test(lane-a): end-to-end gate + ladder on the real raman tree

Pins the honest outcome: raman is single-artifact, therefore NO-SOURCE,
therefore criteria-class only — an honest claim and a consistently fabricated
one hit the same ceiling. Also pins §6.5 full coverage end to end: a claim over
3 of 17 anchors is uncheckable, not a pass.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 16: extent-tolerance certificates for the unswept constants (F3)

Cross-lane review's F3: `REG_LEVEL` earned a measured non-load-bearing certificate; four other constants did not, and they sit exactly where the next architect review will drill. None is an answer key. All are asserted-stable and never swept, which by this project's own standard is a claim without evidence.

**The constants:** the detector quartet (90th-percentile threshold, ≥5-scale persistence, ≤3 match distance, the 5..101 window range) — a code comment asserts "NEVER tuned", which is a statement about intent, not a measurement; and `DATA_LINE_FRACTION = 0.9` in `source-crosscheck.ts` plus the 0.9 parse-coverage bound in `selectSeries`.

**The certificate:** for each constant, sweep it across a wide unchosen range and show the VERDICTS on the pinned cases do not move. Same argument that retired `R_THRESHOLD_PLACEHOLDER` — a constant whose neighbourhood is flat is not load-bearing, and the flatness is measured, not asserted. A constant whose verdicts DO move is load-bearing and must be derived or declared, not left in place.

**Files:**
- Create: `opencode-plugin/test/bench-constant-sweeps.test.ts`
- Modify: `docs/loop-probes/arming-increment-20260821/regression-manifest.md` (record the measured extents)

- [ ] **Step 1: Write the sweep test**

```ts
/** F3 extent-tolerance certificates. Each constant is swept across a range far
 * wider than any plausible tuning, asserting the pinned verdicts do not move.
 * A sweep that DOES move a verdict is a finding: that constant is load-bearing
 * and needs a derivation, not a comment saying it was never tuned. */
import { test, expect } from "bun:test"
import { detectPeaksTracked } from "../src/bench/series-peaks.ts"
import { readSeriesFile } from "../src/bench/series-source.ts"

const GRA = "term-bench2/probe-tasks/raman-fitting-audit/environment"

test("detector persistence floor: anchor count is stable across 3..12 scales", () => {
  const { ys } = readSeriesFile(`${GRA}/task-deps/graphene.dat`, GRA)
  // detectPeaksTracked must accept the floor as a parameter for this sweep;
  // default stays 5. Record every count in the manifest, not just the spread.
  const counts = [3, 4, 5, 6, 8, 10, 12].map((k) => detectPeaksTracked(ys, { persistence: k }).length)
  expect(new Set(counts).size).toBe(1)
})

test("detector match distance: anchor count is stable across 1..8 samples", () => {
  const { ys } = readSeriesFile(`${GRA}/task-deps/graphene.dat`, GRA)
  const counts = [1, 2, 3, 4, 6, 8].map((d) => detectPeaksTracked(ys, { matchDistance: d }).length)
  expect(new Set(counts).size).toBe(1)
})

test("detector percentile threshold: anchor count is stable across 0.80..0.95", () => {
  const { ys } = readSeriesFile(`${GRA}/task-deps/graphene.dat`, GRA)
  const counts = [0.80, 0.85, 0.90, 0.95].map((p) => detectPeaksTracked(ys, { percentile: p }).length)
  expect(new Set(counts).size).toBe(1)
})
```

Widen `detectPeaksTracked` to `detectPeaksTracked(ys, opts?: { persistence?: number; matchDistance?: number; percentile?: number })`, defaulting to the pre-registered values so no production behaviour changes.

- [ ] **Step 2: Run the sweeps and RECORD WHAT THEY SAY**

Run: `cd opencode-plugin && bun test test/bench-constant-sweeps.test.ts`

**If a sweep fails, that is the deliverable, not a defect to tune away.** Do not narrow the range to make it pass. Record the measured extent in the manifest (`stable over X..Y, moves at Z`) and flag the constant as load-bearing for the next review. A constant with a narrow stable region is exactly what this task exists to surface.

- [ ] **Step 3: Commit**

```bash
cd opencode-plugin && bun test 2>&1 | tail -5
cd .. && bun scripts/gate-check.ts
git add opencode-plugin/src/bench/series-peaks.ts opencode-plugin/test/bench-constant-sweeps.test.ts
git commit -m "$(cat <<'EOF'
test(lane-a): extent-tolerance certificates for the unswept constants (F3)

The chi-square level earned a measured non-load-bearing certificate; the
detector quartet and the two 0.9 bounds never did — a comment asserting "never
tuned" states intent, not evidence. Each is now swept across a range wider than
any plausible tuning, asserting the pinned verdicts do not move. A sweep that
moves a verdict is a finding to record, never a range to narrow.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: regression manifest, spec addendum, resume handoff

**Files:**
- Create: `docs/loop-probes/arming-increment-20260821/regression-manifest.md`
- Create: `docs/superpowers/specs/2026-08-20-dnc-design-addendum-arming.md`
- Modify: `docs/resume.md` (**`git add -p` only**)

- [ ] **Step 1: Write the regression manifest**

Create `docs/loop-probes/arming-increment-20260821/regression-manifest.md` listing, for each spec clause, the test that pins it:

```markdown
# Arming increment — regression manifest (2026-08-21)

What pins each closed-spec clause. A clause with no row is unimplemented, not
implicitly satisfied.

| Spec clause | Pinned by |
|---|---|
| §6.1 mechanical divide, survivor set never trimmed | `bench-series-peaks.test.ts` (17 anchors, tracked == untracked) |
| §6.2 frozen family {x, 1/x} | `bench-reval-fit.test.ts` FIT_FAMILY enforcement |
| §6.4 derived automorphisms + fixed ±1 | `bench-reval-fit.test.ts` T1/T10 floor via `mergeAccept` |
| §6.5 full-anchor coverage | `bench-merge-gate.test.ts` count mismatch → uncheckable; `bench-dnc-integration.test.ts` 3-of-17 |
| §6 scope: rejects ERROR, never DECEPTION | `bench-derived-thresholds.test.ts` V5 asserts ACCEPT |
| §8.2(a) quantifier bound to derived + fixed ±1 | `bench-reval-fit.test.ts` asymmetric → no automorphisms, still accepts |
| §8.2(b) validated domain, UNCHECKABLE outside | `bench-merge-gate.test.ts` domain tests + V7 sweep |
| §8.2(c) sigma estimator is the single external input | `bench-noise-sigma.test.ts` (sigma_y on both fixtures) |
| §8.2 derived predicate replaces R | `bench-derived-thresholds.test.ts` V1–V11 + level sweep |
| §8.8(i) CROSSCHECKED conjunction, each half insufficient | `bench-value-truth.test.ts` |
| §8.8(ii) full-source coverage + combination rule | `bench-source-crosscheck.test.ts` |
| §8.8(iii) deterministic CONSISTENT, no model arbiter | `bench-source-crosscheck.test.ts` (no daemon import) |
| §8.8(iv) numeric-literal-free incl. evasion encodings | `bench-numeric-literal.test.ts` + `fixtures/evasion-cards.json` |
| §8.8(iv) checked set is NOT claimant-supplied (F1) | `bench-value-truth.test.ts` FAMILY:none regressions + `bench-dnc-integration.test.ts` |
| §8.8(v) pristine pre-execution snapshot | `bench-eligibility.test.ts` (reads task-definition tree only) |
| §8.8 authority ladder, numeric requires CROSSCHECKED | `bench-value-truth.test.ts` + `bench-dnc-integration.test.ts` |
| §8.8 executable subclass never text-judged (F2) | `bench-source-crosscheck.test.ts` (.py/.lua/.jl/extensionless all undecidable) |
| §8.9 full-series data path | `bench-series-source.test.ts` `selectSeries` |
| Constant extents measured, not asserted (F3) | `bench-constant-sweeps.test.ts` |

## Coverage, honestly restated after review

The census's 34% multi-artifact figure is an UPPER BOUND on L-A coverage, not the
coverage. Two review findings cut it further, both deliberately:

- **F2** — a source is decidable only if it parses as DATA. Program sources are
  undecidable whatever their extension, which is the spec's own rule finally
  enforced structurally rather than by an extension list.
- **F4/prose** — a file that merely MENTIONS a number is undecidable, not
  consistent. Grepping a value out of a README is as weak as grepping a constant
  out of source.

Real coverage is therefore below 34% and is not yet measured. **Measuring it is a
follow-on**: re-run `census-gen.py` against `isDataShaped` rather than against
file counts. Until then the manifest claims no number.

## Not implemented (named, not silently skipped)

- **Executable-evaluator L-A subclass** — returns `undecidable`. Needs a uniform
  invocation contract; per-task adapters are the named cheating class.
- **L-B replication** — demoted by the spec; no code path can grant it numeric
  authority, by construction.
- **Second fixture for the sigma ESTIMATOR** — §8.2(c) says the next fixture
  class (heteroscedastic / peak-correlated noise) tests the estimator, not just
  the predicate. Both current fixtures are homoscedastic. Open transfer debt.
  **Cross-reference (cross-lane review, Q4):** the `inv-x` family member makes
  `sigma_u` heteroscedastic by construction, while V7's validation was
  homoscedastic — so every `inv-x` claim already rides this debt, not just a
  hypothetical future fixture.
- **A bad set the checker's author did not write** — `evasion-cards.json` shares
  an author with the decoders it tests, so it cannot falsify them (the L-B
  shared-prior argument, applied to us). Needs generator diversity; that is
  spend, with its own go.
- **True L-A coverage under the tightened decidability rule** — see above.

## Known imprecision, recorded rather than fixed

`mergeAccept` returns `reject-degenerate` both when an attack was caught (V1) and
when the geometry simply cannot discriminate (V2, an honest claim on equal
spacing). The harness cannot distinguish these — both are "an alternate also
fits" — but the NAME reads as "you are wrong" where the design language insists
uncheckable ≠ wrong. The verdict string stays as-is because Task 8 pins it to
derive.py; the audit trail should surface the degenerate case as
UNCHECKABLE-GEOMETRY in its reason text so the record does not overclaim.

## Reference

`python3 -B docs/loop-probes/derived-thresholds-20260821/derive.py` — 11/11,
re-verified 2026-08-21. The TS port is pinned to it case-for-case by
`bench-derived-thresholds.test.ts`.
```

- [ ] **Step 2: Write the spec addendum**

Create `docs/superpowers/specs/2026-08-20-dnc-design-addendum-arming.md` recording the four implementation decisions the spec left open, each with its reason: (1) the strict Dockerfile manifest and why neither existing parser was reusable; (2) `sigmaFraction` computed in u-space and the algebraic equality that makes it faithful; (3) `sigma_y` computed but not fed to the predicate, matching the validated reference; (4) structural series selection with ambiguity refused. **Never edit the spec itself — addendum only.**

- [ ] **Step 3: Update `docs/resume.md`**

Add a MOST RECENT block: what shipped, that `conventionAudit` is still default-off and arming is unspent, and the three open items from the manifest. **`git add -p docs/resume.md` then `git diff --cached` before committing** — the sibling lane writes this file.

- [ ] **Step 4: Final verification and commit**

```bash
cd opencode-plugin && bun test 2>&1 | tail -6   # expect 0 fail
cd .. && bun scripts/gate-check.ts
python3 -B docs/loop-probes/derived-thresholds-20260821/derive.py | grep -c "OK"   # expect 8 (the tagged cases)
grep -rn "revalidate\|R_THRESHOLD_PLACEHOLDER" opencode-plugin/src   # expect nothing
git add docs/loop-probes/arming-increment-20260821/ docs/superpowers/specs/2026-08-20-dnc-design-addendum-arming.md
git add -p docs/resume.md
git diff --cached          # inspect: no sibling-lane content
git commit -m "$(cat <<'EOF'
docs(lane-a): arming increment regression manifest + spec addendum

Maps each closed-spec clause to the test that pins it, and names what is NOT
implemented (executable-evaluator replay, L-B numeric authority, the
heteroscedastic fixture that would test the sigma estimator rather than the
predicate) so absence never reads as coverage.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-review

**Spec coverage.** §6.1 → T2/T14. §6.2 → untouched, still enforced. §6.3 delta → `mergeCheck` retains it; the chi² path supersedes it for the armed gate and both now share one degeneracy definition (T6). §6.4 → T6 (`enumerateAutomorphisms` unchanged, quantifier bound). §6.5 → T9/T14. §6 threat split → T8 V5, T14. §8.2(a)(b)(c) → T6/T9/T5. §8.8(i)–(v) → T12/T11/T11/T4+T12/T1. §8.8 ladder → T12. §8.9 → T7/T13. §8.3 bad sets → T4's evasion fixture, T8's V9 out-of-family. §8.5 family enforcement → untouched, still enforced by `FIT_FAMILY`'s type.

**Known gaps, all named in the Task 15 manifest rather than left implicit:** executable-evaluator replay; the heteroscedastic fixture that would test the sigma estimator rather than the predicate; §8.7 (score the F3 O4 arm) is out of this increment's scope and stays on the spec's obligation list.

**Type consistency.** `PeakTrack` (T2) → T5, T13. `SeriesNoise` (T5) → T9, T13. `GateVerdict` (T9) → T12, T13. `LAVerdict` (T11) → T12, T13. `EligibleSet` (T1) → T7, T11. `Authority` (T12) → T13. `REG_LEVEL` defined once in T3, defaulted in T6, passed in T9. `VALIDATED_SIGMA_FRACTION` defined once in T5, read once in T9.

**One deliberate breaking change:** T6 deletes `conditioningCheck`/`R_THRESHOLD_PLACEHOLDER` and T13 deletes `revalidate` and the transform whitelist. Both are exported today. Nothing outside `opencode-plugin` imports them (`reval-fit.ts` ships OFF; `revalidate` is called only from `runAuditUncached`), so the blast radius is the two test files the tasks already update.
