# Generality-Tag Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inject a playbook bullet only for sessions whose model matches its generality tag — `universal`/untagged always, `vendor` iff providerID matches, `model` iff the full id matches — in the runtime plugin, the bench harness, AND the fleet persona renderer, via one shared filter.

**Architecture:** One pure filter `renderPlaybookRouted(pb, model)` re-renders the active playbook, keeping only bullets that match the run model. It is invoked from `composeHarness(layers, pins, model?)`, which re-renders from the playbook **only when the playbook is a faithful render of the stored `system.md`** (`renderPlaybook(pb).trim() === flat.trim()`) and a `model` is supplied — otherwise it returns the flat `readActiveSystem`/`readCandidateSystem` text unchanged. All FOUR injection entry points (runtime `engine.composeInjection`, bench `cmd-ab`/`cmd-run`, fleet `render.renderRole`) pass the model, so they route through the single filter identically. No new store coordinates.

**Tech Stack:** TypeScript, Bun (`bun test`, `bun:test`). Spec: `docs/superpowers/specs/2026-07-16-generality-routing-design.md`.

## Global Constraints

- **Byte-identical back-compat, by construction.** `composeHarness` re-renders ONLY when `renderPlaybook(pb).trim() === flat.trim()`. So a routed render can differ from the flat read only by *dropping tagged bullets* (the intended filtering); an all-universal faithful store keeps every bullet → identical; a store whose playbook ≠ its `system.md` (e.g. `seedPlaybook`'s non-format-preserving migration of a header-containing prompt, `harness-store.ts:834-846`/`908-915`) falls back to the flat read → identical. Injection is unchanged for any model until a bullet is actually tagged vendor/model in a faithful store.
- **One shared filter, no drift.** All four entry points route through the single `renderPlaybookRouted` via `composeHarness(model?)`. Never write a second injection path.
- **`renderPlaybook` (harness-store.ts:828-830) stays UNCHANGED** — the full/model-less render for stored `system.md`, no-op guards, display. Routing is injection-time only.
- **`seedPlaybook`/`migrateSystemToPlaybook` are NOT modified** — the `composeHarness` consistency guard absorbs their non-format-preserving output safely.
- **Config routing, NOT detection.** Delivers the tag as configured; does not validate it (multi-model panel deferred, spec §6).
- **No new store coordinates / roots / scope-union changes.**
- **Test hermeticity (MANDATORY).** `account-global`/`account-role` roots resolve via `accountGlobalRoot()` which IGNORES any `metaRoot` arg and reads `META_HARNESS_HOME` → `$XDG_CONFIG_HOME` → the real default. Any test seeding an account layer MUST redirect `META_HARNESS_HOME` (save/restore, per `test/fleet-render.test.ts:19,26`) or it corrupts the developer's live store. Bench-side routing is tested on `project-global` (which IS `metaRoot`-scoped) to stay hermetic without env juggling.
- **Tests run:** `bun test test/<file>.test.ts` from `opencode-plugin/`.

---

### Task 1: `renderPlaybookRouted` + `matchesModel` — the filter

**Files:**
- Modify: `opencode-plugin/src/harness-store.ts` (add two exports just after `renderPlaybook`, ~`:830`)
- Test: `opencode-plugin/test/generality-routing.test.ts` (new)

**Interfaces:**
- Consumes: `Playbook`, `PlaybookBullet` (harness-store.ts:794-811), `parseModelSpec(model): {providerID, modelID} | undefined` (harness-store.ts:404-408).
- Produces:
  - `matchesModel(b: PlaybookBullet, model: string): boolean`
  - `renderPlaybookRouted(pb: Playbook, model: string): string`

- [ ] **Step 1: Write the failing test** — `test/generality-routing.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { renderPlaybookRouted, matchesModel, renderPlaybook, type Playbook } from "../src/harness-store.ts"

const pb = (bs: Array<Partial<{ id: string; text: string; generality: string; slice: string; status: string }>>): Playbook =>
  ({ schemaVersion: 1, nextId: bs.length + 1,
     bullets: bs.map((b, i) => ({
       id: b.id ?? `b${i + 1}`, text: b.text ?? `t${i + 1}`, helpful: 0, harmful: 0,
       addedBy: "test", status: (b.status as any) ?? "active", createdAt: "t", updatedAt: "t",
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
  test("model matches on full id AND on bare modelID tolerance", () => {
    expect(matchesModel(pb([{ generality: "model", slice: "anthropic/claude-haiku-4-5" }]).bullets[0], "anthropic/claude-haiku-4-5")).toBe(true)
    expect(matchesModel(pb([{ generality: "model", slice: "anthropic/claude-haiku-4-5" }]).bullets[0], "anthropic/claude-opus-4-8")).toBe(false)
    // bare-modelID tolerance branch (slice has no provider prefix):
    expect(matchesModel(pb([{ generality: "model", slice: "claude-haiku-4-5" }]).bullets[0], "anthropic/claude-haiku-4-5")).toBe(true)
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
      { text: "PR", generality: "universal", status: "pruned" },
    ])
    expect(renderPlaybookRouted(p, "anthropic/claude-haiku-4-5")).toBe("- U\n- VA")
    expect(renderPlaybookRouted(p, "openai/gpt-5")).toBe("- U\n- VO")
  })
  test("all-universal render equals renderPlaybook (filter is identity)", () => {
    const p = pb([{ text: "a" }, { text: "b", generality: "universal" }])
    expect(renderPlaybookRouted(p, "anthropic/x")).toBe(renderPlaybook(p))
  })
})
```

- [ ] **Step 2: Run test to verify it fails** — `bun test test/generality-routing.test.ts` → FAIL (`renderPlaybookRouted`/`matchesModel` not exported).
- [ ] **Step 3: Write minimal implementation** — in `harness-store.ts` just after `renderPlaybook` (~`:830`):

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

/** renderPlaybook restricted to matchesModel bullets. renderPlaybook itself
 * (the full, model-less view for stored system.md + no-op guards) is UNCHANGED. */
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

### Task 2: `composeHarness(model?)` — faithful-render guard + route (fixes the back-compat break)

**Files:**
- Modify: `opencode-plugin/src/compose.ts` (import `:25`; `composeHarness` `:51-58`)
- Test: `opencode-plugin/test/compose.test.ts` (append)

**Interfaces:**
- Consumes: `renderPlaybookRouted`, `renderPlaybook`, `readPlaybook(storeRoot, version?)` (harness-store.ts:818) + the existing `readActiveSystem`/`readCandidateSystem`/`readActiveTools`/`readCandidateTools`.
- Produces: `composeHarness(layers: LayerRef[], pins?: Record<string,string>, model?: string): ComposedLayer[]` (new optional 3rd param).

**Why the guard:** re-rendering from `playbook.json` must NOT change injection for a store whose `system.md` isn't already the playbook's render (e.g. `seedPlaybook` migrates `DEFAULT_SYSTEM_PROMPT`'s non-bulleted header into a bullet, so `renderPlaybook(pb) !== system.md`). Routing therefore fires only when `renderPlaybook(pb).trim() === flat.trim()`; otherwise it uses the flat read unchanged.

- [ ] **Step 1: Write the failing test** — append to `test/compose.test.ts` (mirror its temp-dir idiom; a layer store = a dir with `active/playbook.json` + `active/system.md`):

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { composeHarness } from "../src/compose.ts"

// helper: seed a layer store; `faithful` writes system.md == renderPlaybook(bullets),
// else writes a deliberately-divergent system.md (simulating seedPlaybook's header case).
function seedLayer(bs: Array<{ text: string; generality?: string; slice?: string }>, faithful = true): string {
  const root = mkdtempSync(join(tmpdir(), "mh-route-"))
  mkdirSync(join(root, "active"), { recursive: true })
  const pb = { schemaVersion: 1, nextId: bs.length + 1,
    bullets: bs.map((b, i) => ({ id: `b${i + 1}`, text: b.text, helpful: 0, harmful: 0,
      addedBy: "t", status: "active", createdAt: "t", updatedAt: "t",
      ...(b.generality ? { generality: b.generality } : {}), ...(b.slice ? { slice: b.slice } : {}) })) }
  writeFileSync(join(root, "active", "playbook.json"), JSON.stringify(pb))
  writeFileSync(join(root, "active", "system.md"),
    faithful ? bs.map((b) => `- ${b.text}`).join("\n") + "\n" : "You are an assistant.\n- keep going\n")
  return root
}

test("composeHarness routes a faithful playbook by model; no model → flat", () => {
  const root = seedLayer([{ text: "U" }, { text: "VA", generality: "vendor", slice: "anthropic" }])
  const L = [{ scope: "account-global", root }]
  expect(composeHarness(L, {}, "openai/gpt-5")[0].system).toBe("- U")               // routed: anthropic bullet dropped
  expect(composeHarness(L, {}, "anthropic/claude-haiku-4-5")[0].system).toBe("- U\n- VA")
  expect(composeHarness(L, {})[0].system).toBe("- U\n- VA")                          // no model → flat
})

test("composeHarness does NOT route when playbook render != system.md (back-compat guard)", () => {
  const root = seedLayer([{ text: "keep going", generality: "vendor", slice: "openai" }], /*faithful*/ false)
  // system.md ("You are an assistant.\n- keep going") != renderPlaybook → guard fails → flat read, even with a model
  expect(composeHarness([{ scope: "account-global", root }], {}, "anthropic/x")[0].system)
    .toBe("You are an assistant.\n- keep going")
})

test("composeHarness legacy layer (no playbook.json) falls back to flat", () => {
  const root = mkdtempSync(join(tmpdir(), "mh-route-legacy-"))
  mkdirSync(join(root, "active"), { recursive: true })
  writeFileSync(join(root, "active", "system.md"), "- legacy\n")
  expect(composeHarness([{ scope: "account-global", root }], {}, "anthropic/x")[0].system).toBe("- legacy")
})
```

- [ ] **Step 2: Run test to verify it fails** — `bun test test/compose.test.ts` → FAIL (routing + guard not implemented).
- [ ] **Step 3: Write minimal implementation** — `compose.ts`:

Update the import at `:25`:
```ts
import { readActiveSystem, readActiveTools, readCandidateSystem, readCandidateTools, readPlaybook, renderPlaybook, renderPlaybookRouted } from "./harness-store.ts"
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
    const flat = ver ? readCandidateSystem(root, ver) : readActiveSystem(root)
    const pb = model ? readPlaybook(root, ver) : null
    // Route ONLY when the playbook faithfully renders the stored system.md, so a
    // routed render can differ from `flat` only by dropping tag-mismatched bullets.
    const system = pb && renderPlaybook(pb).trim() === flat.trim()
      ? renderPlaybookRouted(pb, model!)
      : flat
    const tools = ver ? readCandidateTools(root, ver) : readActiveTools(root)
    return { scope, root, system, tools }
  })
}
```

- [ ] **Step 4: Run test to verify it passes** — `bun test test/compose.test.ts` → PASS (existing compose tests still green — no `model` → `pb` null → flat).
- [ ] **Step 5: Commit** — `git commit -m "feat(routing): composeHarness(model?) routes a faithful playbook; guards back-compat"`

---

### Task 3: Runtime — thread the session model through `composeInjection`

**Files:**
- Modify: `opencode-plugin/src/engine.ts:343`
- Test: `opencode-plugin/test/engine.test.ts` (append — this file already redirects `XDG_CONFIG_HOME` in `beforeAll`, so account-scoped writes are hermetic)

**Interfaces:**
- Consumes: `composeHarness(..., model?)` (Task 2); `st.model` (`engine.ts:262`, format `"provider/model"`, set by `sessionMessage`, `undefined` until the first `chat.message`).
- Produces: no new symbol — `composeInjection` routes by `st.model`.

- [ ] **Step 1: Write the failing test** — append to `test/engine.test.ts`. The new test MUST fully SELF-SEED its own account-global active playbook+system (do not rely on leftover `.version`/candidate state from earlier tests in this file). Use the file's existing Engine construction + store-write helpers + `sessionMessage` signature (mirror an existing test in this file that sets a session model). Seed a FAITHFUL account-global store: one universal bullet `U` + one `vendor:anthropic` bullet `VA`, with `active/system.md === renderPlaybook(pb)`:

```ts
test("composeInjection injects a vendor bullet only for the matching provider", async () => {
  // ARRANGE (mirror this file's helpers): write accountGlobalRoot()/active/{playbook.json, system.md}
  //   playbook = [ {text:"U"}, {text:"VA", generality:"vendor", slice:"anthropic"} ]
  //   system.md = "- U\n- VA\n"   (faithful — must equal renderPlaybook)
  // ACT:
  //   engine.sessionMessage(s1, { role:<primary role>, isPrimary:true, participates:true, model:"anthropic/claude-haiku-4-5" })
  //   const anthropic = (await engine.composeInjection(s1)).join("\n")
  //   engine.sessionMessage(s2, { ...same, model:"openai/gpt-5" })
  //   const openai = (await engine.composeInjection(s2)).join("\n")
  // ASSERT (the contract):
  expect(anthropic).toContain("- VA")
  expect(openai).not.toContain("- VA")
  expect(openai).toContain("- U")
})
```

- [ ] **Step 2: Run test to verify it fails** — `bun test test/engine.test.ts` → FAIL (openai session still gets `- VA` — `composeInjection` passes no model).
- [ ] **Step 3: Write minimal implementation** — `engine.ts:343`, add `st.model` as the 3rd arg:

```ts
    const composed = composeHarness(layers.map((l) => ({ scope: l.scope, root: l.root })), {}, st.model)
```

- [ ] **Step 4: Run test to verify it passes** — `bun test test/engine.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(routing): composeInjection routes by the session model"`

---

### Task 4: Bench + Fleet — thread the model through `assembleAgentsMd` and `renderRole`

**Files:**
- Modify: `opencode-plugin/src/bench/record.ts:117-125`; `opencode-plugin/src/bench/cmd-ab.ts:229-230`; `opencode-plugin/src/bench/cmd-run.ts:401`; `opencode-plugin/src/fleet/render.ts:95`
- Test: `opencode-plugin/test/bench-record.test.ts` (append — **project-global only**, hermetic via `metaRoot`); `opencode-plugin/test/fleet-render.test.ts` (append — already save/restores `META_HARNESS_HOME`)

**Interfaces:**
- Consumes: `composeHarness(..., model?)` (Task 2); `roleSpec(role).model` (`fleet/roles.ts:30-57`, a fixed `"provider/model"` per role) available as `s.model` at `render.ts:95`.
- Produces: `assembleAgentsMd(layers, metaRoot, agent?, pins?, model?): string` (new optional 5th param).

- [ ] **Step 1: Write the failing tests:**

Append to `test/bench-record.test.ts` (use **project-global** — `metaRoot`-scoped, NO real-store write; mirror the existing "active project-global system+tools" test's write pattern, adding a faithful `playbook.json`):
```ts
test("assembleAgentsMd routes project-global by model", () => {
  const metaRoot = tmpDir()
  // seed project-global active: playbook [ {text:"U"}, {text:"VA", generality:"vendor", slice:"anthropic"} ]
  //   + system.md "- U\n- VA\n" (faithful) — write under layerStoreRoots("project", "", metaRoot)'s project-global root.
  const md = (model?: string) => assembleAgentsMd("project", metaRoot, "", {}, model)
  expect(md("anthropic/claude-haiku-4-5")).toContain("- VA")
  expect(md("openai/gpt-5")).not.toContain("- VA")
  expect(md("openai/gpt-5")).toContain("- U")
  expect(md()).toContain("- VA") // no model → flat (back-compat)
})
```

Append to `test/fleet-render.test.ts` (this file already redirects `META_HARNESS_HOME`; `renderRole` writes `<project>/.opencode/agents/mh-<role>.md`):
```ts
test("renderRole routes the persona by the role's fixed model", () => {
  // seed the global (account) layer active playbook with a vendor:anthropic bullet "VA" + universal "U"
  // (faithful system.md). renderRole for a role whose roleSpec.model is anthropic/* should include VA;
  // a role pinned to a non-anthropic model should not. Assert on the written mh-<role>.md body.
  expect(anthropicRoleBody).toContain("- VA")
  expect(nonAnthropicRoleBody).not.toContain("- VA")
})
```

- [ ] **Step 2: Run tests to verify they fail** — both FAIL (model not accepted / not routed).
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
`cmd-ab.ts:229-230` — pass the resolved `model` (`cmd-ab.ts:158`) to BOTH arms:
```ts
  const harnessA = assembleAgentsMd(layers, paths.metaRoot, agent, {}, model)
  const harnessB = assembleAgentsMd(layers, paths.metaRoot, agent, { [layer]: candidate }, model)
```
`cmd-run.ts:401` — pass the in-scope `model` (`cmd-run.ts:370`):
```ts
    harnessMd = assembleAgentsMd(layers, paths.metaRoot, agent, pins, model)
```
`fleet/render.ts:95` — pass the role's fixed model `s.model`:
```ts
  const body = assembleAgentsMd("global", project, s.agent, pins, s.model)
```

- [ ] **Step 4: Run tests to verify they pass** — `bun test test/bench-record.test.ts` and `bun test test/fleet-render.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(routing): route bench (ab/run) + fleet persona render by model — all 4 entry points"`

---

### Task 5: Parity + back-compat + full-suite gate

**Files:**
- Test: `opencode-plugin/test/generality-routing.test.ts` (append)

**Interfaces:** Consumes Tasks 1-4. No new production code — cross-path guarantee + regression gate.

- [ ] **Step 1: Write the test** — append to `test/generality-routing.test.ts`. Build ONE faithful account-global store via `META_HARNESS_HOME` redirect (save/restore, per `fleet-render.test.ts:19,26`), so the SAME store backs both the runtime compose and the bench path — proving they agree:

```ts
import { composeHarness, renderSystemBlocks } from "../src/compose.ts"
import { assembleAgentsMd } from "../src/bench/record.ts"
import { accountGlobalRoot } from "../src/harness-store.ts"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

test("parity + back-compat: runtime compose and bench path agree; all-universal is byte-identical", () => {
  const prev = process.env.META_HARNESS_HOME
  const home = mkdtempSync(join(tmpdir(), "mh-parity-"))
  process.env.META_HARNESS_HOME = home
  try {
    const root = accountGlobalRoot()            // now resolves under `home`
    mkdirSync(join(root, "active"), { recursive: true })
    const pb = { schemaVersion: 1, nextId: 3, bullets: [
      { id:"b1", text:"U", helpful:0, harmful:0, addedBy:"t", status:"active", createdAt:"t", updatedAt:"t" },
      { id:"b2", text:"VA", generality:"vendor", slice:"anthropic", helpful:0, harmful:0, addedBy:"t", status:"active", createdAt:"t", updatedAt:"t" } ] }
    writeFileSync(join(root, "active", "playbook.json"), JSON.stringify(pb))
    writeFileSync(join(root, "active", "system.md"), "- U\n- VA\n")

    const model = "anthropic/claude-haiku-4-5"
    const runtime = renderSystemBlocks(composeHarness([{ scope: "account-global", root }], {}, model)).join("\n")
    const bench = assembleAgentsMd("account", "", "", {}, model)   // account root == `root` via env
    expect(runtime).toContain("- VA"); expect(runtime).toContain("- U")
    expect(bench).toContain("- VA"); expect(bench).toContain("- U")

    // back-compat: strip the tag → all-universal → routed == flat for ANY model
    writeFileSync(join(root, "active", "playbook.json"), JSON.stringify({ ...pb, bullets: pb.bullets.map((b) => ({ ...b, generality: undefined, slice: undefined })) }))
    expect(composeHarness([{ scope: "account-global", root }], {}, "openai/gpt-5")[0].system)
      .toBe(composeHarness([{ scope: "account-global", root }], {})[0].system)
  } finally {
    if (prev === undefined) delete process.env.META_HARNESS_HOME; else process.env.META_HARNESS_HOME = prev
  }
})
```

- [ ] **Step 2: Run it** — `bun test test/generality-routing.test.ts` → PASS.
- [ ] **Step 3: Full regression** — `bun test` → all green (existing `compose`/`bench-record`/`engine`/`fleet-render` tests unchanged-behavior, since they pass no model → flat branch); `npx tsc --noEmit` → 0 errors.
- [ ] **Step 4: Live e2e (manual, spec §7)** — a real session on `anthropic/*` with a seeded faithful `vendor:anthropic` bullet in account-global gets it; a session with no/other model does not; an all-universal store injects identically to pre-change.
- [ ] **Step 5: Commit** — `git commit -m "test(routing): runtime/bench parity + all-universal byte-identity + full-suite green"`

---

## Notes / scope boundaries

- **`tools.md` is NOT tag-routed** (spec §6) — only playbook `system.md` bullets route; `composeHarness` leaves `tools` on the flat read.
- **Stored `system.md` stays the full render** (`createCandidate` → `renderPlaybook`); the routed view is injection-time only. No-op guards (propose.ts:314 / curate :1079) compare the full render — UNCHANGED.
- **The consistency guard (Task 2) is what makes back-compat true** even though `seedPlaybook`/`migrateSystemToPlaybook` are non-format-preserving; do NOT drop it.
- **The multi-model panel / tag validation is deferred** (spec §6) — this delivers the claim, it does not prove it.
- **Every task traces to the spec + review:** T1→§1 (+ bare-modelID test, review Imp-1); T2→§2/§5 (+ faithful-render guard, review Crit-1); T3→§3 (self-seed, review Imp-2); T4→§4 + `fleet/render.ts` (review Crit-3); T5→§7 parity via `META_HARNESS_HOME` redirect (review Crit-2) + §5 back-compat.
