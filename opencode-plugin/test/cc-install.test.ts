import { test, expect, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { computeSettings, installCommandStubs, MH_COMMANDS } from "../src/adapters/claude-code/install.ts"

const HOOK = "/abs/path/to/hook-cli.ts"

function ourEvents(settings: any): string[] {
  return Object.keys(settings.hooks ?? {})
}

test("fresh settings: installs all five hooks + MH_ROLE", () => {
  const { settings, actions } = computeSettings({}, { hookCliPath: HOOK, role: "mh-build" })
  expect(ourEvents(settings).sort()).toEqual(
    ["PostToolUse", "PreToolUse", "SessionStart", "Stop", "UserPromptSubmit"].sort(),
  )
  // commands reference the hook-cli path + the event name
  expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(`bun ${HOOK} SessionStart`)
  // PreToolUse carries the Bash matcher; PostToolUse does not (all tools)
  expect(settings.hooks.PreToolUse[0].matcher).toBe("Bash")
  expect(settings.hooks.PostToolUse[0].matcher).toBeUndefined()
  // record-pipeline hooks get 120s headroom; fast tool hooks 30s
  expect(settings.hooks.Stop[0].hooks[0].timeout).toBe(120)
  expect(settings.hooks.UserPromptSubmit[0].hooks[0].timeout).toBe(120)
  expect(settings.hooks.PreToolUse[0].hooks[0].timeout).toBe(30)
  expect(settings.env.MH_ROLE).toBe("mh-build")
  expect(actions.some((a) => a.includes("SessionStart: added"))).toBe(true)
})

test("--role flows through to env.MH_ROLE", () => {
  const { settings } = computeSettings({}, { hookCliPath: HOOK, role: "mh-review" })
  expect(settings.env.MH_ROLE).toBe("mh-review")
})

test("existing unrelated hooks + env are preserved (non-clobbering merge)", () => {
  const existing = {
    env: { SOME_OTHER: "keepme" },
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "/other/tool.sh SessionStart" }] }],
      PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "/other/edit-guard.sh" }] }],
    },
  }
  const { settings } = computeSettings(existing as any, { hookCliPath: HOOK, role: "mh-build" })

  // unrelated env kept
  expect(settings.env.SOME_OTHER).toBe("keepme")
  expect(settings.env.MH_ROLE).toBe("mh-build")
  // the other SessionStart hook survives; ours is appended alongside
  expect(settings.hooks.SessionStart.length).toBe(2)
  expect(settings.hooks.SessionStart[0].hooks[0].command).toBe("/other/tool.sh SessionStart")
  expect(settings.hooks.SessionStart[1].hooks[0].command).toBe(`bun ${HOOK} SessionStart`)
  // the other PreToolUse(Edit) guard survives; ours (Bash) is a separate group
  expect(settings.hooks.PreToolUse.length).toBe(2)
  expect(settings.hooks.PreToolUse.find((g: any) => g.matcher === "Edit")).toBeTruthy()
  expect(settings.hooks.PreToolUse.find((g: any) => g.matcher === "Bash")).toBeTruthy()
})

test("existing MH_ROLE is kept, not overwritten", () => {
  const { settings, actions } = computeSettings(
    { env: { MH_ROLE: "mh-debug" } } as any,
    { hookCliPath: HOOK, role: "mh-build" },
  )
  expect(settings.env.MH_ROLE).toBe("mh-debug")
  expect(actions.some((a) => a.includes("kept existing"))).toBe(true)
})

test("idempotent: a second run adds nothing and does not duplicate", () => {
  const once = computeSettings({}, { hookCliPath: HOOK, role: "mh-build" })
  const twice = computeSettings(once.settings, { hookCliPath: HOOK, role: "mh-build" })
  // no group grew
  for (const ev of ourEvents(twice.settings)) {
    expect(twice.settings.hooks[ev].length).toBe(once.settings.hooks[ev].length)
  }
  expect(twice.actions.every((a) => a.includes("already installed") || a.includes("kept existing"))).toBe(true)
})

test("does not mutate the input object", () => {
  const existing = { env: {}, hooks: {} }
  const snapshot = JSON.stringify(existing)
  computeSettings(existing as any, { hookCliPath: HOOK, role: "mh-build" })
  expect(JSON.stringify(existing)).toBe(snapshot)
})

// ── installCommandStubs: .claude/commands/mh-*.md stubs ────────────────────
//
// FINDING (live-smoke, claude 2.1.207): CC's slash-command parser rejects
// /mh-* prompts with "Unknown command" BEFORE UserPromptSubmit fires, unless
// a matching command file exists at .claude/commands/mh-<name>.md — then CC
// routes the raw prompt text through the hook, where the existing /^\/mh-/
// matcher intercepts it. These stubs exist to make CC accept the slash
// command at all; their body is never expanded (see dispatch.ts).

let cmdsDir: string

afterEach(() => {
  if (cmdsDir) fs.rmSync(path.dirname(cmdsDir), { recursive: true, force: true })
})

function freshCommandsDir(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mh-cc-install-"))
  cmdsDir = path.join(tmp, ".claude", "commands")
  return cmdsDir
}

test("MH_COMMANDS covers all six engine-routed /mh-* commands", () => {
  expect(MH_COMMANDS.map((c) => c.name).sort()).toEqual(
    ["mh-activate", "mh-curate", "mh-promote", "mh-propose", "mh-score", "mh-status"].sort(),
  )
  for (const c of MH_COMMANDS) expect(c.description.length).toBeGreaterThan(0)
})

test("fresh install writes all six stubs with frontmatter", () => {
  const dir = freshCommandsDir()
  const { actions } = installCommandStubs(dir)
  expect(fs.readdirSync(dir).sort()).toEqual(MH_COMMANDS.map((c) => `${c.name}.md`).sort())
  for (const c of MH_COMMANDS) {
    const body = fs.readFileSync(path.join(dir, `${c.name}.md`), "utf-8")
    expect(body.startsWith("---\n")).toBe(true)
    expect(body).toContain(`description: ${JSON.stringify(c.description)}`)
    expect(body).toContain("$ARGUMENTS")
    expect(actions.some((a) => a.includes(c.name) && a.includes("installed"))).toBe(true)
  }
})

test("existing user file with the same name is preserved and a warning is emitted", () => {
  const dir = freshCommandsDir()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "mh-score.md"), "---\ndescription: my custom score command\n---\ncustom body\n")
  const { actions } = installCommandStubs(dir)

  expect(fs.readFileSync(path.join(dir, "mh-score.md"), "utf-8")).toBe(
    "---\ndescription: my custom score command\n---\ncustom body\n",
  )
  expect(actions.some((a) => a.includes("mh-score") && /preserved|skip/i.test(a))).toBe(true)
  // the other five still get installed
  expect(fs.readdirSync(dir).length).toBe(MH_COMMANDS.length)
})

test("idempotent: a second run reports no-op and does not rewrite files", () => {
  const dir = freshCommandsDir()
  installCommandStubs(dir)
  const before = MH_COMMANDS.map((c) => fs.statSync(path.join(dir, `${c.name}.md`)).mtimeMs)
  const { actions } = installCommandStubs(dir)
  const after = MH_COMMANDS.map((c) => fs.statSync(path.join(dir, `${c.name}.md`)).mtimeMs)
  expect(after).toEqual(before)
  for (const c of MH_COMMANDS) {
    expect(actions.some((a) => a.includes(c.name) && /already|no-op|unchanged/i.test(a))).toBe(true)
  }
})
