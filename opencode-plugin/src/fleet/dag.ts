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

// ── Wire codec — emit/parse the Designer's fenced dag block ────────────────
//
// Two representations, one type (T3 plan Global Constraints): the WIRE form
// (a fenced ```dag block inside the Designer's markdown payload) and the
// ARTIFACT form (a raw {nodes:[...]} JSON file — T4's --dag-file) both
// resolve to the identical TaskDag; both funnel through assertValidDag. This
// section owns the wire parse only.

/** The fenced-block language tag the planner Designer emits under `## Task DAG`. */
export const DAG_FENCE = "dag"
export const DAG_HEADING = "## Task DAG"

/** Canonical emit: the `## Task DAG` heading + a fenced dag JSON block (tag
 * = DAG_FENCE). Used by the persona example, round-trip tests, and to author
 * a T4 `--dag-file` (whose bare form is `JSON.stringify(dag, null, 2)`). */
export function formatDagBlock(dag: TaskDag): string {
  return `${DAG_HEADING}\n\`\`\`${DAG_FENCE}\n${JSON.stringify(dag, null, 2)}\n\`\`\`\n`
}

/** Extract the inner text of the first fenced block tagged `lang`, or
 * undefined if none is found. */
function extractFence(payload: string, lang: string): string | undefined {
  const re = new RegExp("```" + lang + "\\s*\\n([\\s\\S]*?)```", "m")
  const m = re.exec(payload)
  return m ? m[1] : undefined
}

/** Shape-check only (field types) — delegates graph checks (cycle/dangling/
 * dup) to `validateDag`/`assertValidDag`. */
function checkTaskDagShape(v: unknown): v is TaskDag {
  if (typeof v !== "object" || v === null) return false
  const nodes = (v as Record<string, unknown>).nodes
  if (!Array.isArray(nodes)) return false
  return nodes.every((n) => {
    if (typeof n !== "object" || n === null) return false
    const rec = n as Record<string, unknown>
    if (typeof rec.id !== "string" || typeof rec.task !== "string") return false
    if (!Array.isArray(rec.deps) || !rec.deps.every((d) => typeof d === "string")) return false
    if (rec.files !== undefined && (!Array.isArray(rec.files) || !rec.files.every((f) => typeof f === "string"))) {
      return false
    }
    if (rec.mutatesDeps !== undefined && typeof rec.mutatesDeps !== "boolean") return false
    return true
  })
}

/** Extract + JSON-parse + SHAPE-check the DAG block out of a Designer role
 * payload (prose may surround it). Prefers a fenced dag block; falls back to
 * a fenced json block (proposer-drift leniency, mirrors parseVerdict's
 * tolerance). Returns the shaped TaskDag or a parse/shape error — does NOT
 * run graph validation (that is `dagFromApprovedPayload`/`assertValidDag`). */
export function parseDagFromPayload(payload: string): { ok: true; dag: TaskDag } | { ok: false; error: string } {
  const inner = extractFence(payload, DAG_FENCE) ?? extractFence(payload, "json")
  if (inner === undefined) {
    return { ok: false, error: `no fenced \`\`\`${DAG_FENCE}\` (or \`\`\`json) block found in payload` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(inner)
  } catch (e) {
    return { ok: false, error: `malformed JSON in dag block: ${(e as Error).message}` }
  }
  if (!checkTaskDagShape(parsed)) {
    return { ok: false, error: "dag block does not match the {nodes:[{id,task,deps,files?,mutatesDeps?}]} shape" }
  }
  return { ok: true, dag: parsed }
}

/** Gate2 sink: parse the approved Designer payload AND fully validate it.
 * `die`s on either a parse failure or an invalid DAG — nothing invalid ever
 * reaches the scheduler. The T4 `--feature` glue calls this on approve. */
export function dagFromApprovedPayload(payload: string): TaskDag {
  const r = parseDagFromPayload(payload)
  if (!r.ok) die("gate2: no valid task-DAG in the approved plan — " + r.error)
  return assertValidDag(r.dag)
}

/** Verbatim wire-contract detail (block format + a literal example) that the
 * planner Designer's contract.md must show — the generator must SEE the
 * exact `{id,task,deps,files?,mutatesDeps?}` format, not infer it (spec
 * §1.5 wire-visibility). Imported by squad-def.ts's renderWireContract in
 * Task 3. */
export function dagContractText(): string {
  const example: TaskDag = {
    nodes: [
      { id: "a", task: "build worktree primitive", deps: [] },
      { id: "b", task: "build dag schema", deps: [] },
      { id: "c", task: "wire scheduler", deps: ["a", "b"], files: ["src/fleet/dag-scheduler.ts"], mutatesDeps: false },
    ],
  }
  return [
    "",
    `## ${DAG_HEADING.replace(/^##\s*/, "")} — required block format`,
    "",
    `Emit the task-DAG as a \`${DAG_HEADING}\` heading followed by a fenced \`\`\`${DAG_FENCE}\` block`,
    "containing JSON of shape `{nodes: DagNode[]}`, where each `DagNode` is:",
    "",
    "```",
    "{ id: string, task: string, deps: string[], files?: string[], mutatesDeps?: boolean }",
    "```",
    "",
    "- `id` — unique node id.",
    "- `task` — one-line task description.",
    "- `deps` — ids of nodes that must complete first (empty array if none).",
    "- `files` — optional list of files this node is expected to touch (helps the",
    "  scheduler and the human spot merge-conflict risk between concurrent nodes).",
    "- `mutatesDeps` — optional boolean; set true if this node changes shared",
    "  dependency files (e.g. package.json/bun.lock*) so the scheduler can",
    "  serialize it against other dep-mutating nodes.",
    "",
    "Example:",
    "",
    formatDagBlock(example).trimEnd(),
    "",
  ].join("\n")
}
