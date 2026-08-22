/** Integration tests for scripts/gate-check.ts in THROWAWAY temp git repos.
 * The KKAMAK_GATE_COMMANDS seam points every suite and the full check at
 * tiny fake scripts (touch/exit) so no real suite ever runs. Background
 * assertions poll the marker file (condition-based waiting, never bare
 * sleeps). All spawned pids are collected and SIGTERMed pid-scoped in
 * afterEach. */
import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { realCommands, dirtyTreeId } from "../../scripts/gate-check.ts"

const GATE_CHECK = path.join(import.meta.dir, "..", "..", "scripts", "gate-check.ts")
const CLEANUP: string[] = []
const CLEANUP_PIDS: number[] = []
afterEach(() => {
  for (const p of CLEANUP_PIDS.splice(0)) { try { process.kill(p) } catch {} }  // pid-scoped only
  for (const d of CLEANUP.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function tempRepo(): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "gate-check-"))
  CLEANUP.push(dir)
  execFileSync("git", ["init", "-q"], { cwd: dir })
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir })
  fs.mkdirSync(path.join(dir, ".km"), { recursive: true })
  return dir
}

/** Command-table fixture: every suite runs `fake.ts <suite>` which appends
 * its suite id to ran.txt (and its full argv tail to args.txt — lets tests
 * assert appended slow-test files) and exits with the code in exits.json
 * (default 0). The full check appends "FULL". */
function writeCommands(dir: string): string {
  const fake = path.join(dir, "fake.ts")
  fs.writeFileSync(fake, `
const fs = require("node:fs"); const path = require("node:path")
const dir = ${JSON.stringify(dir)}
const tag = process.argv[2]
fs.appendFileSync(path.join(dir, "ran.txt"), tag + "\\n")
fs.appendFileSync(path.join(dir, "args.txt"), process.argv.slice(2).join(" ") + "\\n")
console.log("FAKE_OUT:" + tag)   // lets tests prove output capture is real
let exits = {}
try { exits = JSON.parse(fs.readFileSync(path.join(dir, "exits.json"), "utf8")) } catch {}
let code = exits[tag] ?? 0
// An ARRAY is a per-invocation sequence, consumed left to right and
// persisted back — lets a test express "fails once, then passes", which is
// the shape of a contention flake. Scalars behave exactly as before.
if (Array.isArray(code)) {
  const seq = code
  code = seq.length ? seq.shift() : 0
  exits[tag] = seq
  fs.writeFileSync(path.join(dir, "exits.json"), JSON.stringify(exits))
}
process.exit(code)
`)
  const table = {
    suites: Object.fromEntries(["ccgate", "opencode", "gateplugin", "kmcrank", "doccheck"]
      .map((s) => [s, { cwd: ".", argv: ["bun", fake, s] }])),
    full: { cwd: ".", argv: ["bun", fake, "FULL"] },
  }
  const p = path.join(dir, "commands.json")
  fs.writeFileSync(p, JSON.stringify(table))
  return p
}

function runGate(dir: string, extraEnv: Record<string, string> = {}) {
  // DEVIATION: strip ambient KKAMAK_GATE_* control vars before merging —
  // see task-2-report.md. Without this, an ambient KKAMAK_GATE_NO_BG=1
  // (e.g. set by a caller running THIS script over the repo, which spawns
  // `bun test` in km-crank as its own "kmcrank" tier0 step — a
  // self-referential path once this file exists) leaks into every test
  // here and silently suppresses the bg spawn regardless of what each
  // test actually asked for, breaking the "no real suite ever runs / fully
  // hermetic" contract stated above.
  const { KKAMAK_GATE_NO_BG: _1, KKAMAK_GATE_FULL: _2, KKAMAK_GATE_COMMANDS: _3, ...cleanEnv } = process.env
  return spawnSync("bun", [GATE_CHECK], {
    cwd: dir, encoding: "utf8",
    env: { ...cleanEnv, KKAMAK_GATE_COMMANDS: writeCommands(dir), ...extraEnv },
  })
}

function ran(dir: string): string[] {
  try { return fs.readFileSync(path.join(dir, "ran.txt"), "utf8").split("\n").filter(Boolean) } catch { return [] }
}
function marker(dir: string): any {
  try { return JSON.parse(fs.readFileSync(path.join(dir, ".km", "gate-bg", "state.json"), "utf8")) } catch { return undefined }
}
function lastDecision(dir: string): string {
  try { return fs.readFileSync(path.join(dir, ".km", "gate-bg", "last-decision"), "utf8") } catch { return "" }
}
async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (pred()) return true; await new Promise((r) => setTimeout(r, 50)) }
  return pred()
}

// TIMEOUT RULE (2026-08-22, structural — not per-incident): every test here
// that calls runGate() spawns `bun scripts/gate-check.ts` as a real
// subprocess, so its wall time tracks machine load, not the assertion. On
// bun's 5000ms default those flake under full-suite contention — measured
// twice in one day, 5007.93ms and 5009.35ms, each latching the bg marker red
// and forcing every subsequent Stop down the ~3.5min full-sync path. All
// spawn-bearing tests therefore carry an explicit envelope. The two
// realCommands() tests at the bottom assert on a plain object, never spawn,
// and correctly keep the default.
describe("gate-check CLI", () => {
  test("first run (no marker, no baseline): tier0 = FALLBACK_SUITES (incumbent scope — ccgate yes, opencode NO), exits 0, spawns bg full run that lands green", async () => {
    const dir = tempRepo()
    fs.writeFileSync(path.join(dir, "README.md"), "x")
    const r = runGate(dir)
    expect(r.status).toBe(0)
    // no green baseline exists yet -> TIA has nothing to diff against ->
    // conservative fallback = incumbent scope (amendment c), NOT doc-only
    expect(ran(dir)).toContain("doccheck")
    expect(ran(dir)).toContain("ccgate")
    expect(ran(dir)).not.toContain("opencode")
    expect(await until(() => marker(dir)?.status === "green", 15_000)).toBe(true)
    expect(ran(dir)).toContain("FULL")
  }, 30_000)

  test("docs-only change AFTER a green baseline: TIA active, tier0 runs doccheck only", async () => {
    const dir = tempRepo()
    const r1 = runGate(dir)
    expect(await until(() => marker(dir)?.status === "green", 15_000)).toBe(true)  // baseline
    fs.writeFileSync(path.join(dir, "README.md"), "x")
    fs.rmSync(path.join(dir, "ran.txt"))
    fs.rmSync(path.join(dir, "args.txt"), { force: true })  // DEVIATION: fixture side-effect file, see task-2-report.md
    const r2 = runGate(dir, { KKAMAK_GATE_NO_BG: "1" })
    expect(r2.status).toBe(0)
    expect(ran(dir)).toContain("doccheck")
    expect(ran(dir)).not.toContain("ccgate")
    // The decision line must report what ACTUALLY ran, not decide()'s
    // conservative fallback list — those diverge exactly when TIA narrows,
    // which is the case worth logging correctly.
    const line = lastDecision(dir)
    expect(line).toContain("[doccheck]")
    expect(line).not.toContain("ccgate")
    expect(line).toContain("TIA vs baseline")
  }, 30_000)

  test("tier0 failure blocks: failing suite -> non-zero exit, failure output present, NO bg spawn", async () => {
    // CONTRACT (implementer writes the body): write exits.json
    // {"kmcrank": 1}; runGate(dir). This is a first run (no baseline), so
    // tier0 = FALLBACK_SUITES which includes kmcrank — TIA is not involved.
    // Assert: r.status !== 0; ran(dir) contains "kmcrank" and NOT "FULL";
    // r.stdout+r.stderr contains "FAKE_OUT:kmcrank" (proves the
    // runSyncCaptured output-capture path); marker(dir) stays undefined
    // (no spawn while broken).
    const dir = tempRepo()
    fs.writeFileSync(path.join(dir, "exits.json"), JSON.stringify({ kmcrank: 1 }))
    const r = runGate(dir)
    expect(r.status).not.toBe(0)
    expect(ran(dir)).toContain("kmcrank")
    expect(ran(dir)).not.toContain("FULL")
    expect((r.stdout ?? "") + (r.stderr ?? "")).toContain("FAKE_OUT:kmcrank")
    expect(marker(dir)).toBeUndefined()
  }, 30_000)

  test("KKAMAK_GATE_NO_BG=1 suppresses the spawn", async () => {
    const dir = tempRepo()
    fs.writeFileSync(path.join(dir, "README.md"), "x")
    const r = runGate(dir, { KKAMAK_GATE_NO_BG: "1" })
    expect(r.status).toBe(0)
    await new Promise((res) => setTimeout(res, 500))
    expect(ran(dir)).not.toContain("FULL")
    expect(marker(dir)).toBeUndefined()
  }, 30_000)

  test("red marker -> full-sync debt repayment: FULL runs in-process, green marker replaces red, exit 0", () => {
    const dir = tempRepo()
    fs.mkdirSync(path.join(dir, ".km", "gate-bg"), { recursive: true })
    fs.writeFileSync(path.join(dir, ".km", "gate-bg", "state.json"),
      JSON.stringify({ status: "red", tree: "stale", startedTs: 1, outputTail: "old failure" }))
    const r = runGate(dir, { KKAMAK_GATE_NO_BG: "1" })
    expect(r.status).toBe(0)
    expect(ran(dir)).toEqual(["FULL"])          // debt path runs ONLY the full check
    expect(marker(dir)?.status).toBe("green")
  }, 30_000)

  test("red marker + full check still failing -> non-zero exit, marker stays red with fresh outputTail", () => {
    const dir = tempRepo()
    fs.mkdirSync(path.join(dir, ".km", "gate-bg"), { recursive: true })
    fs.writeFileSync(path.join(dir, ".km", "gate-bg", "state.json"),
      JSON.stringify({ status: "red", tree: "stale", startedTs: 1 }))
    fs.writeFileSync(path.join(dir, "exits.json"), JSON.stringify({ FULL: 1 }))
    const r = runGate(dir, { KKAMAK_GATE_NO_BG: "1" })
    expect(r.status).not.toBe(0)
    expect(marker(dir)?.status).toBe("red")
  }, 30_000)

  test("bg full-run failure lands a red marker with outputTail", async () => {
    const dir = tempRepo()
    fs.writeFileSync(path.join(dir, "README.md"), "x")
    fs.writeFileSync(path.join(dir, "exits.json"), JSON.stringify({ FULL: 1 }))
    const r = runGate(dir)
    expect(r.status).toBe(0)                     // tier0 green; debt lands async
    expect(await until(() => marker(dir)?.status === "red", 15_000)).toBe(true)
  }, 30_000)

  // Confirm-before-latch. decide() sends every Stop down full-sync while the
  // marker reads red, and there is no staleness path out of red (BG_STALE_MS
  // only covers "running"). So one transient bg failure latches the gate into
  // its slowest mode — and that mode is the most contended, which makes the
  // transient recur. Measured 2026-08-22: gate-check-cli timed out by 7.93ms
  // inside the full run while passing 403/0 standalone. A second run is free
  // in bg (nobody waits) and is the difference between a flake and debt.
  test("bg: a full check that fails once then passes does NOT latch red", async () => {
    const dir = tempRepo()
    fs.writeFileSync(path.join(dir, "README.md"), "x")
    fs.writeFileSync(path.join(dir, "exits.json"), JSON.stringify({ FULL: [1, 0] }))
    const r = runGate(dir)
    expect(r.status).toBe(0)
    expect(await until(() => marker(dir)?.status === "green", 15_000)).toBe(true)
    expect(ran(dir).filter((t) => t === "FULL").length).toBe(2)
  }, 30_000)

  test("bg: a full check that fails twice still latches red", async () => {
    const dir = tempRepo()
    fs.writeFileSync(path.join(dir, "README.md"), "x")
    fs.writeFileSync(path.join(dir, "exits.json"), JSON.stringify({ FULL: 1 }))
    const r = runGate(dir)
    expect(r.status).toBe(0)
    expect(await until(() => marker(dir)?.status === "red", 15_000)).toBe(true)
    expect(ran(dir).filter((t) => t === "FULL").length).toBe(2)
  }, 30_000)

  // Observability. The debt path already announces itself on stdout
  // (gate-check.ts's "repaying background-check debt" line), but on a
  // SUCCESSFUL repayment the script exits 0, the Stop is allowed, and hook
  // stdout is not surfaced in an ordinary session — known-issues.md #10,
  // measured. So a legitimate multi-minute repayment is indistinguishable
  // from an unexplained hang. This file is the readable channel: one line,
  // overwritten per Stop, answering "why was that slow" with a cat.
  test("every Stop records a readable decision line", async () => {
    const dir = tempRepo()
    fs.writeFileSync(path.join(dir, "README.md"), "x")
    const r = runGate(dir, { KKAMAK_GATE_NO_BG: "1" })
    expect(r.status).toBe(0)
    const line = lastDecision(dir)
    expect(line).toContain("tier0")
    expect(line).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/)
    // First run: no green marker, so TIA has no diff base and the scope is the
    // conservative fallback. Saying WHY is the point — that sentence is the
    // difference between a ~100ms Stop and a ~3min one, and it is otherwise
    // invisible from outside.
    expect(line).toContain("NO green baseline")
  }, 30_000)

  test("debt repayment records WHY the Stop was slow and when the failure was", async () => {
    const dir = tempRepo()
    fs.mkdirSync(path.join(dir, ".km", "gate-bg"), { recursive: true })
    fs.writeFileSync(path.join(dir, ".km", "gate-bg", "state.json"),
      JSON.stringify({ status: "red", tree: "stale", startedTs: 1, finishedTs: 1755000000000, outputTail: "old" }))
    const r = runGate(dir, { KKAMAK_GATE_NO_BG: "1" })
    expect(r.status).toBe(0)
    const line = lastDecision(dir)
    expect(line).toContain("full-sync")
    expect(line).toContain("debt")
    // It reports the RECORDED failure time, not now. Asserted as "not today"
    // rather than as a literal date: stamps are local, so a fixed date string
    // would pass in KST and fail in a timezone where the epoch lands a day
    // either side. The property under test is provenance, not formatting.
    const today = new Date()
    const p = (n: number) => String(n).padStart(2, "0")
    expect(line).not.toContain(`${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}  full-sync`)
    expect(line).toMatch(/FAILED at \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/)
  }, 30_000)

  test("an unwritable decision file never breaks the gate", async () => {
    const dir = tempRepo()
    fs.mkdirSync(path.join(dir, ".km", "gate-bg"), { recursive: true })
    // a DIRECTORY where the file goes: every write throws, fail-open or bust
    fs.mkdirSync(path.join(dir, ".km", "gate-bg", "last-decision"))
    fs.writeFileSync(path.join(dir, "README.md"), "x")
    const r = runGate(dir, { KKAMAK_GATE_NO_BG: "1" })
    expect(r.status).toBe(0)
    expect(ran(dir)).toContain("doccheck")
  }, 30_000)

  // Baseline preservation. TIA's diff base is the last KNOWN-GOOD tree, and a
  // check being in flight says nothing about whether that tree is still a
  // valid base — it plainly is. Before this, spawnBg's `running` write
  // clobbered the green marker, so every Stop landing inside the ~3.5min
  // background window lost TIA entirely and paid the conservative fallback
  // scope (~180s vs ~100ms for a docs-only change). In an active session with
  // turns shorter than that window, that is most Stops, not an edge case.
  test("a bg run in flight keeps the last green tree as the TIA base", async () => {
    const dir = tempRepo()
    runGate(dir)
    expect(await until(() => marker(dir)?.status === "green", 15_000)).toBe(true)
    const greenTree = marker(dir).tree
    fs.writeFileSync(path.join(dir, "README.md"), "x")           // docs-only
    fs.rmSync(path.join(dir, "ran.txt"))
    fs.rmSync(path.join(dir, "args.txt"), { force: true })
    // a fresh bg check is now in flight for some newer tree
    fs.writeFileSync(path.join(dir, ".km", "gate-bg", "state.json"),
      JSON.stringify({ status: "running", tree: "newtree", pid: process.pid,
                       startedTs: Date.now(), lastGreenTree: greenTree }))
    const r = runGate(dir, { KKAMAK_GATE_NO_BG: "1" })
    expect(r.status).toBe(0)
    expect(ran(dir)).toEqual(["doccheck"])                        // TIA narrowed
    expect(ran(dir)).not.toContain("ccgate")
    expect(lastDecision(dir)).toContain("TIA vs baseline")
  }, 40_000)

  test("a green marker records the tree as the last known-good baseline", async () => {
    const dir = tempRepo()
    runGate(dir)
    expect(await until(() => marker(dir)?.status === "green", 15_000)).toBe(true)
    const m = marker(dir)
    expect(m.lastGreenTree).toBe(m.tree)
  }, 30_000)

  test("running marker + live pid: no duplicate spawn", async () => {
    const dir = tempRepo()
    fs.mkdirSync(path.join(dir, ".km", "gate-bg"), { recursive: true })
    // this test process's own pid is definitely alive
    fs.writeFileSync(path.join(dir, ".km", "gate-bg", "state.json"),
      JSON.stringify({ status: "running", tree: "t", pid: process.pid, startedTs: Date.now() }))
    fs.writeFileSync(path.join(dir, "README.md"), "x")
    const r = runGate(dir)
    expect(r.status).toBe(0)
    await new Promise((res) => setTimeout(res, 500))
    expect(ran(dir)).not.toContain("FULL")
    // 30_000 like its two siblings above and below: this spawns a real CLI
    // subprocess AND burns 500ms of its own budget on the settle sleep, so on
    // bun's 5000ms default it has ~4.5s for the spawn. Measured 2026-08-22:
    // 5007.93ms under full-suite contention — 7.93ms over — which latched the
    // bg marker red and forced every subsequent Stop down the full-sync path.
    // The assertion is unchanged; only the harness's patience is.
  }, 30_000)

  test("running marker + dead pid: recovered, new bg spawn happens", async () => {
    const dir = tempRepo()
    fs.mkdirSync(path.join(dir, ".km", "gate-bg"), { recursive: true })
    fs.writeFileSync(path.join(dir, ".km", "gate-bg", "state.json"),
      JSON.stringify({ status: "running", tree: "t", pid: 999999999, startedTs: 1 }))
    fs.writeFileSync(path.join(dir, "README.md"), "x")
    const r = runGate(dir)
    expect(r.status).toBe(0)
    expect(await until(() => marker(dir)?.status !== "running" || marker(dir)?.pid !== 999999999, 15_000)).toBe(true)
  }, 30_000)

  test("green marker + unchanged tree: tier0 only, no spawn", async () => {
    const dir = tempRepo()
    // Establish a green marker for the CURRENT tree via a real bg cycle:
    const r1 = runGate(dir)
    expect(r1.status).toBe(0)
    expect(await until(() => marker(dir)?.status === "green", 15_000)).toBe(true)
    fs.rmSync(path.join(dir, "ran.txt"))
    fs.rmSync(path.join(dir, "args.txt"), { force: true })  // DEVIATION: fixture side-effect file, see task-2-report.md
    const r2 = runGate(dir)
    expect(r2.status).toBe(0)
    await new Promise((res) => setTimeout(res, 500))
    expect(ran(dir)).not.toContain("FULL")                    // no re-spawn for same tree
  }, 40_000)

  test("KKAMAK_GATE_FULL=1 forces full-sync regardless of marker state", () => {
    const dir = tempRepo()
    const r = runGate(dir, { KKAMAK_GATE_FULL: "1", KKAMAK_GATE_NO_BG: "1" })
    expect(r.status).toBe(0)
    expect(ran(dir)).toEqual(["FULL"])
  }, 30_000)

  // The clean-worktree fast path skips staging entirely (58ms vs 490-1310ms
  // measured 2026-08-23). Both directions are pinned so the guard cannot rot
  // into either failure: this test covers clean-implies-HEAD-tree, and
  // "untracked files change the tree hash" below covers dirty-implies-
  // different. A guard that returned HEAD's tree for a DIRTY worktree would
  // silently mark unverified work as already-checked, which is why the
  // second direction is not optional.
  test("a clean worktree hashes to HEAD's tree; a dirty one does not", () => {
    const dir = tempRepo()
    // tempRepo leaves .km/ untracked, so ignore it — otherwise the worktree
    // is never clean and the fast path can never be exercised here.
    fs.writeFileSync(path.join(dir, ".gitignore"), ".km/\n")
    execFileSync("git", ["add", ".gitignore"], { cwd: dir })
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "ignore"], { cwd: dir })

    const head = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: dir, encoding: "utf8" }).trim()
    expect(dirtyTreeId(dir)).toBe(head)

    fs.writeFileSync(path.join(dir, "u.txt"), "x")   // untracked, not ignored
    expect(dirtyTreeId(dir)).not.toBe(head)
  }, 30_000)

  // The staging index is reused across runs so `git add -A` consults its
  // stat cache instead of rehashing the worktree (408ms -> 37ms, measured
  // 2026-08-23). A reused index can only be wrong by going STALE, and a
  // stale identity reports unverified work as already-checked — the worst
  // failure this file has. So every step is compared against an independent
  // cold computation, and the "1" -> "2" rewrite is deliberate: same byte
  // length, same second, which is exactly the racily-clean case a stat
  // cache can get wrong.
  test("index reuse agrees with a cold index across add/modify/delete", () => {
    const dir = tempRepo()
    fs.writeFileSync(path.join(dir, ".gitignore"), ".km/\n")
    execFileSync("git", ["add", ".gitignore"], { cwd: dir })
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "ignore"], { cwd: dir })

    // Reference index lives OUTSIDE the repo; inside, it would stage itself
    // and diverge from what dirtyTreeId sees.
    const refIndex = path.join(fs.mkdtempSync(path.join(tmpdir(), "gate-ref-")), "index")
    const reference = (): string => {
      const env = { ...process.env, GIT_INDEX_FILE: refIndex }
      execFileSync("git", ["read-tree", "HEAD"], { cwd: dir, env })
      execFileSync("git", ["add", "-A"], { cwd: dir, env })
      execFileSync("git", ["rm", "-r", "--cached", "-f", "--ignore-unmatch", "--", ".km"], { cwd: dir, env })
      const t = execFileSync("git", ["write-tree"], { cwd: dir, env, encoding: "utf8" }).trim()
      fs.rmSync(refIndex, { force: true })
      return t
    }

    const f = path.join(dir, "a.txt")
    fs.writeFileSync(f, "1")
    expect(dirtyTreeId(dir)).toBe(reference())     // seeds the warm index
    fs.writeFileSync(f, "2")
    expect(dirtyTreeId(dir)).toBe(reference())     // racily-clean rewrite
    fs.rmSync(f)
    expect(dirtyTreeId(dir)).toBe(reference())     // deletion, back to clean
  }, 30_000)

  test("untracked files change the tree hash (dirty-tree, not HEAD)", async () => {
    const dir = tempRepo()
    const r1 = runGate(dir)
    expect(await until(() => marker(dir)?.status === "green", 15_000)).toBe(true)
    const t1 = marker(dir).tree
    fs.writeFileSync(path.join(dir, "newfile.txt"), "u")      // untracked
    const r2 = runGate(dir)
    expect(await until(() => marker(dir)?.tree !== t1 && marker(dir)?.status === "green", 15_000)).toBe(true)
  }, 40_000)

  test("wedged bg run (running + ALIVE pid + stale startedTs): group kill, fresh respawn (amendment a)", async () => {
    const dir = tempRepo()
    // detached => own process group, same shape as a real spawnBg child.
    // Named gate-check-hung.ts (not a bare `-e` snippet) so `ps -o command=`
    // contains "gate-check" — matching the real spawnBg shape (`bun
    // .../gate-check.ts --bg <tree>`) so the pid-identity kill guard
    // (Finding 3) doesn't skip the kill here as a false mismatch.
    const hungScript = path.join(dir, "gate-check-hung.ts")
    fs.writeFileSync(hungScript, "setTimeout(() => {}, 1_000_000_000)")
    const hung = spawn("bun", [hungScript], { stdio: "ignore", detached: true })
    hung.unref()
    CLEANUP_PIDS.push(hung.pid!)
    fs.mkdirSync(path.join(dir, ".km", "gate-bg"), { recursive: true })
    fs.writeFileSync(path.join(dir, ".km", "gate-bg", "state.json"),
      JSON.stringify({ status: "running", tree: "t", pid: hung.pid, startedTs: Date.now() - 16 * 60_000 }))
    fs.writeFileSync(path.join(dir, "README.md"), "x")
    const r = runGate(dir)
    expect(r.status).toBe(0)
    expect(await until(() => marker(dir)?.status === "green", 15_000)).toBe(true)   // fresh bg landed
    expect(await until(() => { try { process.kill(hung.pid!, 0); return false } catch { return true } }, 5_000))
      .toBe(true)                                                                    // old pid is dead
  }, 30_000)

  test("changed slow-covered source pulls its matching slow test into the ccgate argv (amendment b)", async () => {
    const dir = tempRepo()
    const r1 = runGate(dir)
    expect(await until(() => marker(dir)?.status === "green", 15_000)).toBe(true)   // green baseline
    fs.mkdirSync(path.join(dir, "cc-gate-plugin", "src", "gauge", "providers"), { recursive: true })
    fs.writeFileSync(path.join(dir, "cc-gate-plugin", "src", "gauge", "providers", "anthropic-cli-warm.ts"), "// x")
    fs.rmSync(path.join(dir, "args.txt"), { force: true })
    const r2 = runGate(dir, { KKAMAK_GATE_NO_BG: "1" })
    expect(r2.status).toBe(0)
    const args = fs.readFileSync(path.join(dir, "args.txt"), "utf8")
    expect(args).toContain("ccgate test/anthropic-cli-warm.test.ts")
  }, 30_000)

  test("a changed EXCLUDED test file appends itself to its own suite's argv (self-pull)", async () => {
    const dir = tempRepo()
    const r1 = runGate(dir)
    expect(await until(() => marker(dir)?.status === "green", 15_000)).toBe(true)   // green baseline
    fs.mkdirSync(path.join(dir, "cc-gate-plugin", "test"), { recursive: true })
    fs.writeFileSync(path.join(dir, "cc-gate-plugin", "test", "gauge-agent-transport.test.ts"), "// x")
    fs.rmSync(path.join(dir, "args.txt"), { force: true })
    const r2 = runGate(dir, { KKAMAK_GATE_NO_BG: "1" })
    expect(r2.status).toBe(0)
    const args = fs.readFileSync(path.join(dir, "args.txt"), "utf8")
    expect(args).toContain("ccgate test/gauge-agent-transport.test.ts")
  }, 30_000)

  test("pull-in log line pins the 'suite:file' format, accumulated across MULTIPLE suites (Task 4's acceptance measurement correlates against this exact line)", async () => {
    const dir = tempRepo()
    const r1 = runGate(dir)
    expect(await until(() => marker(dir)?.status === "green", 15_000)).toBe(true)   // green baseline
    // ccgate pull-in: a slow-covered source.
    fs.mkdirSync(path.join(dir, "cc-gate-plugin", "src", "gauge", "providers"), { recursive: true })
    fs.writeFileSync(path.join(dir, "cc-gate-plugin", "src", "gauge", "providers", "anthropic-cli-warm.ts"), "// x")
    // kmcrank pull-in: the guardless gate-entry-point rule (Task 2).
    fs.mkdirSync(path.join(dir, "scripts"), { recursive: true })
    fs.writeFileSync(path.join(dir, "scripts", "gate-check.ts"), "// x")
    fs.rmSync(path.join(dir, "args.txt"), { force: true })
    const r2 = runGate(dir, { KKAMAK_GATE_NO_BG: "1" })
    expect(r2.status).toBe(0)
    const out = (r2.stdout ?? "") + (r2.stderr ?? "")
    expect(out).toContain("+ slow pull-in [ccgate:test/anthropic-cli-warm.test.ts, kmcrank:test/gate-check-cli.test.ts]")
  }, 30_000)

  test("scanFailed on a Cmd suppresses its pull-in append (degradation, not narrowing) — a real readdir failure must not silently FILTER a scan-degraded 'run everything' argv down to just the pulled-in file", async () => {
    const dir = tempRepo()
    const r1 = runGate(dir)
    expect(await until(() => marker(dir)?.status === "green", 15_000)).toBe(true)   // green baseline, writes fake.ts
    fs.mkdirSync(path.join(dir, "cc-gate-plugin", "src", "gauge", "providers"), { recursive: true })
    fs.writeFileSync(path.join(dir, "cc-gate-plugin", "src", "gauge", "providers", "anthropic-cli-warm.ts"), "// x")   // would pull-in for ccgate
    fs.rmSync(path.join(dir, "args.txt"), { force: true })
    // Hand-build a command table (bypassing writeCommands) with ccgate's Cmd
    // carrying scanFailed: true, simulating realCommands()'s readdirSync
    // catch. Every other suite's Cmd has no such field, matching the
    // seam-fixture shape elsewhere in this file (absence -> append normally).
    const fake = path.join(dir, "fake.ts")
    const table = {
      suites: Object.fromEntries(["ccgate", "opencode", "gateplugin", "kmcrank", "doccheck"].map((s) => [
        s, { cwd: ".", argv: ["bun", fake, s], ...(s === "ccgate" ? { scanFailed: true } : {}) },
      ])),
      full: { cwd: ".", argv: ["bun", fake, "FULL"] },
    }
    const commandsPath = path.join(dir, "commands.json")
    fs.writeFileSync(commandsPath, JSON.stringify(table))
    const { KKAMAK_GATE_NO_BG: _1, KKAMAK_GATE_FULL: _2, KKAMAK_GATE_COMMANDS: _3, ...cleanEnv } = process.env
    const r2 = spawnSync("bun", [GATE_CHECK], {
      cwd: dir, encoding: "utf8",
      env: { ...cleanEnv, KKAMAK_GATE_COMMANDS: commandsPath, KKAMAK_GATE_NO_BG: "1" },
    })
    expect(r2.status).toBe(0)
    expect(ran(dir)).toContain("ccgate")
    const args = fs.readFileSync(path.join(dir, "args.txt"), "utf8")
    expect(args).not.toContain("test/anthropic-cli-warm.test.ts")   // append skipped: no filter narrowing
  }, 30_000)
})

describe("realCommands() — tier-1 full command (2026-08-08 blind-spot regression)", () => {
  // Calls the REAL realCommands(), not a re-typed copy of its argv string —
  // a plain substring check on a hand-copied literal would pass even if the
  // real command drifted, since it'd just be comparing the test's own copy
  // against itself. Parsing the actual returned `cd <dir> && bun test`
  // sequence structurally means this only passes if realCommands() itself
  // still runs opencode-plugin's suite, in the right place in the chain.
  test("full.argv's bash -c script runs `bun test` in opencode-plugin, between cc-gate-plugin and gate-plugin", () => {
    const table = realCommands()
    expect(table.full.argv[0]).toBe("bash")
    expect(table.full.argv[1]).toBe("-c")
    const script = table.full.argv[2]!
    let cwd = "."
    const dirsRunningBunTest: string[] = []
    for (const step of script.split(" && ")) {
      const cdMatch = step.match(/^cd (\S+)$/)
      if (cdMatch) { cwd = path.normalize(path.join(cwd, cdMatch[1])); continue }
      if (step === "bun test") dirsRunningBunTest.push(cwd)
    }
    // Before the 2026-08-08 fix, this was
    // ["cc-gate-plugin", "gate-plugin", "km-crank"] — opencode-plugin
    // simply never appeared. Pin the full ordered sequence (not just
    // `.toContain`) so a future reorder that puts opencode-plugin somewhere
    // that never actually runs (e.g. after a step that already failed and
    // short-circuited the `&&` chain) still fails this test.
    expect(dirsRunningBunTest).toEqual(["cc-gate-plugin", "opencode-plugin", "gate-plugin", "km-crank"])
  })

  test("full.argv's bash -c script still ends with doc-check from repo root (unaffected by the opencode-plugin insertion)", () => {
    const table = realCommands()
    const script = table.full.argv[2]!
    expect(script.trim().endsWith("cd .. && bun scripts/doc-check.ts")).toBe(true)
  })
})
