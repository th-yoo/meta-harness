# Fleet Squad Depth-1 E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One depth-1 squad (analyzer→designer→implementer→evaluator) running end-to-end under a deterministic runner, with role prompts rendered from the meta-harness store and every gate/verdict scored back into it.

**Architecture:** New `opencode-plugin/src/fleet/` module family (pure additions) implementing spec `docs/superpowers/specs/2026-07-13-fleet-squad-integration-design.md`: role manifest → SquadDef store → renderer → importer → headless role driver (AgentDriver seam) → scorer → deterministic squad state machine with checkpoint/resume. CLI subcommands added to the existing bench CLI. Demo script + hermetic E2E test close the loop.

**Tech Stack:** Bun + TypeScript only (no Python). Reuses: `compose.ts`, `harness-store.ts`, `drivers/opencode.ts` (parseOutput/classifyAttempt), `bench/record.ts` (layerStoreRoots, parsePins, recordToStores), `bench/util.ts` (writeJsonAtomic, die, log), `opencode-run.ts` spawn shape.

## Global Constraints

- Pure additions: the only existing files materially edited are `opencode-plugin/src/bench/cli.ts` (new subcommands) and `opencode-plugin/src/bench/util.ts` (add `writeTextAtomic`). 728 existing tests untouched by construction.
- All tests hermetic: `META_HARNESS_HOME` set to a per-test tmp dir; never read the developer's real `$HOME`. Fixture repos in tmp dirs.
- Atomic writes only (`writeJsonAtomic` / new `writeTextAtomic`) for store/pending/checkpoint files.
- opencode driver only in v1. `platform: "claude-code"` in a SlotBinding → `die("claude-code leaf not yet supported — CC persona probe pending (spec §5)")`.
- Slot kind `"squad"` (recursion) → `die("nested squads not yet supported (spec §8.4)")`. Grammar stays in types.
- Escalations are payload-heading conventions (wire contract): `## Clarify`, `## DesignDecision`, `## Exhausted`, `## Infeasible`, `## Refused`. `Refused` is NEVER auto-scored and NEVER retried (spec §3.3.1).
- Verdict wire format: `VERDICT: PASS` or `VERDICT: FAIL cause=impl|design|intent` (missing cause defaults to `impl`).
- opencode permission keys are `bash`, `edit`, `write` — never `shell` (oc-test KNOWN-ISSUES.md).
- oc-test repo is read-only (spec §11). Import fixtures are synthesized under `test/fixtures/fleet/`, never copies of oc-test files.
- Run tests with `bun test <file>` from `opencode-plugin/`.
- Commit after every task with the given message; never push.

---

### Task 1: Role manifest — `fleet/roles.ts`

**Files:**
- Create: `opencode-plugin/src/fleet/roles.ts`
- Test: `opencode-plugin/test/fleet-roles.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces (later tasks import these exact names):
  ```ts
  export type FleetRoleName = "analyzer" | "designer" | "implementer" | "evaluator"
  export interface RoleSpec {
    role: FleetRoleName
    agent: string                                  // "mh-analyzer" etc.
    description: string
    mode: "all"
    model: string                                  // default model pin
    temperature: number
    permission: Record<string, "allow" | "deny">   // keys: bash, edit, write
  }
  export const FLEET_ROLES: RoleSpec[]
  export function roleSpec(role: string): RoleSpec  // die() on unknown role
  ```

- [ ] **Step 1: Write the failing test**

```ts
// opencode-plugin/test/fleet-roles.test.ts
import { describe, expect, test } from "bun:test"
import { FLEET_ROLES, roleSpec } from "../src/fleet/roles.ts"

describe("FLEET_ROLES manifest", () => {
  test("has exactly the four squad roles with mh- agents", () => {
    expect(FLEET_ROLES.map((r) => r.role).sort()).toEqual([
      "analyzer", "designer", "evaluator", "implementer",
    ])
    for (const r of FLEET_ROLES) expect(r.agent).toBe(`mh-${r.role}`)
  })

  test("permission uses bash key, never shell; design roles read-only", () => {
    for (const r of FLEET_ROLES) {
      expect(Object.keys(r.permission)).not.toContain("shell")
    }
    expect(roleSpec("analyzer").permission).toEqual({ bash: "deny", edit: "deny", write: "deny" })
    expect(roleSpec("designer").permission).toEqual({ bash: "deny", edit: "deny", write: "deny" })
    expect(roleSpec("evaluator").permission).toEqual({ bash: "allow", edit: "deny", write: "deny" })
    expect(roleSpec("implementer").permission).toEqual({ bash: "allow", edit: "allow", write: "allow" })
  })

  test("roleSpec dies on unknown role", () => {
    expect(() => roleSpec("architect")).toThrow(/unknown fleet role/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd opencode-plugin && bun test test/fleet-roles.test.ts`
Expected: FAIL — `Cannot find module '../src/fleet/roles.ts'`

- [ ] **Step 3: Write the implementation**

```ts
// opencode-plugin/src/fleet/roles.ts
/**
 * roles.ts — the fleet role manifest (spec §1, §1.5 rule 3).
 * Frontmatter/permission templates ONLY — payload headings live in the
 * SquadDef wire block (squad-def.ts), owned by the consuming squad.
 * Permission keys are bash/edit/write; `shell` is silently ignored by
 * opencode (oc-test KNOWN-ISSUES.md) and must never appear here.
 */
import { die } from "../bench/util.ts"

export type FleetRoleName = "analyzer" | "designer" | "implementer" | "evaluator"

export interface RoleSpec {
  role: FleetRoleName
  agent: string
  description: string
  mode: "all"
  model: string
  temperature: number
  permission: Record<string, "allow" | "deny">
}

const RO = { bash: "deny", edit: "deny", write: "deny" } as const

export const FLEET_ROLES: RoleSpec[] = [
  {
    role: "analyzer",
    agent: "mh-analyzer",
    description: "Turns a slice into use cases + functional spec; escalates genuine intent forks",
    mode: "all",
    model: "anthropic/claude-haiku-4-5",
    temperature: 0.2,
    permission: { ...RO },
  },
  {
    role: "designer",
    agent: "mh-designer",
    description: "Turns an approved spec into design alternatives + recommendation",
    mode: "all",
    model: "anthropic/claude-sonnet-4-6",
    temperature: 0.3,
    permission: { ...RO },
  },
  {
    role: "implementer",
    agent: "mh-implementer",
    description: "Turns a decided design into minimal tested code; commits locally, never pushes",
    mode: "all",
    model: "anthropic/claude-sonnet-4-6",
    temperature: 0.1,
    permission: { bash: "allow", edit: "allow", write: "allow" },
  },
  {
    role: "evaluator",
    agent: "mh-evaluator",
    description: "Authors test-spec from intent; runs checks and emits the VERDICT",
    mode: "all",
    model: "anthropic/claude-haiku-4-5",
    temperature: 0.1,
    permission: { bash: "allow", edit: "deny", write: "deny" },
  },
]

export function roleSpec(role: string): RoleSpec {
  const spec = FLEET_ROLES.find((r) => r.role === role)
  if (!spec) die(`unknown fleet role: ${role} (want one of ${FLEET_ROLES.map((r) => r.role).join("|")})`)
  return spec as RoleSpec
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd opencode-plugin && bun test test/fleet-roles.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add opencode-plugin/src/fleet/roles.ts opencode-plugin/test/fleet-roles.test.ts
git commit -m "feat(fleet): role manifest — 4-role squad, bash-not-shell permissions (spec D1)"
```

---

### Task 2: SquadDef store + wire lint — `fleet/squad-def.ts`

**Files:**
- Create: `opencode-plugin/src/fleet/squad-def.ts`
- Modify: `opencode-plugin/src/bench/util.ts` (add `writeTextAtomic` next to `writeJsonAtomic`, same tmp-then-rename pattern)
- Test: `opencode-plugin/test/fleet-squad-def.test.ts`

**Interfaces:**
- Consumes: `accountMetaRoot()` from `../harness-store.ts`; `writeJsonAtomic`, `die` from `../bench/util.ts`.
- Produces:
  ```ts
  export type SlotBinding =
    | { kind: "agent"; role: string; platform: "opencode" | "claude-code"; model: string }
    | { kind: "squad"; type: string }
  export interface SquadFlow {
    bounds: { R1: number; R2: number; R3: number; globalBudgetSteps: number }
    gatePolicy: { gate1: "human" | "auto"; gate2: "human" | "auto" }
    reentry: "delta" | "full"
  }
  export interface SquadDef {
    type: string
    slots: Record<"analyzer" | "designer" | "implementer" | "evaluator", SlotBinding>
    flow: SquadFlow
    wire: { headings: Record<string, string[][]>; verdictRe: string }
  }
  export const STANDARD_SQUAD: SquadDef
  export function squadRoot(type: string): string          // accountMetaRoot()/squads/<type>
  export function writeSquadDefV1(def: SquadDef): void     // candidates/v1/squad.json + active/squad.json; die if active exists
  export function readActiveSquadDef(type: string): SquadDef  // die with "run squad-def-init" hint if missing
  export function lintPayload(def: SquadDef, slot: string, payload: string): { ok: boolean; missing: string[] }
  export type EscalationType = "Clarify" | "DesignDecision" | "Exhausted" | "Infeasible" | "Refused"
  export function detectEscalation(payload: string): { type: EscalationType; body: string } | null
  export function parseVerdict(def: SquadDef, payload: string):
    { verdict: "PASS" } | { verdict: "FAIL"; cause: "impl" | "design" | "intent" } | null
  ```

- [ ] **Step 1: Write the failing test**

```ts
// opencode-plugin/test/fleet-squad-def.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  STANDARD_SQUAD, detectEscalation, lintPayload, parseVerdict,
  readActiveSquadDef, squadRoot, writeSquadDefV1,
} from "../src/fleet/squad-def.ts"

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mh-squad-"))
  process.env.META_HARNESS_HOME = home
})
afterEach(() => {
  delete process.env.META_HARNESS_HOME
  rmSync(home, { recursive: true, force: true })
})

describe("SquadDef store", () => {
  test("writeSquadDefV1 then readActiveSquadDef round-trips", () => {
    writeSquadDefV1(STANDARD_SQUAD)
    const def = readActiveSquadDef("standard")
    expect(def.type).toBe("standard")
    expect(def.flow.bounds).toEqual({ R1: 2, R2: 1, R3: 3, globalBudgetSteps: 40 })
    expect(squadRoot("standard").startsWith(home)).toBe(true)
  })

  test("writeSquadDefV1 refuses when active already exists", () => {
    writeSquadDefV1(STANDARD_SQUAD)
    expect(() => writeSquadDefV1(STANDARD_SQUAD)).toThrow(/already/)
  })

  test("readActiveSquadDef dies with actionable hint when missing", () => {
    expect(() => readActiveSquadDef("standard")).toThrow(/squad-def-init/)
  })
})

describe("wire lint", () => {
  test("analyzer payload with spec headings passes; empty payload lists missing OR-groups", () => {
    const good = "## Use Cases\n- x\n## Functional Spec\n- y\n"
    expect(lintPayload(STANDARD_SQUAD, "analyzer", good).ok).toBe(true)
    const bad = lintPayload(STANDARD_SQUAD, "analyzer", "hello")
    expect(bad.ok).toBe(false)
    expect(bad.missing.length).toBeGreaterThan(0)
  })

  test("analyzer Clarify alone also satisfies the OR-group contract", () => {
    expect(lintPayload(STANDARD_SQUAD, "analyzer", "## Clarify\nwhich db?").ok).toBe(true)
  })
})

describe("escalations + verdict", () => {
  test("detectEscalation types all five; Refused wins over other headings", () => {
    expect(detectEscalation("## Clarify\nA or B?")?.type).toBe("Clarify")
    expect(detectEscalation("## Infeasible\ncontradictory")?.type).toBe("Infeasible")
    expect(detectEscalation("## Use Cases\n## Refused\nharmful")?.type).toBe("Refused")
    expect(detectEscalation("## Use Cases\nfine")).toBeNull()
  })

  test("parseVerdict: PASS, FAIL with cause, FAIL defaults to impl, garbage → null", () => {
    expect(parseVerdict(STANDARD_SQUAD, "VERDICT: PASS")).toEqual({ verdict: "PASS" })
    expect(parseVerdict(STANDARD_SQUAD, "VERDICT: FAIL cause=design"))
      .toEqual({ verdict: "FAIL", cause: "design" })
    expect(parseVerdict(STANDARD_SQUAD, "VERDICT: FAIL")).toEqual({ verdict: "FAIL", cause: "impl" })
    expect(parseVerdict(STANDARD_SQUAD, "looks good")).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd opencode-plugin && bun test test/fleet-squad-def.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// opencode-plugin/src/fleet/squad-def.ts
/**
 * squad-def.ts — the squad's ONE evolvable artifact (spec §1.5, §6):
 * slot bindings + flow knobs + wire protocol, versioned like a layer
 * (candidates/vN + active pointer) under the account root.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { accountMetaRoot } from "../harness-store.ts"
import { die, writeJsonAtomic } from "../bench/util.ts"

export type SlotBinding =
  | { kind: "agent"; role: string; platform: "opencode" | "claude-code"; model: string }
  | { kind: "squad"; type: string }

export interface SquadFlow {
  bounds: { R1: number; R2: number; R3: number; globalBudgetSteps: number }
  gatePolicy: { gate1: "human" | "auto"; gate2: "human" | "auto" }
  reentry: "delta" | "full"
}

export interface SquadDef {
  type: string
  slots: Record<"analyzer" | "designer" | "implementer" | "evaluator", SlotBinding>
  flow: SquadFlow
  wire: { headings: Record<string, string[][]>; verdictRe: string }
}

export const STANDARD_SQUAD: SquadDef = {
  type: "standard",
  slots: {
    analyzer:    { kind: "agent", role: "analyzer",    platform: "opencode", model: "anthropic/claude-haiku-4-5" },
    designer:    { kind: "agent", role: "designer",    platform: "opencode", model: "anthropic/claude-sonnet-4-6" },
    implementer: { kind: "agent", role: "implementer", platform: "opencode", model: "anthropic/claude-sonnet-4-6" },
    evaluator:   { kind: "agent", role: "evaluator",   platform: "opencode", model: "anthropic/claude-haiku-4-5" },
  },
  flow: {
    bounds: { R1: 2, R2: 1, R3: 3, globalBudgetSteps: 40 },
    gatePolicy: { gate1: "auto", gate2: "auto" },
    reentry: "delta",
  },
  wire: {
    headings: {
      analyzer:    [["## Use Cases", "## Functional Spec"], ["## Clarify"]],
      designer:    [["## Alternatives", "## Recommended"]],
      implementer: [["## Implementation Report"]],
      evaluator:   [["## Test Spec"], ["VERDICT:"]],
    },
    verdictRe: "^VERDICT: (PASS|FAIL)(?: cause=(impl|design|intent))?\\s*$",
  },
}

export function squadRoot(type: string): string {
  return join(accountMetaRoot(), "squads", type)
}

export function writeSquadDefV1(def: SquadDef): void {
  const root = squadRoot(def.type)
  const activePath = join(root, "active", "squad.json")
  if (existsSync(activePath)) die(`squad def '${def.type}' already has an active version`)
  mkdirSync(join(root, "candidates", "v1"), { recursive: true })
  mkdirSync(join(root, "active"), { recursive: true })
  writeJsonAtomic(join(root, "candidates", "v1", "squad.json"), def)
  writeJsonAtomic(activePath, { ...def, __version: "v1" })
}

export function readActiveSquadDef(type: string): SquadDef {
  const p = join(squadRoot(type), "active", "squad.json")
  if (!existsSync(p)) die(`no active squad def '${type}' — run: runner.ts squad-def-init`)
  return JSON.parse(readFileSync(p, "utf-8")) as SquadDef
}

/** OR-groups: payload passes if EVERY heading of AT LEAST ONE group is present. */
export function lintPayload(def: SquadDef, slot: string, payload: string): { ok: boolean; missing: string[] } {
  const groups = def.wire.headings[slot]
  if (!groups) return { ok: true, missing: [] }
  for (const group of groups) {
    if (group.every((h) => payload.includes(h))) return { ok: true, missing: [] }
  }
  return { ok: false, missing: groups.map((g) => g.join(" + ")) }
}

export type EscalationType = "Clarify" | "DesignDecision" | "Exhausted" | "Infeasible" | "Refused"

const ESCALATION_ORDER: EscalationType[] = ["Refused", "Infeasible", "Exhausted", "DesignDecision", "Clarify"]

export function detectEscalation(payload: string): { type: EscalationType; body: string } | null {
  for (const type of ESCALATION_ORDER) {
    const re = new RegExp(`^## ${type}\\s*$`, "m")
    const m = re.exec(payload)
    if (m) return { type, body: payload.slice(m.index) }
  }
  return null
}

export function parseVerdict(
  def: SquadDef,
  payload: string,
): { verdict: "PASS" } | { verdict: "FAIL"; cause: "impl" | "design" | "intent" } | null {
  const m = new RegExp(def.wire.verdictRe, "m").exec(payload)
  if (!m) return null
  if (m[1] === "PASS") return { verdict: "PASS" }
  return { verdict: "FAIL", cause: (m[2] as "impl" | "design" | "intent") ?? "impl" }
}
```

And in `opencode-plugin/src/bench/util.ts`, add beside `writeJsonAtomic` (same tmp-file + rename discipline it already uses):

```ts
export function writeTextAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, text)
  renameSync(tmp, path)
}
```

(Import `writeFileSync`, `renameSync` from `node:fs` if not already imported.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd opencode-plugin && bun test test/fleet-squad-def.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Run the full existing suite to prove no regressions**

Run: `cd opencode-plugin && bun test`
Expected: all pre-existing tests still PASS

- [ ] **Step 6: Commit**

```bash
git add opencode-plugin/src/fleet/squad-def.ts opencode-plugin/src/bench/util.ts opencode-plugin/test/fleet-squad-def.test.ts
git commit -m "feat(fleet): SquadDef store, wire lint, escalation taxonomy, verdict parser (spec §1.5, §3.3.1)"
```

---

### Task 3: Renderer — `fleet/render.ts` + `roles-render` subcommand

**Files:**
- Create: `opencode-plugin/src/fleet/render.ts`
- Modify: `opencode-plugin/src/bench/cli.ts` (add `roles-render` + `squad-def-init` cases; follow the existing `case "run":` dispatch pattern)
- Test: `opencode-plugin/test/fleet-render.test.ts`

**Interfaces:**
- Consumes: `roleSpec` (Task 1); `readActiveSquadDef`, `lintPayload` is NOT used here — lint at render checks the role BODY contains at least one wire heading group mention? No — render lint checks the composed body against the CONSUMING squad's wire block via `renderLint` below; `composeHarness`/`renderAgentsMd` from `../compose.ts`; `layerStoreRoots`, `parsePins` from `../bench/record.ts`; `writeTextAtomic` (Task 2).
- Produces:
  ```ts
  export interface RenderStamp { versions: Record<string, string>; harnessHash: string; renderedAt: string }
  export function renderRole(project: string, role: string, opts?: {
    pins?: Record<string, string>; force?: boolean; squadType?: string
  }): { path: string; stamp: RenderStamp }
  export function parseStamp(md: string): RenderStamp | null
  export function cmdRolesRender(args: { project: string; roles?: string[]; pins?: string[]; force?: boolean }): void
  ```
- Output file: `<project>/.opencode/agents/mh-<role>.md` = hand-serialized YAML frontmatter (description, mode, model, temperature, permission from RoleSpec) + `<!-- mh-render {...stamp json...} -->` + composed body from the role's 4 layers.
- Render lint: composed body must mention every heading of at least one wire OR-group for that role (so evolved prompts keep instructing the wire format). `--force` bypasses with a logged warning.

- [ ] **Step 1: Write the failing test**

```ts
// opencode-plugin/test/fleet-render.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { renderRole, parseStamp } from "../src/fleet/render.ts"
import { writeSquadDefV1, STANDARD_SQUAD } from "../src/fleet/squad-def.ts"
import { accountRoleRoot, createCandidate, writeActive } from "../harness-store-test-helpers.ts" // if no helper exists, import from ../src/harness-store.ts directly

let home: string, project: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mh-render-home-"))
  project = mkdtempSync(join(tmpdir(), "mh-render-proj-"))
  process.env.META_HARNESS_HOME = home
  writeSquadDefV1(STANDARD_SQUAD)
  // seed analyzer account-role v1 whose body teaches the wire format
  const body = "You are the analyzer.\nEmit `## Use Cases` and `## Functional Spec`; escalate with `## Clarify`."
  const root = accountRoleRoot("mh-analyzer")
  createCandidate(root, "v1", body)
  writeActive(root, "v1", body, null, null, null, null)
})
afterEach(() => {
  delete process.env.META_HARNESS_HOME
  rmSync(home, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
})

describe("renderRole", () => {
  test("writes frontmatter + stamp + body; stamp round-trips; idempotent", () => {
    const { path, stamp } = renderRole(project, "analyzer")
    const md = readFileSync(path, "utf-8")
    expect(md).toStartWith("---\n")
    expect(md).toContain("bash: deny")
    expect(md).not.toContain("shell:")
    expect(md).toContain("You are the analyzer.")
    expect(parseStamp(md)).toEqual(stamp)
    const second = renderRole(project, "analyzer")
    expect(readFileSync(second.path, "utf-8")).toBe(md) // same stamp inputs → byte-identical body+frontmatter (renderedAt excluded from idempotence: freeze it via stamp.versions comparison)
  })

  test("render lint refuses a body that never mentions the wire headings; --force overrides", () => {
    const root = accountRoleRoot("mh-designer")
    createCandidate(root, "v1", "You design things. No format promised.")
    writeActive(root, "v1", "You design things. No format promised.", null, null, null, null)
    expect(() => renderRole(project, "designer")).toThrow(/wire/)
    expect(() => renderRole(project, "designer", { force: true })).not.toThrow()
  })
})
```

Note to implementer: check `harness-store.ts` for the real exported names — `accountRoleRoot`, `createCandidate` (:630), `writeActive` (:570) per `docs/fleet-integration-plan.md` T2. Use the actual signatures found there; the writeActive call shape above mirrors its use in `harness-store.ts:activateCandidate`. Adjust the seed helper accordingly, and for idempotence compare everything except the `renderedAt` field (strip it before comparing, or pass a fixed `now` via an optional `opts.now` param — add that param if needed).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd opencode-plugin && bun test test/fleet-render.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// opencode-plugin/src/fleet/render.ts
/**
 * render.ts — compose a role's 4 layers into a platform persona file
 * (spec §5 render step, §10: store is truth, files are rendered outputs).
 * Stamp = attribution backbone: scores route to the versions that RAN.
 */
import { mkdirSync } from "node:fs"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { roleSpec } from "./roles.ts"
import { readActiveSquadDef } from "./squad-def.ts"
import { layerStoreRoots, parsePins } from "../bench/record.ts"
import { composeHarness } from "../compose.ts"
import { die, log, writeTextAtomic } from "../bench/util.ts"

export interface RenderStamp {
  versions: Record<string, string>
  harnessHash: string
  renderedAt: string
}

const STAMP_RE = /<!-- mh-render (\{.*?\}) -->/s

export function parseStamp(md: string): RenderStamp | null {
  const m = STAMP_RE.exec(md)
  if (!m) return null
  try { return JSON.parse(m[1]) as RenderStamp } catch { return null }
}

function frontmatter(role: string): string {
  const s = roleSpec(role)
  const perm = Object.entries(s.permission).map(([k, v]) => `  ${k}: ${v}`).join("\n")
  return [
    "---",
    `description: ${s.description}`,
    `mode: ${s.mode}`,
    `model: ${s.model}`,
    `temperature: ${s.temperature}`,
    "permission:",
    perm,
    "---",
  ].join("\n")
}

export function renderRole(
  project: string,
  role: string,
  opts?: { pins?: Record<string, string>; force?: boolean; squadType?: string; now?: string },
): { path: string; stamp: RenderStamp } {
  const s = roleSpec(role)
  const def = readActiveSquadDef(opts?.squadType ?? "standard")

  // Compose the body from the role's layer roots (global+role × account+project),
  // honoring pins. composeHarness/layerStoreRoots signatures per compose.ts /
  // bench/record.ts — implementer: read those two files and call exactly as
  // cmd-run.ts does for --agent runs (record.ts:56,73 reuse per T1 plan).
  const roots = layerStoreRoots("global", s.agent, project)
  const composed = composeHarness(roots, opts?.pins ?? {})
  const body = composed.text
  const versions = composed.versions   // Record<layerName, version> — adapt to the real return shape

  // Render lint (spec §1.5 rule 3): body must teach at least one wire OR-group.
  const groups = def.wire.headings[role] ?? []
  const taught = groups.length === 0 || groups.some((g) => g.every((h) => body.includes(h)))
  if (!taught) {
    if (!opts?.force) die(`render lint: mh-${role} body never mentions its wire headings (${groups.map((g) => g.join("+")).join(" | ")}) — fix the prompt or pass --force`)
    log(`WARNING: --force render of mh-${role} without wire headings`)
  }

  const stampBase = { versions, harnessHash: createHash("sha256").update(body).digest("hex").slice(0, 16) }
  const stamp: RenderStamp = { ...stampBase, renderedAt: opts?.now ?? new Date().toISOString() }
  const md = `${frontmatter(role)}\n<!-- mh-render ${JSON.stringify(stamp)} -->\n${body}\n`

  const dir = join(project, ".opencode", "agents")
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `mh-${role}.md`)

  // Idempotence: if existing file differs only in renderedAt, keep it byte-stable.
  try {
    const prev = readFileSync(path, "utf-8")
    const prevStamp = parseStamp(prev)
    if (prevStamp && prevStamp.harnessHash === stamp.harnessHash
        && JSON.stringify(prevStamp.versions) === JSON.stringify(stamp.versions)) {
      return { path, stamp: prevStamp }
    }
  } catch { /* no existing file */ }

  writeTextAtomic(path, md)
  return { path, stamp }
}

export function cmdRolesRender(args: { project: string; roles?: string[]; pins?: string[]; force?: boolean }): void {
  const roles = args.roles?.length ? args.roles : ["analyzer", "designer", "implementer", "evaluator"]
  const pins = args.pins?.length ? parsePins(args.pins) : {}
  for (const role of roles) {
    const { path, stamp } = renderRole(args.project, role, { pins, force: args.force })
    log(`rendered ${path} (hash ${stamp.harnessHash})`)
  }
}
```

Implementer note (binding to real code): `composeHarness`'s actual signature and return shape live in `opencode-plugin/src/compose.ts`; `layerStoreRoots`/`parsePins` in `opencode-plugin/src/bench/record.ts` (per `docs/fleet-integration-plan.md`: record.ts:56,73). Read both files first and adapt the two calls + `versions` extraction to reality — everything else in this file stands as written. Also add a `squad-def-init` CLI case that calls `writeSquadDefV1(STANDARD_SQUAD)` (idempotent-refuse is already in the store fn).

CLI wiring in `cli.ts` (follow the existing switch pattern):

```ts
case "squad-def-init": {
  writeSquadDefV1(STANDARD_SQUAD)
  log("squad def 'standard' v1 written + active")
  return 0
}
case "roles-render": {
  const a = parseRolesRenderArgs(rest)   // --project DIR (required), --role R (repeatable), --pin L=vN (repeatable), --force
  cmdRolesRender(a)
  return 0
}
```

Write `parseRolesRenderArgs` beside the other arg parsers in cli.ts, same die-on-missing-value style (see `--k` parsing at cli.ts:183 for the pattern).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd opencode-plugin && bun test test/fleet-render.test.ts`
Expected: PASS

- [ ] **Step 5: Manual CLI smoke (no tokens)**

Run: `cd /tmp && mkdir -p rr-demo && META_HARNESS_HOME=/tmp/rr-home bun ~/z2/meta-harness/term-bench2/runner.ts squad-def-init && bun ~/z2/meta-harness/term-bench2/runner.ts roles-render --project /tmp/rr-demo || echo "expected die: no layers seeded"`
Expected: squad-def-init succeeds; roles-render dies actionably (no active layers yet) — confirms wiring, not silence.

- [ ] **Step 6: Commit**

```bash
git add opencode-plugin/src/fleet/render.ts opencode-plugin/src/bench/cli.ts opencode-plugin/test/fleet-render.test.ts
git commit -m "feat(fleet): roles-render — compose layers → persona md with render stamp + wire lint (spec §5, §10)"
```

---

### Task 4: Importer — `fleet/import.ts` + `roles-import` subcommand

**Files:**
- Create: `opencode-plugin/src/fleet/import.ts`
- Create: `opencode-plugin/test/fixtures/fleet/architect.md`, `implementer.md`, `evaluator.md` (synthesized personas — real heading vocabulary, NOT oc-test copies)
- Modify: `opencode-plugin/src/bench/cli.ts` (add `roles-import` case)
- Test: `opencode-plugin/test/fleet-import.test.ts`

**Interfaces:**
- Consumes: `accountRoleRoot`, `createCandidate`, `writeActive` from `../harness-store.ts`; `roleSpec` (Task 1).
- Produces:
  ```ts
  export function cmdRolesImport(args: {
    from: string                 // dir containing <name>.md source personas
    roles?: string[]             // default: all four
    force?: boolean              // overwrite non-empty active
    map?: Record<string, string[]>  // e.g. { architect: ["analyzer", "designer"] }
  }): void
  ```
- Behavior: for each target role, find its source file — either `<from>/<role>.md`, or a mapped source (`map` lets one source seed several roles: the oc-test 3-role→4-role interim, spec §11 until the fleet-side doctrine split lands). Strip YAML frontmatter if present. Write body verbatim as account-role `v1` + activate. Refuse if the role store already has a non-empty active unless `--force`. Body verbatim = wire contract intact (dedup later, per fleet-integration-plan T2).

- [ ] **Step 1: Write fixtures + the failing test**

`opencode-plugin/test/fixtures/fleet/architect.md`:

```markdown
---
description: analyst-designer (fixture)
---
You are the Architect (fixture). For analysis emit `## Use Cases` and
`## Functional Spec`, or escalate with `## Clarify`. For design emit
`## Alternatives` and `## Recommended`.
```

`implementer.md` fixture body: mentions `## Implementation Report`. `evaluator.md` fixture body: mentions `## Test Spec` and `VERDICT:`.

```ts
// opencode-plugin/test/fleet-import.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cmdRolesImport } from "../src/fleet/import.ts"
import { accountRoleRoot, readActiveSystem } from "../src/harness-store.ts" // use real reader name from harness-store.ts

const FIXTURES = join(import.meta.dir, "fixtures", "fleet")
let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "mh-import-")); process.env.META_HARNESS_HOME = home })
afterEach(() => { delete process.env.META_HARNESS_HOME; rmSync(home, { recursive: true, force: true }) })

describe("roles-import", () => {
  test("architect maps to analyzer+designer; frontmatter stripped; v1 active", () => {
    cmdRolesImport({ from: FIXTURES, map: { architect: ["analyzer", "designer"] }, roles: ["analyzer", "designer", "implementer", "evaluator"] })
    const analyzer = readActiveSystem(accountRoleRoot("mh-analyzer"))
    expect(analyzer).toContain("## Use Cases")
    expect(analyzer).not.toContain("description: analyst-designer") // frontmatter gone
    expect(readActiveSystem(accountRoleRoot("mh-designer"))).toContain("## Alternatives")
    expect(readActiveSystem(accountRoleRoot("mh-evaluator"))).toContain("VERDICT:")
  })

  test("refuses second import without --force, succeeds with it", () => {
    const args = { from: FIXTURES, map: { architect: ["analyzer", "designer"] } }
    cmdRolesImport(args)
    expect(() => cmdRolesImport(args)).toThrow(/--force/)
    expect(() => cmdRolesImport({ ...args, force: true })).not.toThrow()
  })

  test("missing source file dies naming the path", () => {
    expect(() => cmdRolesImport({ from: "/nonexistent" })).toThrow(/nonexistent/)
  })
})
```

(Real reader name: check `harness-store.ts` for `readActiveSystem` — evolution-loop.md references it; adapt import name if it differs.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd opencode-plugin && bun test test/fleet-import.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// opencode-plugin/src/fleet/import.ts
/**
 * import.ts — one-time doctrine → account-role v1 (spec §10: imported ONCE,
 * store owns truth after). `map` bridges the 3-role oc-test doctrine to the
 * 4-role squad until the fleet-side split lands (spec §11): one source body
 * may seed several role stores VERBATIM.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { accountRoleRoot, createCandidate, writeActive, readActiveSystem } from "../harness-store.ts"
import { roleSpec } from "./roles.ts"
import { die, log } from "../bench/util.ts"

function stripFrontmatter(text: string): string {
  if (!text.startsWith("---\n")) return text
  const end = text.indexOf("\n---\n", 4)
  return end === -1 ? text : text.slice(end + 5)
}

export function cmdRolesImport(args: {
  from: string
  roles?: string[]
  force?: boolean
  map?: Record<string, string[]>
}): void {
  const targets = args.roles?.length ? args.roles : ["analyzer", "designer", "implementer", "evaluator"]
  // invert map: target role -> source basename
  const sourceOf: Record<string, string> = {}
  for (const t of targets) sourceOf[t] = t
  for (const [src, dests] of Object.entries(args.map ?? {})) {
    for (const d of dests) sourceOf[d] = src
  }

  for (const role of targets) {
    const spec = roleSpec(role)
    const srcPath = join(args.from, `${sourceOf[role]}.md`)
    if (!existsSync(srcPath)) die(`roles-import: source not found: ${srcPath}`)
    const body = stripFrontmatter(readFileSync(srcPath, "utf-8")).trim() + "\n"

    const root = accountRoleRoot(spec.agent)
    const existing = readActiveSystem(root)
    if (existing && existing.trim() !== "" && !args.force) {
      die(`roles-import: ${spec.agent} already has an active body — pass --force to overwrite`)
    }
    createCandidate(root, "v1", body)
    writeActive(root, "v1", body, null, null, null, null)
    log(`imported ${srcPath} -> ${spec.agent} account-role v1 (active)`)
  }
}
```

Implementer note: `createCandidate`/`writeActive`/`readActiveSystem` real signatures live in `harness-store.ts` (:630, :570 per fleet-integration-plan). If `createCandidate` refuses an existing v1, wrap the `--force` path to remove/rewrite via whatever overwrite mechanism the store exposes — mirror how tests in `test/` exercise those functions today.

CLI case (`cli.ts`): `roles-import --from DIR [--role R]... [--force] [--map SRC=DEST1,DEST2]...`, parse `--map architect=analyzer,designer` into the map record.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd opencode-plugin && bun test test/fleet-import.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add opencode-plugin/src/fleet/import.ts opencode-plugin/test/fixtures/fleet opencode-plugin/src/bench/cli.ts opencode-plugin/test/fleet-import.test.ts
git commit -m "feat(fleet): roles-import — doctrine → account-role v1 with 3→4 role map (spec §10, §11)"
```

---

### Task 5: Headless role drive — `fleet/pending.ts` + `fleet/run.ts` + `role-run`

**Files:**
- Create: `opencode-plugin/src/fleet/pending.ts`
- Create: `opencode-plugin/src/fleet/run.ts`
- Create: `opencode-plugin/test/fixtures/fleet/trace-single-turn.ndjson`, `trace-multi-turn.ndjson` (synthesize from the shapes `drivers/opencode.ts parseOutput` consumes; include `step_finish` events carrying `sessionID`, `tokens`, `cost` — copy the field layout from existing bench test fixtures for the opencode driver)
- Modify: `opencode-plugin/src/bench/cli.ts` (add `role-run` case)
- Test: `opencode-plugin/test/fleet-run.test.ts`

**Interfaces:**
- Consumes: `renderRole`/`parseStamp` (Task 3); `opencodeDriver` (`parseOutput`, `classifyAttempt`) from `../bench/drivers/opencode.ts`; `writeJsonAtomic`.
- Produces:
  ```ts
  // pending.ts
  export interface FleetPendingSession {
    id: string; role: string; agent: string; project: string; model: string
    turnCount: number; toolUsage: Record<string, number>
    payload: string; events: unknown[]
    nodePath?: string; sliceId?: string
    renderStamp?: RenderStamp
    tokens?: { input: number; output: number }; cost?: number
    ts: string
  }
  export function pendingDir(project: string): string   // <project>/.meta-harness/runtime/fleet
  export function writePending(p: FleetPendingSession): void
  export function readPending(project: string, id: string): FleetPendingSession  // die listing pending ids if missing
  export function archivePending(project: string, id: string): void              // move json → scored/ subdir
  export function listPending(project: string): string[]

  // run.ts
  export interface RoleRunResult { id: string; payload: string; turnCount: number; toolUsage: Record<string, number> }
  export type ExecFn = (argv: string[], opts: { timeoutSec: number }) => Promise<{ stdout: string; rc: number }>
  export function extractFinalPayload(ndjsonEvents: unknown[]): string
  export async function cmdRoleRun(args: {
    project: string; role: string; input: string
    model?: string; nodePath?: string; sliceId?: string; timeoutSec?: number; json?: boolean
  }, execFn?: ExecFn): Promise<RoleRunResult>
  ```
- Spawn argv (prod execFn): `["opencode", "run", "--dir", project, "--agent", "mh-<role>", "--auto", "--format", "json", ...(model ? ["--model", model] : []), input]` — the `runJudgeOpencode` shape (opencode-run.ts:92-106).
- id = real opencode `sessionID` (`ses_…`) extracted from any NDJSON event (T0 result 4); fallback `fleet-<role>-<epochSec>-<hex3>` if extraction fails.
- `turnCount === 0` → die, write nothing (0-turn runs never pollute fitness).
- classify: auth → die with hint; transient/timeout → die "re-drive" (no retry loop — the runner/master owns retries).
- `extractFinalPayload` = joined text of the LAST step_finish-delimited segment (final message IS the payload — judge's join-all is wrong for multi-turn).

- [ ] **Step 1: Write the failing test** (injectable execFn — zero tokens)

```ts
// opencode-plugin/test/fleet-run.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cmdRoleRun, extractFinalPayload } from "../src/fleet/run.ts"
import { listPending, readPending } from "../src/fleet/pending.ts"

const FIXTURES = join(import.meta.dir, "fixtures", "fleet")
const multiTurn = readFileSync(join(FIXTURES, "trace-multi-turn.ndjson"), "utf-8")

let home: string, project: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mh-run-")); project = mkdtempSync(join(tmpdir(), "mh-run-proj-"))
  process.env.META_HARNESS_HOME = home
  // Seed: squad def + analyzer layer + render, so role-run's "rendered md exists" check passes.
  // (reuse the seeding helper pattern from fleet-render.test.ts — factor into test/fleet-helpers.ts)
})
afterEach(() => { delete process.env.META_HARNESS_HOME; rmSync(home, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true }) })

describe("role-run", () => {
  test("happy path: spawns argv, extracts real sessionID, writes pending, returns payload", async () => {
    let seenArgv: string[] = []
    const execFn = async (argv: string[]) => { seenArgv = argv; return { stdout: multiTurn, rc: 0 } }
    const res = await cmdRoleRun({ project, role: "analyzer", input: "add slugify()" }, execFn)
    expect(seenArgv.slice(0, 2)).toEqual(["opencode", "run"])
    expect(seenArgv).toContain("--agent"); expect(seenArgv).toContain("mh-analyzer")
    expect(res.id).toMatch(/^ses_/)                        // real sessionID from fixture
    expect(res.payload).toContain("## Use Cases")          // final-segment payload, fixture-defined
    const pending = readPending(project, res.id)
    expect(pending.renderStamp).toBeTruthy()
    expect(pending.turnCount).toBeGreaterThan(0)
  })

  test("0-turn output dies and writes nothing", async () => {
    const execFn = async () => ({ stdout: "", rc: 0 })
    await expect(cmdRoleRun({ project, role: "analyzer", input: "x" }, execFn)).rejects.toThrow(/0 turns|no events/)
    expect(listPending(project)).toEqual([])
  })

  test("missing rendered md dies with 'roles-render first'", async () => {
    const bare = mkdtempSync(join(tmpdir(), "mh-bare-"))
    await expect(cmdRoleRun({ project: bare, role: "analyzer", input: "x" }, async () => ({ stdout: multiTurn, rc: 0 })))
      .rejects.toThrow(/roles-render/)
    rmSync(bare, { recursive: true, force: true })
  })

  test("extractFinalPayload returns only the last step_finish segment", () => {
    const events = multiTurn.trim().split("\n").map((l) => JSON.parse(l))
    const payload = extractFinalPayload(events)
    expect(payload).toContain("## Use Cases")
    expect(payload).not.toContain("intermediate exploration") // earlier-turn text, fixture-defined
  })
})
```

Fixture authoring: open an existing opencode-driver test in `opencode-plugin/test/` (the cross-driver contract suite from bench) and copy the exact NDJSON event field layout it uses; `trace-multi-turn.ndjson` = two step_finish segments, first containing the string `intermediate exploration`, last containing `## Use Cases` + `## Functional Spec`, any event carrying `sessionID: "ses_test0001"`, step_finish carrying `tokens`/`cost`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd opencode-plugin && bun test test/fleet-run.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write pending.ts**

```ts
// opencode-plugin/src/fleet/pending.ts
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs"
import { join } from "node:path"
import type { RenderStamp } from "./render.ts"
import { die, writeJsonAtomic } from "../bench/util.ts"

export interface FleetPendingSession {
  id: string; role: string; agent: string; project: string; model: string
  turnCount: number; toolUsage: Record<string, number>
  payload: string; events: unknown[]
  nodePath?: string; sliceId?: string
  renderStamp?: RenderStamp
  tokens?: { input: number; output: number }; cost?: number
  ts: string
}

const sanitize = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_")

export function pendingDir(project: string): string {
  return join(project, ".meta-harness", "runtime", "fleet")
}

export function writePending(p: FleetPendingSession): void {
  const dir = pendingDir(p.project)
  mkdirSync(dir, { recursive: true })
  writeJsonAtomic(join(dir, `${sanitize(p.id)}.json`), p)
}

export function listPending(project: string): string[] {
  const dir = pendingDir(project)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5))
}

export function readPending(project: string, id: string): FleetPendingSession {
  const p = join(pendingDir(project), `${sanitize(id)}.json`)
  if (!existsSync(p)) die(`no pending fleet session '${id}' — pending: [${listPending(project).join(", ")}]`)
  return JSON.parse(readFileSync(p, "utf-8")) as FleetPendingSession
}

export function archivePending(project: string, id: string): void {
  const dir = pendingDir(project)
  const scored = join(dir, "scored")
  mkdirSync(scored, { recursive: true })
  renameSync(join(dir, `${sanitize(id)}.json`), join(scored, `${sanitize(id)}.json`))
}
```

- [ ] **Step 4: Write run.ts**

```ts
// opencode-plugin/src/fleet/run.ts
/**
 * run.ts — headless leaf-node drive (spec §5): render check → spawn via
 * AgentDriver shapes → parse → classify → pending file. No retry loop here:
 * the squad runner / master owns retries (spec §3).
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { roleSpec } from "./roles.ts"
import { parseStamp } from "./render.ts"
import { writePending, type FleetPendingSession } from "./pending.ts"
import { opencodeDriver } from "../bench/drivers/opencode.ts"  // adapt to the real export name in drivers/index.ts
import { die, log } from "../bench/util.ts"

export interface RoleRunResult { id: string; payload: string; turnCount: number; toolUsage: Record<string, number> }
export type ExecFn = (argv: string[], opts: { timeoutSec: number }) => Promise<{ stdout: string; rc: number }>

const defaultExec: ExecFn = async (argv, { timeoutSec }) => {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => proc.kill(), timeoutSec * 1000)
  const stdout = await new Response(proc.stdout).text()
  const rc = await proc.exited
  clearTimeout(timer)
  return { stdout, rc }
}

/** Last step_finish-delimited segment's joined text — the final message IS
 * the payload (fleet wire contract). */
export function extractFinalPayload(events: unknown[]): string {
  // Segment boundaries = step_finish events. Collect text parts per segment,
  // return the last non-empty segment's text. Field names: mirror
  // drivers/opencode.ts parseOutput's event handling — implementer reads that
  // file and uses the same text-extraction fields it does.
  const segments: string[][] = [[]]
  for (const ev of events as Array<Record<string, unknown>>) {
    const type = ev["type"]
    if (type === "step_finish") { segments.push([]); continue }
    const text = extractTextLikeParseOutputDoes(ev)   // same fields parseOutput reads
    if (text) segments[segments.length - 1].push(text)
  }
  for (let i = segments.length - 1; i >= 0; i--) {
    const joined = segments[i].join("\n").trim()
    if (joined) return joined
  }
  return ""
}

export async function cmdRoleRun(
  args: { project: string; role: string; input: string; model?: string; nodePath?: string; sliceId?: string; timeoutSec?: number; json?: boolean },
  execFn: ExecFn = defaultExec,
): Promise<RoleRunResult> {
  const spec = roleSpec(args.role)
  const mdPath = join(args.project, ".opencode", "agents", `${spec.agent}.md`)
  if (!existsSync(mdPath)) die(`no rendered persona at ${mdPath} — run roles-render first`)
  const stamp = parseStamp(readFileSync(mdPath, "utf-8")) ?? undefined

  const model = args.model ?? spec.model
  const argv = ["opencode", "run", "--dir", args.project, "--agent", spec.agent, "--auto", "--format", "json", "--model", model, args.input]
  const { stdout, rc } = await execFn(argv, { timeoutSec: args.timeoutSec ?? 600 })

  const parsed = opencodeDriver.parseOutput(stdout)       // events, turnCount, toolUsage — real shape from drivers/opencode.ts
  const cls = opencodeDriver.classifyAttempt(stdout, rc)  // real signature from drivers/types.ts
  if (cls.kind === "auth") die(`auth error driving ${spec.agent}: ${cls.hint ?? "check opencode auth"}`)
  if (cls.kind === "transient" || cls.kind === "timeout") die(`${cls.kind} driving ${spec.agent} — re-drive`)
  if (parsed.turnCount === 0 || parsed.events.length === 0) die(`${spec.agent} produced 0 turns / no events — nothing recorded`)

  const fromEvents = extractSessionId(parsed.events)      // scan events for sessionID "ses_…"
  const id = fromEvents ?? `fleet-${args.role}-${Math.floor(Date.now() / 1000)}-${randomBytes(3).toString("hex")}`
  const payload = extractFinalPayload(parsed.events)

  const pending: FleetPendingSession = {
    id, role: args.role, agent: spec.agent, project: args.project, model,
    turnCount: parsed.turnCount, toolUsage: parsed.toolUsage,
    payload, events: parsed.events,
    nodePath: args.nodePath, sliceId: args.sliceId, renderStamp: stamp,
    tokens: sumTokens(parsed.events), cost: sumCost(parsed.events),
    ts: new Date().toISOString(),
  }
  writePending(pending)

  if (args.json) console.log(JSON.stringify({ id, payload, turnCount: parsed.turnCount, toolUsage: parsed.toolUsage }))
  else { console.log(payload); console.error(`id: ${id}`) }
  return { id, payload, turnCount: parsed.turnCount, toolUsage: parsed.toolUsage }
}
```

Implementer notes (bind to reality, everything else stands): (1) the driver export + `parseOutput`/`classifyAttempt` signatures come from `src/bench/drivers/opencode.ts` and `drivers/types.ts` — read them first; the classification kinds above (`auth`/`transient`/`timeout`) mirror the AUTH_ERROR/timeout marks those files define. (2) `extractTextLikeParseOutputDoes`, `extractSessionId`, `sumTokens`, `sumCost` = four ~5-line helpers reading the same event fields `parseOutput` and the T0-captured traces use; write them against the fixture layout. (3) CLI case `role-run`: `--project DIR --role R [--model M] [--node-path P] [--slice-id S] [--timeout-sec N] [--json] (--input-file F | "input")`.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd opencode-plugin && bun test test/fleet-run.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add opencode-plugin/src/fleet/pending.ts opencode-plugin/src/fleet/run.ts opencode-plugin/test/fixtures/fleet opencode-plugin/src/bench/cli.ts opencode-plugin/test/fleet-run.test.ts
git commit -m "feat(fleet): role-run — headless drive via opencode driver, pending capture, final-segment payload (spec §5)"
```

---

### Task 6: Scoring — `fleet/score.ts` + `role-score` subcommand

**Files:**
- Create: `opencode-plugin/src/fleet/score.ts`
- Modify: `opencode-plugin/src/bench/cli.ts` (add `role-score` case)
- Test: `opencode-plugin/test/fleet-score.test.ts`

**Interfaces:**
- Consumes: `readPending`, `archivePending` (Task 5); `recordToStores` from `../bench/record.ts` (record.ts:281, pins param :308); `roleSpec` (Task 1).
- Produces:
  ```ts
  export type FleetGate = "gate1" | "gate2" | "verdict" | "merge" | "lint" | "infeasible"
  export async function cmdRoleScore(args: {
    project: string; id: string; verdict: "good" | "bad"
    note?: string; nodePath?: string; gate?: FleetGate
  }): Promise<void>
  ```
- Behavior (spec §6 D5): read pending (die if missing/already scored) → build env `{driver:"opencode", harnessHash, fleet:{nodePath, sliceId, gate}}` → `recordToStores(sliceId ?? role, id, verdict==="good", turnCount, toolUsage, model, "", "global", project, false, agent, stampVersionsAsPins, env, events, false)` — **stamp versions as pins** = scores route to the exact versions that RAN, immune to activation drift → archive pending.
- `Refused` guard: if `detectEscalation(pending.payload)?.type === "Refused"` → die `"Refused sessions are never scored (spec §3.3.1)"`.

- [ ] **Step 1: Write the failing test**

```ts
// opencode-plugin/test/fleet-score.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cmdRoleScore } from "../src/fleet/score.ts"
import { writePending } from "../src/fleet/pending.ts"
import { accountRoleRoot, readScore } from "../src/harness-store.ts" // real reader name — score.json accessor

let home: string, project: string
const basePending = (id: string, payload = "## Use Cases\nx") => ({
  id, role: "analyzer", agent: "mh-analyzer", project: "", model: "anthropic/claude-haiku-4-5",
  turnCount: 3, toolUsage: { read: 2 }, payload, events: [{ type: "step_finish" }],
  renderStamp: { versions: { "account-role": "v1" }, harnessHash: "abc123", renderedAt: "2026-07-13T00:00:00Z" },
  nodePath: "root/demo/analyzer", sliceId: "demo-slice", ts: "2026-07-13T00:00:00Z",
})

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mh-score-")); project = mkdtempSync(join(tmpdir(), "mh-score-proj-"))
  process.env.META_HARNESS_HOME = home
})
afterEach(() => { delete process.env.META_HARNESS_HOME; rmSync(home, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true }) })

describe("role-score", () => {
  test("good score lands on the STAMPED version with fleet provenance; pending archived", async () => {
    writePending({ ...basePending("ses_a1"), project })
    await cmdRoleScore({ project, id: "ses_a1", verdict: "good", gate: "gate1", nodePath: "root/demo/analyzer" })
    const score = readScore(accountRoleRoot("mh-analyzer"), "v1")   // stamped v1, not whatever is active
    expect(score.nPass).toBe(1)
    const rec = score.sessions[0]
    expect(rec.env?.fleet?.gate).toBe("gate1")
    expect(rec.env?.fleet?.nodePath).toBe("root/demo/analyzer")
    expect(existsSync(join(project, ".meta-harness/runtime/fleet/scored/ses_a1.json"))).toBe(true)
  })

  test("double-score refused; missing id dies listing pending", async () => {
    writePending({ ...basePending("ses_b2"), project })
    await cmdRoleScore({ project, id: "ses_b2", verdict: "bad", gate: "verdict" })
    await expect(cmdRoleScore({ project, id: "ses_b2", verdict: "good" })).rejects.toThrow(/pending|already/)
    await expect(cmdRoleScore({ project, id: "nope", verdict: "good" })).rejects.toThrow(/ses_/)  // lists existing? empty ok — assert error mentions 'no pending'
  })

  test("Refused payload is never scored", async () => {
    writePending({ ...basePending("ses_c3", "## Refused\nharmful"), project })
    await expect(cmdRoleScore({ project, id: "ses_c3", verdict: "bad" })).rejects.toThrow(/never scored/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd opencode-plugin && bun test test/fleet-score.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// opencode-plugin/src/fleet/score.ts
/**
 * score.ts — headless fitness entry (spec §6): pending session + gate
 * adjudication → recordToStores on the STAMPED versions (pins), fleet
 * provenance in env. Refused sessions are constitutionally unscoreable
 * (spec §3.3.1).
 */
import { archivePending, readPending } from "./pending.ts"
import { detectEscalation } from "./squad-def.ts"
import { recordToStores } from "../bench/record.ts"
import { die, log } from "../bench/util.ts"

export type FleetGate = "gate1" | "gate2" | "verdict" | "merge" | "lint" | "infeasible"

export async function cmdRoleScore(args: {
  project: string; id: string; verdict: "good" | "bad"
  note?: string; nodePath?: string; gate?: FleetGate
}): Promise<void> {
  const pending = readPending(args.project, args.id)

  if (detectEscalation(pending.payload)?.type === "Refused") {
    die(`session ${args.id} carries a Refused escalation — never scored (spec §3.3.1); archive manually if needed`)
  }

  const env = {
    driver: "opencode",
    harnessHash: pending.renderStamp?.harnessHash,
    fleet: {
      nodePath: args.nodePath ?? pending.nodePath ?? null,
      sliceId: pending.sliceId ?? null,
      gate: args.gate ?? null,
      note: args.note ?? null,
    },
  }
  const pins = pending.renderStamp?.versions ?? {}

  // recordToStores signature: bench/record.ts:281 (pins param :308). Call
  // exactly as bench cmd-run does for --agent runs, with passed=verdict==="good",
  // agent=pending.agent, layers="global", project=args.project, noStore=false,
  // env, events=pending.events, saveAllTraj=false.
  recordToStores(
    pending.sliceId ?? pending.role, pending.id, args.verdict === "good",
    pending.turnCount, pending.toolUsage, pending.model, "", "global",
    args.project, false, pending.agent, pins, env, pending.events, false,
  )
  archivePending(args.project, args.id)
  log(`scored ${args.id} ${args.verdict} (gate=${args.gate ?? "-"}) on stamped ${JSON.stringify(pins)}`)
}
```

Implementer note: `recordToStores`'s real parameter list is authoritative (`bench/record.ts:281`) — align argument order/names to it; the intent of each argument is stated in the comment. `readScore` in the test likewise comes from `harness-store.ts`'s real score reader.

CLI case: `role-score --project DIR --id ID good|bad [--note S] [--node-path P] [--gate G]`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd opencode-plugin && bun test test/fleet-score.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add opencode-plugin/src/fleet/score.ts opencode-plugin/src/bench/cli.ts opencode-plugin/test/fleet-score.test.ts
git commit -m "feat(fleet): role-score — stamped-pin attribution, fleet provenance, Refused never scored (spec §6, §3.3.1)"
```

---

### Task 7: Squad state machine — `fleet/squad.ts` (pure core)

**Files:**
- Create: `opencode-plugin/src/fleet/squad.ts`
- Test: `opencode-plugin/test/fleet-squad.test.ts`

**Interfaces:**
- Consumes: `SquadDef`, `lintPayload`, `detectEscalation`, `parseVerdict` (Task 2); `RoleRunResult` (Task 5).
- Produces:
  ```ts
  export type Phase = "analyzer" | "gate1" | "evaluator-spec" | "designer" | "gate2" | "implementer" | "evaluator-verdict" | "done"
  export interface SquadCounters { r1: Record<string, number>; r2: number; r3: number; steps: number }
  export interface SquadState {
    sliceId: string; slice: string; phase: Phase
    artifacts: { spec?: string; testSpec?: string; alternatives?: string; design?: string; implReport?: string }
    counters: SquadCounters
    pendingGate?: { gate: "gate1" | "gate2"; payload: string }
    history: Array<{ phase: Phase; event: string; id?: string }>
  }
  export type SquadOutcome =
    | { status: "done"; payload: string }
    | { status: "gate"; gate: "gate1" | "gate2"; payload: string }
    | { status: "escalation"; escalation: { type: string; body: string } }
    | { status: "running" }   // internal — runSquad loops until non-running
  export interface DriveResult { id: string; payload: string }
  export type DriveFn = (slot: string, input: string, sliceId: string) => Promise<DriveResult>
  export type ScoreFn = (id: string, verdict: "good" | "bad", gate: string) => Promise<void>
  export function newSquadState(sliceId: string, slice: string): SquadState
  export async function squadStep(state: SquadState, def: SquadDef, drive: DriveFn, score: ScoreFn): Promise<{ state: SquadState; outcome: SquadOutcome }>
  export async function runSquad(state: SquadState, def: SquadDef, drive: DriveFn, score: ScoreFn): Promise<{ state: SquadState; outcome: SquadOutcome }>
  export function answerGate(state: SquadState, answer: "approve" | "revise" | string): SquadState
  ```
- Semantics (spec §3, all 14 rules): each `squadStep` executes ONE phase transition. Drives via `drive(slot, input, sliceId)`; input strings are built by pure `inputFor(phase, state, def)` (slice for analyzer; spec for designer + evaluator-spec; design + reentry context for implementer; diff/implReport + testSpec for evaluator-verdict; re-entry inputs carry `{prior artifact + question}` when `def.flow.reentry === "delta"`). After every drive: `detectEscalation` first (Refused/Infeasible/Exhausted bubble immediately as escalation outcome; Clarify/DesignDecision at analyzer/designer likewise bubble), then `lintPayload` (fail → score bad `lint`, R1 redo or Exhausted), then phase-specific adjudication per the D5 table (auto-gates score good/bad; verdict parses and routes FAIL-impl→implementer (R3), FAIL-design→designer (R2), FAIL-intent→analyzer (R2, invalidates testSpec)). Counters enforce R1/R2/R3/globalBudgetSteps; any exhaustion → `Exhausted` escalation outcome. Gate policy `human` → outcome `{status:"gate"}` with `pendingGate` set; `answerGate` consumes the answer (approve advances + scores good; revise scores bad + re-enters producer phase WITHOUT touching machine counters — human gates own counter is just "not counted").

- [ ] **Step 1: Write the failing tests** — cover: happy path all-auto; lint-fail→redo→pass; verdict FAIL-impl loop within R3 then pass; FAIL-design re-enters designer and testSpec survives; FAIL-intent invalidates testSpec (evaluator-spec re-runs); R3 exhaustion → Exhausted; Clarify at analyzer → escalation; Refused at implementer → escalation AND score fn never called for it; human gate1 → gate outcome, answerGate("approve") continues, answerGate("revise") re-runs analyzer without incrementing r1; globalBudgetSteps cap trips. Use a scripted DriveFn:

```ts
// opencode-plugin/test/fleet-squad.test.ts
import { describe, expect, test } from "bun:test"
import { STANDARD_SQUAD, type SquadDef } from "../src/fleet/squad-def.ts"
import { answerGate, newSquadState, runSquad } from "../src/fleet/squad.ts"

const OK: Record<string, string> = {
  analyzer: "## Use Cases\nu\n## Functional Spec\nf",
  "evaluator-spec": "## Test Spec\n- t1",
  designer: "## Alternatives\nA,B\n## Recommended\nA",
  implementer: "## Implementation Report\ndone",
  "evaluator-verdict": "## Test Spec\nran\nVERDICT: PASS",
}

/** DriveFn that returns queued payloads per slot, falling back to OK. */
function scripted(queues: Record<string, string[]>) {
  const scores: Array<{ id: string; verdict: string; gate: string }> = []
  let n = 0
  const drive = async (slot: string, _input: string) => {
    const q = queues[slot]
    const payload = q?.length ? q.shift()! : OK[slot]
    return { id: `d${++n}-${slot}`, payload: payload! }
  }
  const score = async (id: string, verdict: "good" | "bad", gate: string) => { scores.push({ id, verdict, gate }) }
  return { drive, score, scores }
}

const AUTO: SquadDef = STANDARD_SQUAD // gate1/gate2 auto by default

describe("squad runner", () => {
  test("happy path: done with implementer payload; every slot scored good once", async () => {
    const { drive, score, scores } = scripted({})
    const { outcome } = await runSquad(newSquadState("s1", "add slugify"), AUTO, drive, score)
    expect(outcome.status).toBe("done")
    expect(scores.filter((s) => s.verdict === "good").length).toBeGreaterThanOrEqual(4)
  })

  test("lint fail scores bad + redoes within R1, then passes", async () => {
    const { drive, score, scores } = scripted({ analyzer: ["not a payload", OK.analyzer] })
    const { outcome } = await runSquad(newSquadState("s2", "x"), AUTO, drive, score)
    expect(outcome.status).toBe("done")
    expect(scores.some((s) => s.gate === "lint" && s.verdict === "bad")).toBe(true)
  })

  test("VERDICT FAIL-impl loops implementer within R3 then passes", async () => {
    const { drive, score, scores } = scripted({
      "evaluator-verdict": ["## Test Spec\nx\nVERDICT: FAIL cause=impl", OK["evaluator-verdict"]],
    })
    const { outcome } = await runSquad(newSquadState("s3", "x"), AUTO, drive, score)
    expect(outcome.status).toBe("done")
    expect(scores.filter((s) => s.gate === "verdict" && s.verdict === "bad").length).toBe(1)
  })

  test("R3 exhaustion escalates Exhausted", async () => {
    const failForever = Array(10).fill("VERDICT: FAIL cause=impl\n## Test Spec\nx")
    const { drive, score } = scripted({ "evaluator-verdict": failForever })
    const { outcome } = await runSquad(newSquadState("s4", "x"), AUTO, drive, score)
    expect(outcome.status).toBe("escalation")
    if (outcome.status === "escalation") expect(outcome.escalation.type).toBe("Exhausted")
  })

  test("FAIL-intent invalidates test spec (evaluator-spec redriven)", async () => {
    const { drive, score } = scripted({
      "evaluator-verdict": ["## Test Spec\nx\nVERDICT: FAIL cause=intent", OK["evaluator-verdict"]],
    })
    const state0 = newSquadState("s5", "x")
    const { state, outcome } = await runSquad(state0, AUTO, drive, score)
    expect(outcome.status).toBe("done")
    expect(state.history.filter((h) => h.phase === "evaluator-spec").length).toBe(2)
  })

  test("Clarify escalates; Refused escalates and is never scored", async () => {
    const c = scripted({ analyzer: ["## Clarify\nA or B?"] })
    const r1 = await runSquad(newSquadState("s6", "x"), AUTO, c.drive, c.score)
    expect(r1.outcome.status).toBe("escalation")

    const r = scripted({ implementer: ["## Refused\nharmful"] })
    const r2 = await runSquad(newSquadState("s7", "x"), AUTO, r.drive, r.score)
    expect(r2.outcome.status).toBe("escalation")
    if (r2.outcome.status === "escalation") expect(r2.outcome.escalation.type).toBe("Refused")
    expect(r.scores.find((s) => s.id.includes("implementer"))).toBeUndefined()
  })

  test("human gate1 pauses; approve continues; revise re-runs analyzer without burning R1", async () => {
    const def: SquadDef = { ...AUTO, flow: { ...AUTO.flow, gatePolicy: { gate1: "human", gate2: "auto" } } }
    const { drive, score } = scripted({})
    const first = await runSquad(newSquadState("s8", "x"), def, drive, score)
    expect(first.outcome.status).toBe("gate")
    const revised = answerGate(first.state, "revise")
    expect(revised.counters.r1["analyzer"] ?? 0).toBe(0)
    const second = await runSquad(revised, def, drive, score)
    expect(second.outcome.status).toBe("gate")   // re-ran analyzer, back at gate1
    const approved = answerGate(second.state, "approve")
    const third = await runSquad(approved, def, drive, score)
    expect(third.outcome.status).toBe("done")
  })

  test("globalBudgetSteps trips Exhausted", async () => {
    const def: SquadDef = { ...AUTO, flow: { ...AUTO.flow, bounds: { ...AUTO.flow.bounds, globalBudgetSteps: 2 } } }
    const { drive, score } = scripted({})
    const { outcome } = await runSquad(newSquadState("s9", "x"), def, drive, score)
    expect(outcome.status).toBe("escalation")
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd opencode-plugin && bun test test/fleet-squad.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `fleet/squad.ts`**

Core skeleton (implementer completes the phase table following these exact semantics — every branch is specified by the tests above + spec §3 rules 1–14):

```ts
// opencode-plugin/src/fleet/squad.ts
/**
 * squad.ts — the deterministic squad runner (spec §2, §3): fixed A→D→I→E
 * state machine; flow knobs from SquadDef; every backward edge bounded;
 * exits done | gate | escalation only. Pure core: drive/score injected.
 */
import { detectEscalation, lintPayload, parseVerdict, type SquadDef } from "./squad-def.ts"

// ... (types exactly as the Interfaces block above)

export function newSquadState(sliceId: string, slice: string): SquadState {
  return { sliceId, slice, phase: "analyzer", artifacts: {}, counters: { r1: {}, r2: 0, r3: 0, steps: 0 }, history: [] }
}

function inputFor(phase: Phase, state: SquadState, def: SquadDef): string {
  switch (phase) {
    case "analyzer": return `SLICE:\n${state.slice}`
    case "evaluator-spec": return `Author a test spec from this functional spec (never from code):\n${state.artifacts.spec}`
    case "designer": return `Functional spec:\n${state.artifacts.spec}\nEmit ## Alternatives and ## Recommended.`
    case "implementer": return `Decided design:\n${state.artifacts.design}\nImplement; emit ## Implementation Report.`
    case "evaluator-verdict": return `Test spec:\n${state.artifacts.testSpec}\nImplementation report:\n${state.artifacts.implReport}\nRun checks; emit VERDICT line.`
    default: return ""
  }
}

const SLOT_OF: Record<string, string> = {
  analyzer: "analyzer", "evaluator-spec": "evaluator", designer: "designer",
  implementer: "implementer", "evaluator-verdict": "evaluator",
}

export async function squadStep(state: SquadState, def: SquadDef, drive: DriveFn, score: ScoreFn):
  Promise<{ state: SquadState; outcome: SquadOutcome }> {
  const s: SquadState = structuredClone(state)
  s.counters.steps++
  if (s.counters.steps > def.flow.bounds.globalBudgetSteps) {
    return { state: s, outcome: esc(s, "Exhausted", `global budget ${def.flow.bounds.globalBudgetSteps} steps exceeded`) }
  }

  // Gate phases don't drive — they adjudicate.
  if (s.phase === "gate1" || s.phase === "gate2") {
    const which = s.phase === "gate1" ? def.flow.gatePolicy.gate1 : def.flow.gatePolicy.gate2
    if (which === "human") {
      s.pendingGate = { gate: s.phase, payload: s.phase === "gate1" ? s.artifacts.spec! : s.artifacts.alternatives! }
      return { state: s, outcome: { status: "gate", gate: s.phase, payload: s.pendingGate.payload } }
    }
    // auto: approve / pick recommended — score good, advance
    // gate1 → evaluator-spec; gate2 → materialize design from ## Recommended, → implementer
    // (score the producing drive id recorded in history)
    return autoGate(s, def, score)
  }

  const slot = SLOT_OF[s.phase]
  const { id, payload } = await drive(slot, inputFor(s.phase, s, def), s.sliceId)
  s.history.push({ phase: s.phase, event: "drive", id })

  const escalation = detectEscalation(payload)
  if (escalation) {
    // Refused/Infeasible/Exhausted/Clarify/DesignDecision all bubble (spec §3.3.1).
    // Refused: NO score call, ever. Others: no score here either (adjudication is the human's).
    return { state: s, outcome: { status: "escalation", escalation } }
  }

  const lint = lintPayload(def, slot, payload)
  if (!lint.ok) {
    await score(id, "bad", "lint")
    const r1 = (s.counters.r1[slot] = (s.counters.r1[slot] ?? 0) + 1)
    if (r1 > def.flow.bounds.R1) return { state: s, outcome: esc(s, "Exhausted", `R1 exhausted at ${slot} (missing: ${lint.missing.join(" | ")})`) }
    return { state: s, outcome: { status: "running" } }  // same phase re-drives next step
  }

  // Phase-specific advance (the D5 table, spec §6):
  switch (s.phase) {
    case "analyzer":
      s.artifacts.spec = payload
      s.phase = "gate1"
      s.history.push({ phase: "analyzer", event: "pass", id })
      s.lastDriveId = id   // add this field to SquadState for gate scoring
      return { state: s, outcome: { status: "running" } }
    case "evaluator-spec":
      s.artifacts.testSpec = payload
      await score(id, "good", "lint")     // v1: well-formedness grade (spec §6 evaluator v1)
      s.phase = "designer"
      return { state: s, outcome: { status: "running" } }
    case "designer":
      s.artifacts.alternatives = payload
      s.phase = "gate2"
      s.lastDriveId = id
      return { state: s, outcome: { status: "running" } }
    case "implementer":
      s.artifacts.implReport = payload
      s.phase = "evaluator-verdict"
      s.lastDriveId = id
      return { state: s, outcome: { status: "running" } }
    case "evaluator-verdict": {
      const v = parseVerdict(def, payload)
      if (!v) { /* treat as lint fail path (same R1 counter for evaluator) */ }
      else if (v.verdict === "PASS") {
        await score(id, "good", "lint")
        await score(s.lastDriveId!, "good", "verdict")          // implementer good
        s.phase = "done"
        return { state: s, outcome: { status: "done", payload: s.artifacts.implReport! } }
      } else {
        await score(id, "good", "lint")
        if (v.cause === "impl") {
          await score(s.lastDriveId!, "bad", "verdict")
          if (++s.counters.r3 > def.flow.bounds.R3) return { state: s, outcome: esc(s, "Exhausted", "R3 exhausted") }
          s.phase = "implementer"
        } else if (v.cause === "design") {
          if (++s.counters.r2 > def.flow.bounds.R2) return { state: s, outcome: esc(s, "Exhausted", "R2 exhausted (design)") }
          s.phase = "designer"                                   // implementer absolved (no score)
        } else { // intent
          if (++s.counters.r2 > def.flow.bounds.R2) return { state: s, outcome: esc(s, "Exhausted", "R2 exhausted (intent)") }
          s.artifacts.testSpec = undefined                       // rule 12: invalidate test spec
          s.phase = "analyzer"
        }
        return { state: s, outcome: { status: "running" } }
      }
    }
  }
  return { state: s, outcome: { status: "running" } }
}

export async function runSquad(state: SquadState, def: SquadDef, drive: DriveFn, score: ScoreFn) {
  let cur = { state, outcome: { status: "running" } as SquadOutcome }
  while (cur.outcome.status === "running") cur = await squadStep(cur.state, def, drive, score)
  return cur
}

export function answerGate(state: SquadState, answer: "approve" | "revise" | string): SquadState {
  const s = structuredClone(state)
  if (!s.pendingGate) throw new Error("no pending gate")
  const gate = s.pendingGate.gate
  s.pendingGate = undefined
  if (answer === "revise") {
    s.phase = gate === "gate1" ? "analyzer" : "designer"   // human revise: machine counters untouched (spec §3.7-5)
    // scoring of the revise (bad) happens in the CLI layer where ScoreFn is bound; store lastDriveId for it
  } else {
    s.phase = gate === "gate1" ? "evaluator-spec" : "implementer"
    if (gate === "gate2") s.artifacts.design = materializeDesign(s.artifacts.alternatives!)
  }
  return s
}

/** Gate 2 output: decided design.md = chosen alternative (## Recommended
 * section), per spec §1.5 wire note. */
function materializeDesign(alternatives: string): string { /* extract ## Recommended section + full alternatives as context */ }
```

Implementer finishes: `esc()` helper (builds Exhausted escalation with failure report from history), `autoGate()` (scores `lastDriveId` good with gate name, advances exactly like `answerGate` approve; gate1 auto also sends flow to `evaluator-spec` BEFORE `designer` — sequential v1: evaluator-spec then designer), `materializeDesign`, `lastDriveId?: string` on SquadState, gate-revise scoring hook in `answerGate` callers (CLI Task 8 scores `lastDriveId` bad with the gate name on revise). Keep every branch matched to a test; do not add unrequested behavior.

- [ ] **Step 4: Run tests until green**

Run: `cd opencode-plugin && bun test test/fleet-squad.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add opencode-plugin/src/fleet/squad.ts opencode-plugin/test/fleet-squad.test.ts
git commit -m "feat(fleet): deterministic squad state machine — rules 1-14, D5 scoring, 5-type escalations (spec §3)"
```

---

### Task 8: `squad-run` CLI — checkpoint/resume + gate answers

**Files:**
- Create: `opencode-plugin/src/fleet/squad-cli.ts`
- Modify: `opencode-plugin/src/bench/cli.ts` (add `squad-run` case)
- Test: `opencode-plugin/test/fleet-squad-cli.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 5–7 (`cmdRoleRun` as prod DriveFn, `cmdRoleScore` as prod ScoreFn, `runSquad`, `answerGate`, `newSquadState`, checkpoint helpers below).
- Produces:
  ```ts
  export function checkpointPath(project: string, sliceId: string): string  // <project>/.meta-harness/runtime/fleet/squad-<sliceId>.json
  export function saveCheckpoint(project: string, state: SquadState): void
  export function loadCheckpoint(project: string, sliceId: string): SquadState  // die if missing
  export async function cmdSquadRun(args: {
    project: string; sliceId: string
    slice?: string                       // required unless --resume
    resume?: boolean; gateAnswer?: string
    gatePolicy?: "root-human" | "auto"   // default root-human
    squadType?: string; json?: boolean
  }, driveFn?: DriveFn, scoreFn?: ScoreFn): Promise<SquadOutcome>
  ```
- Behavior (spec §9.1): fresh run = `newSquadState` (with `--gate-policy root-human` overriding def's gatePolicy to human for BOTH gates — instance-position override, spec §1.5 rule 4); resume = `loadCheckpoint` + `answerGate(state, gateAnswer)` (revise also scores the producer drive bad via ScoreFn with the gate name). Loop `runSquad`; on ANY non-running outcome: save checkpoint, print outcome JSON to stdout (`{status, gate?, escalation?, payload?}`), exit 0. Prod DriveFn = `cmdRoleRun({project, role: slot, input, sliceId, json: false})` adapted to the DriveFn shape; prod ScoreFn = `cmdRoleScore({project, id, verdict, gate})`.

- [ ] **Step 1: Write the failing test** — injectable drive/score (same scripted helper as Task 7; import it from a shared `test/fleet-helpers.ts` you extract now):

```ts
// opencode-plugin/test/fleet-squad-cli.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cmdSquadRun, checkpointPath } from "../src/fleet/squad-cli.ts"
import { writeSquadDefV1, STANDARD_SQUAD } from "../src/fleet/squad-def.ts"
import { scripted } from "./fleet-helpers.ts"

let home: string, project: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mh-sq-")); project = mkdtempSync(join(tmpdir(), "mh-sq-proj-"))
  process.env.META_HARNESS_HOME = home
  writeSquadDefV1(STANDARD_SQUAD)
})
afterEach(() => { delete process.env.META_HARNESS_HOME; rmSync(home, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true }) })

describe("squad-run CLI", () => {
  test("root-human: pauses at gate1 with checkpoint; resume approve → gate2… → done", async () => {
    const { drive, score } = scripted({})
    const first = await cmdSquadRun({ project, sliceId: "s1", slice: "add slugify", gatePolicy: "root-human" }, drive, score)
    expect(first.status).toBe("gate")
    expect(existsSync(checkpointPath(project, "s1"))).toBe(true)

    const second = await cmdSquadRun({ project, sliceId: "s1", resume: true, gateAnswer: "approve" }, drive, score)
    expect(second.status).toBe("gate")   // now gate2
    const third = await cmdSquadRun({ project, sliceId: "s1", resume: true, gateAnswer: "approve" }, drive, score)
    expect(third.status).toBe("done")
  })

  test("all-auto runs straight to done; checkpoint recorded", async () => {
    const { drive, score } = scripted({})
    const out = await cmdSquadRun({ project, sliceId: "s2", slice: "x", gatePolicy: "auto" }, drive, score)
    expect(out.status).toBe("done")
  })

  test("resume without checkpoint dies; fresh without slice dies", async () => {
    const { drive, score } = scripted({})
    await expect(cmdSquadRun({ project, sliceId: "nope", resume: true }, drive, score)).rejects.toThrow(/checkpoint/)
    await expect(cmdSquadRun({ project, sliceId: "s3" }, drive, score)).rejects.toThrow(/slice/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd opencode-plugin && bun test test/fleet-squad-cli.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `squad-cli.ts` + CLI case**

```ts
// opencode-plugin/src/fleet/squad-cli.ts
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { readActiveSquadDef, type SquadDef } from "./squad-def.ts"
import { answerGate, newSquadState, runSquad, type DriveFn, type ScoreFn, type SquadOutcome, type SquadState } from "./squad.ts"
import { cmdRoleRun } from "./run.ts"
import { cmdRoleScore, type FleetGate } from "./score.ts"
import { die, writeJsonAtomic } from "../bench/util.ts"

export function checkpointPath(project: string, sliceId: string): string {
  return join(project, ".meta-harness", "runtime", "fleet", `squad-${sliceId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`)
}
export function saveCheckpoint(project: string, state: SquadState): void {
  const p = checkpointPath(project, state.sliceId)
  mkdirSync(dirname(p), { recursive: true })
  writeJsonAtomic(p, state)
}
export function loadCheckpoint(project: string, sliceId: string): SquadState {
  const p = checkpointPath(project, sliceId)
  if (!existsSync(p)) die(`no checkpoint for slice '${sliceId}' at ${p}`)
  return JSON.parse(readFileSync(p, "utf-8")) as SquadState
}

export async function cmdSquadRun(
  args: { project: string; sliceId: string; slice?: string; resume?: boolean; gateAnswer?: string; gatePolicy?: "root-human" | "auto"; squadType?: string; json?: boolean },
  driveFn?: DriveFn, scoreFn?: ScoreFn,
): Promise<SquadOutcome> {
  let def: SquadDef = readActiveSquadDef(args.squadType ?? "standard")
  if ((args.gatePolicy ?? "root-human") === "root-human") {
    def = { ...def, flow: { ...def.flow, gatePolicy: { gate1: "human", gate2: "human" } } }
  }

  const drive: DriveFn = driveFn ?? (async (slot, input, sliceId) => {
    const r = await cmdRoleRun({ project: args.project, role: slot, input, sliceId, nodePath: `root/${sliceId}/${slot}` })
    return { id: r.id, payload: r.payload }
  })
  const score: ScoreFn = scoreFn ?? (async (id, verdict, gate) => {
    await cmdRoleScore({ project: args.project, id, verdict, gate: gate as FleetGate })
  })

  let state: SquadState
  if (args.resume) {
    state = loadCheckpoint(args.project, args.sliceId)
    if (!args.gateAnswer) die("--resume requires --gate-answer approve|revise")
    if (args.gateAnswer === "revise" && state.lastDriveId) {
      await score(state.lastDriveId, "bad", state.pendingGate?.gate ?? "gate1")
    } else if (args.gateAnswer === "approve" && state.lastDriveId) {
      await score(state.lastDriveId, "good", state.pendingGate?.gate ?? "gate1")
    }
    state = answerGate(state, args.gateAnswer as "approve" | "revise")
  } else {
    if (!args.slice) die("fresh squad-run requires a slice (text or --slice-file)")
    state = newSquadState(args.sliceId, args.slice)
  }

  const result = await runSquad(state, def, drive, score)
  saveCheckpoint(args.project, result.state)
  console.log(JSON.stringify(result.outcome))
  return result.outcome
}
```

CLI case: `squad-run --project DIR --slice-id S (--slice "text" | --slice-file F) [--resume --gate-answer approve|revise] [--gate-policy root-human|auto] [--squad-type T] [--json]`.

- [ ] **Step 4: Run test + full suite**

Run: `cd opencode-plugin && bun test test/fleet-squad-cli.test.ts && bun test`
Expected: new tests PASS; full suite still green

- [ ] **Step 5: Commit**

```bash
git add opencode-plugin/src/fleet/squad-cli.ts opencode-plugin/src/bench/cli.ts opencode-plugin/test/fleet-squad-cli.test.ts opencode-plugin/test/fleet-helpers.ts
git commit -m "feat(fleet): squad-run — checkpoint/resume, human gates via exit-and-wait (spec §9.1)"
```

---

### Task 9: E2E — hermetic pipeline test, live smoke script, recipe doc

**Files:**
- Create: `opencode-plugin/test/fleet-e2e.test.ts` (hermetic, zero tokens)
- Create: `smoke/fleet/squad-demo.sh` (live, ~5 haiku-class drives, controller-run only)
- Create: `docs/fleet-integration.md` (the T6 recipe)
- Test: the e2e test itself

**Interfaces:** consumes everything; produces nothing new.

- [ ] **Step 1: Hermetic pipeline test** — the full chain import → render → squad-run(all-auto, scripted NDJSON execFn through the REAL cmdRoleRun) → assert 5+ records across the 4 role stores on STAMPED versions with fleet provenance:

```ts
// opencode-plugin/test/fleet-e2e.test.ts
// Chain: cmdRolesImport(fixtures) → cmdRolesRender(project) → cmdSquadRun with
// the PROD drive fn but an injected ExecFn that returns per-role fixture NDJSON
// (payload text per slot = the OK map from fleet-helpers, wrapped in the
// trace-multi-turn.ndjson event structure with distinct ses_ ids).
// Assertions:
//   - outcome.status === "done"
//   - readScore(accountRoleRoot("mh-analyzer"), "v1").nPass >= 1  (stamped v1)
//   - same for designer/implementer/evaluator stores
//   - a session record env.fleet.nodePath matches /^root\/demo-slice\//
//   - pending dir empty, scored/ has the archived sessions
// Build the per-role ExecFn by matching argv's --agent value → fixture trace.
```

Write it as real code following that comment plan — every helper already exists from Tasks 4–8. This is the plan's acceptance test for spec §8 step 2.

- [ ] **Step 2: Run it**

Run: `cd opencode-plugin && bun test test/fleet-e2e.test.ts`
Expected: PASS

- [ ] **Step 3: Live smoke script**

```bash
# smoke/fleet/squad-demo.sh — live depth-1 squad E2E (controller-run; ~5 haiku drives)
# Prereqs: opencode on PATH + authed; META_HARNESS_HOME optional override.
# 1. tmp project dir + git init
# 2. bun term-bench2/runner.ts squad-def-init            (idempotent-refuse ok)
# 3. bun term-bench2/runner.ts roles-import --from opencode-plugin/test/fixtures/fleet \
#      --map architect=analyzer,designer                 (fixtures, NOT oc-test — repo read-only)
# 4. bun term-bench2/runner.ts roles-render --project "$PROJ"
# 5. bun term-bench2/runner.ts squad-run --project "$PROJ" --slice-id demo \
#      --slice "add slugify(s) to util.sh + a test" --gate-policy auto --json
# 6. print outcome json + per-store score.json nPass/nFail counts
set -euo pipefail
```

Fill in the actual bash (each numbered line = one command block, `PROJ=$(mktemp -d)`, cleanup trap). Mark executable.

- [ ] **Step 4: Recipe doc `docs/fleet-integration.md`** — write these sections, sourcing content from the spec (not new invention): node/squad grammar + nodePath convention (spec §1); the four subcommands + exit statuses (spec §9.1); target prerequisites (opencode.json provider, host auth, NO meta-harness plugin in fleet targets, `.opencode/agents/` dir name); SquadDef + wire contract-change procedure (edit def candidate + `--force` render); D5 score table (copy from spec §6); escalation taxonomy table (spec §3.3.1); T0 probe results (from fleet-integration-plan.md); troubleshooting (auth die, roles-render-first die, checkpoint-missing die); pointer to oc-test KNOWN-ISSUES.md for the bash/shell key.

- [ ] **Step 5: Full suite + commit**

Run: `cd opencode-plugin && bun test`
Expected: all green

```bash
git add opencode-plugin/test/fleet-e2e.test.ts smoke/fleet/squad-demo.sh docs/fleet-integration.md
git commit -m "feat(fleet): depth-1 E2E — hermetic pipeline test, live smoke, integration recipe (spec §8 step 2, T5+T6)"
```

---

## Self-Review

**Spec coverage:** §1 grammar → types in Tasks 2/7 (recursion + CC = typed but die, per §8 ordering). §1.5 SquadDef/wire/flow → Task 2. §3 rules 1–14 → Task 7 (rule 3/6 human counters via answerGate; rule 13/14 via esc + budget). §3.3.1 taxonomy → Tasks 2/6/7 (Refused unscored enforced twice: score.ts guard + squad.ts skip). §3.8 star topology → structural (runner mediates all payloads). §5 drive → Task 5. §6 D5 table → Tasks 6/7. §9.1 checkpoint/resume → Task 8. §10 import-once → Task 4. §11 read-only → fixtures only, smoke uses fixtures. NOT in this plan (deliberate, spec §8): k=5 baseline (operational), CC leaf (probe pending), recursion machinery, tier-2 evolution, master/OpenClaw wiring (fleet-side).

**Placeholder scan:** Tasks 3/5/6 contain "implementer note: bind to real signature" markers for `composeHarness`/`recordToStores`/driver exports — these are deliberate reality-binding instructions naming the exact file+line to read, not TBDs. Task 7 skeleton marks 4 named helpers with specified behavior + tests that force them. Task 9 test written as comment-plan with exact assertions — acceptable: all ingredients defined in prior tasks.

**Type consistency:** `RoleSpec.agent`="mh-<role>" used by render/import/run; `RenderStamp` produced Task 3, consumed 5/6; `FleetPendingSession` 5→6; `DriveFn/ScoreFn` 7→8; `FleetGate` 6→8; `lastDriveId` added to SquadState in Task 7 and used in Task 8 — consistent.

---

Plan complete.
