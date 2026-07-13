import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { renderRole, parseStamp } from "../src/fleet/render.ts"
import { writeSquadDefV1, STANDARD_SQUAD } from "../src/fleet/squad-def.ts"
import { accountRoleRoot, createCandidate, writeActive } from "../src/harness-store.ts"

let home: string, project: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mh-render-home-"))
  project = mkdtempSync(join(tmpdir(), "mh-render-proj-"))
  process.env.META_HARNESS_HOME = home
  writeSquadDefV1(STANDARD_SQUAD)
  // seed analyzer account-role v1 whose body teaches the wire format
  const body = "You are the analyzer.\nEmit `## Use Cases` and `## Functional Spec`; escalate with `## Clarify`."
  const root = accountRoleRoot("mh-analyzer")
  createCandidate(root, "v1", body)
  writeActive(root, "v1", body, null, null, null, null)
})
afterEach(() => {
  delete process.env.META_HARNESS_HOME
  rmSync(home, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
})

describe("renderRole", () => {
  test("writes frontmatter + stamp + body; stamp round-trips; idempotent", () => {
    const { path, stamp } = renderRole(project, "analyzer")
    const md = readFileSync(path, "utf-8")
    expect(md).toStartWith("---\n")
    expect(md).toContain("bash: deny")
    expect(md).not.toContain("shell:")
    expect(md).toContain("You are the analyzer.")
    expect(parseStamp(md)).toEqual(stamp)
    const second = renderRole(project, "analyzer")
    expect(readFileSync(second.path, "utf-8")).toBe(md) // same stamp inputs → byte-identical body+frontmatter (renderedAt excluded from idempotence: freeze it via stamp.versions comparison)
  })

  test("render lint refuses a body that never mentions the wire headings; --force overrides", () => {
    const root = accountRoleRoot("mh-designer")
    createCandidate(root, "v1", "You design things. No format promised.")
    writeActive(root, "v1", "You design things. No format promised.", null, null, null, null)
    expect(() => renderRole(project, "designer")).toThrow(/wire/)
    expect(() => renderRole(project, "designer", { force: true })).not.toThrow()
  })
})
