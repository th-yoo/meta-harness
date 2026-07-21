import { test, expect } from "bun:test"
import {
  TAXONOMY_MODES,
  buildTaxonomyPrompt,
  parseTaxonomyEntry,
} from "../src/bench/failure-taxonomy.ts"
import type { TrajEvent } from "../src/harness-store.ts"

const EVENTS: TrajEvent[] = [
  { t: "text", text: "I'll create the cert" },
  { t: "tool", tool: "bash", args: "openssl req -x509 -subj '/O=Dev'" },
] as unknown as TrajEvent[]

test("TAXONOMY_MODES includes the seed modes incl. spec_precision + capability", () => {
  const keys = TAXONOMY_MODES.map((m) => m.key)
  expect(keys).toContain("spec_precision")
  expect(keys).toContain("looks_done")
  expect(keys).toContain("comprehension")
  expect(keys).toContain("capability")
  expect(keys).toContain("errored")
  expect(keys).toContain("infra")
  expect(keys).toContain("incomplete")
})

test("buildTaxonomyPrompt embeds instruction, trajectory, the fail-fact, and the mode menu", () => {
  const p = buildTaxonomyPrompt(EVENTS, "openssl-selfsigned-cert", "Create a cert with O=devops team, 365 days.", true)
  expect(p).toContain("openssl-selfsigned-cert")
  expect(p).toContain("devops team") // instruction present
  expect(p).toContain("openssl req") // trajectory present
  expect(p).toContain("spec_precision") // mode menu present
  expect(p.toLowerCase()).toContain("verifier") // AHE: agent never saw the verdict; it FAILED
  expect(p).toContain("GENERAL MECHANISM") // AHE root-cause field
})

test("parseTaxonomyEntry: valid JSON with a known mode → structured entry", () => {
  const reply = `Here is my analysis.\n{"mode":"spec_precision","failure_point":"cert subject","root_cause":"dropped the literal O value","general_mechanism":"extract literal spec values"}`
  const e = parseTaxonomyEntry(reply)
  expect(e).not.toBeNull()
  expect(e!.mode).toBe("spec_precision")
  expect(e!.rootCause).toContain("literal O")
})

test("parseTaxonomyEntry: unknown mode → coerced to 'other'; no JSON → null", () => {
  expect(parseTaxonomyEntry(`{"mode":"banana","failure_point":"x","root_cause":"y","general_mechanism":"z"}`)!.mode).toBe("other")
  expect(parseTaxonomyEntry("no json here")).toBeNull()
})
