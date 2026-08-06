// scripts/gate-check.ts
/**
 * Two-tier gate check — the command gate.json names (design:
 * docs/superpowers/plans/2026-08-05-two-tier-gate-check.md; decision logic:
 * km-crank/src/gate-check-core.ts, tested there).
 *
 * Exit 0 = allow the Stop; non-zero = block (check-runner captures output
 * as the block reason). Env: KKAMAK_GATE_FULL=1 forces the incumbent
 * full-sync check; KKAMAK_GATE_NO_BG=1 suppresses the background spawn
 * (tests/CI); KKAMAK_GATE_COMMANDS=<json> replaces the command table
 * (TEST SEAM ONLY).
 */
import fs from "node:fs"
import path from "node:path"
import { execFileSync, spawnSync, spawn } from "node:child_process"
import {
  decide, parseMarker, suitesForChangedPaths, fastArgvSuffix, pullInsFor, PKG_DIR,
  type GateBgMarker, type SuiteId,
} from "../km-crank/src/gate-check-core.ts"

const cwd = process.cwd()
const BG_DIR = path.join(cwd, ".km", "gate-bg")
const MARKER = path.join(BG_DIR, "state.json")
const OUTPUT_TAIL_BYTES = 4096

// ---------- command table (real, or test-seam override) ----------
interface Cmd {
  cwd: string
  argv: string[]
  /** DEGRADATION flag, never NARROWING — see scanFastArgv(). Lives on the
   * per-Cmd entry (NOT on CommandTable): with two packages scanned, a
   * km-crank readdir failure must not suppress ccgate's pull-in append
   * while ccgate's own argv is a correctly-narrowed fast list — that would
   * open the exact coverage hole amendment b exists to close. Absence
   * (including the common case: this field simply doesn't exist on an
   * object) means "append normally", which is what keeps the
   * KKAMAK_GATE_COMMANDS seam fixture (cwd/argv only, no such field) safe:
   * `undefined` is falsy, so the pull-in append still fires there. That
   * safety only holds because realCommands()'s output is NEVER serialized
   * — commands() below either JSON.parses the seam file (a fixture some
   * test wrote, never this function's return value) or calls
   * realCommands() fresh in-process. The flag is therefore process-local
   * by construction; it can never round-trip through the seam and silently
   * flip meaning. */
  scanFailed?: boolean
}
interface CommandTable { suites: Record<SuiteId, Cmd>; full: Cmd }

/** Scan `pkgDir`'s test/ and src/ recursively for `.test.ts` files and turn
 * them into `suite`'s tier-0 argv via `fastArgvSuffix()`. Shared by ccgate
 * and kmcrank (the two suites PKG_DIR covers — see its doc comment for the
 * double-duty this map plays here vs. in pullInsFor).
 *
 * Scan test/ AND src/ recursively: bare `bun test` (the full check)
 * discovers .test.ts anywhere in the package, so a src/-colocated test must
 * not silently drop out of tier 0. Neither package has one today, nor any
 * nested node_modules under src/ that recursive readdir could snag
 * (verified 2026-08-06 for both cc-gate-plugin and km-crank) — this is the
 * guard for when one lands.
 *
 * scanFailed tracks whether ANY root threw (a genuine readdir failure —
 * both roots are confirmed to exist in this repo today, so a catch firing
 * here is anomalous, not a benign "foreign repo / missing dir"), never
 * inferred from `all.length === 0` (a package with genuinely zero test
 * files produces that same empty list without any failure at all). The
 * fs-touching loop here only collects `all` + `scanFailed`; the actual
 * "discard on any failure, even a partial one" decision is pure and lives
 * in `fastArgvSuffix()` (gate-check-core.ts) — see its doc comment for why
 * a narrowed-but-incomplete `all` would be unsafe. */
function scanFastArgv(suite: SuiteId, pkgDir: string): Cmd {
  const all: string[] = []
  let scanFailed = false
  for (const root of ["test", "src"]) {
    const abs = path.join(cwd, pkgDir, root)
    let entries: string[] = []
    try {
      entries = fs.readdirSync(abs, { recursive: true }) as string[]
    } catch {
      scanFailed = true
      continue
    }
    for (const e of entries) if (e.endsWith(".test.ts")) all.push(`${root}/${e}`)
  }
  return { cwd: pkgDir, argv: ["bun", "test", ...fastArgvSuffix(suite, all, scanFailed)], scanFailed }
}

function realCommands(): CommandTable {
  return {
    suites: {
      // Literal fallbacks (not `!`): PKG_DIR is edited in a different file
      // (gate-check-core.ts) than this one, and a `!` assertion type-checks
      // clean even after a key is renamed away there — it would only fail
      // at runtime, as `path.join(cwd, undefined, root)`, on every single
      // Stop. A `??` fallback instead degrades a stale/renamed map entry
      // back to today's literal cwd, never wedges the gate.
      ccgate: scanFastArgv("ccgate", PKG_DIR.ccgate ?? "cc-gate-plugin"),
      opencode: { cwd: "opencode-plugin", argv: ["bun", "test"] },
      gateplugin: { cwd: "gate-plugin", argv: ["bun", "test"] },
      kmcrank: scanFastArgv("kmcrank", PKG_DIR.kmcrank ?? "km-crank"),
      doccheck: { cwd: ".", argv: ["bun", "scripts/doc-check.ts"] },
    },
    // Tier 1 = incumbent check VERBATIM (plan Global Constraints).
    full: { cwd: ".", argv: ["bash", "-c",
      "cd cc-gate-plugin && bun test && cd ../gate-plugin && bun test && cd ../km-crank && bun test && cd .. && bun scripts/doc-check.ts"] },
  }
}

function commands(): CommandTable {
  const seam = process.env.KKAMAK_GATE_COMMANDS
  if (seam) return JSON.parse(fs.readFileSync(seam, "utf8")) as CommandTable
  return realCommands()
}

// ---------- dirty-tree hash (fixture-ref.ts precedent) ----------
function dirtyTreeId(): string {
  const tmpIndex = path.join(BG_DIR, `index-${process.pid}`)
  fs.mkdirSync(BG_DIR, { recursive: true })
  try {
    const env = { ...process.env, GIT_INDEX_FILE: tmpIndex }
    execFileSync("git", ["read-tree", "HEAD"], { cwd, env })
    // DEVIATION (verbatim `git add -A -- . ':!.km'` fails when .km/ is
    // gitignored, as it is in this repo's real .gitignore): git treats an
    // explicitly-named ignored path — even negated — as a hard error
    // ("use -f"), unlike a bare `add -A` which silently skips ignored
    // paths. Add everything with NO explicit pathspec (so gitignored .km
    // is skipped exactly like fixture-ref.ts's plain `git add -A`), then
    // unstage any .km/ entries that snuck in when it's NOT gitignored (the
    // throwaway CLI-test temp repos have no .gitignore at all).
    execFileSync("git", ["add", "-A"], { cwd, env })
    // -f: the temp index file itself lives under .km/gate-bg/ and mutates
    // every call, so its staged content always differs from HEAD/worktree
    // — a plain `rm --cached` refuses that as unsafe. We're deliberately
    // dropping .km/ wholesale, so force is correct here, not dangerous.
    execFileSync("git", ["rm", "-r", "--cached", "-f", "--ignore-unmatch", "--", ".km"], { cwd, env })
    return execFileSync("git", ["write-tree"], { cwd, env, encoding: "utf8" }).trim()
  } finally {
    fs.rmSync(tmpIndex, { force: true })
  }
}

function changedPathsSince(tree: string, current: string): string[] | undefined {
  try {
    const out = execFileSync("git", ["diff", "--name-only", tree, current], { cwd, encoding: "utf8" })
    return out.split("\n").filter(Boolean)
  } catch {
    return undefined   // unknown tree (pruned) -> caller falls back to ALL
  }
}

// ---------- marker I/O ----------
function readMarker(): GateBgMarker | undefined {
  try { return parseMarker(fs.readFileSync(MARKER, "utf8")) } catch { return parseMarker(undefined) }
}
function writeMarker(m: GateBgMarker): void {
  fs.mkdirSync(BG_DIR, { recursive: true })
  const tmp = `${MARKER}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(m))
  fs.renameSync(tmp, MARKER)
}
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** Portable (darwin+linux, no /proc) identity check before killing a pid we
 * only hold from a stale marker: pid-reuse means d.killPid may no longer be
 * our bg process by the time we act on it. `ps` absence or any other
 * failure degrades to "not identifiable" — never crash the gate, never kill
 * blind. */
function isGateCheckProcess(pid: number): boolean {
  try {
    const out = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" })
    return out.includes("gate-check")
  } catch {
    return false
  }
}

// ---------- runners ----------
function runSyncCaptured(cmd: Cmd): { code: number; tail: string } {
  const r = spawnSync(cmd.argv[0]!, cmd.argv.slice(1), {
    cwd: path.join(cwd, cmd.cwd), encoding: "utf8", env: process.env,
  })
  const out = (r.stdout ?? "") + (r.stderr ?? "")
  process.stdout.write(out)   // check-runner captures this as the block reason
  return { code: r.status ?? 1, tail: out.slice(-OUTPUT_TAIL_BYTES) }
}

function runFullSync(table: CommandTable, tree: string): number {
  const { code, tail } = runSyncCaptured(table.full)
  writeMarker(code === 0
    ? { status: "green", tree, startedTs: Date.now(), finishedTs: Date.now() }
    : { status: "red", tree, startedTs: Date.now(), finishedTs: Date.now(), outputTail: tail })
  return code
}

/** Detached tier-1: this script re-execs itself in bg mode; the child
 * survives the hook's exit (detached + unref, stdio to a log file).
 * MUST use import.meta.path (the script's own resolved location), NOT a
 * cwd-relative guess — the CLI tests run this script from throwaway temp
 * repos that contain no scripts/ directory. */
function spawnBg(tree: string): void {
  fs.mkdirSync(BG_DIR, { recursive: true })
  const log = fs.openSync(path.join(BG_DIR, "bg.log"), "w")
  const child = spawn("bun", [import.meta.path, "--bg", tree], {
    cwd, detached: true, stdio: ["ignore", log, log],
    env: { ...process.env, KKAMAK_GATE_NICE: "1" },
  })
  writeMarker({ status: "running", tree, pid: child.pid!, startedTs: Date.now() })
  child.unref()
  fs.closeSync(log)
}

/** --bg <tree>: run the full check, write green/red for <tree>.
 *
 * Ownership guard: a stale/orphaned bg writer (e.g. superseded by a respawn
 * after a wedged-kill, or simply outlived by a newer run) must not clobber a
 * newer result with its own stale one. Before writing, re-read the marker
 * and only proceed if it still shows THIS run as the tracked owner
 * (status "running" with our own pid) — spawnBg spawns this script directly
 * with bun, so process.pid here IS the pid it recorded. */
function bgMain(tree: string): never {
  const table = commands()
  const r = spawnSync(table.full.argv[0]!, table.full.argv.slice(1), {
    cwd: path.join(cwd, table.full.cwd), encoding: "utf8", env: process.env,
  })
  const out = (r.stdout ?? "") + (r.stderr ?? "")
  const code = r.status ?? 1
  const owner = readMarker()
  if (owner?.status !== "running" || owner.pid !== process.pid) {
    process.stderr.write(`gate-check bg: marker no longer owned (pid ${process.pid}) — result discarded\n`)
    process.exit(0)
  }
  writeMarker(code === 0
    ? { status: "green", tree, startedTs: Date.now(), finishedTs: Date.now() }
    : { status: "red", tree, startedTs: Date.now(), finishedTs: Date.now(), outputTail: out.slice(-OUTPUT_TAIL_BYTES) })
  process.exit(0)   // bg exit code is irrelevant; the marker is the result
}

// ---------- main ----------
function main(): never {
  if (process.argv[2] === "--bg") bgMain(process.argv[3]!)

  const table = commands()
  const tree = dirtyTreeId()
  const marker = readMarker()
  const d = decide({
    tree, marker, pidAlive,
    forceFull: process.env.KKAMAK_GATE_FULL === "1",
    now: Date.now(),
  })

  if (d.mode === "full-sync") {
    if (d.reason === "debt") {
      console.log("gate-check: repaying background-check debt (previous full check FAILED) — running full check synchronously")
      if (marker?.outputTail) console.log(`--- previous failure tail ---\n${marker.outputTail}\n---`)
    }
    process.exit(runFullSync(table, tree))
  }

  if (d.killPid !== undefined) {
    // wedged bg run (amendment a): spawnBg used detached:true, so killPid is
    // a process-GROUP leader — signal the group (negative pid) so the hung
    // bash/bun grandchildren die too, not just the wrapper. Still pid-scoped
    // (standing rule: never pkill -f).
    //
    // pid-reuse hazard: by the time we act on a >15min-old marker, the OS
    // may have recycled d.killPid for an unrelated process. Verify identity
    // portably (darwin+linux, no /proc) via `ps -o command=` before
    // signaling anything; on mismatch or ps failure, skip the kill entirely
    // and just respawn (treat the tracked run as dead either way).
    if (isGateCheckProcess(d.killPid)) {
      console.log(`gate-check: bg full run wedged (pid ${d.killPid}, started >15min ago) — killing group + respawning`)
      try { process.kill(-d.killPid) } catch { try { process.kill(d.killPid) } catch { /* died in between */ } }
    } else {
      console.log(`gate-check: bg full run wedged (pid ${d.killPid}, started >15min ago) — pid no longer identifiable as gate-check, skipping kill + respawning`)
    }
  }

  // tier 0: package-TIA scoped fast suites (+ amendment-b slow pull-in,
  // suite-keyed via pullInsFor — no longer a single flat ccgate-only list)
  const base = marker?.status === "green" ? marker.tree : undefined
  const changed = base ? changedPathsSince(base, tree) : undefined
  const suites = changed !== undefined ? suitesForChangedPaths(changed) : [...d.suites]
  const pullIns = new Map<SuiteId, string[]>()
  if (changed !== undefined) {
    for (const s of suites) {
      const p = pullInsFor(s, changed)
      if (p.length > 0) pullIns.set(s, p)
    }
  }
  // Pinned log format — Task 4's acceptance measurement correlates against
  // this exact line: "suite:file" pairs, accumulated across ALL suites (in
  // suite order) rather than one flat ccgate-only list.
  const pullLog = [...pullIns.entries()].flatMap(([s, files]) => files.map((f) => `${s}:${f}`))
  console.log(`gate-check: tier0 suites [${suites.join(", ")}]${pullLog.length ? ` + slow pull-in [${pullLog.join(", ")}]` : ""} (tree ${tree.slice(0, 8)})`)

  for (const s of suites) {
    const suiteCmd = table.suites[s]
    // amendment b: changed slow-covered sources append their matching slow
    // test files to their suite's argv (fast list never contains them — no
    // dupes). Skipped when scanFailed is set on THIS Cmd: scanFailed means
    // argv already degraded to bare ["bun","test"] (run everything, the
    // safe fallback), and appending a pull-in on top of that would FILTER
    // it down to just the appended file(s) — see Cmd.scanFailed's doc
    // comment for why that would reopen amendment b's coverage hole.
    const pull = pullIns.get(s)
    const cmd = pull && pull.length > 0 && !suiteCmd.scanFailed
      ? { cwd: suiteCmd.cwd, argv: [...suiteCmd.argv, ...pull] }
      : suiteCmd
    const { code } = runSyncCaptured(cmd)
    if (code !== 0) {
      console.error(`gate-check: tier0 suite '${s}' FAILED — blocking`)
      process.exit(code)   // no bg spawn while broken
    }
  }

  if (d.spawnBg && process.env.KKAMAK_GATE_NO_BG !== "1") spawnBg(tree)
  process.exit(0)
}

main()
