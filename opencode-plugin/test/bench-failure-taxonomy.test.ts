import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test, expect } from "bun:test"
import {
  TAXONOMY_MODES,
  buildTaxonomyPrompt,
  parseTaxonomyEntry,
} from "../src/bench/failure-taxonomy.ts"
import { writeTaxonomy, readTaxonomy, candidatePath, type Taxonomy } from "../src/harness-store.ts"
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

test("parseTaxonomyEntry: an early decoy taxonomy-shaped JSON object in the analysis is ignored — the FINAL one wins (last-match, not first-match)", () => {
  const reply = `Initial hunch while reading the trajectory: {"mode":"comprehension","failure_point":"early guess","root_cause":"draft","general_mechanism":"draft"}\n` +
    `On closer inspection that was wrong — the agent actually hit an unresolved build error, so revising the verdict.\n` +
    `{"mode":"errored","failure_point":"build step","root_cause":"unresolved compiler error","general_mechanism":"retry with clarified env"}`
  const e = parseTaxonomyEntry(reply)
  expect(e).not.toBeNull()
  expect(e!.mode).toBe("errored")
  expect(e!.failurePoint).toBe("build step")
})

test("writeTaxonomy/readTaxonomy: roundtrip to candidates/vN/taxonomy.json; absent → null", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mh-tax-"))
  fs.mkdirSync(candidatePath(root, "v0"), { recursive: true })
  expect(readTaxonomy(root, "v0")).toBeNull()
  const tax: Taxonomy = {
    version: "v0", model: "m", nClassified: 1,
    modeFractions: { spec_precision: 1 },
    entries: [{ sessionID: "s1", task: "t", mode: "spec_precision", failurePoint: "x", rootCause: "y", generalMechanism: "z" }],
    byTask: { t: ["spec_precision"] },
  }
  writeTaxonomy(root, "v0", tax)
  expect(fs.existsSync(path.join(candidatePath(root, "v0"), "taxonomy.json"))).toBe(true)
  expect(readTaxonomy(root, "v0")).toEqual(tax)
  fs.rmSync(root, { recursive: true, force: true })
})
