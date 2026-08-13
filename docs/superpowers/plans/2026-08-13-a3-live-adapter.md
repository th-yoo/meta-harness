# a3 Live Adapter (Plan B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Live sessions shadow-evaluate checked rules: every playbook-mutating store transition exports `.km/rule-checks.json`, and the kkamak gate (cc-gate-plugin) evaluates those checks at Stop and appends outcomes to the sensor line — never blocking, byte-identical when the file is absent.

**Architecture:** Producer (meta-harness store side) — one `exportRuleChecks(repoRoot, storeRoot)` helper called at every caller site where the active playbook changes; writes only `liveEligible: true` checks. Consumer (cc-gate-plugin) — a new `src/rule-checks.ts` evaluator slotted after the gauge in the Stop hook path, re-reading the file per call like gate.json, guarded by the runtime `unsafeReason` screen, capped by count + aggregate wall budget, emitting a new OPTIONAL `ruleChecks` SensorLine field. The SensorLine change is a coordinated contract rev (golden vectors both repos; kkamak-side verified on yoo-dev).

**Tech Stack:** Bun/TypeScript both sides; `bun test`; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-13-a3-rule-routing-design.md` §4 (+§1 contract, §7 success criteria). Plan A (TB2 adapter) merged `16c2303`; T9 probe clean (`docs/loop-probes/a3-t9-probe.md`).

## Global Constraints

- **F2:** command text lives in playbook.json and `.km/rule-checks.json` (both host-local/gitignored) — NEVER in sensor lines, gate-outcomes.ndjson, or anything km-sensors-sync exports. Sensor carries outcomes only: `{id, pass, ms}` / `{id, skipped}` / `{id, refused}`.
- **SHADOW:** the evaluator never blocks, never reinjects, never alters `StopResult` — it only annotates the sensor line. Would-block ⇒ exit 0, no block payload (test-pinned).
- **Absent file ⇒ byte-identical behavior** to today, test-pinned. Malformed file ⇒ fail-open (treated as absent), never throws.
- **Caps (spec §4, verbatim):** `RULE_CHECKS_MAX = 8` rules per Stop (file order; excess `skipped`), `RULE_CHECKS_BUDGET_MS = 5000` aggregate per Stop; each check runs with `min(check.timeoutMs, remaining budget)`; exhausted budget ⇒ remaining rules `skipped`, never run. Raising either is an instrument change (boundary ts).
- **Defense in depth:** consumer re-runs `unsafeReason` (gauge/guard.ts) on each cmd at evaluation time; failing ⇒ recorded `refused`, not executed.
- **Contract rev discipline:** `ruleChecks` is an addition to the FROZEN SensorLine contract. Golden vectors updated in BOTH repos in one change window; absent-field back-compat pinned; km-crank parity test upgraded: kkamak fixture PRESENT but missing the ruleChecks vector ⇒ HARD FAIL (absent fixture still skips — yoo-mac has no kkamak clone). Kkamak-side fixture update + parity green = **VERIFIED ON yoo-dev** (handoff step, cannot run on yoo-mac).
- **F1 / merging ≠ deploying:** cc-gate-plugin version bump 0.4.4 → 0.4.5 in the SAME change (both `.claude-plugin/plugin.json` and `package.json` — packaging.test.ts asserts parity); boundary ts in `docs/2026-08-01-gauntlet-adoption-ledger.md` at DEPLOY time; km-refresh + grep-verify cache per host is a separate act.
- **Suites serial** (standing rule). Producer suite: `cd opencode-plugin && bun test`. Consumer suite: `cd cc-gate-plugin && bun test`. km-crank suite: `cd km-crank && bun test`.
- **Export file shape (spec §4, fixed):** `{version: 1, writtenTs: <ms>, rules: [{id, cmd, timeoutMs, state}]}` — only `liveEligible: true` checks from active bullets; `rules: []` when none. Gitignored via existing `.km/` rule (.gitignore:3); EXCLUDED from `km-sensors-sync.sh` FILES (test-locked, Task 2).
- **Deferred by design (recorded, do not build):** multi-layer export union (no cross-layer checks exist — the 5e44620 asymmetry note); check-resend shadow-reset semantics (harmless while shadow-only — the 5e44620 Plan-B note; `state` is always `"shadow"` this cycle); promotion to `blocking` (§4 separate design).

---

### Task 1: Producer — `exportRuleChecks` helper

**Files:**
- Create: `opencode-plugin/src/rule-checks-export.ts`
- Test: `opencode-plugin/test/rule-checks-export.test.ts`

**Interfaces:**
- Consumes: `readPlaybook` from `./harness-store.ts` (reads `active/playbook.json` when called without a version — confirm exact signature at `harness-store.ts` before writing; `activateCandidate` uses `readPlaybook(storeRoot, version)` for candidates, baseline snapshot uses `readPlaybook(storeRoot)` for active), `Playbook`/`PlaybookBullet`/`BulletCheck` types from `./harness-store.ts`.
- Produces: `exportRuleChecks(repoRoot: string, storeRoot: string): void` and `RULE_CHECKS_EXPORT_REL = ".km/rule-checks.json"` — Task 2 wires the call sites; the cc-gate consumer (Task 3) reads the same path from its own constant (repos are separate packages; the path string is part of the spec contract, not a shared import).

- [ ] **Step 1: Write the failing test**

```ts
// opencode-plugin/test/rule-checks-export.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { exportRuleChecks, RULE_CHECKS_EXPORT_REL } from "../src/rule-checks-export.ts"
import type { Playbook } from "../src/harness-store.ts"

let repoRoot: string
let storeRoot: string

function writeActivePlaybook(pb: Playbook): void {
  mkdirSync(join(storeRoot, "active"), { recursive: true })
  writeFileSync(join(storeRoot, "active", "playbook.json"), JSON.stringify(pb, null, 2))
}

const basePb = (bullets: Playbook["bullets"]): Playbook => ({ schemaVersion: 1, nextId: bullets.length + 1, bullets })

const bullet = (id: string, over: Partial<Playbook["bullets"][number]> = {}): Playbook["bullets"][number] => ({
  id, text: `rule ${id}`, helpful: 0, harmful: 0, addedBy: "test", status: "active",
  createdAt: "2026-08-13T00:00:00Z", updatedAt: "2026-08-13T00:00:00Z", ...over,
})

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "rce-repo-"))
  storeRoot = mkdtempSync(join(tmpdir(), "rce-store-"))
})
afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
  rmSync(storeRoot, { recursive: true, force: true })
})

describe("exportRuleChecks", () => {
  test("writes only liveEligible checks from active bullets, spec file shape", () => {
    writeActivePlaybook(basePb([
      bullet("pb-1", { check: { cmd: "bun test --silent", timeoutMs: 30000, state: "shadow", liveEligible: true } }),
      bullet("pb-2", { check: { cmd: "curl example.com", timeoutMs: 5000, state: "shadow", liveEligible: false } }),
      bullet("pb-3"), // no check
      bullet("pb-4", { status: "pruned", check: { cmd: "true", timeoutMs: 1000, state: "shadow", liveEligible: true } }),
    ]))
    exportRuleChecks(repoRoot, storeRoot)
    const out = JSON.parse(readFileSync(join(repoRoot, RULE_CHECKS_EXPORT_REL), "utf8"))
    expect(out.version).toBe(1)
    expect(typeof out.writtenTs).toBe("number")
    expect(out.rules).toEqual([{ id: "pb-1", cmd: "bun test --silent", timeoutMs: 30000, state: "shadow" }])
  })

  test("empty rules array when no eligible checks; creates .km/ if missing", () => {
    writeActivePlaybook(basePb([bullet("pb-1")]))
    expect(existsSync(join(repoRoot, ".km"))).toBe(false)
    exportRuleChecks(repoRoot, storeRoot)
    const out = JSON.parse(readFileSync(join(repoRoot, RULE_CHECKS_EXPORT_REL), "utf8"))
    expect(out.rules).toEqual([])
  })

  test("no active playbook at storeRoot: writes empty rules (post-null-writeActive state)", () => {
    exportRuleChecks(repoRoot, storeRoot)
    const out = JSON.parse(readFileSync(join(repoRoot, RULE_CHECKS_EXPORT_REL), "utf8"))
    expect(out.rules).toEqual([])
  })

  test("overwrites a previous export wholesale (no merge)", () => {
    writeActivePlaybook(basePb([bullet("pb-1", { check: { cmd: "true", timeoutMs: 1000, state: "shadow", liveEligible: true } })]))
    exportRuleChecks(repoRoot, storeRoot)
    writeActivePlaybook(basePb([bullet("pb-9", { check: { cmd: "false", timeoutMs: 2000, state: "shadow", liveEligible: true } })]))
    exportRuleChecks(repoRoot, storeRoot)
    const out = JSON.parse(readFileSync(join(repoRoot, RULE_CHECKS_EXPORT_REL), "utf8"))
    expect(out.rules.map((r: { id: string }) => r.id)).toEqual(["pb-9"])
  })

  test("never throws: unwritable repoRoot is swallowed (fail-open producer)", () => {
    writeActivePlaybook(basePb([]))
    expect(() => exportRuleChecks(join(repoRoot, "no-such-parent", "x", "y"), storeRoot)).not.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd opencode-plugin && bun test test/rule-checks-export.test.ts`
Expected: FAIL — `Cannot find module '../src/rule-checks-export.ts'`

- [ ] **Step 3: Write minimal implementation**

```ts
// opencode-plugin/src/rule-checks-export.ts
/**
 * a3 live adapter (spec §4) — producer side of the .km/rule-checks.json
 * file contract. Called at every CALLER site where the active playbook
 * changes (Task 2): the helper re-reads the just-committed active playbook
 * from storeRoot rather than accepting one as a parameter, so the
 * resolveTrial CONFIRM branch (playbook already live, nothing passed
 * around) re-derives the export instead of skipping it.
 *
 * repoRoot vs storeRoot: `.km/` is rooted at the repo/project cwd (the
 * live gate reads `<cwd>/.km/rule-checks.json`), while store layers may
 * live under the repo (`<worktree>/.kkamak/...`) OR under the account
 * config dir — which has no repo at all. That is why this takes BOTH
 * roots and why call sites live in the callers (engine/propose/km-crank),
 * where a worktree is in scope, not inside harness-store's transition
 * functions, where it is not.
 *
 * Single-layer by design: the export reflects the TRANSITIONING layer's
 * active playbook only. Multi-layer union is the recorded 5e44620
 * asymmetry note — no cross-layer checks exist yet; do not build it here.
 *
 * F2: cmd text is confined to this gitignored host-local file (and the
 * store it came from). It must never enter the sensor stream or the
 * km-sensors-sync FILES list (test-locked in km-crank/test/
 * repos-parity.test.ts).
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { readPlaybook } from "./harness-store.ts"

export const RULE_CHECKS_EXPORT_REL = join(".km", "rule-checks.json")

export interface ExportedRuleCheck {
  id: string
  cmd: string
  timeoutMs: number
  state: "shadow" | "blocking"
}

export function exportRuleChecks(repoRoot: string, storeRoot: string): void {
  try {
    const pb = readPlaybook(storeRoot)
    const rules: ExportedRuleCheck[] =
      pb?.bullets
        .filter((b) => b.status === "active" && b.check?.liveEligible === true)
        .map((b) => ({ id: b.id, cmd: b.check!.cmd, timeoutMs: b.check!.timeoutMs, state: b.check!.state })) ?? []
    const outPath = join(repoRoot, RULE_CHECKS_EXPORT_REL)
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, JSON.stringify({ version: 1, writtenTs: Date.now(), rules }, null, 2) + "\n")
  } catch {
    // Fail-open: an export failure must never break a store transition.
    // The consumer treats a stale/absent file as absent (shadow-only).
  }
}
```

Note: confirm `readPlaybook(storeRoot)` (no version arg) reads `active/playbook.json` and returns `Playbook | null`-ish — adjust the null-coalescing to its real return type. If it throws on absent file, wrap that call specifically.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd opencode-plugin && bun test test/rule-checks-export.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Run the full opencode-plugin suite (serial)**

Run: `cd opencode-plugin && bun test`
Expected: green — this task adds a leaf module; nothing else changes.

- [ ] **Step 6: Commit**

```bash
git add opencode-plugin/src/rule-checks-export.ts opencode-plugin/test/rule-checks-export.test.ts
git commit -m "feat(store): exportRuleChecks producer helper — .km/rule-checks.json file contract (a3 live adapter T1)"
```

---

### Task 2: Producer wiring — call sites + F2 sync-exclusion lock

**Files:**
- Modify: `opencode-plugin/src/engine.ts` (~:829 `/mh-activate` path; ~:657 `resolveTrial` loop)
- Modify: `opencode-plugin/src/propose.ts` (~:636 `applyProposeArtifact` startTrial site; ~:1532 `applyCurateArtifact` startTrial site)
- Modify: `km-crank/src/trial-verdict.ts` (~:546 resolveGateTrial dep call) + `km-crank/src/crank.ts` (~:256 dep wiring)
- Modify: `km-crank/test/repos-parity.test.ts` (new FILES-exclusion test)
- Test: `opencode-plugin/test/rule-checks-export-wiring.test.ts`, extend `km-crank/test/trial-verdict.test.ts`

**Interfaces:**
- Consumes: `exportRuleChecks(repoRoot, storeRoot)` from Task 1.
- Produces: every spec-§4 transition writes the export. Sites and the root pair each passes:

| transition | call site | repoRoot | storeRoot |
|---|---|---|---|
| `/mh-activate` (any scope incl. account) | `engine.ts` right after the `activateCandidate(layer.root, version)` success branch (~:829) | `this.worktree` | `layer.root` |
| trial start (propose pipeline) | `propose.ts` immediately after each `startTrial(...)` call (~:636 and ~:1532; both are inside `if (isProject)`) | `worktree` (in scope from `d` at :353 / :1447) | `layer.root` |
| trial confirm AND revert | `engine.ts` `resolveTrial` loop (~:657): after `resolveTrial(layer.root)` returns, for BOTH `confirmed` and `reverted` resolutions | `this.worktree` | `layer.root` |
| gate-trial keep / rollback / abandoned | `km-crank/src/trial-verdict.ts` after `deps.resolveGateTrial(root, v)` (~:546) for verdicts `keep`, `rollback`, `abandoned` — `keep` is the gate-outcomes twin of `resolveTrial`'s confirm branch (playbook already live, `clearTrial` only at harness-store.ts:1644-1648) and gets the SAME reaffirm-not-skip treatment; only `deferred` (no state change) is exempt. Via NEW optional dep `deps.exportRuleChecks?.(repo, root)`; `crank.ts` wires the real helper at ~:256 | `repo` (REPOS entry, in scope at :546) | `root` |
| `cmdRolesImport` | NOT wired — null playbook, account store, no repo in scope (spec: "no export needed") | — | — |
| `bootstrapStore` | NOT wired — playbook param omitted, playbook unchanged | — | — |

- [ ] **Step 1: Write the failing wiring tests**

```ts
// opencode-plugin/test/rule-checks-export-wiring.test.ts
// Store-level integration: drive the REAL transition functions the way the
// engine/propose callers do, then assert the export appears/updates.
// (engine.ts itself is not importable in isolation — these tests pin the
// helper-at-transition semantics; the call-site placement in engine.ts /
// propose.ts is asserted by grep-level tests below and exercised by the
// existing propose-apply e2e tests once wired.)
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bootstrapStore, createCandidate, activateCandidate, startTrial, resolveTrial, recordSession, writePlaybook } from "../src/harness-store.ts"
import { exportRuleChecks, RULE_CHECKS_EXPORT_REL } from "../src/rule-checks-export.ts"
// NOTE to implementer: import names above must match harness-store's real
// exports — adjust to the actual candidate-creation/session-recording API
// (see test/agent-config.test.ts for the canonical transition-test recipe;
// reuse its helpers for candidate setup and trial-floor satisfaction).

describe("export-at-transition semantics", () => {
  let repoRoot: string
  let storeRoot: string
  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "rcw-repo-"))
    storeRoot = mkdtempSync(join(tmpdir(), "rcw-store-"))
  })
  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true })
    rmSync(storeRoot, { recursive: true, force: true })
  })

  function readExport() {
    return JSON.parse(readFileSync(join(repoRoot, RULE_CHECKS_EXPORT_REL), "utf8"))
  }

  test("activateCandidate then export reflects the newly active playbook's eligible checks", () => {
    // arrange: bootstrap, create candidate vN whose playbook carries one
    // liveEligible check (write playbook.json into candidates/vN/ via the
    // agent-config.test.ts recipe), then:
    //   activateCandidate(storeRoot, "vN")
    //   exportRuleChecks(repoRoot, storeRoot)   // what engine.ts:829 will do
    // assert: readExport().rules has exactly that check's {id, cmd, timeoutMs, state}
  })

  test("startTrial makes the trial playbook's checks live immediately; revert restores baseline export", () => {
    // arrange active playbook WITHOUT checks; startTrial with a playbook
    // carrying a liveEligible check + exportRuleChecks -> rules non-empty.
    // Then drive a losing trial (recordSession per the judge-trivial recipe),
    // resolveTrial -> reverted; exportRuleChecks again -> rules [] (baseline had none).
  })

  test("resolveTrial CONFIRM branch: export re-derived, not skipped (file rewritten)", async () => {
    // startTrial with eligible check + export; capture writtenTs; then
    // `await new Promise(r => setTimeout(r, 2))` — the sleep alone resolves
    // Date.now() same-ms flakiness (monotonic non-decreasing + a >=2ms gap
    // guarantees a REAL second write lands strictly later); drive a winning
    // trial; resolveTrial -> confirmed; export again. Assert STRICT >:
    //   expect(second.writtenTs).toBeGreaterThan(first.writtenTs)
    //   expect(second.rules).toEqual(first.rules) // content unchanged, reaffirmed
    // Strict > is load-bearing: an accidentally-SKIPPED reaffirm export
    // leaves writtenTs exactly equal (and rules trivially equal) — a >=
    // assertion would pass on the very bug this test exists to catch.
  })
})
```

Fill the three bodies with the real store API per `test/agent-config.test.ts` / `test/judge-trivial-fitness.test.ts` recipes — those files contain the canonical minimal sequences for candidate creation and trial floors; copy their setup helpers rather than inventing new ones.

Add the F2 sync-exclusion lock (mirror of the existing check-output test at `km-crank/test/repos-parity.test.ts:60`):

```ts
// repos-parity.test.ts uses namespace imports (import * as fs / * as path)
// and a per-test local repoRoot — mirror that exactly, no new imports:
test("F2: rule-checks export is NEVER in km-sensors-sync.sh's FILES export list", () => {
  const repoRoot = path.resolve(import.meta.dir, "..", "..")
  const script = fs.readFileSync(path.join(repoRoot, "scripts", "km-sensors-sync.sh"), "utf-8")
  const filesLine = script.split("\n").find((l) => l.trimStart().startsWith("FILES=("))
  expect(filesLine).toBeDefined()
  expect(filesLine!).not.toContain("rule-checks")
})
```

And in `km-crank/test/trial-verdict.test.ts`, extend the existing fake-deps recipe (fake `resolveGateTrial` at :595/:867): add an `exportRuleChecks` spy to deps and assert it is called with `(repo, root)` for `keep`, `rollback`, and `abandoned` verdicts, and NOT called for `deferred`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd opencode-plugin && bun test test/rule-checks-export-wiring.test.ts` and `cd km-crank && bun test test/trial-verdict.test.ts test/repos-parity.test.ts`
Expected: wiring tests FAIL (transitions don't export yet — the test bodies call exportRuleChecks manually so they pass trivially; the REAL failing assertions are the trial-verdict spy test and, after Step 3's engine/propose wiring, the e2e propose-apply suite). The repos-parity F2 test passes immediately (the list never contained it) — it is a regression lock, keep it.

- [ ] **Step 3: Wire the call sites**

Each site is ONE line plus the import — no scattered re-implementations:

```ts
// engine.ts ~:829 (after activateCandidate success):
exportRuleChecks(this.worktree, layer.root)

// engine.ts ~:657 (resolveTrial loop, after a resolution that changed or
// reaffirmed the playbook — BOTH "confirmed" and "reverted"):
exportRuleChecks(this.worktree, layer.root)

// propose.ts ~:636 and ~:1532 (immediately after startTrial):
exportRuleChecks(worktree, layer.root)

// km-crank/src/trial-verdict.ts ~:546 — v is GateTrialVerdict, an OBJECT
// ({verdict: "keep" | "rollback" | ...}); gate on v.verdict:
deps.resolveGateTrial(root, v)
if (v.verdict === "keep" || v.verdict === "rollback" || v.verdict === "abandoned") {
  deps.exportRuleChecks?.(repo, root)
}

// km-crank/src/trial-verdict.ts TrialScanDeps interface (~:437-457), new
// optional field beside resolveGateTrial:
exportRuleChecks?: (repo: string, root: string) => void

// km-crank/src/crank.ts — NEW import (exportRuleChecks lives in the new
// module, NOT harness-store.ts; same ../../opencode-plugin/src/ path shape
// as the existing harness-store import at :32-45):
import { exportRuleChecks } from "../../opencode-plugin/src/rule-checks-export.ts"

// crank.ts ~:256 dep wiring:
exportRuleChecks: (repo, root) => exportRuleChecks(repo, root),
```

- [ ] **Step 4: Run all three suites serial**

Run: `cd opencode-plugin && bun test` then `cd km-crank && bun test`
Expected: PASS, including the pre-existing `propose-apply.test.ts` e2e (startTrial sites now also write into the test worktree's `.km/` — if any propose-apply test asserts an exact worktree file listing, update it to tolerate `.km/rule-checks.json`).

- [ ] **Step 5: Commit**

```bash
git add opencode-plugin/src/engine.ts opencode-plugin/src/propose.ts opencode-plugin/src/rule-checks-export.ts opencode-plugin/test/rule-checks-export-wiring.test.ts km-crank/src/trial-verdict.ts km-crank/src/crank.ts km-crank/test/trial-verdict.test.ts km-crank/test/repos-parity.test.ts
git commit -m "feat(store): wire exportRuleChecks at every playbook-mutating transition + F2 sync-exclusion lock (a3 live adapter T2)"
```

---

### Task 3: Consumer — rule-checks evaluator module (cc-gate-plugin)

**Files:**
- Create: `cc-gate-plugin/src/rule-checks.ts`
- Test: `cc-gate-plugin/test/rule-checks.test.ts`

**Interfaces:**
- Consumes: `unsafeReason(check: string): string | undefined` from `./gauge/guard.ts`; `runCheck(cmd, cwd, timeoutMs): Promise<{code, out, ms}>` shape from `../check-runner.ts` (injected, not imported, for testability — mirror `shadowEvaluateAtStop`'s injection style at `gauge/shadow.ts:135`).
- Produces (Task 4 wires these):

```ts
export const RULE_CHECKS_MAX = 8
export const RULE_CHECKS_BUDGET_MS = 5000
export const RULE_CHECKS_FILE_REL: string // ".km/rule-checks.json"
export type RuleCheckOutcome =
  | { id: string; pass: boolean; ms: number }
  | { id: string; skipped: true }
  | { id: string; refused: true }
export async function evaluateRuleChecks(
  cwd: string,
  runCheckFn: (cmd: string, cwd: string, timeoutMs: number) => Promise<{ code: number; out: string; ms: number }>,
): Promise<RuleCheckOutcome[] | undefined>
```

Returns `undefined` when: file absent, unreadable, malformed JSON, `rules` not an array, or `rules` empty — all four mean "no `ruleChecks` field on the line" (absent is the cleaner line, same convention as `forced`). Whole body try/caught fail-open like `shadowEvaluateAtStop` (`gauge/shadow.ts:182-189`).

- [ ] **Step 1: Write the failing test**

```ts
// cc-gate-plugin/test/rule-checks.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { evaluateRuleChecks, RULE_CHECKS_MAX, RULE_CHECKS_BUDGET_MS } from "../src/rule-checks.ts"

let cwd: string
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "rc-")) })
afterEach(() => { rmSync(cwd, { recursive: true, force: true }) })

function writeRules(rules: unknown): void {
  mkdirSync(join(cwd, ".km"), { recursive: true })
  writeFileSync(join(cwd, ".km", "rule-checks.json"), JSON.stringify({ version: 1, writtenTs: 1, rules }))
}

const okRun = (ms = 10) => async (_cmd: string, _cwd: string, _t: number) => ({ code: 0, out: "", ms })
const failRun = async () => ({ code: 1, out: "", ms: 5 })

describe("evaluateRuleChecks", () => {
  test("absent file -> undefined (byte-identity upstream)", async () => {
    expect(await evaluateRuleChecks(cwd, okRun())).toBeUndefined()
  })
  test("malformed JSON -> undefined, never throws", async () => {
    mkdirSync(join(cwd, ".km"), { recursive: true })
    writeFileSync(join(cwd, ".km", "rule-checks.json"), "{nope")
    expect(await evaluateRuleChecks(cwd, okRun())).toBeUndefined()
  })
  test("empty rules -> undefined (absent is the cleaner line)", async () => {
    writeRules([])
    expect(await evaluateRuleChecks(cwd, okRun())).toBeUndefined()
  })
  test("pass/fail outcomes with ms; F2 — no cmd text in outcomes", async () => {
    writeRules([
      { id: "pb-1", cmd: "true", timeoutMs: 1000, state: "shadow" },
      { id: "pb-2", cmd: "false", timeoutMs: 1000, state: "shadow" },
    ])
    const runs: string[] = []
    const out = await evaluateRuleChecks(cwd, async (cmd, c, t) => { runs.push(cmd); return cmd === "true" ? { code: 0, out: "", ms: 3 } : { code: 1, out: "", ms: 4 } })
    expect(out).toEqual([{ id: "pb-1", pass: true, ms: 3 }, { id: "pb-2", pass: false, ms: 4 }])
    expect(JSON.stringify(out)).not.toContain("true") // ids/booleans only… see note below
    expect(runs).toEqual(["true", "false"])
  })
  test("runtime guard screen: unsafe cmd recorded refused, never executed", async () => {
    writeRules([{ id: "pb-1", cmd: "rm -rf /", timeoutMs: 1000, state: "shadow" }])
    const runs: string[] = []
    const out = await evaluateRuleChecks(cwd, async (cmd) => { runs.push(cmd); return { code: 0, out: "", ms: 1 } })
    expect(out).toEqual([{ id: "pb-1", refused: true }])
    expect(runs).toEqual([])
  })
  test("count cap: rules beyond RULE_CHECKS_MAX recorded skipped, file order", async () => {
    writeRules(Array.from({ length: RULE_CHECKS_MAX + 2 }, (_, i) => ({ id: `pb-${i}`, cmd: "true", timeoutMs: 100, state: "shadow" })))
    const out = (await evaluateRuleChecks(cwd, okRun()))!
    expect(out).toHaveLength(RULE_CHECKS_MAX + 2)
    expect(out.slice(RULE_CHECKS_MAX)).toEqual([
      { id: `pb-${RULE_CHECKS_MAX}`, skipped: true },
      { id: `pb-${RULE_CHECKS_MAX + 1}`, skipped: true },
    ])
  })
  test("aggregate budget: per-check timeout = min(timeoutMs, remaining); exhausted -> skipped", async () => {
    writeRules([
      { id: "pb-1", cmd: "sleep-ish", timeoutMs: 60000, state: "shadow" },
      { id: "pb-2", cmd: "true", timeoutMs: 1000, state: "shadow" },
    ])
    const timeouts: number[] = []
    const out = await evaluateRuleChecks(cwd, async (_cmd, _c, t) => { timeouts.push(t); return { code: 0, out: "", ms: RULE_CHECKS_BUDGET_MS } })
    // first check clamped to full budget, consumed it all; second skipped
    expect(timeouts).toEqual([RULE_CHECKS_BUDGET_MS])
    expect(out).toEqual([{ id: "pb-1", pass: true, ms: RULE_CHECKS_BUDGET_MS }, { id: "pb-2", skipped: true }])
  })
  test("malformed individual rule (missing id/cmd) -> that rule skipped, rest evaluated", async () => {
    writeRules([{ nope: true }, { id: "pb-2", cmd: "true", timeoutMs: 1000, state: "shadow" }])
    const out = await evaluateRuleChecks(cwd, okRun())
    expect(out).toEqual([{ id: "unknown", skipped: true }, { id: "pb-2", pass: true, ms: 10 }])
  })
  test("runCheckFn rejection (spawn failure) -> that rule skipped, prior outcomes kept", async () => {
    writeRules([
      { id: "pb-1", cmd: "true", timeoutMs: 1000, state: "shadow" },
      { id: "pb-2", cmd: "boom", timeoutMs: 1000, state: "shadow" },
      { id: "pb-3", cmd: "true", timeoutMs: 1000, state: "shadow" },
    ])
    const out = await evaluateRuleChecks(cwd, async (cmd) => {
      if (cmd === "boom") throw new Error("spawn failed")
      return { code: 0, out: "", ms: 2 }
    })
    expect(out).toEqual([
      { id: "pb-1", pass: true, ms: 2 },
      { id: "pb-2", skipped: true },
      { id: "pb-3", pass: true, ms: 2 },
    ])
  })
})
```

Note on the F2 assertion: asserting the serialized outcomes don't contain cmd text needs a cmd string that can't collide with legit values — use a distinctive cmd like `"echo F2CANARY"` and assert `not.toContain("F2CANARY")` instead of `"true"`. Write it that way.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cc-gate-plugin && bun test test/rule-checks.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// cc-gate-plugin/src/rule-checks.ts
/**
 * a3 live adapter (meta-harness spec §4) — SHADOW rule-check evaluator.
 * Reads <cwd>/.km/rule-checks.json per hook call (same locked re-read
 * discipline as gate.json — the file is producer-owned and may change
 * between Stops). SHADOW: outcomes annotate the sensor line only; this
 * module has no access to, and no effect on, the Stop decision.
 *
 * The file is host-local and hand-editable, so review-time screening is
 * not sufficient provenance: every cmd is re-screened with
 * gauge/guard.ts's unsafeReason at evaluation time (gauge read-only-guard
 * precedent); a screened-out cmd is recorded {id, refused: true} and
 * never executed.
 *
 * Cost caps — the two-tier gate-check work exists precisely to keep Stops
 * fast, and shadow must not undo it: at most RULE_CHECKS_MAX rules per
 * Stop (file order, excess recorded skipped) under an aggregate
 * RULE_CHECKS_BUDGET_MS wall budget; each check runs with
 * min(rule.timeoutMs, remaining). Skips are visible in the stream
 * ({id, skipped: true}), never silent. Raising either constant is an
 * instrument change (boundary ts in the adoption ledger).
 *
 * F2: outcomes carry {id, pass, ms} / {id, skipped} / {id, refused} —
 * never cmd text, never output. runCheck's `out` is discarded here the
 * same way evaluateGauge discards it.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { unsafeReason } from "./gauge/guard.ts"

export const RULE_CHECKS_MAX = 8
export const RULE_CHECKS_BUDGET_MS = 5000
export const RULE_CHECKS_FILE_REL = join(".km", "rule-checks.json")

export type RuleCheckOutcome =
  | { id: string; pass: boolean; ms: number }
  | { id: string; skipped: true }
  | { id: string; refused: true }

interface FileRule { id: string; cmd: string; timeoutMs: number; state: string }

function readRules(cwd: string): FileRule[] | undefined {
  let raw: string
  try {
    raw = readFileSync(join(cwd, RULE_CHECKS_FILE_REL), "utf8")
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(raw) as { rules?: unknown }
    if (!Array.isArray(parsed.rules)) return undefined
    return parsed.rules as FileRule[]
  } catch {
    return undefined
  }
}

export async function evaluateRuleChecks(
  cwd: string,
  runCheckFn: (cmd: string, cwd: string, timeoutMs: number) => Promise<{ code: number; out: string; ms: number }>,
): Promise<RuleCheckOutcome[] | undefined> {
  try {
    const rules = readRules(cwd)
    if (!rules || rules.length === 0) return undefined
    const outcomes: RuleCheckOutcome[] = []
    let remaining = RULE_CHECKS_BUDGET_MS
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i]
      const id = typeof r?.id === "string" ? r.id : "unknown"
      if (typeof r?.cmd !== "string" || typeof r?.timeoutMs !== "number") {
        outcomes.push({ id, skipped: true })
        continue
      }
      if (i >= RULE_CHECKS_MAX || remaining <= 0) {
        outcomes.push({ id, skipped: true })
        continue
      }
      if (unsafeReason(r.cmd) !== undefined) {
        outcomes.push({ id, refused: true })
        continue
      }
      try {
        const res = await runCheckFn(r.cmd, cwd, Math.min(r.timeoutMs, remaining))
        remaining -= res.ms
        outcomes.push({ id, pass: res.code === 0, ms: res.ms })
      } catch {
        // check-runner's runCheck can REJECT (spawn failure) — a mid-loop
        // rejection must not discard already-computed outcomes for this
        // Stop; record this rule skipped and keep going.
        outcomes.push({ id, skipped: true })
      }
    }
    return outcomes
  } catch {
    return undefined // fail-open, gauge/shadow.ts precedent
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd cc-gate-plugin && bun test test/rule-checks.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/rule-checks.ts cc-gate-plugin/test/rule-checks.test.ts
git commit -m "feat(gate): shadow rule-check evaluator — capped, guard-screened, fail-open (a3 live adapter T3)"
```

---

### Task 4: Consumer wiring — Stop path + SensorLine field + shadow/byte-identity pins

**Files:**
- Modify: `cc-gate-plugin/src/types.ts` (SensorLine + new field, ~:294 before closing brace)
- Modify: `cc-gate-plugin/src/core/sensor.ts` (`buildSensorLine` optional-spread, ~:3)
- Modify: `cc-gate-plugin/src/hook-cli.ts` (Stop path, between gauge block ~:291-305 and `appendSensor` ~:306)
- Test: extend `cc-gate-plugin/test/sensor.test.ts`, `cc-gate-plugin/test/sensor-contract.test.ts`, new assertions in `cc-gate-plugin/test/rule-checks.test.ts` or a wiring block in `test/stop.test.ts`-adjacent style

**Interfaces:**
- Consumes: `evaluateRuleChecks` / `RuleCheckOutcome` from Task 3; `runCheck` from `src/check-runner.ts`; existing `buildSensorLine` / `appendSensor` seams.
- Produces: `SensorLine.ruleChecks?: RuleCheckOutcome[]` — the contract-rev field Task 5 locks cross-repo.

- [ ] **Step 1: Write the failing tests**

types.ts doc + sensor builder test (extend `test/sensor.test.ts`'s field-set exactness test — it asserts EXACT key sets, so it fails until the builder knows the field):

```ts
test("ruleChecks: present iff provided, outcomes only", () => {
  const line = buildSensorLine(deps, { ...baseArgs, ruleChecks: [{ id: "pb-1", pass: true, ms: 3 }] })
  expect(line.ruleChecks).toEqual([{ id: "pb-1", pass: true, ms: 3 }])
  const bare = buildSensorLine(deps, baseArgs)
  expect("ruleChecks" in bare).toBe(false) // absent, not undefined-valued
})
```

Byte-identity + shadow-invariant pins, driven at the hook level via the existing sensor-contract harness (`test/sensor-contract.test.ts` — `mkRepo`/`edit`/`stop`/`sensorLines` helpers, real Stop path through `agent-cli-stub.ts`; follow the "driven emission conforms: clean accept" test at :155 as the template):

```ts
test("SHADOW + byte-identity: absent rule-checks file -> emitted line has NO ruleChecks key", async () => {
  const repo = mkRepo({ check: "true" })
  try {
    await edit(repo, "sid-rc-absent")
    await stop(repo, "sid-rc-absent")
    const lines = sensorLines(repo)
    expect(lines.length).toBe(1)
    const line = lines[0]!
    assertConformsToSensorContract(line)
    expect("ruleChecks" in line).toBe(false)
    expect(line.accepted).toBe(true)
    expect(line.rounds).toEqual(["accepted"])
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test("SHADOW invariant: failing rule check annotates the line; Stop still accepts, single line, no extra rounds", async () => {
  const repo = mkRepo({ check: "true" })
  try {
    fs.mkdirSync(path.join(repo, ".km"), { recursive: true })
    fs.writeFileSync(
      path.join(repo, ".km", "rule-checks.json"),
      JSON.stringify({ version: 1, writtenTs: 1, rules: [{ id: "pb-1", cmd: "false", timeoutMs: 1000, state: "shadow" }] }),
    )
    await edit(repo, "sid-rc-shadow")
    await stop(repo, "sid-rc-shadow")
    const lines = sensorLines(repo)
    expect(lines.length).toBe(1) // one line, one cycle — the failing rule did NOT block or reopen
    const line = lines[0]!
    assertConformsToSensorContract(line)
    expect(line.accepted).toBe(true)
    expect(line.rounds).toEqual(["accepted"]) // no verify-failed round from the rule check
    expect(line.ruleChecks).toHaveLength(1)
    const rc = (line.ruleChecks as Array<{ id: string; pass: boolean; ms: number }>)[0]!
    expect(rc.id).toBe("pb-1")
    expect(rc.pass).toBe(false)
    expect(typeof rc.ms).toBe("number")
    expect(JSON.stringify(line)).not.toContain("false\"") // F2: no cmd text on the line (cmd was "false")
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})
```

(F2-canary note: the literal `"false"` collides with JSON booleans in naive substring checks — the assertion above anchors on the quoted form; if that proves brittle, switch the rule cmd to `exit 42` and assert `not.toContain("exit 42")`.)

Also extend `assertConformsToSensorContract` (:98-129) with the same optional-field shape check pattern the function already uses for `checkMs`/`skippedStop`/`forced`:

```ts
if ("ruleChecks" in line) {
  expect(Array.isArray(line.ruleChecks)).toBe(true)
  for (const rc of line.ruleChecks as Array<Record<string, unknown>>) {
    expect(typeof rc.id).toBe("string")
    expect("cmd" in rc).toBe(false) // F2: outcomes never carry command text
    const shapeOk =
      (typeof rc.pass === "boolean" && typeof rc.ms === "number") ||
      rc.skipped === true || rc.refused === true
    expect(shapeOk).toBe(true)
  }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd cc-gate-plugin && bun test test/sensor.test.ts test/sensor-contract.test.ts`
Expected: FAIL — builder drops unknown arg / line lacks `ruleChecks`.

- [ ] **Step 3: Implement**

types.ts — append to `SensorLine` (before the closing brace), following the existing optional-field doc style:

```ts
  /** a3 live adapter (spec §4): shadow rule-check outcomes for this Stop.
   * Outcomes only — {id, pass, ms} | {id, skipped} | {id, refused} — never
   * command text (F2). Present iff .km/rule-checks.json existed with a
   * non-empty rules array this Stop; absent otherwise (absent is the
   * cleaner line, same convention as `forced`). SHADOW: these never
   * influenced the Stop decision. Caps: RULE_CHECKS_MAX / _BUDGET_MS
   * (src/rule-checks.ts); skips/refusals are visible states, not silence. */
  ruleChecks?: RuleCheckOutcome[]
```

(`import type { RuleCheckOutcome } from "./rule-checks.ts"` — if types.ts avoids src imports, move the type into types.ts and have rule-checks.ts import it; follow whichever direction existing types flow.)

sensor.ts — add to the args type and the optional spread chain (mirror `checkMs`):

```ts
...(args.ruleChecks !== undefined && args.ruleChecks.length > 0 ? { ruleChecks: args.ruleChecks } : {}),
```

hook-cli.ts — add the one new import to the import block (:13-32; `runCheck` is already imported at :32):

```ts
import { evaluateRuleChecks } from "./rule-checks.ts"
```

Then, in the Stop branch. CRITICAL variable identity: what gets appended at :306 is `line`, NOT `sensor` — `line` is derived from `sensor` at :276-278 (`{ ...sensor, reinject: arm, ... }`), possibly replaced by the gauge's return at :296-298 and annotated again at :303-305. Mutating `sensor` after that point is a no-op on a detached object. Splice AFTER :305 (all `line` reassignments done) and BEFORE :306's `if (line) appendSensor(...)`, targeting `line`:

```ts
// a3 live adapter: shadow rule checks — annotation only, after the Stop
// decision is final and after every `line` reassignment (gauge replace,
// no-record annotation); fail-open inside evaluateRuleChecks. Skip
// evaluation entirely when no line will be emitted this Stop — don't
// burn the budget for a line that won't exist.
if (line) {
  const ruleChecks = await evaluateRuleChecks(cwd, (cmd, c, t) => runCheck(cmd, c, t))
  if (ruleChecks) line = { ...line, ruleChecks }
}
```

(Production note: `buildSensorLine`'s new arg (below) is the TYPE-level contract; the real Stop flow attaches `ruleChecks` here at the IO boundary — `buildSensorLine` runs deep inside `core/stop.ts` (a MECHANISM_PATH, hook-cli.ts:315 F1 comment) and never sees it. The sensor-contract driven tests are the end-to-end proof; `sensor.test.ts`'s builder test only pins the builder's optional-spread convention.)

- [ ] **Step 4: Run the full cc-gate-plugin suite (serial)**

Run: `cd cc-gate-plugin && bun test`
Expected: PASS. `sensor-contract.test.ts`'s `REQUIRED_FIELDS`/negative-control must NOT list `ruleChecks` (it is optional); if the conformance asserts an exact optional-field allowlist, add `ruleChecks` there.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/types.ts cc-gate-plugin/src/core/sensor.ts cc-gate-plugin/src/hook-cli.ts cc-gate-plugin/test/sensor.test.ts cc-gate-plugin/test/sensor-contract.test.ts
git commit -m "feat(gate): wire shadow rule-checks into Stop path + SensorLine.ruleChecks field (a3 live adapter T4)"
```

---

### Task 5: Contract rev + version bump + cross-repo parity hard-fail (yoo-dev handoff)

**Files:**
- Modify: `km-crank/test/sensor-contract.test.ts` (~:114-141 — parity skip/vector logic)
- Modify: `km-crank/src/scan.ts` (~:39-65 — the package's locally-mirrored `SensorLine` interface re-declares each optional wire field with a doc comment even though `isSensorLine` doesn't shape-check them; add `ruleChecks?: Array<{ id: string; pass?: boolean; ms?: number; skipped?: true; refused?: true }>` in the same style so the local contract mirror stays current)
- Modify: `cc-gate-plugin/.claude-plugin/plugin.json` + `cc-gate-plugin/package.json` (version 0.4.4 → 0.4.5)
- Modify: `docs/resume.md` (yoo-dev handoff block — kkamak-side fixture duty)
- NOT in this repo: `~/z2/kkamak/test/fixtures/sensor-contract.ndjson` + kkamak's own conformance suite — YOO-DEV WORK, recorded as handoff, not executed here.

**Interfaces:**
- Consumes: the `ruleChecks` field shape from Task 4.
- Produces: the contract rev, deployable plugin version, and the recorded cross-repo duty.

- [ ] **Step 1: Write the failing parity-upgrade test**

In `km-crank/test/sensor-contract.test.ts`, replace the blanket skip (:126-132) semantics with:

```ts
// Absent fixture: still an advisory skip (yoo-mac has no kkamak clone).
// PRESENT fixture that lacks the ruleChecks vector: HARD FAIL — the
// contract rev must not land half-updated silently (spec §4 round-2
// finding 6).
if (!existsSync(KKAMAK_FIXTURE)) {
  console.log("cross-repo parity SKIPPED (kkamak fixture absent — advisory on this host; ruleChecks vector verified on yoo-dev)")
  return
}
const fixture = readFileSync(KKAMAK_FIXTURE, "utf8")
if (!fixture.includes('"ruleChecks"')) {
  throw new Error("kkamak sensor-contract fixture is missing the ruleChecks vector — the a3 contract rev landed half-updated; update ~/z2/kkamak's fixture + conformance suite in the same change window")
}
// ...existing byte-compare continues unchanged...
```

Also add a `ruleChecks`-bearing golden line to whatever local vector set the km-crank test byte-compares (mirror the exact fixture-update step into the yoo-dev handoff — the two fixtures must stay byte-equal).

- [ ] **Step 2: Run to verify behavior on THIS host**

Run: `cd km-crank && bun test test/sensor-contract.test.ts`
Expected: PASS via the advisory skip path (no kkamak clone on yoo-mac) — the console notice must mention the pending ruleChecks verification. The hard-fail branch is exercised by a unit-style test with a temp fixture file missing the vector (write that test too — create a temp file, point the check at it via the same path-constant seam or extract the vector-presence check into a tiny exported function `assertFixtureHasRuleChecksVector(raw: string)` and test THAT directly).

- [ ] **Step 3: Version bump (same change as the consumer code — F1)**

`cc-gate-plugin/.claude-plugin/plugin.json` and `cc-gate-plugin/package.json`: `"version": "0.4.5"`.
Run: `cd cc-gate-plugin && bun test test/packaging.test.ts` — parity assertion green.

- [ ] **Step 4: Record the yoo-dev handoff + deploy duties**

Append to the resume.md yoo-dev handoff block (and session-close block at close):

```
A3 CONTRACT REV (ruleChecks) — YOO-DEV DUTIES on next pull:
 1. ~/z2/kkamak: add the ruleChecks golden vector to
    test/fixtures/sensor-contract.ndjson (byte-equal to km-crank's) +
    extend kkamak's conformance suite; both repos' suites green in the
    SAME change window.
 2. km-crank/test/sensor-contract.test.ts now HARD-FAILS if the fixture
    exists but lacks the vector — that failure firing on yoo-dev means
    step 1 was skipped; do step 1, don't relax the test.
 3. Deploy: bun install in cc-gate-plugin, km-refresh, grep-verify 0.4.5
    in the plugin cache; boundary ts entry in
    docs/2026-08-01-gauntlet-adoption-ledger.md (instrument change:
    SensorLine +ruleChecks, caps RULE_CHECKS_MAX=8/BUDGET_MS=5000).
```

- [ ] **Step 5: Full serial suite sweep + commit**

Run: `cd opencode-plugin && bun test` then `cd cc-gate-plugin && bun test` then `cd km-crank && bun test`
Expected: all green (km-crank via advisory-skip path).

```bash
git add km-crank/test/sensor-contract.test.ts cc-gate-plugin/.claude-plugin/plugin.json cc-gate-plugin/package.json docs/resume.md
git commit -m "feat(contract): SensorLine ruleChecks rev — parity hard-fail on half-updated fixture, plugin 0.4.5, yoo-dev handoff (a3 live adapter T5)"
```

---

## Self-Review (done at write time)

- **Spec coverage:** §4 producer (all writeActive-adjacent sites + confirm-branch reaffirm) → T1/T2; §4 consumer (re-read invariant, shadow, caps, refused, skipped-visible) → T3/T4; §4 SensorLine contract rev + skip→hard-fail + yoo-dev verification → T5; §4 defense-in-depth (runtime unsafeReason) → T3; §4 F1 version bump/boundary-ts/deploy → T5; §7 success criteria "EVERY playbook-mutating store transition writes the export" → T2 table; "absent file = byte-identical (test-pinned)" → T4; "removing every check field reproduces today's behavior" → producer emits `rules: []` (T1 test) + consumer `undefined` on empty (T3 test). §4 `state: "blocking"` honored only post-promotion → NOT consumed anywhere (evaluator ignores `state`; recorded in Global Constraints deferred list).
- **Placeholder scan:** three wiring-test bodies in T2 Step 1 are commented recipes pointing at named existing test files (`agent-config.test.ts`, `judge-trivial-fitness.test.ts`) rather than full code — deliberate: the store transition API is large and those files ARE the canonical recipes; the assertions to make are stated concretely. T4's two driven tests are fully written (round-1 fix — they are the primary regression guard for the splice-point identity bug round 1 caught). All other steps carry real code.
- **Type consistency:** `RuleCheckOutcome` defined once (T3), imported by T4/T5; `exportRuleChecks(repoRoot, storeRoot)` signature identical in T1 def and every T2 site; `RULE_CHECKS_MAX`/`RULE_CHECKS_BUDGET_MS` named identically in spec, T3, T4 doc, T5 ledger note; file path `.km/rule-checks.json` via `RULE_CHECKS_EXPORT_REL` (producer) and `RULE_CHECKS_FILE_REL` (consumer) — two constants, two packages, same literal (spec contract, noted in T1 Interfaces).
- **Known open items honored:** rejected.json F2 ruling untouched (proposer side, not this plan); A/A ruling untouched; multi-layer union + shadow-reset deferred with citations.

## Review log

- round 1 (2026-08-13, fresh code-architect, FIX-FIRST → applied): F1 BLOCKING — T4 splice mutated `sensor`, but `line` (reassigned at :276-278/:296-298/:303-305) is what `appendSensor` receives; splice retargeted to `line = { ...line, ruleChecks }` after :305. F2 BLOCKING — trial-verdict gate compared the `GateTrialVerdict` OBJECT to a string; fixed to `v.verdict`. F3 BLOCKING — F2-exclusion test used undefined `REPO_ROOT` + wrong import style; rewritten to repos-parity's namespace-import/local-repoRoot pattern. F4 — gate-trial `keep` added to the export set (twin of resolveTrial's confirm reaffirm; only `deferred` exempt). F5 — `TrialScanDeps.exportRuleChecks?` field + crank.ts NEW-module import made explicit. F6 — writtenTs flakiness: 2ms sleep + `>=` + rules deep-equal. F7 — T4 driven tests written in full (were comment stubs; self-review claim corrected). F8 — km-crank scan.ts SensorLine mirror added to T5. F9 — `assertConformsToSensorContract` ruleChecks shape check added (incl. F2 `"cmd" in rc === false` pin). F11 — evaluator catches per-iteration runCheckFn rejection → `{id, skipped}` , prior outcomes kept, + test. Verified sound by same round: all harness-store/engine/propose/trial-verdict line refs, runCheck ms, unsafeReason, .gitignore, budget-boundary trace, prompt-path exemption, version-pin coverage, propose-apply no-listing-assertion (plan's warned risk doesn't exist — warning kept harmless), single-layer clobber = spec's own deferred note (acceptable-now).
- round 2 (same reviewer, scoped re-verify, FIX-FIRST → applied): MODERATE — the round-1 F6 fix over-corrected: `>=` + sleep neuters the reaffirm test (a SKIPPED export leaves writtenTs exactly equal → `>=` passes on the very bug the test guards); restored STRICT `toBeGreaterThan` — the 2ms sleep alone resolves same-ms flakiness. Trivial — T4 splice snippet lacked its own `import { evaluateRuleChecks }` line; added. Verified sound by same round: splice legality (`main()` async, no `line` reassignment after :305), GateTrialVerdict vocabulary exactly keep/rollback/deferred/abandoned with `deferred` the sole no-mutation branch, abandon-on-active-changed guard race-safe under caller-side `v.verdict` gating, repos-parity snippet compile-plausible, rejection-path budget untouched (trace exact), F2 canary `not.toContain("false\"")` sound JSON reasoning (bare boolean `false` never precedes `"`), `unsafeReason("false")` unmatched so the shadow check genuinely runs.
- round 3 (same reviewer, final scoped verify): both round-2 amendments confirmed correct and complete, no new defects — **FLAWLESS**.
