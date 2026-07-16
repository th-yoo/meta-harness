import { describe, expect, test } from "bun:test"
import { renderPlaybookRouted, matchesModel, renderPlaybook, type Playbook } from "../src/harness-store.ts"

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
