# Generality-Tag Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inject a playbook bullet only for sessions whose model matches its generality tag — `universal`/untagged always, `vendor` iff providerID matches, `model` iff the full id matches — in both the runtime plugin and the bench harness, via one shared filter.

**Architecture:** One pure filter `renderPlaybookRouted(pb, model)` re-renders the already-tagged active playbook, keeping only bullets that match the run model. It is invoked from `composeHarness(layers, pins, model?)` — which re-renders from the playbook when a `model` is supplied and the layer has one, else falls back to today's flat `readActiveSystem`. Runtime (`engine.composeInjection`, session model) and bench (`assembleAgentsMd`, `--model`) both call `composeHarness` with the model, so they inject byte-identically for the same model (no drift by construction). No new store coordinates.

**Tech Stack:** TypeScript, Bun (`bun test`, `bun:test`). Spec: `docs/superpowers/specs/2026-07-16-generality-routing-design.md`.

## Global Constraints

- **Byte-identical back-compat.** With every bullet `universal`/untagged (today's state), routed render == `renderPlaybook` == the stored `system.md`. Injection is unchanged for any model until a bullet is actually tagged vendor/model.
- **One shared filter, no drift.** Runtime and bench both route through the single `renderPlaybookRouted` via `composeHarness(model?)`. Never write a second injection path.
- **`renderPlaybook` (harness-store.ts:826-828) stays UNCHANGED** — it remains the full/model-less render for stored `system.md`, no-op guards, and display. Routing is an injection-time view only.
- **Config routing, NOT detection.** This delivers the tag as configured; it does not validate that a tag is correct (the multi-model panel is deferred, spec §6).
- **No new store coordinates / roots / scope-union changes** — the tag lives on the bullet; routing is a render filter (spec §1 supersedes target-model-axis §4).
- **Graceful fallback:** `model` undefined, or a legacy layer with no `playbook.json` → `readActiveSystem` (today's behavior).
- **Tests run:** `bun test test/<file>.test.ts` from `opencode-plugin/`.

---

### Task 1: `renderPlaybookRouted` + `matchesModel` — the filter

**Files:**
- Modify: `opencode-plugin/src/harness-store.ts` (add two exports near `renderPlaybook`, ~`:826`)
- Test: `opencode-plugin/test/generality-routing.test.ts` (new)

**Interfaces:**
- Consumes: `Playbook`, `PlaybookBullet` (harness-store.ts:794-809), `parseModelSpec(model): {providerID, modelID} | undefined` (harness-store.ts:404).
- Produces:
  - `matchesModel(b: PlaybookBullet, model: string): boolean`
  - `renderPlaybookRouted(pb: Playbook, model: string): string`

- [ ] **Step 1: Write the failing test** — `test/generality-routing.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { renderPlaybookRouted, matchesModel, type Playbook } from "../src/harness-store.ts"

const pb = (bullets: Array<Partial<{ id: string; text: string; generality: string; slice: string; status: string }>>): Playbook =>
  ({ schemaVersion: 1, nextId: bullets.length + 1,
     bullets: bullets.map((b, i) => ({
       id: b.id ?? `b${i + 1}`, text: b.text ?? `t${i + 1}`, helpful: 0, harmful: 0,
       addedBy: "test", status: (b.status as any) ?? "active",
       createdAt: "t", updatedAt: "t",
       ...(b.generality ? { generality: b.generality as any } : {}),
       ...(b.slice ? { slice: b.slice } : {}),
     })) })

describe("matchesModel", () => {
  test("universal / untagged always match", () => {
    expect(matchesModel(pb([{ generality: "universal" }]).bullets[0], "anthropic/x")).toBe(true)
    expect(matchesModel(pb([{}]).bullets[0], "anthropic/x")).toBe(true)
  })
  test("vendor matches on providerID only", () => {
    const b = pb([{ generality: "vendor", slice: "anthropic" }]).bullets[0]
    expect(matchesModel(b, "anthropic/claude-haiku-4-5")).toBe(true)
    expect(matchesModel(b, "openai/gpt-5")).toBe(false)
  })
  test("model matches on full id or bare modelID", () => {
    const b = pb([{ generality: "model", slice: "anthropic/claude-haiku-4-5" }]).bullets[0]
    expect(matchesModel(b, "anthropic/claude-haiku-4-5")).toBe(true)
    expect(matchesModel(b, "anthropic/claude-opus-4-8")).toBe(false)
  })
  test("unparseable model → only universal", () => {
    expect(matchesModel(pb([{ generality: "vendor", slice: "anthropic" }]).bullets[0], "barename")).toBe(false)
    expect(matchesModel(pb([{ generality: "universal" }]).bullets[0], "barename")).toBe(true)
  })
})

describe("renderPlaybookRouted", () => {
  test("drops non-matching + pruned; keeps matching in order", () => {
    const p = pb([
      { text: "U", generality: "universal" },
      { text: "VA", generality: "vendor", slice: "anthropic" },
      { text: "VO", generality: "vendor", slice: "openai" },
      { text: "P", generality: "universal", status: "pruned" },
    ])
    expect(renderPlaybookRouted(p, "anthropic/claude-haiku-4-5")).toBe("- U\n- VA")
    expect(renderPlaybookRouted(p, "openai/gpt-5")).toBe("- U\n- VO")
  })
  test("all-universal render equals renderPlaybook (back-compat)", async () => {
    const { renderPlaybook } = await import("../src/harness-store.ts")
    const p = pb([{ text: "a" }, { text: "b", generality: "universal" }])
    expect(renderPlaybookRouted(p, "anthropic/x")).toBe(renderPlaybook(p))
  })
})
```

- [ ] **Step 2: Run test to verify it fails** — `bun test test/generality-routing.test.ts` → FAIL (`renderPlaybookRouted`/`matchesModel` not exported).

- [ ] **Step 3: Write minimal implementation** — in `harness-store.ts` just after `renderPlaybook` (~`:828`):

```ts
/** Injection-time filter: keep a bullet iff its generality tag matches `model`.
 * universal/untagged → always; vendor → providerID === slice; model → full
 * "provider/model" or bare modelID === slice. Unparseable model → only universal. */
export function matchesModel(b: PlaybookBullet, model: string): boolean {
  const g = b.generality
  if (g === undefined || g === "universal") return true
  const spec = parseModelSpec(model)
  if (!spec) return false
  if (g === "vendor") return spec.providerID === b.slice
  if (g === "model") return model === b.slice || spec.modelID === b.slice
  return true
}

/** Model-routed render — renderPlaybook restricted to matchesModel bullets.
 * renderPlaybook (the full, model-less view) is deliberately left unchanged. */
export function renderPlaybookRouted(pb: Playbook, model: string): string {
  return pb.bullets
    .filter((b) => b.status === "active" && matchesModel(b, model))
    .map((b) => `- ${b.text}`)
    .join("\n")
}
```

- [ ] **Step 4: Run test to verify it passes** — `bun test test/generality-routing.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(routing): renderPlaybookRouted + matchesModel — model-keyed playbook filter"`

---

### Task 2: `composeHarness(model?)` — re-render from playbook when a model is given

**Files:**
- Modify: `opencode-plugin/src/compose.ts` (import line `:25`; `composeHarness` `:51-58`)
- Test: `opencode-plugin/test/compose.test.ts` (append)

**Interfaces:**
- Consumes: `renderPlaybookRouted`, `readPlaybook(storeRoot, version?)` (harness-store.ts:818) — plus the existing `readActiveSystem`/`readCandidateSystem`/`readActiveTools`/`readCandidateTools`.
- Produces: `composeHarness(layers: LayerRef[], pins?: Record<string,string>, model?: string): ComposedLayer[]` (new optional 3rd param).

- [ ] **Step 1: Write the failing test** — append to `test/compose.test.ts` (mirror its temp-dir idiom; a layer store = a dir with `active/playbook.json` + `active/system.md`):

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { composeHarness } from "../src/compose.ts"

function layerWithPlaybook(bullets: Array<{ text: string; generality?: string; slice?: string }>): string {
  const root = mkdtempSync(join(tmpdir(), "mh-route-"))
  mkdirSync(join(root, "active"), { recursive: true })
  const pb = { schemaVersion: 1, nextId: bullets.length + 1,
    bullets: bullets.map((b, i) => ({ id: `b${i + 1}`, text: b.text, helpful: 0, harmful: 0,
      addedBy: "t", status: "active", createdAt: "t", updatedAt: "t",
      ...(b.generality ? { generality: b.generality } : {}), ...(b.slice ? { slice: b.slice } : {}) })) }
  writeFileSync(join(root, "active", "playbook.json"), JSON.stringify(pb))
  writeFileSync(join(root, "active", "system.md"), bullets.map((b) => `- ${b.text}`).join("\n") + "\n")
  return root
}

test("composeHarness with model routes; without model reads flat system.md", () => {
  const root = layerWithPlaybook([
    { text: "U" }, { text: "VA", generality: "vendor", slice: "anthropic" },
  ])
  const layers = [{ scope: "account-global", root }]
  // model given → routed (openai drops the anthropic bullet)
  expect(composeHarness(layers, {}, "openai/gpt-5")[0].system).toBe("- U")
  // anthropic → keeps both
  expect(composeHarness(layers, {}, "anthropic/claude-haiku-4-5")[0].system).toBe("- U\n- VA")
  // no model → flat stored system.md (today's behavior, all bullets)
  expect(composeHarness(layers, {})[0].system).toBe("- U\n- VA")
})

test("composeHarness legacy layer (no playbook.json) falls back to system.md even with a model", () => {
  const root = mkdtempSync(join(tmpdir(), "mh-route-legacy-"))
  mkdirSync(join(root, "active"), { recursive: true })
  writeFileSync(join(root, "active", "system.md"), "- legacy\n")
  expect(composeHarness([{ scope: "account-global", root }], {}, "anthropic/x")[0].system).toBe("- legacy")
})
```

- [ ] **Step 2: Run test to verify it fails** — `bun test test/compose.test.ts` → FAIL (model routing not implemented; the openai case returns both bullets).

- [ ] **Step 3: Write minimal implementation** — `compose.ts`:

Update the import at `:25`:
```ts
import { readActiveSystem, readActiveTools, readCandidateSystem, readCandidateTools, readPlaybook, renderPlaybookRouted } from "./harness-store.ts"
```
Replace `composeHarness` (`:51-58`):
```ts
export function composeHarness(
  layers: LayerRef[],
  pins: Record<string, string> = {},
  model?: string,
): ComposedLayer[] {
  return layers.map(({ scope, root }) => {
    const ver = pins[scope]
    const pb = model ? readPlaybook(root, ver) : null
    const system = model && pb
      ? renderPlaybookRouted(pb, model)
      : ver ? readCandidateSystem(root, ver) : readActiveSystem(root)
    const tools = ver ? readCandidateTools(root, ver) : readActiveTools(root)
    return { scope, root, system, tools }
  })
}
```

- [ ] **Step 4: Run test to verify it passes** — `bun test test/compose.test.ts` → PASS (existing compose tests still green — they pass no model, hit the flat branch).
- [ ] **Step 5: Commit** — `git commit -m "feat(routing): composeHarness(model?) re-renders playbook filtered by model"`

---

### Task 3: Runtime — thread the session model through `composeInjection`

**Files:**
- Modify: `opencode-plugin/src/engine.ts:343`
- Test: `opencode-plugin/test/engine.test.ts` (append — mirror its Engine/session setup)

**Interfaces:**
- Consumes: `composeHarness(..., model?)` (Task 2); the session state's `st.model` (`engine.ts:262`, set by `sessionMessage`).
- Produces: no new symbol — `composeInjection` now routes by `st.model`.

- [ ] **Step 1: Write the failing test** — append to `test/engine.test.ts`. Reuse the file's existing Engine + `META_HARNESS_HOME` setup; seed the account-global active playbook with a vendor bullet, set a session model, assert routing. (Match the exact Engine construction + `sessionMessage` signature already used in that file — do not invent a new harness.)

```ts
// generality routing: composeInjection filters by the session model
test("composeInjection injects a vendor bullet only for the matching provider", async () => {
  // ARRANGE: seed account-global active playbook with one universal + one vendor:anthropic bullet
  //   (write <accountGlobalRoot>/active/playbook.json via the same store helpers the other engine tests use)
  // ACT: engine.sessionMessage(sid, { role, isPrimary:true, participates:true, model:"anthropic/claude-haiku-4-5" })
  //      const anthropic = (await engine.composeInjection(sid)).join("\n")
  //      engine.sessionMessage(sid2, { ...same, model:"openai/gpt-5" })
  //      const openai = (await engine.composeInjection(sid2)).join("\n")
  // ASSERT:
  expect(anthropic).toContain("VENDOR_ANTHROPIC_BULLET_TEXT")
  expect(openai).not.toContain("VENDOR_ANTHROPIC_BULLET_TEXT")
  expect(openai).toContain("UNIVERSAL_BULLET_TEXT")
})
```
(The implementer fills the ARRANGE/ACT with this file's real store-seeding + Engine idiom; the three ASSERT lines are the contract.)

- [ ] **Step 2: Run test to verify it fails** — `bun test test/engine.test.ts` → FAIL (openai session still gets the anthropic bullet, because `composeInjection` passes no model).

- [ ] **Step 3: Write minimal implementation** — `engine.ts:343`, add `st.model` as the 3rd arg:

```ts
    const composed = composeHarness(layers.map((l) => ({ scope: l.scope, root: l.root })), {}, st.model)
```

- [ ] **Step 4: Run test to verify it passes** — `bun test test/engine.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(routing): composeInjection routes by the session model"`

---

### Task 4: Bench — thread `--model` through `assembleAgentsMd`

**Files:**
- Modify: `opencode-plugin/src/bench/record.ts:117-125`; `opencode-plugin/src/bench/cmd-ab.ts:229-230`; `opencode-plugin/src/bench/cmd-run.ts:401`
- Test: `opencode-plugin/test/bench-record.test.ts` (append)

**Interfaces:**
- Consumes: `composeHarness(..., model?)` (Task 2).
- Produces: `assembleAgentsMd(layers, metaRoot, agent?, pins?, model?): string` (new optional 5th param).

- [ ] **Step 1: Write the failing test** — append to `test/bench-record.test.ts` (mirror its `metaRoot`/`layerStoreRoots` seeding; write the account-global active `playbook.json` with a vendor bullet):

```ts
test("assembleAgentsMd routes by model: vendor bullet only for the matching provider", () => {
  const metaRoot = tmpDir()
  // seed account-global active playbook (universal "U" + vendor:anthropic "VA") + a system.md
  // using the same store roots layerStoreRoots("account", "", metaRoot) resolves — mirror the
  // existing "active project-global system+tools" test's write pattern, but write playbook.json too.
  const md = (model?: string) => assembleAgentsMd("account", metaRoot, "", {}, model)
  expect(md("anthropic/claude-haiku-4-5")).toContain("VA")
  expect(md("openai/gpt-5")).not.toContain("VA")
  expect(md("openai/gpt-5")).toContain("U")
  expect(md()).toContain("VA") // no model → flat, both present (back-compat)
})
```

- [ ] **Step 2: Run test to verify it fails** — `bun test test/bench-record.test.ts` → FAIL (model param not accepted / not routed).

- [ ] **Step 3: Write minimal implementation:**

`record.ts` `assembleAgentsMd` (`:117-125`):
```ts
export function assembleAgentsMd(
  layers: string,
  metaRoot: string,
  agent = "",
  pins: Record<string, string> = {},
  model?: string,
): string {
  const layerRefs: LayerRef[] = layerStoreRoots(layers, agent, metaRoot).map(([name, root]) => ({ scope: name, root }))
  return renderAgentsMd(composeHarness(layerRefs, pins, model), LAYER_LABELS, agent)
}
```
`cmd-ab.ts:229-230` — pass the resolved run model (`model` from `cmd-ab.ts:158`, `args.model || DEFAULT_BENCH_MODEL`) to BOTH arms so A and B route identically:
```ts
  const harnessA = assembleAgentsMd(layers, paths.metaRoot, agent, {}, model)
  const harnessB = assembleAgentsMd(layers, paths.metaRoot, agent, { [layer]: candidate }, model)
```
`cmd-run.ts:401` — pass the run's model (the same value used to invoke the driver in this function; add it as the 5th arg):
```ts
    harnessMd = assembleAgentsMd(layers, paths.metaRoot, agent, pins, model)
```

- [ ] **Step 4: Run test to verify it passes** — `bun test test/bench-record.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(routing): assembleAgentsMd routes by --model (both ab arms + run)"`

---

### Task 5: Parity + back-compat + full-suite green

**Files:**
- Test: `opencode-plugin/test/generality-routing.test.ts` (append the parity/back-compat integration checks)

**Interfaces:** Consumes Tasks 1-4. No new production code — this task is the cross-path guarantee + regression gate.

- [ ] **Step 1: Write the failing test** — append to `test/generality-routing.test.ts`. Build ONE seeded account-global store (universal + vendor:anthropic bullet). Assert bench and (a directly-composed) runtime view agree for the same model, and all-universal is byte-identical:

```ts
import { composeHarness, renderSystemBlocks } from "../src/compose.ts"
import { assembleAgentsMd } from "../src/bench/record.ts"

test("parity: composeHarness and the bench path route identically for the same model", () => {
  // seed the account-global layer store (root R) with universal "U" + vendor:anthropic "VA"
  // runtime-style: renderSystemBlocks(composeHarness([{scope,root:R}], {}, model))
  // bench-style:   assembleAgentsMd("account", metaRoot, "", {}, model)  (metaRoot whose account-global root == R)
  const model = "anthropic/claude-haiku-4-5"
  const runtime = renderSystemBlocks(composeHarness([{ scope: "account-global", root: R }], {}, model)).join("\n")
  // both must contain exactly the routed bullet set (U + VA), and neither the openai-only bullet
  expect(runtime).toContain("- U"); expect(runtime).toContain("- VA")
})

test("back-compat: all-universal store injects byte-identically to no-model for any model", () => {
  // seed a store with only universal bullets; composeHarness(..., model) === composeHarness(...) system text
  const withModel = composeHarness([{ scope: "account-global", root: RU }], {}, "openai/gpt-5")[0].system
  const noModel = composeHarness([{ scope: "account-global", root: RU }], {})[0].system
  expect(withModel).toBe(noModel)
})
```

- [ ] **Step 2: Run test to verify it fails first (before adding), then passes** — `bun test test/generality-routing.test.ts` → PASS after Tasks 1-4 (if red, fix the offending task).
- [ ] **Step 3: Full regression** — `bun test` → all green (existing `compose.test.ts`/`bench-record.test.ts`/`engine.test.ts` unchanged-behavior tests still pass, since they pass no model and hit the flat branch); `npx tsc --noEmit` → 0 errors.
- [ ] **Step 4: Live e2e (manual, per spec §7)** — run a real session on `anthropic/*` with a seeded `vendor:anthropic` bullet in account-global; confirm it appears; a session with no/other model does not get it. Confirm an all-universal store injects identically to pre-change.
- [ ] **Step 5: Commit** — `git commit -m "test(routing): runtime/bench parity + all-universal byte-identity + full-suite green"`

---

## Notes / scope boundaries

- **`tools.md` is NOT tag-routed** (spec §6) — only playbook `system.md` bullets route. `composeHarness` leaves `tools` on the flat read.
- **Stored `system.md` stays the full render** (`createCandidate` → `renderPlaybook`); the routed view is injection-time only. No-op guards (propose.ts:314 / curate :1079) compare the full render and are UNCHANGED.
- **The multi-model panel / tag validation is deferred** (spec §6) — this plan delivers the claim, it does not prove it.
- **Every task traces to the spec:** T1→§1; T2→§2/§5; T3→§3; T4→§4; T5→§7 (parity + back-compat) + §5.
