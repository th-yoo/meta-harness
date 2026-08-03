import { describe, test, expect } from "bun:test"
import { GAUGE_TRANSPORTS } from "../src/types.ts"

describe("GaugeTransport", () => {
  test("three transports are recognized, incumbent order preserved", () => {
    expect(GAUGE_TRANSPORTS).toEqual(["cli", "sdk", "agent-sdk"])
  })
})
