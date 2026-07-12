#!/usr/bin/env bun
/**
 * adapters/claude-code/hook-cli.ts
 *
 * The single Claude Code hook entrypoint: `bun hook-cli.ts <event>` reads the
 * hook JSON on stdin, runs the pure dispatcher (dispatch.ts) against a
 * file-backed EvolutionEngine, prints the dispatcher's stdout payload (if any),
 * and exits 0.
 *
 * PRIME DIRECTIVE — a broken hook must NEVER break a user's normal CC session.
 * EVERYTHING is wrapped so that any failure logs and exits 0 with no output (no
 * injection, no block) — the session then proceeds exactly as if the hook were
 * absent. The only non-zero-effect exit is an INTENTIONAL block emitted as
 * stdout JSON ({"decision":"block",...}) by the dispatcher, which still exits 0
 * (CC reads the block from stdout, not the exit code). Belt-and-suspenders:
 * unhandledRejection/uncaughtException handlers keep a stray async throw
 * (e.g. from a fire-and-forget auto-propose trigger) from crashing the process.
 */

import { EvolutionEngine } from "../../engine.ts"
import { FileSessionStateStore } from "./file-state.ts"
import { ClaudeCodeHost } from "./cc-host.ts"
import { dispatch, type HookInput } from "./dispatch.ts"

// Minimal module-scoped Bun ambient (no `bun-types` dep — see bench/exec.ts).
declare const Bun: {
  stdin: { text(): Promise<string> }
}

// Defense in depth: never let an unhandled async error terminate a hook non-zero.
process.on("unhandledRejection", (reason) => {
  try { process.stderr.write(`[mh-hook] unhandledRejection (swallowed): ${reason}\n`) } catch { /* ignore */ }
})
process.on("uncaughtException", (err) => {
  try { process.stderr.write(`[mh-hook] uncaughtException (swallowed): ${err?.stack ?? err}\n`) } catch { /* ignore */ }
  process.exit(0)
})

async function main(): Promise<void> {
  const event = process.argv[2] ?? ""

  let input: HookInput = {}
  try {
    const raw = await Bun.stdin.text()
    if (raw.trim()) input = JSON.parse(raw) as HookInput
  } catch (e) {
    // Malformed/absent stdin → nothing to do; exit 0 silently.
    try { process.stderr.write(`[mh-hook] unreadable stdin (swallowed): ${e}\n`) } catch { /* ignore */ }
    return
  }

  const host = new ClaudeCodeHost(input.cwd ?? process.cwd())
  const state = new FileSessionStateStore((m) => host.log("warn", m))
  const engine = new EvolutionEngine(host, state)

  const output = await dispatch(event, input, { engine, host, state })
  if (output !== undefined) {
    const json = JSON.stringify(output)
    await new Promise<void>((resolve) => {
      process.stdout.write(json, () => resolve())
    })
  }
}

main()
  .catch((e) => {
    try { process.stderr.write(`[mh-hook] fatal (swallowed): ${e?.stack ?? e}\n`) } catch { /* ignore */ }
  })
  .finally(() => {
    // Explicit exit so a detached fire-and-forget promise (auto-propose) can't
    // hold the process open; all real work is awaited above.
    process.exit(0)
  })
