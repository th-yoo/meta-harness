import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  isolationOk,
  loadRegistry,
  registerProject,
  registryPath,
  type ProjectNamespace,
} from "../src/fleet/master/namespace.ts"

describe("master/namespace", () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mh-master-ns-"))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

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

  test("registryPath is under .kkamak/runtime/master/ of masterRoot", () => {
    const p = registryPath(root)
    expect(p).toContain(join(root, ".kkamak", "runtime", "master"))
  })

  test("loadRegistry defaults sanely when missing", () => {
    const reg = loadRegistry(root)
    expect(reg).toEqual({ projects: {}, globalCap: 3 })
  })

  test("register two projects with disjoint roots/branches/creds → both present", () => {
    registerProject(root, ns({ project: "projA" }))
    registerProject(root, ns({ project: "projB" }))
    const reg = loadRegistry(root)
    expect(Object.keys(reg.projects).sort()).toEqual(["projA", "projB"])
    expect(reg.projects.projA.project).toBe("projA")
    expect(reg.projects.projB.project).toBe("projB")
  })

  test("re-registering the same project upserts without self-collision", () => {
    registerProject(root, ns({ project: "projX", gatePolicy: "root-human" }))
    expect(() =>
      registerProject(root, ns({ project: "projX", gatePolicy: "auto" })),
    ).not.toThrow()
    const reg = loadRegistry(root)
    const projXKeys = Object.keys(reg.projects).filter((k) => k === "projX")
    expect(projXKeys).toHaveLength(1)
    expect(reg.projects.projX.gatePolicy).toBe("auto")
  })

  test("lifetime defaults to 'ephemeral' when omitted", () => {
    const full = ns({ project: "projC" })
    // simulate omission by constructing without `lifetime`
    const { lifetime, ...rest } = full
    registerProject(root, rest as Omit<ProjectNamespace, "lifetime">)
    const reg = loadRegistry(root)
    expect(reg.projects.projC.lifetime).toBe("ephemeral")
  })

  test("globalCap persists and defaults sanely (3)", () => {
    registerProject(root, ns({ project: "projD" }))
    const reg = loadRegistry(root)
    expect(reg.globalCap).toBe(3)
  })

  test("isolation enforced: reusing another project's integrationBranch dies", () => {
    registerProject(root, ns({ project: "projE" }))
    expect(() =>
      registerProject(
        root,
        ns({ project: "projF", integrationBranch: "int/projE" }),
      ),
    ).toThrow()
  })

  test("isolation enforced: reusing another project's runtimeRoot dies", () => {
    registerProject(root, ns({ project: "projG" }))
    expect(() =>
      registerProject(root, ns({ project: "projH", runtimeRoot: "/rt/projG" })),
    ).toThrow()
  })

  test("isolation enforced: reusing another project's credentialScope dies", () => {
    registerProject(root, ns({ project: "projI" }))
    expect(() =>
      registerProject(root, ns({ project: "projJ", credentialScope: "cred/projI" })),
    ).toThrow()
  })

  test("isolation enforced: reusing another project's worktreeBase dies", () => {
    registerProject(root, ns({ project: "projK" }))
    expect(() =>
      registerProject(root, ns({ project: "projL", worktreeBase: "/wt/projK" })),
    ).toThrow()
  })

  test("isolationOk: disjoint namespaces are ok", () => {
    const a = ns({ project: "projM" })
    const b = ns({ project: "projN" })
    expect(isolationOk(a, b)).toBe(true)
  })

  test("isolationOk: colliding namespaces are not ok", () => {
    const a = ns({ project: "projO" })
    const b = ns({ project: "projP", runtimeRoot: a.runtimeRoot })
    expect(isolationOk(a, b)).toBe(false)
  })
})
