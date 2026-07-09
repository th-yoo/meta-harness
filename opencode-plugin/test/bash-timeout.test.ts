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

test("composeAgentConfig: most-specific layer wins over a more-general one", () => {
  const general = tmpRoot("general")
  const specific = tmpRoot("specific")

  // both layers have an ACTIVE agent-config, with different values
  const generalCfg: AgentConfig = { schemaVersion: 1, fastTimeoutMs: 1111 }
  const specificCfg: AgentConfig = { schemaVersion: 1, fastTimeoutMs: 2222 }
  writeActive(general, "v1", "general system", "", undefined, generalCfg)
  writeActive(specific, "v1", "specific system", "", undefined, specificCfg)

  // most-specific (later in array) wins
  expect(composeAgentConfig([general, specific])).toEqual(specificCfg)
  expect(composeAgentConfig([general, specific])?.fastTimeoutMs).toBe(2222)

  // order matters: reversed input yields the general one
  expect(composeAgentConfig([specific, general])?.fastTimeoutMs).toBe(1111)
})
