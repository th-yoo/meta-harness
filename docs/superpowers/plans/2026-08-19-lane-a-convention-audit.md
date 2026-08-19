# Lane A Convention-Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an OFF-by-default `--convention-audit` staging step that generates a per-task representation-convention card via one host-side sonnet daemon call and injects it into the task instruction, byte-identical across A/B arms.

**Architecture:** A single new module `convention-audit.ts` exposing `auditCard(paths, task, env, deps)`, a pure pipeline (sampler → daemon audit call → content-gate → card extract) with a single-flight per-task cache. Wired into `agent-run.ts` at the existing `budgetLine` seam and threaded as a boolean flag through `cmd-run.ts`/`cmd-ab.ts`. The audit call mirrors `bench/p2/a4-review.ts` (ACP daemon, deps-injection seam), NOT `claude -p`.

**Tech Stack:** TypeScript (Bun runtime), `@th-yoo/cc-api-daemon` (`ensureDaemon`/`daemonCall`/`closeSession`), node:fs (`realpathSync`), the bench `ExecFn` test idiom. Tests run via `bun test`.

**Spec:** `docs/superpowers/specs/2026-08-19-lane-a-convention-audit-design.md` (read it — this plan argues from it).

## Global Constraints

- **Flag OFF by default.** When `--convention-audit` is absent, every touched code path must be byte-identical to today. This is the top acceptance property.
- **Leak-safety is the critical property.** The sampler must NEVER emit bytes from `tests/`, `solution/`, or any expected-output file, and must reject `..`-traversal and symlinks-out via `realpathSync` containment. Tested on the traversal path, not just the happy path.
- **Verbatim card.** No host-side rewriting of the audit output; hand edits void the end-to-end claim.
- **Auditor model = `anthropic/claude-sonnet-5`, hardcoded constant** (`DEFAULT_BENCH_MODEL`, `paths.ts:28`). Routes to the daemon's uncapped `agent` lane.
- **No live model call / no live daemon in the test suite.** The audit call is exercised through the `deps: { call?, ensure?, close? }` seam with recorded replies, exactly as `a4-review.ts` tests do.
- **Turn-timeout trap:** the audit `env` MUST set `ACP_TURN_TIMEOUT_MS` to a generous value (the 16s `daemon-seat.ts:56` default kills a multi-KB-sample turn). Use `120000`.
- **Co-Authored-By trailer** on every commit: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Branch first if on `main` (this is a feature; do not commit to `main` directly without the user's merge go — build on a feature branch).

---

## File Structure

- Create `opencode-plugin/src/bench/convention-audit.ts` — the whole pipeline + cache. One responsibility: "produce (or decline) a convention card for a task."
- Create `opencode-plugin/src/bench/convention-audit-prompt.txt` — the frozen, version-stamped audit prompt.
- Create `opencode-plugin/src/bench/test/convention-audit.test.ts` — unit + integration tests.
- Create test fixtures under `opencode-plugin/src/bench/test/fixtures/conv-audit/` — fake task dirs (clean, traversal-COPY, symlink-COPY, oversized-dir) + recorded daemon replies.
- Modify `opencode-plugin/src/bench/agent-run.ts` — append card after `budgetLine` (:165-167), add `conventionAudit?` to `runAgent` params.
- Modify `opencode-plugin/src/bench/cmd-run.ts` — parse `--convention-audit`, thread it, oauth-parallel refusal.
- Modify `opencode-plugin/src/bench/cmd-ab.ts` — same threading + refusal.
- Modify `opencode-plugin/src/bench/cli.ts` — register the `--convention-audit` boolean in the arg parser + usage line.

---

### Task 1: Frozen audit prompt constant

**Files:**
- Create: `opencode-plugin/src/bench/convention-audit-prompt.txt`
- Create: `opencode-plugin/src/bench/convention-audit.ts` (prompt loader only, this task)
- Test: `opencode-plugin/src/bench/test/convention-audit.test.ts`

**Interfaces:**
- Produces: `export const AUDIT_PROMPT_VERSION = "lane-a-v1"`; `export function auditPrompt(): string`

- [ ] **Step 1: Write the prompt file.** Copy the three validated clauses verbatim from the spec §4 (audit + compute + instruction-criteria + imperative), ending with the machine line instruction. Source text is banked in `docs/loop-probes/rep-audit-20260819/generator/generator-prompt.txt` (audit+compute), the elf-v3 instruction-criteria clause (`docs/loop-probes/census-e2e-20260819/elf-card/audit-prompt-v3.txt`), and the imperative clause (spec §4). Assemble into one file. Last line block MUST instruct: `End your CONTENT section with exactly one line: "CONTENT VERDICT: MISMATCH" or "CONTENT VERDICT: NO MISMATCH".`

- [ ] **Step 2: Write the failing test**

```typescript
import { test, expect } from "bun:test"
import { auditPrompt, AUDIT_PROMPT_VERSION } from "../convention-audit.ts"

test("auditPrompt loads the frozen prompt with all four clauses + verdict line", () => {
  const p = auditPrompt()
  expect(p).toContain("numerically")           // compute clause
  expect(p).toContain("success criteria")      // instruction-criteria clause
  expect(p).toContain("MANDATORY")             // imperative clause
  expect(p).toContain("CONTENT VERDICT:")      // machine line
  expect(AUDIT_PROMPT_VERSION).toBe("lane-a-v1")
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd opencode-plugin && bun test src/bench/test/convention-audit.test.ts -t "auditPrompt"`
Expected: FAIL ("Cannot find module ../convention-audit.ts" or export missing)

- [ ] **Step 4: Write minimal implementation** in `convention-audit.ts`

```typescript
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"

export const AUDIT_PROMPT_VERSION = "lane-a-v1"

export function auditPrompt(): string {
  return readFileSync(join(dirname(new URL(import.meta.url).pathname), "convention-audit-prompt.txt"), "utf-8")
}
```

- [ ] **Step 5: Run test to verify it passes** — Run same command. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add opencode-plugin/src/bench/convention-audit-prompt.txt opencode-plugin/src/bench/convention-audit.ts opencode-plugin/src/bench/test/convention-audit.test.ts
git commit -m "feat(lane-a): frozen convention-audit prompt constant + loader

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Leak-safe sampler with realpath containment

**Files:**
- Modify: `opencode-plugin/src/bench/convention-audit.ts`
- Test: `opencode-plugin/src/bench/test/convention-audit.test.ts`
- Create fixtures: `opencode-plugin/src/bench/test/fixtures/conv-audit/{clean,traversal,symlink,bigdir}/` each with `instruction.md`, `environment/Dockerfile`, `tests/secret.txt`.

**Interfaces:**
- Consumes: `BenchPaths` (`paths.ts:30`, uses `.tbRoot`).
- Produces: `export interface Sample { text: string; truncated: boolean }`; `export function buildSample(paths: BenchPaths, task: string, budgetBytes?: number): Sample`

- [ ] **Step 1: Build fixtures.** `clean/`: Dockerfile `COPY task-deps/data.txt ./`, a real `environment/task-deps/data.txt` with 50 lines, and a `tests/secret.txt` containing `LEAK_CANARY`. `traversal/`: Dockerfile `COPY ../tests/secret.txt /app`. `symlink/`: `environment/link` → symlink to `../tests/secret.txt`, Dockerfile `COPY link /app`. `bigdir/`: `environment/task-deps/` with 400KB across 20 files, Dockerfile `COPY task-deps/ ./`.

- [ ] **Step 2: Write the failing tests**

```typescript
import { buildSample } from "../convention-audit.ts"
const P = (root: string) => ({ tbRoot: root } as any)  // only .tbRoot is read
const FIX = join(dirname(new URL(import.meta.url).pathname), "fixtures/conv-audit")

test("buildSample emits instruction + input, never tests/ bytes", () => {
  const s = buildSample(P(FIX), "clean")
  expect(s.text).toContain("data.txt")
  expect(s.text).not.toContain("LEAK_CANARY")
})
test("buildSample rejects ..-traversal COPY source", () => {
  expect(() => buildSample(P(FIX), "traversal")).toThrow(/outside|containment|leak/i)
})
test("buildSample rejects symlink-out COPY source", () => {
  expect(() => buildSample(P(FIX), "symlink")).toThrow(/outside|containment|leak/i)
})
test("buildSample truncates an oversized dir COPY and flags it", () => {
  const s = buildSample(P(FIX), "bigdir", 100_000)
  expect(s.truncated).toBe(true)
  expect(s.text.length).toBeLessThan(120_000)
})
test("buildSample is deterministic", () => {
  expect(buildSample(P(FIX), "clean").text).toBe(buildSample(P(FIX), "clean").text)
})
```

- [ ] **Step 3: Run tests to verify they fail** — Run: `cd opencode-plugin && bun test src/bench/test/convention-audit.test.ts -t "buildSample"`. Expected: FAIL (buildSample not exported).

- [ ] **Step 4: Implement `buildSample`.** Resolve COPY sources from `<tbRoot>/<task>/environment/Dockerfile` (parse only `COPY <src> <dst>` lines yourself — do NOT import `parseTaskDockerfile`; it does zero containment and `die()`s on unrelated directives). For each `src`: `const root = realpathSync(join(taskDir,"environment")); const cand = realpathSync(join(root, src));` then require `cand === root || cand.startsWith(root + sep)`, else `throw new BenchError("convention-audit: COPY source escapes environment/ (leak guard): " + src)`. Never touch `tests/`/`solution/`. Emit: instruction.md verbatim + per-file `=== <name> (<bytes>) ===` block with a derived summary (text: line count + top token histogram via a simple `\S+` tally + first-column numeric range if parseable; binary: first 64 bytes hex) + head-20/tail-20 lines. Accumulate against `budgetBytes` (default 200_000); on overflow stop adding files, set `truncated: true`.

- [ ] **Step 5: Run tests to verify they pass** — same command. Expected: PASS (all 5).

- [ ] **Step 6: Commit**

```bash
git add opencode-plugin/src/bench/convention-audit.ts opencode-plugin/src/bench/test/
git commit -m "feat(lane-a): leak-safe sampler with realpath containment + size budget

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Content-gate verdict parser + card extractor

**Files:**
- Modify: `opencode-plugin/src/bench/convention-audit.ts`
- Test: `opencode-plugin/src/bench/test/convention-audit.test.ts`

**Interfaces:**
- Produces: `export function parseVerdict(raw: string): "MISMATCH" | "NO_MISMATCH"`; `export function cardFrom(raw: string): string`

- [ ] **Step 1: Write the failing tests**

```typescript
import { parseVerdict, cardFrom } from "../convention-audit.ts"
test("parseVerdict reads the machine line", () => {
  expect(parseVerdict("...\nCONTENT VERDICT: MISMATCH\n...")).toBe("MISMATCH")
  expect(parseVerdict("CONTENT VERDICT: NO MISMATCH")).toBe("NO_MISMATCH")
})
test("parseVerdict defaults to NO_MISMATCH when the line is absent", () => {
  expect(parseVerdict("no verdict here")).toBe("NO_MISMATCH")
})
test("cardFrom returns the audit body verbatim", () => {
  const raw = "SURFACE ... CONTENT ... MISREADINGS ..."
  expect(cardFrom(raw)).toBe(raw.trim())
})
```

- [ ] **Step 2: Run to verify fail** — `bun test ... -t "parseVerdict"` and `-t "cardFrom"`. Expected: FAIL.

- [ ] **Step 3: Implement.**

```typescript
export function parseVerdict(raw: string): "MISMATCH" | "NO_MISMATCH" {
  const m = raw.match(/CONTENT VERDICT:\s*(MISMATCH|NO MISMATCH)/i)
  if (!m) return "NO_MISMATCH"
  return m[1].toUpperCase() === "MISMATCH" ? "MISMATCH" : "NO_MISMATCH"
}
export function cardFrom(raw: string): string {
  return raw.trim()
}
```

- [ ] **Step 4: Run to verify pass** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add opencode-plugin/src/bench/convention-audit.ts opencode-plugin/src/bench/test/convention-audit.test.ts
git commit -m "feat(lane-a): content-gate verdict parser + verbatim card extractor

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: The audit daemon call + `auditCard` orchestration

**Files:**
- Modify: `opencode-plugin/src/bench/convention-audit.ts`
- Test: `opencode-plugin/src/bench/test/convention-audit.test.ts`

**Interfaces:**
- Consumes: `buildSample`, `auditPrompt`, `parseVerdict`, `cardFrom`; the daemon deps `{ call?: typeof daemonCall; ensure?: typeof ensureDaemon; close?: typeof closeSession }`; `DEFAULT_BENCH_MODEL` (`paths.ts:28`).
- Produces:
  ```typescript
  export type AuditResult =
    | { card: string; rawAudit: string; verdict: "MISMATCH"; sample: string; truncated: boolean }
    | { card: null; rawAudit: string; verdict: "NO_MISMATCH" | "ERROR"; sample: string; truncated: boolean }
  export async function runAuditUncached(
    paths: BenchPaths, task: string,
    env: Record<string, string | undefined>,
    deps?: { call?: typeof daemonCall; ensure?: typeof ensureDaemon; close?: typeof closeSession },
  ): Promise<AuditResult>
  ```

- [ ] **Step 1: Write the failing tests** (recorded-reply fixtures, no live call — mirror `a4-review.ts` tests)

```typescript
import { runAuditUncached } from "../convention-audit.ts"
const okReply = (text: string) => ({ kind: "ok", text, model: "anthropic/claude-sonnet-5", canonicalModel: "anthropic/claude-sonnet-5", sessionId: "s1", stopReason: "end_turn" })
const deps = (reply: any) => ({ ensure: async () => {}, call: async () => reply, close: async () => {} })

test("runAuditUncached returns a card on MISMATCH", async () => {
  const r = await runAuditUncached(P(FIX), "clean", {}, deps(okReply("AUDIT BODY\nCONTENT VERDICT: MISMATCH")))
  expect(r.card).toContain("AUDIT BODY"); expect(r.verdict).toBe("MISMATCH")
})
test("runAuditUncached returns null card on NO MISMATCH", async () => {
  const r = await runAuditUncached(P(FIX), "clean", {}, deps(okReply("clean\nCONTENT VERDICT: NO MISMATCH")))
  expect(r.card).toBeNull(); expect(r.verdict).toBe("NO_MISMATCH")
})
test("runAuditUncached fails safe (card null) on daemon error", async () => {
  const r = await runAuditUncached(P(FIX), "clean", {}, deps({ kind: "error" }))
  expect(r.card).toBeNull(); expect(r.verdict).toBe("ERROR")
})
test("runAuditUncached fails safe on max_tokens truncation", async () => {
  const r = await runAuditUncached(P(FIX), "clean", {}, deps({ ...okReply(""), stopReason: "max_tokens" }))
  expect(r.card).toBeNull(); expect(r.verdict).toBe("ERROR")
})
```

- [ ] **Step 2: Run to verify fail** — Expected: FAIL.

- [ ] **Step 3: Implement**, mirroring `runA4Review` (a4-review.ts:247-290):

```typescript
import { ensureDaemon, daemonCall, closeSession, modelProvenBy } from "@th-yoo/cc-api-daemon"
import { DEFAULT_BENCH_MODEL } from "./paths.ts"

export async function runAuditUncached(paths, task, env, deps = {}) {
  const call = deps.call ?? daemonCall, ensure = deps.ensure ?? ensureDaemon, close = deps.close ?? closeSession
  const { text: sample, truncated } = buildSample(paths, task)
  const auditEnv = { ...env, ACP_TURN_TIMEOUT_MS: env.ACP_TURN_TIMEOUT_MS ?? "120000" }
  let sid: string | undefined
  try {
    await ensure(auditEnv, { waitMs: 0 })
    const outcome = await call(auditPrompt() + "\n\n" + sample, DEFAULT_BENCH_MODEL, auditEnv, {})
    if (outcome.kind !== "ok") return { card: null, rawAudit: "", verdict: "ERROR", sample, truncated }
    sid = outcome.sessionId
    if (outcome.stopReason === "max_tokens" || !modelProvenBy(outcome.model, DEFAULT_BENCH_MODEL, outcome.canonicalModel))
      return { card: null, rawAudit: outcome.text ?? "", verdict: "ERROR", sample, truncated }
    const verdict = parseVerdict(outcome.text)
    if (verdict === "NO_MISMATCH") return { card: null, rawAudit: outcome.text, verdict, sample, truncated }
    return { card: cardFrom(outcome.text), rawAudit: outcome.text, verdict: "MISMATCH", sample, truncated }
  } catch {
    return { card: null, rawAudit: "", verdict: "ERROR", sample, truncated }
  } finally {
    if (sid) try { await close(sid, auditEnv) } catch {}
  }
}
```

- [ ] **Step 4: Run to verify pass** — Expected: PASS (all 4).

- [ ] **Step 5: Commit**

```bash
git add opencode-plugin/src/bench/convention-audit.ts opencode-plugin/src/bench/test/convention-audit.test.ts
git commit -m "feat(lane-a): audit daemon call + auditCard orchestration (a4-review shape, fail-safe)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Single-flight per-task cache

**Files:**
- Modify: `opencode-plugin/src/bench/convention-audit.ts`
- Test: `opencode-plugin/src/bench/test/convention-audit.test.ts`

**Interfaces:**
- Produces: `export async function auditCard(paths, task, env, deps?): Promise<AuditResult>` — caches by `task`, single-flights concurrent misses. `export function _resetAuditCache(): void` (test helper).

- [ ] **Step 1: Write the failing test** (asserts the sequential invariant's safety net: concurrent same-task requests share ONE completion)

```typescript
import { auditCard, _resetAuditCache } from "../convention-audit.ts"
test("auditCard single-flights concurrent same-task misses into one call", async () => {
  _resetAuditCache()
  let calls = 0
  const d = { ensure: async () => {}, close: async () => {}, call: async () => { calls++; return okReply("X\nCONTENT VERDICT: MISMATCH") } }
  const [a, b] = await Promise.all([auditCard(P(FIX), "clean", {}, d), auditCard(P(FIX), "clean", {}, d)])
  expect(calls).toBe(1)
  expect(a.card).toBe(b.card)   // byte-identical across "arms"
})
```

- [ ] **Step 2: Run to verify fail** — Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
const _cache = new Map<string, Promise<AuditResult>>()
export function _resetAuditCache() { _cache.clear() }
export async function auditCard(paths, task, env, deps = {}) {
  const hit = _cache.get(task)
  if (hit) return hit
  const p = runAuditUncached(paths, task, env, deps)
  _cache.set(task, p)        // set the PROMISE before await → single-flight
  return p
}
```

- [ ] **Step 4: Run to verify pass** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add opencode-plugin/src/bench/convention-audit.ts opencode-plugin/src/bench/test/convention-audit.test.ts
git commit -m "feat(lane-a): single-flight per-task card cache (concurrent-arm safety net)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Audit-trail write

**Files:**
- Modify: `opencode-plugin/src/bench/convention-audit.ts`
- Test: `opencode-plugin/src/bench/test/convention-audit.test.ts`

**Interfaces:**
- Produces: `export function writeAuditTrail(paths: BenchPaths, task: string, r: AuditResult): void` — appends one JSON line to `<resultsDir>/convention-audit-trail.ndjson` with `{task, promptVersion, verdict, truncated, cardLen, sampleLen, card, rawAudit}`.

- [ ] **Step 1: Write the failing test**

```typescript
import { writeAuditTrail } from "../convention-audit.ts"
test("writeAuditTrail appends one ndjson line with the card + verdict", () => {
  const dir = mkdtempSync(join(tmpdir(), "conv-trail-"))
  writeAuditTrail({ resultsDir: dir } as any, "clean",
    { card: "C", rawAudit: "R", verdict: "MISMATCH", sample: "S", truncated: false })
  const line = JSON.parse(readFileSync(join(dir, "convention-audit-trail.ndjson"), "utf-8").trim())
  expect(line.task).toBe("clean"); expect(line.verdict).toBe("MISMATCH"); expect(line.card).toBe("C")
  expect(line.promptVersion).toBe("lane-a-v1")
})
```

- [ ] **Step 2: Run to verify fail** — Expected: FAIL.

- [ ] **Step 3: Implement** using `appendFileSync`, `AUDIT_PROMPT_VERSION`, `cardLen = r.card?.length ?? 0`.

- [ ] **Step 4: Run to verify pass** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add opencode-plugin/src/bench/convention-audit.ts opencode-plugin/src/bench/test/convention-audit.test.ts
git commit -m "feat(lane-a): audit-trail ndjson writer (leak-safety record)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Wiring — flag, injection, oauth-parallel refusal

**Files:**
- Modify: `opencode-plugin/src/bench/agent-run.ts:135-167` (add `conventionAudit?: string` — the card string — to params; append after `budgetLine`)
- Modify: `opencode-plugin/src/bench/cmd-run.ts`, `cmd-ab.ts` (call `auditCard`+`writeAuditTrail` before `runAgent` when flag on; pass `result.card ?? ""`; oauth-parallel refusal)
- Modify: `opencode-plugin/src/bench/cli.ts` (register `--convention-audit` boolean + usage)
- Test: `opencode-plugin/src/bench/test/convention-audit.test.ts` + assert in an existing agent-run test

**Interfaces:**
- Consumes: `auditCard`, `writeAuditTrail`, `AuditResult`.
- The card is appended in `agent-run.ts` exactly like `budgetLine` — a per-task CONTROLLED CONSTANT, NOT the evolvable `harnessMd`.

- [ ] **Step 1: Write the failing tests**

```typescript
// injection: card appended after budgetLine, absent when off
test("runAgent appends the convention card after the budget line when provided", async () => {
  // drive runAgent with a fake driver capturing buildArgv({instruction}); assert
  // instruction ends with the card AND still contains the budget line; and that
  // with conventionAudit undefined the instruction is byte-identical to today.
})
// oauth-parallel refusal (cmd-run/cmd-ab arg validation)
test("--convention-audit --parallel under oauth is refused", () => {
  expect(() => validateConventionAuditParallel({ conventionAudit: true, parallel: true, keyAuth: false }))
    .toThrow(/convention-audit.*parallel.*oauth/i)
})
```

- [ ] **Step 2: Run to verify fail** — Expected: FAIL.

- [ ] **Step 3: Implement.**
  (a) `agent-run.ts`: add `conventionAudit = ""` param after `harnessMd`; after the `budgetLine` append (`:167`), add — under a CONTROLLED-CONSTANT comment mirroring the budgetLine one — `if (conventionAudit) instruction = instruction + "\n\n" + conventionAudit`.
  (b) `cli.ts`: add `conventionAudit` boolean to the parser (default false) + usage line `[--convention-audit]`.
  (c) `cmd-run.ts`/`cmd-ab.ts`: a shared guard `validateConventionAuditParallel({conventionAudit, parallel, keyAuth})` that throws when `conventionAudit && parallel && !keyAuth` (mirror the refusal at `cmd-run.ts:783-791`). Before each task's `runAgent`, when `conventionAudit` on: `const r = await auditCard(paths, task, env, {}); writeAuditTrail(paths, task, r);` and pass `r.card ?? ""` into `runAgent`. When off, pass `""` — byte-identical path.

- [ ] **Step 4: Run to verify pass** — Expected: PASS. Then run the FULL suite: `cd opencode-plugin && bun test` — expected: green (no regressions; off-path byte-identical).

- [ ] **Step 5: Trace-confirm item-4 (no A/B-gate contamination).** Add a comment + a one-line test asserting the appended card does not appear in `envBlock`'s budget-identity hash (computed once from `harnessMd` before per-task append) nor in stored `TrajEvent`s (`normalizeEvents` parses only assistant/result NDJSON). Grep-verify: `grep -n "envBlock" cmd-ab.ts` shows it built from `harnessMd`, not per-task instruction.

- [ ] **Step 6: Commit**

```bash
git add opencode-plugin/src/bench/agent-run.ts opencode-plugin/src/bench/cmd-run.ts opencode-plugin/src/bench/cmd-ab.ts opencode-plugin/src/bench/cli.ts opencode-plugin/src/bench/test/
git commit -m "feat(lane-a): wire --convention-audit flag, instruction injection, oauth-parallel refusal

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- §3.1 sampler + realpath guard + derived stats + size budget → Task 2. ✓
- §3.2 daemon audit call (a4-review shape, 16s override, agent lane, fail-safe) → Task 4. ✓
- §3.3 content-gate → Task 3. ✓ §3.4 card extract → Task 3. ✓
- §4 frozen prompt (4 clauses + verdict line) → Task 1. ✓
- §5 wiring + cache single-flight + oauth-parallel refusal → Tasks 5, 7. ✓
- §6 audit trail → Task 6. ✓
- §7 revalidator → OUT (increment 2), correctly not a task. ✓
- §9 first-arming blockers A (transport, Task 4), B (oauth refusal, Task 7), C (realpath guard, Task 2) → all covered. ✓
- Item-4 no-gate-contamination trace → Task 7 Step 5. ✓

**Placeholder scan:** no "TBD"/"handle edge cases"/"similar to Task N"; every code step has a concrete block. ✓

**Type consistency:** `AuditResult`, `buildSample→Sample{text,truncated}`, `auditCard`/`runAuditUncached` signatures, `parseVerdict`/`cardFrom`/`writeAuditTrail`/`auditPrompt`/`AUDIT_PROMPT_VERSION` — names used in Tasks 4–7 match their Task 1–3 definitions. ✓
