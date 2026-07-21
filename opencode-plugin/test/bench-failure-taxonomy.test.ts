import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test, expect } from "bun:test"
import {
  TAXONOMY_MODES,
  buildTaxonomyPrompt,
  parseTaxonomyEntry,
} from "../src/bench/failure-taxonomy.ts"
import {
  writeTaxonomy,
  readTaxonomy,
  candidatePath,
  recordSession,
  projectGlobalRoot,
  createCandidate,
  writeTrajectory,
  type Taxonomy,
} from "../src/harness-store.ts"
import type { TrajEvent } from "../src/harness-store.ts"
import { cmdFailureTaxonomy, type FailureTaxonomyArgs } from "../src/bench/cmd-failure-taxonomy.ts"
import { sessionRecord } from "../src/bench/record.ts"
import type { BenchPaths } from "../src/bench/paths.ts"

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

function taxPaths(dir: string): BenchPaths {
  return {
    metaRoot: dir, termBenchDir: path.join(dir, "tb"), tbRoot: path.join(dir, "tbroot"),
    resultsDir: path.join(dir, "r"), patchesDir: path.join(dir, "p"),
    baselineTasksFile: path.join(dir, "b.txt"), splitsFile: path.join(dir, "s.json"),
  }
}

test("cmdFailureTaxonomy: classifies failing sessions, writes taxonomy.json with mode-fractions", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mh-cmdtax-"))
  const root = projectGlobalRoot(dir)
  createCandidate(root, "v0", "sys")
  // one failing session with a trajectory + a passing one (ignored)
  fs.mkdirSync(path.join(dir, "tbroot", "openssl-selfsigned-cert"), { recursive: true })
  fs.writeFileSync(path.join(dir, "tbroot", "openssl-selfsigned-cert", "instruction.md"), "Create a cert.")
  recordSession(root, "v0", sessionRecord("openssl-selfsigned-cert", "s-fail", false, 3, {}, "m", ""))
  writeTrajectory(root, "v0", "s-fail", [{ t: "text", text: "did stuff" }] as any)
  recordSession(root, "v0", sessionRecord("other-task", "s-pass", true, 2, {}, "m", ""))

  const runJudge = async () =>
    `analysis\n{"mode":"spec_precision","failure_point":"subject","root_cause":"dropped O","general_mechanism":"extract literals"}`
  const rc = await cmdFailureTaxonomy(taxPaths(dir), { layer: "project-global", candidate: "v0" }, runJudge)
  expect(rc).toBe(0)
  const tax = JSON.parse(fs.readFileSync(path.join(root, "candidates", "v0", "taxonomy.json"), "utf8"))
  expect(tax.nClassified).toBe(1) // only the failing session
  expect(tax.modeFractions.spec_precision).toBe(1)
  expect(tax.byTask["openssl-selfsigned-cert"]).toEqual(["spec_precision"])
  fs.rmSync(dir, { recursive: true, force: true })
})

test("cmdFailureTaxonomy: no failing trajectories → rc 2, no file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mh-cmdtax2-"))
  const root = projectGlobalRoot(dir)
  createCandidate(root, "v0", "sys")
  recordSession(root, "v0", sessionRecord("t", "s-pass", true, 2, {}, "m", ""))
  const rc = await cmdFailureTaxonomy(taxPaths(dir), { layer: "project-global", candidate: "v0" }, async () => "{}")
  expect(rc).toBe(2)
  expect(fs.existsSync(path.join(root, "candidates", "v0", "taxonomy.json"))).toBe(false)
  fs.rmSync(dir, { recursive: true, force: true })
})
