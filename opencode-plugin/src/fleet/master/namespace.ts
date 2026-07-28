// master/namespace.ts — project-namespace registry (D8.3, D8.4).
//
// Multi-project under one master is a NAMESPACE, not a redesign. Each
// project gets an isolated runtimeRoot / worktreeBase / integrationBranch /
// credentialScope / gatePolicy / process-lifetime. This module is pure data
// + mechanical isolation validation; the scheduler (master/scheduler.ts)
// consumes the resulting registry.
//
// NOTE: this registry introduces NO new store-splitting axis (D6 is
// untouched) — it only records the outer namespace boundary that the
// existing account/project store layer already lives inside of.
//
// Single-writer (the singleton master) means no flock is required here,
// same rationale as master/gate-state.ts.

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { die, writeJsonAtomic } from "../../bench/util.ts"

/** `lifetime` defaults to "ephemeral" (D8.4) — a "daemon" project opts into
 * a longer-lived per-project sub-scheduler; the master itself is still the
 * only persistent authority (D8.1/D8.2). `credentialScope` is the
 * `fleet/*`-scoped non-admin credential id from self-hosting N2, never the
 * owner's admin identity. */
export interface ProjectNamespace {
  project: string
  runtimeRoot: string
  worktreeBase: string
  integrationBranch: string
  credentialScope: string
  gatePolicy: "root-human" | "auto"
  lifetime: "ephemeral" | "daemon"
}

export interface NamespaceRegistry {
  projects: Record<string, ProjectNamespace>
  globalCap: number
}

const DEFAULT_GLOBAL_CAP = 3

export function registryPath(masterRoot: string): string {
  return join(masterRoot, ".kkamak", "runtime", "master", "namespace-registry.json")
}

export function loadRegistry(masterRoot: string): NamespaceRegistry {
  const p = registryPath(masterRoot)
  if (!existsSync(p)) return { projects: {}, globalCap: DEFAULT_GLOBAL_CAP }
  const raw = JSON.parse(readFileSync(p, "utf8")) as NamespaceRegistry
  return {
    projects: raw.projects ?? {},
    globalCap: raw.globalCap ?? DEFAULT_GLOBAL_CAP,
  }
}

/** Pairwise disjointness predicate: two namespaces are isolation-OK iff they
 * share none of runtimeRoot / worktreeBase / integrationBranch /
 * credentialScope. Mechanical, not advisory (D8.3). */
export function isolationOk(a: ProjectNamespace, b: ProjectNamespace): boolean {
  return (
    a.runtimeRoot !== b.runtimeRoot &&
    a.worktreeBase !== b.worktreeBase &&
    a.integrationBranch !== b.integrationBranch &&
    a.credentialScope !== b.credentialScope
  )
}

/** Registers (or updates) a project namespace. Rejects — via `die` — a
 * namespace that collides with any OTHER existing project on any of
 * runtimeRoot / worktreeBase / integrationBranch / credentialScope
 * (D8.3 per-project isolation). Atomic write (D9). */
export function registerProject(
  masterRoot: string,
  ns: Omit<ProjectNamespace, "lifetime"> & { lifetime?: ProjectNamespace["lifetime"] },
): void {
  const withDefaults: ProjectNamespace = { ...ns, lifetime: ns.lifetime ?? "ephemeral" }
  const reg = loadRegistry(masterRoot)
  for (const [otherProject, other] of Object.entries(reg.projects)) {
    if (otherProject === withDefaults.project) continue
    if (!isolationOk(withDefaults, other)) {
      die(
        `registerProject: namespace collision between "${withDefaults.project}" and "${otherProject}" — ` +
          `runtimeRoot/worktreeBase/integrationBranch/credentialScope must be disjoint per-project (D8.3)`,
      )
    }
  }
  reg.projects[withDefaults.project] = withDefaults
  writeJsonAtomic(registryPath(masterRoot), reg)
}
