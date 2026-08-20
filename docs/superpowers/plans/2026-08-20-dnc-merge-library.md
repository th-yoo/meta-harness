# D&C Merge/Divide Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the D&C spec's divide/merge machinery as a standalone, ships-OFF library in opencode-plugin — mechanical peak divide, over-determined merge with derived delta, derived-automorphism conditioning check — plus the spec's §8 validation obligations (out-of-family bad set, family-addition enforcement, noise sweep, O4 scoring, second fixture).

**Architecture:** Three focused modules under `opencode-plugin/src/bench/` (pure functions, no daemon, no model calls): `series-source.ts` (leak-safe numeric-series read + parse), `series-peaks.ts` (scale-persistent peak detection), `reval-fit.ts` (affine fit, derived delta, derived-automorphism conditioning check, full-coverage merge check). Nothing is wired into `cmd-run.ts` or the shipped audit path — arming is a future increment with its own gos. Validation artifacts (noise sweep, second fixture, O4 scoring) live under `docs/loop-probes/` as pre-registered probe extensions.

**Tech Stack:** Bun + TypeScript, bun:test, stdlib only (no new dependencies). Python probe stays as the original record; new machinery is TS.

**Spec:** `docs/superpowers/specs/2026-08-20-dnc-design.md` (amended through 3fb9ff9). Probe evidence: `docs/loop-probes/dnc-merge-fit-20260820/` (T1–T10).

## Global Constraints

- SHIPS OFF: no file in this plan may import from or be imported by `cmd-run.ts`, `convention-audit.ts`, or any driver — the library stands alone until an arming increment.
- Work directly on `main`. NO branch/worktree operations (shared checkout with a sibling session; a checkout squats HEAD under them — measured 2026-08-20).
- Do NOT push. Zero model-token spend anywhere in this plan.
- Full suite (`cd opencode-plugin && bun test`) green at every task boundary; `bun scripts/gate-check.ts` (repo root) green before every commit (doc-check runs on .md files — every fenced code block needs a matching closing fence).
- Never edit committed verdict/pre-registration files under `docs/loop-probes/` — new files (addenda) only.
- Never `git add docs/resume.md` without `git add -p` + `git diff --cached` inspection (shared file).
- Frozen family is exactly `u ∈ {x, 1/x}` (spec §6.2) — no additions in this plan.
- The conditioning check's alternate set has TWO components with distinct jobs (spec §6.4 as amended): DERIVED automorphisms — the symmetry defence, correctly EMPTY on asymmetric geometry because a wrong pairing can only fit well by composing with a symmetry, so no symmetry = no attack surface in that class — plus the FIXED ±1-index-shift pair as the minimal-misassignment distinguishability reference (fixed BEFORE any attack existed and never grown in response to one; reversal is NOT in the fixed set — it comes from the derived component when the geometry has mirror symmetry). {T1, T10} are the regression floor.
- R threshold 3 is a PLACEHOLDER pending the §8.2 noise rule — name it `R_THRESHOLD_PLACEHOLDER` in code so no reader mistakes it for a validated constant.
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## Task DAG

```
G1 (independent, may run in any order):   T1 reval-fit core   T5 series-peaks   T6 series-source   T9 O4 scoring
G2 (after T1):                            T2 conditioning check
G3 (after T2):                            T3 merge check
G4 (after T3, mutually independent):      T4 out-of-family bad set   T7 family enforcement   T10 noise sweep
G5 (after T3+T5+T6+T7):                   T8 real-fixture integration
G6 (after T8):                            T11 second fixture
G7 (last):                                T12 docs + resume
```

Execution note: the shared checkout serializes implementers (never dispatch two in parallel — same working tree, same test suite). The DAG is the dispatch ORDER constraint and shows what could parallelize under future worktree isolation; within a group, batch small same-shape tasks into one dispatch where sensible (T5+T6 are one dispatch candidate).

---

### Task 1: reval-fit core — fitAffine + deriveDelta

**Files:**
- Create: `opencode-plugin/src/bench/reval-fit.ts`
- Test: `opencode-plugin/test/bench-reval-fit.test.ts`

**Interfaces:**
- Consumes: nothing (pure functions).
- Produces (later tasks import these exact names from `../src/bench/reval-fit.ts`):
  - `export interface AffineFit { a: number; b: number; rms: number }`
  - `export function fitAffine(us: number[], cs: number[]): AffineFit`
  - `export function deriveDelta(us: number[], b: number): number` — `|b| * minΔu / 2` over sorted us; throws `RangeError` if `us.length < 2` or any spacing is 0.
  - `export const EPS = 1e-9`

- [ ] **Step 1: Write the failing tests**

Create `opencode-plugin/test/bench-reval-fit.test.ts`:

```ts
import { test, expect } from "bun:test"
import { fitAffine, deriveDelta, EPS } from "../src/bench/reval-fit.ts"

test("fitAffine recovers exact affine relation", () => {
  const us = [1.0, 2.3, 2.9, 5.1, 7.8]
  const cs = us.map((u) => 100 + 40 * u)
  const f = fitAffine(us, cs)
  expect(Math.abs(f.a - 100)).toBeLessThan(1e-9)
  expect(Math.abs(f.b - 40)).toBeLessThan(1e-9)
  expect(f.rms).toBeLessThan(1e-9)
})

test("fitAffine reports large rms on a shifted assignment over irregular anchors", () => {
  // probe T4: truth shifted by one index on an irregular constellation
  const us = [1.0, 2.3, 2.9, 5.1, 7.8]
  const truth = us.map((u) => 100 + 40 * u)
  const shifted = [...truth.slice(1), truth[4]! + 40]
  expect(fitAffine(us, shifted).rms).toBeGreaterThan(10)
})

test("fitAffine on constant us degrades to mean without dividing by zero", () => {
  const f = fitAffine([2, 2, 2], [5, 6, 7])
  expect(f.b).toBe(0)
  expect(Math.abs(f.a - 6)).toBeLessThan(1e-9)
})

test("deriveDelta is |b| * min spacing / 2 (spec D4)", () => {
  // sorted spacings of [1, 2.3, 2.9, 5.1, 7.8] -> min 0.6; b=40 -> delta 12
  expect(deriveDelta([1.0, 2.3, 2.9, 5.1, 7.8], 40)).toBeCloseTo(12, 9)
  // unsorted input must give the same answer
  expect(deriveDelta([7.8, 1.0, 5.1, 2.9, 2.3], -40)).toBeCloseTo(12, 9)
})

test("deriveDelta rejects degenerate spacing", () => {
  expect(() => deriveDelta([1], 40)).toThrow(RangeError)
  expect(() => deriveDelta([1, 1, 2], 40)).toThrow(RangeError)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd opencode-plugin && bun test test/bench-reval-fit.test.ts`
Expected: FAIL — module `../src/bench/reval-fit.ts` not found.

- [ ] **Step 3: Write the implementation**

Create `opencode-plugin/src/bench/reval-fit.ts`:

```ts
/** D&C merge machinery — spec docs/superpowers/specs/2026-08-20-dnc-design.md §6.
 * SHIPS OFF: nothing in the run/audit path imports this module. Pure functions,
 * no I/O, no model calls. Reference probe: docs/loop-probes/dnc-merge-fit-20260820/. */

export const EPS = 1e-9

export interface AffineFit { a: number; b: number; rms: number }

/** Least-squares y = a + b*u. Constant-u input degrades to the mean (b=0). */
export function fitAffine(us: number[], cs: number[]): AffineFit {
  const n = us.length
  const mu = us.reduce((s, v) => s + v, 0) / n
  const mc = cs.reduce((s, v) => s + v, 0) / n
  let sxx = 0
  let sxy = 0
  for (let i = 0; i < n; i++) {
    sxx += (us[i]! - mu) ** 2
    sxy += (us[i]! - mu) * (cs[i]! - mc)
  }
  const b = sxx < EPS ? 0 : sxy / sxx
  const a = mc - b * mu
  let se = 0
  for (let i = 0; i < n; i++) se += (a + b * us[i]! - cs[i]!) ** 2
  return { a, b, rms: Math.sqrt(se / n) }
}

/** Spec D4: delta < |b| * min spacing / 2 — derived from the fit's own slope and
 * the detected anchor geometry; no external constant. */
export function deriveDelta(us: number[], b: number): number {
  if (us.length < 2) throw new RangeError("deriveDelta: need >= 2 anchors")
  const sorted = [...us].sort((x, y) => x - y)
  let minDu = Infinity
  for (let i = 1; i < sorted.length; i++) minDu = Math.min(minDu, sorted[i]! - sorted[i - 1]!)
  if (minDu < EPS) throw new RangeError("deriveDelta: coincident anchors")
  return (Math.abs(b) * minDu) / 2
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd opencode-plugin && bun test test/bench-reval-fit.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Full suite + gate, then commit**

Run: `cd opencode-plugin && bun test 2>&1 | tail -3 && cd .. && bun scripts/gate-check.ts 2>&1 | tail -1`
Expected: 0 fail; doc-check OK.

```bash
git add opencode-plugin/src/bench/reval-fit.ts opencode-plugin/test/bench-reval-fit.test.ts
git commit -m "feat(lane-a): reval-fit core — affine fit + derived delta (D&C spec §6.2/§6.3, ships OFF)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: derived-automorphism conditioning check

**Files:**
- Modify: `opencode-plugin/src/bench/reval-fit.ts` (append)
- Test: `opencode-plugin/test/bench-reval-fit.test.ts` (append)

**Interfaces:**
- Consumes: `fitAffine`, `EPS` from Task 1.
- Produces:
  - `export const R_THRESHOLD_PLACEHOLDER = 3` — placeholder pending the §8.2 noise rule; never rename to imply validation.
  - `export function enumerateAutomorphisms(us: number[], tol?: number): number[][]` — index permutations (non-identity) under which the sorted constellation approximately maps to itself: mirror (`u → us[0]+us[n-1] − u`) and translations (`u → u ± (us[k]−us[0])` for k=1..n−1), each accepted only if every mapped value pairs to a distinct anchor within `tol` (default `minΔu / 4`). Input is used sorted; permutations are over the SORTED index order.
  - `export interface ConditioningResult { ok: boolean; R: number; alternates: number }`
  - `export function conditioningCheck(us: number[], cs: number[], tol?: number): ConditioningResult` — alternates = derived automorphism pairings PLUS the ±1 index shifts (translation cases that drop one anchor; they are the regression floor's shift arm and cost nothing). `R = min(alternate rms) / max(claimed rms, EPS)`; `ok = n >= 3 && R > R_THRESHOLD_PLACEHOLDER`. `us`/`cs` are taken in matched sorted-by-u order.

- [ ] **Step 1: Write the failing tests**

Append to `opencode-plugin/test/bench-reval-fit.test.ts` (add a NEW import statement below the existing ones — the code below shows it; multiple import statements from the same module are fine):

```ts
import { enumerateAutomorphisms, conditioningCheck, R_THRESHOLD_PLACEHOLDER } from "../src/bench/reval-fit.ts"

// -- derived automorphisms ---------------------------------------------------

test("equal-spaced constellation has the mirror automorphism (finite translations never survive the boundaries)", () => {
  const auts = enumerateAutomorphisms([1, 2, 3, 4, 5])
  // translations of a FINITE arithmetic sequence always push a boundary
  // element outside tolerance, so only the mirror survives
  expect(auts).toEqual([[4, 3, 2, 1, 0]])
})

test("SYMMETRIC irregular constellation has the mirror automorphism (probe T10 geometry)", () => {
  const auts = enumerateAutomorphisms([1, 2, 6, 10, 11])
  expect(auts).toContainEqual([4, 3, 2, 1, 0])
})

test("asymmetric irregular constellation has NO automorphisms", () => {
  expect(enumerateAutomorphisms([1.0, 2.3, 2.9, 5.1, 7.8])).toEqual([])
})

// -- conditioning check: the regression floor (probe T1, T2, T3, T10) --------

const truthOf = (us: number[]) => us.map((u) => 100 + 40 * u)

test("T1 floor: identity shift on equal-spaced constellation is REJECTED", () => {
  const us = [1, 2, 3, 4, 5]
  const truth = truthOf(us)
  const shifted = [...truth.slice(1), truth[4]! + 40]
  expect(conditioningCheck(us, shifted).ok).toBe(false)
})

test("T2 floor: honest claim on degenerate (equal-spaced) geometry is REJECTED fail-closed", () => {
  const us = [1, 2, 3, 4, 5]
  expect(conditioningCheck(us, truthOf(us)).ok).toBe(false)
})

test("T3 floor: honest claim on irregular geometry is ACCEPTED with wide margin", () => {
  const us = [1.0, 2.3, 2.9, 5.1, 7.8]
  const r = conditioningCheck(us, truthOf(us))
  expect(r.ok).toBe(true)
  expect(r.R).toBeGreaterThan(R_THRESHOLD_PLACEHOLDER * 100)
})

test("T10 floor: reversal on SYMMETRIC irregular constellation is REJECTED (derived mirror alternate)", () => {
  const us = [1, 2, 6, 10, 11]
  const reversed = [...truthOf(us)].reverse()
  expect(conditioningCheck(us, reversed).ok).toBe(false)
})

test("n < 3 is rejected outright", () => {
  expect(conditioningCheck([1, 2], [140, 180]).ok).toBe(false)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd opencode-plugin && bun test test/bench-reval-fit.test.ts`
Expected: FAIL — `enumerateAutomorphisms` not exported.

- [ ] **Step 3: Write the implementation**

Append to `opencode-plugin/src/bench/reval-fit.ts`:

```ts
/** Placeholder pending the §8.2 pre-registered noise rule — NOT a validated
 * constant. In the noiseless probe the separation was total (R = 0 vs 1.5e10),
 * so this value is not load-bearing; the noise sweep decides whether it
 * survives or the check moves to a derived threshold. */
export const R_THRESHOLD_PLACEHOLDER = 3

function sortedWith<T>(us: number[], cs: T[]): { su: number[]; sc: T[] } {
  const idx = us.map((_, i) => i).sort((i, j) => us[i]! - us[j]!)
  return { su: idx.map((i) => us[i]!), sc: idx.map((i) => cs[i]!) }
}

/** Spec §6.4 derived form: enumerate the constellation's approximate
 * automorphisms — mirror and translations — as index permutations over the
 * SORTED anchor order. A candidate mapping is an automorphism only when every
 * mapped value pairs to a distinct anchor within tol (default minΔu/4). The
 * fixed set {±1 shift, reversal} is the regression FLOOR the derived form must
 * cover (equal-spaced: translations + mirror; symmetric: mirror) — see the
 * floor tests; the floor is never the implementation. */
export function enumerateAutomorphisms(us: number[], tol?: number): number[][] {
  const su = [...us].sort((x, y) => x - y)
  const n = su.length
  if (n < 3) return []
  let minDu = Infinity
  for (let i = 1; i < n; i++) minDu = Math.min(minDu, su[i]! - su[i - 1]!)
  const t = tol ?? minDu / 4
  const candidates: number[][] = []
  const images: ((u: number) => number)[] = [(u) => su[0]! + su[n - 1]! - u]
  for (let k = 1; k < n; k++) {
    const d = su[k]! - su[0]!
    images.push((u) => u + d, (u) => u - d)
  }
  for (const img of images) {
    const used = new Set<number>()
    const perm: number[] = []
    let valid = true
    for (let i = 0; i < n && valid; i++) {
      const target = img(su[i]!)
      let hit = -1
      for (let j = 0; j < n; j++) {
        if (!used.has(j) && Math.abs(su[j]! - target) <= t) { hit = j; break }
      }
      if (hit < 0) valid = false
      else { used.add(hit); perm.push(hit) }
    }
    if (valid && perm.some((p, i) => p !== i)) candidates.push(perm)
  }
  // dedupe identical permutations from different generators
  const seen = new Set<string>()
  return candidates.filter((p) => { const k = p.join(","); if (seen.has(k)) return false; seen.add(k); return true })
}

export interface ConditioningResult { ok: boolean; R: number; alternates: number }

/** Spec §6.4 (as amended): R = min(RMS over alternates) / max(RMS claimed, EPS);
 * reject when R <= threshold or n < 3. TWO alternate components with distinct
 * jobs: (1) the constellation's DERIVED automorphism pairings — the symmetry
 * defence; an empty set on asymmetric geometry is CORRECT, not a gap, because
 * a wrong pairing can only fit well by composing with a symmetry of the
 * constellation, so no symmetry = no attack surface in that class; (2) the
 * FIXED ±1-index-shift pair — the minimal-misassignment distinguishability
 * reference, fixed before any attack existed and never grown in response to
 * one (reversal is NOT fixed here: it arrives via (1) when the geometry has
 * mirror symmetry). Growth-by-incident applies to neither component. */
export function conditioningCheck(us: number[], cs: number[], tol?: number): ConditioningResult {
  const n = us.length
  if (n < 3 || cs.length !== n) return { ok: false, R: NaN, alternates: 0 }
  const { su, sc } = sortedWith(us, cs)
  const claimed = fitAffine(su, sc).rms
  const altRms: number[] = []
  for (const perm of enumerateAutomorphisms(su, tol)) {
    altRms.push(fitAffine(su, perm.map((p) => sc[p]!)).rms)
  }
  if (n - 1 >= 3) {
    altRms.push(fitAffine(su.slice(0, -1), sc.slice(1)).rms)
    altRms.push(fitAffine(su.slice(1), sc.slice(0, -1)).rms)
  }
  if (altRms.length === 0) return { ok: false, R: NaN, alternates: 0 }
  const R = Math.min(...altRms) / Math.max(claimed, EPS)
  return { ok: R > R_THRESHOLD_PLACEHOLDER, R, alternates: altRms.length }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd opencode-plugin && bun test test/bench-reval-fit.test.ts`
Expected: PASS (13 tests). If T3-floor fails on R magnitude, print `conditioningCheck([1.0,2.3,2.9,5.1,7.8], truth)` and check the alternate count is 2 (shifts only — no automorphisms on asymmetric geometry).

- [ ] **Step 5: Full suite + gate, then commit**

Run: `cd opencode-plugin && bun test 2>&1 | tail -3 && cd .. && bun scripts/gate-check.ts 2>&1 | tail -1`
Expected: 0 fail; doc-check OK.

```bash
git add opencode-plugin/src/bench/reval-fit.ts opencode-plugin/test/bench-reval-fit.test.ts
git commit -m "feat(lane-a): derived-automorphism conditioning check — spec §6.4, floor T1/T2/T3/T10 pinned

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: merge check — full coverage, derived delta, fail-closed

**Files:**
- Modify: `opencode-plugin/src/bench/reval-fit.ts` (append)
- Test: `opencode-plugin/test/bench-reval-fit.test.ts` (append)

**Interfaces:**
- Consumes: `fitAffine`, `deriveDelta`, `conditioningCheck` (Tasks 1–2).
- Produces:
  - `export type MergeReject = "coverage" | "insufficient-anchors" | "coincident-anchors" | "degenerate-constellation" | "residual"`
  - `export interface MergeResult { ok: boolean; reason?: MergeReject; a?: number; b?: number; delta?: number; R?: number }`
  - `export function mergeCheck(anchorsU: number[], canonicals: number[]): MergeResult` — full-anchor coverage is enforced by shape: `canonicals.length` must equal `anchorsU.length` (spec §6.5 — the claimant never selects the graded subset). Order: `canonicals[i]` is the claim for `anchorsU[i]`.

- [ ] **Step 1: Write the failing tests**

Append to `opencode-plugin/test/bench-reval-fit.test.ts` (add a new import statement for `mergeCheck` below the existing ones, as shown):

```ts
import { mergeCheck } from "../src/bench/reval-fit.ts"

const usIr = [1.0, 2.3, 2.9, 5.1, 7.8]

test("mergeCheck accepts an honest full-coverage claim on irregular anchors", () => {
  const r = mergeCheck(usIr, truthOf(usIr))
  expect(r.ok).toBe(true)
  expect(r.b).toBeCloseTo(40, 6)
  expect(r.delta).toBeCloseTo(12, 6) // |40| * 0.6 / 2
})

test("mergeCheck rejects partial coverage — claimant never selects the graded subset (spec §6.5)", () => {
  const r = mergeCheck(usIr, truthOf(usIr).slice(0, 3))
  expect(r.ok).toBe(false)
  expect(r.reason).toBe("coverage")
})

test("mergeCheck rejects n < 3", () => {
  const r = mergeCheck([1.0, 2.3], [140, 192])
  expect(r.ok).toBe(false)
  expect(r.reason).toBe("insufficient-anchors")
})

test("mergeCheck rejects coincident anchors fail-closed instead of throwing", () => {
  const r = mergeCheck([1, 2, 2, 4, 5], [140, 180, 180, 260, 300])
  expect(r.ok).toBe(false)
  expect(r.reason).toBe("coincident-anchors")
})

test("mergeCheck rejects degenerate geometry fail-closed (probe T2)", () => {
  const us = [1, 2, 3, 4, 5]
  const r = mergeCheck(us, truthOf(us))
  expect(r.ok).toBe(false)
  expect(r.reason).toBe("degenerate-constellation")
})

test("mergeCheck rejects a shifted claim on irregular anchors via residuals (probe T4)", () => {
  const truth = truthOf(usIr)
  const shifted = [...truth.slice(1), truth[4]! + 40]
  const r = mergeCheck(usIr, shifted)
  expect(r.ok).toBe(false)
  expect(r.reason).toBe("residual")
})

test("DOCUMENTED BOUNDARY (probe T6): an invented consistent (a,b) PASSES — the merge checks pairing, never truth", () => {
  // Spec §6 scope paragraph: this is deception, rejectable only by an outside
  // prior (§8.8). This test pins the boundary so nobody mistakes it for a bug.
  const invented = usIr.map((u) => 7 + 3 * u)
  expect(mergeCheck(usIr, invented).ok).toBe(true)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd opencode-plugin && bun test test/bench-reval-fit.test.ts`
Expected: FAIL — `mergeCheck` not exported.

- [ ] **Step 3: Write the implementation**

Append to `opencode-plugin/src/bench/reval-fit.ts`:

```ts
export type MergeReject = "coverage" | "insufficient-anchors" | "coincident-anchors" | "degenerate-constellation" | "residual"

export interface MergeResult { ok: boolean; reason?: MergeReject; a?: number; b?: number; delta?: number; R?: number }

/** Spec §6 merge: ONE over-determined fit across the FULL anchor set, delta
 * derived from the fit itself, conditioning check on the constellation.
 * Fail-closed at every gate. THREAT MODEL (spec §6, binding): this rejects
 * ERROR (internal inconsistency), never DECEPTION (a consistently invented
 * (a,b) passes by construction — probe T6); value truth needs an outside
 * prior (§8.8) and is not this function's claim. */
export function mergeCheck(anchorsU: number[], canonicals: number[]): MergeResult {
  if (canonicals.length !== anchorsU.length) return { ok: false, reason: "coverage" }
  if (anchorsU.length < 3) return { ok: false, reason: "insufficient-anchors" }
  const { su, sc } = sortedWith(anchorsU, canonicals)
  // Coincident anchors would make deriveDelta throw; fail CLOSED, not loud —
  // a typed reject, never an escaping RangeError (the reorder below made
  // deriveDelta reachable before any other guard could catch this).
  for (let i = 1; i < su.length; i++) {
    if (su[i]! - su[i - 1]! < EPS) return { ok: false, reason: "coincident-anchors" }
  }
  // RESIDUALS FIRST. The conditioning R's denominator is the claimed fit's own
  // rms, so a badly-fitting claim collapses R and would steal the reason from
  // the residual signal (a shifted claim on irregular anchors must report
  // "residual", matching the probe's side-by-side record — the two signals
  // are independent, never chained bad-fit-first).
  const fit = fitAffine(su, sc)
  const delta = deriveDelta(su, fit.b)
  for (let i = 0; i < su.length; i++) {
    if (Math.abs(fit.a + fit.b * su[i]! - sc[i]!) >= delta) {
      return { ok: false, reason: "residual", a: fit.a, b: fit.b, delta }
    }
  }
  // A residual-clean claim still faces the geometry question: could a WRONG
  // pairing fit this well? (probe T1/T10 — perfect fits on degenerate geometry.)
  const cond = conditioningCheck(su, sc)
  if (!cond.ok) return { ok: false, reason: "degenerate-constellation", a: fit.a, b: fit.b, delta, R: cond.R }
  return { ok: true, a: fit.a, b: fit.b, delta, R: cond.R }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd opencode-plugin && bun test test/bench-reval-fit.test.ts`
Expected: PASS (20 tests).

- [ ] **Step 5: Full suite + gate, then commit**

Run: `cd opencode-plugin && bun test 2>&1 | tail -3 && cd .. && bun scripts/gate-check.ts 2>&1 | tail -1`
Expected: 0 fail; doc-check OK.

```bash
git add opencode-plugin/src/bench/reval-fit.ts opencode-plugin/test/bench-reval-fit.test.ts
git commit -m "feat(lane-a): mergeCheck — full-anchor coverage, derived delta, fail-closed; T6 boundary pinned as documented

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: out-of-family bad set (spec §8.3)

**Files:**
- Test: `opencode-plugin/test/bench-reval-fit.test.ts` (append only — no src change expected)

**Interfaces:**
- Consumes: `mergeCheck` (Task 3).
- Produces: the §8.3 bad-set evidence: residuals reject a wrong family.

- [ ] **Step 1: Write the tests (expected to pass immediately — they are validation, not TDD; if any FAILS, that is a real design break: STOP and report, do not adjust thresholds)**

```ts
// -- §8.3 out-of-family bad set: residuals must reject a wrong family --------

test("quadratic relationship is rejected by residuals under the affine family", () => {
  const us = [1.0, 2.3, 2.9, 5.1, 7.8]
  const quad = us.map((u) => 50 + 5 * u * u)
  const r = mergeCheck(us, quad)
  expect(r.ok).toBe(false)
  expect(r.reason).toBe("residual")
})

test("logarithmic relationship is rejected by residuals under the affine family", () => {
  const us = [1.0, 2.3, 2.9, 5.1, 7.8]
  const logc = us.map((u) => 300 + 500 * Math.log(u))
  const r = mergeCheck(us, logc)
  expect(r.ok).toBe(false)
  expect(r.reason).toBe("residual")
})

test("oracle arm: the same anchors under the true affine family still pass", () => {
  const us = [1.0, 2.3, 2.9, 5.1, 7.8]
  expect(mergeCheck(us, us.map((u) => 100 + 40 * u)).ok).toBe(true)
})
```

- [ ] **Step 2: Run the tests**

Run: `cd opencode-plugin && bun test test/bench-reval-fit.test.ts`
Expected: PASS. If the quadratic or log case PASSES mergeCheck (test fails), the derived delta is too loose for out-of-family rejection — report as a spec-level finding; do not tune.

- [ ] **Step 3: Full suite + gate, then commit**

```bash
cd opencode-plugin && bun test 2>&1 | tail -3 && cd .. && bun scripts/gate-check.ts 2>&1 | tail -1
git add opencode-plugin/test/bench-reval-fit.test.ts
git commit -m "test(lane-a): §8.3 out-of-family bad set — quadratic/log rejected by residuals, oracle arm passes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: series-peaks — scale-persistent peak detector

**Files:**
- Create: `opencode-plugin/src/bench/series-peaks.ts`
- Test: `opencode-plugin/test/bench-series-peaks.test.ts`

**Interfaces:**
- Consumes: nothing (pure function).
- Produces: `export function detectPeaks(ys: number[]): number[]` — indices of scale-persistent local maxima. Parameters FIXED per spec/probe pre-registration (never tuned): smoothing windows odd 5..101; threshold = 90th percentile of each smoothed series; a peak survives if it persists (±3 samples) across ≥5 consecutive scales from the smallest; survivors closer than 3 samples merge to the first.

- [ ] **Step 1: Write the failing tests**

Create `opencode-plugin/test/bench-series-peaks.test.ts`:

```ts
import { test, expect } from "bun:test"
import { detectPeaks } from "../src/bench/series-peaks.ts"

/** Deterministic synthetic spectrum: flat baseline + three gaussian peaks +
 * deterministic ripple (no RNG — Math.random is banned for reproducibility). */
function synth(): { ys: number[]; centers: number[] } {
  const n = 1200
  const centers = [200, 617, 990]
  const ys: number[] = []
  for (let i = 0; i < n; i++) {
    let v = 1000 + 20 * Math.sin(i / 7) // baseline + ripple far below peak scale
    for (const c of centers) v += 8000 * Math.exp(-((i - c) ** 2) / (2 * 12 ** 2))
    ys.push(v)
  }
  return { ys, centers }
}

test("detectPeaks finds all three synthetic peaks within tolerance and nothing else", () => {
  const { ys, centers } = synth()
  const peaks = detectPeaks(ys)
  expect(peaks.length).toBe(3)
  for (let i = 0; i < 3; i++) expect(Math.abs(peaks[i]! - centers[i]!)).toBeLessThanOrEqual(5)
})

test("detectPeaks returns empty on a featureless series", () => {
  const flat = Array.from({ length: 500 }, (_, i) => 1000 + 5 * Math.sin(i / 3))
  // ripple maxima are not scale-persistent: smoothing at larger windows erases them
  expect(detectPeaks(flat).length).toBe(0)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd opencode-plugin && bun test test/bench-series-peaks.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation** (direct port of `docs/loop-probes/dnc-merge-fit-20260820/probe.py detect_peaks` — keep the algorithm identical; that code is the registered record)

Create `opencode-plugin/src/bench/series-peaks.ts`:

```ts
/** Scale-persistent peak detection — D&C spec §6.1 divide step. SHIPS OFF.
 * Parameters are the probe's pre-registered values (dnc-merge-fit-20260820)
 * and are NEVER tuned against an expected peak count or identity: windows
 * odd 5..101, 90th-percentile threshold, persistence >= 5 consecutive scales
 * at +/-3 samples. Survivor set is never trimmed by expected count. */
export function detectPeaks(ys: number[]): number[] {
  const perScale: number[][] = []
  for (let w = 5; w <= 101; w += 2) {
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
  const survivors: number[] = []
  for (const p of perScale[0]!) {
    let pos = p
    let run = 1
    for (let s = 1; s < perScale.length; s++) {
      const match = perScale[s]!.find((q) => Math.abs(q - pos) <= 3)
      if (match === undefined) break
      pos = match
      run++
    }
    if (run >= 5) survivors.push(p)
  }
  const merged: number[] = []
  for (const p of survivors.sort((a, b) => a - b)) {
    if (merged.length && p - merged[merged.length - 1]! <= 3) continue
    merged.push(p)
  }
  return merged
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd opencode-plugin && bun test test/bench-series-peaks.test.ts`
Expected: PASS (2 tests). If the synthetic count is off, print `detectPeaks(ys)` — do NOT touch window/percentile/persistence parameters (registered); fix only transcription bugs against probe.py.

- [ ] **Step 5: Full suite + gate, then commit**

```bash
cd opencode-plugin && bun test 2>&1 | tail -3 && cd .. && bun scripts/gate-check.ts 2>&1 | tail -1
git add opencode-plugin/src/bench/series-peaks.ts opencode-plugin/test/bench-series-peaks.test.ts
git commit -m "feat(lane-a): scale-persistent peak detector — TS port of the registered probe algorithm (ships OFF)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: series-source — parse + leak-safe read

**Files:**
- Create: `opencode-plugin/src/bench/series-source.ts`
- Test: `opencode-plugin/test/bench-series-source.test.ts`

**Interfaces:**
- Consumes: nothing new (`parseFirstColNum` behaviour is REPRODUCED locally, not imported — importing `convention-audit.ts` would violate the ships-OFF isolation constraint).
- Produces:
  - `export function parseSeries(text: string): { xs: number[]; ys: number[] }` — two-column whitespace-separated numeric rows; single-comma-no-dot tokens read as EU decimal commas; non-conforming lines skipped.
  - `export function readSeriesFile(filePath: string, rootDir: string): { xs: number[]; ys: number[] }` — resolves both paths (`realpathSync`) and throws `Error("series-source: path escapes root")` unless the resolved file is inside the resolved root (spec §8.9 decision: harness-side raw-fixture read, leak-safe by containment — a leak guard that degrades instead of failing loud is not a leak guard).

- [ ] **Step 1: Write the failing tests**

Create `opencode-plugin/test/bench-series-source.test.ts`:

```ts
import { test, expect } from "bun:test"
import { join } from "node:path"
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { parseSeries, readSeriesFile } from "../src/bench/series-source.ts"

test("parseSeries reads plain-decimal tab-separated rows", () => {
  const { xs, ys } = parseSeries("5800.0\t5591.99\n5800.87\t5591.68\nnot a row\n")
  expect(xs).toEqual([5800.0, 5800.87])
  expect(ys).toEqual([5591.99, 5591.68])
})

test("parseSeries reads EU decimal commas (the raman-fitting-audit fixture variant)", () => {
  const { xs, ys } = parseSeries("47183,554644\t19261,547207\n")
  expect(xs[0]).toBeCloseTo(47183.554644, 6)
  expect(ys[0]).toBeCloseTo(19261.547207, 6)
})

test("readSeriesFile reads a contained file and refuses escapes loudly", () => {
  const root = mkdtempSync(join(tmpdir(), "series-src-"))
  mkdirSync(join(root, "env"))
  writeFileSync(join(root, "env", "data.dat"), "1\t10\n2\t20\n")
  writeFileSync(join(root, "outside.dat"), "1\t10\n")
  const ok = readSeriesFile(join(root, "env", "data.dat"), join(root, "env"))
  expect(ok.xs).toEqual([1, 2])
  expect(() => readSeriesFile(join(root, "outside.dat"), join(root, "env"))).toThrow("escapes root")
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd opencode-plugin && bun test test/bench-series-source.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `opencode-plugin/src/bench/series-source.ts`:

```ts
/** Full-numeric-series access for the D&C divide step — spec §8.9 decision:
 * the detector reads the raw task fixture harness-side, contained to a root,
 * entirely separate from the truncated audit sample. SHIPS OFF. */
import { readFileSync, realpathSync } from "node:fs"
import { sep } from "node:path"

/** Single-comma-no-dot tokens are EU decimal commas (mirrors the audit
 * pipeline's parseFirstColNum contract without importing it — ships-OFF
 * isolation). Anything else falls through to Number(). */
function numToken(tok: string): number {
  if (/^-?\d+,\d+$/.test(tok)) return Number(tok.replace(",", "."))
  return Number(tok)
}

export function parseSeries(text: string): { xs: number[]; ys: number[] } {
  const xs: number[] = []
  const ys: number[] = []
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/)
    if (parts.length !== 2) continue
    const x = numToken(parts[0]!)
    const y = numToken(parts[1]!)
    if (Number.isNaN(x) || Number.isNaN(y)) continue
    xs.push(x)
    ys.push(y)
  }
  return { xs, ys }
}

export function readSeriesFile(filePath: string, rootDir: string): { xs: number[]; ys: number[] } {
  const real = realpathSync(filePath)
  const root = realpathSync(rootDir)
  if (real !== root && !real.startsWith(root + sep)) {
    throw new Error(`series-source: path escapes root: ${filePath}`)
  }
  return parseSeries(readFileSync(real, "utf-8"))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd opencode-plugin && bun test test/bench-series-source.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Full suite + gate, then commit**

```bash
cd opencode-plugin && bun test 2>&1 | tail -3 && cd .. && bun scripts/gate-check.ts 2>&1 | tail -1
git add opencode-plugin/src/bench/series-source.ts opencode-plugin/test/bench-series-source.test.ts
git commit -m "feat(lane-a): leak-safe series source — parse + contained read (spec §8.9 path a, ships OFF)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: family-addition enforcement test (spec §8.5)

**Files:**
- Modify: `opencode-plugin/src/bench/reval-fit.ts` (append the frozen family declaration)
- Test: `opencode-plugin/test/bench-reval-fit.test.ts` (append)

**Interfaces:**
- Consumes: Task 2's check.
- Produces:
  - `export interface FamilyMember { name: string; u: (x: number) => number; regressionAttack: { us: number[]; wrongClaim: number[] } }`
  - `export const FIT_FAMILY: readonly FamilyMember[]` — exactly two members, `"x"` and `"inv-x"`, each carrying its own T1-style regression attack input.

- [ ] **Step 1: Write the failing test**

```ts
import { FIT_FAMILY } from "../src/bench/reval-fit.ts"

// -- §8.5 family-addition enforcement: a member without a registered attack
// -- cannot exist, and every registered attack must actually be rejected.
test("every family member carries a regression attack that the check rejects", () => {
  expect(FIT_FAMILY.length).toBe(2) // frozen: {x, 1/x}; growth needs oracle+bad set per §1
  for (const m of FIT_FAMILY) {
    const { us, wrongClaim } = m.regressionAttack
    expect(us.length).toBeGreaterThanOrEqual(3)
    const r = mergeCheck(us, wrongClaim)
    expect(r.ok).toBe(false) // the attack input must be rejected — by geometry or residual
  }
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd opencode-plugin && bun test test/bench-reval-fit.test.ts`
Expected: FAIL — `FIT_FAMILY` not exported.

- [ ] **Step 3: Write the implementation**

Append to `opencode-plugin/src/bench/reval-fit.ts`:

```ts
export interface FamilyMember {
  name: string
  u: (x: number) => number
  /** §8.5 enforcement: a family member cannot be added without its own
   * T1-style attack input; the enforcement test rejects members without one
   * (and rejects a member whose attack the check fails to reject). */
  regressionAttack: { us: number[]; wrongClaim: number[] }
}

const T1_US = [1, 2, 3, 4, 5]
const T1_TRUTH = T1_US.map((u) => 100 + 40 * u)

/** Frozen a priori (spec §6.2): general measurement algebra, never grown per
 * incident. Growth requires oracle-set AND bad-set validation (§8.3) plus a
 * regression attack here (§8.5) — the type makes the attack mandatory. */
export const FIT_FAMILY: readonly FamilyMember[] = [
  {
    name: "x",
    u: (x) => x,
    regressionAttack: { us: T1_US, wrongClaim: [...T1_TRUTH.slice(1), T1_TRUTH[4]! + 40] },
  },
  {
    name: "inv-x",
    u: (x) => 1 / x,
    // attack constructed in X-SPACE and passed through the member's own u —
    // xs chosen so u(x) is the equal-spaced degenerate constellation; an
    // identical-to-"x" attack would make this enforcement near-vacuous.
    regressionAttack: (() => {
      const xs = [1, 0.5, 1 / 3, 0.25, 0.2]
      const us = xs.map((x) => 1 / x) // ≈ [1,2,3,4,5] via the member's transform
      const truth = us.map((u) => 100 + 40 * u)
      return { us, wrongClaim: [...truth.slice(1), truth[4]! + 40] }
    })(),
  },
] as const
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd opencode-plugin && bun test test/bench-reval-fit.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite + gate, then commit**

```bash
cd opencode-plugin && bun test 2>&1 | tail -3 && cd .. && bun scripts/gate-check.ts 2>&1 | tail -1
git add opencode-plugin/src/bench/reval-fit.ts opencode-plugin/test/bench-reval-fit.test.ts
git commit -m "feat(lane-a): frozen FIT_FAMILY with mandatory per-member regression attacks (spec §8.5)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: real-fixture integration

**Files:**
- Test: `opencode-plugin/test/bench-dnc-integration.test.ts` (create)

**Interfaces:**
- Consumes: `detectPeaks` (T5), `readSeriesFile` (T6), `conditioningCheck` (T2), `FIT_FAMILY` (T7).
- Produces: the end-to-end evidence that the TS pipeline reproduces the probe's D3 result on the real fixture — 17 peaks, irregular geometry in both family variables.

- [ ] **Step 1: Write the test** (validation test — expected to pass if T5/T6 are faithful ports; a mismatch with the probe's recorded numbers is a transcription bug in T5/T6, not a threshold to adjust)

Create `opencode-plugin/test/bench-dnc-integration.test.ts`:

```ts
import { test, expect } from "bun:test"
import { join } from "node:path"
import { readSeriesFile } from "../src/bench/series-source.ts"
import { detectPeaks } from "../src/bench/series-peaks.ts"
import { FIT_FAMILY, conditioningCheck } from "../src/bench/reval-fit.ts"

const FIXTURE_DIR = join(import.meta.dir, "../../term-bench2/probe-tasks/raman-fitting-audit/environment/task-deps")

test("TS pipeline reproduces the probe's D3 result on the real fixture: n=17 persistent peaks", () => {
  const { xs, ys } = readSeriesFile(join(FIXTURE_DIR, "graphene.dat"), FIXTURE_DIR)
  expect(xs.length).toBe(3565) // the EU-comma fixture variant
  const peaks = detectPeaks(ys)
  expect(peaks.length).toBe(17) // probe verdict D3 — a different count is a port bug, not a tune target
})

test("real-fixture constellation is irregular in both family variables (attack = transfer risk, not live)", () => {
  const { xs, ys } = readSeriesFile(join(FIXTURE_DIR, "graphene.dat"), FIXTURE_DIR)
  const px = detectPeaks(ys).map((i) => xs[i]!)
  for (const m of FIT_FAMILY) {
    const us = px.map(m.u).sort((a, b) => a - b)
    const d = us.slice(1).map((v, i) => v - us[i]!)
    const mean = d.reduce((s, v) => s + v, 0) / d.length
    const cv = Math.sqrt(d.reduce((s, v) => s + (v - mean) ** 2, 0) / d.length) / mean
    expect(cv).toBeGreaterThan(0.15) // probe D3: CV 1.374 (x), 1.861 (1/x)
    // honest synthetic claim over this real geometry is accepted by the check
    const claim = us.map((u) => 10 + 2 * u)
    expect(conditioningCheck(us, claim).ok).toBe(true)
  }
})
```

- [ ] **Step 2: Run the test**

Run: `cd opencode-plugin && bun test test/bench-dnc-integration.test.ts`
Expected: PASS. On a peak-count mismatch: diff the TS detector against `probe.py detect_peaks` line by line (same windows, same percentile index arithmetic `(0.9*len)|0` vs python's `int(0.9*len)` — these must agree).

- [ ] **Step 3: Full suite + gate, then commit**

```bash
cd opencode-plugin && bun test 2>&1 | tail -3 && cd .. && bun scripts/gate-check.ts 2>&1 | tail -1
git add opencode-plugin/test/bench-dnc-integration.test.ts
git commit -m "test(lane-a): D&C pipeline end-to-end on the real fixture — n=17 reproduced, geometry irregular in both u

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: O4 formal scoring (spec §8.7) — independent of all code tasks

**Files:**
- Create: `docs/loop-probes/f3-cell-contract-20260820/score-o4.py`
- Create: `docs/loop-probes/f3-cell-contract-20260820/addendum-01-o4-scoring.md`

**Interfaces:**
- Consumes: the four committed `out-O4-r{1..4}.json` cells and the probe's own `pre-registration.md` O4 decision rule (already registered — this task scores against it, registering nothing new).
- Produces: the verdict §4 G1 can cite instead of raw cells.

- [ ] **Step 1: Write the scorer**

Create `docs/loop-probes/f3-cell-contract-20260820/score-o4.py`:

```python
#!/usr/bin/env python3
"""Formal scoring of the O4 arm against the ALREADY-REGISTERED rule in
pre-registration.md AMENDMENT 01 (O4 was run but never scored in verdict.md —
found by the D&C spec architect review, F4). The registered metric is
CONSTANT-CONSISTENCY under the STRICT check — the declared CONSTANT token
appears in every derivation row — baseline to beat O3's 2/4. Parse rate
(strictBlock) is REPORTED for the divergence story but is NOT the scored
metric. Run from the repo root."""
import glob
import json
import os
import re

cells = sorted(glob.glob(os.path.join(os.path.dirname(__file__), "out-O4-r*.json")))
assert len(cells) == 4, f"expected 4 O4 cells, found {len(cells)}"
consistent = 0
rows = []
for p in cells:
    d = json.load(open(p))
    raw = d.get("rawAudit", "")
    m = re.search(r"^CONSTANT:\s*(\S+)", raw, re.M)
    const_tok = m.group(1) if m else None
    # O4's block is five columns: | input | computed | canonical | derivation |
    # discriminates | — the derivation is cell index 3 of each data row.
    derivs = []
    for line in raw.splitlines():
        parts = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(parts) == 5 and parts[0] not in ("input",) and not set(parts[0]) <= set("-: "):
            derivs.append(parts[3])
    ok = const_tok is not None and len(derivs) > 0 and all(const_tok in dv for dv in derivs)
    consistent += ok
    rows.append((os.path.basename(p), const_tok, len(derivs), ok, d.get("strictBlock")))
print(f"O4 CONSTANT-CONSISTENCY (strict): {consistent}/4  [registered baseline: O3 2/4]")
for name, tok, nd, ok, sb in rows:
    print(f"  {name}: CONSTANT={tok} derivation-rows={nd} consistent={ok} (strictBlock={sb} — parse metric, reported not scored)")
print("registered rule: consistency 4/4 -> adopt cross-check + column; <=2/4 -> confirms prediction (root cause F4, not F3); 3/4 -> INDETERMINATE under the registered rule")
print(f"outcome: {'ADOPT' if consistent == 4 else 'CONFIRMS PREDICTION' if consistent <= 2 else 'INDETERMINATE'}")
```

- [ ] **Step 2: Run it and capture output**

Run: `python3 docs/loop-probes/f3-cell-contract-20260820/score-o4.py`
NO expected outcome is written here on purpose — the registered rule has three branches (4/4 adopt, ≤2/4 confirms-prediction, 3/4 indeterminate) and the scorer decides. Whatever it ACTUALLY prints goes verbatim into Step 3 — never write the addendum from an expectation.

- [ ] **Step 3: Write the addendum with the real output**

Create `docs/loop-probes/f3-cell-contract-20260820/addendum-01-o4-scoring.md` containing: a header noting the arm was run 2026-08-20 but omitted from `verdict.md` (found by the architect review of the D&C spec, finding F4); the scorer's verbatim output in a fenced block; the registered rule quoted from `pre-registration.md` AMENDMENT 01; and a reading that (a) applies whichever branch of the registered rule actually fired, and (b) states the PARSE-vs-CONSISTENCY divergence precisely (parse was 0/4 while consistency is whatever the scorer printed) — that divergence, not any single number, is what the D&C spec's G1 cites (the announced metric moving independently of the underlying behaviour). If the outcome is INDETERMINATE, say so and leave G1 citing the divergence plus the raw cells; do not round 3/4 down to confirm a prediction. The addendum must also state, in one sentence, why a cell with NO revalidation table counts as inconsistent rather than vacuously consistent (fail-closed, matching every other gate in this design; the vacuous reading would let an empty block outscore a populated one). `verdict.md` itself is NOT edited.

- [ ] **Step 4: Gate, then commit**

```bash
bun scripts/gate-check.ts 2>&1 | tail -1
git add docs/loop-probes/f3-cell-contract-20260820/score-o4.py docs/loop-probes/f3-cell-contract-20260820/addendum-01-o4-scoring.md
git commit -m "probe(lane-a): O4 arm formally scored against its registered rule — closes spec §8.7

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: noise sweep — pre-registration then run (spec §8.2 + §8.6)

**Files:**
- Create: `docs/loop-probes/dnc-merge-fit-20260820/addendum-02-noise-pre.md`
- Create: `docs/loop-probes/dnc-merge-fit-20260820/noise-sweep.ts`
- Create: `docs/loop-probes/dnc-merge-fit-20260820/addendum-02-noise-verdict.md`

**Interfaces:**
- Consumes: `conditioningCheck`, `R_THRESHOLD_PLACEHOLDER` from `opencode-plugin/src/bench/reval-fit.ts` (Task 2) — the sweep validates the LIBRARY, not the python probe.
- Produces: the §8.2 acceptance-rule verdict — R threshold survives or moves to derived.

- [ ] **Step 1: Write the pre-registration FIRST**

Create `docs/loop-probes/dnc-merge-fit-20260820/addendum-02-noise-pre.md`:

```markdown
# Addendum 02 pre-registration — noise robustness of the R check (2026-08-20)

Implements spec §8.6 with the §8.2 acceptance rule. Registered before the
sweep runs. Runner: `noise-sweep.ts` against the TS library
(`opencode-plugin/src/bench/reval-fit.ts` conditioningCheck).

## Parameters (registered)

- Noise: additive gaussian on the CANONICAL values, sigma ∈ {0.1%, 0.5%, 1%,
  2%, 5%} of the canonical span (max−min of the honest claim).
- Trials: 200 per sigma per case, seeded xorshift128+ PRNG, seeds 1..200
  (deterministic — wall-clock and Math.random are banned).
- Cases: honest-irregular (probe T3 geometry, us=[1.0,2.3,2.9,5.1,7.8]) and
  shifted-irregular (probe T4 geometry, same us).
- GAP (registered definition, worst-case): min(R over all honest trials at a
  sigma) / max(R over all shifted trials at that sigma).

## Acceptance rule (from spec §8.2, applied verbatim)

The fixed threshold R=3 SURVIVES at a sigma iff GAP ≥ 100 (two orders of
magnitude, worst case). Report per-sigma. If GAP < 100 at any sigma at or
below 1%, the check moves to a DERIVED threshold (from the fit's condition
number under the delta bound) — never a tuned constant. Sigmas above 1% are
reported as the operating boundary, not grounds for tuning.

## Also reported (no rule attached)

False-reject rate of honest-irregular at R=3 per sigma (the fail-closed cost
under noise).
```

- [ ] **Step 2: Write the runner**

Create `docs/loop-probes/dnc-merge-fit-20260820/noise-sweep.ts`:

```ts
/** Noise sweep per addendum-02-noise-pre.md. Run from repo root:
 *    bun docs/loop-probes/dnc-merge-fit-20260820/noise-sweep.ts */
import { conditioningCheck, R_THRESHOLD_PLACEHOLDER } from "../../../opencode-plugin/src/bench/reval-fit.ts"

// deterministic PRNG (xorshift128+), seeded — no Math.random, no Date.now
function prng(seed: number): () => number {
  let s0 = seed >>> 0 || 1
  let s1 = (seed * 2654435761) >>> 0 || 2
  return () => {
    let x = s0
    const y = s1
    s0 = y
    x ^= x << 23
    x >>>= 0
    s1 = (x ^ y ^ (x >>> 17) ^ (y >>> 26)) >>> 0
    return ((s1 + y) >>> 0) / 4294967296
  }
}
function gauss(r: () => number): number {
  // Box-Muller
  const u = Math.max(r(), 1e-12)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r())
}

const US = [1.0, 2.3, 2.9, 5.1, 7.8]
const TRUTH = US.map((u) => 100 + 40 * u)
const SHIFTED = [...TRUTH.slice(1), TRUTH[4]! + 40]
const SPAN = Math.max(...TRUTH) - Math.min(...TRUTH)
const SIGMAS = [0.001, 0.005, 0.01, 0.02, 0.05]
const TRIALS = 200

for (const sig of SIGMAS) {
  const honest: number[] = []
  const shifted: number[] = []
  let falseReject = 0
  for (let seed = 1; seed <= TRIALS; seed++) {
    const r = prng(seed + SIGMAS.indexOf(sig) * 1000)
    const noise = () => gauss(r) * sig * SPAN
    const h = conditioningCheck(US, TRUTH.map((c) => c + noise()))
    const s = conditioningCheck(US, SHIFTED.map((c) => c + noise()))
    honest.push(h.R)
    shifted.push(s.R)
    if (!h.ok) falseReject++
  }
  const gap = Math.min(...honest) / Math.max(...shifted)
  const survives = gap >= 100
  console.log(
    `sigma=${(sig * 100).toFixed(1)}%: GAP(worst-case)=${gap.toExponential(2)} ` +
    `threshold-${R_THRESHOLD_PLACEHOLDER}-${survives ? "SURVIVES" : "FAILS"} ` +
    `honest-false-reject=${falseReject}/${TRIALS}`,
  )
}
```

- [ ] **Step 3: Run it and capture output verbatim**

Run: `bun docs/loop-probes/dnc-merge-fit-20260820/noise-sweep.ts`
Expected shape: five `sigma=…: GAP…` lines. NO expectation is registered on which sigmas survive — that is what is being measured.

- [ ] **Step 4: Write the verdict with the real numbers**

Create `docs/loop-probes/dnc-merge-fit-20260820/addendum-02-noise-verdict.md`: the runner's verbatim output in a fenced block; the per-sigma SURVIVES/FAILS reading against the registered rule; the consequence — either "threshold survives through 1%, placeholder stands until arming" or "GAP < 100 at ≤1% → §8.2's derived-threshold branch is now the requirement; `R_THRESHOLD_PLACEHOLDER` gains a code comment pointing here"; and the honest false-reject cost table. If the derived-threshold branch fires, this plan does NOT implement it — it is recorded as the §8.2 consequence for the arming increment (report it prominently in the task's completion message).

- [ ] **Step 5: Gate, then commit**

```bash
bun scripts/gate-check.ts 2>&1 | tail -1
git add docs/loop-probes/dnc-merge-fit-20260820/addendum-02-noise-pre.md docs/loop-probes/dnc-merge-fit-20260820/noise-sweep.ts docs/loop-probes/dnc-merge-fit-20260820/addendum-02-noise-verdict.md
git commit -m "probe(lane-a): noise sweep of the conditioning check — §8.2 acceptance rule applied as registered

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: second fixture — the transfer test (spec §8.1)

**Files:**
- Create: `docs/loop-probes/dnc-second-fixture-20260820/pre-registration.md`
- Create: `docs/loop-probes/dnc-second-fixture-20260820/make-fixture.ts`
- Create: `docs/loop-probes/dnc-second-fixture-20260820/fixture.dat` (generated, committed)
- Create: `docs/loop-probes/dnc-second-fixture-20260820/run-transfer.ts`
- Create: `docs/loop-probes/dnc-second-fixture-20260820/verdict.md`

**Interfaces:**
- Consumes: `detectPeaks`, `parseSeries`, `mergeCheck`, `FIT_FAMILY`, `conditioningCheck` (Tasks 1–8).
- Produces: the first transfer evidence for the divide/merge machinery on a fixture from a DIFFERENT domain whose construction the machinery has never seen.

- [ ] **Step 1: Write the pre-registration FIRST**

Create `docs/loop-probes/dnc-second-fixture-20260820/pre-registration.md`:

```markdown
# Pre-registration — second fixture transfer test (2026-08-20)

Spec §8.1: one agreement is not transfer. This fixture is a DIFFERENT domain
(synthetic resonance scan: channel positions vs response counts), a DIFFERENT
family member (identity u=x — the raman work exercised 1/x reasoning), and a
DIFFERENT peak count and noise texture, generated by `make-fixture.ts` with
hardcoded seed 424242. The machinery under test (detector + merge) is frozen
at its Task-1..8 state; NOTHING in it may be edited in response to this
fixture — a failure here is a verdict, not a bug to fix.

## Fixture construction (declared, seed 424242)

2000 samples, x = 100.0 + 0.05*i (channel units). Baseline 500 + deterministic
drift. SIX gaussian peaks at irregular, asymmetric channel positions (drawn
once from the seeded PRNG, then FIXED in fixture.dat), widths 8-20 samples,
amplitudes 3000-9000. Gaussian noise sigma=25 counts.

Truth for the ORACLE arm: canonical values c = -50 + 8*x at the true peak
channels (family member u=x, a=-50, b=8) — the generator's constants, written
here before running anything.

## Registered outcomes

- DIVIDE: detectPeaks must find >= 3 scale-persistent peaks; found peak
  channels within +/-5 samples of >= 4 of the 6 true centers. Fewer than 3
  peaks -> divide FAILS transfer (spec: sampler design needs rework).
- ORACLE arm: mergeCheck(us, -50 + 8*u at detected peaks) -> ok=true.
- BAD arms (all must reject):
  b1 identity shift of oracle canonicals (by one detected-peak index)
  b2 reversed oracle canonicals
  b3 out-of-family: c = 20 + 0.5*u^2
- DOCUMENTED BOUNDARY arm: invented consistent (a=3, b=1) -> EXPECTED to pass
  (T6 class; deception is out of the merge's scope by spec §6).
- Geometry report: spacing CV per family member; conditioning alternates count.

## Decision (registered)

All registered outcomes hold -> transfer EVIDENCE (one more fixture, not
proof). Any bad arm accepted or the oracle arm rejected -> the affected
mechanism FAILS transfer; record which and STOP - no tuning against this
fixture, ever (it would become fixture #2 answer-fitting).
```

- [ ] **Step 2: Write the generator**

Create `docs/loop-probes/dnc-second-fixture-20260820/make-fixture.ts`:

```ts
/** Generates fixture.dat per pre-registration.md. Seed hardcoded — rerunning
 * reproduces the identical file (verify with git diff after regeneration).
 * Run once from repo root:
 *    bun docs/loop-probes/dnc-second-fixture-20260820/make-fixture.ts */
import { writeFileSync } from "node:fs"
import { join } from "node:path"

function prng(seed: number): () => number {
  let s0 = seed >>> 0 || 1
  let s1 = (seed * 2654435761) >>> 0 || 2
  return () => {
    let x = s0
    const y = s1
    s0 = y
    x ^= x << 23
    x >>>= 0
    s1 = (x ^ y ^ (x >>> 17) ^ (y >>> 26)) >>> 0
    return ((s1 + y) >>> 0) / 4294967296
  }
}
function gauss(r: () => number): number {
  const u = Math.max(r(), 1e-12)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r())
}

const r = prng(424242)
const N = 2000
// six irregular, asymmetric peak centers (sample indices), min separation 120
const centers: number[] = []
while (centers.length < 6) {
  const c = 100 + Math.floor(r() * (N - 200))
  if (centers.every((e) => Math.abs(e - c) >= 120)) centers.push(c)
}
centers.sort((a, b) => a - b)
const widths = centers.map(() => 8 + r() * 12)
const amps = centers.map(() => 3000 + r() * 6000)

const lines: string[] = []
const trueChannels: number[] = []
for (let i = 0; i < N; i++) {
  const x = 100.0 + 0.05 * i
  let y = 500 + 30 * Math.sin(i / 400) + gauss(r) * 25
  centers.forEach((c, k) => { y += amps[k]! * Math.exp(-((i - c) ** 2) / (2 * widths[k]! ** 2)) })
  lines.push(`${x.toFixed(4)}\t${y.toFixed(4)}`)
}
centers.forEach((c) => trueChannels.push(100.0 + 0.05 * c))

const dir = join(import.meta.dir)
writeFileSync(join(dir, "fixture.dat"), lines.join("\n") + "\n")
writeFileSync(join(dir, "truth.json"), JSON.stringify({ seed: 424242, trueChannels, a: -50, b: 8 }, null, 1))
console.log(`wrote fixture.dat (${N} rows), truth.json — centers at channels ${trueChannels.map((v) => v.toFixed(2)).join(", ")}`)
```

- [ ] **Step 3: Generate and inspect**

Run: `bun docs/loop-probes/dnc-second-fixture-20260820/make-fixture.ts && head -3 docs/loop-probes/dnc-second-fixture-20260820/fixture.dat && cat docs/loop-probes/dnc-second-fixture-20260820/truth.json`
Expected: 2000 rows, six centers listed. `truth.json` is the ORACLE record — committed openly; it validates the harness machinery and is never readable by any model (nothing in this plan is wired to a model).

- [ ] **Step 4: Write the transfer runner**

Create `docs/loop-probes/dnc-second-fixture-20260820/run-transfer.ts`:

```ts
/** Transfer test per pre-registration.md. Run from repo root:
 *    bun docs/loop-probes/dnc-second-fixture-20260820/run-transfer.ts */
import { join } from "node:path"
import { readFileSync } from "node:fs"
import { readSeriesFile } from "../../../opencode-plugin/src/bench/series-source.ts"
import { detectPeaks } from "../../../opencode-plugin/src/bench/series-peaks.ts"
import { mergeCheck, conditioningCheck, FIT_FAMILY } from "../../../opencode-plugin/src/bench/reval-fit.ts"

const dir = import.meta.dir
const { xs, ys } = readSeriesFile(join(dir, "fixture.dat"), dir)
const truth = JSON.parse(readFileSync(join(dir, "truth.json"), "utf-8")) as { trueChannels: number[]; a: number; b: number }

const idx = detectPeaks(ys)
const px = idx.map((i) => xs[i]!)
console.log(`DIVIDE: n=${px.length} peaks at channels ${px.map((v) => v.toFixed(2)).join(", ")}`)
const step = xs[1]! - xs[0]!
const matched = truth.trueChannels.filter((t) => px.some((p) => Math.abs(p - t) <= 5 * step)).length
console.log(`matched ${matched}/6 true centers within +/-5 samples`)

const us = [...px].sort((a, b) => a - b)
const oracle = us.map((u) => truth.a + truth.b * u)
const arms: [string, number[], boolean][] = [
  ["ORACLE", oracle, true],
  ["b1 shifted", [...oracle.slice(1), oracle[oracle.length - 1]! + truth.b], false],
  ["b2 reversed", [...oracle].reverse(), false],
  ["b3 out-of-family quadratic", us.map((u) => 20 + 0.5 * u * u), false],
  ["BOUNDARY invented (a=3,b=1)", us.map((u) => 3 + u), true],
]
for (const [name, claim, expectOk] of arms) {
  const r = mergeCheck(us, claim)
  const mark = r.ok === expectOk ? "as-registered" : "*** DEVIATES ***"
  console.log(`${name}: ok=${r.ok} reason=${r.reason ?? "-"} R=${r.R?.toExponential(2) ?? "-"} [${mark}]`)
}
for (const m of FIT_FAMILY) {
  const uv = px.map(m.u).sort((a, b) => a - b)
  const d = uv.slice(1).map((v, i) => v - uv[i]!)
  const mean = d.reduce((s, v) => s + v, 0) / d.length
  const cv = Math.sqrt(d.reduce((s, v) => s + (v - mean) ** 2, 0) / d.length) / mean
  console.log(`geometry u=${m.name}: spacing CV=${cv.toFixed(3)} alternates=${conditioningCheck(uv, uv.map((u) => 1 + 2 * u)).alternates}`)
}
```

- [ ] **Step 5: Commit the registration BEFORE running (structural no-tuning guard)**

```bash
bun scripts/gate-check.ts 2>&1 | tail -1
git add docs/loop-probes/dnc-second-fixture-20260820/
git commit -m "probe(lane-a): second-fixture registration — fixture, truth, runner committed before any transfer run (spec §8.1)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git rev-parse --short HEAD   # record as REG_SHA for Step 6
```

- [ ] **Step 6: Run and write the verdict, with the machinery-freeze proof**

Run: `bun docs/loop-probes/dnc-second-fixture-20260820/run-transfer.ts`
Then run the freeze guard and capture its (required-empty) output — the guard covers BOTH the machinery AND the fixture/registration files, so a post-run edit to `fixture.dat`, `truth.json`, `make-fixture.ts`, `run-transfer.ts`, or `pre-registration.md` is caught the same as a machinery edit (`verdict.md` does not exist yet at this point, so the probe-dir path is safe to include whole):

```bash
git diff --stat REG_SHA..HEAD -- opencode-plugin/src/bench/ docs/loop-probes/dnc-second-fixture-20260820/
```

Then create `verdict.md`: runner output verbatim in a fenced block; the freeze-guard command and its output verbatim (MUST be empty — ANY diff in either path between registration and verdict means machinery or fixture was edited in response to the result, which voids the transfer claim; record the void, do not "fix" it); each registered outcome marked HELD / FAILED; the registered decision applied. **If ANY line shows `*** DEVIATES ***` or the divide finds < 3 peaks: write the verdict recording the failure and STOP — do not modify detector, check, or fixture; the failure IS the deliverable.**

- [ ] **Step 7: Gate, then commit the verdict**

```bash
bun scripts/gate-check.ts 2>&1 | tail -1
git add docs/loop-probes/dnc-second-fixture-20260820/verdict.md
git commit -m "probe(lane-a): second fixture transfer verdict — machinery frozen at registration (spec §8.1)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: docs close-out

**Files:**
- Modify: `docs/resume.md` (top lane-A block + queue — SHARED FILE protocol)
- Modify: `docs/INDEX.md` (one line: D&C spec + library + probes entry)

**Interfaces:**
- Consumes: results of Tasks 1–11 (SHAs and the T10/T11 verdicts).

- [ ] **Step 1: INDEX entry**

Add one line to `docs/INDEX.md` under the design-docs section: `- D&C design (2026-08-20): docs/superpowers/specs/2026-08-20-dnc-design.md — divide/merge library (ships OFF) opencode-plugin/src/bench/{reval-fit,series-peaks,series-source}.ts; probes docs/loop-probes/dnc-*-20260820/; architect review docs/reviews/2026-08-20-dnc-spec-architect-review.md`

- [ ] **Step 2: resume.md update**

In the lane-A MOST RECENT STATE block, append after the existing D&C/queue text a short dated note: library built ships-OFF (list the three modules + test files), §8 obligations closed (O4 scored, noise-sweep verdict outcome in one clause, second-fixture verdict outcome in one clause, out-of-family bad set green, family enforcement test green), arming/L1-ab still own-go. Re-locate insert points by grep (line numbers drift).

- [ ] **Step 3: Stage SAFELY, commit**

```bash
git add docs/INDEX.md
git add -p docs/resume.md
git diff --cached -- docs/resume.md | head -60   # ONLY your hunks; anything else: git reset docs/resume.md and re-add
git commit -m "docs(lane-a): D&C library + validation obligations closed — INDEX + resume

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Final verification**

Run: `cd opencode-plugin && bun test 2>&1 | tail -3 && cd .. && bun scripts/gate-check.ts 2>&1 | tail -1 && git status --short && git log --oneline -12`
Expected: suite 0 fail, gate green, tree clean except pre-existing `term-bench2/probe-tasks/extract-elf-card/`, twelve-ish new commits. DO NOT PUSH — push has its own go.

---

## Self-Review (performed at write time)

- **Spec coverage:** §6.1 divide → T5/T6/T8; §6.2 family → T7; §6.3 delta → T1; §6.4 derived check + floor → T2; §6.5 coverage → T3; §6 scope/T6-boundary → T3 pin test; §8.1 → T11; §8.2+§8.6 → T10; §8.3 → T4; §8.5 → T7; §8.7 → T9; §8.9 → T6 (decision: path a, harness-side contained read). NOT covered on purpose (own gos, spec §9/§4): L1 bullets + ab, arming/wiring into the shipped gate, kkamak, push, §8.8 value-truth mechanism (open design item — needs its own spec round).
- **Placeholder scan:** none; every step carries code or exact content; T9/T10/T11 verdict files are written from ACTUAL runner output by explicit instruction, with registered rules fixed beforehand.
- **Type consistency:** `fitAffine(us, cs): AffineFit` (T1) used in T2/T3; `conditioningCheck(us, cs, tol?): ConditioningResult` (T2) used in T3/T8/T10/T11; `mergeCheck(anchorsU, canonicals): MergeResult` (T3) used in T4/T7/T11; `detectPeaks(ys): number[]` (T5) used in T8/T11; `readSeriesFile(filePath, rootDir)` (T6) used in T8/T11; `FIT_FAMILY` (T7) used in T8/T11. `truthOf` helper defined in T2's test block, used in T3/T4 test additions (same file, earlier definition).
