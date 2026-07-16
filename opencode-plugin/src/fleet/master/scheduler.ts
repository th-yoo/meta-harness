// master/scheduler.ts — deterministic composite scheduler (D8.1, D8.2, D8.4).
//
// Singleton authority, COMPOSITE SCHEDULING — not composite AUTHORITY
// (D8.2). `admit` selects ready per-project run-requests under one global
// resource cap, fair-share so a single project can't monopolize the cap,
// and spawns each admitted request through an INJECTED, EPHEMERAL
// `SubScheduler` (the self-hosting `fleet-dev` DAG scheduler, consumed as a
// seam here). Every admitted run is a fresh ephemeral `sub` call — the
// master never forks a second persistent authority; the composite
// recurses, authority does not.
//
// Deterministic: no LLM, no randomness, no wall-clock dependence. Selection
// order is a pure function of the registry + request list (fair-share
// round-robin across distinct project keys, tie-broken by project key then
// sliceId).

import type { NamespaceRegistry, ProjectNamespace } from "./namespace.ts"
import type { SquadOutcome } from "../squad.ts"

export interface RunRequest {
  project: string
  feature: string
  sliceId: string
}

/** The injected, EPHEMERAL per-project executor — the self-hosting
 * T4/N5a `fleet-dev` DAG scheduler. Spawned fresh per admitted request; it
 * holds no persistent authority (D8.2). */
export type SubScheduler = (req: RunRequest & { ns: ProjectNamespace }) => Promise<SquadOutcome>

export interface AdmitResult {
  admitted: RunRequest[]
  deferred: RunRequest[]
  outcomes: Array<{ req: RunRequest; outcome: SquadOutcome }>
}

/** Admits up to `registry.globalCap` requests from `requests`, fair-share
 * round-robin across distinct project keys so N requests from one project
 * never starve another project's share of the cap. Requests naming an
 * unregistered project are filtered out up front and are ALWAYS deferred —
 * never run, regardless of cap slack. Deterministic tie-break: projects
 * are visited in ascending project-key order, and within a project,
 * requests are visited in the order registered for that key which is a
 * stable sort by sliceId — one request is taken per project per round,
 * cycling until the cap is hit or all requests are exhausted. */
export async function admit(
  deps: { registry: NamespaceRegistry; sub: SubScheduler },
  requests: RunRequest[],
): Promise<AdmitResult> {
  const { registry, sub } = deps

  const registered = requests.filter((r) => registry.projects[r.project] !== undefined)
  const unregistered = requests.filter((r) => registry.projects[r.project] === undefined)

  // Group registered requests by project, preserving arrival order within
  // a project but presenting a per-project queue sorted by sliceId for a
  // fully deterministic tie-break independent of input order.
  const byProject = new Map<string, RunRequest[]>()
  for (const r of registered) {
    const bucket = byProject.get(r.project)
    if (bucket) bucket.push(r)
    else byProject.set(r.project, [r])
  }
  for (const bucket of byProject.values()) {
    bucket.sort((a, b) => (a.sliceId < b.sliceId ? -1 : a.sliceId > b.sliceId ? 1 : 0))
  }

  const projectKeys = [...byProject.keys()].sort()

  const admitted: RunRequest[] = []
  const deferredRegistered: RunRequest[] = []

  // Fair-share round-robin: repeatedly sweep the sorted project keys,
  // taking at most one request per project per sweep, until the cap is
  // reached or every per-project queue is empty.
  let remaining = registered.length > 0
  while (remaining && admitted.length < registry.globalCap) {
    remaining = false
    for (const key of projectKeys) {
      if (admitted.length >= registry.globalCap) break
      const bucket = byProject.get(key)!
      if (bucket.length === 0) continue
      admitted.push(bucket.shift()!)
      if (bucket.length > 0) remaining = true
    }
  }

  // Anything left in per-project queues after the cap is hit is deferred.
  for (const key of projectKeys) {
    const bucket = byProject.get(key)!
    deferredRegistered.push(...bucket)
  }

  const deferred = [...deferredRegistered, ...unregistered]

  const outcomes = await Promise.all(
    admitted.map(async (req) => {
      const ns = registry.projects[req.project]!
      const outcome = await sub({ ...req, ns })
      return { req, outcome }
    }),
  )

  return { admitted, deferred, outcomes }
}
