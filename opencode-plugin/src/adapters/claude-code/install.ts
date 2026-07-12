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
import { migrateAccountRoot } from "../../harness-store.ts"

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

/**
 * ── /mh-* command stubs ──────────────────────────────────────────────────
 *
 * FINDING (live-smoke, claude 2.1.207): CC's slash-command parser rejects an
 * unregistered command like /mh-score with "Unknown command" BEFORE the
 * UserPromptSubmit hook ever fires — the adapter's /^\/mh-/ interception in
 * dispatch.ts never runs. But when a matching command file exists at
 * .claude/commands/mh-<name>.md, CC instead routes the RAW prompt text
 * ("/mh-score good ...") through UserPromptSubmit, where dispatch.ts's
 * matcher blocks + handles it. So these stub files exist purely to make CC
 * accept the slash command syntax at all; the file's *body* is never
 * expanded into a prompt in normal operation (the hook blocks first).
 *
 * One entry per command engine.ts's handleCommand routes on (see
 * src/engine.ts handleCommand + dispatch.ts's mh-score special case).
 */
export const MH_COMMANDS: { name: string; description: string }[] = [
  {
    name: "mh-score",
    description: "Rate the last session: /mh-score good|bad [note]  (accepted: good/bad/1/0/yes/no)",
  },
  {
    name: "mh-propose",
    description: "Trigger a meta-harness proposer. Scope: (none)=project-role, project=project-global, role-global=account-role, account=account-global",
  },
  {
    name: "mh-activate",
    description: "Activate a candidate version: /mh-activate <scope> <vN> [--force]. Account scopes require a winning ab-verdict.json (use --force to override). Scope: role|project|role-global|account",
  },
  {
    name: "mh-promote",
    description: "Promote proven project-layer rules up to the account layer: /mh-promote [global|role]. Creates an inactive account candidate to validate with bun term-bench2/runner.ts ab.",
  },
  {
    name: "mh-curate",
    description: "Consolidate a layer's playbook (merge duplicates, prune net-harmful bullets, enforce budget): /mh-curate [scope]. Output goes through the trial/ab gate.",
  },
  {
    name: "mh-status",
    description: "Show meta-harness per-layer state: active version, scores, in-progress trials, and pending candidate ab-verdicts.",
  },
]

/** The stub file's content: frontmatter description (shown in CC's command
 * picker) + a passthrough body that's a fallback only — see MH_COMMANDS doc
 * comment above for why the body normally never reaches the model. */
function commandStubContent(description: string): string {
  return [
    "---",
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    "mh:passthrough $ARGUMENTS",
    "<!-- Fallback only: UserPromptSubmit intercepts the raw /mh-* prompt text",
    "     before this body would ever be expanded (see dispatch.ts). This line",
    "     only matters if the meta-harness hooks are disabled. -->",
    "",
  ].join("\n")
}

/**
 * Write the six /mh-* command stubs into `commandsDir` (typically
 * <project>/.claude/commands). MERGE semantics mirror computeSettings:
 * never clobber a user's existing file of the same name (skip + warn);
 * re-running with identical content already on disk is a no-op.
 */
export function installCommandStubs(commandsDir: string): { actions: string[] } {
  fs.mkdirSync(commandsDir, { recursive: true })
  const actions: string[] = []

  for (const { name, description } of MH_COMMANDS) {
    const filePath = path.join(commandsDir, `${name}.md`)
    const content = commandStubContent(description)

    if (fs.existsSync(filePath)) {
      const existing = fs.readFileSync(filePath, "utf-8")
      if (existing === content) {
        actions.push(`${name}.md: already installed — skipped`)
      } else {
        actions.push(`${name}.md: existing user file preserved — skipped (WARNING: customized, not overwritten)`)
      }
      continue
    }

    fs.writeFileSync(filePath, content)
    actions.push(`${name}.md: installed`)
  }

  return { actions }
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
  // F2 — CC entrypoint migration. install.ts can be the very first
  // meta-harness process a Claude-Code-only user ever runs (no opencode
  // plugin init to have already called this); run it before anything else
  // could touch accountMetaRoot() and strand an old evolved store at the
  // legacy opencode-owned path. Never blocks install: migrateAccountRoot()
  // already never throws (see harness-store.ts's doc comment).
  migrateAccountRoot()

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

  const commandsDir = path.join(project, ".claude", "commands")
  const { actions: commandActions } = installCommandStubs(commandsDir)

  console.log(`meta-harness Claude Code hooks → ${settingsPath}`)
  console.log(`  hook-cli: ${hookCliPath}`)
  for (const a of actions) console.log(`  ${a}`)
  console.log(`meta-harness Claude Code command stubs → ${commandsDir}`)
  for (const a of commandActions) console.log(`  ${a}`)
}

// Run only when invoked directly (not when imported by tests).
if (import.meta.main) main()
