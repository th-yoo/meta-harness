import { describe, expect, test } from "bun:test"
import { renderPlaybookRouted, matchesModel, renderPlaybook, accountGlobalRoot, type Playbook } from "../src/harness-store.ts"
import { composeHarness, renderSystemBlocks } from "../src/compose.ts"
import { assembleAgentsMd } from "../src/bench/record.ts"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const pb = (bs: Array<Partial<{ id: string; text: string; generality: string; slice: string; status: string }>>): Playbook =>
  ({ schemaVersion: 1, nextId: bs.length + 1,
     bullets: bs.map((b, i) => ({
       id: b.id ?? `b${i + 1}`, text: b.text ?? `t${i + 1}`, helpful: 0, harmful: 0,
       addedBy: "test", status: (b.status as any) ?? "active", createdAt: "t", updatedAt: "t",
       ...(b.generality ? { generality: b.generality as any } : {}),
       ...(b.slice ? { slice: b.slice } : {}),
     })) })

describe("matchesModel", () => {
  test("universal / untagged always match", () => {
    expect(matchesModel(pb([{ generality: "universal" }]).bullets[0], "anthropic/x")).toBe(true)
    expect(matchesModel(pb([{}]).bullets[0], "anthropic/x")).toBe(true)
  })
  test("vendor matches on providerID only", () => {
    const b = pb([{ generality: "vendor", slice: "anthropic" }]).bullets[0]
    expect(matchesModel(b, "anthropic/claude-haiku-4-5")).toBe(true)
    expect(matchesModel(b, "openai/gpt-5")).toBe(false)
  })
  test("model matches on full id AND on bare modelID tolerance", () => {
    expect(matchesModel(pb([{ generality: "model", slice: "anthropic/claude-haiku-4-5" }]).bullets[0], "anthropic/claude-haiku-4-5")).toBe(true)
    expect(matchesModel(pb([{ generality: "model", slice: "anthropic/claude-haiku-4-5" }]).bullets[0], "anthropic/claude-opus-4-8")).toBe(false)
    // bare-modelID tolerance branch (slice has no provider prefix):
    expect(matchesModel(pb([{ generality: "model", slice: "claude-haiku-4-5" }]).bullets[0], "anthropic/claude-haiku-4-5")).toBe(true)
  })
  test("unparseable model → only universal", () => {
    expect(matchesModel(pb([{ generality: "vendor", slice: "anthropic" }]).bullets[0], "barename")).toBe(false)
    expect(matchesModel(pb([{ generality: "universal" }]).bullets[0], "barename")).toBe(true)
  })
})

describe("renderPlaybookRouted", () => {
  test("drops non-matching + pruned; keeps matching in order", () => {
    const p = pb([
      { text: "U", generality: "universal" },
      { text: "VA", generality: "vendor", slice: "anthropic" },
      { text: "VO", generality: "vendor", slice: "openai" },
      { text: "PR", generality: "universal", status: "pruned" },
    ])
    expect(renderPlaybookRouted(p, "anthropic/claude-haiku-4-5")).toBe("- U\n- VA")
    expect(renderPlaybookRouted(p, "openai/gpt-5")).toBe("- U\n- VO")
  })
  test("all-universal render equals renderPlaybook (filter is identity)", () => {
    const p = pb([{ text: "a" }, { text: "b", generality: "universal" }])
    expect(renderPlaybookRouted(p, "anthropic/x")).toBe(renderPlaybook(p))
  })
})

test("parity + back-compat: runtime compose and bench path agree; all-universal is byte-identical", () => {
  const prev = process.env.META_HARNESS_HOME
  const home = mkdtempSync(join(tmpdir(), "mh-parity-"))
  process.env.META_HARNESS_HOME = home
  try {
    const root = accountGlobalRoot()            // now resolves under `home`
    mkdirSync(join(root, "active"), { recursive: true })
    const pb = { schemaVersion: 1, nextId: 3, bullets: [
      { id:"b1", text:"U", helpful:0, harmful:0, addedBy:"t", status:"active", createdAt:"t", updatedAt:"t" },
      { id:"b2", text:"VA", generality:"vendor", slice:"anthropic", helpful:0, harmful:0, addedBy:"t", status:"active", createdAt:"t", updatedAt:"t" } ] }
    writeFileSync(join(root, "active", "playbook.json"), JSON.stringify(pb))
    writeFileSync(join(root, "active", "system.md"), "- U\n- VA\n")

    const model = "anthropic/claude-haiku-4-5"
    const runtime = renderSystemBlocks(composeHarness([{ scope: "account-global", root }], {}, model)).join("\n")
    const bench = assembleAgentsMd("account", "", "", {}, model)   // account root == `root` via env
    expect(runtime).toContain("- VA"); expect(runtime).toContain("- U")
    expect(bench).toContain("- VA"); expect(bench).toContain("- U")

    // back-compat: strip the tag → all-universal → routed == flat for ANY model
    writeFileSync(join(root, "active", "playbook.json"), JSON.stringify({ ...pb, bullets: pb.bullets.map((b) => ({ ...b, generality: undefined, slice: undefined })) }))
    expect(composeHarness([{ scope: "account-global", root }], {}, "openai/gpt-5")[0].system)
      .toBe(composeHarness([{ scope: "account-global", root }], {})[0].system)
  } finally {
    if (prev === undefined) delete process.env.META_HARNESS_HOME; else process.env.META_HARNESS_HOME = prev
  }
})
