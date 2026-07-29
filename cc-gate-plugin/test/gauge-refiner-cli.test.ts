import { test, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { extractResultText } from "../src/gauge/refiner-cli.ts"
import { gaugeDir } from "../src/gauge/files.ts"

const REFINER_CLI = path.join(import.meta.dir, "..", "src", "gauge", "refiner-cli.ts")

// --- extractResultText (claude -p --output-format json wrapper) ---

test("extractResultText pulls .result from the CLI wrapper", () => {
  const wrapper = JSON.stringify({ type: "result", result: "the text", total_cost_usd: 0.001 })
  expect(extractResultText(wrapper)).toBe("the text")
})

test("extractResultText → undefined on raw text / missing result / bad JSON", () => {
  expect(extractResultText("just plain text")).toBeUndefined()
  expect(extractResultText(JSON.stringify({ type: "result" }))).toBeUndefined()
  expect(extractResultText("{broken")).toBeUndefined()
})

// --- E2E against a stub claude bin ---

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

function stubBin(repo: string, script: string): string {
  const p = path.join(repo, "stub-claude")
  fs.writeFileSync(p, `#!/usr/bin/env bash\n${script}\n`)
  fs.chmodSync(p, 0o755)
  return p
}

async function runRefinerCli(repo: string, sessionID: string, n: number, bin: string): Promise<void> {
  const proc = Bun.spawn(["bun", REFINER_CLI, repo, sessionID, String(n)], {
    stdout: "ignore",
    stderr: "ignore",
    env: { ...(process.env as Record<string, string>), KKAMAK_GAUGE_CLAUDE_BIN: bin },
  })
  await proc.exited
}

// v2: class is now a required parse field (km-gauge v2 extractor, 2026-07-29) —
// the stub model output must carry it or parseRefinerOutput discards it as
// malformed (M0 miss), same as any other refiner-cli.ts caller.
const DERIVATION = { goalSummary: "g", class: "C", criteria: ["c1"], check: "test -f done.txt", confidence: 0.9 }

function stubBinFor(repo: string, derivation: unknown): string {
  return stubBin(
    repo,
    `PROMPT=$(cat)
[ -n "$PROMPT" ] || exit 3
[ "$KM_CHILD" = "1" ] || exit 4
echo '${JSON.stringify({ type: "result", result: JSON.stringify(derivation) }).replace(/'/g, `'\\''`)}'`,
  )
}

test("E2E: valid stub output → gauge file written, req removed, KM_CHILD set in child", async () => {
  const repo = mkRepo()
  writeReq(repo, "sid-9", 1, "create done.txt", "")
  // Stub proves it received a prompt on stdin and had KM_CHILD=1, then emits the wrapper.
  const bin = stubBinFor(repo, DERIVATION)
  await runRefinerCli(repo, "sid-9", 1, bin)

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
  expect(typeof gauge.derivationMs).toBe("number")
  expect(fs.existsSync(path.join(gaugeDir(repo), "sid-9-1.req.json"))).toBe(false)
})

test("E2E: class C with a path NOT in the prompt → validated down to D pre-persist (downgraded, check null)", async () => {
  const repo = mkRepo()
  // Prompt names no path at all — the stub's check names "done.txt", which
  // validateDerivation cannot find verbatim in the prompt below.
  writeReq(repo, "sid-9", 4, "please finish the task", "")
  const derivation = { goalSummary: "g", class: "C", criteria: ["c1"], check: "test -f done.txt", confidence: 0.9 }
  const bin = stubBinFor(repo, derivation)
  await runRefinerCli(repo, "sid-9", 4, bin)

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
  const bin = stubBinFor(repo, DERIVATION)
  await runRefinerCli(repo, "sid-9", 5, bin)

  const gauge = JSON.parse(fs.readFileSync(path.join(gaugeDir(repo), "sid-9-5.json"), "utf-8"))
  expect(gauge.v).toBe(2)
  expect(gauge.class).toBe("C")
  expect(gauge.check).toBe("test -f done.txt")
})

test("E2E: garbage stub output → no gauge file, req still cleaned up, exit 0", async () => {
  const repo = mkRepo()
  writeReq(repo, "sid-9", 2, "create done.txt")
  const bin = stubBin(repo, `cat >/dev/null; echo "I refuse to emit JSON"`)
  await runRefinerCli(repo, "sid-9", 2, bin)

  expect(fs.existsSync(path.join(gaugeDir(repo), "sid-9-2.json"))).toBe(false)
  expect(fs.existsSync(path.join(gaugeDir(repo), "sid-9-2.req.json"))).toBe(false)
})

test("E2E: missing req file → clean no-op", async () => {
  const repo = mkRepo()
  const bin = stubBin(repo, `cat >/dev/null; echo nope`)
  await runRefinerCli(repo, "sid-9", 3, bin)
  expect(fs.existsSync(path.join(gaugeDir(repo), "sid-9-3.json"))).toBe(false)
})
