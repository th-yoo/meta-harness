import { unsafeReason } from "../../minimal/guard.ts"

const MAX_TIMEOUT_MS = 600_000
const STORE_PATH_RE = /(^|[\s'"/])(\.kkamak|\.km|term-bench2\/store)([\s'"/]|$)/
const NETWORK_RE = /\b(curl|wget|nc|ssh|scp|git\s+(clone|fetch|pull|push))\b/
const PKG_RE = /\b(apt(-get)?|pip3?|npm|bun\s+add|brew)\s+(install|add)\b/
const DESTRUCTIVE_OUT_RE = /\brm\s+(-[a-z]*r[a-z]*f?|-[a-z]*f[a-z]*r)\b|\brm\s+.*\.\.\//
const BACKTICK_RE = /`/

export function screenCheck(check: { cmd: string; timeoutMs: number }): {
  tier: "rejected" | "bench" | "live"
  reason?: string
} {
  const cmd = check.cmd.trim()
  if (!cmd) return { tier: "rejected", reason: "empty" }
  if (!(check.timeoutMs > 0 && check.timeoutMs <= MAX_TIMEOUT_MS)) return { tier: "rejected", reason: "timeout-bounds" }
  if (STORE_PATH_RE.test(cmd)) return { tier: "rejected", reason: "store-path" }
  if (NETWORK_RE.test(cmd)) return { tier: "rejected", reason: "network" }
  if (PKG_RE.test(cmd)) return { tier: "rejected", reason: "package-install" }
  if (DESTRUCTIVE_OUT_RE.test(cmd)) return { tier: "rejected", reason: "destructive" }
  if (BACKTICK_RE.test(cmd)) return { tier: "rejected", reason: "substitution" }
  return unsafeReason(cmd) === undefined ? { tier: "live" } : { tier: "bench" }
}
