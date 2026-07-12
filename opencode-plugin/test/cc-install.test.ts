import { test, expect } from "bun:test"
import { computeSettings } from "../src/adapters/claude-code/install.ts"

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
