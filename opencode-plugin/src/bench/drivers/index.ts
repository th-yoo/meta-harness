/**
 * drivers/index.ts — the driver registry.
 *
 * One place callers (cmd-run.ts, cmd-ab.ts, etc — none of which are touched
 * in this step) will eventually go from a config-selected driver id to an
 * AgentDriver instance. Only "opencode" exists today; task-B1-brief.md's
 * later steps add claude-code / codex here.
 */
import { die } from "../util.ts"
import { opencodeDriver } from "./opencode.ts"
import type { AgentDriver } from "./types.ts"

export const DRIVER_IDS = ["opencode"] as const

export function getDriver(id: string): AgentDriver {
  if (id === "opencode") return opencodeDriver
  return die(`getDriver: unknown agent driver id "${id}" (expected one of ${DRIVER_IDS.join(", ")})`)
}
