import { describe, test, expect } from "bun:test"
import { GAUGE_TRANSPORTS } from "../src/types.ts"
import { selectTransport } from "../src/gauge/transport.ts"

describe("GaugeTransport", () => {
  test("three transports are recognized, incumbent order preserved", () => {
    expect(GAUGE_TRANSPORTS).toEqual(["cli", "sdk", "agent-sdk"])
  })
})

describe("selectTransport", () => {
  test("defaults to sdk when unset, empty, or unrecognized", () => {
    expect(selectTransport({})).toBe("sdk")
    expect(selectTransport({ KKAMAK_GAUGE_TRANSPORT: "" })).toBe("sdk")
    expect(selectTransport({ KKAMAK_GAUGE_TRANSPORT: "nonsense" })).toBe("sdk")
  })
  test("selects agent-sdk only on the exact literal", () => {
    expect(selectTransport({ KKAMAK_GAUGE_TRANSPORT: "agent-sdk" })).toBe("agent-sdk")
  })
  test("never selects the retired cli transport", () => {
    expect(selectTransport({ KKAMAK_GAUGE_TRANSPORT: "cli" })).toBe("sdk")
  })
})
