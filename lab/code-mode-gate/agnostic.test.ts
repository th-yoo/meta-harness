/** Verifier-agnosticism of the core runtime, enforced two LIST-FREE ways.
 * A hand-enumerated word list would be a fixed set growing one entry per new
 * verifier — the incident-registry pattern this repo's CLAUDE.md names as
 * cheating (caught by architect review; original draft had exactly that).
 *
 * (1) IMPORT GRAPH: core files must not import verifiers/ or opencode-plugin.
 *     Structural, needs no vocabulary at all.
 * (2) DERIVED VOCABULARY: every identifier EXPORTED by files under verifiers/
 *     is extracted and must not appear in core files. The forbidden set is
 *     derived from the artifact, so a third verifier extends it automatically. */
import { test, expect } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const HERE = dirname(fileURLToPath(import.meta.url))
const CORE = ["types.ts", "guest-shell.ts", "bridge.ts", "runtime.ts"]

test("core files import neither verifiers/ nor opencode-plugin", () => {
  const offenders: string[] = []
  for (const f of CORE) {
    const text = readFileSync(join(HERE, f), "utf-8")
    for (const [i, line] of text.split("\n").entries()) {
      if (/from\s+"[^"]*(verifiers\/|opencode-plugin)/.test(line)) offenders.push(`${f}:${i + 1}`)
    }
  }
  expect(offenders).toEqual([])
})

test("no verifier-EXPORTED identifier appears in core files (derived, self-maintaining)", () => {
  const vdir = join(HERE, "verifiers")
  const exported = new Set<string>()
  for (const vf of readdirSync(vdir).filter((n) => n.endsWith(".ts"))) {
    const text = readFileSync(join(vdir, vf), "utf-8")
    for (const m of text.matchAll(/export\s+(?:function|const|interface|type|class)\s+(\w+)/g)) {
      exported.add(m[1]!)
    }
  }
  // the guard itself must be able to fail: an empty forbidden set would make
  // this a check that cannot fire
  expect(exported.size).toBeGreaterThan(0)
  const offenders: string[] = []
  for (const f of CORE) {
    const text = readFileSync(join(HERE, f), "utf-8")
    for (const name of exported) {
      if (new RegExp(`\\b${name}\\b`).test(text)) offenders.push(`${f}: ${name}`)
    }
  }
  expect(offenders).toEqual([])
})
