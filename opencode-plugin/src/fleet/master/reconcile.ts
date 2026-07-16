/**
 * master/reconcile.ts — restart reconciliation: persisted namespace intent
 * vs GIT TRUTH (D9).
 *
 * D9 crash-consistency: git is the crash-consistent artifact store — the
 * integration branch's commits ARE the durable truth of completed nodes.
 * Anything before its atomic commit boundary is discarded, never consumed.
 * On restart, the master reconciles each project's in-flight intent against
 * that truth, per intent:
 *
 *   1. a partial merge (`MERGE_HEAD` present) never committed, so it never
 *      became truth — abort it.
 *   2. a node whose commit SHA IS already on the integration branch is
 *      DONE. Re-merging an applied commit is a no-op, so it is never
 *      re-driven — this is what bounds the crash blast radius to only what
 *      was actually live at crash time.
 *   3. anything else was live at crash: re-queue it, and discard any
 *      partial worktree it held (never resume from potentially-torn
 *      working-tree state; the DAG node is redriven from scratch instead).
 *
 * This is the MASTER/NAMESPACE-level wrapper: it walks a batch of
 * `CrashIntent`s (one per in-flight DAG node, across every registered
 * project) and applies the rule above per-project via the injected
 * `GitProbe`. Intra-DAG node state (which nodes were in flight, their
 * commit SHAs/worktree dirs) is owned by the self-hosting N5a per-project
 * reconciler — coordination with it is modeled here purely by the
 * `intents` input, so this module stays hermetic and non-duplicative of
 * N5a's own reconciliation.
 *
 * Pure / deterministic: `reconcile` is a synchronous, pure function of
 * `intents` + the injected `GitProbe` + `removeWorktree` seam — no LLM, no
 * network, no randomness, no hidden state carried between calls. Running
 * it twice on the same inputs yields the same `ReconcileResult`; `abortMerge`
 * is only invoked when `hasMergeHead` currently reports true, so a second
 * run against the (now-true) post-abort git state never double-aborts.
 */
import type { NamespaceRegistry } from "./namespace.ts"

export interface GitProbe {
  hasMergeHead(root: string): boolean
  branchContains(root: string, branch: string, sha: string): boolean
  abortMerge(root: string): void
}

export interface CrashIntent {
  project: string
  sliceId: string
  commitSha?: string
  worktreeDir?: string
  phase: "merging" | "running"
}

export interface ReconcileResult {
  abortedMerges: string[]
  doneByCommit: string[]
  redriven: string[]
  discardedWorktrees: string[]
}

export function reconcile(deps: {
  masterRoot: string
  registry: NamespaceRegistry
  intents: CrashIntent[]
  git: GitProbe
  removeWorktree: (dir: string) => void
}): ReconcileResult {
  const { registry, intents, git, removeWorktree } = deps
  const result: ReconcileResult = {
    abortedMerges: [],
    doneByCommit: [],
    redriven: [],
    discardedWorktrees: [],
  }

  for (const intent of intents) {
    const ns = registry.projects[intent.project]
    if (!ns) continue // unregistered project — nothing to reconcile against

    const id = `${intent.project}/${intent.sliceId}`

    if (intent.phase === "merging" && git.hasMergeHead(ns.runtimeRoot)) {
      git.abortMerge(ns.runtimeRoot)
      result.abortedMerges.push(id)
      continue
    }

    if (intent.commitSha && git.branchContains(ns.runtimeRoot, ns.integrationBranch, intent.commitSha)) {
      // Already on the integration branch — done. Re-driving would be a
      // no-op merge; skip it entirely so the blast radius stays bounded to
      // what was actually live at crash.
      result.doneByCommit.push(id)
      continue
    }

    // Live at crash: re-queue, and discard any partial worktree rather than
    // resuming from possibly-torn working-tree state.
    result.redriven.push(id)
    if (intent.worktreeDir) {
      removeWorktree(intent.worktreeDir)
      result.discardedWorktrees.push(intent.worktreeDir)
    }
  }

  return result
}
