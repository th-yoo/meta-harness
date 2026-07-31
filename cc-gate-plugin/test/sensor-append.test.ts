import { describe, expect, test } from "bun:test"
import fs from "node:fs"; import os from "node:os"; import path from "node:path"
import { appendSensor, sensorFilePath, DEFAULT_SENSOR_REL_PATH } from "../src/sensor-append"

const LINE = { ts: 1, sessionID: "s", check: "true", accepted: true, gateExhausted: false,
  rounds: [] as string[], interrupted: false, marker: false, durationMs: 0, host: "h", app: "claude-code" }

describe("sensorFilePath", () => {
  test("default vs override (raw JSON string in, exactly as hook-cli passes it)", () => {
    expect(sensorFilePath("/x", undefined)).toBe(path.resolve("/x", DEFAULT_SENSOR_REL_PATH))
    expect(sensorFilePath("/x", JSON.stringify({ check: "true", sensor: "custom.ndjson" })))
      .toBe(path.resolve("/x", "custom.ndjson"))
  })
})
describe("appendSensor", () => {
  test("appends one stamped ndjson line", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-"))
    appendSensor(dir, undefined, LINE as never, () => {})
    const txt = fs.readFileSync(path.join(dir, DEFAULT_SENSOR_REL_PATH), "utf-8")
    const rec = JSON.parse(txt.trim())
    expect(rec.sessionID).toBe("s")
    expect(typeof rec.pluginVersion === "string" || rec.pluginVersion === undefined).toBe(true)
  })
  test("write failure swallowed + logged", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-"))
    fs.mkdirSync(path.join(dir, ".km"), { recursive: true })
    fs.mkdirSync(path.join(dir, DEFAULT_SENSOR_REL_PATH), { recursive: true }) // path occupied by a dir
    const logs: string[] = []
    expect(() => appendSensor(dir, undefined, LINE as never, (m) => logs.push(m))).not.toThrow()
    expect(logs.length).toBeGreaterThan(0)
  })
})
