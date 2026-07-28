/**
 * squad-cli.ts — `squad-run` orchestration (spec §9.1): drives `runSquad` to
 * its next non-running outcome, checkpointing state to disk so a human gate
 * can be answered in a later, separate process invocation ("exit-and-wait").
 *
 * Reality-binding notes:
 *
 *  - squad.ts's `DriveFn` is keyed by PHASE ("analyzer" | "evaluator-spec" |
 *    "designer" | "implementer" | "evaluator-verdict") — see that file's
 *    header. `cmdRoleRun`/`roleSpec` only know the 4 wire SLOTS ("analyzer" |
 *    "designer" | "implementer" | "evaluator"); passing a phase straight
 *    through as `role` dies on "evaluator-spec"/"evaluator-verdict" (unknown
 *    fleet role). `roleForPhase` below does that phase→slot collapse before
 *    calling `cmdRoleRun`, same as `squad.ts`'s own internal `wireSlotFor`.
 *
 *  - Human-gate scoring is a CLI-layer responsibility (squad.ts's
 *    `answerGate` doc comment): resuming at a pending gate must score the
 *    gate's producer drive (`state.lastDriveId`) — good on approve, bad on
 *    revise, both under the gate's own name (`state.pendingGate.gate`) —
 *    BEFORE calling `answerGate`, mirroring `autoGate`'s scoring shape for
 *    the auto-policy path.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import {
  activeSquadVersion,
  readActiveSquadDef,
  readSquadDefVersion,
  recordSquadOutcome,
  type SquadDef,
} from "./squad-def.ts"
import {
  answerGate,
  newSquadState,
  runSquad,
  type DriveFn,
  type ScoreFn,
  type SquadOutcome,
  type SquadState,
} from "./squad.ts"
import { cmdRoleRun, type ExecFn } from "./run.ts"
import { cmdRoleScore, type FleetGate } from "./score.ts"
import { die, writeJsonAtomic } from "../bench/util.ts"

/** Collapse a squad.ts driving PHASE to the fleet role/wire SLOT `roleSpec`
 * (roles.ts) actually knows about. Mirrors squad.ts's private `wireSlotFor`
 * — kept as a separate copy here since that function isn't exported and the
 * two call sites want the mapping for different reasons (lint slot vs.
 * `cmdRoleRun`'s `role` argument). */
export function roleForPhase(phase: string): string {
  switch (phase) {
    case "evaluator-spec":
    case "evaluator-verdict":
      return "evaluator"
    default:
      return phase
  }
}

export function checkpointPath(project: string, sliceId: string): string {
  return join(
    project,
    ".kkamak",
    "runtime",
    "fleet",
    `squad-${sliceId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`,
  )
}

/**
 * On-disk checkpoint shape: `SquadState` plus a CLI-only sidecar field.
 * squad.ts's `SquadState` is the pure runner core's own state — it has no
 * notion of "which squad-def CANDIDATE VERSION produced this run" (that's a
 * squad-cli.ts / def-version-pin concern, spec §6 ch2 trial machinery), so
 * that pin rides along as an extra field on the same JSON blob rather than
 * growing the pure state type. `defVersion` undefined = this run was
 * unpinned (drove against whatever was active at the time).
 */
export interface SquadCheckpoint extends SquadState {
  defVersion?: string
}

export function saveCheckpoint(project: string, state: SquadState, defVersion?: string): void {
  const p = checkpointPath(project, state.sliceId)
  mkdirSync(dirname(p), { recursive: true })
  const checkpoint: SquadCheckpoint = defVersion !== undefined ? { ...state, defVersion } : state
  writeJsonAtomic(p, checkpoint)
}

export function loadCheckpoint(project: string, sliceId: string): SquadCheckpoint {
  const p = checkpointPath(project, sliceId)
  if (!existsSync(p)) die(`no checkpoint for slice '${sliceId}' at ${p}`)
  return JSON.parse(readFileSync(p, "utf-8")) as SquadCheckpoint
}

export async function cmdSquadRun(
  args: {
    project: string
    /** The CODE dir every role of this squad-run drives (`--dir`) — a
     * throwaway git worktree (spec N1) when self-hosting; defaults to
     * `project`. The ledger (checkpoint/pending/scored) stays under `project`
     * (runtimeRoot, N1b), so it survives the worktree's removal. */
    worktreeDir?: string
    sliceId: string
    slice?: string
    resume?: boolean
    gateAnswer?: string
    gatePolicy?: "root-human" | "auto"
    squadType?: string
    /** Flat per-squad model override (cli.ts's `--model`), forwarded
     * verbatim into every `cmdRoleRun` call the default DriveFn makes below.
     * Undefined (the default) leaves each role's own `spec.model` tiering
     * untouched — same fallback `cmdRoleRun` itself already does
     * (`args.model ?? spec.model`, run.ts:203). A flat override COLLAPSES
     * that per-role tiering onto one model for every role when set; that's
     * the accepted tradeoff for a single override (a per-role map is a
     * bigger, deferred design). */
    model?: string
    /** Pin this run to a specific squad-def CANDIDATE version instead of the
     * active one (spec §6 ch2 trial machinery — squad-trial drives runs
     * against a candidate before it's activated, and a human debugging a
     * specific candidate wants the same knob directly). An explicit
     * `--def-version` always wins; on `--resume` with this omitted, the
     * checkpoint's own pinned version (set by the run that created it) is
     * reused automatically — a paused trial run must never silently drift
     * onto whatever the active def happens to be by the time a gate answer
     * comes back. Undefined (the default) throughout a slice's whole
     * lifecycle preserves existing behavior: always read the active def. */
    defVersion?: string
    json?: boolean
  },
  driveFn?: DriveFn,
  scoreFn?: ScoreFn,
  /** Test-only seam: threaded into the default (non-injected) DriveFn's
   * `cmdRoleRun` call in place of `cmdRoleRun`'s own real default
   * (`bench/exec.ts`'s `runHost`, a genuine host spawn). Never passed by any
   * real (non-test) caller — `cli.ts`'s squad-run case calls `cmdSquadRun`
   * with just the args object, so prod behavior is byte-identical to before
   * this param existed. Exists so tests can drive the REAL default DriveFn
   * closure (including the `model` forwarding above) hermetically, the same
   * way `fleet-e2e.test.ts` already injects an `ExecFn` through
   * `cmdRoleRun` directly — without duplicating this closure's logic in
   * test code or resorting to module mocking. */
  execFn?: ExecFn,
): Promise<SquadOutcome> {
  const squadType = args.squadType ?? "standard"

  const drive: DriveFn =
    driveFn ??
    (async (phase, input, sliceId) => {
      const role = roleForPhase(phase)
      const r = await cmdRoleRun(
        {
          project: args.project,
          worktreeDir: args.worktreeDir,
          role,
          input,
          model: args.model,
          sliceId,
          nodePath: `root/${sliceId}/${phase}`,
          // Each squad-run outcome drives several role-runs; only the final
          // outcome JSON (cmdSquadRun's own console.log below) should land
          // on stdout, or it's not machine-parseable (task-8 concern #3).
          silent: true,
        },
        execFn,
      )
      return { id: r.id, payload: r.payload }
    })
  const score: ScoreFn =
    scoreFn ??
    (async (id, verdict, gate) => {
      await cmdRoleScore({ project: args.project, id, verdict, gate: gate as FleetGate })
    })

  let state: SquadState
  // The CONCRETE def version this run's whole lifecycle is pinned to (spec §6
  // ch2 def-version pin; Fix 1 — version drift). Resolved ONCE, at run start,
  // and threaded into BOTH the flow execution and `recordSquadOutcome` so a
  // slice can never split across two defs:
  //  - an explicit `--def-version` always wins;
  //  - a fresh UNPINNED run captures `activeSquadVersion` NOW (run time), not
  //    at record time — the runner is exit-and-wait, so `/mh-activate` can
  //    promote a new version between a gate pause and its resume; recording
  //    to whatever happens to be active by then would credit/blame a def that
  //    never ran this slice, polluting the score.json squad-trial reads;
  //  - a `--resume` inherits the version the checkpoint itself carries (set by
  //    the run that first created it), so a paused run stays on its original
  //    def regardless of what got activated in between.
  let pinnedDefVersion: string | undefined = args.defVersion
  if (args.resume) {
    const checkpoint = loadCheckpoint(args.project, args.sliceId)
    if (args.gateAnswer !== "approve" && args.gateAnswer !== "revise") {
      die("--resume requires --gate-answer approve|revise")
    }
    if (!checkpoint.pendingGate) {
      die(`checkpoint for slice '${args.sliceId}' has no pending gate — nothing to resume`)
    }
    if (!checkpoint.lastDriveId) {
      die(`checkpoint for slice '${args.sliceId}' is missing its pending gate's producer drive id`)
    }
    // Prefer the checkpoint's own captured version. `?? activeSquadVersion`
    // is a backward-compat fallback for pre-Fix-1 checkpoints written without
    // a resolved version — such a checkpoint could still drift, but a fresh
    // run created after this fix always carries a concrete version.
    pinnedDefVersion = args.defVersion ?? checkpoint.defVersion ?? activeSquadVersion(squadType)
    // BEFORE answerGate: score the gate's producer drive — approve → good,
    // revise → bad — under the gate's own name (squad.ts's `answerGate`
    // doc comment; mirrors `autoGate`'s scoring shape for the auto path).
    await score(checkpoint.lastDriveId, args.gateAnswer === "revise" ? "bad" : "good", checkpoint.pendingGate.gate)
    state = answerGate(checkpoint, args.gateAnswer)
  } else {
    if (!args.slice) die("fresh squad-run requires a slice (text or --slice-file)")
    // Resolve the active pointer to a CONCRETE version now, at run start, so
    // the whole slice lifecycle (including any later resume + record) is
    // pinned to it and can't drift onto a mid-run activation.
    pinnedDefVersion = args.defVersion ?? activeSquadVersion(squadType)
    state = newSquadState(args.sliceId, args.slice)
  }

  // pinnedDefVersion is now always concrete; readSquadDefVersion reads that
  // exact candidate's def. (readActiveSquadDef stays only as a defensive
  // fallback for the theoretically-impossible undefined case.)
  let def: SquadDef =
    pinnedDefVersion !== undefined ? readSquadDefVersion(squadType, pinnedDefVersion) : readActiveSquadDef(squadType)
  // root-human (default) is an instance-position override (spec §1.5 rule
  // 4): it overrides BOTH gates to human regardless of what the def itself
  // says. "auto" leaves the def's own gatePolicy untouched.
  if ((args.gatePolicy ?? "root-human") === "root-human") {
    def = { ...def, flow: { ...def.flow, gatePolicy: { gate1: "human", gate2: "human" } } }
  }

  const result = await runSquad(state, def, drive, score)

  // Channel 2 — squad-level fitness (spec §6, D5 table): `done` → squad def
  // GOOD, an `Exhausted` escalation → squad def BAD. Every other exit
  // (a gate pause, or an escalation of any OTHER type — Clarify/
  // DesignDecision/Infeasible/Refused) is deliberately NOT recorded here
  // (neutral or scored elsewhere — see squad-def.ts's channel-2 section).
  // This is the single exit point both a fresh run and a `--resume`
  // continuation converge on, so a resumed run that lands on done/Exhausted
  // is recorded exactly the same way. `pinnedDefVersion` routes the record
  // to the def version that actually RAN (undefined = active, unchanged).
  const outcome = result.outcome
  if (outcome.status === "done" || (outcome.status === "escalation" && outcome.escalation.type === "Exhausted")) {
    recordSquadOutcome(
      squadType,
      {
        sliceId: args.sliceId,
        passed: outcome.status === "done",
        steps: result.state.counters.steps,
        escalationType: outcome.status === "escalation" ? outcome.escalation.type : undefined,
        nodePath: `root/${args.sliceId}`,
        ts: new Date().toISOString(),
      },
      pinnedDefVersion,
    )
  }

  saveCheckpoint(args.project, result.state, pinnedDefVersion)
  console.log(JSON.stringify(result.outcome))
  return result.outcome
}
