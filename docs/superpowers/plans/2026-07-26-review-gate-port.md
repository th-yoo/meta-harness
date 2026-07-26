# Review Gate + Rejected Ledger Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port minimal's Reviewer seat + permanent rejection ledger (R4/R6 lessons) into the production proposer path, so every added playbook bullet passes deterministic + rubric review BEFORE staging/trial, failures are recorded in a durable per-layer ledger, and the ledger feeds back into the proposer prompt (design: `docs/2026-07-25-daily-evolution-loop.md` §4.2, build stage 2).

**Architecture:** Review core is REUSED from `minimal/review.ts` (already platform-independent: injectable `call`, code-computed verdict conjunction) — imported cross-dir exactly like existing tests do (`opencode-plugin/test/minimal-review.test.ts` pattern). The insertion point is `applyProposeArtifact` in `opencode-plugin/src/propose.ts` — the gap after staging-file parse / no-op guard and before `createCandidate` (propose.ts L395-415) — which covers BOTH transports (opencode inline and Claude Code `applyPendingArtifacts`), and safely postdates the F5 microtask hazard (engine.ts L644-660: no async may be inserted between auto-propose fire and child spawn; review runs after the child's artifact exists, so it is unaffected). Ledger = `rejected.json` under each `layer.root`, appended on review-fail, surfaced in `buildProposerPrompt`'s rejected section alongside the existing ab-verdict rejections, and fed to the reviewer's duplicate check.

**Tech Stack:** Bun + TypeScript, `bun:test`, existing `HarnessHost.runTextAgent` as the rubric-review LLM transport (judge-style, tools denied).

## Global Constraints

- The adoption discipline is UNCHANGED: review gate rejects candidates before spend; it never adopts. `startTrial`/ab-verdict flow stays the sole selection path.
- Review applies to PLAYBOOK-MODE proposals' ADDED bullets only (v1). Legacy whole-system.md proposals and non-add ops (tune/demote/drop) pass through un-reviewed with a log line — scope-fenced, not silent.
- Whole-proposal reject on any final-failed added bullet (conservative; partial-op surgery would corrupt proposal provenance).
- Bounded revise: 1 revision round per bullet, diagnosis frozen (minimal's `reviewLoop` semantics, reused as-is).
- Layer-1 checks are free and run even when the LLM reviewer is unavailable; `runTextAgent → null` (LLM down) counts as rubric-unparseable → FAIL (fail-closed, matches minimal).
- Suite baseline before starting: run `bun test` in `opencode-plugin/` and record the pass count; every task ends at that count or higher.

## File Structure

- Create: `opencode-plugin/src/review-gate.ts` — production adapter around `minimal/review.ts` (`reviewAddedBullets()`)
- Modify: `opencode-plugin/src/harness-store.ts` — `readRejectedLedger` / `appendRejectedLedger`
- Modify: `opencode-plugin/src/propose.ts` — call review gate in `applyProposeArtifact`; extend `rejectedSection` in `buildProposerPrompt`
- Test: `opencode-plugin/test/review-gate.test.ts`, extend `opencode-plugin/test/propose-apply.test.ts`

---

### Task 1: Rejected ledger store API

**Files:**
- Modify: `opencode-plugin/src/harness-store.ts` (append at end; read the file's existing IO style first and match it)
- Test: `opencode-plugin/test/rejected-ledger.test.ts`

**Interfaces:**
- Produces:
```ts
export interface RejectedEntry {
  rejectedAt: string          // ISO date
  scope: string               // layer scope
  version: string             // candidate version that carried the bullet
  bullet: string
  violations: string[]
  source: "review-gate"       // future: "ab-verdict" | "trial-loss"
}
export function readRejectedLedger(root: string): RejectedEntry[]        // [] when absent/corrupt
export function appendRejectedLedger(root: string, e: RejectedEntry): void  // creates file, appends, atomic-enough (read-modify-write JSON array like minimal/rejected.json)
```

- [ ] **Step 1: Write failing tests**

```ts
// opencode-plugin/test/rejected-ledger.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readRejectedLedger, appendRejectedLedger, type RejectedEntry } from "../src/harness-store.ts"

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ledger-")) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const entry = (over: Partial<RejectedEntry> = {}): RejectedEntry => ({
  rejectedAt: "2026-07-26", scope: "project-role", version: "v3",
  bullet: "When X, do Y.", violations: ["category: failed"], source: "review-gate", ...over,
})

test("read: missing file → []", () => expect(readRejectedLedger(root)).toEqual([]))
test("read: corrupt file → []", () => {
  writeFileSync(join(root, "rejected.json"), "{nope")
  expect(readRejectedLedger(root)).toEqual([])
})
test("append creates then accumulates", () => {
  appendRejectedLedger(root, entry())
  appendRejectedLedger(root, entry({ version: "v4", bullet: "When Z, do W." }))
  const got = readRejectedLedger(root)
  expect(got.length).toBe(2)
  expect(got[1]!.bullet).toBe("When Z, do W.")
  // file is a pretty JSON array (human-auditable like minimal/rejected.json)
  expect(readFileSync(join(root, "rejected.json"), "utf-8").trimStart().startsWith("[")).toBe(true)
})
```

- [ ] **Step 2: Run, verify fail** — `cd opencode-plugin && bun test test/rejected-ledger.test.ts` → FAIL (no export).

- [ ] **Step 3: Implement in harness-store.ts** (match its existing fs import style):

```ts
// ── rejected ledger (review-gate rejections; permanent proposer input) ──────
export interface RejectedEntry {
  rejectedAt: string
  scope: string
  version: string
  bullet: string
  violations: string[]
  source: "review-gate"
}

export function readRejectedLedger(root: string): RejectedEntry[] {
  const p = path.join(root, "rejected.json")
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf-8"))
    return Array.isArray(j) ? j : []
  } catch {
    return []
  }
}

export function appendRejectedLedger(root: string, e: RejectedEntry): void {
  const p = path.join(root, "rejected.json")
  const cur = readRejectedLedger(root)
  cur.push(e)
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(p, JSON.stringify(cur, null, 2) + "\n")
}
```
(Adjust `path`/`fs` identifiers to the file's actual imports.)

- [ ] **Step 4: Run, verify pass**, then full `bun test` → baseline count holds.

- [ ] **Step 5: Commit** — `git commit -m "feat(store): rejected ledger read/append — durable review-gate rejection record per layer"`

---

### Task 2: review-gate.ts — production adapter over minimal/review.ts

**Files:**
- Create: `opencode-plugin/src/review-gate.ts`
- Test: `opencode-plugin/test/review-gate.test.ts`

**Interfaces:**
- Consumes: `reviewBullet, reviewLoop, layer1Checks, type ReviewResult, type ProposalLike` from `../../minimal/review.ts`; `HarnessHost` (needs `runTextAgent({title, prompt, model}) → string | null` — verify exact signature in `src/host.ts` first and adapt); `readRejectedLedger` (Task 1).
- Produces:
```ts
export interface BulletReviewOutcome {
  bullet: string            // final text (may differ from input after revision)
  staged: boolean           // true = passed review (possibly revised)
  violations: string[]      // final violations when staged=false
  trail: { round: number; bullet: string; verdict: "pass" | "fail" }[]
}
export function reviewAddedBullets(a: {
  host: HarnessHost
  bullets: string[]                 // texts of ops with type "add"
  diagnosisReason: string           // frozen diagnosis (from diagnosis.json summary)
  activeSystem: string              // current harness text for duplicate check
  ledger: RejectedEntry[]           // rejected ledger for duplicate check
  scope: string
  reviewModel?: string
}): Promise<BulletReviewOutcome[]>
```

**Behavior contract:**
1. Layer-1 fail (e.g. 70-word bullet) → outcome staged=false WITHOUT any `runTextAgent` call (free-fail).
2. Layer-1 pass + rubric pass (fake host returns a passing `{"checks":...}` JSON) → staged=true, bullet unchanged.
3. Rubric fail then revision passes: first `runTextAgent` call returns failing checks, second (revision) returns `{"action":"propose","bullet":{"text":"When …(valid revised)…"}}`, third (re-review) returns passing checks → staged=true with the REVISED text; trail length 2.
4. Rubric fail + revision fail → staged=false, violations from final review.
5. `runTextAgent → null` → staged=false with violation containing "no parseable" (fail-closed).
6. Ledger text is embedded in the review prompt (assert the fake host saw a prompt containing a known ledger bullet string).
7. Empty `bullets` array → `[]`, zero LLM calls.

- [ ] **Step 1: Write failing tests.** Fake host pattern: copy `fakeHost` shape from `test/propose-apply.test.ts:43-55`; make `runTextAgent` a scripted queue of replies (`replies.shift()`), recording prompts. Passing rubric reply fixture:
```ts
const PASS_CHECKS = `ok
{"checks":{"category":{"pass":true,"category":"iteration-discipline","quote":"…"},
"domain_swap":{"pass":true,"swapped_bullet":"When a SQL migration fails twice, change the diagnosis."},
"behavior_level":{"pass":true,"restatement":"Agent changes approach after repeated failure."},
"duplicate":{"pass":true,"match":"none"}},"confidence":0.8}`
```
One test per contract bullet (7 tests).

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement `review-gate.ts`:**

```ts
/** opencode-plugin/src/review-gate.ts — production Reviewer seat.
 * Core review logic lives in minimal/review.ts (injectable, code-computed
 * verdict); this file adapts it to HarnessHost + the playbook-ops shape and
 * writes nothing — callers own the ledger. Bounded revise: 1 round,
 * diagnosis frozen (docs/2026-07-24-proposer-review-loop.md). */
import { reviewBullet, reviewLoop, type ProposalLike } from "../../minimal/review.ts"
import type { HarnessHost } from "./host.ts"
import type { RejectedEntry } from "./harness-store.ts"

const REVISE_ROUNDS = 1

function ledgerText(ledger: RejectedEntry[]): string {
  if (ledger.length === 0) return "(none recorded)"
  return ledger.map((e) => `- [${e.rejectedAt} ${e.scope} ${e.version}] ${e.bullet} (violations: ${e.violations.join("; ")})`).join("\n")
}

function revisionPrompt(p: ProposalLike, violations: string[], rejected: string): string {
  return `You are the LESSON PROPOSER in a REVISION round. Your previously proposed
rule failed external review. Your DIAGNOSIS is FROZEN — do not re-diagnose.
Reform ONLY the rule so it fixes the violations below, stays behavior-level
("When <trigger>, <action>." or "Do not X until Y", <=60 words, no task/domain
specifics), or abstain if impossible.

## Frozen diagnosis
${p.reason ?? ""}
## Your rejected rule
${p.bullet?.text ?? ""}
## Review violations
${violations.map((v) => `- ${v}`).join("\n")}
## Previously REJECTED lessons (do NOT re-derive)
${rejected}

Reply with EXACTLY ONE JSON object:
{"action":"propose"|"abstain","reason":"<one sentence>","bullet":{"text":"<the rule>"}}`
}

export async function reviewAddedBullets(a: {
  host: HarnessHost
  bullets: string[]
  diagnosisReason: string
  activeSystem: string
  ledger: RejectedEntry[]
  scope: string
  reviewModel?: string
}): Promise<BulletReviewOutcome[]> {
  const rejected = ledgerText(a.ledger)
  const call = async (prompt: string) => {
    const reply = await a.host.runTextAgent({ title: `[meta-harness] review ${a.scope}`, prompt, model: a.reviewModel })
    return reply ?? ""   // null (LLM down) → unparseable → fail-closed in computeVerdict
  }
  const out: BulletReviewOutcome[] = []
  for (const text of a.bullets) {
    const proposal: ProposalLike = { action: "propose", reason: a.diagnosisReason, bullet: { text } }
    const { final, staged, trail } = await reviewLoop({
      proposal,
      rounds: REVISE_ROUNDS,
      review: (bullet, reason) => reviewBullet({
        bullet, reason, harness: a.activeSystem, rejected, taskId: "", call,
      }),
      revise: async (p, r) => {
        const reply = await call(revisionPrompt(p, r.violations, rejected))
        const { extractJsonObject } = await import("../../minimal/review.ts")
        return (extractJsonObject(reply, /\{\s*"action"/) as ProposalLike) ?? { action: "abstain", reason: "revision reply unparseable" }
      },
    })
    out.push({
      bullet: final.bullet?.text ?? text,
      staged,
      violations: staged ? [] : trail[trail.length - 1]!.review.violations,
      trail: trail.map((t) => ({ round: t.round, bullet: t.bullet, verdict: t.review.verdict })),
    })
  }
  return out
}
```
IMPLEMENTER: check `runTextAgent`'s real signature in `src/host.ts` (title/prompt/model fields, return type) and the `taskId` argument value — pass the layer scope if `reviewBullet` uses it only for leak checks (empty string disables task-fragment leak checks; scope is not a task id — empty is correct here). Move the `extractJsonObject` import to top-level.

- [ ] **Step 4: Run, verify pass**; full suite holds baseline.

- [ ] **Step 5: Commit** — `git commit -m "feat(review-gate): production Reviewer seat over minimal/review.ts — layer1 + rubric + bounded revise, fail-closed"`

---

### Task 3: Wire into applyProposeArtifact + ledger writes

**Files:**
- Modify: `opencode-plugin/src/propose.ts` (`applyProposeArtifact`, gap at ~L395-415 after the no-op guard, before `createCandidate` at L415)
- Test: extend `opencode-plugin/test/propose-apply.test.ts`

**Interfaces:**
- Consumes: `reviewAddedBullets` (Task 2), `readRejectedLedger`/`appendRejectedLedger` (Task 1), existing `readActiveSystem`, playbook op shape (READ `harness-store.ts` Playbook/PlaybookOp types first — the "add" op's bullet-text field name must be taken from the real type, NOT assumed).

**Behavior contract:**
1. Playbook proposal whose added bullets all pass review → `createCandidate` + `startTrial` happen exactly as before (assert via existing test helpers `listVersions`/`readTrial`).
2. Any added bullet final-fails → NO candidate created, NO trial started; one `RejectedEntry` per failed bullet appended to `layer.root/rejected.json`; host.notify called with a "review-rejected" message; return "applied".
3. A bullet REVISED by review replaces the original text in the op before `createCandidate` (assert staged playbook contains revised text).
4. Non-playbook (legacy system.md) proposal → review skipped entirely, one log line contains "review-gate: skipped (legacy mode)"; behavior otherwise unchanged.
5. Proposal with only non-add ops → review skipped ("no added bullets"), unchanged behavior.
6. Review runs AFTER the no-op guard (a no-op proposal never triggers LLM review — zero `runTextAgent` calls).

- [ ] **Step 1: Write failing tests** in `propose-apply.test.ts` style: hermetic `META_HARNESS_HOME` tmp store, hand-written staging files (ops.json with one add op + diagnosis.json), `fakeHost` with scripted `runTextAgent` queue (reuse Task 2 fixtures — import or copy `PASS_CHECKS`). One test per contract bullet.

- [ ] **Step 2: Run, verify fail** (review not wired: candidate gets created even with failing rubric reply).

- [ ] **Step 3: Implement wiring** in `applyProposeArtifact`, inserted immediately after the no-op guard block (after L413's `return "applied"`, before `createCandidate` L415):

```ts
  // ── review gate (R4/R6 port): added bullets must pass review BEFORE spend ──
  if (newPlaybook) {
    const addedOps = /* ops of type "add" — use the real PlaybookOp discriminator */
    if (addedOps.length > 0) {
      const ledger = readRejectedLedger(layer.root)
      const outcomes = await reviewAddedBullets({
        host, bullets: addedOps.map((o) => o./*textField*/),
        diagnosisReason: /* summary string from the parsed diagnosis object */,
        activeSystem: readActiveSystem(layer.root),
        ledger, scope: layer.scope,
      })
      const failed = outcomes.filter((o) => !o.staged)
      if (failed.length > 0) {
        for (const f of failed) appendRejectedLedger(layer.root, {
          rejectedAt: new Date().toISOString().slice(0, 10),
          scope: layer.scope, version, bullet: f.bullet,
          violations: f.violations, source: "review-gate",
        })
        await host.log("info", `review-gate ${layer.scope}: REJECTED ${failed.length}/${outcomes.length} added bullet(s) — no candidate, no trial`)
        await host.notify(`Proposer ${layer.scope}: review-rejected (${failed[0]!.violations[0] ?? "violations"}) — recorded in ledger`, "warning", 10_000)
        return "applied"
      }
      // staged (possibly revised): write revised texts back into the ops
      addedOps.forEach((o, i) => { o./*textField*/ = outcomes[i]!.bullet })
    } else {
      await host.log("info", `review-gate ${layer.scope}: skipped (no added bullets)`)
    }
  } else {
    await host.log("info", `review-gate ${layer.scope}: skipped (legacy mode)`)
  }
```
IMPLEMENTER: resolve every `/*…*/` against the REAL types in harness-store.ts (op discriminator + text field) and the parsed diagnosis shape in this function (present near L308). `reviewAddedBullets` is async — this insertion point is inside an already-async function on both transports; the F5 hazard (engine.ts L644-660) does NOT apply here (child already spawned and finished). Keep the mutation of ops BEFORE `createCandidate(...)` so staged content carries the revised text.

- [ ] **Step 4: Run new tests + FULL suite** — baseline holds; note any test that asserted old staging behavior and adapt it deliberately (document in commit message if so).

- [ ] **Step 5: Commit** — `git commit -m "feat(propose): review gate wired before createCandidate/startTrial — whole-proposal reject + ledger on bullet review failure, both transports"`

---

### Task 4: Feed ledger into the proposer prompt

**Files:**
- Modify: `opencode-plugin/src/propose.ts` (`buildProposerPrompt` `rejectedSection`, L840-863)
- Test: extend `opencode-plugin/test/review-gate.test.ts` (or a new `proposer-prompt-ledger.test.ts` if propose-prompt tests don't exist — check for existing buildProposerPrompt tests first and co-locate)

**Behavior contract:**
1. With ledger entries present, `buildProposerPrompt` output contains a "review-gate REJECTED" block listing each ledger bullet + violations, adjacent to the existing ab-verdict rejected section.
2. Empty ledger → prompt unchanged vs today (byte-identical for a fixture store with no ledger).
3. Ledger block appears BEFORE "## Your task — DIAGNOSE" (same region as rejectedSection, L984).

- [ ] **Step 1: Write failing tests** — build a fixture layer root, `appendRejectedLedger` two entries, call `buildProposerPrompt` with minimal args (mirror an existing caller; if no test calls it today, construct via the same fixtures propose-apply tests use) and assert contract 1-3.

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement** — inside the `rejectedSection` IIFE (L840) or as a sibling `ledgerSection` concatenated at L984:

```ts
  const ledgerSection = (() => {
    const ledger = readRejectedLedger(layer.root)
    if (ledger.length === 0) return ""
    const lines = ledger.map((e) => `- [${e.rejectedAt} ${e.version}] ${e.bullet}\n  violations: ${e.violations.join("; ")}`)
    return `## Rules the review gate REJECTED before any experiment — do NOT re-derive or rephrase\n\n${lines.join("\n")}\n\n`
  })()
```
and add `${ledgerSection}` immediately after `${rejectedSection}` in the template (L984).

- [ ] **Step 4: Run new tests + full suite** — green, baseline holds.

- [ ] **Step 5: Commit** — `git commit -m "feat(propose): rejected ledger feeds the proposer prompt — review-gate rejections join ab-verdict rejections as permanent input"`

---

## Self-Review Notes (author-run)

- §4.2 coverage: layer-1 deterministic checks ✓ (via minimal reuse), rubric review ✓, bounded revise ✓ (1 round, frozen diagnosis), permanent rejection ledger ✓ (Task 1), ledger as proposer input ✓ (Task 4). Trial-loss/ab-verdict ledger sources: DEFERRED (ab-verdict rejections already reach the prompt via the existing rejectedSection; unifying sources is stage-3 territory).
- Placeholders: Task 3 deliberately carries `/*…*/` markers ONLY where the real type names must be read from harness-store.ts at implementation time — each is an explicit instruction to resolve against a named file, not a TBD.
- Type consistency: `RejectedEntry` defined once (Task 1), imported by Tasks 2-4. `BulletReviewOutcome` defined Task 2, consumed Task 3.
