/**
 * dag.ts — the task-DAG artifact (spec N4, T3 plan): the planner Designer's
 * concrete output type, a total structural+graph validator, and (Task 2) the
 * wire codec that emits/parses it as a fenced block inside a Designer
 * payload. This is a LEAF module (imports only `die`/`log` from
 * `../bench/util.ts`) — nothing here couples to the scheduler; the T4 plan's
 * `dag-state.ts` imports `DagNode`/`TaskDag` from here on integration and
 * `runDag` calls `assertValidDag` as its single validation gate. See the T3
 * plan's Global Constraints for why the shape below is frozen byte-identical
 * to what T4 consumes (including the optional `mutatesDeps?`, which the
 * spec's own short-form omits but T4's scheduler enforces).
 */
import { die, log } from "../bench/util.ts"

export interface DagNode {
  id: string
  task: string
  deps: string[]
  files?: string[]
  mutatesDeps?: boolean
}

export interface TaskDag {
  nodes: DagNode[]
}

export interface DagValidation {
  ok: boolean
  errors: string[]
  warnings: string[]
}

/** Structural shape check for one candidate node — pushes to `errors` and
 * returns whether the node is well-formed enough to participate in the
 * id-set / dangling-dep / cycle checks below. Runs before anything else:
 * a node with a non-string `id` can't be reasoned about as a graph vertex. */
function checkNodeShape(n: unknown, errors: string[], index: number): n is DagNode {
  if (typeof n !== "object" || n === null) {
    errors.push(`node[${index}] is not an object`)
    return false
  }
  const rec = n as Record<string, unknown>
  let ok = true
  if (typeof rec.id !== "string" || rec.id.length === 0) {
    errors.push(`node[${index}]: id must be a non-empty string`)
    ok = false
  }
  if (typeof rec.task !== "string" || rec.task.length === 0) {
    errors.push(`node[${index}] (id=${String(rec.id)}): task must be a non-empty string`)
    ok = false
  }
  if (!Array.isArray(rec.deps) || !rec.deps.every((d) => typeof d === "string")) {
    errors.push(`node[${index}] (id=${String(rec.id)}): deps must be an array of strings`)
    ok = false
  }
  if (rec.files !== undefined && (!Array.isArray(rec.files) || !rec.files.every((f) => typeof f === "string"))) {
    errors.push(`node[${index}] (id=${String(rec.id)}): files must be an array of strings when present`)
    ok = false
  }
  if (rec.mutatesDeps !== undefined && typeof rec.mutatesDeps !== "boolean") {
    errors.push(`node[${index}] (id=${String(rec.id)}): mutatesDeps must be a boolean when present`)
    ok = false
  }
  return ok
}

/** Total structural + graph validation. Never throws — returns every
 * error/warning found so a gate2 revise can show the human all of them. */
export function validateDag(dag: unknown): DagValidation {
  const errors: string[] = []
  const warnings: string[] = []

  if (typeof dag !== "object" || dag === null || !("nodes" in dag)) {
    errors.push("dag must be an object with a 'nodes' array")
    return { ok: false, errors, warnings }
  }
  const nodesRaw = (dag as Record<string, unknown>).nodes
  if (!Array.isArray(nodesRaw)) {
    errors.push("dag.nodes must be an array")
    return { ok: false, errors, warnings }
  }
  if (nodesRaw.length === 0) {
    errors.push("dag.nodes must be non-empty")
    return { ok: false, errors, warnings }
  }

  // Shape check every node first — dangling/self/cycle checks below assume
  // string ids/deps and would otherwise throw or produce misleading errors.
  let shapeOk = true
  nodesRaw.forEach((n, i) => {
    if (!checkNodeShape(n, errors, i)) shapeOk = false
  })
  if (!shapeOk) return { ok: false, errors, warnings }

  const nodes = nodesRaw as DagNode[]

  // Id uniqueness.
  const seen = new Set<string>()
  const dups = new Set<string>()
  for (const n of nodes) {
    if (seen.has(n.id)) dups.add(n.id)
    seen.add(n.id)
  }
  for (const id of dups) errors.push(`duplicate node id: '${id}'`)
  if (dups.size > 0) return { ok: false, errors, warnings }

  const idSet = new Set(nodes.map((n) => n.id))

  // Dangling deps + self-deps (structurally sound ids at this point).
  for (const n of nodes) {
    for (const d of n.deps) {
      if (d === n.id) {
        errors.push(`self-dep: node '${n.id}' depends on itself`)
      } else if (!idSet.has(d)) {
        errors.push(`dangling dep: node '${n.id}' depends on unknown id '${d}'`)
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors, warnings }

  // Acyclic — Kahn's algorithm. If nodes remain after removing all
  // in-degree-0 nodes repeatedly, the remainder is a cycle.
  const inDegree = new Map<string, number>()
  const dependents = new Map<string, string[]>() // id -> ids that depend on it
  for (const n of nodes) {
    inDegree.set(n.id, n.deps.length)
    for (const d of n.deps) {
      dependents.set(d, [...(dependents.get(d) ?? []), n.id])
    }
  }
  const queue: string[] = [...idSet].filter((id) => inDegree.get(id) === 0)
  const removed = new Set<string>()
  while (queue.length > 0) {
    const id = queue.shift()!
    removed.add(id)
    for (const dep of dependents.get(id) ?? []) {
      const next = (inDegree.get(dep) ?? 0) - 1
      inDegree.set(dep, next)
      if (next === 0) queue.push(dep)
    }
  }
  const remaining = [...idSet].filter((id) => !removed.has(id))
  if (remaining.length > 0) {
    errors.push(`cycle detected among nodes: ${remaining.sort().join(", ")}`)
    return { ok: false, errors, warnings }
  }

  // Files-overlap (warning) — only computed once the graph is structurally
  // sound. Build reachability over `deps` (n reachable-from m iff m depends,
  // transitively, on n) so we can tell "concurrent" (neither reaches the
  // other) pairs apart from dependency-ordered pairs.
  const reachable = new Map<string, Set<string>>() // id -> set of ids it (transitively) depends on
  const depsOf = new Map(nodes.map((n) => [n.id, n.deps]))
  function reachableFrom(id: string): Set<string> {
    const cached = reachable.get(id)
    if (cached) return cached
    const acc = new Set<string>()
    for (const d of depsOf.get(id) ?? []) {
      acc.add(d)
      for (const r of reachableFrom(d)) acc.add(r)
    }
    reachable.set(id, acc)
    return acc
  }
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!
      const b = nodes[j]!
      const aReachesB = reachableFrom(a.id).has(b.id)
      const bReachesA = reachableFrom(b.id).has(a.id)
      if (aReachesB || bReachesA) continue // dependency-ordered — never concurrent
      const aFiles = new Set(a.files ?? [])
      const shared = (b.files ?? []).filter((f) => aFiles.has(f))
      if (shared.length > 0) {
        warnings.push(`files-overlap between concurrent nodes '${a.id}' and '${b.id}': ${shared.join(", ")}`)
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings }
}

/** Scheduler-boundary gate: `die` with the joined errors if invalid, else
 * `log` any warnings and return the typed dag. T4's `runDag` calls this. */
export function assertValidDag(dag: unknown): TaskDag {
  const v = validateDag(dag)
  if (!v.ok) die("invalid task-DAG:\n- " + v.errors.join("\n- "))
  for (const w of v.warnings) log("task-DAG warning: " + w)
  return dag as TaskDag
}
