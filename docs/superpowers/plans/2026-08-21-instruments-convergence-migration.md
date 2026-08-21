# Instruments-Convergence Migration (Phase 1: lab → kkamak) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **This plan is executed across TWO sessions:** lane M = the meta-harness session (`~/z2/meta-harness`), lane K = the `kkamak` peer session (`~/z2/kkamak`), driven by lane M via SendMessage. See "Execution & driving protocol".

**Goal:** Port the proven gauge runtime instrument from the lab plugin (`cc-gate-plugin`) into kkamak as a config-gated, off-by-default extension, behind a generic extension seam — without touching the deployed lab plugin or its b3 emission stream.

**Architecture:** kkamak gains an `src/extensions/` boundary: extensions parse their own block of `gate.json`, decorate the `GateHost` (sensor-line annotation) and run detached side-effects after the kernel's decision — additive only, the kernel is never modified and never imports extensions. The gauge port takes the runtime instrument subset only (~2.7k lines); experiment machinery (cls-ab, paired-validation, replay/refiner, corpus-mine) and daemon-backed transports stay lab-side, plugged in later at back-port time through the same seam.

**Tech Stack:** Bun + TypeScript (strict), `bun test`, zero runtime dependencies (enforced by `test/imports.test.ts`).

**Spec:** No standalone spec file. The binding rulings are: (1) the user-ruled strategy in `docs/resume.md` @ `296c806` ("migrate proven instruments INTO kkamak config-gated, then BACK-PORT kkamak → cc-gate-plugin; NEVER retire the lab plugin"), (2) `~/z2/meta-harness/CLAUDE.md` (generality rule), (3) the repo survey embedded in this plan's task file lists (verified against both trees 2026-08-21).

## Global Constraints

- **Scope: migration INTO kkamak only.** Back-porting cc-gate-plugin onto kkamak is a SEPARATE future plan with its own user go. `~/z2/meta-harness/cc-gate-plugin/` is READ-ONLY for this entire plan.
- **b3 continuity:** the installed plugin cache (`~/.claude/plugins/`, `kkamak-local` → `cc-gate-plugin` @ 0.4.x) must be untouched; gauge emissions to `.km/gauge/` must continue. Verified by Task M4.
- **Off by default:** with no `extensions` key in `gate.json`, kkamak's observable behavior (hook stdout/stderr/exit code AND sensor lines) must be byte-identical to 0.7.0. Proven by test in K1 and again end-to-end in K5.
- **Kernel purity holds:** `src/kernel/` is not modified by any task in this plan. `src/adapters/` and `src/runtime/` may import from `src/extensions/` ONLY via `src/extensions/registry.ts`. Extensions may import `kernel/ports.ts` types. Enforced by extending `test/imports.test.ts`, including a guard-can-fail test.
- **Zero runtime dependencies stands:** no `@anthropic-ai/sdk`, no `@th-yoo/cc-api-daemon` in kkamak. LLM calls go through an extension-local transport port; only the CLI-spawn provider is ported.
- **Version bump discipline (merge≠deploy):** the release lands as ONE version bump (0.7.0 → 0.8.0) in `.claude-plugin/plugin.json` + `package.json` + `CHANGELOG.md`, in the same change as the last code commit (Task K6). No push, no merge, no release without explicit user go.
- **No push from lane K without user go** — worker commits locally and reports; lane M relays state to the user.
- **Frozen-contract parity:** kkamak's sensor schema deliberately mirrors cc-gate-plugin (`ports.ts` comments call it "the frozen contract"). Ported gauge annotations must extend `SensorLine` the way the lab plugin does (`gauge` field, `present:false + offReason` on silence), not invent a new shape.
- **Commit style:** kkamak commits end with the `Co-Authored-By` trailer the repo already uses; conventional-commit subjects (`feat(extensions): …`).

---

## DAG

```
 lane M (meta-harness session)          lane K (kkamak peer session)
 ─────────────────────────────          ────────────────────────────
 M1 inventory + evidence  ─┐            K1 extension seam
 M2 core divergence map  ─┐│               │
        │                 ││   ┌───────────┤  ◄── CHECKPOINT 1 (M reviews K1; user go to proceed)
        │                 │└──►│
        │                 └───►│ K2 gauge pure-core port
        │                      │   │
        │                      │ K3 transport port + CLI provider (+ channel)
        │                      │   │
        └─────(review feed)───►│ K4 shadow/spawn/state wiring, config-gated
                               │   │
                               │ K5 off-by-default parity + guard-can-fail proofs
                               │   │  ◄── CHECKPOINT 2 (M reviews full diff)
 M4 b3-continuity check ──────►│ K6 version bump + changelog
                                   ▲
                                   └── CHECKPOINT 3 (user go: push/release)
```

**Parallelism:** M1 ∥ M2 ∥ K1 start immediately (no shared files, different repos). K2 needs K1 (seam) and is *informed* by M1/M2 (gate + rewrite table) — M1/M2 are small and finish well inside K1's runtime, so no stall in practice. K3→K4→K5→K6 are sequential inside lane K (each consumes the previous task's exports). Lane M reviews each K task on completion while K proceeds to the next — review is advisory mid-stream, blocking only at the three checkpoints.

**Halt condition:** if M1 does NOT verdict gauge "migrate-now" (evidence fails the rubric), lane K stops after K1 and the plan re-scopes with the user. K1 is useful regardless (the seam is instrument-agnostic).

---

## Execution & driving protocol (lane M drives)

- Dispatch: `SendMessage` to peer `kkamak` with one task block at a time, copied verbatim from this plan (task text is self-contained; the worker does not read this plan file — it lives in the other repo).
- If the peer refuses a cross-session instruction (distrust), that is the security model working: fall back to the tmux pane (`kkamak:0.0`, pane `%0`) and type the same task text truthfully as user-visible input. Never fight the refusal.
- Review: lane M reads `~/z2/kkamak` files and `git -C ~/z2/kkamak log/diff` directly after each task report. Findings go back as a follow-up SendMessage; the worker fixes before the next task.
- Lane K never touches `~/z2/meta-harness`; lane M never edits `~/z2/kkamak` files (read-only review).
- Worker's standing rules, repeated in every dispatch: TDD (test first, watch it fail), commit per task, no push, `bun test` + `bun run typecheck` green before "done".

---

### Task M1: Instrument inventory with evidence pointers (lane M)

**Files:**
- Create: `docs/superpowers/specs/2026-08-21-instrument-inventory.md` (in `~/z2/meta-harness`)

**Interfaces:**
- Consumes: `cc-gate-plugin/src/` tree (read-only), `.km/` emission stores, `~/z2/kkamak/.km/gauge/`, memory/resume records with commit hashes.
- Produces: a verdict table consumed by the K2 gate and by the future back-port plan. Columns: `instrument | files | live evidence (pointer) | decision-neutral? | external deps | verdict`.

**Rubric (fixed here, applied there — no per-instrument invention):** an instrument is **migrate-now** iff (a) it has a live measurement record produced by deployed code (emission files, dogfood-log entries — a pointer to actual bytes, not a memory claim; POINTER-OR-INADMISSIBLE), (b) it never alters a `GateDecision` (annotate/observe/spawn only), and (c) its runtime code can satisfy kkamak's zero-dependency rule, possibly behind a transport port. Otherwise **lab-only** (experiment machinery, unproven, or dep-bound) or **dead**.

- [ ] **Step 1: Enumerate candidates from the artifact** (not from memory): every `src/` file outside `core/`, `config.ts`, `hook-cli.ts`, `state.ts`, `types.ts`, `output.ts`, `check-runner.ts`, `init-cli.ts` in cc-gate-plugin. Expected rows at minimum: `gauge/` runtime subset, `gauge/` experiment subset (cls-ab, paired-validation, corpus-mine, corpus-replay, replay-cli, refiner, refiner-cli), `review-sensor/` (+spawn), `prompt-check` (2 files), `sidecar.ts`, `sensor-append.ts`, `reinject.ts`, `score.ts`/`score-cli.ts`, `hook-rule-outcomes.ts`, `fixture-ref.ts`, `acp-client-singleton.ts`, `gauge/providers/*`.
- [ ] **Step 2: Attach evidence per row.** Commands, output pasted into the doc:

```bash
ls ~/z2/kkamak/.km/gauge/*.done.json | wc -l           # gauge live emissions
ls ~/z2/meta-harness/.km 2>/dev/null; ls ~/z2/meta-harness/cc-gate-plugin/.km/cc-gate/ | head
grep -rn "review-sensor\|sidecar" ~/z2/kkamak/docs/dogfood-log.md ~/z2/meta-harness/docs/ --include="*.md" -l | head
grep -c "cc-api-daemon\|@anthropic-ai/sdk\|acp-client-singleton" ~/z2/meta-harness/cc-gate-plugin/src/gauge/transport.ts ~/z2/meta-harness/cc-gate-plugin/src/gauge/send-prompt.ts ~/z2/meta-harness/cc-gate-plugin/src/gauge/providers/*.ts
```

- [ ] **Step 3: Verdict each row against the rubric.** Known priors to CHECK, not assume: review-sensor ships OFF and never armed → expect lab-only; reinject is an experiment arm (`KKAMAK_REINJECT`) → expect lab-only; gauge runtime has `.done.json` emissions in a second checkout → expect migrate-now. If evidence contradicts a prior, the evidence wins and the plan's halt condition applies.
- [ ] **Step 4: Commit** (meta-harness; exact-path staging per shared-checkout rule):

```bash
git -C ~/z2/meta-harness add docs/superpowers/specs/2026-08-21-instrument-inventory.md
git -C ~/z2/meta-harness diff --cached --stat   # verify ONLY this file staged
git -C ~/z2/meta-harness commit -m "docs(migration): instrument inventory with evidence pointers"
```

---

### Task M2: Core divergence map — lab types → kkamak ports (lane M)

**Files:**
- Create: `docs/superpowers/specs/2026-08-21-core-divergence-map.md` (in `~/z2/meta-harness`)

**Interfaces:**
- Consumes: `cc-gate-plugin/src/types.ts`, `src/config.ts`, `src/sensor-append.ts`, `src/check-runner.ts`, `src/state.ts` vs `kkamak/src/kernel/ports.ts`, `src/kernel/config.ts`, `src/runtime/*`.
- Produces: the **import-rewrite table** K2–K4 apply mechanically. One row per symbol gauge imports from outside `gauge/`: `lab symbol (file) | kkamak equivalent (file) | adaptation needed`.

- [ ] **Step 1: Extract gauge's exact external-import surface** (this is the complete demand side — the table must cover every row):

```bash
grep -h 'from "\.\./' ~/z2/meta-harness/cc-gate-plugin/src/gauge/*.ts | sort -u
```

Known from survey (verify, then map): `../types.ts` (14×), `../send-prompt.ts`, `../transport.ts`, `../sensor-append.ts`, `../config.ts`, `../check-runner.ts`, `../fixture-ref.ts`, `../agent-transport.ts`, `../../acp-client-singleton.ts`.

- [ ] **Step 2: Map each imported SYMBOL** (grep the specific named imports, not just files) to its kkamak home: `GateConfig`/`SensorLine` → `src/kernel/ports.ts` (note field diffs: kkamak has no `gauge`/`channelNudge` config fields — the extension's own config supplies these; see K1), check running → `src/runtime/check-runner.ts` (`SpawnCheckRunner`, `TIMEOUT_EXIT_CODE`), sensor append → `src/runtime/ndjson-sink.ts` (`NdjsonSensorSink`), state paths → `src/runtime/file-state-store.ts`. Symbols with NO kkamak equivalent (daemon transports, `acp-client-singleton`, `fixture-ref`) get row value **`lab-only — do not port; covered by K3 transport port or excluded file list`**.
- [ ] **Step 3: Commit** (same exact-path staging discipline as M1):

```bash
git -C ~/z2/meta-harness add docs/superpowers/specs/2026-08-21-core-divergence-map.md
git -C ~/z2/meta-harness diff --cached --stat
git -C ~/z2/meta-harness commit -m "docs(migration): lab→kkamak core divergence map for gauge port"
```

---

### Task K1: Extension seam in kkamak (lane K — dispatch to `kkamak` peer)

**Files:**
- Create: `src/extensions/config.ts`, `src/extensions/registry.ts`
- Modify: `src/adapters/claude-code/hook-cli.ts` (wire seam), `test/imports.test.ts` (extend boundary rules)
- Test: `test/extensions-config.test.ts`, `test/extensions-registry.test.ts`, plus new cases inside `test/imports.test.ts` and `test/claude-code-adapter.test.ts`

**Interfaces:**
- Consumes: `GateHost`, `GateEvent`, `GateDecision` types from `src/kernel/ports.ts`; raw `gate.json` text via `host.config`.
- Produces (exact signatures — K2–K4 build against these):

```ts
// src/extensions/config.ts
/** Names under gate.json "extensions" whose value is the literal `true`.
 *  Missing key, malformed JSON, non-object, or any other value shape → []. Never throws. */
export function parseEnabledExtensions(raw: string | undefined): string[]

// src/extensions/registry.ts
export interface Extension {
  name: string
  /** Decorate the host (e.g. wrap host.sensor to annotate lines). MUST return
   *  a host that behaves identically except for additive annotation. */
  wrapHost(host: GateHost): GateHost
  /** Detached side-effects after the kernel decided. MUST NOT change the
   *  emitted decision. Errors are swallowed by the registry, logged to host.logger. */
  afterDecision(event: GateEvent, decision: GateDecision, host: GateHost): Promise<void>
}
export interface ActiveExtensions {
  wrapHost(host: GateHost): GateHost          // identity when none enabled
  afterDecision(event: GateEvent, decision: GateDecision): Promise<void>  // noop when none
}
/** Registry of known extensions. K1 ships it EMPTY: {} — gauge registers in K4. */
export const EXTENSIONS: Record<string, Extension>
export async function loadActiveExtensions(host: GateHost): Promise<ActiveExtensions>
```

- [ ] **Step 1: Write failing config tests** — `test/extensions-config.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { parseEnabledExtensions } from "../src/extensions/config.ts"

describe("parseEnabledExtensions", () => {
  test("missing raw → []", () => expect(parseEnabledExtensions(undefined)).toEqual([]))
  test("no extensions key → []", () =>
    expect(parseEnabledExtensions('{"check":"bun test"}')).toEqual([]))
  test("literal true enables; anything else does not", () =>
    expect(parseEnabledExtensions(
      '{"check":"x","extensions":{"gauge":true,"a":1,"b":"true","c":false}}',
    )).toEqual(["gauge"]))
  test("malformed JSON → [] (never throws)", () =>
    expect(parseEnabledExtensions('{oops')).toEqual([]))
  test("extensions not an object → []", () =>
    expect(parseEnabledExtensions('{"check":"x","extensions":["gauge"]}')).toEqual([]))
})
```

- [ ] **Step 2: Run** `bun test test/extensions-config.test.ts` — expect FAIL (module not found).
- [ ] **Step 3: Implement `src/extensions/config.ts`** with the same never-throw discipline as `kernel/config.ts` (sorted output for determinism):

```ts
export function parseEnabledExtensions(raw: string | undefined): string[] {
  if (!raw) return []
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return [] }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return []
  const ext = (parsed as Record<string, unknown>).extensions
  if (typeof ext !== "object" || ext === null || Array.isArray(ext)) return []
  return Object.entries(ext as Record<string, unknown>)
    .filter(([, v]) => v === true)
    .map(([k]) => k)
    .sort()
}
```

- [ ] **Step 4: Write failing registry tests** — `test/extensions-registry.test.ts`. Must cover: (a) no enabled extensions → `wrapHost(h) === h` (object identity, not deep-equal) and `afterDecision` resolves without effect; (b) enabled-but-unknown name → identity + one `host.logger` line naming it (silence-is-forbidden, matching the lab's `offReason` discipline); (c) a fake registered extension's `afterDecision` that THROWS is swallowed and logged — the returned promise still resolves (use `test/fakes.ts` host fakes); (d) a fake extension's `wrapHost` is applied when its name is enabled.
- [ ] **Step 5: Run** — expect FAIL. **Implement `src/extensions/registry.ts`** to pass: reads raw config via `host.config` (same source the kernel reads — one config, no second file), filters `EXTENSIONS` by `parseEnabledExtensions`, composes `wrapHost` in sorted-name order, `afterDecision` iterates sequentially inside try/catch per extension.
- [ ] **Step 6: Wire the adapter.** In `src/adapters/claude-code/hook-cli.ts`, replace the gate construction:

```ts
const host = createNodeHost({ root: parsed.root, app: APP, stopTimeoutMs: STOP_HOOK_TIMEOUT_MS })
const ext = await loadActiveExtensions(host)
const gate = createGate(ext.wrapHost(host))
const decision = await gate.handle(parsed.event)
await ext.afterDecision(parsed.event, decision)
const plan = planEmit(decision)
```

Add an adapter test in `test/claude-code-adapter.test.ts`: with a `gate.json` lacking `extensions`, the full hook output for a Stop payload is **byte-identical** to the pre-change expectation the suite already pins (existing adapter tests must pass UNCHANGED — that is the parity proof at this layer; if any existing expectation needs editing, the seam broke parity and the implementation is wrong).

- [ ] **Step 7: Extend `test/imports.test.ts`** with an `extensions isolation` describe mirroring the existing `skills isolation` block: (a) `kernel/` imports nothing from `extensions/`; (b) `adapters/` and `runtime/` import from `extensions/` only the specifier ending `extensions/registry.ts`; (c) **guard-can-fail test**: a synthetic file list containing `src/kernel/gate.ts → ../extensions/registry.ts` is flagged by the scan (copy the pattern of the existing "the guard would catch a real violation" test).
- [ ] **Step 8: Full suite** — `bun test && bun run typecheck`. Expect: all green, zero existing-test edits outside `imports.test.ts`/`claude-code-adapter.test.ts` additions.
- [ ] **Step 9: Commit** `feat(extensions): config-gated extension seam (registry empty, off-by-default proven)`.

**CHECKPOINT 1 (lane M):** review K1 diff (`git -C ~/z2/kkamak diff HEAD~1`) against this task's spec, confirm M1 verdicts gauge migrate-now, report both to the user, get go for K2–K6.

---

### Task K2: Gauge pure-core port (lane K)

**Files:**
- Create: `src/extensions/gauge/classifier.ts`, `evaluate.ts`, `validate.ts`, `guard.ts`, `files.ts`, `nudge.ts` (ported from `~/z2/meta-harness/cc-gate-plugin/src/gauge/` — lane M pastes each source file's content into the dispatch, or the worker reads them; **reading the lab repo is allowed, writing is not**)
- Test: `test/gauge-classifier.test.ts`, `test/gauge-evaluate.test.ts`, `test/gauge-validate.test.ts`, `test/gauge-guard.test.ts`, `test/gauge-files.test.ts`, `test/gauge-nudge.test.ts` (ported from lab `test/`)

**Interfaces:**
- Consumes: K1 seam types; M2's import-rewrite table (relayed in the dispatch message).
- Produces: the pure gauge core K3/K4 import — exported symbol names preserved EXACTLY as in the lab files (the port renames files' imports, never their exports).

**Port recipe (per file, test-first):**
- [ ] **Step 1:** Copy the lab TEST file into `test/`, rewrite its import paths per M2's table (`../src/gauge/X.ts` → `../src/extensions/gauge/X.ts`; lab `../src/types.ts` symbols → `../src/kernel/ports.ts` or the extension's own types file per table).
- [ ] **Step 2:** Run it — expect FAIL "module not found".
- [ ] **Step 3:** Copy the lab SOURCE file, apply the same rewrite table. Where the table says a lab symbol has no kkamak home and the file still needs it (expected for `GateConfig.gauge`/`channelNudge` fields): define `src/extensions/gauge/types.ts` carrying a `GaugeConfig` read from the extension's own `gate.json` block (`extensions.gauge` may be `true` or an object later — K4 finalizes; K2 stubs ONLY type definitions that the lab file demanded, no invented fields).
- [ ] **Step 4:** Run the file's test — expect PASS with zero assertion edits. **An assertion edit means the port changed behavior: stop, record why in the commit message, get lane-M review before proceeding.**
- [ ] **Step 5:** Repeat 1–4 for each of the six files in dependency order: `classifier` → `files` → `guard` → `evaluate` → `validate` → `nudge`.
- [ ] **Step 6:** `bun test && bun run typecheck` full-suite green (imports guard must accept the new files — they import only kernel ports + gauge siblings).
- [ ] **Step 7: Commit** `feat(gauge): port pure core from lab plugin (tests ported verbatim)`.

---

### Task K3: Transport port + portable provider (lane K)

**Files:**
- Create: `src/extensions/gauge/transport.ts` (NEW code — the port interface), `src/extensions/gauge/providers/cli-spawn.ts` (ported subset of lab `send-prompt.ts`/`spawn` path that shells out to the `claude` CLI), `src/extensions/gauge/channel.ts`, `src/extensions/gauge/channel-run.ts` (ported)
- Test: `test/gauge-transport.test.ts` (new), `test/gauge-channel.test.ts`, `test/gauge-channel-run.test.ts` (ported)

**Interfaces:**
- Consumes: K2 core.
- Produces:

```ts
// src/extensions/gauge/transport.ts
export interface GaugeTransport {
  /** One evaluation call. Resolves to the model's raw text, or undefined on
   *  any failure — a gauge that cannot call a model annotates offReason,
   *  never blocks and never throws. */
  call(prompt: string, timeoutMs: number): Promise<string | undefined>
}
export function cliSpawnTransport(): GaugeTransport   // the ONLY provider kkamak ships
```

**Hard boundary (from the zero-dep constraint):** lab `transport.ts` (`sdkCall`), `providers/anthropic-api.ts`, `providers/anthropic-cli-warm.ts`, `agent-transport.ts`, `acp-client-singleton.ts` are **NOT ported**. Any lab call-site reaching them is rewritten to take a `GaugeTransport` parameter. The lab providers plug back in at back-port time by implementing this interface lab-side.

- [ ] **Step 1:** Write `test/gauge-transport.test.ts` first: (a) `cliSpawnTransport().call` with a stubbed spawn (fake `claude` binary on PATH via a temp dir, pattern already used by lab `test/agent-cli-stub.ts` — port that stub) returns the stub's stdout; (b) timeout → resolves `undefined` (not a throw); (c) missing binary → resolves `undefined`. Run — FAIL.
- [ ] **Step 2:** Implement `transport.ts` + `providers/cli-spawn.ts` (extract the spawn-CLI path from lab `send-prompt.ts`, dropping its daemon branch). Run — PASS.
- [ ] **Step 3:** Port `channel.ts`/`channel-run.ts` with their tests per the K2 recipe (they consume the transport interface where the lab passed `sdkCall`; that substitution is per M2's table and IS an allowed signature change — record it in the commit message).
- [ ] **Step 4:** Full suite + typecheck green. Imports guard: `extensions/gauge/**` imports only node builtins, kernel ports, gauge siblings.
- [ ] **Step 5: Commit** `feat(gauge): transport port + CLI-spawn provider (daemon transports stay lab-side)`.

---

### Task K4: Shadow/spawn/state wiring — gauge registers, config-gated (lane K)

**Files:**
- Create: `src/extensions/gauge/shadow.ts`, `state-resolve.ts`, `corpus-store.ts`, `spawn.ts` (ported per K2 recipe), `src/extensions/gauge/index.ts` (NEW — the `Extension` implementation)
- Modify: `src/extensions/registry.ts` (register `gauge` in `EXTENSIONS`)
- Test: ported `test/gauge-shadow.test.ts`, `test/gauge-spawn.test.ts`, `test/state-resolve.test.ts` (lab name), `test/gauge-wiring.test.ts` — plus NEW registry-level wiring tests

**Interfaces:**
- Consumes: K1 `Extension` interface, K2 core, K3 transport.
- Produces: `EXTENSIONS.gauge: Extension` — `wrapHost` decorates `host.sensor` so every written `SensorLine` carries either a real `gauge` annotation or `{present:false, offReason}` (frozen-contract parity with lab `hook-cli.ts:362`); `afterDecision` holds the detached spawn (lab `maybeSpawnGauge`) and shadow evaluation at Stop.

- [ ] **Step 1:** Port `state-resolve.ts`, `corpus-store.ts`, `shadow.ts`, `spawn.ts` with their tests, per the K2 recipe (test first, no assertion edits, dependency order as listed).
- [ ] **Step 2:** Write NEW failing tests for `src/extensions/gauge/index.ts` in `test/gauge-wiring.test.ts` additions: (a) with `extensions.gauge` absent → registry returns identity host (already guaranteed by K1, re-asserted here THROUGH the gauge registration to prove registering ≠ enabling); (b) with `{"extensions":{"gauge":true}}` and a fake transport, a completed Stop cycle's sensor line carries a `gauge` field; (c) transport failure → line carries `gauge: {present:false, offReason: ...}` — **silence is the one thing the stream must never emit** (lab rule, `hook-cli.ts:340-344`); (d) `afterDecision` never rejects even when every dependency throws.
- [ ] **Step 3:** Implement `index.ts`, register in `EXTENSIONS`. Run — PASS.
- [ ] **Step 4:** Full suite + typecheck. **Commit** `feat(gauge): register gauge extension — config-gated, annotate-only`.

---

### Task K5: Off-by-default parity + guard-can-fail proofs (lane K)

**Files:**
- Test: `test/extensions-parity.test.ts` (new)
- Modify: none (a parity failure here is a bug in K1–K4, fixed there)

**Interfaces:**
- Consumes: everything K1–K4 shipped.
- Produces: the release evidence CHECKPOINT 2 reviews.

**Design rule (downstream-of-decision law):** the parity check must compare against an artifact the current change CANNOT influence — the expectations are pinned from `git show v0.7.0`-era behavior (the existing adapter test expectations, unedited since 0.7.0), not recomputed from the new code.

- [ ] **Step 1:** Write `test/extensions-parity.test.ts`: drive the full claude-code adapter path (same harness as `test/claude-code-adapter.test.ts`) twice over one fixture session — once with `gate.json` = `{"check": "..."}` (no extensions key), once with `{"check": "...", "extensions": {}}` — and assert stdout plans, exit codes, state records, and sensor lines are deep-equal to each other AND to the pinned 0.7.0 expectations.
- [ ] **Step 2: Build the input that should break it** (a check that cannot fail cannot inform): temporarily register a fake extension whose `wrapHost` tampers a sensor field, enable it in the fixture config, and assert the parity test's comparator DOES flag the difference; keep this as a permanent test case (`"the parity comparator catches a tampering extension"`).
- [ ] **Step 3:** Confirm dogfood evidence lane: run the suite with `{"extensions":{"gauge":true}}` + stubbed transport and verify a `.km/` gauge artifact appears in the fixture root (proof the gated path actually executes — an off-by-default feature that was never turned on is unproven, not proven-safe).
- [ ] **Step 4:** Full suite + typecheck. **Commit** `test(extensions): off-by-default parity pinned to 0.7.0 + tamper-detection proof`.

**CHECKPOINT 2 (lane M):** review the full K1–K5 diff, run `bun test` independently in `~/z2/kkamak`, verify the excluded-file list (no `cls-ab`, `paired-validation`, `corpus-mine`, `corpus-replay`, `replay-cli`, `refiner*`, `providers/anthropic-*`, `agent-transport`, `acp-client-singleton` anywhere under `~/z2/kkamak/src/`), report to user.

---

### Task M4: b3-continuity check (lane M — runs any time after K4, mandatory before K6)

**Files:**
- Modify: `docs/superpowers/specs/2026-08-21-instrument-inventory.md` (append a dated continuity section)

- [ ] **Step 1:** Verify the installed plugin is still the lab copy, untouched:

```bash
python3 - <<'EOF'
import json, pathlib
p = pathlib.Path.home() / ".claude/plugins/installed_plugins.json"
d = json.loads(p.read_text())
print(json.dumps({k: v for k, v in d.items() if "kkamak" in k.lower()}, indent=2))
EOF
```

Expected: `kkamak-local` sourced from `/home/th-yoo/z2/meta-harness/cc-gate-plugin`, version 0.4.x. Anything else = STOP, report.

- [ ] **Step 2:** Confirm gauge emissions continued during the migration window: `find ~/z2/kkamak/.km/gauge -name '*.done.json' -newer ~/z2/meta-harness/docs/superpowers/plans/2026-08-21-instruments-convergence-migration.md | wc -l` — a zero here is REPORTED with the session-activity context (zero emissions with zero gated sessions is expected; zero WITH activity is an incident), never silently passed.
- [ ] **Step 3:** Append findings + commit (exact-path staging).

---

### Task K6: Release packaging — version bump + changelog (lane K; **user go required first**)

**Files:**
- Modify: `.claude-plugin/plugin.json` (`"version": "0.8.0"`), `package.json` (`"version": "0.8.0"`), `CHANGELOG.md` (new 0.8.0 section), `README.md` (extensions block documented: one paragraph + the `{"extensions":{"gauge":true}}` example, explicitly marked experimental/off-by-default)

- [ ] **Step 1:** Wait for CHECKPOINT 3: lane M relays M4 + CHECKPOINT 2 evidence to the user and asks for the release go. **No go → plan ends here, committed but unpushed and unreleased.**
- [ ] **Step 2:** Bump both version fields + changelog + README in ONE commit (merge≠deploy rule: the bump travels with the last code change so any cache refresh picks up the whole feature or none of it). `test/packaging.test.ts` must pass — it is the guard that the two version fields agree.
- [ ] **Step 3:** Full suite + typecheck one last time; **Commit** `release: 0.8.0 — config-gated extension seam + gauge instrument (off by default)`.
- [ ] **Step 4:** Push only on the user's explicit push go, from whichever session the user designates.

---

## Self-review (performed at write time)

- **Coverage vs the ruling:** "migrate proven instruments INTO kkamak config-gated" → K1–K6 (gauge, gated, off-default); "experiments stay lab-side" → K3 hard boundary + CHECKPOINT 2 excluded-file sweep; "never retire the lab plugin" → global read-only constraint + M4; "back-port later, own go" → out of scope, stated in Global Constraints. Inventory generality (rubric fixed before application, evidence-pointer mandatory) → M1.
- **Placeholder scan:** no TBDs. The one deliberate deferral — exact `GaugeConfig` object shape beyond the boolean — is bounded in K2 Step 3/K4 ("no invented fields"; boolean `true` is the only enabling value this release).
- **Type consistency:** `parseEnabledExtensions`, `Extension`, `ActiveExtensions`, `loadActiveExtensions`, `EXTENSIONS`, `GaugeTransport`, `cliSpawnTransport` are each defined once (K1/K3) and consumed by name in K2/K4/K5. Lab symbol names preserved on ported files per K2 recipe.
- **DAG honesty:** the only true cross-lane data dependencies are M2's rewrite table → K2 Step 1 and M1's verdict → CHECKPOINT 1; both produced before K1 completes in practice, and both relayed inside dispatch messages so lane K never reads meta-harness files.
