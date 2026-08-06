import { describe, expect, test } from "bun:test"
import {
  parseMarker, decide, suitesForChangedPaths, fastFiles, fastArgvSuffix, pullInsFor,
  ALL_SUITES, FALLBACK_SUITES, BG_STALE_MS, PKG_DIR, SUITE_POLICY, type GateBgMarker,
} from "../src/gate-check-core.ts"

const T1 = "aaaa1111"
const T2 = "bbbb2222"
const NOW = 100_000_000
const mk = (m: Partial<GateBgMarker>): GateBgMarker =>
  ({ status: "green", tree: T1, startedTs: NOW - 1000, ...m }) as GateBgMarker
const alive = () => true
const dead = () => false

describe("parseMarker", () => {
  test("round-trips a valid marker", () => {
    const m = mk({ status: "running", pid: 42 })
    expect(parseMarker(JSON.stringify(m))).toEqual(m)
  })
  test("undefined input, malformed JSON, unknown status, missing tree -> undefined", () => {
    expect(parseMarker(undefined)).toBeUndefined()
    expect(parseMarker("{nope")).toBeUndefined()
    expect(parseMarker(JSON.stringify({ status: "purple", tree: T1, startedTs: 1 }))).toBeUndefined()
    expect(parseMarker(JSON.stringify({ status: "green", startedTs: 1 }))).toBeUndefined()
  })
})

describe("decide", () => {
  test("forceFull wins over everything, even red", () => {
    expect(decide({ tree: T1, marker: mk({ status: "red" }), pidAlive: alive, forceFull: true, now: NOW }))
      .toEqual({ mode: "full-sync", reason: "forced" })
  })
  test("red marker -> full-sync debt repayment, regardless of tree match", () => {
    expect(decide({ tree: T2, marker: mk({ status: "red", tree: T1 }), pidAlive: alive, forceFull: false, now: NOW }))
      .toEqual({ mode: "full-sync", reason: "debt" })
  })
  test("running + pid alive + fresh -> tier0, no new spawn", () => {
    const d = decide({ tree: T2, marker: mk({ status: "running", tree: T1, pid: 7 }), pidAlive: alive, forceFull: false, now: NOW })
    expect(d).toEqual({ mode: "tier0", suites: FALLBACK_SUITES, spawnBg: false })
  })
  test("running + pid alive + startedTs older than BG_STALE_MS -> WEDGED: kill + respawn (amendment a)", () => {
    const d = decide({
      tree: T1, marker: mk({ status: "running", tree: T1, pid: 7, startedTs: NOW - BG_STALE_MS - 1 }),
      pidAlive: alive, forceFull: false, now: NOW,
    })
    expect(d).toEqual({ mode: "tier0", suites: FALLBACK_SUITES, spawnBg: true, killPid: 7 })
  })
  test("running exactly AT the bound is not yet wedged", () => {
    const d = decide({
      tree: T1, marker: mk({ status: "running", tree: T1, pid: 7, startedTs: NOW - BG_STALE_MS }),
      pidAlive: alive, forceFull: false, now: NOW,
    })
    expect(d).toEqual({ mode: "tier0", suites: FALLBACK_SUITES, spawnBg: false })
  })
  test("running + pid dead (crash/reboot) -> treated as absent: tier0 + spawn, no killPid", () => {
    const d = decide({ tree: T1, marker: mk({ status: "running", tree: T1, pid: 7 }), pidAlive: dead, forceFull: false, now: NOW })
    expect(d).toEqual({ mode: "tier0", suites: FALLBACK_SUITES, spawnBg: true })
  })
  test("running with pid ABSENT is malformed-in-effect -> tier0 + spawn", () => {
    const d = decide({ tree: T1, marker: mk({ status: "running", pid: undefined }), pidAlive: alive, forceFull: false, now: NOW })
    expect(d).toEqual({ mode: "tier0", suites: FALLBACK_SUITES, spawnBg: true })
  })
  test("green + same tree -> tier0, nothing to spawn", () => {
    expect(decide({ tree: T1, marker: mk({ status: "green", tree: T1 }), pidAlive: alive, forceFull: false, now: NOW }))
      .toEqual({ mode: "tier0", suites: FALLBACK_SUITES, spawnBg: false })
  })
  test("green + different tree -> tier0 + spawn for the new tree", () => {
    expect(decide({ tree: T2, marker: mk({ status: "green", tree: T1 }), pidAlive: alive, forceFull: false, now: NOW }))
      .toEqual({ mode: "tier0", suites: FALLBACK_SUITES, spawnBg: true })
  })
  test("no marker -> tier0 + spawn", () => {
    expect(decide({ tree: T1, marker: undefined, pidAlive: alive, forceFull: false, now: NOW }))
      .toEqual({ mode: "tier0", suites: FALLBACK_SUITES, spawnBg: true })
  })
})

describe("suitesForChangedPaths (package-level TIA)", () => {
  test("maps each known prefix to its suite (doccheck always included)", () => {
    expect(suitesForChangedPaths(["cc-gate-plugin/src/x.ts"])).toEqual(["ccgate", "doccheck"])
    expect(suitesForChangedPaths(["opencode-plugin/src/x.ts"])).toEqual(["opencode", "doccheck"])
    expect(suitesForChangedPaths(["minimal/llm.ts"])).toEqual(["opencode", "doccheck"])
    expect(suitesForChangedPaths(["gate-plugin/src/x.ts"])).toEqual(["gateplugin", "doccheck"])
    expect(suitesForChangedPaths(["km-crank/src/x.ts"])).toEqual(["kmcrank", "doccheck"])
  })
  test("docs-only / markdown-only changes -> doccheck only", () => {
    expect(suitesForChangedPaths(["docs/resume.md", "README.md"])).toEqual(["doccheck"])
  })
  test("markdown under a TIA package is still doc-only: minimal/HISTORY.md does not drag opencode in", () => {
    expect(suitesForChangedPaths(["minimal/HISTORY.md"])).toEqual(["doccheck"])
  })
  test("minimal/CLAUDE.md is FUNCTIONAL (sha256'd harness slot) -> opencode despite .md", () => {
    expect(suitesForChangedPaths(["minimal/CLAUDE.md"])).toEqual(["opencode", "doccheck"])
  })
  test("unknown path -> FALLBACK_SUITES (incumbent scope — no opencode; amendment c)", () => {
    expect(suitesForChangedPaths(["term-bench2/store/x.json"])).toEqual(FALLBACK_SUITES)
    expect(suitesForChangedPaths(["scripts/gate-check.ts"])).toEqual(FALLBACK_SUITES)
  })
  test("unknown path + opencode-matched path -> union is ALL_SUITES (fallback never DROPS a TIA pick)", () => {
    expect(suitesForChangedPaths(["scripts/x.ts", "opencode-plugin/src/y.ts"])).toEqual(ALL_SUITES)
  })
  test("union across paths, deduplicated, stable ALL_SUITES order", () => {
    expect(suitesForChangedPaths(["km-crank/src/a.ts", "cc-gate-plugin/src/b.ts"]))
      .toEqual(["ccgate", "kmcrank", "doccheck"])
  })
  test("empty change list -> doccheck only (nothing to test, doc drift still checked)", () => {
    expect(suitesForChangedPaths([])).toEqual(["doccheck"])
  })
})

describe("pullInsFor('ccgate', ...) — amendment b, exact lists (ported from the retired slowCcgateTestsForChangedPaths)", () => {
  test("changed slow source pulls its DIRECT value-import consumers (exact lists)", () => {
    expect(pullInsFor("ccgate", ["cc-gate-plugin/src/gauge/acp-daemon.ts"]))
      .toEqual(["test/acp-daemon.test.ts"])
    expect(pullInsFor("ccgate", ["cc-gate-plugin/src/gauge/agent-transport.ts"]))
      .toEqual(["test/acp-client.test.ts", "test/anthropic-cli-warm.test.ts", "test/gauge-agent-transport.test.ts"])
    expect(pullInsFor("ccgate", ["cc-gate-plugin/src/gauge/providers/anthropic-cli-warm.ts"]))
      .toEqual(["test/anthropic-cli-warm.test.ts"])
    expect(pullInsFor("ccgate", ["cc-gate-plugin/src/gauge/warm-session.ts"]))
      .toEqual(["test/acp-pool.test.ts", "test/warm-session.test.ts"])
    expect(pullInsFor("ccgate", ["cc-gate-plugin/src/gauge/acp-pool.ts"]))
      .toEqual(["test/acp-daemon.test.ts", "test/acp-pool.test.ts"])
  })
  test("CURRENT layout: src/acp/ paths match the same basename-anchored regexes (exact lists)", () => {
    // The ACP sources actually live here post-promotion (2026-08-06). These
    // cases are the ones that prove the module-doc's claim ("sources in
    // src/acp/...") true — the gauge/-path cases above are kept alongside
    // them to prove the basename anchoring is genuinely path-agnostic, not
    // because src/gauge/acp-daemon.ts etc. still exist.
    expect(pullInsFor("ccgate", ["cc-gate-plugin/src/acp/acp-daemon.ts"]))
      .toEqual(["test/acp-daemon.test.ts"])
    expect(pullInsFor("ccgate", ["cc-gate-plugin/src/acp/acp-pool.ts"]))
      .toEqual(["test/acp-daemon.test.ts", "test/acp-pool.test.ts"])
    expect(pullInsFor("ccgate", ["cc-gate-plugin/src/acp/warm-session.ts"]))
      .toEqual(["test/acp-pool.test.ts", "test/warm-session.test.ts"])
    expect(pullInsFor("ccgate", ["cc-gate-plugin/src/acp/acp-client.ts"]))
      .toEqual(["test/acp-client.test.ts"])
  })
  test("changed slow TEST file pulls itself", () => {
    expect(pullInsFor("ccgate", ["cc-gate-plugin/test/warm-session.test.ts"]))
      .toEqual(["test/warm-session.test.ts"])
  })
  test("changed test stubs pull their direct slow consumers (exact lists)", () => {
    expect(pullInsFor("ccgate", ["cc-gate-plugin/test/acp-fake-daemon.ts"]))
      .toEqual(["test/acp-client.test.ts", "test/anthropic-cli-warm.test.ts"])
    expect(pullInsFor("ccgate", ["cc-gate-plugin/test/agent-cli-stub.ts"]))
      .toEqual([
        "test/acp-client.test.ts", "test/acp-daemon.test.ts",
        "test/gauge-agent-transport.test.ts", "test/warm-session.test.ts",
      ])
  })
  test("fast files, foreign packages, near-miss basenames pull nothing", () => {
    expect(pullInsFor("ccgate", [
      "cc-gate-plugin/src/gauge/acp-wire.ts",     // fast, not in the slow set
      "km-crank/src/acp-daemon.ts",               // foreign package
      "cc-gate-plugin/src/reinject.ts",
    ])).toEqual([])
  })
  test("deduplicated union across paths", () => {
    expect(pullInsFor("ccgate", [
      "cc-gate-plugin/src/gauge/acp-pool.ts", "cc-gate-plugin/test/acp-pool.test.ts",
    ])).toEqual(["test/acp-daemon.test.ts", "test/acp-pool.test.ts"])
  })
})

describe("pullInsFor (suite-keyed pull-in)", () => {
  // ccgate's own exact-list coverage now lives entirely in the
  // "pullInsFor('ccgate', ...) — amendment b" describe block above (the
  // ported home of the retired slowCcgateTestsForChangedPaths tests) — not
  // duplicated here.
  test("suite-keyed, never a flat union: a suite with no configured policy pulls nothing, even for paths that pull for another suite", () => {
    expect(pullInsFor("opencode", ["cc-gate-plugin/test/warm-session.test.ts"])).toEqual([])
  })
  test("kmcrank: a changed slow TEST file pulls itself (second-package self-pull, Task 1 Step 5)", () => {
    expect(pullInsFor("kmcrank", ["km-crank/test/gate-check-cli.test.ts"]))
      .toEqual(["test/gate-check-cli.test.ts"])
  })
  test("kmcrank: guardless pull-ins for the gate's own entry point and pure-logic module (no package prefix)", () => {
    expect(pullInsFor("kmcrank", ["scripts/gate-check.ts"]))
      .toEqual(["test/gate-check-cli.test.ts"])
    expect(pullInsFor("kmcrank", ["km-crank/src/gate-check-core.ts"]))
      .toEqual(["test/gate-check-cli.test.ts"])
  })
  test("per-rule guard: a scripts/gate-check.ts change pulls the km-crank test while ccgate's guarded rules stay inert for the same path", () => {
    expect(pullInsFor("kmcrank", ["scripts/gate-check.ts"]))
      .toEqual(["test/gate-check-cli.test.ts"])
    expect(pullInsFor("ccgate", ["scripts/gate-check.ts"])).toEqual([])
  })
  test("kmcrank pulls nothing for paths outside its own rules, including another suite's slow-covered path", () => {
    expect(pullInsFor("kmcrank", ["cc-gate-plugin/src/gauge/acp-daemon.ts"])).toEqual([])
  })
})

describe("fastFiles (suite-keyed, ported from the retired ccgateFastFiles)", () => {
  test("ccgate: filters exactly the spawn-heavy files, keeps the rest", () => {
    const files = [
      "test/acp-client.test.ts", "test/acp-daemon.test.ts", "test/acp-pool.test.ts",
      "test/anthropic-cli-warm.test.ts", "test/warm-session.test.ts",
      "test/gauge-agent-transport.test.ts",
      "test/acp-wire.test.ts", "test/acp-paths.test.ts", "test/reinject.test.ts",
    ]
    expect(fastFiles("ccgate", files)).toEqual([
      "test/acp-wire.test.ts", "test/acp-paths.test.ts", "test/reinject.test.ts",
    ])
  })
  test("ccgate: empty in, empty out", () => {
    expect(fastFiles("ccgate", [])).toEqual([])
  })
  test("kmcrank: filters its own slow file (gate-check-cli.test.ts), keeps the rest", () => {
    expect(fastFiles("kmcrank", ["test/gate-check-core.test.ts", "test/gate-check-cli.test.ts"]))
      .toEqual(["test/gate-check-core.test.ts"])
  })
  test("a suite with no configured slowTestRe (e.g. doccheck) is unfiltered — no narrowing means no-op", () => {
    const files = ["test/a.test.ts", "test/b.test.ts"]
    expect(fastFiles("doccheck", files)).toEqual(files)
  })
})

describe("SUITE_POLICY / PKG_DIR invariant (gate-check-core.ts:197-207)", () => {
  test("every SUITE_POLICY key is also a PKG_DIR key — a suite only gets " +
    "pull-in rules if scripts/gate-check.ts's scanFastArgv gives it an " +
    "ENUMERATED fast-file Cmd.argv (never a bare [\"bun\",\"test\"]); " +
    "otherwise a pull-in append would silently collapse the whole suite " +
    "to the appended file(s), the same class of bug the scanFailed guard " +
    "exists to prevent, reintroduced from the policy side", () => {
    for (const suite of Object.keys(SUITE_POLICY)) {
      expect(PKG_DIR).toHaveProperty(suite)
    }
  })
})

describe("fastArgvSuffix (scanFastArgv's pure decision half — review fix)", () => {
  test("scanFailed=false: behaves exactly like fastFiles, narrowed normally", () => {
    expect(fastArgvSuffix("ccgate", ["test/acp-wire.test.ts", "test/acp-daemon.test.ts"], false))
      .toEqual(["test/acp-wire.test.ts"])
  })
  test("scanFailed=true DISCARDS whatever was collected, even a non-empty partial scan — the MEDIUM fix: " +
    "a partial failure (one root threw, the other read fine and contributed real fast files) must not " +
    "produce a narrowed-looking-but-incomplete argv", () => {
    expect(fastArgvSuffix("ccgate", ["test/acp-wire.test.ts", "test/reinject.test.ts"], true))
      .toEqual([])
  })
  test("scanFailed=true with an empty partial scan also discards to [] (same outcome, degenerate input)", () => {
    expect(fastArgvSuffix("ccgate", [], true)).toEqual([])
  })
  test("scanFailed=true for a suite with no slowTestRe still discards to [] — the flag wins regardless of policy", () => {
    expect(fastArgvSuffix("doccheck", ["test/a.test.ts"], true)).toEqual([])
  })
})
