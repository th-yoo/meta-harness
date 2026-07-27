import { test, expect } from "bun:test"
import { parseRequirements, stripBashComments, uncoveredRequirements } from "../../minimal/spec-probe.ts"

const REQS_JSON = JSON.stringify({
  requirements: [
    { id: "R-ctrlc", text: "modifier keys like ctrl-C", markers: ["\\x03", "ctrl"] },
    { id: "R-bashrc", text: "sources startup files", markers: ["bashrc"] },
  ],
})

test("parseRequirements round-trips well-formed JSON", () => {
  const rs = parseRequirements(REQS_JSON)!
  expect(rs.length).toBe(2)
  expect(rs[0]!.id).toBe("R-ctrlc")
  expect(rs[1]!.markers).toEqual(["bashrc"])
})

test("parseRequirements rejects malformed input", () => {
  expect(parseRequirements("not json")).toBeUndefined()
  expect(parseRequirements("{}")).toBeUndefined()
  expect(parseRequirements(JSON.stringify({ requirements: [{ id: "x" }] }))).toBeUndefined()
})

test("stripBashComments drops comment tails but keeps quoted hashes", () => {
  expect(stripBashComments("echo hi # not this")).toBe("echo hi ")
  expect(stripBashComments('echo "# keep" # drop')).toBe('echo "# keep" ')
  expect(stripBashComments("# whole line\nrun x")).toBe("\nrun x")
})

test("uncoveredRequirements: covered via any marker, case-insensitive", () => {
  const rs = parseRequirements(REQS_JSON)!
  const verify = 'python3 - <<EOF\nt.send_keystrokes("\\x03")\nEOF\n'
  const un = uncoveredRequirements(rs, verify)
  expect(un.map((r) => r.id)).toEqual(["R-bashrc"])
})

test("uncoveredRequirements: markers inside bash comments do NOT count (anti-gaming)", () => {
  const rs = parseRequirements(REQS_JSON)!
  const gamed = "# \\x03 ctrl bashrc — mentioning every marker in a comment\nexit 0\n"
  expect(uncoveredRequirements(rs, gamed).map((r) => r.id)).toEqual(["R-ctrlc", "R-bashrc"])
})
