# Gauge Verification-Channel Ladder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend gauge from a binary "derivable check? (class C)" instrument
into a verification-channel ladder — C1 programmatic / C2 LLM-verifiable /
C3 human-verifiable / C4 no-criterion — so gauge can eventually nudge (never
hard-reject in v1) only the C4 tail: prompts with no falsifiable completion
criterion under ANY channel. User direction 2026-08-03: "gauge should reject
prompts unverifiable with gate" refined by "some portion of
non-programmatically-gatable tasks can be verified with LLM and human —
gauge should not reject such tasks."

**Architecture:** (1) Pre-registration spec fixes the ladder + constants
before any data. (2) Pure channel taxonomy + prompt/parse functions in
`cc-gate-plugin/src/gauge/channel.ts` (mirrors `refiner.ts` discipline:
pure text builders + shape-only parsers, IO elsewhere). (3) A cost-fenced
`channel` batch subcommand in `replay-cli.ts` classifies the EXISTING
corpus's A2/D records (250 on this host) to measure the real C4 base rate
— measurement before actuation. (4) An inert, config-flagged
UserPromptSubmit nudge path (additionalContext only) ships built but OFF;
arming is a separate go gated on the C4 base-rate readout + the in-flight
classifier 2×2 verdict.

**Tech Stack:** Bun + TypeScript, existing gauge module patterns
(`refiner.ts`, `replay-cli.ts`, `transport.ts` SDK transport), bun:test.

## Global Constraints

- **Spec-is-law**: constants freeze at first channel-classification datum;
  pre-data amendments only (registered in the Task 1 spec).
- **Explicit sized go before spend**: every task below is token-free to
  build and test. The corpus channel run (Task 4's *execution*) is model
  spend = its own sized go (`channel --go 250`). Nudge arming = own go.
- **F1**: `core/` is MECHANISM_PATH — never edited. All new code in
  `cc-gate-plugin/src/gauge/` + one `replay-cli.ts` dispatch branch + one
  `hook-cli.ts` UserPromptSubmit branch (src/, editable; core/ untouched).
- **F2**: no sampled prompt text in committed artifacts. Spec/plan/docs
  quote NOTHING from corpus records; script-tally counts only.
- **sonnet=subject, opus=judgment**: channel classification is judgment →
  `claude-opus-5` via the existing SDK transport. Cheap-arm substitution
  waits on the classifier 2×2 verdict (in flight) — NOT in this plan.
- **Sensor-line shape is LAW** (`test/sensor-contract.test.ts`): the nudge
  path appends NO new sensor fields in v1; channel results live in gauge
  corpus records only (`derivation.channel`), never on sensor lines.
- **7b gate is ARMED on this repo**: the branch built from this plan
  merges via `scripts/merge-with-gate.sh` with a committed
  `docs/reviews/<short-sha>-<slug>.md` artifact — that merge is
  falsification-window attempt row(s) in the 7b spec §6 ledger.
- **Fail-open family rule**: every runtime failure in hook/detached paths
  is swallowed; a broken channel classification must never surface as an
  error or block a prompt.
- Corpus store root: `.km/gauge-corpus/` under the repo cwd (canonical
  since 08-01); run all replay-cli subcommands from the meta-harness root.

---

### Task 1: Pre-registration spec (doc only, no code)

**Files:**
- Create: `docs/superpowers/specs/2026-08-03-gauge-verification-channel-ladder-preregistration.md`

**Interfaces:**
- Produces: the constant names + values every later task cites verbatim:
  `CHANNEL_LITERALS = ["C1","C2","C3","C4"]`, nudge scope, over-refusal
  bar. Later tasks copy these; they never re-decide them.

- [ ] **Step 1: Write the spec** with exactly these sections (real content,
  constants PROPOSED where the user has not ruled):

```markdown
# Gauge verification-channel ladder — pre-registration (2026-08-03)

**Status:** DRAFT — constants freeze at the first channel-classification
datum (first `channel --go` record). Open rulings in §6.

## 1. The ladder (definitions — these are the law)

- **C1 (programmatic)**: the prompt's own text states a success condition
  mechanically checkable by a shell command against a named in-repo
  artifact. Existing gauge class C (extract path) and class B
  (floor-covered) both land here.
- **C2 (LLM-verifiable)**: a falsifiable completion criterion is stated
  in the prompt's own words, but checking it requires judgment over
  content (does this explanation answer the question asked; does this
  review cover the diff) — an LLM judge with ONLY the prompt + the final
  artifact could return pass/fail non-vacuously.
- **C3 (human-verifiable)**: a falsifiable criterion is stated but
  judging it needs information or authority outside any transcript
  (taste ruled out — "the user will know it when they see it" is NOT C3;
  C3 requires the criterion itself to be stated, only its judging needs
  the human). Mechanical floor for C3 = demonstrability: evidence
  surfaced in-transcript.
- **C4 (no criterion)**: no falsifiable completion criterion under any
  channel — unbounded adjectives ("better", "cleaner"), unstated scope,
  no boolean exit derivable FROM THE PROMPT'S OWN TEXT.
- **exempt**: class A1 (no evaluation needed) — outside the ladder.

## 2. Class → channel mapping (deterministic part)

A1→exempt · B→C1 · C→C1. A2 and D require a model refinement question
(§3) — they contain the C2/C3/C4 split this instrument exists to measure.

## 3. Refinement question (verbatim prompt text lives in
`cc-gate-plugin/src/gauge/channel.ts` `buildChannelPrompt`; this spec
fixes its CONCEPT): given the prompt text alone — is a falsifiable
completion criterion stated? If yes, could an LLM judge decide pass/fail
from prompt + final artifact alone (C2), or does judging need a human
(C3)? If no criterion is stated at all: C4. Same blind-isolation
discipline as the cls-ab label rubric: the question never sees stored
classes or arm outputs.

## 4. Measurement before actuation (binding order)

1. Batch-classify the existing corpus A2/D records (cost-fenced sized
   go). Script-tally the C2/C3/C4 distribution per host.
2. Only after the C4 base rate is a measured number does the nudge
   arming question go to the user, WITH that number in it.

## 5. Nudge policy (v1, PROPOSED)

- Soft only: UserPromptSubmit additionalContext nudge asking for a
  measurable exit + naming the cheapest channel. NEVER decision:"block"
  in v1. Hard-reject exists only as a §6 open ruling for a future
  loop-shaped band, out of v1 scope.
- Config-flagged: `gate.json` key `"channelNudge": true` arms it;
  absent/false = fully inert (no model call, no latency).
- Prompt-time classification budget: PROPOSED timeout 8s, fail-open
  (timeout/error = no nudge, never a block); heuristic prefilter
  (PROPOSED: prompt length >= 80 chars AND not starting with "/") so
  chat-shaped prompts never trigger a model call.

## 6. Open rulings

1. Nudge text final wording (Task 5 carries a PROPOSED draft).
2. Prompt-time model: opus (judgment rule, costly) vs cls-ab-winning
   cheap arm (only after that verdict lands + within its measured F1
   margin). PROPOSED: no prompt-time arming at all until cls-ab verdict.
3. Prefilter constants (80 chars, "/" exclusion) — freeze at first
   armed firing.
4. Over-refusal bar for the armed nudge, mirroring 7b §6: first N=30
   nudge firings, user-judged spurious rate <= 0.20; failing caps
   rollout, never silently loosens. (PROPOSED N and bar.)
5. Hard-reject band (loop-shaped prompts): entirely deferred; needs its
   own registration.

## 7. Falsification

If the measured C4 rate on the corpus is < 5%, the nudge's value is
marginal — registering now: a sub-5% C4 rate parks Task 5's arming
indefinitely (build stays inert) rather than lowering the trigger bar
to manufacture firings.
```

- [ ] **Step 2: Run `bun scripts/doc-check.ts`** — expect
  `0 violations` (new doc has no dead links).

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-08-03-gauge-verification-channel-ladder-preregistration.md
git commit -m "docs(spec): register gauge verification-channel ladder (pre-data)"
```

### Task 2: Channel taxonomy types + deterministic class→channel mapping

**Files:**
- Create: `cc-gate-plugin/src/gauge/channel.ts`
- Test: `cc-gate-plugin/test/gauge-channel.test.ts`

**Interfaces:**
- Consumes: `GaugePromptClass` from `../types.ts` (existing:
  `"A1"|"A2"|"B"|"C"|"D"`).
- Produces (later tasks rely on these exact names):
  `type VerificationChannel = "C1" | "C2" | "C3" | "C4"`,
  `type ChannelOrExempt = VerificationChannel | "exempt"`,
  `channelForClass(cls: GaugePromptClass): ChannelOrExempt | null` (null
  = needs model refinement, i.e. A2/D),
  `CHANNEL_LITERALS: readonly string[]`.

- [ ] **Step 1: Write the failing test**

```typescript
// cc-gate-plugin/test/gauge-channel.test.ts
import { describe, test, expect } from "bun:test"
import { channelForClass, CHANNEL_LITERALS } from "../src/gauge/channel.ts"

describe("channelForClass", () => {
  test("deterministic classes map without a model", () => {
    expect(channelForClass("A1")).toBe("exempt")
    expect(channelForClass("B")).toBe("C1")
    expect(channelForClass("C")).toBe("C1")
  })
  test("A2 and D need model refinement (null)", () => {
    expect(channelForClass("A2")).toBeNull()
    expect(channelForClass("D")).toBeNull()
  })
  test("channel literal set is the spec's ladder", () => {
    expect(CHANNEL_LITERALS).toEqual(["C1", "C2", "C3", "C4"])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd cc-gate-plugin && bun test test/gauge-channel.test.ts`
Expected: FAIL — `Cannot find module '../src/gauge/channel.ts'`

- [ ] **Step 3: Minimal implementation**

```typescript
// cc-gate-plugin/src/gauge/channel.ts
// km-gauge verification-channel ladder (pre-reg spec 2026-08-03-gauge-
// verification-channel-ladder-preregistration.md §1-§3). Pure module:
// text builders + shape parsers + deterministic mapping. No IO here —
// same discipline as refiner.ts.
import type { GaugePromptClass } from "../types.ts"

export type VerificationChannel = "C1" | "C2" | "C3" | "C4"
export type ChannelOrExempt = VerificationChannel | "exempt"

export const CHANNEL_LITERALS: readonly string[] = ["C1", "C2", "C3", "C4"]

/** Spec §2: A1/B/C map deterministically; A2/D return null = the model
 * refinement question (buildChannelPrompt) decides C2/C3/C4. */
export function channelForClass(cls: GaugePromptClass): ChannelOrExempt | null {
  switch (cls) {
    case "A1":
      return "exempt"
    case "B":
    case "C":
      return "C1"
    case "A2":
    case "D":
      return null
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd cc-gate-plugin && bun test test/gauge-channel.test.ts`
Expected: PASS (3 tests). Also run full suite: `bun test` — 783+ pass,
0 fail.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/gauge/channel.ts cc-gate-plugin/test/gauge-channel.test.ts
git commit -m "feat(gauge): verification-channel taxonomy + deterministic class mapping"
```

### Task 3: Refinement prompt builder + shape parser (pure, token-free)

**Files:**
- Modify: `cc-gate-plugin/src/gauge/channel.ts` (append)
- Test: `cc-gate-plugin/test/gauge-channel.test.ts` (append)

**Interfaces:**
- Produces: `buildChannelPrompt(userPrompt: string): string`,
  `interface ChannelRefinement { channel: "C2"|"C3"|"C4"; reason: string | null }`,
  `parseChannelOutput(text: string): ChannelRefinement | undefined`.
- Blind-isolation BY CONSTRUCTION (cls-ab `buildLabelPrompt` precedent,
  refiner.ts:119 doc comment): `buildChannelPrompt` takes ONLY the prompt
  text — no stored class, no floorCheck, no arm output can even be passed.

- [ ] **Step 1: Write the failing tests**

```typescript
describe("buildChannelPrompt", () => {
  test("contains the prompt inside sentinel markers and no class leakage", () => {
    const p = buildChannelPrompt("write a summary of the design")
    expect(p).toContain("<<<PROMPT")
    expect(p).toContain("write a summary of the design")
    expect(p).toContain('"C2"')
    expect(p).toContain('"C4"')
    // blind isolation: builder must not mention gauge classes at all
    expect(p).not.toContain("A1")
    expect(p).not.toContain('"D"')
  })
})

describe("parseChannelOutput", () => {
  test("parses a well-formed refinement", () => {
    expect(parseChannelOutput('{"channel":"C2","reason":"criterion stated"}'))
      .toEqual({ channel: "C2", reason: "criterion stated" })
  })
  test("tolerates fences and prose around the JSON", () => {
    expect(parseChannelOutput('noise ```{"channel":"C4","reason":null}``` more'))
      .toEqual({ channel: "C4", reason: null })
  })
  test("rejects channels outside the refinement set (C1 not refinable)", () => {
    expect(parseChannelOutput('{"channel":"C1","reason":null}')).toBeUndefined()
    expect(parseChannelOutput('{"channel":"X","reason":null}')).toBeUndefined()
    expect(parseChannelOutput("not json")).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run — expect FAIL** (`buildChannelPrompt is not exported`).

- [ ] **Step 3: Implement** (append to `channel.ts`):

```typescript
/** Refinement channels: only A2/D records are refined, and refinement can
 * never promote to C1 (extraction already ruled that out upstream). */
export interface ChannelRefinement {
  channel: "C2" | "C3" | "C4"
  reason: string | null
}

const REFINEMENT_LITERALS: readonly string[] = ["C2", "C3", "C4"]

/** Spec §3. Deliberately takes ONLY the prompt text (blind isolation by
 * construction — buildLabelPrompt precedent). Never names gauge classes. */
export function buildChannelPrompt(userPrompt: string): string {
  return [
    "You are given a coding-agent task prompt. Answer one question about it:",
    "does the prompt's own text state a falsifiable completion criterion — a",
    "condition someone could check and get a yes/no answer — and if so, who is",
    "the cheapest competent judge of it?",
    "",
    '- "C2": a criterion is stated, and an LLM given only this prompt plus the',
    "  final work product could decide pass/fail non-vacuously.",
    '- "C3": a criterion is stated, but deciding it needs information or',
    "  authority no transcript can carry (a human must judge). The criterion",
    "  itself must still be stated — \"the user will know it when they see it\"",
    '  is NOT "C3".',
    '- "C4": no falsifiable criterion is stated at all — open-ended adjectives,',
    "  unstated scope, no yes/no condition derivable from the prompt text alone.",
    "",
    "Clarifications:",
    "- Judge only the prompt text as written. A criterion you infer from",
    "  context, convention, or from what a typical project would want does not",
    "  count.",
    "- Do not judge difficulty, importance, or how long the task would take.",
    "",
    "Output ONLY a JSON object, no prose, no markdown fences:",
    '{"channel": "C2"|"C3"|"C4", "reason": string|null}',
    "",
    "Task prompt:",
    "<<<PROMPT",
    userPrompt,
    "PROMPT",
  ].join("\n")
}

/** Shape-only parse (parseLabelOutput discipline: first "{" to last "}",
 * undefined on any malformed shape — never fabricate). */
export function parseChannelOutput(text: string): ChannelRefinement | undefined {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) return undefined
  let j: unknown
  try {
    j = JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (typeof j !== "object" || j === null || Array.isArray(j)) return undefined
  const r = j as Record<string, unknown>
  if (typeof r.channel !== "string" || !REFINEMENT_LITERALS.includes(r.channel)) return undefined
  const reason = typeof r.reason === "string" && r.reason.trim() ? r.reason.trim() : null
  return { channel: r.channel as ChannelRefinement["channel"], reason }
}
```

- [ ] **Step 4: Run — expect PASS**; full `bun test` still green; also
  `bunx tsc --noEmit` inside `cc-gate-plugin` clean.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/gauge/channel.ts cc-gate-plugin/test/gauge-channel.test.ts
git commit -m "feat(gauge): channel refinement prompt + shape parser (blind-isolated)"
```

### Task 4: `channel` batch subcommand — cost-fenced corpus measurement

**Files:**
- Modify: `cc-gate-plugin/src/gauge/replay-cli.ts` (new dispatch branch
  beside `derive`, replay-cli.ts:532 pattern)
- Create: `cc-gate-plugin/src/gauge/channel-run.ts` (batch driver — IO
  lives here, mirrors the derive batch driver's structure: lifecycle
  lock, fence re-check under lock, ONE store write at batch end)
- Test: `cc-gate-plugin/test/gauge-channel-run.test.ts`

**Interfaces:**
- Consumes: `channelForClass`, `buildChannelPrompt`,
  `parseChannelOutput` (Task 2/3 exact names); corpus store read/write
  helpers from `corpus-store.ts`; SDK transport from `transport.ts`
  (same call shape the deriver uses); the deriver's cost-fence helper
  (refuse unless `--go <n>` equals the pending count — reuse the
  existing fence function; find it in the derive path and import, do not
  copy).
- Produces: records gain `derivation.channel?: "C1"|"C2"|"C3"|"C4"|"exempt"`
  (deterministic classes stamped WITHOUT model calls; only A2/D spend);
  `channel` CLI: `bun cc-gate-plugin/src/gauge/replay-cli.ts channel [cwd] --go <n>`.
- Usage doc line appended to replay-cli.ts's header comment block.

- [ ] **Step 1: Write failing tests for the pure selection logic**

```typescript
// cc-gate-plugin/test/gauge-channel-run.test.ts
import { describe, test, expect } from "bun:test"
import { selectChannelWork } from "../src/gauge/channel-run.ts"

// Minimal record stubs: only the fields selectChannelWork reads.
const rec = (cls: string, channel?: string) =>
  ({ derivation: { class: cls, ...(channel ? { channel } : {}) } }) as never

describe("selectChannelWork", () => {
  test("A2/D without channel = model work; A1/B/C = stamp-only; done skipped", () => {
    const records = [rec("A2"), rec("D"), rec("C"), rec("A1"), rec("A2", "C2")]
    const w = selectChannelWork(records)
    expect(w.modelWork.length).toBe(2)
    expect(w.stampOnly.length).toBe(2)
    expect(w.done).toBe(1)
  })
  test("records without a derivation class are not work", () => {
    const w = selectChannelWork([{ derivation: {} } as never])
    expect(w.modelWork.length + w.stampOnly.length).toBe(0)
  })
})
```

- [ ] **Step 2: Run — expect FAIL** (module missing).

- [ ] **Step 3: Implement `channel-run.ts`** — pure `selectChannelWork`
  exported for tests; batch driver behind the same structure as the
  derive driver (read store → fence check `go === modelWork.length` →
  acquire lifecycle lock → re-check fence under lock → loop: transport
  call with `buildChannelPrompt`, `parseChannelOutput`, stamp
  `derivation.channel`; malformed output leaves the record unstamped
  (retryable) — never fabricate → stamp all `stampOnly` records via
  `channelForClass` → ONE `writeCorpus` at batch end → release lock →
  print `channel: <n>/<go> refined, <m> stamped deterministic, <k>
  stayed pending (retryable)`).

```typescript
// Pure part (exact shape — driver code follows derive-driver structure):
import { channelForClass } from "./channel.ts"

export interface ChannelWork {
  modelWork: unknown[]   // A2/D lacking derivation.channel
  stampOnly: unknown[]   // A1/B/C lacking derivation.channel
  done: number           // already carrying derivation.channel
}

export function selectChannelWork(records: readonly unknown[]): ChannelWork {
  const out: ChannelWork = { modelWork: [], stampOnly: [], done: 0 }
  for (const r of records) {
    const d = (r as { derivation?: { class?: string; channel?: string } }).derivation
    if (!d?.class) continue
    if (d.channel) { out.done++; continue }
    const direct = channelForClass(d.class as never)
    if (direct === null) out.modelWork.push(r)
    else out.stampOnly.push(r)
  }
  return out
}
```

- [ ] **Step 4: Wire the `replay-cli.ts` dispatch branch** (beside
  `derive`, same arg parsing incl. the fence) and append the usage line
  to the header + the unknown-subcommand usage string
  (replay-cli.ts:620).

- [ ] **Step 5: Run — expect PASS**; full `bun test` green; `tsc` clean.
  Execute-proof token-free: `bun cc-gate-plugin/src/gauge/replay-cli.ts
  channel --go 0` from a scratch dir with an empty store must refuse or
  no-op WITHOUT any model call (fence working).

- [ ] **Step 6: Commit**

```bash
git add cc-gate-plugin/src/gauge/channel-run.ts cc-gate-plugin/src/gauge/replay-cli.ts cc-gate-plugin/test/gauge-channel-run.test.ts
git commit -m "feat(gauge): cost-fenced channel batch subcommand (measure C4 base rate)"
```

**NOT in this task:** actually running `channel --go 250` on the office
corpus. That is model spend → own sized go, recorded per §4 of the Task 1
spec, script-tallied, committed as counts (F2: counts only, no prompt
text).

### Task 5: Inert C4 nudge path (config-flagged OFF, soft-only)

**Files:**
- Modify: `cc-gate-plugin/src/config.ts` (accept optional
  `channelNudge?: boolean` in gate.json — follow the existing optional-key
  pattern, e.g. `checkTimeoutMs`)
- Create: `cc-gate-plugin/src/gauge/nudge.ts` (pure: prefilter + nudge
  text builder)
- Modify: `cc-gate-plugin/src/hook-cli.ts` UserPromptSubmit branch (call
  the nudge decision ONLY when `cfg.channelNudge === true`; on any
  error/timeout emit nothing — fail-open)
- Test: `cc-gate-plugin/test/gauge-nudge.test.ts`

**Interfaces:**
- Consumes: `buildChannelPrompt`/`parseChannelOutput` (Task 3);
  transport (Task 4's call shape); config parse.
- Produces: `shouldConsiderPrompt(prompt: string): boolean` (prefilter,
  spec §5 constants: `length >= 80 && !prompt.startsWith("/")`),
  `buildNudgeContext(channel: "C4"): string` (the additionalContext
  text), and the hook-cli branch emitting
  `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":<text>}}`
  — soft only; `decision:"block"` MUST NOT appear anywhere in this path.

- [ ] **Step 1: Write failing tests**

```typescript
// cc-gate-plugin/test/gauge-nudge.test.ts
import { describe, test, expect } from "bun:test"
import { shouldConsiderPrompt, buildNudgeContext } from "../src/gauge/nudge.ts"

describe("shouldConsiderPrompt (spec §5 prefilter, frozen at first firing)", () => {
  test("short prompts and slash commands never trigger", () => {
    expect(shouldConsiderPrompt("hi")).toBe(false)
    expect(shouldConsiderPrompt("/compact")).toBe(false)
    expect(shouldConsiderPrompt("/goal " + "x".repeat(200))).toBe(false)
  })
  test("long task-shaped prompts pass the prefilter", () => {
    expect(shouldConsiderPrompt("please improve the overall quality of the data layer and make everything nicer across the app somehow".padEnd(120, "."))).toBe(true)
  })
})

describe("buildNudgeContext", () => {
  test("nudge asks for a measurable exit and names the channel ladder, never blocks", () => {
    const t = buildNudgeContext("C4")
    expect(t).toContain("measurable")
    expect(t).toContain("verifiable")
    expect(t.toLowerCase()).not.toContain("refuse")
    expect(t.toLowerCase()).not.toContain("block")
  })
})
```

- [ ] **Step 2: Run — expect FAIL** (module missing).

- [ ] **Step 3: Implement `nudge.ts`**

```typescript
// cc-gate-plugin/src/gauge/nudge.ts — pure pieces of the C4 nudge (spec §5:
// soft-only, config-flagged, fail-open). Model call + emission live in
// hook-cli's UserPromptSubmit branch; nothing here touches IO.

/** Spec §5 prefilter constants — FROZEN at first armed firing. */
const MIN_PROMPT_CHARS = 80

export function shouldConsiderPrompt(prompt: string): boolean {
  return prompt.length >= MIN_PROMPT_CHARS && !prompt.startsWith("/")
}

/** additionalContext text (spec §6 ruling 1 carries final wording; this is
 * the PROPOSED draft). Soft guidance to the model, invisible-to-user by
 * hook semantics; asks for a measurable exit, never refuses work. */
export function buildNudgeContext(channel: "C4"): string {
  return [
    "kkamak gauge: this prompt states no verifiable completion criterion",
    "(no programmatic check, no LLM-judgeable condition, no human-decidable",
    "condition in the prompt's own words). Before starting, restate the goal",
    "with a measurable, verifiable exit — e.g. name the artifact and the",
    "observable property that will hold when done — and confirm it with the",
    "user if the restatement changes scope.",
  ].join(" ")
}
```

- [ ] **Step 4: Wire hook-cli UserPromptSubmit branch** — read cfg; if
  `cfg.channelNudge !== true` → existing behavior untouched (this is the
  whole inertness guarantee, assert it in a test that runs the branch
  logic with the flag absent and expects no added output). When armed:
  prefilter → transport call with `buildChannelPrompt` under an 8s
  timeout (spec §5) → only a parsed `{channel:"C4"}` emits the
  additionalContext JSON; C2/C3/parse-failure/timeout emit nothing.

- [ ] **Step 5: Run — expect PASS**; full `bun test` (all suites) green;
  `tsc` clean; grep-proof soft-only:
  `grep -n 'decision' cc-gate-plugin/src/gauge/nudge.ts` → no matches.

- [ ] **Step 6: Commit**

```bash
git add cc-gate-plugin/src/gauge/nudge.ts cc-gate-plugin/src/hook-cli.ts cc-gate-plugin/src/config.ts cc-gate-plugin/test/gauge-nudge.test.ts
git commit -m "feat(gauge): inert C4 nudge path (config-flagged off, soft-only)"
```

**NOT in this task:** setting `channelNudge: true` anywhere. Arming =
own go, gated on (a) Task 4's measured C4 base rate, (b) the classifier
2×2 verdict for the prompt-time model choice, (c) spec §6 rulings 1-4.

---

## Post-plan (not tasks — recorded so the executor doesn't invent them)

1. **Branch + merge discipline**: all tasks on one branch
   (`gauge-channel-ladder`); per-task reviews per project rule; final
   fresh-context review; merge via `scripts/merge-with-gate.sh` with a
   committed `docs/reviews/<short-sha>-gauge-channel-ladder.md` artifact
   (7b armed — this merge = §6 ledger row).
2. **Corpus channel run** (`channel --go <pending>`): own sized go after
   merge; script-tally C2/C3/C4 counts into
   `docs/gauge-channel/<hostname>-channel-counts.json` (counts only, F2).
3. **Arming decision**: goes to the user with the measured C4 rate +
   spec §7 falsification threshold (<5% parks it).

## Self-review (run per writing-plans skill)

- Spec coverage: ladder defs → Task 1; deterministic mapping → Task 2;
  refinement question → Task 3; measurement-before-actuation → Task 4 +
  post-plan 2; nudge policy → Task 5; over-refusal bar + rulings →
  Task 1 §6 (deliberately spec-side, not code).
- Placeholder scan: none — every step carries real code or exact
  commands. Task 4 Step 3's driver references the derive driver's
  structure by name (lock, fence-under-lock, single writeCorpus) — those
  are existing, findable patterns, with the pure part given in full.
- Type consistency: `VerificationChannel`/`ChannelOrExempt`/
  `ChannelRefinement`/`channelForClass`/`buildChannelPrompt`/
  `parseChannelOutput`/`selectChannelWork` names match across Tasks 2-5.
