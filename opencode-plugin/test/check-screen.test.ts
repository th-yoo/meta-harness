import { test, expect } from "bun:test"
import { screenCheck } from "../src/check-screen.ts"

const T = (cmd: string) => screenCheck({ cmd, timeoutMs: 5000 })

test("empty / unparseable / oversize timeout rejected", () => {
  expect(screenCheck({ cmd: "", timeoutMs: 5000 }).tier).toBe("rejected")
  expect(screenCheck({ cmd: "ls", timeoutMs: 0 }).tier).toBe("rejected")
  expect(screenCheck({ cmd: "ls", timeoutMs: 600001 }).tier).toBe("rejected")
})

test("store-path / network / package-install / rm -rf rejected at Tier B with slug reasons only", () => {
  for (const [cmd, slug] of [
    ["cat .kkamak/global/active/playbook.json", "store-path"],
    ["grep x .km/gate-outcomes.ndjson", "store-path"],
    ["ls term-bench2/store/global", "store-path"],
    ["curl http://example.com", "network"],
    ["apt-get install jq", "package-install"],
    ["rm -rf /app", "destructive"],
  ] as const) {
    const r = T(cmd)
    expect(r.tier).toBe("rejected")
    expect(r.reason).toBe(slug)
    expect(r.reason!.includes(cmd)).toBe(false)
  }
})

test("workspace-scoped write passes Tier B but not Tier L", () => {
  const r = T("echo probe > probe.txt && test -s probe.txt")
  expect(r.tier).toBe("bench")
})

test("read-only verification passes Tier L", () => {
  expect(T("test -s DONE-CHECK.txt").tier).toBe("live")
  expect(T("grep -q 'result' DONE-CHECK.txt").tier).toBe("live")
})
