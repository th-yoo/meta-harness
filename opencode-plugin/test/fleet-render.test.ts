import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { renderRole, parseStamp, harnessHashOf } from "../src/fleet/render.ts"
import { writeSquadDefV1, STANDARD_SQUAD } from "../src/fleet/squad-def.ts"
import { accountGlobalRoot, accountRoleRoot, createCandidate, writeActive } from "../src/harness-store.ts"

// seed analyzer account-role v1 whose body teaches the wire format (shared
// across tests so the frontmatter-covering test below can recompute the
// exact hash renderRole produced without re-deriving the body from disk).
const ANALYZER_BODY = "You are the analyzer.\nEmit `## Use Cases` and `## Functional Spec`; escalate with `## Clarify`."

let home: string, project: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mh-render-home-"))
  project = mkdtempSync(join(tmpdir(), "mh-render-proj-"))
  process.env.META_HARNESS_HOME = home
  writeSquadDefV1(STANDARD_SQUAD)
  const root = accountRoleRoot("mh-analyzer")
  createCandidate(root, "v1", ANALYZER_BODY)
  writeActive(root, "v1", ANALYZER_BODY, null, null, null, null)
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

  test("harnessHashOf covers frontmatter, not just body: identical body, different role → different hash", () => {
    // analyzer (read-only permission, haiku model) vs. implementer (allow-all
    // permission, sonnet model) — frontmatter differs, body is byte-identical.
    // A body-only hash would collide here; the fix must not.
    expect(harnessHashOf("analyzer", ANALYZER_BODY)).not.toBe(harnessHashOf("implementer", ANALYZER_BODY))
    // and it must also differ from the OLD (pre-fix) body-only formula, so a
    // stamp produced before this fix is correctly treated as not matching.
    const bodyOnlyHash = createHash("sha256").update(ANALYZER_BODY).digest("hex").slice(0, 16)
    expect(harnessHashOf("analyzer", ANALYZER_BODY)).not.toBe(bodyOnlyHash)
  })

  test("stamp whose hash predates frontmatter-coverage is treated as stale and gets rewritten", () => {
    // Render once for real, then hand-craft a stamp that looks like it came
    // from the OLD (body-only) hash formula — standing in for "roles.ts
    // permission changed since this file was last rendered" without needing
    // to actually mutate the static roles.ts manifest at runtime.
    const { path, stamp } = renderRole(project, "analyzer")
    const fresh = readFileSync(path, "utf-8")
    const staleHash = createHash("sha256").update(ANALYZER_BODY).digest("hex").slice(0, 16)
    expect(staleHash).not.toBe(stamp.harnessHash) // sanity: the two formulas really do disagree
    writeFileSync(path, fresh.replace(stamp.harnessHash, staleHash))

    const second = renderRole(project, "analyzer")
    // Recomputed to the correct, frontmatter-covering hash — NOT short-circuited
    // to (nor left carrying on disk) the frontmatter-blind stale one.
    expect(second.stamp.harnessHash).toBe(stamp.harnessHash)
    expect(second.stamp.harnessHash).not.toBe(staleHash)
    const rewritten = readFileSync(path, "utf-8")
    expect(parseStamp(rewritten)?.harnessHash).toBe(stamp.harnessHash)
  })

  // ── generality-tag routing (Task 4, generality-routing plan) ─────────────
  // ALL FLEET_ROLES use anthropic/* (fleet/roles.ts) — there is no non-anthropic
  // role, so route by CONTRASTING two vendor bullets on ONE renderRole call
  // instead of two roles. Seeds the GLOBAL (account) layer's active playbook
  // — hermetic via this file's existing META_HARNESS_HOME redirect (beforeEach).
  test("renderRole routes the persona by the role's fixed model", () => {
    const root = accountGlobalRoot()
    const pb = {
      schemaVersion: 1 as const,
      nextId: 4,
      bullets: [
        { id: "b1", text: "U", helpful: 0, harmful: 0, addedBy: "t", status: "active" as const, createdAt: "t", updatedAt: "t" },
        { id: "b2", text: "VA", helpful: 0, harmful: 0, addedBy: "t", status: "active" as const, createdAt: "t", updatedAt: "t", generality: "vendor" as const, slice: "anthropic" },
        { id: "b3", text: "VO", helpful: 0, harmful: 0, addedBy: "t", status: "active" as const, createdAt: "t", updatedAt: "t", generality: "vendor" as const, slice: "openai" },
      ],
    }
    const flat = "- U\n- VA\n- VO\n"
    createCandidate(root, "v1", flat, "", pb)
    writeActive(root, "v1", flat, "", pb)

    // analyzer's fixed model is anthropic/* (fleet/roles.ts) — its account-role
    // layer (seeded in beforeEach) still teaches the wire headings, so no --force needed.
    const { path } = renderRole(project, "analyzer")
    const roleBody = readFileSync(path, "utf-8")
    expect(roleBody).toContain("- VA")
    expect(roleBody).toContain("- U")
    expect(roleBody).not.toContain("- VO")
  })
})
