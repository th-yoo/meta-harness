// cc-gate-plugin/test/gauge-channel.test.ts
import { describe, test, expect } from "bun:test"
import { channelForClass, CHANNEL_LITERALS } from "../src/gauge/channel.ts"

describe("channelForClass", () => {
  test("deterministic classes map without a model", () => {
    expect(channelForClass("A1")).toBe("exempt")
    expect(channelForClass("B")).toBe("C1")
    expect(channelForClass("C")).toBe("C1")
  })
  test("A2 and D need model refinement (null)", () => {
    expect(channelForClass("A2")).toBeNull()
    expect(channelForClass("D")).toBeNull()
  })
  test("channel literal set is the spec's ladder", () => {
    expect(CHANNEL_LITERALS).toEqual(["C1", "C2", "C3", "C4"])
  })
})
