#!/usr/bin/env bun
/**
 * adapters/claude-code/install.ts
 *
 * `bun install.ts [--project <dir>] [--role <mh-role>]` — wire the meta-harness
 * hook-cli into a project's Claude Code `.claude/settings.json`. It writes the
 * five hook entries (SessionStart, UserPromptSubmit, PreToolUse[Bash],
 * PostToolUse, Stop), each invoking `bun <abs hook-cli.ts> <event>`, plus an
 * `env.MH_ROLE` declaring the session's role.
 *
 * MERGE semantics (idempotent, non-clobbering): existing unrelated hooks and
 * env vars are preserved; our own entries are detected (by command referencing
 * this hook-cli path) and never duplicated on re-run; an existing MH_ROLE is
 * kept, not overwritten. The pure `computeSettings` does the merge (unit-tested
 * against fresh / existing-unrelated / idempotent-rerun cases); `main` only does
 * path resolution + read/write + a summary print.
 *
 * Hooks GET stdin (the event JSON) — the command is NOT `< /dev/null` redirected.
 * Per-hook timeouts: the hooks that run the record/scoring pipeline or the
 * env-snapshot probes (SessionStart, UserPromptSubmit — which runs sessionIdle
 * for /mh-score, Stop) get generous headroom (120s); the fast tool hooks get 30s.
 */

import fs from "node:fs"
import path from "node:path"

interface HookEntry { type: "command"; command: string; timeout?: number }
interface HookGroup { matcher?: string; hooks: HookEntry[] }
interface CcSettings { env?: Record<string, unknown>; hooks?: Record<string, HookGroup[]>; [k: string]: unknown }

/** Events we install, with their CC matcher (if any) and per-hook timeout(s). */
const HOOK_SPECS: { event: string; matcher?: string; timeout: number }[] = [
  { event: "SessionStart", timeout: 120 },
  { event: "UserPromptSubmit", timeout: 120 }, // runs sessionIdle for /mh-score
  { event: "PreToolUse", matcher: "Bash", timeout: 30 },
  { event: "PostToolUse", timeout: 30 }, // no matcher → capture ALL tools
  { event: "Stop", timeout: 120 },
]

const DEFAULT_ROLE = "mh-build"

function hookCommand(hookCliPath: string, event: string): string {
  return `bun ${hookCliPath} ${event}`
}

/**
 * Pure merge: given the existing settings object (or {}), return the new settings
 * plus a human-readable list of what changed. Never mutates `existing`.
 */
export function computeSettings(
  existing: CcSettings,
  opts: { hookCliPath: string; role: string },
): { settings: CcSettings; actions: string[] } {
  const { hookCliPath, role } = opts
  const settings: CcSettings = JSON.parse(JSON.stringify(existing ?? {}))
  settings.hooks ??= {}
  settings.env ??= {}
  const actions: string[] = []

  for (const spec of HOOK_SPECS) {
    const groups = (settings.hooks[spec.event] ??= [])
    // Ours iff any entry's command references this hook-cli path for this event.
    const present = groups.some((g) =>
      (g.hooks ?? []).some(
        (h) => typeof h.command === "string" && h.command.includes(hookCliPath) && h.command.trimEnd().endsWith(spec.event),
      ),
    )
    if (present) {
      actions.push(`${spec.event}: already installed — skipped`)
      continue
    }
    const entry: HookEntry = { type: "command", command: hookCommand(hookCliPath, spec.event), timeout: spec.timeout }
    groups.push({ ...(spec.matcher ? { matcher: spec.matcher } : {}), hooks: [entry] })
    actions.push(`${spec.event}: added${spec.matcher ? ` (matcher ${spec.matcher})` : ""}`)
  }

  if (typeof settings.env["MH_ROLE"] === "string" && settings.env["MH_ROLE"]) {
    actions.push(`env.MH_ROLE: kept existing (${settings.env["MH_ROLE"]})`)
  } else {
    settings.env["MH_ROLE"] = role
    actions.push(`env.MH_ROLE: set to ${role}`)
  }

  return { settings, actions }
}

/** Resolve the absolute hook-cli.ts path next to this module (tsc-safe: no
 * import.meta.dir, which is Bun-only/untyped — see bench/paths.ts). */
export function resolveHookCliPath(): string {
  const here = path.dirname(new URL(import.meta.url).pathname)
  return path.join(here, "hook-cli.ts")
}

function parseArgs(argv: string[]): { project: string; role: string } {
  let project = process.cwd()
  let role = DEFAULT_ROLE
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--project") project = path.resolve(argv[++i] ?? project)
    else if (argv[i] === "--role") role = argv[++i] ?? role
  }
  return { project, role }
}

function main(): void {
  const { project, role } = parseArgs(process.argv.slice(2))
  const hookCliPath = resolveHookCliPath()
  const settingsPath = path.join(project, ".claude", "settings.json")

  let existing: CcSettings = {}
  if (fs.existsSync(settingsPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(settingsPath, "utf-8"))
    } catch {
      console.error(`refusing to clobber unparseable ${settingsPath} — fix or remove it, then re-run`)
      process.exit(1)
    }
  }

  const { settings, actions } = computeSettings(existing, { hookCliPath, role })
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n")

  console.log(`meta-harness Claude Code hooks → ${settingsPath}`)
  console.log(`  hook-cli: ${hookCliPath}`)
  for (const a of actions) console.log(`  ${a}`)
}

// Run only when invoked directly (not when imported by tests).
if (import.meta.main) main()
