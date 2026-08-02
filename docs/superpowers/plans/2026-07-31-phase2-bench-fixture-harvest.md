# Phase 2 — Blocked-Cycle → Bench-Fixture Harvest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert rare live blocked cycles into permanent offline TB2 fixtures, replayable at k=5 forever (roadmap `docs/2026-07-30-enhancement-roadmap.md` Phase 2).

**Architecture:** Three seams. (1) **Capture** — a new `fixture-ref.ts` module at the cc-gate-plugin hook-cli seam snapshots the dirty working tree at block time via a temp-index `git write-tree` + `git update-ref` (non-mutating), and appends a host-local `.km/fixture-refs.ndjson` record sharing the exact `(sessionID, ts, round)` key with the Phase 1 check-output sidecar. (2) **Harvest** — a km-crank CLI joins fixture-ref records with sidecar excerpts, extracts prompt context from the Claude Code transcript JSONL, and materializes the tree into a task directory. (3) **Convert** — pure renderers emit `task.toml` + `environment/Dockerfile` + `tests/` + `instruction.md` in the terminal-bench-2 layout, under git-tracked `term-bench2/tasks/`, runnable via the existing `--tb-root` flag (`opencode-plugin/src/bench/cli.ts:109` — no runner changes).

**Tech Stack:** Bun + TypeScript (matching cc-gate-plugin / km-crank), git plumbing (`write-tree`, `update-ref`, `archive`), podman + ubuntu:24.04 for the converted task image.

## Global Constraints

- **F1 (calibration tripwire):** NO commit may touch `cc-gate-plugin/src/core/` or `cc-gate-plugin/vendor/` (`km-crank/src/calibration.ts` MECHANISM_PATHS). All capture code lives in `cc-gate-plugin/src/fixture-ref.ts` + `hook-cli.ts` wiring — same precedent as Phase 1 `sidecar.ts`. Final task verifies `git log -- cc-gate-plugin/src/core cc-gate-plugin/vendor` is EMPTY over the phase's commits.
- **F2 (snapshot one-way door):** `.km/fixture-refs.ndjson` is host-local, code-adjacent, and must NEVER enter `scripts/km-sensors-sync.sh`'s `FILES` list. Tripwire test added in Task 1 (mirrors Phase 1's check-output tripwire in `cc-gate-plugin/test/sidecar.test.ts`).
- **Fail-open:** capture must never change the emitted Stop decision — same contract as `appendSensor`/`appendCheckOutput` (`sidecar.ts:54-71`).
- **gate-outcomes stream untouched:** no new fields on `SensorLine`, no spec amendment needed — fixture refs are evidence-only, registered by a docs note (Phase 1 precedent).
- **Private-repo inclusion:** harvest REFUSES any repo not in an explicit allowlist (per-repo user ruling; roadmap: "private-repo fixtures need an explicit inclusion decision per repo"). Allowlist ships EMPTY.
- **Vocabulary:** no bare "gate" in new docs/comments — say "cc-gate", "check", or "block".
- Suites must stay green: `bun test` in `cc-gate-plugin/` and `km-crank/`; `bunx tsc --noEmit` clean in both.

## File Structure

```
cc-gate-plugin/src/fixture-ref.ts          NEW  capture module (temp-index snapshot + ndjson append)
cc-gate-plugin/src/hook-cli.ts             MOD  block-branch wiring (shared blockTs; transcript_path extraction)
cc-gate-plugin/test/fixture-ref.test.ts    NEW  unit (fake runner) + real-git integration + F2 tripwire
km-crank/src/fixture-harvest.ts            NEW  pure: ref-record parsing, sidecar join, transcript prompt extraction
km-crank/src/tb2-task.ts                   NEW  pure: task.toml / Dockerfile / test.sh / instruction.md renderers
km-crank/src/harvest-cli.ts                NEW  CLI assembling harvest+convert; allowlist guard; git archive materialize
km-crank/test/fixture-harvest.test.ts      NEW
km-crank/test/tb2-task.test.ts             NEW
km-crank/test/harvest-cli.test.ts          NEW  allowlist refusal + end-to-end on temp scratch repo
term-bench2/tasks/                         OUT  harvested task dirs land here (git-tracked, deliberate)
docs/2026-07-31-phase2-fixture-registration.md  NEW  evidence-only registration note (Task 5)
```

Key layout decision (locked): one harvested task dir =

```
term-bench2/tasks/harvested-<repo>-<yyyymmdd-hhmmss>/
├── task.toml
├── instruction.md
├── fixture.json            # provenance: full joined record + prompt context
├── environment/
│   ├── Dockerfile
│   └── repo/               # tree materialized from the fixture ref via git archive
└── tests/
    ├── test.sh             # tamper guard + check run + reward write
    └── pristine.tar        # verifier-only copy of test files at capture time
```

---

### Task 1: fixture-ref capture module + hook-cli wiring (cc-gate-plugin)

**Files:**
- Create: `cc-gate-plugin/src/fixture-ref.ts`
- Create: `cc-gate-plugin/test/fixture-ref.test.ts`
- Modify: `cc-gate-plugin/src/hook-cli.ts:343-356` (block branch), `:230-233` (payload extraction)

**Interfaces:**
- Consumes: `buildCheckOutputRecord`/`appendCheckOutput` from `src/sidecar.ts` (unchanged), block decision shape `{kind:"block", round, roundsMax, rawOut?, evidence}` (`src/types.ts:103`).
- Produces: `FixtureRefRecord` type + `captureFixtureRef(args): Promise<void>` — consumed by km-crank Task 2 (record shape re-declared there per the standalone-package rule, Phase 1 T2 precedent).

Record shape (locked — Task 2 re-declares byte-compatible):

```ts
export interface FixtureRefRecord {
  ts: number            // SAME value as the paired check-output sidecar record
  sessionID: string
  round: number
  check: string
  headSha: string       // HEAD at block time ("" if unborn)
  treeSha: string       // git write-tree result ("" when bailed)
  ref: string           // refs/kkamak/fixtures/<ts>-<sid8>-r<round> ("" when bailed)
  transcriptPath?: string
  bail?: string         // "rebase-merge" | "rebase-apply" | "merge-head" | "cherry-pick" | "not-a-repo" | "git-failed: <step>"
}
```

- [ ] **Step 1: Write failing unit tests (fake git runner)**

`cc-gate-plugin/test/fixture-ref.test.ts` — inject a `run` dependency so units need no real git:

```ts
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { buildFixtureRef, FIXTURE_REF_REL_PATH, type GitRunner } from "../src/fixture-ref"

function fakeRunner(outputs: Record<string, string>): GitRunner {
  return async (argv) => {
    const key = argv.join(" ")
    for (const [prefix, out] of Object.entries(outputs)) {
      if (key.startsWith(prefix)) return { code: 0, out }
    }
    return { code: 128, out: "" }
  }
}

describe("buildFixtureRef", () => {
  test("happy path: write-tree + update-ref, record carries both shas", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fxref-"))
    fs.mkdirSync(path.join(dir, ".git"))
    const rec = await buildFixtureRef(
      { cwd: dir, ts: 1785400000000, sessionID: "abcd1234-x", round: 1, check: "bun test" },
      fakeRunner({
        "rev-parse HEAD": "headsha000\n",
        "add -A": "",
        "write-tree": "treesha111\n",
        "update-ref": "",
      }),
    )
    expect(rec.treeSha).toBe("treesha111")
    expect(rec.headSha).toBe("headsha000")
    expect(rec.ref).toBe("refs/kkamak/fixtures/1785400000000-abcd1234-r1")
    expect(rec.bail).toBeUndefined()
  })

  test("bails mid-rebase without running any git mutation", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fxref-"))
    fs.mkdirSync(path.join(dir, ".git", "rebase-merge"), { recursive: true })
    let calls = 0
    const rec = await buildFixtureRef(
      { cwd: dir, ts: 1, sessionID: "s", round: 1, check: "c" },
      async () => { calls++; return { code: 0, out: "" } },
    )
    expect(rec.bail).toBe("rebase-merge")
    expect(rec.treeSha).toBe("")
    expect(calls).toBe(0)
  })

  test("bails not-a-repo when .git missing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fxref-"))
    const rec = await buildFixtureRef(
      { cwd: dir, ts: 1, sessionID: "s", round: 1, check: "c" },
      async () => ({ code: 0, out: "" }),
    )
    expect(rec.bail).toBe("not-a-repo")
  })

  test("git failure surfaces as bail, never throws", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fxref-"))
    fs.mkdirSync(path.join(dir, ".git"))
    const rec = await buildFixtureRef(
      { cwd: dir, ts: 1, sessionID: "s", round: 1, check: "c" },
      async () => ({ code: 128, out: "boom" }),
    )
    expect(rec.bail).toMatch(/^git-failed: /)
  })
})
```

- [ ] **Step 2: Run tests, verify FAIL** — `cd cc-gate-plugin && bun test test/fixture-ref.test.ts` → "Cannot find module '../src/fixture-ref'".

- [ ] **Step 3: Implement `src/fixture-ref.ts`**

```ts
/**
 * fixture-ref.ts — Phase 2 block-time repo snapshot (evidence-only).
 * Lives at the hook-cli seam ON PURPOSE (F1): src/core/ and vendor/ are
 * MECHANISM_PATHS. Host-local; NEVER exported by km-sensors-sync.sh (F2).
 * Non-mutating: temp GIT_INDEX_FILE, working index and tree untouched.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const FIXTURE_REF_REL_PATH = ".km/fixture-refs.ndjson"

export interface FixtureRefRecord { /* exact shape from the Interfaces block above */ }

export type GitRunner = (argv: string[], env?: Record<string, string>) => Promise<{ code: number; out: string }>

export const bunGitRunner: GitRunner = async (argv, env) => {
  const proc = Bun.spawn(["git", ...argv], {
    cwd: env?.__cwd,
    env: { ...process.env, ...env },
    stdout: "pipe", stderr: "pipe",
  })
  const timer = setTimeout(() => { try { proc.kill("SIGKILL") } catch {} }, 15_000)
  const out = await new Response(proc.stdout).text()
  const code = await proc.exited
  clearTimeout(timer)
  return { code, out }
}

const BAILS: Array<[string, string]> = [
  ["rebase-merge", ".git/rebase-merge"],
  ["rebase-apply", ".git/rebase-apply"],
  ["merge-head", ".git/MERGE_HEAD"],
  ["cherry-pick", ".git/CHERRY_PICK_HEAD"],
]

export async function buildFixtureRef(
  args: { cwd: string; ts: number; sessionID: string; round: number; check: string; transcriptPath?: string },
  run: GitRunner,
): Promise<FixtureRefRecord> {
  const base = {
    ts: args.ts, sessionID: args.sessionID, round: args.round, check: args.check,
    headSha: "", treeSha: "", ref: "",
    ...(args.transcriptPath ? { transcriptPath: args.transcriptPath } : {}),
  }
  if (!fs.existsSync(path.join(args.cwd, ".git"))) return { ...base, bail: "not-a-repo" }
  for (const [name, rel] of BAILS) {
    if (fs.existsSync(path.join(args.cwd, rel))) return { ...base, bail: name }
  }
  const tmpIndex = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kkamak-fxidx-")), "index")
  const env = { __cwd: args.cwd, GIT_INDEX_FILE: tmpIndex }
  try {
    const head = await run(["rev-parse", "HEAD"], env)
    const headSha = head.code === 0 ? head.out.trim() : ""
    const add = await run(["add", "-A"], env)
    if (add.code !== 0) return { ...base, headSha, bail: "git-failed: add" }
    const wt = await run(["write-tree"], env)
    if (wt.code !== 0) return { ...base, headSha, bail: "git-failed: write-tree" }
    const treeSha = wt.out.trim()
    const ref = `refs/kkamak/fixtures/${args.ts}-${args.sessionID.slice(0, 8)}-r${args.round}`
    const ur = await run(["update-ref", ref, treeSha], env)
    if (ur.code !== 0) return { ...base, headSha, treeSha, bail: "git-failed: update-ref" }
    return { ...base, headSha, treeSha, ref }
  } finally {
    try { fs.rmSync(path.dirname(tmpIndex), { recursive: true, force: true }) } catch {}
  }
}

/** mkdir -p + append one ndjson line; never throws (appendCheckOutput contract). */
export function appendFixtureRef(cwd: string, rec: FixtureRefRecord, log: (msg: string) => void): void {
  try {
    const p = path.resolve(cwd, FIXTURE_REF_REL_PATH)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.appendFileSync(p, JSON.stringify(rec) + "\n")
  } catch (e) {
    try { log(`hook-cli: failed to append fixture-ref (swallowed): ${String(e)}`) } catch {}
  }
}

/** Full capture: build + append, swallowing everything (fail-open). */
export async function captureFixtureRef(
  args: { cwd: string; ts: number; sessionID: string; round: number; check: string; transcriptPath?: string },
  run: GitRunner,
  log: (msg: string) => void,
): Promise<void> {
  try {
    appendFixtureRef(args.cwd, await buildFixtureRef(args, run), log)
  } catch (e) {
    try { log(`hook-cli: fixture capture failed (swallowed): ${String(e)}`) } catch {}
  }
}
```

Note: `GitRunner` passes cwd via the `__cwd` env-map key to keep one injectable signature; `bunGitRunner` strips it. If the implementer prefers an explicit `{cwd, env}` options object, that is fine — keep the runner injectable either way.

- [ ] **Step 4: Run unit tests, verify PASS.**

- [ ] **Step 5: Add real-git integration test + F2 tripwire test (same file)**

```ts
describe("integration (real git)", () => {
  test("snapshots dirty tree without touching working index", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fxref-int-"))
    const sh = (cmd: string) => Bun.spawnSync(["bash", "-c", cmd], { cwd: dir })
    sh("git init -q && git config user.email t@t && git config user.name t")
    fs.writeFileSync(path.join(dir, "a.txt"), "committed\n")
    sh("git add -A && git commit -qm init")
    fs.writeFileSync(path.join(dir, "a.txt"), "DIRTY\n")           // unstaged edit
    fs.writeFileSync(path.join(dir, "new.txt"), "untracked\n")      // untracked file
    const { buildFixtureRef, bunGitRunner } = await import("../src/fixture-ref")
    const rec = await buildFixtureRef(
      { cwd: dir, ts: 42, sessionID: "sessAAAA-1", round: 2, check: "bun test" }, bunGitRunner)
    expect(rec.bail).toBeUndefined()
    // tree contains BOTH the dirty edit and the untracked file
    const show = sh(`git cat-file -p ${rec.treeSha}`)
    expect(show.stdout.toString()).toContain("new.txt")
    // working index untouched: status still shows the edit as unstaged
    expect(sh("git status --porcelain").stdout.toString()).toContain(" M a.txt")
    // ref resolvable
    expect(sh(`git rev-parse ${rec.ref}`).stdout.toString().trim()).toBe(rec.treeSha)
  })
})

describe("F2 tripwire", () => {
  test("fixture-refs.ndjson never enters km-sensors-sync FILES", () => {
    const sync = fs.readFileSync(path.join(import.meta.dir, "../../scripts/km-sensors-sync.sh"), "utf-8")
    expect(sync).not.toContain("fixture-refs")
  })
})
```

- [ ] **Step 6: Run full new test file, verify PASS.**

- [ ] **Step 7: Wire hook-cli block branch**

In `hook-cli.ts` payload extraction (after line 231):

```ts
const transcriptPath = typeof rec.transcript_path === "string" && rec.transcript_path
  ? rec.transcript_path : undefined
```

Replace the block branch (current lines 343-356) so BOTH sidecars share one `blockTs` (the exact join key for Task 2):

```ts
if (decision.kind === "block") {
  const blockTs = Date.now()
  appendCheckOutput(
    cwd,
    buildCheckOutputRecord({
      ts: blockTs,
      sessionID: sessionId,
      round: decision.round,
      roundsMax: decision.roundsMax,
      check: cfg?.check ?? "",
      rawText: decision.rawOut ?? decision.evidence,
    }),
    deps.log,
  )
  // Phase 2 fixture ref (evidence-only): snapshot the dirty tree that the
  // failing check saw. Fail-open inside; never touches gate-outcomes,
  // never changes the decision. Shares blockTs with the check-output
  // record — (sessionID, ts, round) is the harvest join key.
  await captureFixtureRef(
    { cwd, ts: blockTs, sessionID: sessionId, round: decision.round, check: cfg?.check ?? "", transcriptPath },
    bunGitRunner,
    deps.log,
  )
}
```

Imports: add `captureFixtureRef, bunGitRunner` from `./fixture-ref`. `StopInput` (`types.ts:90`) stays UNCHANGED — transcript_path never enters `core/stop.ts` (F1 stays trivially clean).

- [ ] **Step 8: Full suite + typecheck** — `cd cc-gate-plugin && bun test && bunx tsc --noEmit`. Expect all green (394+ tests).

- [ ] **Step 9: Verify F1 clean** — `git status` shows NO changes under `cc-gate-plugin/src/core/` or `cc-gate-plugin/vendor/`.

- [ ] **Step 10: Commit**

```bash
git add cc-gate-plugin/src/fixture-ref.ts cc-gate-plugin/test/fixture-ref.test.ts cc-gate-plugin/src/hook-cli.ts
git commit -m "feat(cc-gate): phase 2 block-time fixture ref — temp-index snapshot + .km/fixture-refs.ndjson sidecar"
```

---

### Task 2: harvest pure core — record parsing, sidecar join, transcript prompt extraction (km-crank)

**Files:**
- Create: `km-crank/src/fixture-harvest.ts`
- Create: `km-crank/test/fixture-harvest.test.ts`

**Interfaces:**
- Consumes: `CheckOutputRecord` + `parseCheckOutputRecords` from `km-crank/src/check-output.ts` (Phase 1).
- Produces (Task 4 consumes): `FixtureRefRecord` (re-declared, byte-compatible with Task 1), `parseFixtureRefRecords(text: string): FixtureRefRecord[]`, `joinFixture(ref: FixtureRefRecord, sidecar: CheckOutputRecord[]): HarvestJoin`, `extractPromptContext(jsonlText: string, beforeTs: number): PromptContext`.

```ts
export interface HarvestJoin {
  ref: FixtureRefRecord
  excerpt?: string          // from the (sessionID, ts, round)-matched sidecar record
  elidedChars?: number
}
export interface PromptContext {
  firstUser?: string        // opening ask of the session (task statement)
  lastUser?: string         // most recent user text at/before beforeTs
}
```

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, test } from "bun:test"
import { extractPromptContext, joinFixture, parseFixtureRefRecords } from "../src/fixture-harvest"
import { parseCheckOutputRecords } from "../src/check-output"

const REF = { ts: 100, sessionID: "s1", round: 2, check: "bun test", headSha: "h", treeSha: "t", ref: "refs/kkamak/fixtures/100-s1-r2" }

describe("parseFixtureRefRecords", () => {
  test("parses valid lines, skips malformed + bailed-shape-invalid silently", () => {
    const text = JSON.stringify(REF) + "\n" + "not json\n" + JSON.stringify({ ts: 1 }) + "\n"
    const recs = parseFixtureRefRecords(text)
    expect(recs.length).toBe(1)
    expect(recs[0].treeSha).toBe("t")
  })
  test("keeps bail records (observability) — caller filters", () => {
    const bailed = { ...REF, treeSha: "", ref: "", bail: "rebase-merge" }
    expect(parseFixtureRefRecords(JSON.stringify(bailed) + "\n")[0].bail).toBe("rebase-merge")
  })
})

describe("joinFixture", () => {
  test("matches sidecar record on exact (sessionID, ts, round)", () => {
    const sidecar = parseCheckOutputRecords(
      JSON.stringify({ ts: 100, sessionID: "s1", round: 2, roundsMax: 3, check: "bun test", excerpt: "FAIL x" }) + "\n" +
      JSON.stringify({ ts: 99, sessionID: "s1", round: 1, roundsMax: 3, check: "bun test", excerpt: "older" }) + "\n")
    const j = joinFixture(REF, sidecar)
    expect(j.excerpt).toBe("FAIL x")
  })
  test("no match → excerpt undefined (fixture still harvestable)", () => {
    expect(joinFixture(REF, []).excerpt).toBeUndefined()
  })
})

describe("extractPromptContext", () => {
  // Claude Code transcript JSONL: parse DEFENSIVELY — only lines with
  // type:"user" and a string-or-blocks message.content survive.
  const line = (ts: string, role: string, content: unknown) =>
    JSON.stringify({ type: role, timestamp: ts, message: { role, content } }) + "\n"
  test("first + last user text before cutoff", () => {
    const jsonl =
      line("2026-07-31T01:00:00Z", "user", "make the tests pass") +
      line("2026-07-31T01:01:00Z", "assistant", [{ type: "text", text: "ok" }]) +
      line("2026-07-31T01:02:00Z", "user", [{ type: "text", text: "also fix lint" }]) +
      line("2026-07-31T09:00:00Z", "user", "AFTER CUTOFF — must be ignored")
    const ctx = extractPromptContext(jsonl, Date.parse("2026-07-31T02:00:00Z"))
    expect(ctx.firstUser).toBe("make the tests pass")
    expect(ctx.lastUser).toBe("also fix lint")
  })
  test("tool_result-only user lines are skipped; garbage lines skipped", () => {
    const jsonl =
      line("2026-07-31T01:00:00Z", "user", "real ask") +
      line("2026-07-31T01:03:00Z", "user", [{ type: "tool_result", content: "..." }]) +
      "garbage\n"
    const ctx = extractPromptContext(jsonl, Date.parse("2026-07-31T02:00:00Z"))
    expect(ctx.lastUser).toBe("real ask")
  })
  test("empty/unreadable transcript → both undefined", () => {
    expect(extractPromptContext("", 1).firstUser).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run, verify FAIL** — `cd km-crank && bun test test/fixture-harvest.test.ts`.

- [ ] **Step 3: Implement `src/fixture-harvest.ts`**

```ts
/** Phase 2 harvest core — PURE (no fs, no subprocess): parse fixture-ref
 * ndjson, join with the Phase 1 check-output sidecar, extract prompt
 * context from a Claude Code transcript JSONL string. Host-local inputs;
 * never exported (F2). */
import type { CheckOutputRecord } from "./check-output"

export interface FixtureRefRecord { /* byte-compatible re-declaration of Task 1's shape (standalone-package rule) */ }

export function parseFixtureRefRecords(text: string): FixtureRefRecord[] {
  const out: FixtureRefRecord[] = []
  for (const ln of text.split("\n")) {
    if (!ln.trim()) continue
    try {
      const o = JSON.parse(ln) as Record<string, unknown>
      if (typeof o.ts !== "number" || typeof o.sessionID !== "string" || typeof o.round !== "number"
        || typeof o.check !== "string" || typeof o.headSha !== "string" || typeof o.treeSha !== "string"
        || typeof o.ref !== "string") continue
      out.push(o as unknown as FixtureRefRecord)
    } catch { /* skip malformed */ }
  }
  return out
}

export interface HarvestJoin { ref: FixtureRefRecord; excerpt?: string; elidedChars?: number }

export function joinFixture(ref: FixtureRefRecord, sidecar: CheckOutputRecord[]): HarvestJoin {
  const m = sidecar.find((r) => r.sessionID === ref.sessionID && r.ts === ref.ts && r.round === ref.round)
  return m ? { ref, excerpt: m.excerpt, ...(m.elidedChars !== undefined ? { elidedChars: m.elidedChars } : {}) } : { ref }
}

export interface PromptContext { firstUser?: string; lastUser?: string }

function userText(content: unknown): string | undefined {
  if (typeof content === "string") return content || undefined
  if (Array.isArray(content)) {
    const texts = content
      .filter((b): b is { type: string; text: string } =>
        typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "text"
        && typeof (b as Record<string, unknown>).text === "string")
      .map((b) => b.text)
    return texts.length ? texts.join("\n") : undefined
  }
  return undefined
}

export function extractPromptContext(jsonlText: string, beforeTs: number): PromptContext {
  let firstUser: string | undefined
  let lastUser: string | undefined
  for (const ln of jsonlText.split("\n")) {
    if (!ln.trim()) continue
    try {
      const o = JSON.parse(ln) as Record<string, unknown>
      if (o.type !== "user") continue
      const ts = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN
      if (!Number.isNaN(ts) && ts > beforeTs) continue
      const msg = o.message as Record<string, unknown> | undefined
      const text = userText(msg?.content)
      if (!text) continue
      if (firstUser === undefined) firstUser = text
      lastUser = text
    } catch { /* skip */ }
  }
  return { firstUser, lastUser }
}
```

- [ ] **Step 4: Run tests, verify PASS.** Then `bunx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add km-crank/src/fixture-harvest.ts km-crank/test/fixture-harvest.test.ts
git commit -m "feat(km-crank): phase 2 harvest core — fixture-ref parse, sidecar join, transcript prompt extraction"
```

---

### Task 3: TB2 renderers — task.toml / Dockerfile / test.sh / instruction.md (km-crank, pure)

**Files:**
- Create: `km-crank/src/tb2-task.ts`
- Create: `km-crank/test/tb2-task.test.ts`

**Interfaces:**
- Consumes: `HarvestJoin`, `PromptContext` from Task 2.
- Produces (Task 4 consumes): `renderTaskToml`, `renderDockerfile`, `renderTestSh`, `renderInstruction` — all `(args) => string`, plus `TEST_PRISTINE_GLOBS: string[]`.

Rendered-format facts (verified against a real terminal-bench-2 task, e.g. `dna-assembly/task.toml`): `schema_version = "1.1"`; `[task]` name/description; `[metadata]` difficulty/category/tags; `[verifier].timeout_sec`; `[agent].timeout_sec`; `[environment]` build_timeout_sec/cpus/memory_mb/storage_mb/gpus/allow_internet. Verifier convention: `tests/test.sh` invoked in-container; writes `/logs/verifier/reward.txt` `1`|`0`.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, test } from "bun:test"
import { renderDockerfile, renderInstruction, renderTaskToml, renderTestSh } from "../src/tb2-task"

describe("renderTaskToml", () => {
  const toml = renderTaskToml({
    name: "harvested-kkamak-20260731-101500",
    description: "Harvested blocked cycle: bun test failing after agent turn",
    check: "bun test",
    agentTimeoutSec: 900, verifierTimeoutSec: 300,
  })
  test("carries schema 1.1, name, harvested category, internet on", () => {
    expect(toml).toContain('schema_version = "1.1"')
    expect(toml).toContain('name = "terminal-bench/harvested-kkamak-20260731-101500"')
    expect(toml).toContain('category = "harvested"')
    expect(toml).toContain("allow_internet = true")
    expect(toml).toContain("timeout_sec = 900")
  })
})

describe("renderDockerfile", () => {
  const df = renderDockerfile({})
  test("ubuntu 24.04 base, bun install, repo copied to /app", () => {
    expect(df).toContain("FROM ubuntu:24.04")
    expect(df).toContain("bun.sh/install")
    expect(df).toContain("COPY repo/ /app/")
    expect(df).toContain("WORKDIR /app")
  })
})

describe("renderTestSh", () => {
  const sh = renderTestSh({ check: "bun test" })
  test("tamper guard restores pristine test files before the check", () => {
    expect(sh).toContain("pristine.tar")
    expect(sh).toContain("bun test")
    expect(sh).toContain("/logs/verifier/reward.txt")
  })
  test("check command is not shell-mangled", () => {
    expect(renderTestSh({ check: 'bun test --filter "x y"' })).toContain('bun test --filter "x y"')
  })
})

describe("renderInstruction", () => {
  test("includes prompt context, check command, and failure excerpt", () => {
    const md = renderInstruction({
      check: "bun test",
      prompt: { firstUser: "build the parser", lastUser: "now make tests pass" },
      excerpt: "1 fail: parser.test.ts",
    })
    expect(md).toContain("build the parser")
    expect(md).toContain("bun test")
    expect(md).toContain("parser.test.ts")
  })
})
```

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement `src/tb2-task.ts`**

```ts
/** Phase 2 TB2 renderers — PURE string generation for a harvested task dir
 * in the terminal-bench-2 layout. No fs. */

export const TEST_PRISTINE_GLOBS = ["test", "tests", "__tests__"]  // dirs restored by the tamper guard

export function renderTaskToml(a: {
  name: string; description: string; check: string
  agentTimeoutSec: number; verifierTimeoutSec: number
}): string {
  return `schema_version = "1.1"
artifacts = []

[task]
name = "terminal-bench/${a.name}"
description = ${JSON.stringify(a.description)}
keywords = ["harvested", "kkamak"]

[metadata]
difficulty = "medium"
category = "harvested"
tags = ["harvested", "dogfood"]

[verifier]
timeout_sec = ${a.verifierTimeoutSec}.0

[agent]
timeout_sec = ${a.agentTimeoutSec}.0

[environment]
build_timeout_sec = 900.0
cpus = 1
memory_mb = 2048
storage_mb = 10240
gpus = 0
allow_internet = true
mcp_servers = []
`
}

export function renderDockerfile(_a: Record<string, never>): string {
  return `FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates unzip git && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:\${PATH}"
WORKDIR /app
COPY repo/ /app/
RUN bun install --frozen-lockfile || bun install || true
`
}

export function renderTestSh(a: { check: string }): string {
  return `#!/bin/bash
# Harvested-fixture verifier: restore pristine test files (tamper guard),
# then run the original failing check. Reward 1 iff it passes.
set -u
mkdir -p /logs/verifier
cd /app
# Tamper guard: the check lives inside the repo, so an agent could "pass"
# by editing the tests. Restore test dirs from the capture-time archive.
if [ -f /tests/pristine.tar ]; then
  tar -xf /tests/pristine.tar -C /app
fi
if ${a.check}; then
  echo 1 > /logs/verifier/reward.txt
else
  echo 0 > /logs/verifier/reward.txt
fi
`
}

export function renderInstruction(a: {
  check: string
  prompt: { firstUser?: string; lastUser?: string }
  excerpt?: string
}): string {
  const parts: string[] = ["# Task (harvested from a live blocked cycle)\n"]
  if (a.prompt.firstUser) parts.push(`## Original session ask\n\n${a.prompt.firstUser}\n`)
  if (a.prompt.lastUser && a.prompt.lastUser !== a.prompt.firstUser)
    parts.push(`## Most recent instruction before the block\n\n${a.prompt.lastUser}\n`)
  parts.push(`## Your goal\n\nThe repository in /app currently FAILS its check. Make the following command pass without weakening or deleting tests:\n\n~~~\n${a.check}\n~~~\n`)
  if (a.excerpt) parts.push(`## Failing check output at capture time\n\n~~~\n${a.excerpt}\n~~~\n`)
  return parts.join("\n")
}
```

- [ ] **Step 4: Run tests, verify PASS.** `bunx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add km-crank/src/tb2-task.ts km-crank/test/tb2-task.test.ts
git commit -m "feat(km-crank): phase 2 TB2 renderers — task.toml/Dockerfile/test.sh/instruction for harvested fixtures"
```

---

### Task 4: harvest CLI — allowlist guard, git-archive materialize, task-dir assembly (km-crank)

**Files:**
- Create: `km-crank/src/harvest-cli.ts`
- Create: `km-crank/test/harvest-cli.test.ts`

**Interfaces:**
- Consumes: Task 2 (`parseFixtureRefRecords`, `joinFixture`, `extractPromptContext`), Task 3 renderers, `parseCheckOutputRecords` from `check-output.ts`.
- Produces: `harvestFixture(opts): Promise<string>` (returns created task-dir path) + `import.meta.main`-guarded CLI:
  `bun km-crank/src/harvest-cli.ts <repoPath> [--ref <fixtureRef>] [--out <tasksDir>] [--name <taskName>]`
  Default `--out`: `<meta-repo>/term-bench2/tasks`. Default `--ref`: newest non-bailed record.

Locked behaviors:
1. **Allowlist guard (private-repo one-way door):** `export const FIXTURE_ALLOWED_REPOS: string[] = []` — harvest refuses (`throws HarvestRefusal`) any repo whose basename is not listed. NO bypass flag. Adding a repo = a reviewed commit = the explicit per-repo inclusion ruling. Test asserts refusal message names the roadmap clause.
2. **Materialize:** `git -C <repo> archive --format=tar <treeSha> | tar -x -C <taskDir>/environment/repo` (uses the ref's treeSha, works for tree objects).
3. **Pristine test archive:** from `environment/repo`, tar the `TEST_PRISTINE_GLOBS` dirs that exist into `tests/pristine.tar` (empty archive if none — test.sh tolerates).
4. **Secrets hygiene:** after materialize, delete `environment/repo/.km/` and `environment/repo/.env*` if present (host-local runtime state and secrets must not enter a committed fixture).
5. **fixture.json:** full `HarvestJoin` + `PromptContext` + generation timestamp — provenance for the future k=5 replay writeup.
6. **Transcript read:** `fs.readFileSync(ref.transcriptPath)` best-effort; unreadable → empty PromptContext (fixture still valid).

- [ ] **Step 1: Write failing tests** — three cases: (a) refusal for unlisted repo (message contains "per-repo inclusion"); (b) end-to-end on a temp scratch repo (init git repo with a `test/` dir + failing `exit 1` check record chain written by hand, temporarily monkey-patching `FIXTURE_ALLOWED_REPOS` via an injectable `allowedRepos` option on `harvestFixture` — the CLI passes the constant, tests pass their own); assert created dir contains `task.toml`, `instruction.md`, `fixture.json`, `environment/Dockerfile`, `environment/repo/<files>`, `tests/test.sh`, `tests/pristine.tar`, and that `environment/repo/.km/` was stripped; (c) `--ref` selection: bailed records are never auto-picked.

```ts
// test skeleton (full assertions per the list above)
import { describe, expect, test } from "bun:test"
import fs from "node:fs"; import os from "node:os"; import path from "node:path"
import { harvestFixture } from "../src/harvest-cli"

function scratchRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harvest-e2e-"))
  const sh = (c: string) => Bun.spawnSync(["bash", "-c", c], { cwd: dir })
  sh("git init -q && git config user.email t@t && git config user.name t")
  fs.mkdirSync(path.join(dir, "test"))
  fs.writeFileSync(path.join(dir, "test", "x.test.ts"), "// failing test placeholder\n")
  fs.writeFileSync(path.join(dir, "app.ts"), "export const x = 1\n")
  fs.mkdirSync(path.join(dir, ".km"), { recursive: true })
  sh("git add -A && git commit -qm init")
  // fixture ref via the same plumbing Task 1 uses
  sh("git add -A && git write-tree > .treesha")
  const treeSha = fs.readFileSync(path.join(dir, ".treesha"), "utf-8").trim()
  sh(`git update-ref refs/kkamak/fixtures/100-scratch-r1 ${treeSha}`)
  fs.writeFileSync(path.join(dir, ".km", "fixture-refs.ndjson"),
    JSON.stringify({ ts: 100, sessionID: "scratchsess", round: 1, check: "exit 1",
      headSha: "x", treeSha, ref: "refs/kkamak/fixtures/100-scratch-r1" }) + "\n")
  fs.writeFileSync(path.join(dir, ".km", "check-output.ndjson"),
    JSON.stringify({ ts: 100, sessionID: "scratchsess", round: 1, roundsMax: 2,
      check: "exit 1", excerpt: "synthetic failure output" }) + "\n")
  return dir
}

describe("harvestFixture", () => {
  test("refuses repos outside the allowlist", async () => {
    const dir = scratchRepo()
    await expect(harvestFixture({ repoPath: dir, outDir: fs.mkdtempSync(path.join(os.tmpdir(), "out-")), allowedRepos: [] }))
      .rejects.toThrow(/per-repo inclusion/)
  })
  test("end-to-end: materializes full task dir, strips .km", async () => {
    const dir = scratchRepo()
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "out-"))
    const taskDir = await harvestFixture({ repoPath: dir, outDir: out, allowedRepos: [path.basename(dir)] })
    for (const f of ["task.toml", "instruction.md", "fixture.json", "environment/Dockerfile",
      "environment/repo/app.ts", "tests/test.sh", "tests/pristine.tar"])
      expect(fs.existsSync(path.join(taskDir, f))).toBe(true)
    expect(fs.existsSync(path.join(taskDir, "environment/repo/.km"))).toBe(false)
    const fx = JSON.parse(fs.readFileSync(path.join(taskDir, "fixture.json"), "utf-8"))
    expect(fx.excerpt).toBe("synthetic failure output")
  })
})
```

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement `harvest-cli.ts`** — assemble from Tasks 2+3; `HarvestRefusal extends Error`; task name default `harvested-<repoBasename>-<yyyymmdd-hhmmss from ref.ts>`; `import.meta.main` guard (crank.ts:485 precedent — `bun test` must never harvest). Subprocess pattern: `Bun.spawnSync(["bash", "-c", cmd])` with explicit cwd, checking exit codes, no shell interpolation of user strings beyond the treeSha/paths already validated by parse.

- [ ] **Step 4: Run tests, verify PASS.** Full `bun test` + `bunx tsc --noEmit` in km-crank.

- [ ] **Step 5: Commit**

```bash
git add km-crank/src/harvest-cli.ts km-crank/test/harvest-cli.test.ts
git commit -m "feat(km-crank): phase 2 harvest CLI — allowlist-guarded fixture materialize + TB2 task assembly"
```

---

### Task 5: end-to-end container smoke + registration note + F1/F2 phase verification

**Files:**
- Create: `docs/2026-07-31-phase2-fixture-registration.md`
- No product code (smoke uses scratch dirs; committed only if it produces a keeper fixture — it will not: scratch repo is not on the allowlist by commit).

**Interfaces:** consumes everything; produces the sealed phase.

- [ ] **Step 1: Live capture smoke (installed-copy analog of Phase 1 T4):** temp scratch git repo with `gate.json` (`check: "bun test"`, rounds 2) + one intentionally failing `bun test`; drive `cc-gate-plugin/src/hook-cli.ts` from the WORKING TREE with a synthetic Stop payload (Phase 1 smoke recipe) after an edit-marking PostToolUse; assert `.km/fixture-refs.ndjson` gained a non-bailed record whose `treeSha` resolves via `git rev-parse` and whose `ts` equals the paired `check-output.ndjson` record's `ts`.

- [ ] **Step 2: Harvest smoke:** run `bun km-crank/src/harvest-cli.ts <scratch>` with the scratch repo temporarily allowlisted VIA THE TEST-ONLY `allowedRepos` option in a one-off driver script (the committed constant stays `[]`). Inspect the produced task dir by hand: instruction.md readable, fixture.json provenance complete.

- [ ] **Step 3: Container fidelity smoke (podman, office host):**

```bash
cd <produced-task-dir>/environment && podman build -t harvest-smoke .
podman run --rm -v <produced-task-dir>/tests:/tests:ro harvest-smoke \
  bash -c 'mkdir -p /logs/verifier && bash /tests/test.sh; cat /logs/verifier/reward.txt'
```

Expected: `0` — the fixture REPRODUCES the failure (oracle-inverse). Then flip: fix the failing test inside the container (`podman run -it` shell, edit, rerun `/tests/test.sh`) → expect `1` — the verifier senses a fix. Both directions must hold before the phase seals.

- [ ] **Step 4: Registration note** — `docs/2026-07-31-phase2-fixture-registration.md`: fixture-refs sidecar is evidence-only (Phase 1 template): never in km-sensors-sync FILES, no SensorLine change, no §4.3 metric touches; ref namespace `refs/kkamak/fixtures/*` (host-local until a per-repo inclusion ruling adds the repo to `FIXTURE_ALLOWED_REPOS` AND its refs are pushed); allowlist = the ruling's implementation point; known limitation: exhausted final rounds not captured (rawOut confined to core/, F1 — Phase 1 precedent) and tamper guard restores only `TEST_PRISTINE_GLOBS` dirs.

- [ ] **Step 5: Phase verification** — `git log --oneline <phase-base>..HEAD -- cc-gate-plugin/src/core cc-gate-plugin/vendor` EMPTY; `git log --oneline <phase-base>..HEAD -- scripts/km-sensors-sync.sh` EMPTY; both suites + `bunx tsc --noEmit` green; record suite counts.

- [ ] **Step 6: Commit**

```bash
git add docs/2026-07-31-phase2-fixture-registration.md
git commit -m "docs: phase 2 fixture-harvest registration note + smoke evidence"
```

---

## Deferred within the phase (explicit, not silent)

- **First REAL k=5 replay** — blocked on the first live block event reaching the sidecars (none exist yet as of 2026-07-31). When one lands: per-repo inclusion ruling → allowlist commit → harvest → `bun term-bench2/runner.ts run --tb-root term-bench2/tasks --tasks <name> --driver claude-code --k 5`. That run is model-token spend: explicit go required.
- **Ref pushing / cross-host fixture travel** — `refs/kkamak/fixtures/*` do not travel on default pushes; the harvested task dir (committed) is the travel vehicle. Pushing raw refs deferred until a real need.
- **Solution dirs for harvested tasks** — the eventual human fix commit could become `solution/`; deferred until a real fixture exists.

## Self-review notes

- Roadmap coverage: state ref ✅ (T1), fixture record incl. transcript prompt context ✅ (T1 transcriptPath + T2 extraction), TB2 converter ✅ (T3+T4), fidelity work ✅ (T5 podman both-directions smoke), private-repo decision ✅ (allowlist one-way door, T4), no §4.3 ceremony ✅ (registration note, T5).
- Deviation from roadmap text: capture keys on exact shared `blockTs` instead of nearest-ts join — strictly stronger; noted in T1 Step 7.
- Type consistency: `FixtureRefRecord` re-declared in km-crank byte-compatible (Phase 1 T2 standalone-package precedent); `HarvestJoin`/`PromptContext` produced in T2, consumed T3/T4 with matching field names.
