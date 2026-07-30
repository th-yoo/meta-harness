import { test, expect } from "bun:test"
import { readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { EDIT_TOOLS } from "../src/types.ts"

const pluginRoot = dirname(import.meta.dir)
const pluginJsonPath = join(pluginRoot, ".claude-plugin/plugin.json")
const packageJsonPath = join(pluginRoot, "package.json")
const hooksJsonPath = join(pluginRoot, "hooks/hooks.json")

function parseJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"))
}

test("plugin.json parses as JSON", () => {
  expect(() => parseJson(pluginJsonPath)).not.toThrow()
})

test("hooks.json parses as JSON", () => {
  expect(() => parseJson(hooksJsonPath)).not.toThrow()
})

test("plugin.json has name, version, description", () => {
  const p = parseJson(pluginJsonPath) as Record<string, unknown>
  expect(p.name).toBe("kkamak")
  expect(typeof p.version).toBe("string")
  expect(typeof p.description).toBe("string")
  expect((p.description as string).length).toBeGreaterThan(0)
})

test("plugin.json version === package.json version (parity)", () => {
  const plugin = parseJson(pluginJsonPath) as Record<string, unknown>
  const pkg = parseJson(packageJsonPath) as Record<string, unknown>
  expect(plugin.version).toBe(pkg.version)
})

interface HookEntry {
  type: string
  command: string
  timeout: number
}

interface HookBlock {
  matcher?: string
  hooks: HookEntry[]
}

interface HooksJson {
  hooks: Record<string, HookBlock[]>
}

function allHookEntries(h: HooksJson): { event: string; block: HookBlock; entry: HookEntry }[] {
  const out: { event: string; block: HookBlock; entry: HookEntry }[] = []
  for (const [event, blocks] of Object.entries(h.hooks)) {
    for (const block of blocks) {
      for (const entry of block.hooks) {
        out.push({ event, block, entry })
      }
    }
  }
  return out
}

test("every hook command references src/hook-cli.ts, and that file exists on disk", () => {
  const h = parseJson(hooksJsonPath) as HooksJson
  const entries = allHookEntries(h)
  expect(entries.length).toBeGreaterThan(0)

  const hookCliPath = join(pluginRoot, "src/hook-cli.ts")
  expect(existsSync(hookCliPath)).toBe(true)

  for (const { entry } of entries) {
    expect(entry.command).toContain("src/hook-cli.ts")
  }
})

test("PostToolUse matcher === EDIT_TOOLS.join(\"|\") (single-source assertion)", () => {
  const h = parseJson(hooksJsonPath) as HooksJson
  const postToolUseBlocks = h.hooks.PostToolUse
  expect(postToolUseBlocks).toBeDefined()
  for (const block of postToolUseBlocks!) {
    expect(block.matcher).toBe(EDIT_TOOLS.join("|"))
  }
})

test("Stop timeout is 600; PostToolUse and UserPromptSubmit timeouts are 30", () => {
  const h = parseJson(hooksJsonPath) as HooksJson
  for (const { event, entry } of allHookEntries(h)) {
    if (event === "Stop") {
      expect(entry.timeout).toBe(600)
    } else {
      expect(entry.timeout).toBe(30)
    }
  }
})
