import { describe, expect, test } from "bun:test"
import type { NamespaceRegistry, ProjectNamespace } from "../src/fleet/master/namespace.ts"
import { admit, type RunRequest, type SubScheduler } from "../src/fleet/master/scheduler.ts"

function ns(project: string): ProjectNamespace {
  return {
    project,
    runtimeRoot: `/rt/${project}`,
    worktreeBase: `/wt/${project}`,
    integrationBranch: `int/${project}`,
    credentialScope: `cred/${project}`,
    gatePolicy: "root-human",
    lifetime: "ephemeral",
  }
}

function registry(projects: string[], globalCap: number): NamespaceRegistry {
  const reg: NamespaceRegistry = { projects: {}, globalCap }
  for (const p of projects) reg.projects[p] = ns(p)
  return reg
}

/** Fake SubScheduler that records every call it receives and always
 * resolves "done" — no real fleet-dev involved. */
function recordingSub(): SubScheduler & { calls: Array<RunRequest & { ns: ProjectNamespace }> } {
  const calls: Array<RunRequest & { ns: ProjectNamespace }> = []
  const sub = async (req: RunRequest & { ns: ProjectNamespace }) => {
    calls.push(req)
    return { status: "done" as const, payload: "ok" }
  }
  return Object.assign(sub, { calls })
}

describe("master/scheduler admit", () => {
  test("cap respected: globalCap:2, 4 requests across 3 projects → exactly 2 admitted, 2 deferred; sub called twice", async () => {
    const reg = registry(["projA", "projB", "projC"], 2)
    const sub = recordingSub()
    const requests: RunRequest[] = [
      { project: "projA", feature: "f1", sliceId: "s1" },
      { project: "projB", feature: "f1", sliceId: "s1" },
      { project: "projC", feature: "f1", sliceId: "s1" },
      { project: "projA", feature: "f1", sliceId: "s2" },
    ]
    const result = await admit({ registry: reg, sub }, requests)
    expect(result.admitted).toHaveLength(2)
    expect(result.deferred).toHaveLength(2)
    expect(sub.calls).toHaveLength(2)
    expect(result.outcomes).toHaveLength(2)
  })

  test("fair-share: 3 requests from projA + 1 from projB with cap:2 → admitted is one projA + projB, not two projA", async () => {
    const reg = registry(["projA", "projB"], 2)
    const sub = recordingSub()
    const requests: RunRequest[] = [
      { project: "projA", feature: "f1", sliceId: "s1" },
      { project: "projA", feature: "f1", sliceId: "s2" },
      { project: "projA", feature: "f1", sliceId: "s3" },
      { project: "projB", feature: "f1", sliceId: "s1" },
    ]
    const result = await admit({ registry: reg, sub }, requests)
    expect(result.admitted).toHaveLength(2)
    const projectsAdmitted = result.admitted.map((r) => r.project).sort()
    expect(projectsAdmitted).toEqual(["projA", "projB"])
    // no single-project monopoly: projA must not occupy both slots
    expect(result.admitted.filter((r) => r.project === "projA")).toHaveLength(1)
    expect(result.admitted.filter((r) => r.project === "projB")).toHaveLength(1)
  })

  test("ephemeral spawn: each sub call receives the correctly resolved ns for its project", async () => {
    const reg = registry(["projA", "projB"], 2)
    const sub = recordingSub()
    const requests: RunRequest[] = [
      { project: "projA", feature: "f1", sliceId: "s1" },
      { project: "projB", feature: "f1", sliceId: "s1" },
    ]
    await admit({ registry: reg, sub }, requests)
    expect(sub.calls).toHaveLength(2)
    for (const call of sub.calls) {
      expect(call.ns).toEqual(reg.projects[call.project])
    }
  })

  test("unregistered rejected: a request for an unregistered project is deferred, never run", async () => {
    const reg = registry(["projA"], 2)
    const sub = recordingSub()
    const requests: RunRequest[] = [
      { project: "projA", feature: "f1", sliceId: "s1" },
      { project: "unregistered", feature: "f1", sliceId: "s1" },
    ]
    const result = await admit({ registry: reg, sub }, requests)
    expect(result.admitted).toHaveLength(1)
    expect(result.admitted[0].project).toBe("projA")
    expect(result.deferred).toHaveLength(1)
    expect(result.deferred[0].project).toBe("unregistered")
    expect(sub.calls).toHaveLength(1)
    expect(sub.calls[0].project).toBe("projA")
  })

  test("determinism: admit ordering is stable across two identical calls", async () => {
    const reg = registry(["projA", "projB", "projC"], 2)
    const requests: RunRequest[] = [
      { project: "projC", feature: "f1", sliceId: "s2" },
      { project: "projA", feature: "f1", sliceId: "s1" },
      { project: "projB", feature: "f1", sliceId: "s1" },
      { project: "projA", feature: "f1", sliceId: "s2" },
    ]
    const sub1 = recordingSub()
    const result1 = await admit({ registry: reg, sub: sub1 }, requests)
    const sub2 = recordingSub()
    const result2 = await admit({ registry: reg, sub: sub2 }, requests)
    expect(result1.admitted).toEqual(result2.admitted)
    expect(result1.deferred).toEqual(result2.deferred)
  })

  test("cap respected but no unregistered request is ever run even under slack", async () => {
    const reg = registry(["projA"], 5)
    const sub = recordingSub()
    const requests: RunRequest[] = [{ project: "ghost", feature: "f1", sliceId: "s1" }]
    const result = await admit({ registry: reg, sub }, requests)
    expect(result.admitted).toHaveLength(0)
    expect(result.deferred).toHaveLength(1)
    expect(sub.calls).toHaveLength(0)
  })
})
