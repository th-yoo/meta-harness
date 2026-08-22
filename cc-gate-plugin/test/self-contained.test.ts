// The plugin is INSTALLED by copying its directory out of this monorepo
// (claude plugin install → ~/.claude/plugins/cache/…). Any import that
// escapes the plugin root resolves in the repo and dies in the install —
// and the hook's fail-open contract turns that death into SILENCE: exit 0,
// gate inert, zero sensor data, no error the user ever sees.
//
// Live proof (2026-07-28): the first local install failed exactly this way
// ("Cannot find module '../../../minimal/session2.ts'").
import { test, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const PLUGIN_ROOT = path.join(import.meta.dir, "..")

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...sourceFiles(p))
    else if (e.name.endsWith(".ts")) out.push(p)
  }
  return out
}

test("no src/ or hooks/ file imports anything outside the plugin root", () => {
  const offenders: string[] = []
  for (const file of sourceFiles(path.join(PLUGIN_ROOT, "src"))) {
    const src = fs.readFileSync(file, "utf-8")
    for (const m of src.matchAll(/from\s+"([^"]+)"|import\("([^"]+)"\)/g)) {
      const spec = m[1] ?? m[2]!
      if (!spec.startsWith(".")) continue // bare package specifier
      const resolved = path.resolve(path.dirname(file), spec)
      if (!resolved.startsWith(PLUGIN_ROOT + path.sep)) {
        offenders.push(`${path.relative(PLUGIN_ROOT, file)} → ${spec}`)
      }
    }
  }
  expect(offenders).toEqual([])
})

test("vendored copies are byte-identical to the minimal/ originals (drift guard)", () => {
  // Only meaningful inside the monorepo; an installed copy has no minimal/.
  const minimalDir = path.join(PLUGIN_ROOT, "..", "minimal")
  if (!fs.existsSync(minimalDir)) return

  for (const name of ["complete-gate.ts", "session2.ts", "mutate.ts", "spec-probe.ts"]) {
    const vendored = path.join(PLUGIN_ROOT, "vendor", name)
    expect(fs.existsSync(vendored)).toBe(true)
    expect(fs.readFileSync(vendored, "utf-8")).toBe(
      fs.readFileSync(path.join(minimalDir, name), "utf-8"),
    )
  }
})

test("INSTALL SHAPE: hook-cli runs from a copy outside the monorepo", async () => {
  // Reproduces `claude plugin install` — copy the plugin elsewhere, then
  // drive a real gated Stop through it.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "km-install-"))
  const pluginCopy = path.join(tmp, "plugin")
  fs.cpSync(PLUGIN_ROOT, pluginCopy, {
    recursive: true,
    filter: (src) => !src.includes("node_modules"),
  })

  const repo = path.join(tmp, "repo")
  fs.mkdirSync(repo)
  fs.writeFileSync(path.join(repo, "gate.json"), JSON.stringify({ check: "true", rounds: 2 }))
  fs.mkdirSync(path.join(repo, ".km", "cc-gate"), { recursive: true })
  fs.writeFileSync(
    path.join(repo, ".km", "cc-gate", "install-sid.json"),
    JSON.stringify({
      v: 1, edited: true, gating: false, round: 0, outcomes: [],
      cycleStartedAt: 0, failStreak: 0, updatedAt: Date.now(),
    }),
  )

  const proc = Bun.spawn(["bun", path.join(pluginCopy, "src", "hook-cli.ts"), "Stop"], {
    stdin: new TextEncoder().encode(JSON.stringify({ session_id: "install-sid", cwd: repo })),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stderr] = await Promise.all([
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ])

  expect(stderr).not.toContain("Cannot find module")
  // The gate actually ran: a sensor line exists for the accepted check.
  const sensor = path.join(repo, ".km", "gate-outcomes.ndjson")
  expect(fs.existsSync(sensor)).toBe(true)
  const line = JSON.parse(fs.readFileSync(sensor, "utf-8").trim())
  expect(line.accepted).toBe(true)
  expect(line.rounds).toEqual(["accepted"])
  // 30s, not the 5s default: this test does a recursive plugin copy plus a
  // cold bun subprocess — measured 5.11s on a loaded host (2026-08-22, two
  // concurrent suites), i.e. the default bar fails on load, not on defect.
  // Loosest-envelope rule: a timeout that can fire on contention produces
  // fake failure evidence.
}, 30_000)
