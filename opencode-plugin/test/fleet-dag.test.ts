/**
 * fleet-dag.test.ts — T3 (N4) DAG artifact: schema + total validator (Task 1)
 * and the wire codec — emit/parse the Designer's fenced dag block (Task 2).
 * Pure functions, no fs/env — no beforeEach/afterEach needed.
 */
import { describe, expect, test } from "bun:test"
import {
  assertValidDag,
  dagFromApprovedPayload,
  formatDagBlock,
  parseDagFromPayload,
  validateDag,
  type TaskDag,
} from "../src/fleet/dag.ts"

describe("validateDag / assertValidDag", () => {
  test("valid 3-node DAG: ok:true, errors:[]; assertValidDag returns it unchanged", () => {
    const dag: TaskDag = {
      nodes: [
        { id: "a", task: "task a", deps: [] },
        { id: "b", task: "task b", deps: [] },
        { id: "c", task: "task c", deps: ["a", "b"], files: ["src/c.ts"] },
      ],
    }
    const v = validateDag(dag)
    expect(v.ok).toBe(true)
    expect(v.errors).toEqual([])
    expect(assertValidDag(dag)).toEqual(dag)
  })

  test("duplicate id: ok:false, error mentions the dup id", () => {
    const dag = {
      nodes: [
        { id: "a", task: "t1", deps: [] },
        { id: "a", task: "t2", deps: [] },
      ],
    }
    const v = validateDag(dag)
    expect(v.ok).toBe(false)
    expect(v.errors.some((e) => e.includes("a"))).toBe(true)
  })

  test("dangling dep: ok:false, error mentions the dangling id", () => {
    const dag = {
      nodes: [
        { id: "a", task: "t1", deps: [] },
        { id: "c", task: "t3", deps: ["a", "zzz"] },
      ],
    }
    const v = validateDag(dag)
    expect(v.ok).toBe(false)
    expect(v.errors.some((e) => e.includes("zzz"))).toBe(true)
  })

  test("self-dep: ok:false, error mentions the self-cycle", () => {
    const dag = { nodes: [{ id: "a", task: "t1", deps: ["a"] }] }
    const v = validateDag(dag)
    expect(v.ok).toBe(false)
    expect(v.errors.some((e) => e.includes("a"))).toBe(true)
  })

  test("2-cycle: ok:false with a cycle error", () => {
    const dag = {
      nodes: [
        { id: "a", task: "t1", deps: ["b"] },
        { id: "b", task: "t2", deps: ["a"] },
      ],
    }
    const v = validateDag(dag)
    expect(v.ok).toBe(false)
    expect(v.errors.some((e) => /cycle/i.test(e))).toBe(true)
  })

  test("3-cycle: ok:false with a cycle error", () => {
    const dag = {
      nodes: [
        { id: "a", task: "t1", deps: ["c"] },
        { id: "b", task: "t2", deps: ["a"] },
        { id: "c", task: "t3", deps: ["b"] },
      ],
    }
    const v = validateDag(dag)
    expect(v.ok).toBe(false)
    expect(v.errors.some((e) => /cycle/i.test(e))).toBe(true)
  })

  test("empty nodes and not-an-object inputs: ok:false", () => {
    expect(validateDag({ nodes: [] }).ok).toBe(false)
    expect(validateDag(null).ok).toBe(false)
    expect(validateDag({}).ok).toBe(false)
    expect(validateDag({ nodes: "x" }).ok).toBe(false)
  })

  test("shape errors: empty id, missing task, deps not array, files not array", () => {
    expect(validateDag({ nodes: [{ id: "", task: "t", deps: [] }] }).ok).toBe(false)
    expect(validateDag({ nodes: [{ id: "a", deps: [] }] }).ok).toBe(false)
    expect(validateDag({ nodes: [{ id: "a", task: "t", deps: "nope" }] }).ok).toBe(false)
    expect(validateDag({ nodes: [{ id: "a", task: "t", deps: [], files: "nope" }] }).ok).toBe(false)
  })

  test("files-overlap between concurrent nodes is a warning, not an error", () => {
    const dag: TaskDag = {
      nodes: [
        { id: "a", task: "t1", deps: [], files: ["src/shared.ts"] },
        { id: "b", task: "t2", deps: [], files: ["src/shared.ts"] },
      ],
    }
    const v = validateDag(dag)
    expect(v.ok).toBe(true)
    expect(v.errors).toEqual([])
    expect(v.warnings.length).toBeGreaterThan(0)
    expect(v.warnings.some((w) => w.includes("src/shared.ts"))).toBe(true)
    expect(() => assertValidDag(dag)).not.toThrow()
  })

  test("overlap along a dependency edge is NOT warned (never run concurrently)", () => {
    const dag: TaskDag = {
      nodes: [
        { id: "a", task: "t1", deps: [], files: ["src/x.ts"] },
        { id: "b", task: "t2", deps: ["a"], files: ["src/x.ts"] },
      ],
    }
    const v = validateDag(dag)
    expect(v.ok).toBe(true)
    expect(v.warnings).toEqual([])
  })

  test("mutatesDeps round-trips: validates ok:true", () => {
    const dag: TaskDag = { nodes: [{ id: "a", task: "t1", deps: [], mutatesDeps: true }] }
    expect(validateDag(dag).ok).toBe(true)
  })

  test("assertValidDag dies (throws) on a cyclic dag, returns the typed value on a valid one", () => {
    const cyclic = {
      nodes: [
        { id: "a", task: "t1", deps: ["b"] },
        { id: "b", task: "t2", deps: ["a"] },
      ],
    }
    expect(() => assertValidDag(cyclic)).toThrow()
    const valid: TaskDag = { nodes: [{ id: "a", task: "t1", deps: [] }] }
    expect(assertValidDag(valid)).toEqual(valid)
  })
})

describe("wire codec", () => {
  const FULL_DAG: TaskDag = {
    nodes: [
      { id: "a", task: "task a", deps: [] },
      { id: "b", task: "task b", deps: [] },
      { id: "c", task: "task c", deps: ["a", "b"], files: ["src/c.ts"], mutatesDeps: true },
    ],
  }

  test("round-trip: parseDagFromPayload(formatDagBlock(dag)) deep-equals dag", () => {
    const parsed = parseDagFromPayload(formatDagBlock(FULL_DAG))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.dag).toEqual(FULL_DAG)
  })

  test("prose around the block still parses ok:true", () => {
    const payload = "Here is the plan.\n\n" + formatDagBlock(FULL_DAG) + "\n\nThat's it."
    const parsed = parseDagFromPayload(payload)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.dag).toEqual(FULL_DAG)
  })

  test("```json fallback (proposer-drift leniency): a json-fenced block still parses ok:true", () => {
    const block = formatDagBlock(FULL_DAG).replace("```dag", "```json")
    const parsed = parseDagFromPayload(block)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.dag).toEqual(FULL_DAG)
  })

  test("missing block: ok:false with an error string", () => {
    const parsed = parseDagFromPayload("just some prose, no fenced block here")
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error.length).toBeGreaterThan(0)
  })

  test("malformed JSON in the block: ok:false", () => {
    const payload = "## Task DAG\n```dag\n{nodes: [ }\n```\n"
    const parsed = parseDagFromPayload(payload)
    expect(parsed.ok).toBe(false)
  })

  test("wrong shape: {nodes:\"x\"} or {items:[]} → ok:false", () => {
    const p1 = parseDagFromPayload("```dag\n" + JSON.stringify({ nodes: "x" }) + "\n```")
    expect(p1.ok).toBe(false)
    const p2 = parseDagFromPayload("```dag\n" + JSON.stringify({ items: [] }) + "\n```")
    expect(p2.ok).toBe(false)
  })

  test("byte-consistency with T4: a fully-populated node survives the round-trip with all five keys intact", () => {
    const parsed = parseDagFromPayload(formatDagBlock(FULL_DAG))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      const node = parsed.dag.nodes.find((n) => n.id === "c")!
      expect(Object.keys(node).sort()).toEqual(["deps", "files", "id", "mutatesDeps", "task"])
    }
  })

  test("dagFromApprovedPayload: valid payload returns the TaskDag", () => {
    expect(dagFromApprovedPayload(formatDagBlock(FULL_DAG))).toEqual(FULL_DAG)
  })

  test("dagFromApprovedPayload: parseable-but-cyclic block throws (parse ok, validate fails)", () => {
    const cyclic: TaskDag = {
      nodes: [
        { id: "a", task: "t1", deps: ["b"] },
        { id: "b", task: "t2", deps: ["a"] },
      ],
    }
    expect(() => dagFromApprovedPayload(formatDagBlock(cyclic))).toThrow()
  })

  test("dagFromApprovedPayload: no block throws", () => {
    expect(() => dagFromApprovedPayload("no dag here")).toThrow()
  })
})
