import { describe, expect, test } from "bun:test"
import { fakeTransport } from "../src/fleet/master/transport.ts"

describe("fakeTransport (R1 offset-ack durability)", () => {
  test("poll returns backlog; ack advances the offset; un-acked re-appears (R1 durability)", async () => {
    const t = fakeTransport([
      { id: "u1", text: "approve p/s1" },
      { id: "u2", text: "status" },
    ])
    expect((await t.poll()).map((m) => m.id)).toEqual(["u1", "u2"])
    await t.ack("u1")
    expect((await t.poll()).map((m) => m.id)).toEqual(["u2"]) // u1 gone, u2 (un-acked) stays
  })

  test("acked messages never re-appear even across multiple polls", async () => {
    const t = fakeTransport([
      { id: "u1", text: "approve p/s1" },
      { id: "u2", text: "status" },
    ])
    await t.poll()
    await t.ack("u1")
    await t.ack("u2")
    expect((await t.poll()).map((m) => m.id)).toEqual([])
    expect((await t.poll()).map((m) => m.id)).toEqual([])
  })

  test("un-acked messages persist across repeated polls (self-healing backlog)", async () => {
    const t = fakeTransport([{ id: "u1", text: "status" }])
    expect((await t.poll()).map((m) => m.id)).toEqual(["u1"])
    expect((await t.poll()).map((m) => m.id)).toEqual(["u1"])
    expect((await t.poll()).map((m) => m.id)).toEqual(["u1"])
  })

  test("ack records into acked array", async () => {
    const t = fakeTransport([{ id: "u1", text: "status" }])
    await t.ack("u1")
    expect(t.acked).toEqual(["u1"])
  })

  test("send records into sent and returns a monotonic id", async () => {
    const t = fakeTransport()
    const r1 = await t.send({ text: "hello" })
    const r2 = await t.send({ text: "world", replyTo: "u1" })
    expect(t.sent).toEqual([{ text: "hello" }, { text: "world", replyTo: "u1" }])
    expect(r1.id).not.toEqual(r2.id)
    expect(r1.id).toEqual("out-0")
    expect(r2.id).toEqual("out-1")
  })

  test("inject adds new backlog mid-test", async () => {
    const t = fakeTransport([{ id: "u1", text: "status" }])
    expect((await t.poll()).map((m) => m.id)).toEqual(["u1"])
    t.inject([{ id: "u2", text: "approve p/s1" }])
    expect((await t.poll()).map((m) => m.id)).toEqual(["u1", "u2"])
    await t.ack("u1")
    expect((await t.poll()).map((m) => m.id)).toEqual(["u2"])
  })

  test("fakeTransport with no script starts with empty backlog", async () => {
    const t = fakeTransport()
    expect(await t.poll()).toEqual([])
  })
})
