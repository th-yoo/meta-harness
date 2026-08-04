import { test, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { gaugeDir } from "../src/gauge/files.ts"
import { stubServer, stubServerFor, type SdkStub } from "./sdk-stub.ts"

const REFINER_CLI = path.join(import.meta.dir, "..", "src", "gauge", "refiner-cli.ts")

// E2E against a stub Anthropic API server (§6c SDK transport — the CLI child
// no longer spawns `claude -p`; it makes one direct API call). Zero real
// model calls: KKAMAK_GAUGE_SDK_BASE_URL points every child at the stub.

function mkRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "km-gauge-rcli-"))
}

// floorCheck omitted (undefined) by default → writes a v1-shaped req, no
// floorCheck key at all (pre-Task-2 spawn.ts shape); pass a string to write
// a fresh v2-shaped req instead.
function writeReq(repo: string, sessionID: string, n: number, prompt: string, floorCheck?: string): void {
  const dir = gaugeDir(repo)
  fs.mkdirSync(dir, { recursive: true })
  const body: Record<string, unknown> =
    floorCheck === undefined
      ? { v: 1, sessionID, n, ts: 1, prompt }
      : { v: 2, sessionID, n, ts: 1, prompt, floorCheck }
  fs.writeFileSync(path.join(dir, `${sessionID}-${n}.req.json`), JSON.stringify(body))
}

async function runRefinerCli(
  repo: string,
  sessionID: string,
  n: number,
  srv: SdkStub,
  extraEnv: Record<string, string> = {},
): Promise<void> {
  const proc = Bun.spawn(["bun", REFINER_CLI, repo, sessionID, String(n)], {
    stdout: "ignore",
    stderr: "ignore",
    env: {
      ...(process.env as Record<string, string>),
      KKAMAK_GAUGE_SDK_BASE_URL: srv.url,
      KKAMAK_GAUGE_AUTH_TOKEN: "tok-test",
      ...extraEnv,
    },
  })
  await proc.exited
}

// v2: class is now a required parse field (km-gauge v2 extractor, 2026-07-29) —
// the stub model output must carry it or parseRefinerOutput discards it as
// malformed (M0 miss), same as any other refiner-cli.ts caller.
const DERIVATION = { goalSummary: "g", class: "C", criteria: ["c1"], check: "test -f done.txt", confidence: 0.9 }

test("E2E: valid stub output → gauge file written w/ transport 'sdk', req removed", async () => {
  const repo = mkRepo()
  writeReq(repo, "sid-9", 1, "create done.txt", "")
  const srv = stubServerFor(DERIVATION)
  try {
    await runRefinerCli(repo, "sid-9", 1, srv)
  } finally {
    srv.stop()
  }

  const gauge = JSON.parse(
    fs.readFileSync(path.join(gaugeDir(repo), "sid-9-1.json"), "utf-8"),
  )
  expect(gauge.goalSummary).toBe("g")
  expect(gauge.check).toBe("test -f done.txt")
  expect(gauge.sessionID).toBe("sid-9")
  expect(gauge.n).toBe(1)
  // v2: the persisted pending is the run-through-validateDerivation result —
  // v:2 and it carries the validated class (run pre-persist, not raw parse).
  expect(gauge.v).toBe(2)
  expect(gauge.class).toBe("C")
  // §6c provenance: SDK-derived records carry transport "sdk" (absent = cli).
  expect(gauge.transport).toBe("sdk")
  expect(typeof gauge.derivationMs).toBe("number")
  expect(fs.existsSync(path.join(gaugeDir(repo), "sid-9-1.req.json"))).toBe(false)
  // The refiner prompt reached the API and carried structured-output config.
  expect(srv.captured.length).toBe(1)
  const body = srv.captured[0]!.body
  expect(body.model).toBe("claude-haiku-4-5")
  expect((body.output_config as { format: { type: string } }).format.type).toBe("json_schema")
})

// §6d PER-CALLER pin regression test (closes the review finding that
// refiner-cli's transport had no direct coverage): the live derive path
// (this file) MUST stay pinned to "sdk" even under an adversarial
// environment that a batch-run wrapper/tmux launcher/shell profile could
// plausibly export. Two stub servers stand in for the two real endpoints —
// KKAMAK_GAUGE_SDK_BASE_URL (the direct API-SDK path) and ANTHROPIC_BASE_URL
// (what the Agent SDK's spawned CLI would hit if the pin were ever removed)
// — so this test proves routing, not just the stamp: if refiner-cli.ts's
// liveEnv strip is deleted and `callModelSdk` goes back to reading
// `process.env` directly, this adversarial KKAMAK_GAUGE_TRANSPORT
// would flip transport to "agent-sdk", the call would go out over the Agent
// SDK's spawned CLI (hitting agentSrv, not sdkSrv) instead, and EITHER the
// stamp/endpoint assertions below fail directly (if this host has on-disk
// Claude Code credentials for the spawned CLI to use) OR the live derive
// call fails open with no credentials and no gauge file is ever written,
// which fails the final `readFileSync` with ENOENT — the pin's removal
// cannot pass silently either way.
test("PIN (§6d): adversarial KKAMAK_GAUGE_TRANSPORT=agent-sdk does not reroute the live path — stamped 'sdk', API-SDK endpoint hit, agent endpoint untouched", async () => {
  const repo = mkRepo()
  writeReq(repo, "sid-9", 7, "create done.txt", "")
  const sdkSrv = stubServerFor(DERIVATION)
  const agentSrv = stubServer(() => new Response("must not be hit by the live derive path", { status: 500 }))
  // Mutate THIS process's env (not just the spawned child's) to simulate the
  // real threat: a shell profile / tmux launcher / wrapper that exports
  // KKAMAK_GAUGE_TRANSPORT=agent-sdk for batch runs and happens to also be
  // the environment the live Stop hook (and its refiner-cli.ts child) runs
  // in. runRefinerCli spreads `process.env` into the child by default, so
  // this alone is enough to prove inheritance is blocked; ANTHROPIC_BASE_URL
  // is passed via extraEnv since only the child would ever consult it.
  const prevTransport = process.env.KKAMAK_GAUGE_TRANSPORT
  process.env.KKAMAK_GAUGE_TRANSPORT = "agent-sdk"
  try {
    await runRefinerCli(repo, "sid-9", 7, sdkSrv, { ANTHROPIC_BASE_URL: agentSrv.url })
  } finally {
    if (prevTransport === undefined) delete process.env.KKAMAK_GAUGE_TRANSPORT
    else process.env.KKAMAK_GAUGE_TRANSPORT = prevTransport
    sdkSrv.stop()
    agentSrv.stop()
  }

  const gauge = JSON.parse(fs.readFileSync(path.join(gaugeDir(repo), "sid-9-7.json"), "utf-8"))
  // The pin: live derivations always stamp "sdk", regardless of the env.
  expect(gauge.transport).toBe("sdk")
  // The direct API-SDK endpoint got exactly the one call...
  expect(sdkSrv.captured.length).toBe(1)
  expect(sdkSrv.captured[0]!.body.model).toBe("claude-haiku-4-5")
  // ...and the Agent SDK's endpoint was never touched at all.
  expect(agentSrv.captured.length).toBe(0)
})

test("E2E: class C with a path NOT in the prompt → validated down to D pre-persist (downgraded, check null)", async () => {
  const repo = mkRepo()
  // Prompt names no path at all — the stub's check names "done.txt", which
  // validateDerivation cannot find verbatim in the prompt below.
  writeReq(repo, "sid-9", 4, "please finish the task", "")
  const derivation = { goalSummary: "g", class: "C", criteria: ["c1"], check: "test -f done.txt", confidence: 0.9 }
  const srv = stubServerFor(derivation)
  try {
    await runRefinerCli(repo, "sid-9", 4, srv)
  } finally {
    srv.stop()
  }

  const gauge = JSON.parse(fs.readFileSync(path.join(gaugeDir(repo), "sid-9-4.json"), "utf-8"))
  expect(gauge.v).toBe(2)
  expect(gauge.class).toBe("D")
  expect(gauge.check).toBeNull()
  expect(gauge.downgraded?.rule).toBe("path-not-in-prompt")
  expect(gauge.downgraded?.token).toBe("done.txt")
})

test("E2E: stale v1-shaped req (no floorCheck key) still produces a valid v2 pending (floorCheck '' path)", async () => {
  const repo = mkRepo()
  // No 5th arg → writeReq emits the OLD v1 req shape: no floorCheck key at
  // all. refiner-cli.ts must tolerate this (typeof req.floorCheck ===
  // "string" ? it : "") rather than crash or silently drop the request.
  writeReq(repo, "sid-9", 5, "create done.txt")
  const srv = stubServerFor(DERIVATION)
  try {
    await runRefinerCli(repo, "sid-9", 5, srv)
  } finally {
    srv.stop()
  }

  const gauge = JSON.parse(fs.readFileSync(path.join(gaugeDir(repo), "sid-9-5.json"), "utf-8"))
  expect(gauge.v).toBe(2)
  expect(gauge.class).toBe("C")
  expect(gauge.check).toBe("test -f done.txt")
})

test("E2E: garbage stub output → no gauge file, req still cleaned up, exit 0", async () => {
  const repo = mkRepo()
  writeReq(repo, "sid-9", 2, "create done.txt")
  const srv = stubServer(() =>
    Response.json({
      id: "msg_stub",
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5",
      content: [{ type: "text", text: "I refuse to emit JSON" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  )
  try {
    await runRefinerCli(repo, "sid-9", 2, srv)
  } finally {
    srv.stop()
  }

  expect(fs.existsSync(path.join(gaugeDir(repo), "sid-9-2.json"))).toBe(false)
  expect(fs.existsSync(path.join(gaugeDir(repo), "sid-9-2.req.json"))).toBe(false)
})

test("E2E: API error → no gauge file, req cleaned up (fail-open unchanged from CLI spawn failure)", async () => {
  const repo = mkRepo()
  writeReq(repo, "sid-9", 6, "create done.txt", "")
  const srv = stubServer(() => new Response("boom", { status: 500 }))
  try {
    await runRefinerCli(repo, "sid-9", 6, srv)
  } finally {
    srv.stop()
  }

  expect(fs.existsSync(path.join(gaugeDir(repo), "sid-9-6.json"))).toBe(false)
  expect(fs.existsSync(path.join(gaugeDir(repo), "sid-9-6.req.json"))).toBe(false)
})

test("E2E: missing req file → clean no-op", async () => {
  const repo = mkRepo()
  const srv = stubServerFor(DERIVATION)
  try {
    await runRefinerCli(repo, "sid-9", 3, srv)
  } finally {
    srv.stop()
  }
  expect(fs.existsSync(path.join(gaugeDir(repo), "sid-9-3.json"))).toBe(false)
  expect(srv.captured.length).toBe(0)
})
