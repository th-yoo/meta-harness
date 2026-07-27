# False-Accept Probes (Spec-Coverage + Relation Probes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attack the false-accept class (completion gate accepts, grader fails — 100% of real failures across C2+C1+G1) with two new deterministic probe classes in the completion gate, desk-validated against oracle solutions, plus a pre-registered arm spec for the paired verification (arms themselves are spend-gated, NOT part of this plan).

**Architecture:** Two probes run inside the existing completion-gate round, between verify-passes and the mutation probe: (1) **spec-coverage** — a frozen per-task `requirements.json` (compiled by hand from instruction.md, RTM-style) is matched against the agent's verify.sh text (bash comments stripped — anti-gaming); uncovered requirement → round fails, reinject names it. (2) **relation probes** — per-task python scripts (metamorphic/property relations derived ONLY from instruction.md) run against the artifact; violation → round fails, reinject shows the relation + evidence. Both fail-open when a task ships no probe data (gate-plugin and hello-fs unaffected). Design rationale: `docs/2026-07-27-probe-grip-fix-design.md` §5.1.

**Tech Stack:** Bun + TypeScript (`minimal/`), bun:test in `opencode-plugin/test/`, python3 subprocess desk tests (host python 3.12, rdflib 7.6.0 verified present), podman exec wiring in `minimal/run.ts`.

## Global Constraints

- **Invariant 1:** the completion gate NEVER sees or runs the task grader (`tests/`); all probe content derives ONLY from instruction.md + fixtures the agent already sees.
- **Determinism:** no LLM calls, no randomness, no timestamps inside probe logic (grip-fix design S5 decision).
- **Fail-open:** absent `requirements.json` / `relations/` → probes skip silently; `GateIO` additions are optional members; gate-plugin (`gate-plugin/`) must compile and its 26 tests stay green WITHOUT changes to its wiring.
- **No bare "gate"** in docs/comments — say "completion gate" (repo glossary rule).
- **TDD red-first** for every new function; run the failing test before implementing.
- **Oracle artifacts** (answer keys) live in `minimal/tasks/<task>/oracle/` — `run.ts` copies only `fixtures/` into agent containers, so oracle/ never reaches an agent. Keep the terminal-bench canary comment lines intact when copying oracle files.
- Suites that must stay green: `cd opencode-plugin && bun test` (1656 pre-plan), `cd gate-plugin && bun test` (26).
- Commit after every task with the exact message given; do not push mid-plan (single push at the end is fine).

## File Structure

- `minimal/spec-probe.ts` — NEW: requirement types, bash-comment stripping, uncovered-requirement matcher. Pure, no IO.
- `minimal/tasks/headless-terminal/requirements.json` — NEW: 5 requirements (hand-compiled below).
- `minimal/tasks/sparql-university/requirements.json` — NEW: 4 requirements (hand-compiled below).
- `minimal/tasks/headless-terminal/relations/*.py` — NEW: 4 relation scripts.
- `minimal/tasks/sparql-university/relations/*.py` — NEW: 2 relation scripts.
- `minimal/tasks/headless-terminal/oracle/headless_terminal.py` — NEW: copied oracle artifact.
- `minimal/tasks/sparql-university/oracle/solution.sparql` — NEW: extracted oracle query.
- `minimal/complete-gate.ts` — MODIFY: optional GateIO members (`readVerify`, `runScript`), gate opts gain `requirements`/`relations`, two new round outcomes, new round-result fields.
- `minimal/run.ts` — MODIFY: load probe data from taskDir, wire the two new IO members, extend trial serializer + `GATE_CONTRACT`.
- `opencode-plugin/test/minimal-spec-probe.test.ts` — NEW.
- `opencode-plugin/test/minimal-complete-gate.test.ts` — MODIFY: probe round-step contract tests.
- `opencode-plugin/test/minimal-relations-desk.test.ts` — NEW: oracle-pass / degraded-fail desk validation (real python3).
- `docs/2026-07-27-probe-grip-fix-design.md` — MODIFY: §6.3 pre-registration for the (not-yet-run) paired arms.

---

### Task 1: spec-probe core (pure module)

**Files:**
- Create: `minimal/spec-probe.ts`
- Test: `opencode-plugin/test/minimal-spec-probe.test.ts`

**Interfaces:**
- Produces (Task 3 + Task 7 consume):
  - `interface Requirement { id: string; text: string; markers: string[] }`
  - `parseRequirements(raw: string): Requirement[] | undefined` — JSON `{"requirements":[...]}`; undefined on malformed/empty/missing fields.
  - `stripBashComments(script: string): string` — removes `#`-to-EOL outside single/double quotes.
  - `uncoveredRequirements(reqs: Requirement[], verifyText: string): Requirement[]` — requirement covered iff ANY marker appears case-insensitively as a substring of the comment-stripped verify text.

- [ ] **Step 1: Write the failing tests**

```typescript
// opencode-plugin/test/minimal-spec-probe.test.ts
import { test, expect } from "bun:test"
import { parseRequirements, stripBashComments, uncoveredRequirements } from "../../minimal/spec-probe.ts"

const REQS_JSON = JSON.stringify({
  requirements: [
    { id: "R-ctrlc", text: "modifier keys like ctrl-C", markers: ["\\x03", "ctrl"] },
    { id: "R-bashrc", text: "sources startup files", markers: ["bashrc"] },
  ],
})

test("parseRequirements round-trips well-formed JSON", () => {
  const rs = parseRequirements(REQS_JSON)!
  expect(rs.length).toBe(2)
  expect(rs[0]!.id).toBe("R-ctrlc")
  expect(rs[1]!.markers).toEqual(["bashrc"])
})

test("parseRequirements rejects malformed input", () => {
  expect(parseRequirements("not json")).toBeUndefined()
  expect(parseRequirements("{}")).toBeUndefined()
  expect(parseRequirements(JSON.stringify({ requirements: [{ id: "x" }] }))).toBeUndefined()
})

test("stripBashComments drops comment tails but keeps quoted hashes", () => {
  expect(stripBashComments("echo hi # not this")).toBe("echo hi ")
  expect(stripBashComments('echo "# keep" # drop')).toBe('echo "# keep" ')
  expect(stripBashComments("# whole line\nrun x")).toBe("\nrun x")
})

test("uncoveredRequirements: covered via any marker, case-insensitive", () => {
  const rs = parseRequirements(REQS_JSON)!
  const verify = 'python3 - <<EOF\nt.send_keystrokes("\\x03")\nEOF\n'
  const un = uncoveredRequirements(rs, verify)
  expect(un.map((r) => r.id)).toEqual(["R-bashrc"])
})

test("uncoveredRequirements: markers inside bash comments do NOT count (anti-gaming)", () => {
  const rs = parseRequirements(REQS_JSON)!
  const gamed = "# \\x03 ctrl bashrc — mentioning every marker in a comment\nexit 0\n"
  expect(uncoveredRequirements(rs, gamed).map((r) => r.id)).toEqual(["R-ctrlc", "R-bashrc"])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/th-yoo/z2/meta-harness/opencode-plugin && bun test test/minimal-spec-probe.test.ts`
Expected: FAIL — module `minimal/spec-probe.ts` does not exist.

- [ ] **Step 3: Implement `minimal/spec-probe.ts`**

```typescript
/**
 * minimal/spec-probe.ts — spec-coverage probe for the completion gate
 * (false-accept fix L1, docs/2026-07-27-probe-grip-fix-design.md §5.1).
 *
 * A frozen per-task requirements.json (hand-compiled from instruction.md,
 * RTM-style: id + text + observable markers) is matched against the agent's
 * verify.sh. A requirement is "covered" iff any marker appears (case-
 * insensitive substring) in the COMMENT-STRIPPED script — mentioning
 * markers in a bash comment does not count. Derives only from the
 * instruction the agent already sees (invariant 1 intact).
 */

export interface Requirement {
  id: string
  text: string
  markers: string[]
}

export function parseRequirements(raw: string): Requirement[] | undefined {
  try {
    const j = JSON.parse(raw)
    if (!Array.isArray(j.requirements) || j.requirements.length === 0) return undefined
    const out: Requirement[] = []
    for (const r of j.requirements) {
      if (typeof r.id !== "string" || typeof r.text !== "string" || !Array.isArray(r.markers)) return undefined
      if (!r.markers.every((m: unknown) => typeof m === "string") || r.markers.length === 0) return undefined
      out.push({ id: r.id, text: r.text, markers: r.markers })
    }
    return out
  } catch {
    return undefined
  }
}

/** Remove #-to-EOL bash comments outside single/double quotes (crude lexer —
 * good enough for agent-written verify scripts; heredoc bodies keep their
 * text since they contain no unquoted leading `#` in practice). */
export function stripBashComments(script: string): string {
  return script
    .split("\n")
    .map((line) => {
      let inS = false
      let inD = false
      for (let i = 0; i < line.length; i++) {
        const c = line[i]
        if (c === "'" && !inD) inS = !inS
        else if (c === '"' && !inS) inD = !inD
        else if (c === "#" && !inS && !inD) return line.slice(0, i)
      }
      return line
    })
    .join("\n")
}

export function uncoveredRequirements(reqs: Requirement[], verifyText: string): Requirement[] {
  const hay = stripBashComments(verifyText).toLowerCase()
  return reqs.filter((r) => !r.markers.some((m) => hay.includes(m.toLowerCase())))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/th-yoo/z2/meta-harness/opencode-plugin && bun test test/minimal-spec-probe.test.ts`
Expected: 5 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
cd /home/th-yoo/z2/meta-harness
git add minimal/spec-probe.ts opencode-plugin/test/minimal-spec-probe.test.ts
git commit -m "feat(probe): spec-coverage core — requirements parsing + comment-stripped marker matching

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: requirements.json for both tasks

**Files:**
- Create: `minimal/tasks/headless-terminal/requirements.json`
- Create: `minimal/tasks/sparql-university/requirements.json`
- Test: extend `opencode-plugin/test/minimal-spec-probe.test.ts`

**Interfaces:**
- Consumes: `parseRequirements` from Task 1.
- Produces: the two frozen requirement files Task 7's loader reads. IDs are load-bearing (reinject text + sensor lines use them) — do not rename later.

Requirement lists are compiled by hand from the two instruction.md files (quoted in each `text`), NOT from graders. Markers are lowercase-insensitive substrings an honest verify.sh scenario would contain.

- [ ] **Step 1: Write the failing test (files must exist, parse, and self-check)**

Append to `opencode-plugin/test/minimal-spec-probe.test.ts`:

```typescript
import { readFileSync } from "node:fs"
import { join } from "node:path"

const TASKS = join(import.meta.dir, "../../minimal/tasks")

test("both tasks ship parseable requirements.json with unique ids", () => {
  for (const task of ["headless-terminal", "sparql-university"]) {
    const rs = parseRequirements(readFileSync(join(TASKS, task, "requirements.json"), "utf-8"))
    expect(rs).toBeDefined()
    const ids = rs!.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(rs!.length).toBeGreaterThanOrEqual(4)
  }
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/th-yoo/z2/meta-harness/opencode-plugin && bun test test/minimal-spec-probe.test.ts`
Expected: FAIL — ENOENT `requirements.json`.

- [ ] **Step 3: Write `minimal/tasks/headless-terminal/requirements.json`**

```json
{
  "requirements": [
    {
      "id": "R-shell-exec",
      "text": "Mimics a terminal: interactive bash shell, commands executed by typing characters and hitting Enter",
      "markers": ["send_keystrokes"]
    },
    {
      "id": "R-interactive-programs",
      "text": "Supports interactive programs",
      "markers": ["cat >", "python3 -", "read ", "interactive"]
    },
    {
      "id": "R-modifier-keys",
      "text": "Has support for modifier keys like \"\\x03\" for control C",
      "markers": ["\\x03", "\\x04", "ctrl"]
    },
    {
      "id": "R-startup-files",
      "text": "Because the shell is interactive, it should source the startup files (e.g. ~/.bashrc)",
      "markers": ["bashrc", "startup"]
    },
    {
      "id": "R-class-contract",
      "text": "Call your implementation HeadlessTerminal(BaseTerminal) in /app/headless_terminal.py, importable as from headless_terminal import HeadlessTerminal",
      "markers": ["import headlessterminal", "from headless_terminal"]
    }
  ]
}
```

- [ ] **Step 4: Write `minimal/tasks/sparql-university/requirements.json`**

```json
{
  "requirements": [
    {
      "id": "R-full-professor",
      "text": "They are full professors",
      "markers": ["professor"]
    },
    {
      "id": "R-eu-country",
      "text": "Work in at least one department of a university located in a European Union country",
      "markers": ["country", "\"gr\"", "\"de\"", "\"fr\""]
    },
    {
      "id": "R-enrollment-threshold",
      "text": "Among all departments they work in, at least one has more than 10 students currently enrolled in classes taught in that department",
      "markers": ["10", "enroll"]
    },
    {
      "id": "R-result-shape",
      "text": "SELECT ?professorName (GROUP_CONCAT(DISTINCT ?country; separator=\", \") AS ?countries)",
      "markers": ["professorname", "group_concat", "countries"]
    }
  ]
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd /home/th-yoo/z2/meta-harness/opencode-plugin && bun test test/minimal-spec-probe.test.ts`
Expected: 6 pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
cd /home/th-yoo/z2/meta-harness
git add minimal/tasks/headless-terminal/requirements.json minimal/tasks/sparql-university/requirements.json opencode-plugin/test/minimal-spec-probe.test.ts
git commit -m "feat(probe): frozen requirements.json for headless + sparql (hand-compiled from instruction.md)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: spec-coverage round step in the completion gate

**Files:**
- Modify: `minimal/complete-gate.ts`
- Test: `opencode-plugin/test/minimal-complete-gate.test.ts` (append)

**Interfaces:**
- Consumes: `Requirement`, `uncoveredRequirements` from Task 1 (`import { type Requirement, uncoveredRequirements } from "./spec-probe.ts"`).
- Produces (Task 4 + Task 7 rely on):
  - `GateIO` gains OPTIONAL member: `readVerify?(): MaybeAsync<string | undefined>` — verify.sh content; undefined = unreadable (probe skips, fail-open).
  - `runCompletionGate(io, opts)` — `opts` gains optional `requirements?: Requirement[]`.
  - `GateRoundResult.outcome` union gains `"requirement-untested"`.
  - `GateRoundResult` gains `uncoveredReqs?: string[]` (ids, present only when the spec probe ran and found gaps).
- Round order becomes: verify-exists → verify-passes → **spec-coverage** → (Task 4: relations) → mutation probe. Spec-coverage placement rationale: it is a free text check — run it before any expensive mutant execution.
- Fail-open triple: no `opts.requirements` OR no `io.readVerify` OR `readVerify()` returns undefined → step skips.

- [ ] **Step 1: Write the failing tests**

Append to `opencode-plugin/test/minimal-complete-gate.test.ts`:

```typescript
import { type Requirement } from "../../minimal/spec-probe.ts"

const REQS: Requirement[] = [
  { id: "R-a", text: "does A", markers: ["scenario_a"] },
  { id: "R-b", text: "does B", markers: ["scenario_b"] },
]

test("spec probe fails the round and names uncovered requirements", async () => {
  const io = fakeIO({
    readVerify: () => "run scenario_a only\n",
    runVerify: (onMutant?: boolean) => (onMutant ? { code: 1, out: "caught" } : { code: 0, out: "ok" }),
  })
  const r = await runCompletionGate(io, { rounds: 1, mutants: 2, requirements: REQS })
  expect(r.rounds[0]!.outcome).toBe("requirement-untested")
  expect(r.rounds[0]!.uncoveredReqs).toEqual(["R-b"])
  const msg = io.log.find((l) => l.startsWith("reinject:"))!
  expect(msg).toContain("does B")
  expect(msg).toContain("R-b")
})

test("spec probe passes through when verify covers all requirements", async () => {
  const io = fakeIO({
    readVerify: () => "scenario_a then scenario_b\n",
    runVerify: (onMutant?: boolean) => (onMutant ? { code: 1, out: "caught" } : { code: 0, out: "ok" }),
  })
  const r = await runCompletionGate(io, { rounds: 1, mutants: 2, requirements: REQS })
  expect(r.rounds[0]!.outcome).toBe("accepted")
  expect(r.rounds[0]!.uncoveredReqs).toBeUndefined()
})

test("spec probe is fail-open: no requirements, no readVerify, or unreadable verify", async () => {
  const noReqs = fakeIO({ runVerify: (m?: boolean) => (m ? { code: 1, out: "x" } : { code: 0, out: "ok" }) })
  expect((await runCompletionGate(noReqs, { rounds: 1, mutants: 2 })).rounds[0]!.outcome).toBe("accepted")
  const unreadable = fakeIO({
    readVerify: () => undefined,
    runVerify: (m?: boolean) => (m ? { code: 1, out: "x" } : { code: 0, out: "ok" }),
  })
  expect(
    (await runCompletionGate(unreadable, { rounds: 1, mutants: 2, requirements: REQS })).rounds[0]!.outcome,
  ).toBe("accepted")
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd /home/th-yoo/z2/meta-harness/opencode-plugin && bun test test/minimal-complete-gate.test.ts`
Expected: first two new tests FAIL (outcome is "accepted", `uncoveredReqs` undefined / TS error on unknown opts key). Third may pass — that is fine (it pins existing fail-open behavior).

- [ ] **Step 3: Implement in `minimal/complete-gate.ts`**

Add the import at the top:

```typescript
import { type Requirement, uncoveredRequirements } from "./spec-probe.ts"
```

Extend `GateIO` (after the `coveredLines?` member):

```typescript
  /** Optional (false-accept L1): content of the agent's verify.sh for the
   * spec-coverage probe. undefined = unreadable → probe skips (fail-open). */
  readVerify?(): MaybeAsync<string | undefined>
```

Extend `GateRoundResult`:

```typescript
  outcome: "accepted" | "no-verify" | "verify-failed" | "mutant-survived" | "artifact-missing" | "requirement-untested"
  /** Spec-coverage probe: ids of instruction requirements the verify script
   * never exercises (present only when the probe ran and found gaps). */
  uncoveredReqs?: string[]
```

`checkRound` gains a `requirements` parameter and the step goes AFTER the verify-passes check and BEFORE `readArtifact`:

```typescript
async function checkRound(
  io: GateIO,
  mutants: number,
  requirements?: Requirement[],
): Promise<{ r: GateRoundResult; reinjectMsg?: string }> {
```

Insert after the `verify-failed` early return:

```typescript
  // Spec-coverage probe (false-accept L1): every instruction requirement
  // must be exercised by the verification. Free text check — runs before
  // any mutant execution. Fail-open when the task ships no requirements
  // or verify.sh is unreadable.
  if (requirements && io.readVerify) {
    const verifyText = await io.readVerify()
    if (verifyText !== undefined) {
      const uncovered = uncoveredRequirements(requirements, verifyText)
      if (uncovered.length > 0)
        return {
          r: {
            outcome: "requirement-untested",
            mutantsTried: 0,
            mutantsSurvived: 0,
            mutantsKilled: 0,
            coverage: "off",
            uncoveredReqs: uncovered.map((q) => q.id),
          },
          reinjectMsg: `not done: the task instruction states requirements your verification never exercises:\n${uncovered
            .map((q) => `- [${q.id}] ${q.text}`)
            .join(
              "\n",
            )}\nAdd a scenario to /app/verify.sh for each (exercise the behavior itself — naming it in a comment does not count), run it, and fix anything it finds.`,
        }
    }
  }
```

Thread the parameter through `runCompletionGate`:

```typescript
export async function runCompletionGate(
  io: GateIO,
  opts: { rounds: number; mutants: number; requirements?: Requirement[] },
): Promise<GateResult> {
  const rounds: GateRoundResult[] = []
  for (let attempt = 0; ; attempt++) {
    const { r, reinjectMsg } = await checkRound(io, opts.mutants, opts.requirements)
```

- [ ] **Step 4: Run the full minimal-core test files**

Run: `cd /home/th-yoo/z2/meta-harness/opencode-plugin && bun test test/minimal-complete-gate.test.ts test/minimal-spec-probe.test.ts test/minimal-mutate.test.ts test/minimal-cover.test.ts`
Expected: all pass (15 complete-gate, 6 spec-probe, 17 mutate, 4 cover).

- [ ] **Step 5: Commit**

```bash
cd /home/th-yoo/z2/meta-harness
git add minimal/complete-gate.ts opencode-plugin/test/minimal-complete-gate.test.ts
git commit -m "feat(probe): spec-coverage round step in completion gate — requirement-untested outcome + named reinject

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: relation-probe round step in the completion gate

**Files:**
- Modify: `minimal/complete-gate.ts`
- Test: `opencode-plugin/test/minimal-complete-gate.test.ts` (append)

**Interfaces:**
- Produces (Tasks 5–7 rely on):
  - `export interface Relation { id: string; script: string }` (in `complete-gate.ts` — it is gate vocabulary, not task data).
  - `GateIO` gains OPTIONAL member: `runScript?(script: string): MaybeAsync<{ code: number; out: string }>` — executes a python relation script in the task environment (Task 7 wires podman; exit 0 = relation holds).
  - `opts` gains `relations?: Relation[]`.
  - `GateRoundResult.outcome` union gains `"relation-violated"`; `GateRoundResult` gains `violatedRelations?: string[]`.
- Round order: … → spec-coverage → **relations** → mutation probe. Relations run each round (artifact may change between rounds). ALL relations run before verdict (report every violation at once — one reinject, not R reinjects).
- Fail-open: no `opts.relations` or no `io.runScript` → step skips.

- [ ] **Step 1: Write the failing tests**

Append to `opencode-plugin/test/minimal-complete-gate.test.ts`:

```typescript
import { type Relation } from "../../minimal/complete-gate.ts"

const RELS: Relation[] = [
  { id: "MR-echo", script: "echo-roundtrip-py" },
  { id: "MR-ctrlc", script: "ctrlc-py" },
]

test("relation probe fails the round listing every violated relation", async () => {
  const io = fakeIO({
    runScript: (script: string) => ({ code: script === "ctrlc-py" ? 1 : 0, out: "sleep survived interrupt" }),
    runVerify: (m?: boolean) => (m ? { code: 1, out: "caught" } : { code: 0, out: "ok" }),
  })
  const r = await runCompletionGate(io, { rounds: 1, mutants: 2, relations: RELS })
  expect(r.rounds[0]!.outcome).toBe("relation-violated")
  expect(r.rounds[0]!.violatedRelations).toEqual(["MR-ctrlc"])
  const msg = io.log.find((l) => l.startsWith("reinject:"))!
  expect(msg).toContain("MR-ctrlc")
  expect(msg).toContain("sleep survived interrupt")
})

test("relation probe passes when every relation holds, then mutation probe still runs", async () => {
  const io = fakeIO({
    runScript: () => ({ code: 0, out: "ok" }),
    runVerify: (m?: boolean) => (m ? { code: 1, out: "caught" } : { code: 0, out: "ok" }),
  })
  const r = await runCompletionGate(io, { rounds: 1, mutants: 2, relations: RELS })
  expect(r.rounds[0]!.outcome).toBe("accepted")
  expect(r.rounds[0]!.mutantsTried).toBeGreaterThan(0) // relations did not short-circuit the mutation probe
})

test("relation probe is fail-open without runScript", async () => {
  const io = fakeIO({ runVerify: (m?: boolean) => (m ? { code: 1, out: "x" } : { code: 0, out: "ok" }) })
  const r = await runCompletionGate(io, { rounds: 1, mutants: 2, relations: RELS })
  expect(r.rounds[0]!.outcome).toBe("accepted")
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd /home/th-yoo/z2/meta-harness/opencode-plugin && bun test test/minimal-complete-gate.test.ts`
Expected: first two FAIL (TS unknown `relations` opt / outcome "accepted"); third may already pass.

- [ ] **Step 3: Implement in `minimal/complete-gate.ts`**

Add near `GateIO`:

```typescript
/** A metamorphic/property relation probe: a self-contained python script
 * derived ONLY from instruction.md (never the grader). Exit 0 = relation
 * holds; non-zero = violated, stdout/stderr tail = evidence. */
export interface Relation {
  id: string
  script: string
}
```

`GateIO` gains (after `readVerify?`):

```typescript
  /** Optional (false-accept probes): run a relation script in the task
   * environment. Absent → relation probe skips (fail-open). */
  runScript?(script: string): MaybeAsync<{ code: number; out: string }>
```

`GateRoundResult`:

```typescript
  outcome: "accepted" | "no-verify" | "verify-failed" | "mutant-survived" | "artifact-missing" | "requirement-untested" | "relation-violated"
  /** Relation probe: ids of violated relations (present only on violation). */
  violatedRelations?: string[]
```

`checkRound` signature and threading:

```typescript
async function checkRound(
  io: GateIO,
  mutants: number,
  requirements?: Requirement[],
  relations?: Relation[],
): Promise<{ r: GateRoundResult; reinjectMsg?: string }> {
```

Insert AFTER the spec-coverage block, BEFORE `readArtifact`:

```typescript
  // Relation probe (false-accept fix): instruction-derived metamorphic/
  // property relations run against the artifact itself — they catch
  // wrong-behavior the agent's own scenarios never imagined. All relations
  // run; one reinject reports every violation.
  if (relations && io.runScript) {
    const violated: { id: string; out: string }[] = []
    for (const rel of relations) {
      const res = await io.runScript(rel.script)
      if (res.code !== 0) violated.push({ id: rel.id, out: res.out.slice(-OUT_TAIL) })
    }
    if (violated.length > 0)
      return {
        r: {
          outcome: "relation-violated",
          mutantsTried: 0,
          mutantsSurvived: 0,
          mutantsKilled: 0,
          coverage: "off",
          violatedRelations: violated.map((v) => v.id),
        },
        reinjectMsg: `not done: your artifact violates behavior the task instruction implies:\n${violated
          .map((v) => `- [${v.id}]\n${v.out}`)
          .join(
            "\n",
          )}\nFix the artifact so the stated behavior holds, extend /app/verify.sh to cover it, and re-run your verification.`,
      }
  }
```

In `runCompletionGate`, extend opts and the call:

```typescript
  opts: { rounds: number; mutants: number; requirements?: Requirement[]; relations?: Relation[] },
```
```typescript
    const { r, reinjectMsg } = await checkRound(io, opts.mutants, opts.requirements, opts.relations)
```

- [ ] **Step 4: Run the file**

Run: `cd /home/th-yoo/z2/meta-harness/opencode-plugin && bun test test/minimal-complete-gate.test.ts`
Expected: 18 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
cd /home/th-yoo/z2/meta-harness
git add minimal/complete-gate.ts opencode-plugin/test/minimal-complete-gate.test.ts
git commit -m "feat(probe): relation-probe round step — relation-violated outcome, all violations in one reinject

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: headless relation scripts + oracle + desk validation

**Files:**
- Create: `minimal/tasks/headless-terminal/relations/mr-exec.py`, `mr-interactive-eof.py`, `mr-ctrlc.py`, `mr-bashrc.py`
- Create: `minimal/tasks/headless-terminal/oracle/headless_terminal.py` (copy)
- Test: `opencode-plugin/test/minimal-relations-desk.test.ts`

**Interfaces:**
- Script contract (Task 7's `runScript` wiring provides): env `ARTIFACT` = absolute path to the artifact file, env `APPDIR` = directory containing the artifact + fixtures; script runs with cwd = `APPDIR`; exit 0 = holds, non-zero = violated; failure evidence printed to stdout. Scripts import the artifact via `sys.path.insert(0, APPDIR)`.
- Desk-validation contract (the free grip proof): every relation must PASS on the oracle artifact (zero false alarms) and the suite must FAIL a deliberately degraded artifact (grip demonstrated).

- [ ] **Step 1: Copy the oracle artifact**

```bash
cd /home/th-yoo/z2/meta-harness
mkdir -p minimal/tasks/headless-terminal/oracle
cp ~/z2/terminal-bench-2/headless-terminal/solution/headless_terminal.py minimal/tasks/headless-terminal/oracle/headless_terminal.py
```

(Keep any canary comment lines intact. `run.ts` copies only `fixtures/` into agent containers — oracle/ never reaches an agent.)

- [ ] **Step 2: Write the four relation scripts**

`minimal/tasks/headless-terminal/relations/mr-exec.py` — instruction: "commands are typically executed by typing characters and hitting Enter":

```python
import os, sys, tempfile
sys.path.insert(0, os.environ["APPDIR"])
from headless_terminal import HeadlessTerminal

out = os.path.join(tempfile.gettempdir(), "mh_mr_exec.txt")
if os.path.exists(out):
    os.remove(out)
t = HeadlessTerminal()
t.send_keystrokes(f"echo mh_exec_ok > {out}")
t.send_keystrokes("\n", wait_sec=3)
if not (os.path.exists(out) and open(out).read().strip() == "mh_exec_ok"):
    print(f"relation mr-exec violated: typed command + Enter did not execute (expected '{out}' containing mh_exec_ok)")
    sys.exit(1)
```

`minimal/tasks/headless-terminal/relations/mr-interactive-eof.py` — instruction: "supports interactive programs" (+ modifier key EOF):

```python
import os, sys, tempfile
sys.path.insert(0, os.environ["APPDIR"])
from headless_terminal import HeadlessTerminal

out = os.path.join(tempfile.gettempdir(), "mh_mr_eof.txt")
if os.path.exists(out):
    os.remove(out)
t = HeadlessTerminal()
t.send_keystrokes(f"cat > {out}")
t.send_keystrokes("\n", wait_sec=1)
t.send_keystrokes("mh_interactive_line")
t.send_keystrokes("\n", wait_sec=1)
t.send_keystrokes("\x04", wait_sec=2)  # Ctrl-D: end interactive cat
if not (os.path.exists(out) and "mh_interactive_line" in open(out).read()):
    print(f"relation mr-interactive-eof violated: interactive `cat > file` + Ctrl-D did not capture typed input in {out}")
    sys.exit(1)
```

`minimal/tasks/headless-terminal/relations/mr-ctrlc.py` — instruction: 'modifier keys like "\x03" for control C':

```python
import os, sys, tempfile
sys.path.insert(0, os.environ["APPDIR"])
from headless_terminal import HeadlessTerminal

out = os.path.join(tempfile.gettempdir(), "mh_mr_ctrlc.txt")
if os.path.exists(out):
    os.remove(out)
t = HeadlessTerminal()
t.send_keystrokes("sleep 300")
t.send_keystrokes("\n", wait_sec=1)
t.send_keystrokes("\x03", wait_sec=1)  # Ctrl-C must interrupt the sleep
t.send_keystrokes(f"echo mh_after_int > {out}")
t.send_keystrokes("\n", wait_sec=3)
if not (os.path.exists(out) and open(out).read().strip() == "mh_after_int"):
    print("relation mr-ctrlc violated: after \\x03 the shell did not accept the next command (sleep 300 survived the interrupt)")
    sys.exit(1)
```

`minimal/tasks/headless-terminal/relations/mr-bashrc.py` — instruction: "should source the startup files (e.g. ~/.bashrc)":

```python
import os, sys, tempfile
sys.path.insert(0, os.environ["APPDIR"])

out = os.path.join(tempfile.gettempdir(), "mh_mr_bashrc.txt")
if os.path.exists(out):
    os.remove(out)
rc = os.path.expanduser("~/.bashrc")
marker = "export MH_RC_MARK=mh_rc_ok  # mh-relation-probe\n"
with open(rc, "a") as f:
    f.write(marker)
try:
    from headless_terminal import HeadlessTerminal  # constructed AFTER the marker exists
    t = HeadlessTerminal()
    t.send_keystrokes(f"echo $MH_RC_MARK > {out}")
    t.send_keystrokes("\n", wait_sec=3)
    ok = os.path.exists(out) and open(out).read().strip() == "mh_rc_ok"
finally:
    lines = open(rc).readlines()
    with open(rc, "w") as f:
        f.writelines(l for l in lines if "mh-relation-probe" not in l)
if not ok:
    print("relation mr-bashrc violated: a fresh terminal did not see a variable exported from ~/.bashrc (startup files not sourced)")
    sys.exit(1)
```

- [ ] **Step 3: Write the failing desk-validation test**

`opencode-plugin/test/minimal-relations-desk.test.ts`:

```typescript
import { test, expect } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, cpSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Desk validation (false-accept probes plan Task 5/6): every relation must
// PASS on the oracle artifact (zero false alarms) and the suite must FAIL a
// deliberately degraded artifact (grip). Real python3 — no fakes.

const TASKS = join(import.meta.dir, "../../minimal/tasks")

function runRelation(scriptPath: string, appdir: string, artifact: string): { code: number; out: string } {
  const r = Bun.spawnSync(["python3", scriptPath], {
    cwd: appdir,
    env: { ...process.env, APPDIR: appdir, ARTIFACT: artifact },
    timeout: 60_000,
  })
  return { code: r.exitCode ?? 1, out: r.stdout.toString() + r.stderr.toString() }
}

function headlessAppdir(artifactSource: string): { appdir: string; artifact: string } {
  const dir = mkdtempSync(join(tmpdir(), "mh-desk-headless-"))
  cpSync(join(TASKS, "headless-terminal/fixtures/base_terminal.py"), join(dir, "base_terminal.py"))
  const artifact = join(dir, "headless_terminal.py")
  writeFileSync(artifact, artifactSource)
  return { appdir: dir, artifact }
}

const RELDIR = join(TASKS, "headless-terminal/relations")
const ORACLE = readFileSync(join(TASKS, "headless-terminal/oracle/headless_terminal.py"), "utf-8")

test("headless: every relation PASSES on the oracle artifact", () => {
  const { appdir, artifact } = headlessAppdir(ORACLE)
  for (const f of readdirSync(RELDIR).filter((f) => f.endsWith(".py"))) {
    const r = runRelation(join(RELDIR, f), appdir, artifact)
    expect({ relation: f, code: r.code, out: r.out.slice(-300) }).toEqual({ relation: f, code: 0, out: r.out.slice(-300) })
  }
}, 120_000)

test("headless: degraded artifact (drops modifier keys) violates at least one relation", () => {
  // Degradation: strip control characters before sending — Ctrl-C/Ctrl-D become no-ops.
  const degraded = ORACLE.replace(
    "def send_keystrokes(self, keystrokes: str, wait_sec: float = 0.0) -> None:",
    'def send_keystrokes(self, keystrokes: str, wait_sec: float = 0.0) -> None:\n        keystrokes = "".join(c for c in keystrokes if c >= " " or c == "\\n")',
  )
  expect(degraded).not.toBe(ORACLE) // the anchor line must exist
  const { appdir, artifact } = headlessAppdir(degraded)
  const codes = readdirSync(RELDIR)
    .filter((f) => f.endsWith(".py"))
    .map((f) => runRelation(join(RELDIR, f), appdir, artifact).code)
  expect(codes.some((c) => c !== 0)).toBe(true)
}, 120_000)
```

- [ ] **Step 4: Run to verify current state**

Run: `cd /home/th-yoo/z2/meta-harness/opencode-plugin && bun test test/minimal-relations-desk.test.ts`
Expected first run: FAILS until scripts/oracle behave (missing files → ENOENT; then possibly relation bugs). Iterate on the RELATION SCRIPTS (not the oracle) until: oracle test = all relations exit 0; degraded test = ≥1 non-zero. If a relation cannot be made to pass on the oracle (e.g. the oracle itself does not source ~/.bashrc), the relation is WRONG or the requirement needs a weaker observable — fix the script; never weaken the degraded-fail assertion.

- [ ] **Step 5: Commit**

```bash
cd /home/th-yoo/z2/meta-harness
git add minimal/tasks/headless-terminal/relations minimal/tasks/headless-terminal/oracle opencode-plugin/test/minimal-relations-desk.test.ts
git commit -m "feat(probe): headless relation scripts + oracle desk validation (oracle-pass / degraded-fail)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: sparql relation scripts + oracle + desk validation

**Files:**
- Create: `minimal/tasks/sparql-university/relations/mr-shape.py`, `mr-rename.py`
- Create: `minimal/tasks/sparql-university/oracle/solution.sparql`
- Test: `opencode-plugin/test/minimal-relations-desk.test.ts` (append)

**Interfaces:**
- Same script contract as Task 5. Scripts use rdflib (7.6.0 on host, present in the mh-bench image) and read the graph fixture from `APPDIR/university_graph.ttl`.

- [ ] **Step 1: Extract the oracle query**

The oracle query is the heredoc body of `~/z2/terminal-bench-2/sparql-university/solution/solve.sh` (between `cat << 'EOF' > /app/solution.sparql` and the final `EOF`). Extract it verbatim:

```bash
cd /home/th-yoo/z2/meta-harness
mkdir -p minimal/tasks/sparql-university/oracle
sed -n "/^cat << 'EOF'/,/^EOF$/p" ~/z2/terminal-bench-2/sparql-university/solution/solve.sh | sed '1d;$d' > minimal/tasks/sparql-university/oracle/solution.sparql
head -3 minimal/tasks/sparql-university/oracle/solution.sparql   # expect: PREFIX uni: <http://university.org/ontology/>
```

- [ ] **Step 2: Write the two relation scripts**

`minimal/tasks/sparql-university/relations/mr-shape.py` — instruction states the exact SELECT shape:

```python
import os, sys
import rdflib

artifact = os.environ["ARTIFACT"]
appdir = os.environ["APPDIR"]
g = rdflib.Graph()
g.parse(os.path.join(appdir, "university_graph.ttl"), format="turtle")
try:
    res = g.query(open(artifact).read())
except Exception as e:
    print(f"relation mr-shape violated: query does not parse/execute: {e}")
    sys.exit(1)
vars_ = sorted(str(v) for v in res.vars)
if vars_ != ["countries", "professorName"]:
    print(f"relation mr-shape violated: result variables {vars_} != ['countries', 'professorName'] (instruction-stated SELECT shape)")
    sys.exit(1)
```

`minimal/tasks/sparql-university/relations/mr-rename.py` — pure isomorphism relation: renaming one professor's name literal in the graph must rename it correspondingly in the results (catches hardcoded names / brittle string matching; holds for ANY correct query):

```python
import os, sys
import rdflib
from rdflib import Literal

artifact = os.environ["ARTIFACT"]
appdir = os.environ["APPDIR"]
query = open(artifact).read()

g = rdflib.Graph()
g.parse(os.path.join(appdir, "university_graph.ttl"), format="turtle")
try:
    base = {str(row[0]) for row in g.query(query)}
except Exception as e:
    print(f"relation mr-rename violated: query does not execute: {e}")
    sys.exit(1)
if not base:
    sys.exit(0)  # vacuous: no results to rename — other checks own emptiness

target = sorted(base)[0]
SUFFIX = "_MHRENAME"
g2 = rdflib.Graph()
for s, p, o in g:
    if isinstance(o, Literal) and str(o) == target:
        o = Literal(str(o) + SUFFIX, datatype=o.datatype, lang=o.language)
    g2.add((s, p, o))
renamed = {str(row[0]) for row in g2.query(query)}
expected = {(n + SUFFIX if n == target else n) for n in base}
if renamed != expected:
    print(
        "relation mr-rename violated: renaming professor "
        f"'{target}' in the graph did not rename it in the results.\n"
        f"expected names: {sorted(expected)}\ngot: {sorted(renamed)}\n"
        "(a correct query tracks the data; hardcoded names or brittle matching break this)"
    )
    sys.exit(1)
```

- [ ] **Step 3: Write the failing desk tests**

Append to `opencode-plugin/test/minimal-relations-desk.test.ts`:

```typescript
function sparqlAppdir(query: string): { appdir: string; artifact: string } {
  const dir = mkdtempSync(join(tmpdir(), "mh-desk-sparql-"))
  cpSync(join(TASKS, "sparql-university/fixtures/university_graph.ttl"), join(dir, "university_graph.ttl"))
  const artifact = join(dir, "solution.sparql")
  writeFileSync(artifact, query)
  return { appdir: dir, artifact }
}

const SP_RELDIR = join(TASKS, "sparql-university/relations")
const SP_ORACLE = readFileSync(join(TASKS, "sparql-university/oracle/solution.sparql"), "utf-8")

test("sparql: every relation PASSES on the oracle query", () => {
  const { appdir, artifact } = sparqlAppdir(SP_ORACLE)
  for (const f of readdirSync(SP_RELDIR).filter((f) => f.endsWith(".py"))) {
    const r = runRelation(join(SP_RELDIR, f), appdir, artifact)
    expect({ relation: f, code: r.code, out: r.out.slice(-300) }).toEqual({ relation: f, code: 0, out: r.out.slice(-300) })
  }
}, 120_000)

test("sparql: degraded query (hardcoded professor names) violates mr-rename", () => {
  // Degradation of the false-accept class: replace the data-driven professor
  // pattern with hardcoded VALUES of whatever names the oracle returns —
  // looks right on today's graph, breaks the isomorphism relation.
  const { appdir, artifact } = sparqlAppdir(SP_ORACLE)
  const namesOut = Bun.spawnSync(
    [
      "python3",
      "-c",
      `import rdflib,os; g=rdflib.Graph(); g.parse(os.path.join(${JSON.stringify(join(TASKS, "sparql-university/fixtures"))},"university_graph.ttl"),format="turtle"); print("\\n".join(sorted({str(r[0]) for r in g.query(open(${JSON.stringify(artifact)}).read())})))`,
    ],
    { timeout: 60_000 },
  )
  const names = namesOut.stdout.toString().trim().split("\n").filter(Boolean)
  expect(names.length).toBeGreaterThan(0)
  const hardcoded = `PREFIX uni: <http://university.org/ontology/>
SELECT ?professorName (GROUP_CONCAT(DISTINCT ?country; separator=", ") AS ?countries)
WHERE {
  ?professor a uni:Person ; uni:hasName ?professorName ; uni:worksIn ?dept .
  ?dept uni:belongsTo ?u . ?u uni:locatedInCountry ?country .
  VALUES ?professorName { ${names.map((n) => JSON.stringify(n)).join(" ")} }
}
GROUP BY ?professorName`
  const { appdir: appdir2, artifact: artifact2 } = sparqlAppdir(hardcoded)
  const r = runRelation(join(SP_RELDIR, "mr-rename.py"), appdir2, artifact2)
  expect(r.code).not.toBe(0)
}, 120_000)
```

- [ ] **Step 4: Run desk tests**

Run: `cd /home/th-yoo/z2/meta-harness/opencode-plugin && bun test test/minimal-relations-desk.test.ts`
Expected: all 4 desk tests pass (2 headless from Task 5 + 2 sparql). Iterate on scripts, never on assertions.

- [ ] **Step 5: Commit**

```bash
cd /home/th-yoo/z2/meta-harness
git add minimal/tasks/sparql-university/relations minimal/tasks/sparql-university/oracle opencode-plugin/test/minimal-relations-desk.test.ts
git commit -m "feat(probe): sparql relation scripts (shape + isomorphic-rename) + oracle desk validation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: run.ts wiring + serializer + contract text + full-suite green

**Files:**
- Modify: `minimal/run.ts`
- Test: existing suites (wiring is podman glue — repo idiom keeps it untested; the pure parts were tested in Tasks 1–6)

**Interfaces:**
- Consumes: `parseRequirements` (Task 1), `Relation` (Task 4), the task-dir layout `requirements.json` + `relations/*.py` (Tasks 2/5/6).

- [ ] **Step 1: Load probe data near the existing task-dir resolution** (after the `fixturesDir` assignment around `minimal/run.ts:394`)

```typescript
// False-accept probes (docs/superpowers/plans/2026-07-27-false-accept-probes.md):
// frozen per-task requirement list + instruction-derived relation scripts.
// Both optional — tasks without them get the unchanged completion gate.
import { parseRequirements } from "./spec-probe.ts"  // ← this import goes at the TOP of the file with the others
const reqPath = join(taskDir, "requirements.json")
const gateRequirements = existsSync(reqPath) ? parseRequirements(readFileSync(reqPath, "utf-8")) : undefined
const relationsDir = join(taskDir, "relations")
const gateRelations: import("./complete-gate.ts").Relation[] = existsSync(relationsDir)
  ? readdirSync(relationsDir)
      .filter((f) => f.endsWith(".py"))
      .sort()
      .map((f) => ({ id: f.replace(/\.py$/, ""), script: readFileSync(join(relationsDir, f), "utf-8") }))
  : []
```

- [ ] **Step 2: Wire the two new GateIO members** (inside the `gateIO` object, after `coveredLines`)

```typescript
        readVerify: async () => {
          const r = await podman(["exec", name, "cat", "/app/verify.sh"])
          return r.code === 0 ? r.out : undefined
        },
        runScript: async (script: string) => {
          const tmp = join(tmpdir(), `minimal-relation-${process.pid}-${i}.py`)
          writeFileSync(tmp, script)
          if ((await podman(["cp", tmp, `${name}:/tmp/mh-relation.py`])).code !== 0)
            return { code: 0, out: "" } // copy failure = fail-open, never a violation
          const r = await podman([
            "exec", name, "timeout", "60", "bash", "-c",
            `cd /app && APPDIR=/app ARTIFACT=${gateArtifact} python3 /tmp/mh-relation.py`,
          ])
          return { code: r.code, out: (r.out + "\n" + r.err).trim() }
        },
```

- [ ] **Step 3: Pass probe data into the completion gate** (the `runCompletionGate` call around `minimal/run.ts:661`)

```typescript
      gate = await runCompletionGate(gateIO, {
        rounds: gateRounds,
        mutants: gateMutants,
        requirements: gateRequirements,
        relations: gateRelations.length > 0 ? gateRelations : undefined,
      })
```

- [ ] **Step 4: Extend the trial serializer** (the `rounds:` mapping at `minimal/run.ts:782`)

```typescript
              rounds: gate.rounds.map((r) => ({
                outcome: r.outcome,
                tried: r.mutantsTried,
                survived: r.mutantsSurvived,
                killed: r.mutantsKilled,
                coverage: r.coverage,
                ...(r.uncoveredReqs ? { uncoveredReqs: r.uncoveredReqs } : {}),
                ...(r.violatedRelations ? { violatedRelations: r.violatedRelations } : {}),
              })),
```

- [ ] **Step 5: Extend `GATE_CONTRACT`** — find the `GATE_CONTRACT` constant in `minimal/run.ts` (the paragraph appended to the instruction when `--complete-gate` is set) and append this sentence to its existing text, inside the template string:

```
 Your verification must exercise every requirement stated in the task instruction — an unexercised stated requirement, or artifact behavior contradicting the instruction, will be treated as not done.
```

- [ ] **Step 6: Run everything**

Run: `cd /home/th-yoo/z2/meta-harness/opencode-plugin && bun test`
Expected: full suite green (≈1656 + the new tests from Tasks 1–6, 0 fail).
Run: `cd /home/th-yoo/z2/meta-harness/gate-plugin && bun test`
Expected: 26 pass (gate-plugin untouched — optional members absent = fail-open).
Run: `cd /home/th-yoo/z2/meta-harness/gate-plugin && bunx tsc --noEmit`
Expected: clean (the two pre-existing `minimal/llm.ts` Bun-type errors in the opencode-plugin tsc run are known and not ours).

- [ ] **Step 7: Commit**

```bash
cd /home/th-yoo/z2/meta-harness
git add minimal/run.ts
git commit -m "feat(probe): wire spec-coverage + relation probes into run.ts — loader, GateIO members, serializer, contract text

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: pre-registration §6.3 (arms are NOT run in this plan)

**Files:**
- Modify: `docs/2026-07-27-probe-grip-fix-design.md` (append after §6.2)

- [ ] **Step 1: Append §6.3**

```markdown
### 6.3 PRE-REGISTERED false-accept arms (sealed before launch; SPEND-GATED — not yet run)

Paired arms on `yoo-dev`, config identical to G1 (opus-4-8, system-v0+seed-v0,
completion-gate rounds 2 / mutants 4) plus `requirements.json` + `relations/`
now present in both task dirs. Futility designCheck vets the design pre-spend.

- **Arms:** headless k=10 probes-ON vs probes-OFF control; probes are
  fail-open, so the control arm = the same task dir copied to a scratch
  location with `requirements.json` + `relations/` DELETED — byte-identical
  binary, same commit, one variable. sparql k=5 probes-ON (shape watch).
- **Primary metric:** false-accept count per valid trial (completion gate
  accepted ∧ grader failed). Reference rates: G1 headless 2/5 accepted-but-
  failed; C1 sparql 1/9. Expect a drop; floor is NOT zero (graders test
  semantics no marker/relation fully encodes) — the residual is the
  calibration number that §4.3 must consume.
- **Guards:** exhaustion rate stays 0 (no C1 regression); median elapsed
  < 2x G1 medians (headless 400s, sparql ~420s); rewards non-regressing
  (Fisher vs the paired control arm, same host).
- **Calibration protocol:** false-accept rate + Wilson 95% CI recorded per
  arm into this doc; recheck cadence = every mechanism change to any probe
  (mutation, spec-coverage, relation) triggers a fresh calibration arm
  before §4.3 may consume its outcomes.
- **Voids:** standing forensics rule (auth-race / 0-turn / timeout-suspect
  excluded before counting).
```

- [ ] **Step 2: Commit + push everything**

```bash
cd /home/th-yoo/z2/meta-harness
git add docs/2026-07-27-probe-grip-fix-design.md
git commit -m "docs(probe): pre-register false-accept arms (§6.3) — spend-gated, calibration protocol included

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

---

## Out of scope (explicitly)

- Running the §6.3 arms (spend — separate explicit go; ENV: podman up + oauth fresh + tmux + fresh-office-baseline provenance rules apply).
- §4.3 trial-mode integration (deferred plugin work; it CONSUMES the calibration number, nothing more).
- v2 trace-based spec coverage, requirement-deferral channel, S4 behavior-targeting mutation operators, gate-plugin wiring of the new probes (its `gate.json` has no probe config yet — daily sessions keep the unchanged completion gate).

## Self-review notes (done at write time)

- Spec coverage: §5.1 L1 → Tasks 1–3; metamorphic probes → Tasks 4–6; calibration → Task 8 protocol (arms spend-gated by design). Gap: none open inside the declared scope.
- Type consistency checked: `Requirement`/`Relation` names, `readVerify`/`runScript` optional members, `uncoveredReqs`/`violatedRelations` fields used identically in Tasks 3/4/7.
- Placeholder scan: all code blocks concrete; the two `requirements.json` files and six relation scripts are written out in full.
- Known honest limitations recorded where they bite: comment-stripping is a crude lexer (heredocs), marker matching is v1-gameable by echoing strings into executed code (recorded; desk test pins the comment channel), mr-rename is vacuous on empty result sets, `runScript` copy-failure is fail-open.
