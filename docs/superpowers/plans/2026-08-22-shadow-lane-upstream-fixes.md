# Shadow-Lane Upstream Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the two starved shadow lanes decidable — rule checks gain a falsification-calibration contract (a check must prove it CAN fail before its data counts), and the hook-rule lane gets its first deployed rules (via playbook bullets, the only durable path — the exporter overwrites hand-edits).

**Architecture:** Store-side only. `BulletCheck` gains an optional `failProbe` (a bash snippet that constructs a violating state in a sandbox; the check must then exit nonzero). A calibration runner proves/refutes falsifiability per check and a report script joins calibration + sensor tallies. Hook rules are seeded as 4 structural playbook bullets (project-global layer) through a new authored-ops script that replicates the review gate's mechanical screens — then `exportHookRules` compiles them into `.km/hook-rules.json` and the existing ramp (`hook-rule-ramp.ts`) does promotion automatically once data accrues. The exported `.km/rule-checks.json` schema is byte-unchanged (cc-gate-plugin consumer untouched).

**Tech Stack:** Bun/TypeScript (opencode-plugin), bun:test, node:child_process (spawnSync bash) for calibration.

## Global Constraints

- Evidence discipline: authored ops run the SAME mechanical screens the review gate runs (`screenCheck`, `screenHookRule`) — an op that would fail the gate must be refused by the script.
- Generality rule (CLAUDE.md §1): every seeded rule/check is structural (incident-class-shaped), never a task or fixture answer key.
- `mode`/`state` are store-owned: authored ops never set them; `applyPlaybookOps` stamps `shadow` (existing behavior, verified at harness-store.ts:1173-1175).
- `.km/rule-checks.json` exported schema unchanged: `{id, cmd, timeoutMs, state}` only (cc-gate-plugin/src/rule-checks.ts `FileRule` parses it blind).
- F2: cmd text stays out of the sensor stream; calibration verdicts live in the store + report output only.
- Suite must be green after every task: `cd /Users/yoo/z2/meta-harness/opencode-plugin && bun test` (baseline 2280+/0).
- One task = one commit. No pushes (user pushes; solo-dev workflow, main directly).
- All store mutations in this plan touch `.kkamak/` (project layers, host-local, gitignored) — the SCRIPTS are the durable deliverable; yoo-dev reruns them after pull.

## File Structure

- `opencode-plugin/src/harness-store.ts` — `failProbe` on the bullet-check type + `PlaybookOp` + `applyPlaybookOps` passthrough (modify)
- `opencode-plugin/src/check-calibrate.ts` — sandbox falsification runner (create)
- `opencode-plugin/src/propose.ts` — checkContract paragraph documents `fail_probe` (modify)
- `opencode-plugin/src/review-gate.ts` — screens `failProbe.cmd` with `screenCheck` (modify)
- `opencode-plugin/scripts/authored-ops.ts` — operator lane: screen → apply → export (create)
- `opencode-plugin/scripts/seed-hook-rules.ts` — the 4 structural rules as add-ops, calls authored-ops machinery (create)
- `opencode-plugin/scripts/rule-check-report.ts` — per-rule denominator report: sensor tallies × calibration status (create)
- Tests: `opencode-plugin/test/check-calibrate.test.ts`, `test/authored-ops.test.ts`, `test/seed-hook-rules-patterns.test.ts`, plus edits to existing `test/harness-store*.test.ts` neighbors' pattern (create/modify)

---

### Task 1: `failProbe` field through the store types

**Files:**
- Modify: `opencode-plugin/src/harness-store.ts` (the bullet-check interface — grep `liveEligible` to land on it; `PlaybookOp` at ~L1095; `applyPlaybookOps` at ~L1160)
- Test: `opencode-plugin/test/harness-store-failprobe.test.ts` (create)

**Interfaces:**
- Produces: bullet-check type gains `failProbe?: { cmd: string; timeoutMs: number }`; `PlaybookOp` add/update `check` objects accept the same optional field; `applyPlaybookOps` copies it through verbatim on add and on update-with-check-object. Consumed by Tasks 2, 3, 5.

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test"
import { applyPlaybookOps, type Playbook } from "../src/harness-store.ts"

const base: Playbook = { schemaVersion: 1, nextId: 1, bullets: [] }

test("add op carries failProbe through to the stored check", () => {
  const pb = applyPlaybookOps(base, [{
    op: "add", text: "When X, do Y.",
    check: { cmd: "test -f out.txt", timeoutMs: 5000,
      failProbe: { cmd: "rm -f out.txt", timeoutMs: 5000 } },
  }])
  expect(pb.bullets[0]!.check?.failProbe?.cmd).toBe("rm -f out.txt")
  expect(pb.bullets[0]!.check?.state).toBe("shadow") // store-owned stamp unchanged
})

test("update op with check object replaces failProbe; omitted field keeps the old check whole", () => {
  const withProbe = applyPlaybookOps(base, [{
    op: "add", text: "When X, do Y.",
    check: { cmd: "c1", timeoutMs: 1000, failProbe: { cmd: "p1", timeoutMs: 1000 } },
  }])
  const replaced = applyPlaybookOps(withProbe, [{
    op: "update", id: "b1", text: "When X, do Y2.",
    check: { cmd: "c2", timeoutMs: 1000 }, // no failProbe → new check has none
  }])
  expect(replaced.bullets[0]!.check?.cmd).toBe("c2")
  expect(replaced.bullets[0]!.check?.failProbe).toBeUndefined()
  const kept = applyPlaybookOps(withProbe, [{ op: "update", id: "b1", text: "When X, do Y3." }])
  expect(kept.bullets[0]!.check?.failProbe?.cmd).toBe("p1") // tri-state: omitted = keep
})
```

- [ ] **Step 2: Run test, verify it fails** — `bun test test/harness-store-failprobe.test.ts`. Expected: TS error or `failProbe` undefined-property failure.

- [ ] **Step 3: Implement.** In the bullet-check interface add:

```ts
  /** Falsification probe (shadow-lane calibration, 2026-08-22): a bash
   * snippet that CONSTRUCTS the violating state in a throwaway sandbox dir;
   * the check cmd, run in that same dir afterward, must exit nonzero. A
   * check with no probe (or a probe under which it still passes) is
   * "unproven" — its always-green sensor tally carries no promotion
   * evidence (measured: 120/120 pass across b3/b7/b8, zero information).
   * Never exported to .km/rule-checks.json; store + calibration only. */
  failProbe?: { cmd: string; timeoutMs: number }
```

Add the same optional field to both `check` object literals in `PlaybookOp` (add + update variants). In `applyPlaybookOps`, extend the add-op check spread:

```ts
        ...(op.check ? { check: { cmd: op.check.cmd, timeoutMs: op.check.timeoutMs, state: "shadow" as const,
          ...(op.check.failProbe ? { failProbe: { cmd: op.check.failProbe.cmd, timeoutMs: op.check.failProbe.timeoutMs } } : {}) } } : {}),
```

and mirror the same `...(op.check.failProbe ...)` spread in the update-op's check-object branch.

- [ ] **Step 4: Run test, verify pass** — same command. Then full suite: `bun test`. Expected: green.
- [ ] **Step 5: Commit** — `git add opencode-plugin/src/harness-store.ts opencode-plugin/test/harness-store-failprobe.test.ts && git commit -m "feat(store): failProbe on bullet checks — falsification-calibration contract, store-side only"`

---

### Task 2: review gate screens `failProbe` like a check cmd

**Files:**
- Modify: `opencode-plugin/src/review-gate.ts` (the `b.check` screening branch, ~L117-137)
- Modify: `opencode-plugin/src/propose.ts` (the `checkContract` template string, ~L1490)
- Test: `opencode-plugin/test/review-gate-failprobe.test.ts` (create)

**Interfaces:**
- Consumes: `screenCheck(check: {cmd, timeoutMs}): {tier: "rejected"|"bench"|"live", reason?}` from `check-screen.ts` (unchanged).
- Produces: a bullet whose `check.failProbe.cmd` fails `screenCheck` is rejected whole with violation `check-screen:failprobe-<reason>` — same reject-whole-and-ledger contract as the check screen.

- [ ] **Step 1: Write the failing test.** Follow the existing fixture pattern in `test/` for `reviewAddedBullets` (grep `reviewAddedBullets` in test/ and copy its host/ledger stubs verbatim). Core assertion:

```ts
const outcomes = await reviewAddedBullets({
  host: stubHost, diagnosisReason: "r", activeSystem: "", ledger: [], scope: "project-global",
  bullets: [{ text: "When X, do Y.", check: { cmd: "test -f out", timeoutMs: 5000,
    // rejected-tier probe: screenCheck refuses network commands
    failProbe: { cmd: "curl http://example.com", timeoutMs: 5000 } } as never }],
})
expect(outcomes[0]!.staged).toBe(false)
expect(outcomes[0]!.violations[0]).toMatch(/^check-screen:failprobe-/)
```

(If `screenCheck` does not reject `curl` — check its rules first with a one-line unit probe — use a cmd it provably rejects, e.g. empty string or over-bound timeout: `failProbe: { cmd: "", timeoutMs: 5000 }` → reason `empty`.)

- [ ] **Step 2: Run, verify fails** (bullet currently stages — no probe screening exists).
- [ ] **Step 3: Implement.** In `review-gate.ts`, directly after the existing `screenCheck(b.check)` rejected-branch, add:

```ts
      const probe = (b.check as { failProbe?: { cmd: string; timeoutMs: number } }).failProbe
      if (probe) {
        const pScreened = screenCheck(probe)
        if (pScreened.tier === "rejected") {
          out.push({
            bullet: `${b.text} [failProbe: screen-denied (${pScreened.reason})]`,
            staged: false,
            violations: [`check-screen:failprobe-${pScreened.reason}`],
            trail: [],
          })
          continue
        }
      }
```

In `propose.ts`'s `checkContract` string, append one sentence to the first paragraph:

```
A check SHOULD also carry "fail_probe": {"cmd": "<shell command that CONSTRUCTS the violating state in an empty sandbox directory>", "timeoutMs": <number>} — the harness verifies the check exits nonzero after the probe runs; a check that cannot demonstrate a failing state earns no promotion evidence from passing (a permanently-green check is vacuous, not safe).
```

Wire `fail_probe` → `failProbe` in whatever op-parsing code maps proposer JSON to `PlaybookOp` (grep `hookRule` in the same parsing site and mirror its optional-field handling).

- [ ] **Step 4: Run test + full suite.** Green.
- [ ] **Step 5: Commit** — `git commit -m "feat(gate): screen failProbe cmds like check cmds; proposer contract documents fail_probe"`

---

### Task 3: calibration runner

**Files:**
- Create: `opencode-plugin/src/check-calibrate.ts`
- Test: `opencode-plugin/test/check-calibrate.test.ts`

**Interfaces:**
- Produces: `calibrateCheck(check: { cmd: string; timeoutMs: number; failProbe?: { cmd: string; timeoutMs: number } }): { calibrated: boolean; reason: "no-probe" | "probe-failed" | "vacuous-on-bad-state" | "check-fails-on-bad-state" }`. Consumed by Task 5 backfill and the Task 6 report.

- [ ] **Step 1: Write the failing tests**

```ts
import { test, expect } from "bun:test"
import { calibrateCheck } from "../src/check-calibrate.ts"

test("no probe → uncalibrated", () => {
  expect(calibrateCheck({ cmd: "true", timeoutMs: 5000 }).reason).toBe("no-probe")
})

test("vacuous check: passes even on probed-bad state", () => {
  const r = calibrateCheck({ cmd: "jobs -r | wc -l", timeoutMs: 5000,
    failProbe: { cmd: "echo garbage > corrupt.json", timeoutMs: 5000 } })
  expect(r.calibrated).toBe(false)
  expect(r.reason).toBe("vacuous-on-bad-state")
})

test("falsifiable check: probe constructs bad state, check fails on it", () => {
  const r = calibrateCheck({
    cmd: `for f in *.json; do [ -e "$f" ] || exit 0; python3 -c "import json;json.load(open('$f'))" || exit 1; done`,
    timeoutMs: 10000,
    failProbe: { cmd: "echo '{bad' > corrupt.json", timeoutMs: 5000 } })
  expect(r.calibrated).toBe(true)
  expect(r.reason).toBe("check-fails-on-bad-state")
})

test("probe itself failing is its own verdict, not a calibration", () => {
  const r = calibrateCheck({ cmd: "true", timeoutMs: 5000,
    failProbe: { cmd: "exit 3", timeoutMs: 5000 } })
  expect(r.calibrated).toBe(false)
  expect(r.reason).toBe("probe-failed")
})
```

- [ ] **Step 2: Run, verify fails** (module absent).
- [ ] **Step 3: Implement**

```ts
/** Falsification calibration (shadow-lane upstream fix, 2026-08-22).
 * One leg only — CAN the check fail: run the probe in a fresh sandbox dir
 * (never the repo — a probe constructs BAD state by design), then the check
 * in that same dir; calibrated iff the check exits nonzero there. The
 * passes-on-good-state leg is already measured for free by the shadow lane
 * itself (every sensor line is a good-state run), so it is not re-proven
 * here. Sandbox is a mkdtemp dir, removed on every path. */
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export type CalibrationReason = "no-probe" | "probe-failed" | "vacuous-on-bad-state" | "check-fails-on-bad-state"

export function calibrateCheck(check: {
  cmd: string; timeoutMs: number; failProbe?: { cmd: string; timeoutMs: number }
}): { calibrated: boolean; reason: CalibrationReason } {
  if (!check.failProbe) return { calibrated: false, reason: "no-probe" }
  const dir = mkdtempSync(join(tmpdir(), "mh-check-calib-"))
  try {
    const probe = spawnSync("bash", ["-c", check.failProbe.cmd], { cwd: dir, timeout: check.failProbe.timeoutMs })
    if (probe.status !== 0) return { calibrated: false, reason: "probe-failed" }
    const chk = spawnSync("bash", ["-c", check.cmd], { cwd: dir, timeout: check.timeoutMs })
    return chk.status !== 0
      ? { calibrated: true, reason: "check-fails-on-bad-state" }
      : { calibrated: false, reason: "vacuous-on-bad-state" }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
```

- [ ] **Step 4: Run test + full suite.** Green.
- [ ] **Step 5: Commit** — `git commit -m "feat(calibrate): sandbox falsification runner — a check must prove it can fail"`

---

### Task 4: authored-ops script (operator lane with gate-equivalent screens)

**Files:**
- Create: `opencode-plugin/scripts/authored-ops.ts`
- Test: `opencode-plugin/test/authored-ops.test.ts`

**Interfaces:**
- Consumes: `readPlaybook`, `applyPlaybookOps`, `type PlaybookOp` (harness-store); `screenCheck` (check-screen); `screenHookRule` (hook-rule-screen); `exportRuleChecks` (rule-checks-export); `exportHookRules` (hook-rules-export); `calibrateCheck` (Task 3).
- Produces: `applyAuthoredOps(a: { storeRoot: string; repoRoot: string; ops: PlaybookOp[]; provenance: string }): { applied: boolean; refusals: string[] }` — exported for tests and for Task 6's seed script; plus a thin CLI (`bun scripts/authored-ops.ts <storeRoot> <ops.json>`).

- [ ] **Step 1: Write the failing tests** (tmpdir store; write a minimal `active/playbook.json` fixture first — copy the `writeActive`-based fixture setup from `test/proposer-prompt-ledger.test.ts` and write the playbook JSON directly with `writeFileSync`):

```ts
import { test, expect } from "bun:test"
import * as fs from "node:fs"; import * as path from "node:path"; import * as os from "node:os"
import { applyAuthoredOps } from "../scripts/authored-ops.ts"

function store(): { root: string; repo: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mh-authored-store-"))
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "mh-authored-repo-"))
  fs.mkdirSync(path.join(root, "active"), { recursive: true })
  fs.writeFileSync(path.join(root, "active", "playbook.json"),
    JSON.stringify({ schemaVersion: 1, nextId: 1, bullets: [] }))
  return { root, repo }
}

test("screen-failing hookRule op refuses the WHOLE batch, store untouched", () => {
  const { root, repo } = store()
  const r = applyAuthoredOps({ storeRoot: root, repoRoot: repo, provenance: "test",
    ops: [
      { op: "add", text: "When A, do B." },
      { op: "add", text: "When C, do D.", hookRule: { event: "PreToolUse", toolMatcher: "Bash",
        inputPattern: "(a+)+", feedback: "nope" } }, // backtracking risk → screen refusal
    ] })
  expect(r.applied).toBe(false)
  expect(r.refusals.length).toBeGreaterThan(0)
  const pb = JSON.parse(fs.readFileSync(path.join(root, "active", "playbook.json"), "utf8"))
  expect(pb.bullets).toHaveLength(0)
})

test("clean ops apply, stamp shadow, and export both tables", () => {
  const { root, repo } = store()
  const r = applyAuthoredOps({ storeRoot: root, repoRoot: repo, provenance: "test",
    ops: [{ op: "add", text: "When E, do F.", hookRule: { event: "PreToolUse", toolMatcher: "Bash",
      inputPattern: "^rm .*(kkamak|candidates/)", feedback: "read target first" } }] })
  expect(r.applied).toBe(true)
  const pb = JSON.parse(fs.readFileSync(path.join(root, "active", "playbook.json"), "utf8"))
  expect(pb.bullets[0].hookRule.mode).toBe("shadow")
  const table = JSON.parse(fs.readFileSync(path.join(repo, ".km", "hook-rules.json"), "utf8"))
  expect(table.rules).toHaveLength(1)
  expect(table.rules[0].mode).toBe("shadow")
})
```

- [ ] **Step 2: Run, verify fails.**
- [ ] **Step 3: Implement.** Core shape (all-or-nothing: any refusal aborts the batch before any write):

```ts
/** Operator lane for playbook ops (v7 authored-update precedent, formalized).
 * Replicates the review gate's MECHANICAL screens exactly — an op the gate
 * would kill pre-LLM is refused here; what this lane deliberately skips is
 * the LLM judgment round, which is the operator's accountability. Writes
 * active/playbook.json atomically and re-exports both .km tables. */
import * as fs from "node:fs"; import * as path from "node:path"
import { readPlaybook, applyPlaybookOps, type PlaybookOp } from "../src/harness-store.ts"
import { screenCheck } from "../src/check-screen.ts"
import { screenHookRule } from "../src/hook-rule-screen.ts"
import { exportRuleChecks } from "../src/rule-checks-export.ts"
import { exportHookRules } from "../src/hook-rules-export.ts"

export function applyAuthoredOps(a: { storeRoot: string; repoRoot: string; ops: PlaybookOp[]; provenance: string }): { applied: boolean; refusals: string[] } {
  const refusals: string[] = []
  for (const op of a.ops) {
    if (op.op === "delete") continue
    if (op.check) {
      const s = screenCheck(op.check)
      if (s.tier === "rejected") refusals.push(`${op.op}:"${op.text.slice(0, 40)}" check ${s.reason}`)
      const probe = (op.check as { failProbe?: { cmd: string; timeoutMs: number } }).failProbe
      if (probe) { const ps = screenCheck(probe); if (ps.tier === "rejected") refusals.push(`${op.op} failProbe ${ps.reason}`) }
    }
    if (op.hookRule) {
      const hs = screenHookRule(op.hookRule)
      if (!hs.ok) refusals.push(`${op.op}:"${op.text.slice(0, 40)}" hookRule ${hs.violation}`)
    }
  }
  if (refusals.length > 0) return { applied: false, refusals }
  const base = readPlaybook(a.storeRoot) ?? { schemaVersion: 1, nextId: 1, bullets: [] }
  const next = applyPlaybookOps(base, a.ops)
  const p = path.join(a.storeRoot, "active", "playbook.json")
  fs.writeFileSync(p + ".tmp", JSON.stringify(next, null, 2) + "\n"); fs.renameSync(p + ".tmp", p)
  exportRuleChecks(a.repoRoot, a.storeRoot)
  exportHookRules(a.repoRoot, a.storeRoot)
  console.error(`authored-ops[${a.provenance}]: applied ${a.ops.length} op(s)`)
  return { applied: true, refusals: [] }
}

if (import.meta.main) {
  const [storeRoot, opsFile] = process.argv.slice(2)
  if (!storeRoot || !opsFile) { console.error("usage: bun scripts/authored-ops.ts <storeRoot> <ops.json>"); process.exit(2) }
  const ops = JSON.parse(fs.readFileSync(opsFile, "utf8")) as PlaybookOp[]
  const r = applyAuthoredOps({ storeRoot, repoRoot: process.cwd(), ops, provenance: "cli" })
  if (!r.applied) { console.error("REFUSED:\n  " + r.refusals.join("\n  ")); process.exit(1) }
}
```

Caveat to verify while implementing: if `readPlaybook`'s empty-store default shape differs (check its null contract), keep the `?? {schemaVersion:1,nextId:1,bullets:[]}` literal in sync with the `Playbook` type; if `screenHookRule` rejects a `mode`-less object for a missing required field other than mode, adjust the seed objects, not the screen.

- [ ] **Step 4: Run test + full suite.** Green.
- [ ] **Step 5: Commit** — `git commit -m "feat(scripts): authored-ops operator lane — gate-equivalent screens, atomic apply, table re-export"`

---

### Task 5: backfill — retire b3's vacuous check, deploy one calibrated check

**Files:**
- Create: `opencode-plugin/scripts/backfill-mh-build-checks.ts` (the ops as code, so yoo-dev replays it)
- Test: `opencode-plugin/test/backfill-ops.test.ts` (screens + calibration of the NEW check pass; b3-drop op shape correct)

**Interfaces:**
- Consumes: `applyAuthoredOps` (Task 4), `calibrateCheck` (Task 3).
- Store targets (run-time, host-local): `<repo>/.kkamak/roles/mh-build` (b3 lives here) — verify with `ls .kkamak/roles/` before running.

The two ops, exactly (exported as `BACKFILL_OPS` so the test imports them):

```ts
import type { PlaybookOp } from "../src/harness-store.ts"

// b3's check `jobs -r | wc -l` is vacuous BY CONSTRUCTION: the check runs in
// a fresh shell (no jobs table) and `wc` exits 0 regardless — 52/52 recorded
// passes carry zero information. The bullet TEXT stays (behavioral rule,
// works as prose); the check is dropped via the tri-state null contract.
// The replacement check guards a real measured incident class (poisoned
// rejected.json, 2026-08-17 — store JSON must always parse) and is
// falsifiable: the probe writes malformed JSON, the check must reject it.
export const BACKFILL_OPS: PlaybookOp[] = [
  { op: "update", id: "b3",
    text: "When a background run you started is still incomplete at the end of a turn, report it as still running with its check condition — never as done.",
    check: null },
  { op: "add",
    text: "Do not end a turn that modified evolution-store state until every store JSON file you touched still parses.",
    generality: "universal",
    check: {
      cmd: `ok=0; for f in .kkamak/*/active/*.json .kkamak/*/*/active/*.json *.json; do [ -e "$f" ] || continue; python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$f" || ok=1; done; exit $ok`,
      timeoutMs: 15000,
      failProbe: { cmd: `echo '{bad' > corrupt.json`, timeoutMs: 5000 },
    } },
]
```

- [ ] **Step 1: Write the failing test** — imports `BACKFILL_OPS`, asserts (a) `screenCheck` on the new check and its probe both return tier ≠ `"rejected"`, (b) `calibrateCheck` on the new check object returns `{calibrated: true, reason: "check-fails-on-bad-state"}`, (c) the b3 op carries `check: null` (drop, not keep). Note the check's glob list includes bare `*.json` exactly so the sandbox probe's `corrupt.json` is in scope — assert calibration proves it.
- [ ] **Step 2: Run, verify fails** (script absent).
- [ ] **Step 3: Implement the script**: the `BACKFILL_OPS` export above + `import.meta.main` block calling `applyAuthoredOps({ storeRoot: ".kkamak/roles/mh-build", repoRoot: process.cwd(), ops: BACKFILL_OPS, provenance: "backfill-20260822" })`, then printing `calibrateCheck` verdicts for every active bullet check.
- [ ] **Step 4: Run test + full suite.** Green.
- [ ] **Step 5: EXECUTE against the live store** (this is host-local state, the repo rules apply — read first): `cat .kkamak/roles/mh-build/active/playbook.json | python3 -m json.tool | head -30` to confirm current shape, then `bun opencode-plugin/scripts/backfill-mh-build-checks.ts` from the repo root. Verify: `.km/rule-checks.json` now carries the new bullet's check (state shadow) and NOT b3's.
- [ ] **Step 6: Commit** — `git commit -m "feat(backfill): retire b3 vacuous check, deploy calibrated store-json-integrity check (probe-proven falsifiable)"`

---

### Task 6: seed the hook-rule lane — 4 structural rules

**Files:**
- Create: `opencode-plugin/scripts/seed-hook-rules.ts` (exports `SEED_OPS`)
- Test: `opencode-plugin/test/seed-hook-rules-patterns.test.ts`

**Interfaces:**
- Consumes: `applyAuthoredOps` (Task 4); `evalHookRules` (adapters/claude-code/hook-rule-eval.ts) and `screenHookRule` for the pattern tests.
- Store target (run-time): `<repo>/.kkamak/global` (project-global — rules govern every agent in this repo).

The four rules — each from a measured incident class, structural, portable-subset patterns (no backslash escapes, no `\d\w\s`, `^`-anchored):

```ts
import type { PlaybookOp } from "../src/harness-store.ts"

export const SEED_OPS: PlaybookOp[] = [
  // Incident class: store deletion/overwrite without reading (CLAUDE.md rule;
  // poisoned-rejected.json + v0-junk-bak precedents).
  { op: "add",
    text: "Do not delete or move evolution-store paths until you have read the target and named what it holds.",
    hookRule: { event: "PreToolUse", toolMatcher: "Bash",
      inputPattern: "^(rm|mv) .*(kkamak|rejected.json|candidates/|.km/)",
      feedback: "Store state: read the target first (ls/cat), prefer archiving over deleting." } },
  // Incident class: single-> redirect truncating append-only ndjson stores.
  { op: "add",
    text: "Do not overwrite an append-only ndjson store with a bare redirect; append or write a new file.",
    hookRule: { event: "PreToolUse", toolMatcher: "Bash",
      inputPattern: "[^>]> *[a-zA-Z0-9_./-]*ndjson",
      feedback: "That ndjson is append-only telemetry — a single > truncates it." } },
  // Incident class: blind store-sync export (measured 381-deletion split-brain, 2026-08-17).
  { op: "add",
    text: "Do not run a bulk store-sync export without reviewing the diff first.",
    hookRule: { event: "PreToolUse", toolMatcher: "Bash",
      inputPattern: "store-sync.sh +export",
      feedback: "Blind export is the data-loss trap — diff first, sync surgically." } },
  // Incident class: history rewrite on shared main (repo rule: explicit go).
  { op: "add",
    text: "Do not force-push or hard-reset shared branches without an explicit go.",
    hookRule: { event: "PreToolUse", toolMatcher: "Bash",
      inputPattern: "git .*(push[^|]*--force|reset +--hard +origin)",
      feedback: "History rewrite on a shared branch needs an explicit go." } },
]
```

- [ ] **Step 1: Write the failing tests.** For each rule: (a) `screenHookRule({event,toolMatcher,inputPattern,feedback})` returns `ok: true` (no `mode` key present — store stamps it); (b) `evalHookRules` on a compiled single-rule table MATCHES a true-positive command and DOES NOT match a benign near-miss:

| rule | must match | must not match |
|---|---|---|
| rm/mv store | `rm -rf .kkamak/global` | `rm -rf node_modules` |
| ndjson redirect | `echo x > .km/gate-outcomes.ndjson` | `cat a.ndjson >> backup.ndjson` |
| store-sync | `term-bench2/store-sync.sh export` | `term-bench2/store-sync.sh import` |
| force-push | `git push origin main --force` | `git push origin main` |

Build the table JSON for `evalHookRules` exactly as `compileHookRulesTable` emits it: `{version:1, writtenTs:0, killSwitch:false, rules:[{id:"b1", event, toolMatcher, inputPattern, feedback, mode:"shadow"}]}` (check `evalHookRules`'s exact signature — `(tableJson: string, toolName, toolInput)` per dispatch.ts:246 — and match the `tool_input` key it greps for Bash commands, likely `command`).

- [ ] **Step 2: Run, verify fails** (script absent). If any pattern fails its match/no-match pair or the screen, FIX THE PATTERN in `SEED_OPS` — the test is the contract.
- [ ] **Step 3: Implement the script**: `SEED_OPS` + `import.meta.main` block calling `applyAuthoredOps({ storeRoot: ".kkamak/global", repoRoot: process.cwd(), ops: SEED_OPS, provenance: "seed-hook-rules-20260822" })`.
- [ ] **Step 4: Run test + full suite.** Green.
- [ ] **Step 5: EXECUTE live**: read first (`python3 -m json.tool .kkamak/global/active/playbook.json | head -20`), then `bun opencode-plugin/scripts/seed-hook-rules.ts`. Verify `.km/hook-rules.json` carries 4 shadow rules.
- [ ] **Step 6: Commit** — `git commit -m "feat(seed): 4 structural hook rules deployed to project-global — the P2 shadow lane finally has a denominator"`

---

### Task 7: live wire proof — synthetic PreToolUse through to a sensor line

**Files:** none (evidence-only task; findings go in the Task 8 doc)

- [ ] **Step 1: Fire a matching PreToolUse** through the real dispatcher (proven pattern from the proposer probes):

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf .kkamak/does-not-exist-probe"},"cwd":"/Users/yoo/z2/meta-harness","session_id":"hookrule-wire-probe"}' \
  | bun opencode-plugin/src/adapters/claude-code/hook-cli.ts PreToolUse
```

Expected: exit 0, NO deny (shadow mode), and `.km/hook-rule-outcomes-hookrule-wire-probe.ndjson` appears with one line carrying the matched rule id + `mode:"shadow"`.

- [ ] **Step 2: Verify the accumulator line**: `cat .km/hook-rule-outcomes-hookrule-wire-probe.ndjson` — quote the line.
- [ ] **Step 3: Stop-path aggregation.** The accumulator → sensor join runs in cc-gate-plugin's Stop path (0.4.7). Confirm the installed lab plugin ≥ 0.4.7 (`grep pluginVersion` on the tail of `.km/gate-outcomes.ndjson` — 134 lines already carry 0.4.7), then either wait for the next organic Stop in a real session on this repo, or fire cc-gate's Stop hook-cli synthetically with the same session_id (locate: `grep -n "hook-rule-outcomes" cc-gate-plugin/src/hook-cli.ts` for the exact event name it consumes). Evidence bar: one line in `.km/gate-outcomes.ndjson` carrying `hookRules:[...]` with the probe rule's id. If the synthetic Stop path proves awkward, the organic-session fallback is acceptable — record which one produced the line.
- [ ] **Step 4: No commit** (nothing tracked changed); evidence lines go into Task 8's doc.

---

### Task 8: docs — resume block + yoo-dev replay instructions

**Files:**
- Modify: `docs/resume.md` (new block above MOST RECENT STATE, following house style)
- Test: none (docs)

- [ ] **Step 1: Write the block.** Contents, house-style compressed: shadow-lane audit numbers (550 lines; ruleChecks 120/120 pass = zero promotion evidence; hookRules 0 carriers, `rules:[]` by construction; coEdit 30/32 clean → boolean permanently shadow, decided); what shipped (failProbe contract + screens, calibration runner, authored-ops lane, b3 vacuous check retired + calibrated JSON-integrity check live, 4 structural hook rules seeded shadow); wire-proof evidence lines from Task 7; **yoo-dev replay**: `git pull` then `bun opencode-plugin/scripts/backfill-mh-build-checks.ts && bun opencode-plugin/scripts/seed-hook-rules.ts` (`.kkamak`/`.km` host-local — scripts are the transfer); revisit condition: hook-rule-ramp promotes automatically at its FP-proxy θ once matched-session data accrues — re-run the tally after ~2 weeks of dogfood sessions.
- [ ] **Step 2: Commit** — `git commit -m "docs(resume): shadow-lane upstream fixes — calibration contract live, hook-rule lane seeded, replay steps for yoo-dev"`

---

## Self-Review

1. **Spec coverage:** "failure-capable checks" → Tasks 1-3 (contract+screen+runner) + Task 5 (live backfill, one vacuous check retired, one calibrated check deployed). "Deploy hook rules" → Tasks 4+6 (durable path through the playbook, exporter-compatible) + Task 7 (wire proof). Data-decidability close → Task 8 revisit condition. Gap: none found.
2. **Placeholder scan:** two deliberate verify-while-implementing caveats (Task 4 `readPlaybook` null contract; Task 6 `evalHookRules` exact signature) — each names the exact grep and the decision rule, not "TBD". Acceptable.
3. **Type consistency:** `failProbe?: {cmd,timeoutMs}` uniform across Tasks 1/2/3/5; `applyAuthoredOps` signature identical in Tasks 4/5/6; `calibrateCheck` reasons enum matches between Tasks 3 and 5.

Known risks, stated: `applyPlaybookOps` stamps `addedBy:"candidate"` on authored adds (cosmetic provenance smear — acceptable, noted in authored-ops doc comment); seeded bullets add ~60 tokens of context to every session on this repo (4 short rules, judged worth the lane); the Task 5 check's glob list is repo-shaped by design (it guards THIS repo's store — structural per incident class, not a task answer key; generality rule satisfied).
