# a3 Rule Routing — Plan A: Contract + Screens + TB2 Adapter

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Checked rules (bullet + mechanical check) flow propose → review screens → TB2 trial/ab arms enforced by an injected in-container Stop-hook gate, per spec `docs/superpowers/specs/2026-08-13-a3-rule-routing-design.md` (FLAWLESS, 4 review rounds).

**Architecture:** Optional `check` field on `PlaybookBullet` travels through the store; deterministic two-tier screens at the review gate (Tier B bench / Tier L live via `minimal/guard.ts`); TB2 claude-code-driver arms get a generated, round-capped Stop-hook gate injected per attempt; `checksHash` joins the env identity block. Live adapter (kkamak gate) is **Plan B** — NOT here.

**Tech Stack:** Bun/TypeScript, bun:test, podman (existing bench harness). No new dependencies.

## Global Constraints (from spec — verbatim)

- Checked-rule invocations run on `--driver claude-code` ONLY; refusal is loud, pre-container (after `readPlaybook`/harness assembly, BEFORE `inContainerAgentVersion()`).
- Proposer-emitted checks are ALWAYS `state: "shadow"`; review gate rejects `state: "blocking"` proposals. `liveEligible` is screen-stamped, never proposer-set.
- `canonicalChecksJson` serializes ONLY `(bulletId, cmd, timeoutMs)`, array sorted by bulletId, fixed key order. `state`/`liveEligible` EXCLUDED deliberately.
- `EMPTY_CHECKS_HASH = sha256(canonicalChecksJson([]))`; absent field coalesces to it in budget-identity comparison.
- F2: no command text on sensor lines or record annotations — outcomes only. rejected.json gets check VERDICT SUMMARY only (e.g. `check: screen-denied (network)`), never command text (open user ruling; this is the fallback in force).
- Per-arm own-playbook injection; never baked into the shared bench image. Round cap mirrors cc-gate-plugin `rounds: 2` EXACTLY (verified against `cc-gate-plugin/src/core/stop.ts:98-166`): failure 1 → BLOCK (rounds=1), failure 2 → BLOCK (rounds=2), failure 3 → exhausted-ALLOW (rounds=3 > cap 2) + recorded. Two blocks total, exhausted on the third failing Stop.
- Every checked-rule ab verdict carries `checkBundleCaveat` + per-rule block/exhaust counts.
- First checked-rule ab stamps a boundary ts in `docs/2026-08-01-gauntlet-adoption-ledger.md` (run-time duty, noted in Task 8).
- Repo process rules: TDD; explicit user go before merge to main and any spend; 7b gate + docs/reviews artifact (bare fields); suites serial; add NAMED files only.

## File Structure

- `minimal/guard.ts` — NEW kernel copy of `unsafeReason()` (from `cc-gate-plugin/src/gauge/guard.ts`). Plan B later re-points cc-gate-plugin to a vendor copy; until then a drift-parity test guards the two copies.
- `opencode-plugin/src/harness-store.ts` — `BulletCheck` type, `PlaybookBullet.check?`, `PlaybookOp` add/update `check?`, `applyPlaybookOps` threading, `canonicalChecksJson`, `checksHashOf`, `EMPTY_CHECKS_HASH`, `budgetIdentityMatches` coalescing.
- `opencode-plugin/src/check-screen.ts` — NEW: Tier B/L deterministic screens (`screenCheck`).
- `opencode-plugin/src/review-gate.ts` — structured bullets (`{text, check?}`), screen wiring, verdict-summary ledger text.
- `opencode-plugin/src/bench/rule-gate.ts` — NEW: generated in-container gate (`buildRuleGateScript`, `RULE_GATE_*` constants).
- `opencode-plugin/src/bench/record.ts` — `EnvBlock.checksHash?`.
- `opencode-plugin/src/bench/cmd-run.ts`, `cmd-ab.ts` — driver refusal + injection + annotation + verdict fields.
- Tests: `opencode-plugin/test/check-screen.test.ts`, `rule-gate.test.ts`, `guard-parity.test.ts`; extensions to `harness-store.test.ts` (or nearest existing store test file), `bench-record.test.ts`, `bench-cli-ab.test.ts`.

---

### Task 1: `minimal/guard.ts` kernel copy + parity guard

**Files:**
- Create: `minimal/guard.ts`
- Test: `opencode-plugin/test/guard-parity.test.ts`

**Interfaces:**
- Produces: `unsafeReason(check: string): string | undefined` — exact copy of `cc-gate-plugin/src/gauge/guard.ts`'s export (same name, same behavior; `undefined` = safe).

- [ ] **Step 1: Write the failing parity test**

```ts
// opencode-plugin/test/guard-parity.test.ts
import { test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..", "..")

/** Compare from the RULES policy array to EOF — the policy content IS the
 * thing that must not drift (review round-1 F4: anchoring at the function
 * would exclude RULES, making the guard a no-op for the likely drift). */
function implBlock(src: string): string {
  const i = src.indexOf("const RULES")
  if (i < 0) throw new Error("RULES not found")
  return src.slice(i)
}

test("minimal/guard.ts unsafeReason is byte-identical to cc-gate-plugin's (interim drift guard until Plan B vendors it)", () => {
  const kernel = readFileSync(join(root, "minimal", "guard.ts"), "utf-8")
  const ccg = readFileSync(join(root, "cc-gate-plugin", "src", "gauge", "guard.ts"), "utf-8")
  expect(implBlock(kernel)).toBe(implBlock(ccg))
})

test("unsafeReason from minimal/ flags a destructive workspace-scoped command and passes a read-only one", async () => {
  const { unsafeReason } = await import("../../minimal/guard.ts")
  expect(unsafeReason("rm notes.txt")).toBeDefined()
  expect(unsafeReason("grep -q done README.md")).toBeUndefined()
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd opencode-plugin && bun test test/guard-parity.test.ts`
Expected: FAIL — `minimal/guard.ts` does not exist.

- [ ] **Step 3: Create `minimal/guard.ts`**

Copy `cc-gate-plugin/src/gauge/guard.ts` verbatim (header comment included), prepending one line to the header: `// Kernel home of unsafeReason (a3 rule routing Plan A); cc-gate-plugin re-points to a vendor byte-copy in Plan B.` Do NOT modify cc-gate-plugin in this plan (its `vendor/` + `src/core` are MECHANISM_PATHS — calibration territory, Plan B's coordinated duty).

- [ ] **Step 4: Run tests to verify pass**

Run: `cd opencode-plugin && bun test test/guard-parity.test.ts`
Expected: PASS (2 tests). The prepended header line must sit ABOVE `const RULES` so the compare (RULES → EOF) stays byte-identical.

- [ ] **Step 5: Commit**

```bash
git add minimal/guard.ts opencode-plugin/test/guard-parity.test.ts
git commit -m "feat(kernel): minimal/guard.ts — unsafeReason kernel copy + drift-parity test (a3 routing T1)"
```

---

### Task 2: `BulletCheck` schema + `canonicalChecksJson` + `EMPTY_CHECKS_HASH`

**Files:**
- Modify: `opencode-plugin/src/harness-store.ts` (PlaybookBullet interface ~line 970; PlaybookOp type; `applyPlaybookOps` ~line 1043; `budgetIdentityMatches` ~line 444; `BudgetStamp` ~line 428; `readActiveBudget` ~line 408)
- Test: `opencode-plugin/test/harness-store-checks.test.ts` (new file)

**Interfaces:**
- Produces:
  - `interface BulletCheck { cmd: string; timeoutMs: number; state: "shadow" | "blocking"; liveEligible?: boolean }`
  - `PlaybookBullet.check?: BulletCheck`
  - `PlaybookOp` add/update variants gain `check?: { cmd: string; timeoutMs: number }` (state/liveEligible NOT accepted from ops — stamped downstream)
  - `canonicalChecksJson(checks: Array<{ bulletId: string; cmd: string; timeoutMs: number }>): string` — sort by `bulletId`, serialize each as `{"bulletId":…,"cmd":…,"timeoutMs":…}` in exactly that key order, join as a JSON array string
  - `checksHashOf(playbook: Playbook | null): string` — collects `{bulletId: b.id, cmd, timeoutMs}` for every ACTIVE-status bullet with a `check`, returns `sha256(canonicalChecksJson(list))` full hex
  - `EMPTY_CHECKS_HASH: string` — precomputed constant `checksHashOf(null)`

- [ ] **Step 1: Write failing tests**

```ts
// opencode-plugin/test/harness-store-checks.test.ts
import { test, expect } from "bun:test"
import {
  applyPlaybookOps, canonicalChecksJson, checksHashOf, EMPTY_CHECKS_HASH,
  type Playbook, type PlaybookOp,
} from "../src/harness-store.ts"

const base: Playbook = { schemaVersion: 1, nextId: 1, bullets: [] } as Playbook
// (real fixture shape — see gate-trial-store.test.ts:265; a bare {bullets: []}
// cast would yield "bundefined" ids from applyPlaybookOps' nextId++)

test("legacy playbook JSON without check fields parses and round-trips (back-compat)", () => {
  const pb = applyPlaybookOps(base, [{ op: "add", text: "plain rule" }])
  expect(pb.bullets[0]!.check).toBeUndefined()
})

test("add op with check threads cmd/timeoutMs and stamps state shadow, liveEligible absent", () => {
  const pb = applyPlaybookOps(base, [
    { op: "add", text: "verify before done", check: { cmd: "test -s DONE.txt", timeoutMs: 5000 } },
  ])
  const c = pb.bullets[0]!.check!
  expect(c.cmd).toBe("test -s DONE.txt")
  expect(c.state).toBe("shadow")
  expect(c.liveEligible).toBeUndefined()
})

test("canonicalChecksJson sorts by bulletId with fixed key order and excludes state/liveEligible", () => {
  const s = canonicalChecksJson([
    { bulletId: "b2", cmd: "y", timeoutMs: 2 },
    { bulletId: "b1", cmd: "x", timeoutMs: 1 },
  ])
  expect(s).toBe('[{"bulletId":"b1","cmd":"x","timeoutMs":1},{"bulletId":"b2","cmd":"y","timeoutMs":2}]')
})

test("EMPTY_CHECKS_HASH equals checksHashOf(null) and of a checkless playbook", () => {
  expect(checksHashOf(null)).toBe(EMPTY_CHECKS_HASH)
  const pb = applyPlaybookOps(base, [{ op: "add", text: "plain" }])
  expect(checksHashOf(pb)).toBe(EMPTY_CHECKS_HASH)
})

test("two playbooks identical in prose but different in check cmd hash differently", () => {
  const a = applyPlaybookOps(base, [{ op: "add", text: "r", check: { cmd: "c1", timeoutMs: 1000 } }])
  const b = applyPlaybookOps(base, [{ op: "add", text: "r", check: { cmd: "c2", timeoutMs: 1000 } }])
  // ids differ per-op; normalize: compare via same-id lists
  const ha = canonicalChecksJson([{ bulletId: "x", cmd: "c1", timeoutMs: 1000 }])
  const hb = canonicalChecksJson([{ bulletId: "x", cmd: "c2", timeoutMs: 1000 }])
  expect(ha).not.toBe(hb)
  expect(a.bullets[0]!.check!.cmd).not.toBe(b.bullets[0]!.check!.cmd)
})
```

(Adjust `base` construction to the real `Playbook` shape — read the interface at implementation time; if `Playbook` requires more fields, build via the existing test helpers in the store test file.)

- [ ] **Step 2: Run to verify fail** — `cd opencode-plugin && bun test test/harness-store-checks.test.ts` → FAIL (exports missing).

- [ ] **Step 3: Implement in `harness-store.ts`**

```ts
export interface BulletCheck {
  cmd: string
  timeoutMs: number
  /** live-consumer state; TB2 trial arms always enforce regardless. */
  state: "shadow" | "blocking"
  /** Screen-stamped (Tier L, check-screen.ts). Never proposer-set. */
  liveEligible?: boolean
}
// PlaybookBullet gains: check?: BulletCheck
// PlaybookOp add/update gain: check?: { cmd: string; timeoutMs: number }

// In applyPlaybookOps, where an add/update op materializes a bullet:
//   ...(op.check ? { check: { cmd: op.check.cmd, timeoutMs: op.check.timeoutMs, state: "shadow" as const } } : {})

export function canonicalChecksJson(
  checks: Array<{ bulletId: string; cmd: string; timeoutMs: number }>,
): string {
  const sorted = [...checks].sort((a, b) => (a.bulletId < b.bulletId ? -1 : a.bulletId > b.bulletId ? 1 : 0))
  return "[" + sorted.map((c) => `{"bulletId":${JSON.stringify(c.bulletId)},"cmd":${JSON.stringify(c.cmd)},"timeoutMs":${c.timeoutMs}}`).join(",") + "]"
}

export function checksHashOf(playbook: Playbook | null): string {
  const list = (playbook?.bullets ?? [])
    .filter((b) => b.status === "active" && b.check)
    .map((b) => ({ bulletId: b.id, cmd: b.check!.cmd, timeoutMs: b.check!.timeoutMs }))
  return createHash("sha256").update(canonicalChecksJson(list), "utf-8").digest("hex")
}

export const EMPTY_CHECKS_HASH = checksHashOf(null)
```

(`createHash` import exists already or add `node:crypto`.)

- [ ] **Step 4: Extend `budgetIdentityMatches` AND its production data source** (review round-1 F5 — without this the /mh-activate guard is a silent no-op): (a) `BudgetStamp` (harness-store.ts ~line 428) gains `checksHash?: string`; (b) `readActiveBudget` (~line 408) computes it via `checksHashOf(readPlaybook(storeRoot))`; (c) `budgetIdentityMatches` compares with coalescing `(x.checksHash ?? EMPTY_CHECKS_HASH) === (y.checksHash ?? EMPTY_CHECKS_HASH)` following the file's `?? 0`/`?? false` convention. Tests: legacy record (absent) vs modern zero-check record MATCH; differing hashes MISMATCH; `readActiveBudget` on a store whose active playbook has a checked bullet returns that playbook's real hash (fixture store, same helpers as existing readActiveBudget tests).

- [ ] **Step 5: Run full store tests** — `cd opencode-plugin && bun test test/harness-store-checks.test.ts` and the nearest existing store test file → PASS.

- [ ] **Step 6: Commit**

```bash
git add opencode-plugin/src/harness-store.ts opencode-plugin/test/harness-store-checks.test.ts
git commit -m "feat(store): BulletCheck schema + canonicalChecksJson/EMPTY_CHECKS_HASH + identity coalescing (a3 routing T2)"
```

---

### Task 3: check screens (`check-screen.ts`) — Tier B / Tier L

**Files:**
- Create: `opencode-plugin/src/check-screen.ts`
- Test: `opencode-plugin/test/check-screen.test.ts`

**Interfaces:**
- Consumes: `unsafeReason` from `minimal/guard.ts` (T1).
- Produces: `screenCheck(check: { cmd: string; timeoutMs: number }): { tier: "rejected" | "bench" | "live"; reason?: string }`
  - `"rejected"` — fails Tier B; `reason` = short slug, NO command text (ledger-safe).
  - `"bench"` — Tier B pass, Tier L fail (`liveEligible: false` downstream).
  - `"live"` — both pass.

- [ ] **Step 1: Write failing tests**

```ts
// opencode-plugin/test/check-screen.test.ts
import { test, expect } from "bun:test"
import { screenCheck } from "../src/check-screen.ts"

const T = (cmd: string) => screenCheck({ cmd, timeoutMs: 5000 })

test("empty / unparseable / oversize timeout rejected", () => {
  expect(screenCheck({ cmd: "", timeoutMs: 5000 }).tier).toBe("rejected")
  expect(screenCheck({ cmd: "ls", timeoutMs: 0 }).tier).toBe("rejected")
  expect(screenCheck({ cmd: "ls", timeoutMs: 600001 }).tier).toBe("rejected")
})

test("store-path / network / package-install / rm -rf rejected at Tier B with slug reasons only", () => {
  for (const [cmd, slug] of [
    ["cat .kkamak/global/active/playbook.json", "store-path"],
    ["grep x .km/gate-outcomes.ndjson", "store-path"],
    ["ls term-bench2/store/global", "store-path"],
    ["curl http://example.com", "network"],
    ["apt-get install jq", "package-install"],
    ["rm -rf /app", "destructive"],
  ] as const) {
    const r = T(cmd)
    expect(r.tier).toBe("rejected")
    expect(r.reason).toBe(slug)
    expect(r.reason!.includes(cmd)).toBe(false)
  }
})

test("workspace-scoped write passes Tier B but not Tier L", () => {
  const r = T("echo probe > probe.txt && test -s probe.txt")
  expect(r.tier).toBe("bench")
})

test("read-only verification passes Tier L", () => {
  expect(T("test -s DONE-CHECK.txt").tier).toBe("live")
  expect(T("grep -q 'result' DONE-CHECK.txt").tier).toBe("live")
})
```

- [ ] **Step 2: Run to verify fail** — module missing.

- [ ] **Step 3: Implement**

```ts
// opencode-plugin/src/check-screen.ts
import { unsafeReason } from "../../minimal/guard.ts"

const MAX_TIMEOUT_MS = 600_000
const STORE_PATH_RE = /(^|[\s'"/])(\.kkamak|\.km|term-bench2\/store)([\s'"/]|$)/
const NETWORK_RE = /\b(curl|wget|nc|ssh|scp|git\s+(clone|fetch|pull|push))\b/
const PKG_RE = /\b(apt(-get)?|pip3?|npm|bun\s+add|brew)\s+(install|add)\b/
const DESTRUCTIVE_OUT_RE = /\brm\s+(-[a-z]*r[a-z]*f?|-[a-z]*f[a-z]*r)\b|\brm\s+.*\.\.\//

export function screenCheck(check: { cmd: string; timeoutMs: number }): {
  tier: "rejected" | "bench" | "live"
  reason?: string
} {
  const cmd = check.cmd.trim()
  if (!cmd) return { tier: "rejected", reason: "empty" }
  if (!(check.timeoutMs > 0 && check.timeoutMs <= MAX_TIMEOUT_MS)) return { tier: "rejected", reason: "timeout-bounds" }
  if (STORE_PATH_RE.test(cmd)) return { tier: "rejected", reason: "store-path" }
  if (NETWORK_RE.test(cmd)) return { tier: "rejected", reason: "network" }
  if (PKG_RE.test(cmd)) return { tier: "rejected", reason: "package-install" }
  if (DESTRUCTIVE_OUT_RE.test(cmd)) return { tier: "rejected", reason: "destructive" }
  return unsafeReason(cmd) === undefined ? { tier: "live" } : { tier: "bench" }
}
```

(Regexes above are the starting set; tune against the test matrix at implementation time — the CONTRACT is the three-tier result + slug-only reasons, not these exact regexes.)

- [ ] **Step 4: Run tests → PASS.**

- [ ] **Step 5: Commit**

```bash
git add opencode-plugin/src/check-screen.ts opencode-plugin/test/check-screen.test.ts
git commit -m "feat(review): two-tier deterministic check screens, slug-only reasons (a3 routing T3)"
```

---

### Task 4: review-gate structured bullets + screen wiring

**Files:**
- Modify: `opencode-plugin/src/review-gate.ts` (`reviewAddedBullets` signature ~line 62; ledger text builder)
- Modify: `opencode-plugin/src/propose.ts` — BOTH artifact-apply functions: `applyProposeArtifact` (:285; `reviewAddedBullets` call :435; post-apply patch site ~:476) AND `applyCurateArtifact` (:1313; its direct `applyPlaybookOps` call :1337 — currently zero screening, review round-3). Thread `check` from artifact JSON through ops in both; call the shared `screenOpsChecks` helper in both before `applyPlaybookOps`.
- Test: extend `opencode-plugin/test/` review-gate test file (locate via `grep -rln reviewAddedBullets opencode-plugin/test`).

**Interfaces:**
- Consumes: `screenCheck` (T3).
- Produces: `reviewAddedBullets` accepts `bullets: Array<{ text: string; check?: { cmd: string; timeoutMs: number } }>` (back-compat overload NOT kept — update all callers in the same task); each `BulletReviewOutcome` gains `check?: { cmd: string; timeoutMs: number; liveEligible: boolean }` when staged, or rejection with `reason: "check-screen:<slug>"`.
- Behavior: proposal carrying `state` at all → rejected `"check-screen:state-not-proposer-set"`. Screen `"rejected"` → whole bullet rejected, ledger entry text = bullet text + ` [check: screen-denied (<slug>)]` — NEVER the command text. Screen `"bench"`/`"live"` → bullet proceeds to the existing layer-1 + rubric flow on its TEXT; if staged, outcome carries `liveEligible` (`"live"` → true, `"bench"` → false).
- SCREEN COVERAGE INVARIANT: EVERY op carrying a `check` — add OR update — passes `screenCheck` before apply; a `"rejected"` tier drops/rejects that op the same way regardless of op kind. TWO SEPARATE CALL SITES, one shared helper (review round-3: `applyProposeArtifact` at propose.ts:285 and `applyCurateArtifact` at propose.ts:1313 are independent functions — curation calls `applyPlaybookOps` directly at :1337 with no review; a screen must be added THERE explicitly or curator checks ship unscreened): extract `screenOpsChecks(ops): { ops, rejections }` (drops ops whose check screens `"rejected"`, stamps `liveEligible` on survivors) and call it in BOTH functions before their `applyPlaybookOps`. Test-pinned with an update-op case through the CURATE path specifically.

- [ ] **Step 1: Write failing tests** — five cases: (a) checked bullet whose cmd hits `store-path` is rejected whole with ledger text containing `screen-denied (store-path)` and NOT containing the cmd string; (b) checked bullet passing Tier L stages with `liveEligible: true`; (c) proposal JSON smuggling `state: "blocking"` is rejected; (d) **PERSISTENCE (review round-1 F2): after the full propose-apply path, the PLAYBOOK WRITTEN TO THE STORE carries `check.liveEligible` matching the screen tier** — assert on `readPlaybook()` output, not the outcome object (`applyPlaybookOps` deliberately never sets it; a post-apply patch must); (e) **CURATE PATH (review round-3): an update op carrying a screen-rejected check through `applyCurateArtifact` is dropped/rejected — the screen fires on the curator lane too.**

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement** — signature change + screen call before layer-1; map `tier` to outcome as specified; update the single production caller (`propose.ts:435`); **post-`applyPlaybookOps` patch in propose.ts (~line 476): for each staged outcome with a check, set `newPlaybook.bullets[i].check.liveEligible` from the outcome before the playbook is written** (this is the only site that persists the stamp — review round-1 F2).

- [ ] **Step 4: Update the proposer prompt templates** (review round-1 F3 — spec §2's "Prompt addition"). PROPOSER heredoc (~line 1077) gains:

```
Optionally, an "add" op may carry "check": {"cmd": "<shell command that mechanically verifies the rule's behavior>", "timeoutMs": <number>}. Only include a check when the rule's behavior is mechanically verifiable by a command; unverifiable rules stay prose-only — never invent a check. The command must be workspace-scoped; never touch stores, network, or packages.
```

CURATOR heredoc (~line 1427) — curation forbids add ops (propose.ts:1409), so it gets the UPDATE-oriented variant instead (review round-2 residual):

```
Optionally, an "update" op may carry or revise "check": {"cmd": "...", "timeoutMs": <number>} on a bullet that already warrants one, under the same constraints: mechanically verifiable behavior only, workspace-scoped, never stores/network/packages; drop a check (omit the field) rather than keep one that no longer matches the bullet.
```

- [ ] **Step 5: Run the review-gate test file + full opencode suite → PASS.**

- [ ] **Step 6: Commit**

```bash
git add opencode-plugin/src/review-gate.ts opencode-plugin/src/propose.ts <test file>
git commit -m "feat(review): structured checked bullets — screens, liveEligible persistence, proposer prompt (a3 routing T4)"
```

---

### Task 5: `checksHash` in the env identity block

**Files:**
- Modify: `opencode-plugin/src/bench/record.ts` (`EnvBlock` ~line 190; `envBlock()` ~line 247)
- Modify: `envBlock` call sites in `cmd-run.ts` / `cmd-ab.ts` to pass the arm's enforced-set hash (from `checksHashOf` on the arm's playbook; `EMPTY_CHECKS_HASH` when checkless).
- Test: extend `opencode-plugin/test/bench-record.test.ts`.

**Interfaces:**
- Produces: `EnvBlock.checksHash: string` (ALWAYS present on new records, following the `resourceEnforcement` always-present precedent in the same interface); `envBlock(...)` gains a `checksHash: string` parameter.

- [ ] **Step 1: Failing test** — `envBlock(..., EMPTY_CHECKS_HASH)` output carries `checksHash === EMPTY_CHECKS_HASH`; a distinct hash round-trips.
- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement** — add field + parameter; update call sites (each arm computes `checksHashOf(itsPlaybook)`).
- [ ] **Step 4: Suite green** (`bench-record.test.ts` + files touching envBlock callers).
- [ ] **Step 5: Commit** — `feat(bench): checksHash joins the env identity block (a3 routing T5)`.

---

### Task 6: `rule-gate.ts` — generated in-container Stop-hook gate

**Files:**
- Create: `opencode-plugin/src/bench/rule-gate.ts`
- Test: `opencode-plugin/test/rule-gate.test.ts`

**Interfaces:**
- Produces:
  - `RULE_GATE_DIR = "/app/.rule-gate"` · `RULE_GATE_ROUNDS_CAP = 2`
  - `buildRuleGateScript(checks: Array<{ bulletId: string; cmd: string; timeoutMs: number }>): string` — bash script text
  - `buildRuleGateSettings(): string` — settings.json text whose single Stop hook runs `bash /app/.rule-gate/check.sh`
  - `readRuleGateStateArgs(): string[]` — the `podman exec cat` argv for post-attempt state readback (`/app/.rule-gate/state.json`)
- Script contract (the TESTED behavior, executed against a temp dir in tests with `RULE_GATE_DIR` overridable via env `RULE_GATE_DIR` for testability):
  - Runs each check with `timeout <timeoutMs/1000>s bash -c <cmd>`. On first failure, compare-THEN-increment, mirroring `stop.ts`'s `state.round < cfg.rounds` order (review round-2 residual — increment-then-compare would exhaust after ONE block):
    - if pre-increment `rounds < RULE_GATE_ROUNDS_CAP` → increment `rounds` in `state.json` `{rounds, exhausted, perRule: {<bulletId>: {blocked, lastFail}}}`, print the failing check's captured stderr+stdout (tail-capped 2048 chars) to fd 2, `exit 2` (block); yields blocks at rounds 0→1 and 1→2.
    - else (pre-increment `rounds >= cap`, i.e. the THIRD failure) → increment, set `exhausted: true`, `exit 0` (allow) — loud line to stderr `rule-gate: exhausted after 2 blocks` (informational; exit 0 does not block).
  - All pass → reset nothing, `exit 0`.
  - F2: state.json carries bulletIds + counts only, no command text.

- [ ] **Step 1: Write failing tests** — generate script for one failing + one passing check into a temp dir; run via `Bun.spawnSync(["bash", script])` with `RULE_GATE_DIR=<tmp>`. Pin EXACTLY the cc-gate-plugin `rounds: 2` mirror (review round-1 F1, verified against `cc-gate-plugin/src/core/stop.ts:98-166`: block while `round < cap`, so cap+1 failures total): run1 → exit 2, evidence on stderr, state rounds=1; run2 → exit 2, rounds=2; run3 → exit 0, `exhausted: true`, rounds=3, stderr carries `rule-gate: exhausted after 2 blocks`. All-pass script exits 0 with no state mutation beyond file creation.
- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement** generator (heredoc-safe: checks embedded via `printf %q`-quoted strings or a JSON sidecar the script reads with `python3 -c`/`jq`-free bash parsing — implementer picks the robust one; tests are the contract).
- [ ] **Step 4: Tests PASS.**
- [ ] **Step 5: Commit** — `feat(bench): generated round-capped in-container rule gate (a3 routing T6)`.

---

### Task 7: cmd wiring — driver refusal, injection, annotation

**Files:**
- Modify: `opencode-plugin/src/bench/cmd-run.ts` (~assembly at line 589, pre-`inContainerAgentVersion` at 602), `cmd-ab.ts` (~294-304), the per-attempt container create/exec path. Injection precedent (review round-1 F8): the generated script/settings are STRINGS, so mirror `agent-run.ts:174-178`'s pattern — `mkdtempSync` scratch dir + `writeFileSync` the generated text + `buildCpToArgv` into the container (`/app/.claude/settings.json`, `/app/.rule-gate/check.sh`); `cmd-p2.ts:357-362`'s static-asset copy shows only the `mkdir /app/.claude` + cp shape, not the generated-content step.
- Test: extend `opencode-plugin/test/bench-cli-ab.test.ts` (refusal) + a focused injection unit test with the existing exec-seam fakes.

**Interfaces:**
- Consumes: `checksHashOf`, `buildRuleGateScript`, `buildRuleGateSettings`, `readRuleGateStateArgs` (T2/T6).
- Produces: per-attempt result annotation field `ruleChecks?: { rounds: number; exhausted: boolean; perRule: Record<string, { blocked: number }> }` (from post-attempt state readback; absent when arm checkless). Refusal: `die("run/ab: candidate carries checked bullets (<bulletId>…) — requires --driver claude-code; the opencode driver has no hook chokepoint (spec §3)")` placed AFTER playbook read, BEFORE `inContainerAgentVersion()`, in both cmd-run and cmd-ab.
- Behavior: EACH arm's enforced set = that arm's OWN playbook's active checked bullets (spec §3 symmetry); injection only when the set is non-empty.

- [ ] **Step 1: Failing refusal test** — ab invocation, candidate playbook with a checked bullet, driver opencode (default) → dies naming the bullet id and `--driver claude-code`; same playbook with `--driver claude-code` proceeds past the refusal point (fake exec seam). Also: prose-only candidate on opencode driver unaffected.
- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement refusal** in both cmds at the specified point.
- [ ] **Step 4: Failing injection test** — with exec-seam fakes, a claude-code-driver attempt whose arm has one checked bullet issues `podman cp` for settings.json + check.sh and a post-attempt state read; annotation lands `ruleChecks` with the faked state; checkless arm issues neither.
- [ ] **Step 5: Implement injection + readback + annotation.**
- [ ] **Step 6: Full opencode suite green.**
- [ ] **Step 7: Commit** — `feat(bench): checked-rule arm wiring — driver refusal, per-arm injection, ruleChecks annotation (a3 routing T7)`.

---

### Task 8: ab verdict — `checksHash` + `checkBundleCaveat`

**Files:**
- Modify: `cmd-ab.ts` verdict assembly (locate `ab-verdict` writer) + wherever arm env blocks land in the verdict.
- Modify: `opencode-plugin/src/harness-store.ts` — `AbVerdict` interface (~line 313) gains `checksHash` per-arm slots + `checkBundleCaveat?: string` (closed interface, must be declared before cmd-ab compiles — review round-1 F7).
- Test: extend `opencode-plugin/test/bench-cli-ab.test.ts`.

**Interfaces:**
- Produces: verdict gains per-arm `checksHash`; when EITHER arm's hash ≠ `EMPTY_CHECKS_HASH`, verdict carries `checkBundleCaveat: "checked-rule bundle: regressions are not attributable between rule text and check behavior; see per-rule ruleChecks block/exhaust counts"` + aggregated per-rule `{blocked, exhausted}` totals from the arm annotations.

- [ ] **Step 1: Failing test** — fake a completed checked ab; verdict JSON contains both fields; checkless ab verdict contains per-arm hashes == EMPTY_CHECKS_HASH and NO caveat.
- [ ] **Step 2: Verify fail. Step 3: Implement. Step 4: Suite green.**
- [ ] **Step 5: Commit** — `feat(bench): checked-rule ab verdict fields — per-arm checksHash + checkBundleCaveat (a3 routing T8)`.
- [ ] **Step 6 (documentation, same commit ok):** note in the plan/spec that the FIRST real checked-rule ab run stamps a boundary ts in `docs/2026-08-01-gauntlet-adoption-ledger.md` — a RUN-TIME duty, not code.

---

### Task 9: probe-the-consequence (GATED — real spend, own sized go)

**NOT executed by subagents. Runs only on an explicit user sized go (≤4 haiku calls).**

- [ ] Build a throwaway claude-code-driver container per the P2 PROBE C recipe (`docs/loop-probes/p2/PROBE.md`); inject a rule gate with one deliberately-failing check.
- [ ] One `claude -p` attempt: expect num_turns > 1-turn control, evidence of block/fix cycle, and `state.json` showing `rounds ≥ 1`; forcing failure through THREE Stops must show blocks on 1 and 2, then `exhausted: true` + allow on the third (the T6 contract, live).
- [ ] Record outcome in the plan file + READINESS-style note. Zero store writes.

---

## Self-Review (done at write time)

- Spec coverage: §1 → T2 (+T5 identity); §2 → T3/T4; §3 → T6/T7/T8 (+T9 probe; boundary-ts duty noted T8); §5.1 → T9; §5 TDD → per-task; §4/§5.2 (live adapter, contract rev, export producer) → **Plan B, deliberately absent**; §6/§7 honored (no opencode-driver carrier, back-compat tests T2/T7).
- Placeholders: none — where exact regex/impl detail is implementer-tunable, the CONTRACT is pinned by test code instead.
- Type consistency: `BulletCheck`/`screenCheck` tiers/`checksHashOf`/`EMPTY_CHECKS_HASH`/`buildRuleGateScript` names used consistently across T2-T8.
- Known open ruling: rejected.json F2 (spec §1) — T4 implements the fallback (verdict-summary-only). If the user rules FOR command text later, that is a one-line ledger change + test.

## Review log

- round 1 (2026-08-13, fresh code-architect, FIX-FIRST → applied): round-cap semantics corrected to the real cc-gate mirror — block/block/exhaust-on-3rd (T6, T9, Global Constraints) (F1); liveEligible PERSISTENCE step + persisted-playbook test added to T4 (post-applyPlaybookOps patch in propose.ts ~476) (F2); proposer prompt-template update added to T4 (F3); T1 parity anchor moved to `const RULES` (F4); readActiveBudget/BudgetStamp wired into T2 step 4 (F5); T2 fixture uses real `{schemaVersion, nextId, bullets}` shape (F6); AbVerdict/BudgetStamp named in T8/T2 file lists (F7); T7 injection precedent corrected to agent-run.ts mkdtemp+write+cp (F8).
- round 2 (same reviewer, scoped re-verify, FIX-FIRST → applied): T6 script-contract bullets rewritten compare-THEN-increment mirroring stop.ts order (increment-then-compare would exhaust after one block — the contract now agrees with its own Step-1 test pin); curator heredoc gets the update-oriented check text (curation forbids adds, propose.ts:1409); NEW screen-coverage invariant added to T4 — update-op checks pass the same screenCheck at apply (curator lane would otherwise bypass screening).
- round 3 (same reviewer, FIX-FIRST → applied): the invariant's "one shared code path" claim was false — `applyProposeArtifact` (:285) and `applyCurateArtifact` (:1313, direct `applyPlaybookOps` at :1337, no screening) are separate functions. T4 now names BOTH in Files, specifies the shared `screenOpsChecks(ops)` helper called at both sites, and pins a curate-path update-op test.
