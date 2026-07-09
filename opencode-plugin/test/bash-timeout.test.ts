import { test, expect } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { adjustedTimeout } from "../src/bash-timeout.ts"
import { composeAgentConfig, writeActive, type AgentConfig } from "../src/harness-store.ts"

// ── adjustedTimeout: no-cfg behavior is byte-identical to pre-B2 ───────────

test("adjustedTimeout: no cfg — fast command capped at default 5000ms", () => {
  expect(adjustedTimeout("ls")).toBe(5000)
})

test("adjustedTimeout: no cfg — slow command left alone", () => {
  expect(adjustedTimeout("make")).toBeUndefined()
})

// ── adjustedTimeout: cfg knobs ─────────────────────────────────────────────

test("adjustedTimeout: cfg.fastTimeoutMs overrides the default cap", () => {
  const cfg: AgentConfig = { schemaVersion: 1, fastTimeoutMs: 2000 }
  expect(adjustedTimeout("ls -la", undefined, cfg)).toBe(2000)
})

test("adjustedTimeout: cfg.extraFastCommands extends the fast set", () => {
  const cfg: AgentConfig = { schemaVersion: 1, extraFastCommands: ["mytool"] }
  expect(adjustedTimeout("mytool x", undefined, cfg)).toBe(5000)
})

test("adjustedTimeout: cfg.extraSlowCommands wins over the built-in fast set", () => {
  const cfg: AgentConfig = { schemaVersion: 1, extraSlowCommands: ["ls"] }
  expect(adjustedTimeout("ls", undefined, cfg)).toBeUndefined()
})

test("adjustedTimeout: cfg.extraSlowCommands wins over cfg.extraFastCommands on conflict", () => {
  const cfg: AgentConfig = {
    schemaVersion: 1,
    extraFastCommands: ["mytool"],
    extraSlowCommands: ["mytool"],
  }
  expect(adjustedTimeout("mytool", undefined, cfg)).toBeUndefined()
})

test("adjustedTimeout: null cfg behaves like no cfg", () => {
  expect(adjustedTimeout("ls", undefined, null)).toBe(5000)
})

// ── composeAgentConfig: most-specific layer wins (closes a B1 test gap) ────

function tmpRoot(name: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `mh-compose-${name}-`))
  fs.mkdirSync(tmp, { recursive: true })
  return tmp
}

test("composeAgentConfig: most-specific layer with an active config wins", () => {
  const general = tmpRoot("general")
  const specific = tmpRoot("specific")

  const specificCfg: AgentConfig = { schemaVersion: 1, fastTimeoutMs: 3000 }
  writeActive(specific, "v1", "specific system", "", null, specificCfg)

  expect(composeAgentConfig([general, specific])).toEqual(specificCfg)
})
