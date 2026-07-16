/**
 * fleet-dag.test.ts — T3 (N4) DAG artifact: schema + total validator (Task 1).
 * Pure functions, no fs/env — no beforeEach/afterEach needed.
 */
import { describe, expect, test } from "bun:test"
import { assertValidDag, validateDag, type TaskDag } from "../src/fleet/dag.ts"

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
