# T3 — DAG Artifact + Designer Emit (N4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the planner Designer a concrete **task-DAG artifact** to emit — a typed schema `{id, task, deps[], files?}` (+ the optional `mutatesDeps?` the T4 scheduler enforces), a **total validator** (cycle / dangling-dep / dup-id / shape rejection; files-overlap awareness), and a **wire-contract** so the Designer emits the DAG as a structured block, the block is parsed back out of the role output, and the **existing root-human gate2 approves it** before any node runs. This is spec piece **N4** from `docs/superpowers/specs/2026-07-16-fleet-selfhosting-dev-design.md`. The artifact this plan defines is exactly what the **T4 scheduler** (`docs/superpowers/plans/2026-07-16-t4-fleet-dev-scheduler.md`) `runDag`/`dag-state.ts` ingests.

**Architecture:** A new **leaf module** `fleet/dag.ts` owns the artifact: the `DagNode`/`TaskDag` types (the canonical source T4's `dag-state.ts` imports on integration), `validateDag`/`assertValidDag` (the single total validation gate the scheduler calls), and the wire codec `formatDagBlock`/`parseDagFromPayload`/`dagFromApprovedPayload` (the fenced ` ```dag ` block ↔ `TaskDag`). The **wire-contract** is delivered two ways: a new `PLANNER_SQUAD` squad-def (type `"planner"`) whose Designer wire heading is `[["## Task DAG"]]`, and a **guarded** append in the shipped `renderWireContract` (squad-def.ts) that teaches the exact block format only when a def's Designer wire declares `## Task DAG` (STANDARD stays byte-identical). **Gate2 is pure reuse:** the planner squad runs `gatePolicy:"auto"` so gate1 auto-approves and the def's `gate2:"human"` pauses on the Designer's DAG payload; the human answers via the shipped `--resume --gate-answer approve|revise` (`answerGate`, `squad.ts:304-322`) — no new gate primitive. `dag.ts` is a leaf (imports only `bench/util.ts` `die`/`log`), so nothing here couples to the scheduler; T4 depends on `dag.ts`, never the reverse.

**Tech Stack:** TypeScript, Bun (`bun test`), `bun:test`. Hermetic tests: `META_HARNESS_HOME` per-test, the shipped `scripted` injected-`DriveFn` seam (`test/fleet-helpers.ts`) and the `trace()` NDJSON `execFn` seam (`test/fleet-squad-run-model.test.ts`) — no real `opencode` spawn, **no real git** (T3 is pure artifact/wire logic; the scheduler owns worktrees).

## Global Constraints

- **The schema IS the T4 contract — it is FROZEN to T4's mirrored shape.** `dag.ts` exports `DagNode { id: string; task: string; deps: string[]; files?: string[]; mutatesDeps?: boolean }` and `TaskDag { nodes: DagNode[] }` **byte-identical** to the shape T4's `dag-state.ts` mirrors (T4 Task 1 Interfaces). T3 is the **canonical source**; on integration T4's `dag-state.ts` drops its local copy and does `import { DagNode, TaskDag } from "./dag.ts"`, and T4's `runDag` calls T3's `assertValidDag`. Any field add/rename ripples into `runDag`/`dag-state`/`--dag-file` — do not change the shape without updating the T4 plan.
- **`mutatesDeps?` is REQUIRED in the schema even though the spec's short-form omits it.** Spec line 26/87 writes `{id, task, deps[], files?}`, but the spec's own T1-review carry-forward heads-up #2 (spec line 114) and T4's constraint (T4 plan line 24) state the DAG must flag dep-mutating nodes — "T3/N4 emits it; the scheduler enforces it." So the canonical `DagNode` = the 4 core fields **plus the optional `mutatesDeps?: boolean`**, matching T4's `DagNode` exactly. (See report — this is the one reconciliation between the spec's short-form and T4's consumed shape.)
- **Validation is TOTAL — no invalid DAG can reach the scheduler.** `assertValidDag` rejects: empty node list, non-string/empty `id` or `task`, non-array `deps`/`files`, duplicate ids, dangling deps (a dep id not in the node set), self-deps, and any cycle. The scheduler (T4 `runDag`) uses `assertValidDag` as its single validation gate, so a malformed artifact `die`s at the boundary, never mid-schedule.
- **Files-overlap is AWARENESS, not rejection.** The spec asks nodes to touch disjoint file-sets "where possible" (merge-conflict minimization) — overlap is a risk T5's integration gate handles, not an illegal DAG. `validateDag` returns `warnings` (not `errors`) for any two **concurrent** nodes (neither reachable from the other via `deps`) whose `files` intersect; `assertValidDag` `log`s warnings but does not fail. The gate2 glue surfaces `warnings` to the human alongside the DAG so they can revise granularity.
- **Gate2 is REUSE, not reinvention.** The DAG is approved through the SHIPPED root-human gate: the planner squad pauses at `{status:"gate", gate:"gate2", payload:<Designer DAG output>}` and the human answers `--resume --gate-answer approve|revise` (`answerGate`). T3 adds **no** new gate/approval mechanism. `approve` on gate2 = "schedule this DAG"; `revise` re-drives the planner Designer. The planner def sets `gate2:"human"` and is driven `gatePolicy:"auto"` (gate1 auto-approves, gate2 pauses).
- **Back-compat with shipped squad/gate code is byte-identical.** `STANDARD_SQUAD`, `syncWireContracts`, `cmdSquadRun`, `answerGate`, `renderRole` behavior are unchanged. The only edit to shipped code is a **guarded** append in `renderWireContract` (squad-def.ts) that fires solely when a def's Designer wire teaches `## Task DAG`; STANDARD's rendered `contract.md` stays byte-identical, asserted by a regression test.
- **Two representations, one type.** The **wire** form (a fenced ` ```dag ` block inside the Designer's markdown payload, parsed by `parseDagFromPayload`) and the **artifact** form (a raw `{nodes:[...]}` JSON — T4's `--dag-file`) both resolve to the identical `TaskDag`; both funnel through `assertValidDag`. T3 owns the wire parse; T4 owns the file read.
- **Tests run with:** `bun test test/<file>.test.ts` from `opencode-plugin/`. All hermetic — injected `DriveFn`/`execFn`, temp dirs, `META_HARNESS_HOME` per-test. No real opencode drive, no real git.

---

### Task 1: `fleet/dag.ts` — the DAG artifact schema + total validator

**Files:**
- Create: `opencode-plugin/src/fleet/dag.ts`
- Test: `opencode-plugin/test/fleet-dag.test.ts`

**Interfaces:**
- Consumes: `die`, `log` from `../bench/util.ts` (`die: (msg: string) => never`, `log: (msg: string) => void`).
- Produces (the schema — **byte-identical to T4 `dag-state.ts`'s mirrored `DagNode`/`TaskDag`**; T4 imports these on integration):
  ```ts
  export interface DagNode {
    id: string
    task: string
    deps: string[]
    files?: string[]
    mutatesDeps?: boolean
  }
  export interface TaskDag {
    nodes: DagNode[]
  }

  export interface DagValidation {
    ok: boolean          // false iff `errors` is non-empty
    errors: string[]     // HARD — an invalid DAG the scheduler must never run
    warnings: string[]   // SOFT — files-overlap between concurrent nodes (merge-conflict risk)
  }

  /** Total structural + graph validation. Never throws — returns every
   * error/warning found so a gate2 revise can show the human all of them. */
  export function validateDag(dag: unknown): DagValidation
  /** Scheduler-boundary gate: `die` with the joined errors if invalid, else
   * `log` any warnings and return the typed dag. T4's `runDag` calls this. */
  export function assertValidDag(dag: unknown): TaskDag
  ```
- Validation rules (all in `validateDag`):
  - `dag` is `{nodes: DagNode[]}`, `nodes` a **non-empty** array.
  - each node: `id` a non-empty string; `task` a non-empty string; `deps` an array of strings; `files` (if present) an array of strings; `mutatesDeps` (if present) a boolean.
  - **id uniqueness** — no two nodes share an `id`.
  - **dangling deps** — every id in every `deps[]` exists in the node-id set.
  - **self-dep** — no id appears in its own `deps` (a trivial cycle; report explicitly).
  - **acyclic** — Kahn's algorithm (or DFS); if nodes remain after removing all in-degree-0 nodes, report the cycle members. (Runs only after ids/deps are structurally sound.)
  - **files-overlap (warning)** — computed only when there are no structural errors: build reachability over `deps`; for each unordered pair where neither node is reachable from the other (they can run concurrently), if `files` intersect, push a warning naming the shared file(s) and node ids.

- [ ] **Step 1: Write the failing test** — `test/fleet-dag.test.ts`, `describe("validateDag / assertValidDag")`:
  - **valid** 3-node DAG (`a`,`b` independent; `c` deps `["a","b"]`, `files:["src/c.ts"]`) → `ok:true`, `errors:[]`; `assertValidDag` returns it unchanged.
  - **duplicate id** (`a` twice) → `ok:false`, an error mentioning the dup id.
  - **dangling dep** (`c` deps `["a","zzz"]`) → `ok:false`, an error mentioning `zzz`.
  - **self-dep** (`a` deps `["a"]`) → `ok:false`, an error mentioning the self-cycle.
  - **2-cycle** (`a`→`b`, `b`→`a`) and **3-cycle** (`a`→`b`→`c`→`a`) → each `ok:false` with a cycle error.
  - **empty nodes** (`{nodes:[]}`) and **not-an-object** (`null`, `{}`, `{nodes:"x"}`) → `ok:false`.
  - **shape errors** — node with empty `id`, missing `task`, `deps` not an array, `files` not an array → each `ok:false`.
  - **files-overlap = warning, not error** — `a`,`b` concurrent (both `deps:[]`) both listing `src/shared.ts` → `ok:true`, `errors:[]`, `warnings` non-empty naming `src/shared.ts`; `assertValidDag` returns the dag (does not throw).
  - **overlap along a dependency edge is NOT warned** — `a` (`files:["src/x.ts"]`) and `b` (deps `["a"]`, `files:["src/x.ts"]`) → `warnings:[]` (they never run concurrently).
  - **`mutatesDeps` round-trips** — a node `{id,task,deps:[],mutatesDeps:true}` validates `ok:true`.
  - **`assertValidDag` dies** on a cyclic dag (`expect(() => assertValidDag(cyclic)).toThrow`), returns the typed value on a valid one.
- [ ] **Step 2: Run test to verify it fails** — `bun test test/fleet-dag.test.ts` → FAIL (`Cannot find module '../src/fleet/dag.ts'`).
- [ ] **Step 3: Write minimal implementation** — `dag.ts` with the types + `validateDag` (structural checks → id-set → dangling/self → Kahn cycle detect → reachability-based overlap warnings) + `assertValidDag` (`const v = validateDag(dag); if (!v.ok) die("invalid task-DAG:\n- " + v.errors.join("\n- ")); for (const w of v.warnings) log("task-DAG warning: " + w); return dag as TaskDag`).
- [ ] **Step 4: Run test to verify it passes** — `bun test test/fleet-dag.test.ts` → PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add opencode-plugin/src/fleet/dag.ts opencode-plugin/test/fleet-dag.test.ts
  git commit -m "feat(fleet): T3 dag artifact — schema + total validator (cycle/dangling/dup, files-overlap warn) (N4)"
  ```

---

### Task 2: `fleet/dag.ts` — the wire codec (emit / parse the Designer's DAG block)

**Files:**
- Modify: `opencode-plugin/src/fleet/dag.ts` (add the codec + contract text)
- Test: `opencode-plugin/test/fleet-dag.test.ts` (append a `describe("wire codec")`)

**Interfaces:**
- Consumes: `TaskDag`/`DagNode`, `validateDag`/`assertValidDag` (Task 1).
- Produces:
  ```ts
  /** The fenced-block language tag the planner Designer emits under `## Task DAG`. */
  export const DAG_FENCE = "dag"
  export const DAG_HEADING = "## Task DAG"

  /** Canonical emit: the `## Task DAG` heading + a fenced dag JSON block (tag
   * = DAG_FENCE). Used by the persona example, round-trip tests, and to author
   * a T4 `--dag-file` (whose bare form is `JSON.stringify(dag, null, 2)`). */
  export function formatDagBlock(dag: TaskDag): string

  /** Extract + JSON-parse + SHAPE-check the DAG block out of a Designer role
   * payload (prose may surround it). Prefers a fenced dag block; falls back to
   * a fenced json block (proposer-drift leniency, mirrors parseVerdict's
   * tolerance). Returns the shaped TaskDag or a parse/shape error — does NOT
   * run graph validation (that is `dagFromApprovedPayload`/`assertValidDag`). */
  export function parseDagFromPayload(
    payload: string,
  ): { ok: true; dag: TaskDag } | { ok: false; error: string }

  /** Gate2 sink: parse the approved Designer payload AND fully validate it.
   * `die`s on either a parse failure or an invalid DAG — nothing invalid ever
   * reaches the scheduler. The T4 `--feature` glue calls this on approve. */
  export function dagFromApprovedPayload(payload: string): TaskDag

  /** Verbatim wire-contract detail (block format + a literal example) that the
   * planner Designer's contract.md must show — the generator must SEE the
   * exact `{id,task,deps,files?,mutatesDeps?}` format, not infer it (spec
   * §1.5 wire-visibility). Imported by squad-def.ts's renderWireContract in
   * Task 3. */
  export function dagContractText(): string
  ```
- `parseDagFromPayload` regex: first fenced block tagged `dag` (then `json` fallback), inner text `JSON.parse`d; shape-check `{nodes: DagNode[]}` field types only (delegate graph checks). `formatDagBlock`/`parseDagFromPayload` are exact inverses for any valid `TaskDag`.

- [ ] **Step 1: Write the failing test** — append `describe("wire codec")` to `test/fleet-dag.test.ts`:
  - **round-trip** — `parseDagFromPayload(formatDagBlock(dag))` → `{ok:true}` with `.dag` deep-equal to `dag` (including `files`/`mutatesDeps`).
  - **prose around the block** — a payload like `"Here is the plan.\n\n" + formatDagBlock(dag) + "\n\nThat's it."` still parses `ok:true`.
  - **```json fallback** — a payload whose block is fenced ` ```json ` (not `dag`) still parses `ok:true`.
  - **missing block** — a plain-prose payload → `ok:false`, an error string.
  - **malformed JSON in the block** — `` ```dag\n{nodes: [ }\n``` `` → `ok:false`.
  - **wrong shape** — a block that parses to `{nodes:"x"}` or `{items:[]}` → `ok:false`.
  - **byte-consistency with T4** — a fully-populated node `{id:"c",task:"t",deps:["a"],files:["src/c.ts"],mutatesDeps:true}` survives `formatDagBlock`→`parseDagFromPayload` with all five keys intact (this is the exact `DagNode` T4's `dag-state.ts`/`--dag-file` consumes; assert `Object.keys(node).sort()` = `["deps","files","id","mutatesDeps","task"]`).
  - **`dagFromApprovedPayload`** — on a valid payload returns the `TaskDag`; on a payload whose block is parseable but **cyclic** (`a`→`b`→`a`), `expect(() => dagFromApprovedPayload(p)).toThrow` (parse ok, validate fails → `die`); on a payload with **no block**, throws.
- [ ] **Step 2: Run test to verify it fails** — FAIL (missing `formatDagBlock`/`parseDagFromPayload`/…).
- [ ] **Step 3: Write minimal implementation** — add the constants, `formatDagBlock` (heading + fence + `JSON.stringify(dag, null, 2)` + fence), `parseDagFromPayload` (fence regex `dag` then `json`, `JSON.parse`, shape-check), `dagFromApprovedPayload` (`const r = parseDagFromPayload(payload); if (!r.ok) die("gate2: no valid task-DAG in the approved plan — " + r.error); return assertValidDag(r.dag)`), and `dagContractText` (the block format + a 3-node example incl. `deps`/`files`/`mutatesDeps`).
- [ ] **Step 4: Run test to verify it passes** — PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add opencode-plugin/src/fleet/dag.ts opencode-plugin/test/fleet-dag.test.ts
  git commit -m "feat(fleet): T3 dag wire codec — emit/parse the Designer's fenced dag block; gate2 sink (N4)"
  ```

---

### Task 3: `PLANNER_SQUAD` def + Designer DAG wire-contract (schema/lint)

**Files:**
- Modify: `opencode-plugin/src/fleet/squad-def.ts` (add `PLANNER_SQUAD`; guard-extend `renderWireContract`)
- Test: `opencode-plugin/test/fleet-dag-planner.test.ts` (new)

**Interfaces:**
- Consumes: `dagContractText`, `DAG_HEADING` from `./dag.ts` (Task 2); the existing `SquadDef`/`renderWireContract`/`syncWireContracts`/`writeSquadDefV1`/`readActiveSquadDef` (squad-def.ts).
- Produces:
  ```ts
  /** The top-level planner squad (spec N4): reuses the 4 role slots + flow of
   * STANDARD, but the Designer's wire output is the task-DAG, and gate2 is the
   * human DAG-approval. Driven `gatePolicy:"auto"` so gate1 auto-approves and
   * gate2 pauses on the DAG. */
  export const PLANNER_SQUAD: SquadDef
  ```
  - `PLANNER_SQUAD.type = "planner"`; `slots` identical to `STANDARD_SQUAD.slots`; `flow` = STANDARD's bounds/reentry but `gatePolicy: { gate1: "auto", gate2: "human" }`.
  - `wire.headings.designer = [["## Task DAG"]]` (the DAG is the Designer's contract); `analyzer`/`implementer`/`evaluator`/`evaluator-spec`/`evaluator-verdict` headings + `verdictRe` reuse STANDARD verbatim.
  - **Guarded** `renderWireContract` edit: after the existing group rendering, if `role === "designer"` **and** `def.wire.headings.designer` contains a group equal to `["## Task DAG"]`, append `dagContractText()` (mirrors the existing `role === "evaluator"` special-case). STANDARD's designer wire has no `## Task DAG`, so its rendered contract is unchanged.

- [ ] **Step 1: Write the failing test** — `test/fleet-dag-planner.test.ts` (hermetic `META_HARNESS_HOME` per-test, same beforeEach idiom as `fleet-squad-cli.test.ts`):
  - **def shape** — `PLANNER_SQUAD.type === "planner"`; `PLANNER_SQUAD.wire.headings.designer` deep-equals `[["## Task DAG"]]`; `flow.gatePolicy` is `{gate1:"auto", gate2:"human"}`; slots deep-equal `STANDARD_SQUAD.slots`.
  - **writes + reads back** — `writeSquadDefV1(PLANNER_SQUAD)`; `readActiveSquadDef("planner")` returns a def whose designer wire is `[["## Task DAG"]]` (proves `validateSlots` accepts it — all opencode agent slots).
  - **planner Designer contract.md teaches the DAG format** — after `writeSquadDefV1(PLANNER_SQUAD)` (which calls `syncWireContracts`), read `<accountRoleRoot("mh-designer")>/contract.md`; assert it contains `## Task DAG` AND the ` ```dag ` block-format detail from `dagContractText()` (e.g. contains `"deps"` and `"mutatesDeps"`).
  - **back-compat regression** — in a SEPARATE `META_HARNESS_HOME`, `writeSquadDefV1(STANDARD_SQUAD)`; assert `mh-designer` `contract.md` does **not** contain `Task DAG` and still contains `## Alternatives` + `## Recommended` (STANDARD's designer contract is byte-identical to before this task).
- [ ] **Step 2: Run test to verify it fails** — FAIL (`PLANNER_SQUAD` undefined; and the contract.md assertion fails until the guarded `renderWireContract` append lands).
- [ ] **Step 3: Write minimal implementation** — add `PLANNER_SQUAD` (spread STANDARD's slots, override `type`/`flow.gatePolicy`/`wire.headings.designer`, reuse the rest of `wire`); import `dagContractText`/`DAG_HEADING` from `./dag.ts`; add the guarded designer branch to `renderWireContract`.
- [ ] **Step 4: Run test to verify it passes** — `bun test test/fleet-dag-planner.test.ts` → PASS; `bun test test/fleet-squad-def.test.ts` (or the existing squad-def suite) stays green (STANDARD contracts unchanged).
- [ ] **Step 5: Commit**
  ```bash
  git add opencode-plugin/src/fleet/squad-def.ts opencode-plugin/test/fleet-dag-planner.test.ts
  git commit -m "feat(fleet): T3 planner squad-def + guarded Designer DAG wire-contract (N4)"
  ```

---

### Task 4: gate2 emit → parse → approve, end-to-end through the SHIPPED gate

**Files:**
- Test: `opencode-plugin/test/fleet-dag-gate2.test.ts` (new)

**Interfaces:**
- Consumes: `cmdSquadRun` (squad-cli.ts) with `squadType:"planner"` + `gatePolicy:"auto"`; the `scripted` injected-`DriveFn` seam (`test/fleet-helpers.ts`); `parseDagFromPayload`/`formatDagBlock`/`TaskDag` (Tasks 1-2); `PLANNER_SQUAD`/`writeSquadDefV1` (Task 3); for Test B, `cmdRoleRun`/`ExecFn` (run.ts) + `renderRole`/`seedRenderedRole`. **Produces nothing** — integration proof only. Proves gate2 is the shipped gate (`answerGate` / `--resume --gate-answer`), and the emitted DAG is byte-consistent with what T4 ingests.

- [ ] **Step 1: Write the failing test** — `test/fleet-dag-gate2.test.ts`:

  **Test A — planner squad pauses at gate2 with the DAG, approve advances (injected `DriveFn`, no personas):**
  ```ts
  import { afterEach, beforeEach, describe, expect, test } from "bun:test"
  import { mkdtempSync, rmSync } from "node:fs"
  import { tmpdir } from "node:os"
  import { join } from "node:path"
  import { cmdSquadRun } from "../src/fleet/squad-cli.ts"
  import { writeSquadDefV1, PLANNER_SQUAD } from "../src/fleet/squad-def.ts"
  import { formatDagBlock, parseDagFromPayload, type TaskDag } from "../src/fleet/dag.ts"
  import { scripted } from "./fleet-helpers.ts"

  const DAG: TaskDag = {
    nodes: [
      { id: "a", task: "build worktree prim", deps: [] },
      { id: "b", task: "build dag schema", deps: [] },
      { id: "c", task: "wire scheduler", deps: ["a", "b"], files: ["src/fleet/dag-scheduler.ts"] },
    ],
  }

  describe("planner gate2 = DAG approval (shipped gate)", () => {
    let home: string, project: string
    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), "mh-dag-g2-home-"))
      project = mkdtempSync(join(tmpdir(), "mh-dag-g2-proj-"))
      process.env.META_HARNESS_HOME = home
      writeSquadDefV1(PLANNER_SQUAD)                 // planner def active (syncs the DAG contract)
    })
    afterEach(() => {
      delete process.env.META_HARNESS_HOME
      rmSync(home, { recursive: true, force: true })
      rmSync(project, { recursive: true, force: true })
    })

    test("Designer emits the DAG; gate2 pauses on it; parse yields a valid TaskDag; approve advances", async () => {
      // Override ONLY the designer phase to emit the ## Task DAG block; the
      // analyzer/evaluator-spec phases fall back to fleet-helpers' OK payloads.
      const { drive, score } = scripted({ designer: [formatDagBlock(DAG)] })
      const first = await cmdSquadRun(
        { project, sliceId: "plan1", slice: "self-host feature X", squadType: "planner", gatePolicy: "auto" },
        drive, score,
      )
      expect(first.status).toBe("gate")
      if (first.status !== "gate") throw new Error("unreachable")
      expect(first.gate).toBe("gate2")                       // gate1 auto-approved; gate2 is the DAG gate
      const parsed = parseDagFromPayload(first.payload)       // the DAG rode the Designer payload to gate2
      expect(parsed.ok).toBe(true)
      if (parsed.ok) expect(parsed.dag).toEqual(DAG)          // byte-consistent with T4's runDag input

      // approve via the SHIPPED gate machinery (answerGate / --resume) — no new gate
      const second = await cmdSquadRun(
        { project, sliceId: "plan1", resume: true, gateAnswer: "approve", squadType: "planner", gatePolicy: "auto" },
        drive, score,
      )
      expect(second.status).not.toBe("gate")                 // approve moved the flow past gate2 (existing mechanism)
    })
  })
  ```
  (`scripted`'s `OK.analyzer`/`OK["evaluator-spec"]` satisfy the reused analyzer/evaluator wire; the planner Designer lint is `## Task DAG`, satisfied by `formatDagBlock(DAG)`. Gate1 is `"auto"` in the planner def, so with `gatePolicy:"auto"` the run pauses only at gate2.)

  **Test B — the DAG survives the REAL role-output parse path (`trace()` NDJSON `execFn` idiom):** render a designer persona (`seedRenderedRole(project, "designer", "designer body\n## Alternatives\nx\n## Recommended\ny")` so it passes STANDARD render-lint), inject an `execFn` returning `trace(formatDagBlock(DAG))` (the same one-text-turn + `step_finish` fixture `fleet-squad-run-model.test.ts` uses), call `cmdRoleRun({ project, role: "designer", input: "x" }, execFn)`, then assert `parseDagFromPayload(res.payload)` is `ok:true` and `.dag` deep-equals `DAG` — proving the DAG block round-trips through `run.ts`'s NDJSON→`extractFinalPayload` extraction, not just an in-memory string.
- [ ] **Step 2: Run test to verify it fails** — FAIL until Tasks 1-3 are in (planner def + wire + codec).
- [ ] **Step 3: Implementation** — none (Tasks 1-3 supply everything); if Test A does not pause at gate2, the fix is in the Task-3 planner def's `gatePolicy`, not here.
- [ ] **Step 4: Run test + full suite** — `bun test test/fleet-dag-gate2.test.ts` PASS; `bun test` green (no regression — STANDARD flows + shipped gate untouched).
- [ ] **Step 5: Commit**
  ```bash
  git add opencode-plugin/test/fleet-dag-gate2.test.ts
  git commit -m "test(fleet): T3 gate2 emit→parse→approve via the shipped gate; NDJSON round-trip (N4)"
  ```

---

## Notes / scope boundaries (carried from the spec)

- **T3 owns the artifact; T4 owns execution.** On T4 integration: T4's `dag-state.ts` deletes its locally-mirrored `DagNode`/`TaskDag` and does `import { DagNode, TaskDag } from "./dag.ts"`; T4's `runDag` validation (T4 Task 4: "node ids unique, every `deps[]` id exists, DAG acyclic — `die` on cycle/dangling") is replaced by a single `assertValidDag(dag)` call. This is a pure import/dedup change on the T4 side (the shapes are byte-identical by construction), and it collapses two validators into T3's one total gate.
- **The `--feature` / `--dag-file` CLI is T4, not T3.** T4's `fleet-dev` CLI (T4 Task 8) reads `--dag-file F` (a bare `{nodes:[...]}` JSON = `writeJsonAtomic(path, dag)` of an approved `TaskDag`) and, on the `--feature` path, runs the planner squad to its gate2 pause, then on approve calls `dagFromApprovedPayload(gatePayload)` → hands the `TaskDag` to `runDag`. T3 supplies `dagFromApprovedPayload`/`formatDagBlock`/`validateDag`; wiring them into the `--feature` flow (currently the T4 stub that `die`s "provide --dag-file (T3 planner-emit integration pending)") is the T3↔T4 seam.
- **Files-overlap warnings reach the human at gate2.** The `--feature` glue shows `validateDag(dag).warnings` next to the DAG payload so a human can `revise` for better granularity — the awareness the spec asks for ("disjoint file-sets where possible"), without blocking a legitimately-overlapping DAG (T5's integration gate is the real conflict backstop).
- **The planner squad is driven only to gate2.** `approve` means "schedule the DAG" (the orchestrator hands off to `runDag`), not "resume the planner into its own implementer." Test A resumes past gate2 only to prove the shipped gate advances; the planner's implementer/evaluator-verdict phases are not part of DAG emission.

## Explicitly DEFERRED / out of scope

- **Scheduling / running the DAG** (worktrees, concurrency cap, unblock-on-PASS, DAG-scheduler state, crash-reconciliation) — **T4** (`2026-07-16-t4-fleet-dev-scheduler.md`). T3 stops at "a validated `TaskDag` the human approved at gate2."
- **Merge + integration-verify** of node branches — **T5 (N5b)**.
- **The `fleet-dev` CLI surface** (`--feature`, `--dag-file`, `--max-concurrency`, `--run-id --resume`) — **T4 Task 8**. T3 adds no CLI case.
- **Threading `squadType` through `cmdRolesRender`** (so `roles-render --squad-type planner` render-lints the Designer persona against `## Task DAG`) — a small additive change owned by whoever wires the live planner run (T4/T6). T3's tests use the injected `DriveFn` (no persona render needed) and, for Test B, `seedRenderedRole` under STANDARD (the DAG rides the injected/execFn payload, not the persona body).
- **`mutatesDeps` INFERENCE** — T3 emits/validates the field as the Designer declares it; auto-detecting which nodes touch `package.json`/`bun.lock*` (vs. trusting the Designer's flag) is deferred. T4 enforces the flag at run time (its `worktree-deps` policy, T4 Task 2).
- **A richer DAG artifact** (per-node `squadType`, budgets, priority, estimated cost, explicit edge labels) — YAGNI for N4; the frozen `{id,task,deps[],files?,mutatesDeps?}` shape is exactly what T4 consumes. Extending it is a coordinated T3+T4 change, not a T3-alone addition.
- **Evaluator-authored whole-plan test spec for the DAG** (a planner-mode evaluator that grades the decomposition) — the spec's deferred "synthesized whole-feature evaluator" line; the v1 gate for the plan is the **human at gate2**, not an automated planner-evaluator.
