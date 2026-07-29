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

function writeReq(repo: string, sessionID: string, n: number, prompt: string): void {
  const dir = gaugeDir(repo)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${sessionID}-${n}.req.json`),
    JSON.stringify({ v: 1, sessionID, n, ts: 1, prompt }),
  )
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

test("E2E: valid stub output → gauge file written, req removed, KM_CHILD set in child", async () => {
  const repo = mkRepo()
  writeReq(repo, "sid-9", 1, "create done.txt")
  // Stub proves it received a prompt on stdin and had KM_CHILD=1, then emits the wrapper.
  const bin = stubBin(
    repo,
    `PROMPT=$(cat)
[ -n "$PROMPT" ] || exit 3
[ "$KM_CHILD" = "1" ] || exit 4
echo '${JSON.stringify({ type: "result", result: JSON.stringify(DERIVATION) }).replace(/'/g, `'\\''`)}'`,
  )
  await runRefinerCli(repo, "sid-9", 1, bin)

  const gauge = JSON.parse(
    fs.readFileSync(path.join(gaugeDir(repo), "sid-9-1.json"), "utf-8"),
  )
  expect(gauge.goalSummary).toBe("g")
  expect(gauge.check).toBe("test -f done.txt")
  expect(gauge.sessionID).toBe("sid-9")
  expect(gauge.n).toBe(1)
  expect(gauge.v).toBe(1)
  expect(typeof gauge.derivationMs).toBe("number")
  expect(fs.existsSync(path.join(gaugeDir(repo), "sid-9-1.req.json"))).toBe(false)
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
