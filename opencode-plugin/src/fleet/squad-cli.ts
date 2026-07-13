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
import { readActiveSquadDef, type SquadDef } from "./squad-def.ts"
import {
  answerGate,
  newSquadState,
  runSquad,
  type DriveFn,
  type ScoreFn,
  type SquadOutcome,
  type SquadState,
} from "./squad.ts"
import { cmdRoleRun } from "./run.ts"
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
    ".meta-harness",
    "runtime",
    "fleet",
    `squad-${sliceId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`,
  )
}

export function saveCheckpoint(project: string, state: SquadState): void {
  const p = checkpointPath(project, state.sliceId)
  mkdirSync(dirname(p), { recursive: true })
  writeJsonAtomic(p, state)
}

export function loadCheckpoint(project: string, sliceId: string): SquadState {
  const p = checkpointPath(project, sliceId)
  if (!existsSync(p)) die(`no checkpoint for slice '${sliceId}' at ${p}`)
  return JSON.parse(readFileSync(p, "utf-8")) as SquadState
}

export async function cmdSquadRun(
  args: {
    project: string
    sliceId: string
    slice?: string
    resume?: boolean
    gateAnswer?: string
    gatePolicy?: "root-human" | "auto"
    squadType?: string
    json?: boolean
  },
  driveFn?: DriveFn,
  scoreFn?: ScoreFn,
): Promise<SquadOutcome> {
  let def: SquadDef = readActiveSquadDef(args.squadType ?? "standard")
  // root-human (default) is an instance-position override (spec §1.5 rule
  // 4): it overrides BOTH gates to human regardless of what the def itself
  // says. "auto" leaves the def's own gatePolicy untouched.
  if ((args.gatePolicy ?? "root-human") === "root-human") {
    def = { ...def, flow: { ...def.flow, gatePolicy: { gate1: "human", gate2: "human" } } }
  }

  const drive: DriveFn =
    driveFn ??
    (async (phase, input, sliceId) => {
      const role = roleForPhase(phase)
      const r = await cmdRoleRun({
        project: args.project,
        role,
        input,
        sliceId,
        nodePath: `root/${sliceId}/${phase}`,
        // Each squad-run outcome drives several role-runs; only the final
        // outcome JSON (cmdSquadRun's own console.log below) should land on
        // stdout, or it's not machine-parseable (task-8 concern #3).
        silent: true,
      })
      return { id: r.id, payload: r.payload }
    })
  const score: ScoreFn =
    scoreFn ??
    (async (id, verdict, gate) => {
      await cmdRoleScore({ project: args.project, id, verdict, gate: gate as FleetGate })
    })

  let state: SquadState
  if (args.resume) {
    state = loadCheckpoint(args.project, args.sliceId)
    if (args.gateAnswer !== "approve" && args.gateAnswer !== "revise") {
      die("--resume requires --gate-answer approve|revise")
    }
    if (!state.pendingGate) {
      die(`checkpoint for slice '${args.sliceId}' has no pending gate — nothing to resume`)
    }
    if (!state.lastDriveId) {
      die(`checkpoint for slice '${args.sliceId}' is missing its pending gate's producer drive id`)
    }
    // BEFORE answerGate: score the gate's producer drive — approve → good,
    // revise → bad — under the gate's own name (squad.ts's `answerGate`
    // doc comment; mirrors `autoGate`'s scoring shape for the auto path).
    await score(state.lastDriveId, args.gateAnswer === "revise" ? "bad" : "good", state.pendingGate.gate)
    state = answerGate(state, args.gateAnswer)
  } else {
    if (!args.slice) die("fresh squad-run requires a slice (text or --slice-file)")
    state = newSquadState(args.sliceId, args.slice)
  }

  const result = await runSquad(state, def, drive, score)
  saveCheckpoint(args.project, result.state)
  console.log(JSON.stringify(result.outcome))
  return result.outcome
}
