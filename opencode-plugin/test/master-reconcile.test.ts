import { describe, expect, test } from "bun:test"
import { reconcile, type CrashIntent, type GitProbe } from "../src/fleet/master/reconcile.ts"
import type { NamespaceRegistry, ProjectNamespace } from "../src/fleet/master/namespace.ts"

function ns(overrides: Partial<ProjectNamespace> & { project: string }): ProjectNamespace {
  return {
    project: overrides.project,
    runtimeRoot: overrides.runtimeRoot ?? `/rt/${overrides.project}`,
    worktreeBase: overrides.worktreeBase ?? `/wt/${overrides.project}`,
    integrationBranch: overrides.integrationBranch ?? `int/${overrides.project}`,
    credentialScope: overrides.credentialScope ?? `cred/${overrides.project}`,
    gatePolicy: overrides.gatePolicy ?? "root-human",
    lifetime: overrides.lifetime ?? "ephemeral",
  }
}

function registry(...projects: ProjectNamespace[]): NamespaceRegistry {
  const projectsMap: Record<string, ProjectNamespace> = {}
  for (const p of projects) projectsMap[p.project] = p
  return { projects: projectsMap, globalCap: 3 }
}

/** Fake GitProbe: static, non-self-mutating lookups + call logs — so
 * reconcile's own idempotence/determinism (not the fixture's state
 * machine) is what the tests exercise. */
function fakeGit(opts: { mergeHeads?: Record<string, boolean>; contains?: Record<string, boolean> }) {
  const abortCalls: string[] = []
  const hasMergeHeadCalls: string[] = []
  const branchContainsCalls: string[] = []
  const mergeHeads = opts.mergeHeads ?? {}
  const contains = opts.contains ?? {}
  const git: GitProbe = {
    hasMergeHead(root) {
      hasMergeHeadCalls.push(root)
      return mergeHeads[root] ?? false
    },
    branchContains(root, branch, sha) {
      branchContainsCalls.push(`${root}|${branch}|${sha}`)
      return contains[`${root}|${branch}|${sha}`] ?? false
    },
    abortMerge(root) {
      abortCalls.push(root)
    },
  }
  return { git, abortCalls, hasMergeHeadCalls, branchContainsCalls }
}

describe("master/reconcile", () => {
  test("abort partial merge: phase 'merging' + hasMergeHead:true -> abortMerge called, in abortedMerges", () => {
    const project = ns({ project: "p1" })
    const reg = registry(project)
    const { git, abortCalls } = fakeGit({ mergeHeads: { [project.runtimeRoot]: true } })
    const removed: string[] = []
    const intents: CrashIntent[] = [{ project: "p1", sliceId: "s1", phase: "merging" }]

    const result = reconcile({
      masterRoot: "/mh",
      registry: reg,
      intents,
      git,
      removeWorktree: (d) => removed.push(d),
    })

    expect(abortCalls).toEqual([project.runtimeRoot])
    expect(result.abortedMerges).toEqual(["p1/s1"])
    expect(removed).toEqual([])
    expect(result.redriven).toEqual([])
  })

  test("done-by-commit (idempotent): commitSha on integration branch -> doneByCommit, not re-driven, worktree not discarded", () => {
    const project = ns({ project: "p1" })
    const reg = registry(project)
    const { git } = fakeGit({
      contains: { [`${project.runtimeRoot}|${project.integrationBranch}|shaOnBranch`]: true },
    })
    const removed: string[] = []
    const intents: CrashIntent[] = [
      { project: "p1", sliceId: "s1", commitSha: "shaOnBranch", worktreeDir: "/wt/p1/s1", phase: "running" },
    ]

    const result = reconcile({
      masterRoot: "/mh",
      registry: reg,
      intents,
      git,
      removeWorktree: (d) => removed.push(d),
    })

    expect(result.doneByCommit).toEqual(["p1/s1"])
    expect(result.redriven).toEqual([])
    expect(removed).toEqual([])
    expect(result.discardedWorktrees).toEqual([])
  })

  test("re-drive + discard live-at-crash: phase 'running', worktreeDir set, sha not on branch -> redriven + discardedWorktrees", () => {
    const project = ns({ project: "p1" })
    const reg = registry(project)
    const { git } = fakeGit({}) // no merge head; branchContains defaults false everywhere
    const removed: string[] = []
    const intents: CrashIntent[] = [
      { project: "p1", sliceId: "s2", commitSha: "shaNotOnBranch", worktreeDir: "/wt/p1/s2", phase: "running" },
    ]

    const result = reconcile({
      masterRoot: "/mh",
      registry: reg,
      intents,
      git,
      removeWorktree: (d) => removed.push(d),
    })

    expect(result.redriven).toEqual(["p1/s2"])
    expect(removed).toEqual(["/wt/p1/s2"])
    expect(result.discardedWorktrees).toEqual(["/wt/p1/s2"])
    expect(result.doneByCommit).toEqual([])
  })

  test("re-drive without a worktreeDir does not call removeWorktree", () => {
    const project = ns({ project: "p1" })
    const reg = registry(project)
    const { git } = fakeGit({})
    const removed: string[] = []
    const intents: CrashIntent[] = [{ project: "p1", sliceId: "s3", phase: "running" }]

    const result = reconcile({
      masterRoot: "/mh",
      registry: reg,
      intents,
      git,
      removeWorktree: (d) => removed.push(d),
    })

    expect(result.redriven).toEqual(["p1/s3"])
    expect(removed).toEqual([])
    expect(result.discardedWorktrees).toEqual([])
  })

  test("idempotent second run: same inputs -> same result, no double side effects", () => {
    const project = ns({ project: "p1" })
    const reg = registry(project)
    const { git, abortCalls } = fakeGit({ mergeHeads: { [project.runtimeRoot]: true } })
    const intents: CrashIntent[] = [{ project: "p1", sliceId: "s1", phase: "merging" }]

    const removed1: string[] = []
    const result1 = reconcile({
      masterRoot: "/mh",
      registry: reg,
      intents,
      git,
      removeWorktree: (d) => removed1.push(d),
    })

    const removed2: string[] = []
    const result2 = reconcile({
      masterRoot: "/mh",
      registry: reg,
      intents,
      git,
      removeWorktree: (d) => removed2.push(d),
    })

    expect(result1).toEqual(result2)
    // abortMerge fires once per run because MERGE_HEAD is still (statically)
    // reported present both times -- reconcile itself holds no state that
    // would suppress a legitimately-repeated observation.
    expect(abortCalls).toEqual([project.runtimeRoot, project.runtimeRoot])
    expect(removed1).toEqual([])
    expect(removed2).toEqual([])
  })

  test("abortMerge is only called while MERGE_HEAD is (still) present -- no double-abort across a real post-abort sequence", () => {
    const project = ns({ project: "p1" })
    const reg = registry(project)
    const intents: CrashIntent[] = [{ project: "p1", sliceId: "s1", phase: "merging" }]

    // First reconcile observes a merge in progress.
    const { git: gitBefore, abortCalls: abortsBefore } = fakeGit({
      mergeHeads: { [project.runtimeRoot]: true },
    })
    const result1 = reconcile({
      masterRoot: "/mh",
      registry: reg,
      intents,
      git: gitBefore,
      removeWorktree: () => {},
    })
    expect(abortsBefore).toEqual([project.runtimeRoot])
    expect(result1.abortedMerges).toEqual(["p1/s1"])

    // Second reconcile: git now truthfully reports the merge already
    // resolved (the real post-abort state) -- reconcile must not re-abort.
    const { git: gitAfter, abortCalls: abortsAfter } = fakeGit({
      mergeHeads: { [project.runtimeRoot]: false },
    })
    const removed: string[] = []
    const result2 = reconcile({
      masterRoot: "/mh",
      registry: reg,
      intents,
      git: gitAfter,
      removeWorktree: (d) => removed.push(d),
    })
    expect(abortsAfter).toEqual([])
    expect(result2.abortedMerges).toEqual([])
  })

  test("crash blast radius bounded: done-by-commit intents are never re-driven -- only live-at-crash nodes re-run", () => {
    const project = ns({ project: "p1" })
    const reg = registry(project)
    const { git } = fakeGit({
      contains: { [`${project.runtimeRoot}|${project.integrationBranch}|shaDone`]: true },
    })
    const removed: string[] = []
    const intents: CrashIntent[] = [
      { project: "p1", sliceId: "done1", commitSha: "shaDone", worktreeDir: "/wt/p1/done1", phase: "running" },
      { project: "p1", sliceId: "live1", commitSha: "shaLive", worktreeDir: "/wt/p1/live1", phase: "running" },
    ]

    const result = reconcile({
      masterRoot: "/mh",
      registry: reg,
      intents,
      git,
      removeWorktree: (d) => removed.push(d),
    })

    expect(result.doneByCommit).toEqual(["p1/done1"])
    expect(result.redriven).toEqual(["p1/live1"])
    expect(result.redriven).not.toContain("p1/done1")
    expect(removed).toEqual(["/wt/p1/live1"])
    expect(result.discardedWorktrees).toEqual(["/wt/p1/live1"])
  })
})
