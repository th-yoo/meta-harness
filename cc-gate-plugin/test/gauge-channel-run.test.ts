// cc-gate-plugin/test/gauge-channel-run.test.ts
import { describe, test, expect } from "bun:test"
import { selectChannelWork } from "../src/gauge/channel-run.ts"

// Minimal record stubs: only the fields selectChannelWork reads.
const rec = (cls: string, channel?: string) =>
  ({ derivation: { class: cls, ...(channel ? { channel } : {}) } }) as never

describe("selectChannelWork", () => {
  test("A2/D without channel = model work; A1/B/C = stamp-only; done skipped", () => {
    const records = [rec("A2"), rec("D"), rec("C"), rec("A1"), rec("A2", "C2")]
    const w = selectChannelWork(records)
    expect(w.modelWork.length).toBe(2)
    expect(w.stampOnly.length).toBe(2)
    expect(w.done).toBe(1)
  })
  test("records without a derivation class are not work", () => {
    const w = selectChannelWork([{ derivation: {} } as never])
    expect(w.modelWork.length + w.stampOnly.length).toBe(0)
  })
})
