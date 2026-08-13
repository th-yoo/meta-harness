import { test, expect, spyOn } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import {
  layerStoreRoots,
  parsePins,
  assembleAgentsMd,
  harnessMeta,
  opencodeVersion,
  pluginSha,
  harnessHash,
  envBlock,
  sessionRecord,
  recordToStores,
} from "../src/bench/record.ts"
import {
  layersFor,
  createCandidate,
  readScore,
  projectGlobalRoot,
  readTrajectory,
  readMhConfig,
  buildProposerContext,
  candidatePath,
  EMPTY_CHECKS_HASH,
} from "../src/harness-store.ts"
import { BenchError } from "../src/bench/util.ts"
import type { ExecResult } from "../src/bench/exec.ts"

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mh-bench-record-"))
}

// ── layerStoreRoots ordering (mandatory parity test) ─────────────────────
//
// Note: account-global/account-role are pure path-string constructions here
// (accountGlobalRoot()/accountRoleRoot() never touch the filesystem) — no
// real host state is read or written by this test. Any test that would
// actually WRITE into an account-scoped store is deliberately avoided
// throughout this file (see the recordToStores/pin tests below, which only
// ever exercise the project-scoped layers under a tmp metaRoot).

test("layerStoreRoots order === harness-store layersFor's root order, for layers=global + agent set", () => {
  const metaRoot = tmpDir()
  const agent = "mh-build"
  const roots = layerStoreRoots("global", agent, metaRoot)
  const viaLayersFor = layersFor(metaRoot, agent)

  expect(roots.map(([name]) => name)).toEqual(["account-global", "project-global", "account-role", "project-role"])
  expect(roots.map(([name]) => name)).toEqual(viaLayersFor.map((l) => l.scope))
  expect(roots.map(([, root]) => root)).toEqual(viaLayersFor.map((l) => l.root))
})

test("layerStoreRoots: layers=account/project/none gating, and agent='' drops role rows", () => {
  const metaRoot = tmpDir()
  expect(layerStoreRoots("global", "", metaRoot).map(([n]) => n)).toEqual(["account-global", "project-global"])
  expect(layerStoreRoots("account", "", metaRoot).map(([n]) => n)).toEqual(["account-global"])
  expect(layerStoreRoots("project", "", metaRoot).map(([n]) => n)).toEqual(["project-global"])
  expect(layerStoreRoots("none", "", metaRoot).map(([n]) => n)).toEqual([])
  expect(layerStoreRoots("account", "mh-build", metaRoot).map(([n]) => n)).toEqual(["account-global", "account-role"])
  expect(layerStoreRoots("project", "mh-build", metaRoot).map(([n]) => n)).toEqual(["project-global", "project-role"])
})

// ── parsePins ──────────────────────────────────────────────────────────

test("parsePins: empty pin list -> {}", () => {
  expect(parsePins([], "global", "", tmpDir())).toEqual({})
})

test("parsePins: --layers none rejects any pin", () => {
  expect(() => parsePins(["project-global=v1"], "none", "", tmpDir())).toThrow(BenchError)
})

test("parsePins: malformed spec (no '=') dies", () => {
  expect(() => parsePins(["not-a-pin"], "global", "", tmpDir())).toThrow(BenchError)
})

test("parsePins: unknown layer name dies", () => {
  expect(() => parsePins(["bogus-layer=v1"], "global", "", tmpDir())).toThrow(BenchError)
})

test("parsePins: version not matching vN dies", () => {
  expect(() => parsePins(["project-global=abc"], "global", "", tmpDir())).toThrow(BenchError)
})

test("parsePins: same layer pinned twice dies", () => {
  const metaRoot = tmpDir()
  createCandidate(projectGlobalRoot(metaRoot), "v1", "sys")
  expect(() => parsePins(["project-global=v1", "project-global=v1"], "global", "", metaRoot)).toThrow(BenchError)
})

test("parsePins: role layer without --agent dies", () => {
  expect(() => parsePins(["project-role=v1"], "global", "", tmpDir())).toThrow(BenchError)
})

test("parsePins: layer not included by --layers dies", () => {
  const metaRoot = tmpDir()
  expect(() => parsePins(["project-global=v1"], "account", "", metaRoot)).toThrow(BenchError)
})

test("parsePins: nonexistent candidate dies naming the have-list", () => {
  const metaRoot = tmpDir()
  expect(() => parsePins(["project-global=v1"], "global", "", metaRoot)).toThrow(BenchError)
})

test("parsePins: valid pin on project-global resolves", () => {
  const metaRoot = tmpDir()
  createCandidate(projectGlobalRoot(metaRoot), "v3", "sys")
  expect(parsePins(["project-global=v3"], "global", "", metaRoot)).toEqual({ "project-global": "v3" })
})

test("parsePins: valid pin on project-role resolves (requires --agent)", () => {
  const metaRoot = tmpDir()
  const agent = "mh-build"
  const roots = new Map(layerStoreRoots("global", agent, metaRoot))
  createCandidate(roots.get("project-role")!, "v2", "sys")
  expect(parsePins(["project-role=v2"], "global", agent, metaRoot)).toEqual({ "project-role": "v2" })
})

// ── assembleAgentsMd ─────────────────────────────────────────────────────

test("assembleAgentsMd: empty stores -> empty string", () => {
  expect(assembleAgentsMd("project", tmpDir())).toBe("")
})

test("assembleAgentsMd: active project-global system+tools, joined with the labeled heading", () => {
  const metaRoot = tmpDir()
  const root = projectGlobalRoot(metaRoot)
  createCandidate(root, "v1", "Be careful.", "bash: use -e")
  // activate v1
  const { writeActive } = require("../src/harness-store.ts") as typeof import("../src/harness-store.ts")
  writeActive(root, "v1", "Be careful.", "bash: use -e")

  const md = assembleAgentsMd("project", metaRoot)
  expect(md).toBe("## Project guidance\n\nBe careful.\n\n---\n\n## Project tool usage\n\nbash: use -e")
})

test("assembleAgentsMd: pinned candidate reads candidate text, not active text", () => {
  const metaRoot = tmpDir()
  const root = projectGlobalRoot(metaRoot)
  const { writeActive } = require("../src/harness-store.ts") as typeof import("../src/harness-store.ts")
  createCandidate(root, "v1", "active text")
  writeActive(root, "v1", "active text")
  createCandidate(root, "v2", "candidate text")

  const md = assembleAgentsMd("project", metaRoot, "", { "project-global": "v2" })
  expect(md).toContain("candidate text")
  expect(md).not.toContain("active text")
})

test("assembleAgentsMd: role layer heading substitutes {agent}", () => {
  const metaRoot = tmpDir()
  const agent = "mh-build"
  const roots = new Map(layerStoreRoots("project", agent, metaRoot))
  const root = roots.get("project-role")!
  const { writeActive } = require("../src/harness-store.ts") as typeof import("../src/harness-store.ts")
  createCandidate(root, "v1", "role rule")
  writeActive(root, "v1", "role rule")

  const md = assembleAgentsMd("project", metaRoot, agent)
  expect(md).toContain(`## Project role guidance (${agent})`)
  expect(md).toContain("role rule")
})

// ── assembleAgentsMd: generality-tag routing (project-global, hermetic) ────
// project-global is metaRoot-scoped (no real account-root writes), per this
// file's header note and the plan's Task-4 hermeticity requirement.

test("assembleAgentsMd routes project-global by model", () => {
  const metaRoot = tmpDir()
  const root = projectGlobalRoot(metaRoot)
  const { writeActive } = require("../src/harness-store.ts") as typeof import("../src/harness-store.ts")
  const pb = {
    schemaVersion: 1 as const,
    nextId: 3,
    bullets: [
      { id: "b1", text: "U", helpful: 0, harmful: 0, addedBy: "t", status: "active" as const, createdAt: "t", updatedAt: "t" },
      { id: "b2", text: "VA", helpful: 0, harmful: 0, addedBy: "t", status: "active" as const, createdAt: "t", updatedAt: "t", generality: "vendor" as const, slice: "anthropic" },
    ],
  }
  const flat = "- U\n- VA\n"
  createCandidate(root, "v1", flat, "", pb)
  writeActive(root, "v1", flat, "", pb)

  const md = (model?: string) => assembleAgentsMd("project", metaRoot, "", {}, model)
  expect(md("anthropic/claude-haiku-4-5")).toContain("- VA")
  expect(md("openai/gpt-5")).not.toContain("- VA")
  expect(md("openai/gpt-5")).toContain("- U")
  expect(md()).toContain("- VA") // no model → flat (back-compat)
})

// ── harnessMeta ──────────────────────────────────────────────────────────

test("harnessMeta: layers='none' shortcut not applicable here (cmd-run handles that); empty store -> 'none' actives", () => {
  const metaRoot = tmpDir()
  const meta = harnessMeta("project", metaRoot)
  expect(meta["project_active"]).toBe("none")
  expect(meta["pins"]).toEqual({})
  expect(meta["agent"]).toBe("")
})

test("harnessMeta: agent set adds role active fields", () => {
  const metaRoot = tmpDir()
  const meta = harnessMeta("project", metaRoot, "mh-build")
  expect(meta).toHaveProperty("project_role_active")
  expect(meta).toHaveProperty("account_role_active")
})

// ── provenance: opencodeVersion / pluginSha / harnessHash / envBlock ──────

function fakeSpawn(stdout: string, rc = 0): (argv: string[]) => Promise<ExecResult> {
  return async () => ({ rc, stdout, stderr: "", timedOut: false })
}

test("opencodeVersion: first line of stdout, capped at 40 chars", async () => {
  expect(await opencodeVersion(fakeSpawn("opencode 1.2.3\nextra ignored line"))).toBe("opencode 1.2.3")
})

test("opencodeVersion: falls back to stderr when stdout empty", async () => {
  const execFn = async (): Promise<ExecResult> => ({ rc: 1, stdout: "", stderr: "some stderr version", timedOut: false })
  expect(await opencodeVersion(execFn)).toBe("some stderr version")
})

test("opencodeVersion: exec throwing -> 'unknown'", async () => {
  const execFn = async (): Promise<ExecResult> => {
    throw new Error("no such binary")
  }
  expect(await opencodeVersion(execFn)).toBe("unknown")
})

test("opencodeVersion: blank output -> 'unknown'", async () => {
  expect(await opencodeVersion(fakeSpawn("   \n"))).toBe("unknown")
})

test("pluginSha: trimmed stdout", async () => {
  expect(await pluginSha("/repo", fakeSpawn("abc1234\n"))).toBe("abc1234")
})

test("pluginSha: exec throwing -> 'unknown'", async () => {
  const execFn = async (): Promise<ExecResult> => {
    throw new Error("not a git repo")
  }
  expect(await pluginSha("/repo", execFn)).toBe("unknown")
})

test("harnessHash: sha256 hex, first 16 chars, deterministic", () => {
  const h1 = harnessHash("hello harness")
  const h2 = harnessHash("hello harness")
  const h3 = harnessHash("different")
  expect(h1).toBe(h2)
  expect(h1).not.toBe(h3)
  expect(h1).toMatch(/^[0-9a-f]{16}$/)
})

test("envBlock: assembles agentVersion/pluginSha/harnessHash/maxAgentTimeout/provider/driver", async () => {
  let calls = 0
  const execFn = async (argv: string[]): Promise<ExecResult> => {
    calls++
    if (argv[0] === "opencode") return { rc: 0, stdout: "opencode 9.9.9", stderr: "", timedOut: false }
    return { rc: 0, stdout: "deadbee\n", stderr: "", timedOut: false }
  }
  const env = await envBlock("harness text", 600, "anthropic/claude-sonnet-4-6", "/repo", execFn)
  expect(env).toEqual({
    agentVersion: "opencode 9.9.9",
    pluginSha: "deadbee",
    harnessHash: harnessHash("harness text"),
    maxAgentTimeout: 600,
    provider: "anthropic",
    driver: "opencode",
    resourceEnforcement: false,
    checksHash: EMPTY_CHECKS_HASH,
  })
  expect(calls).toBe(2)
})

test("envBlock: checksHash defaults to EMPTY_CHECKS_HASH, but is carried through verbatim when supplied (a3 routing T5)", async () => {
  const execFn = async (): Promise<ExecResult> => ({ rc: 0, stdout: "v1\n", stderr: "", timedOut: false })
  const off = await envBlock("h", 0, "anthropic/claude-x", "/repo", execFn)
  expect(off.checksHash).toBe(EMPTY_CHECKS_HASH)

  // A distinct (sha256-shaped) hash round-trips verbatim — trailing param
  // after minAgentTimeout, so minAgentTimeout is explicitly skipped (undefined).
  const distinct = "b".repeat(64)
  const on = await envBlock("h", 0, "anthropic/claude-x", "/repo", execFn, "some-version", "opencode", true, undefined, distinct)
  expect(on.checksHash).toBe(distinct)
})

test("envBlock: resourceEnforcement defaults to false, but is carried through verbatim when supplied", async () => {
  const execFn = async (): Promise<ExecResult> => ({ rc: 0, stdout: "v1\n", stderr: "", timedOut: false })
  const off = await envBlock("h", 0, "anthropic/claude-x", "/repo", execFn)
  expect(off.resourceEnforcement).toBe(false)

  const on = await envBlock("h", 0, "anthropic/claude-x", "/repo", execFn, "some-version", "opencode", true)
  expect(on.resourceEnforcement).toBe(true)
})

test("envBlock: minAgentTimeout is omitted when no floor, stamped verbatim when set", async () => {
  const execFn = async (): Promise<ExecResult> => ({ rc: 0, stdout: "v1\n", stderr: "", timedOut: false })
  // No floor (undefined / falsy) -> key absent, byte-identical env shape.
  const off = await envBlock("h", 600, "anthropic/claude-x", "/repo", execFn)
  expect(Object.prototype.hasOwnProperty.call(off, "minAgentTimeout")).toBe(false)
  // Floor set -> carried through verbatim (trailing param after resourceEnforcement).
  const on = await envBlock("h", 600, "anthropic/claude-x", "/repo", execFn, "some-version", "opencode", true, 3600)
  expect(on.minAgentTimeout).toBe(3600)
})

test("envBlock: driverId param defaults to 'opencode' but is carried through verbatim when supplied", async () => {
  const execFn = async (): Promise<ExecResult> => ({ rc: 0, stdout: "v1\n", stderr: "", timedOut: false })
  const env = await envBlock("h", 0, "anthropic/claude-x", "/repo", execFn, "some-version", "fake-driver")
  expect(env.driver).toBe("fake-driver")
  expect(env.agentVersion).toBe("some-version")
})

test("envBlock: bare (unprefixed) model -> provider 'unknown'; maxAgentTimeout 0 stays 0", async () => {
  const env = await envBlock("", 0, "bare-model-name", "/repo", fakeSpawn(""))
  expect(env.provider).toBe("unknown")
  expect(env.maxAgentTimeout).toBe(0)
})

test("envBlock: agentVersionOverride bypasses the (host) opencodeVersion lookup entirely", async () => {
  // cmd-run.ts/cmd-ab.ts pass the IN-CONTAINER version here (see
  // inContainerAgentVersion in cmd-run.ts) — the host lookup must not
  // even be attempted when an override is supplied.
  let opencodeCalls = 0
  const execFn = async (argv: string[]): Promise<ExecResult> => {
    if (argv[0] === "opencode") opencodeCalls++
    return { rc: 0, stdout: "deadbee\n", stderr: "", timedOut: false }
  }
  const env = await envBlock("h", 0, "anthropic/claude-x", "/repo", execFn, "opencode 9.9.9 (in-container)")
  expect(env.agentVersion).toBe("opencode 9.9.9 (in-container)")
  expect(opencodeCalls).toBe(0) // host `opencode --version` never invoked
  expect(env.pluginSha).toBe("deadbee") // pluginSha (git) still runs on the host
})

// ── sessionRecord ────────────────────────────────────────────────────────

test("sessionRecord: matches harness-store SessionRecord shape (bench:<task> note, task summary)", () => {
  const rec = sessionRecord("mytask", "sess-1", true, 5, { bash: { calls: 2, errors: 0 } }, "m", "high", { foo: "bar" })
  expect(rec.sessionID).toBe("sess-1")
  expect(rec.passed).toBe(true)
  expect(rec.note).toBe("bench:mytask")
  expect(rec.turnCount).toBe(5)
  expect(rec.summary).toBe("mytask")
  expect(rec.model).toBe("m")
  expect(rec.variant).toBe("high")
  expect(rec.toolUsage).toEqual({ bash: { calls: 2, errors: 0 } })
  expect(rec.env).toEqual({ foo: "bar" })
  expect(typeof rec.timestamp).toBe("string")
})

test("sessionRecord: variant defaults to '' when falsy", () => {
  expect(sessionRecord("t", "s", false, 1, {}, "m", "").variant).toBe("")
})

// Task L1: bench sessions are driven by a selectable AgentDriver (task-B3),
// so `platform` provenance on a bench-recorded SessionRecord is the DRIVER
// id, not a hardcoded "opencode" — envBlock already threads driverId into
// `env.driver` (see envBlock's driver tests above), so sessionRecord reads
// it from there rather than needing a new parameter.

test("sessionRecord: platform is set to env.driver (the AgentDriver id envBlock threaded through)", () => {
  const rec = sessionRecord("t", "s", true, 1, {}, "m", "", { driver: "claude-code" })
  expect(rec.platform).toBe("claude-code")
})

test("sessionRecord: no env.driver present -> platform stays undefined (no invented default)", () => {
  const rec = sessionRecord("t", "s", true, 1, {}, "m", "", { foo: "bar" })
  expect(rec.platform).toBeUndefined()
})

test("sessionRecord: cpuSeconds/peakRssMb stamped only when provided (conditional-stamp idiom)", () => {
  // measured footprint present (trailing params after agentTimeout)
  const measured = sessionRecord("t", "s", true, 1, {}, "m", "", {}, 12.3, false, 900, 42.5, 256)
  expect(measured.cpuSeconds).toBe(42.5)
  expect(measured.peakRssMb).toBe(256)
  // omitted → keys absent (pre-capture records + non-podman callers keep parsing)
  const bare = sessionRecord("t", "s", true, 1, {}, "m", "")
  expect("cpuSeconds" in bare).toBe(false)
  expect("peakRssMb" in bare).toBe(false)
})

test("sessionRecord: capMemoryMb/capRaised stamped only when provided (per-session cap provenance)", () => {
  // trailing cap-provenance params after cpuSeconds/peakRssMb
  const withCap = sessionRecord("t", "s", true, 1, {}, "m", "", {}, 12.3, false, 900, 42.5, 256, 6144, true)
  expect(withCap.capMemoryMb).toBe(6144)
  expect(withCap.capRaised).toBe(true)
  // capRaised:false is still stamped (present-but-false), distinct from omitted
  const notRaised = sessionRecord("t", "s", true, 1, {}, "m", "", {}, 12.3, false, 900, 42.5, 256, 2048, false)
  expect(notRaised.capMemoryMb).toBe(2048)
  expect(notRaised.capRaised).toBe(false)
  // omitted → keys absent (unenforced runs never stamp them)
  const bare = sessionRecord("t", "s", true, 1, {}, "m", "")
  expect("capMemoryMb" in bare).toBe(false)
  expect("capRaised" in bare).toBe(false)
})

// ── recordToStores ───────────────────────────────────────────────────────
// Only ever exercises project-scoped layers under a fresh tmp metaRoot — no
// account-global/account-role writes anywhere in this file (see file header).

test("recordToStores: noStore=true is a pure no-op (no fs writes)", () => {
  const metaRoot = tmpDir()
  recordToStores("t", "s1", true, 3, {}, "m", "", "project", metaRoot, true)
  expect(fs.existsSync(projectGlobalRoot(metaRoot))).toBe(false)
})

test("recordToStores: turnCount=0 is skipped (hygiene — timeout/transient failure, not a verdict)", () => {
  const metaRoot = tmpDir()
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    recordToStores("t", "s1", true, 0, {}, "m", "", "project", metaRoot, false)
    const messages = errSpy.mock.calls.map((c) => String(c[0]))
    expect(messages.some((m) => m.includes("skip store record: 0 agent turns"))).toBe(true)
  } finally {
    errSpy.mockRestore()
  }
  expect(fs.existsSync(projectGlobalRoot(metaRoot))).toBe(false)
})

test("recordToStores: writes a SessionRecord into project-global's active version, logs nPass/nFail", () => {
  const metaRoot = tmpDir()
  const root = projectGlobalRoot(metaRoot)
  createCandidate(root, "v0", "sys")
  const { writeActive } = require("../src/harness-store.ts") as typeof import("../src/harness-store.ts")
  writeActive(root, "v0", "sys")

  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  try {
    recordToStores("mytask", "sess-a", true, 4, { bash: { calls: 1, errors: 0 } }, "m", "", "project", metaRoot, false)
    const messages = errSpy.mock.calls.map((c) => String(c[0]))
    expect(messages.some((m) => m.includes("store project-global v0: nPass=1 nFail=0"))).toBe(true)
  } finally {
    errSpy.mockRestore()
  }
  const score = readScore(root, "v0")
  expect(score.nPass).toBe(1)
  expect(score.sessions[0]!.sessionID).toBe("sess-a")
})

test("recordToStores: persisted record.platform equals the driver id carried in env.driver", () => {
  const metaRoot = tmpDir()
  const root = projectGlobalRoot(metaRoot)
  createCandidate(root, "v0", "sys")
  const { writeActive } = require("../src/harness-store.ts") as typeof import("../src/harness-store.ts")
  writeActive(root, "v0", "sys")

  recordToStores("t", "sess-driver", true, 2, {}, "m", "", "project", metaRoot, false, "", {}, { driver: "claude-code" })

  const score = readScore(root, "v0")
  expect(score.sessions[0]!.platform).toBe("claude-code")
})

test("recordToStores: persists capMemoryMb/capRaised onto the session record when provided (and omits them when not)", () => {
  const metaRoot = tmpDir()
  const root = projectGlobalRoot(metaRoot)
  createCandidate(root, "v0", "sys")
  const { writeActive } = require("../src/harness-store.ts") as typeof import("../src/harness-store.ts")
  writeActive(root, "v0", "sys")

  // trailing capMemoryMb/capRaised after cpuSeconds/peakRssMb
  recordToStores(
    "t",
    "sess-cap",
    true,
    2,
    {},
    "m",
    "",
    "project",
    metaRoot,
    false,
    "",
    {},
    {},
    [],
    false,
    false,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    6144,
    true,
  )
  const withCap = readScore(root, "v0").sessions[0]!
  expect(withCap.capMemoryMb).toBe(6144)
  expect(withCap.capRaised).toBe(true)

  // a second record with the params omitted → keys absent on that record
  recordToStores("t", "sess-nocap", true, 2, {}, "m", "", "project", metaRoot, false)
  const bare = readScore(root, "v0").sessions.find((s) => s.sessionID === "sess-nocap")!
  expect("capMemoryMb" in bare).toBe(false)
  expect("capRaised" in bare).toBe(false)
})

test("recordToStores: pinned layer records into the PINNED candidate, not the active one", () => {
  const metaRoot = tmpDir()
  const root = projectGlobalRoot(metaRoot)
  const { writeActive } = require("../src/harness-store.ts") as typeof import("../src/harness-store.ts")
  createCandidate(root, "v0", "sys0")
  writeActive(root, "v0", "sys0")
  createCandidate(root, "v5", "sys5")

  recordToStores("t", "s1", true, 2, {}, "m", "", "project", metaRoot, false, "", { "project-global": "v5" })

  expect(readScore(root, "v0").sessions.length).toBe(0)
  expect(readScore(root, "v5").sessions.length).toBe(1)
})

test("recordToStores: saves a trajectory for a FAILING run, not for a passing run (unless saveAllTraj)", () => {
  const metaRoot = tmpDir()
  const root = projectGlobalRoot(metaRoot)
  createCandidate(root, "v0", "sys")
  const { writeActive } = require("../src/harness-store.ts") as typeof import("../src/harness-store.ts")
  writeActive(root, "v0", "sys")

  const events = [{ t: "text" as const, text: "hi" }]
  recordToStores("t", "pass-sess", true, 2, {}, "m", "", "project", metaRoot, false, "", {}, {}, events, false)
  recordToStores("t", "fail-sess", false, 2, {}, "m", "", "project", metaRoot, false, "", {}, {}, events, false)

  expect(readTrajectory(root, "v0", "pass-sess")).toEqual([])
  expect(readTrajectory(root, "v0", "fail-sess")).toEqual(events)
})

test("recordToStores: saveAllTraj=true persists trajectories for passing runs too", () => {
  const metaRoot = tmpDir()
  const root = projectGlobalRoot(metaRoot)
  createCandidate(root, "v0", "sys")
  const { writeActive } = require("../src/harness-store.ts") as typeof import("../src/harness-store.ts")
  writeActive(root, "v0", "sys")

  const events = [{ t: "text" as const, text: "hi" }]
  recordToStores("t", "pass-sess", true, 2, {}, "m", "", "project", metaRoot, false, "", {}, {}, events, true)

  expect(readTrajectory(root, "v0", "pass-sess")).toEqual(events)
})

// ── Loop-3 T3: recordTimeouts flag (record.ts guard change) ──────────────
//
// The 0-turn skip guard is intentionally a DISCRIMINATOR, not a blanket
// drop: turnCount===0 && !(timedOut && recordTimeouts). Flag OFF (default)
// keeps today's behavior byte-identical for every 0-turn run (timeout OR
// auth/transient). Flag ON records ONLY the timeout subset — auth/transient
// 0-turn runs (timedOut unset/false) must still be dropped even with the
// flag on, so the proposer never sees pre-agent-phase noise as a fitness
// signal.

test("recordToStores: flag ON + timedOut=true -> writes a genuine fail (passed=false, turnCount=0, timedOut=true, elapsed set)", () => {
  const metaRoot = tmpDir()
  const root = projectGlobalRoot(metaRoot)
  createCandidate(root, "v0", "sys")
  const { writeActive } = require("../src/harness-store.ts") as typeof import("../src/harness-store.ts")
  writeActive(root, "v0", "sys")

  recordToStores(
    "t", "sess-timeout", false, 0, {}, "m", "", "project", metaRoot, false,
    "", {}, {}, [], false,
    /* timedOut */ true, /* recordTimeouts */ true, /* elapsed */ 638.4,
  )

  const score = readScore(root, "v0")
  expect(score.sessions).toHaveLength(1)
  expect(score.sessions[0]!.passed).toBe(false)
  expect(score.sessions[0]!.turnCount).toBe(0)
  expect(score.sessions[0]!.timedOut).toBe(true)
  expect(score.sessions[0]!.elapsed).toBe(638.4)
  expect(score.nFail).toBe(1)
})

test("recordToStores: flag OFF (default) still drops a timeout — byte-identical to today", () => {
  const metaRoot = tmpDir()
  const root = projectGlobalRoot(metaRoot)
  createCandidate(root, "v0", "sys")
  const { writeActive } = require("../src/harness-store.ts") as typeof import("../src/harness-store.ts")
  writeActive(root, "v0", "sys")

  recordToStores(
    "t", "sess-timeout", false, 0, {}, "m", "", "project", metaRoot, false,
    "", {}, {}, [], false,
    /* timedOut */ true, /* recordTimeouts */ false, /* elapsed */ 638.4,
  )

  expect(readScore(root, "v0").sessions).toEqual([])
})

test("recordToStores: flag ON but timedOut=false (auth/transient 0-turn) is STILL dropped (discriminator)", () => {
  const metaRoot = tmpDir()
  const root = projectGlobalRoot(metaRoot)
  createCandidate(root, "v0", "sys")
  const { writeActive } = require("../src/harness-store.ts") as typeof import("../src/harness-store.ts")
  writeActive(root, "v0", "sys")

  recordToStores(
    "t", "sess-authfail", false, 0, {}, "m", "", "project", metaRoot, false,
    "", {}, {}, [], false,
    /* timedOut */ false, /* recordTimeouts */ true,
  )

  expect(readScore(root, "v0").sessions).toEqual([])
})

test("sessionRecord: elapsed/timedOut stamped only when provided (matches platform's conditional-stamp idiom)", () => {
  const withBoth = sessionRecord("t", "s", false, 0, {}, "m", "", {}, 12.5, true)
  expect(withBoth.elapsed).toBe(12.5)
  expect(withBoth.timedOut).toBe(true)

  const withNeither = sessionRecord("t", "s", true, 3, {}, "m", "")
  expect(withNeither.elapsed).toBeUndefined()
  expect(withNeither.timedOut).toBeUndefined()
})

// Loop-3 pre-flip fix #1: `agentTimeout` (the REAL per-task budget, distinct
// from env.maxAgentTimeout's run-level cap) is stamped only when provided —
// same conditional-stamp idiom as elapsed/timedOut, additive-only.
test("sessionRecord: agentTimeout stamped only when provided (real per-task budget, additive)", () => {
  const withIt = sessionRecord("t", "s", false, 0, {}, "m", "", {}, 12.5, true, 300)
  expect(withIt.agentTimeout).toBe(300)

  const without = sessionRecord("t", "s", true, 3, {}, "m", "", {}, 12.5, true)
  expect(without.agentTimeout).toBeUndefined()
})

test("recordToStores: agentTimeout threads through into the persisted SessionRecord", () => {
  const metaRoot = tmpDir()
  const root = projectGlobalRoot(metaRoot)
  createCandidate(root, "v0", "sys")
  const { writeActive } = require("../src/harness-store.ts") as typeof import("../src/harness-store.ts")
  writeActive(root, "v0", "sys")

  recordToStores(
    "t", "sess-timeout", false, 0, {}, "m", "", "project", metaRoot, false,
    "", {}, { maxAgentTimeout: 900 }, [], false,
    /* timedOut */ true, /* recordTimeouts */ true, /* elapsed */ 290.1, /* agentTimeout */ 300,
  )

  const score = readScore(root, "v0")
  expect(score.sessions).toHaveLength(1)
  expect(score.sessions[0]!.agentTimeout).toBe(300)
  expect(score.sessions[0]!.elapsed).toBe(290.1)
})

// ── Loop-3 T3: back-compat (pre-Loop-3 score.json still parses/renders) ──

test("back-compat: a score.json with neither elapsed nor timedOut parses and renders via buildProposerContext", () => {
  const metaRoot = tmpDir()
  const root = projectGlobalRoot(metaRoot)
  createCandidate(root, "v0", "sys")

  const legacyRecord = {
    sessionID: "legacy-1",
    passed: false,
    note: "bench:t",
    turnCount: 3,
    timestamp: new Date().toISOString(),
    summary: "t",
    model: "m",
    variant: "",
    toolUsage: {},
  }
  fs.writeFileSync(
    candidatePath(root, "v0", "score.json"),
    JSON.stringify({ version: "v0", nPass: 0, nFail: 1, sessions: [legacyRecord] }),
  )

  const score = readScore(root, "v0")
  expect(score.sessions).toHaveLength(1)
  expect(score.sessions[0]!.timedOut).toBeUndefined()
  expect(score.sessions[0]!.elapsed).toBeUndefined()

  let context = ""
  expect(() => {
    context = buildProposerContext(root, [])
  }).not.toThrow()
  expect(context).toContain("FAIL")
})

// ── Loop-3 T3: MhConfig.recordTimeouts default-OFF flag ───────────────────

test("readMhConfig: recordTimeouts defaults to false (OFF); {\"recordTimeouts\":true} honored", () => {
  const empty = tmpDir()
  expect(readMhConfig(empty).recordTimeouts).toBe(false)

  const set = tmpDir()
  fs.writeFileSync(path.join(set, "config.json"), JSON.stringify({ recordTimeouts: true }))
  expect(readMhConfig(set).recordTimeouts).toBe(true)
})
