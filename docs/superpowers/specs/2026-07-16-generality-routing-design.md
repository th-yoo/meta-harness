# Generality-tag routing — model-keyed injection filter (runtime + bench)

> **Status: approved design (2026-07-16).** Builds directly on the shipped
> per-bullet generality CLAIM tag (`target-model-axis.md §7.0`; commit
> `ecc6874`). This spec is the **routing/act-on-the-tag** step, RUNTIME +
> BENCH. It **supersedes `target-model-axis.md §4`'s separate-store-coordinate
> approach** for delivery: no new store coordinates, no `accountVendorRoot`, no
> scope-union widening, no seeding. The multi-model **panel/detection** (§6)
> and any content **validation** remain deferred — this is *configuration
> routing*, not detection.

## 0. Context — why this, why now

We shipped the generality tag: every playbook bullet may carry
`generality ∈ {universal|vendor|model}` + `slice` (the vendor/model id). Today
the tag is **inert** — injection is byte-identical regardless of the run model.

This spec makes the store **act on the tag**: a bullet tagged `vendor:anthropic`
is injected **only** for a session running an Anthropic model; `model:X` only
for model X; `universal` (or untagged) always. The run model is a **known
config value** already in hand (runtime: the session's captured model; bench:
`--model`) — so this is *routing/selection by configuration*, not detection.

**Key realization (why it's small):** the generality already lives **on the
bullet** inside the existing scope layers (account-global, …). There is no
separate empty `vendor:anthropic/` dir to build or seed. Routing is a
**render-time filter of the already-tagged playbook against the run model** —
one shared function, called identically by runtime and bench, so they inject
**byte-identically for the same model** (no drift by construction).

## 1. The filter — `renderPlaybookRouted(pb, model)`

New pure function in `harness-store.ts`, a routing variant of `renderPlaybook`
(`:826-828`, which stays UNCHANGED for full/model-less renders):

```
renderPlaybookRouted(pb: Playbook, model: string): string
  = pb.bullets
      .filter(b => b.status === "active" && matchesModel(b, model))
      .map(b => `- ${b.text}`)
      .join("\n")
```

`matchesModel(b, model)` — with `{providerID, modelID} = parseModelSpec(model)`:
- `b.generality` is `undefined` or `"universal"` → **always keep**
- `b.generality === "vendor"` → keep iff `providerID === b.slice`
- `b.generality === "model"` → keep iff `model === b.slice` (the full
  `"provider/model"` string; also accept `modelID === b.slice` as a tolerance)
- unparseable `model` (no `/`) → keep only universal (degrade safe)

Additive-only (doc §3.2): the filter only **includes/excludes**; it never
overrides or masks. The budget (§5) is naturally "the resolved set" — exactly
the bullets that pass for this model.

## 2. The injection seam — `composeHarness(layers, pins, model?)`

`composeHarness` (`compose.ts:51-58`) currently reads each layer's **flat
stored `system.md`** (`readActiveSystem`/`readCandidateSystem`) — which carries
no tags. Add an optional `model?: string`:

- **`model` provided AND the layer has a playbook** (`readPlaybook(root)` for
  active, `readPlaybook(root, ver)` for a pinned candidate) →
  `system = renderPlaybookRouted(thatPlaybook, model)`.
- **else** (no `model`, or a legacy layer with no `playbook.json`) →
  `system = readActiveSystem(root)` / `readCandidateSystem(root, ver)` — i.e.
  **today's exact behavior**.

`tools` is unchanged (tools.md is not yet tag-routed — out of scope; note it).
`renderSystemBlocks` / `renderAgentsMd` (`compose.ts:69-103`) are UNCHANGED —
they consume the already-composed `ComposedLayer.system`.

## 3. Runtime path

`engine.ts composeInjection(sessionId)` (`:337-342`) already holds the session
state `st`, whose `st.model` (`"provider/model"`) is captured live at
`chat.message` (`index.ts:125` → `engine.ts:262`). Thread it: the `layersFor`
→ `composeHarness` chain passes `st.model` as the new `model` arg. Nothing else
in the live hook (`index.ts:137-153`) changes.

## 4. Bench path (parity is mandatory)

`bench/record.ts assembleAgentsMd` (`:117-125`) and its `composeHarness` call
must pass the bench `--model` (already resolved at `cmd-ab.ts:158` /
`cmd-run.ts`) as the same `model` arg. Because runtime and bench both route
through the **one** `renderPlaybookRouted`, a candidate is evaluated with
**exactly** the prompt a real session on that model will get. Parity is
structural, and assert-able in a test (same model → identical render).

## 5. Back-compat & edge cases

- **All-universal (today's state) → byte-identical.** `renderPlaybookRouted`
  with every bullet universal/absent == `renderPlaybook`, and the stored
  `system.md` was itself written as `renderPlaybook(playbook)` — so the
  re-render matches the old flat read exactly. Injection is unchanged until a
  bullet is actually tagged vendor/model.
- **Legacy layers (no `playbook.json`)** → fall through to `readActiveSystem`
  (no re-render) — byte-identical.
- **`model` undefined** (first turn before `chat.message`, or a message with no
  model) → fall through to `readActiveSystem` = today. Graceful; a later turn
  routes once `st.model` is set.
- **Stored `system.md` vs injected prompt.** The candidate's stored `system.md`
  stays the FULL render (`createCandidate` → `renderPlaybook`, all bullets) —
  an artifact for display / no-op guards / comparison. The **injected** prompt
  is the model-routed re-render. Both derive from the one authoritative
  playbook (`harness-store.ts:790`), so no invariant break; the no-op guards
  (which compare the full render) are UNCHANGED.

## 6. Explicitly NOT in scope

- **Detection / the multi-model panel (§6).** Nothing here validates that a
  `vendor:X` bullet actually helps X. Routing delivers the *claim* as
  configured; proving it right is the deferred panel.
- **Separate store coordinates / `accountVendorRoot` / scope-union widening
  (§4).** Replaced by the on-bullet tag + render filter. If a future need
  arises to store vendor content in its OWN layer (e.g. cross-scope reuse),
  that reopens §4 — with evidence.
- **Tag-routing `tools.md`.** Only `system.md`/playbook bullets route for now.
- **Content seeding.** Populating vendor/model tags is the proposer's job (a
  new propose emits them) or a separate hand-seed task.

## 7. Testing

- **Unit `renderPlaybookRouted`:** universal always kept; `vendor` kept iff
  providerID matches, dropped otherwise; `model` kept iff full-id matches;
  unparseable model → universal-only; all-universal render == `renderPlaybook`.
- **`composeHarness(model)`:** playbook-layer re-renders routed; legacy layer
  and `model===undefined` fall back to `readActiveSystem` (byte-identical).
- **Parity:** runtime `composeInjection` and bench `assembleAgentsMd` on the
  SAME model produce identical system blocks (assert-equal).
- **Back-compat:** with a playbook of only universal bullets, injection is
  byte-identical to pre-change for any model.
- **Live e2e:** a session on `anthropic/*` injects a `vendor:anthropic` bullet;
  the same store on `openai/*` (or model undefined) does not.

## 8. Acceptance self-check

- **Where does routing live?** → one shared `renderPlaybookRouted`, invoked via
  `composeHarness(model?)` by BOTH runtime (`composeInjection`, `st.model`) and
  bench (`assembleAgentsMd`, `--model`). No drift by construction (§2, §4).
- **New store coordinates?** → NO — on-bullet tag + render filter; §4's
  separate-dir approach is superseded (§1, §6).
- **Back-compat?** → byte-identical while all-universal / legacy / model-unknown
  (§5); `renderPlaybook` + no-op guards + stored `system.md` unchanged.
- **Does it validate the tags?** → NO — config routing only; the panel is
  deferred (§6).
