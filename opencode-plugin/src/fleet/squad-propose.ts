/**
 * squad-propose.ts — tier-2 flow-knob proposer for a squad def (spec
 * §1.5.1 + §6 channel 2): `squad-propose` spawns ONE one-shot opencode
 * session that mutates `flow` (bounds/gatePolicy/reentry) on the ACTIVE
 * squad.json and nothing else, validates the mutation is knob-only, and —
 * only if valid — writes a new INACTIVE candidate version. It never
 * activates anything (activation is a separate, human-gated step, same as
 * the tier-1 role proposer's account-layer candidates in propose.ts).
 *
 * Reality-binding notes:
 *
 *  - This is deliberately NOT propose.ts's Task-Agent flow (that's an
 *    in-plugin, host-mediated session with a `stageArtifactApply` detach
 *    path for Claude Code). A squad def has no plugin host to run inside —
 *    `squad-propose` is a plain CLI subcommand (bench/cli.ts), so it spawns
 *    a real `opencode run --dir <scratch> --auto --format json --model M
 *    <prompt>` one-shot exactly like bench/opencode-run.ts's
 *    `runJudgeOpencode` does for the judge transport: a fresh `mkdtempSync`
 *    scratch `--dir` (the session workspace, never the store), spawned via
 *    an injectable `ExecFn` (fleet/run.ts's type — `cmdRoleRun` and
 *    `cmdSquadRun`'s default DriveFn both already thread this same seam),
 *    default = `bench/exec.ts`'s `runHost` (the project's single spawn
 *    funnel).
 *
 *  - The prompt does not ask the model to answer on stdout — it asks it to
 *    WRITE two files (a diagnosis .md, then the complete squad.json) to
 *    absolute paths named in the prompt, using its own file tools. This
 *    mirrors propose.ts's `cat > path << EOF` convention (proven to work
 *    against a real `--auto` opencode session) rather than parsing NDJSON
 *    stdout for a payload — there is no wire contract here, just two files.
 *
 *  - "Poll ≤ timeoutSec for the staged file" (task brief): the exec call
 *    itself already blocks until the child exits or `runHost`'s own
 *    `opts.timeoutSec` timer fires, so in the common case the staged file
 *    is already on disk the instant `execFn` resolves. The poll after that
 *    is a bounded grace period (remaining budget only, never doubling the
 *    wait) for the rare case a session's last write hasn't synced to a
 *    stat() yet. A hermetic test `execFn` that never writes anything
 *    exhausts this and `cmdSquadPropose` dies cleanly — no real opencode
 *    process is ever spawned in tests.
 *
 *  - Validation is hard-fail, all-errors-listed (never partial): a proposed
 *    def that mutates `type`/`slots`/`wire` OR puts a bound/enum out of
 *    range is rejected wholesale — NOTHING is written (no candidate
 *    directory, no diagnosis copy) and the active def is never touched.
 *    v1 rule (spec §1.5.1): only `flow` is tier-2 evolvable; `type`/
 *    `slots`/`wire` are tier-3 structure, frozen to this proposer.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import {
  readActiveSquadDef, squadRoot, activeSquadVersion,
  type SquadDef, type SquadOutcomeRecord,
} from "./squad-def.ts"
import { accountRoleRoot, activeVersion, candidatePath, nextVersion, readScore } from "../harness-store.ts"
import { runHost } from "../bench/exec.ts"
import { die, log, writeJsonAtomic, writeTextAtomic } from "../bench/util.ts"
import { sandboxEnv } from "./sandbox.ts"
import type { RoleSpec } from "./roles.ts"
import type { ExecFn } from "./run.ts"

/**
 * Synthetic bash:allow `RoleSpec` used ONLY to reach `sandboxEnv`'s existing
 * credential scrub (fleet/sandbox.ts, same mechanism `fleet/run.ts`'s
 * `cmdRoleRun` applies to the implementer/evaluator roles). The proposer
 * spawns its own one-shot `opencode run --dir <scratch> --auto` child (this
 * module's header, "Reality-binding notes") — it has no `FleetRoleName` of
 * its own (it drives a scratch dir, not a rendered role persona) but
 * legitimately needs bash+write (it stages squad.json/diagnosis.md via
 * heredoc) and, exactly like an implementer/evaluator drive, would
 * otherwise inherit the operator's ambient env (GH_TOKEN/SSH_AUTH_SOCK/git
 * credential-helper) and could write outside its scratch dir or exfiltrate
 * secrets. `sandboxEnv` only reads `spec.permission["bash"]` — the rest of
 * this object exists purely to satisfy `RoleSpec`'s shape and is otherwise
 * unused.
 */
const PROPOSER_SANDBOX_SPEC: RoleSpec = {
  role: "implementer",
  agent: "squad-propose",
  description: "squad-def flow-knob proposer one-shot session (synthetic — not a rendered fleet role)",
  mode: "all",
  model: "n/a",
  temperature: 0,
  permission: { bash: "allow", write: "allow" },
}

export interface SquadProposeResult {
  version: string
  def: SquadDef
}

/** Real default: same `runHost` funnel `fleet/run.ts`'s `defaultExec` binds
 * (that binding itself isn't exported — this mirrors it locally rather than
 * reaching for a private symbol). Tests always inject their own `execFn`. */
const defaultExec: ExecFn = (argv, opts) => runHost(argv, { timeoutSec: opts.timeoutSec, env: opts.env })

/** Next candidate version for a squad-def store — thin wrapper around
 * harness-store.ts's generic `nextVersion` (max existing `vN` + 1, gaps
 * tolerated — never fills a gap). Exists as its own export because callers
 * of THIS module think in squad `type`, not raw store roots. */
export function nextSquadVersion(type: string): string {
  return nextVersion(squadRoot(type))
}

/** score.json shape at squadRoot(type)/candidates/<version>/score.json —
 * same shape squad-def.ts's `recordSquadOutcome` writes (deliberately
 * identical to harness-store's `CandidateScore`, per that file's comment),
 * read here with the squad-specific `SquadOutcomeRecord` session type
 * instead of a role's `SessionRecord` so the evidence lines below can read
 * `sliceId`/`escalationType` typed. */
interface SquadScoreEvidence {
  version: string
  nPass: number
  nFail: number
  sessions: SquadOutcomeRecord[]
}

function readSquadScoreEvidence(type: string, version: string): SquadScoreEvidence {
  const p = candidatePath(squadRoot(type), version, "score.json")
  if (!existsSync(p)) return { version, nPass: 0, nFail: 0, sessions: [] }
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as SquadScoreEvidence
  } catch {
    return { version, nPass: 0, nFail: 0, sessions: [] }
  }
}

/** How many most-recent sessions to show verbatim in the prompt — enough to
 * be evidence, not so many the prompt balloons (same "index, not evidence
 * dump" spirit as propose.ts's failing-trajectory excerpts). */
const MAX_SESSIONS_SHOWN = 20

/**
 * Build the proposer's one-shot prompt: active squad.json verbatim, squad-
 * level outcome evidence (score.json sessions at the ACTIVE version), a
 * one-liner member aggregate per agent-kind role slot, the flow-knob
 * semantics cheat-sheet (spec §1.5.1's table), and the write instructions.
 * `stagingPath` is where the complete squad.json must land; the diagnosis
 * markdown goes to the literal sibling path `${stagingPath}.diagnosis.md`.
 */
export function buildSquadProposerPrompt(type: string, active: SquadDef, stagingPath: string): string {
  const version = activeSquadVersion(type)
  const evidence = readSquadScoreEvidence(type, version)
  const sessionLines = evidence.sessions
    .slice(-MAX_SESSIONS_SHOWN)
    .map((s) =>
      `- sliceId=${s.sliceId} passed=${s.passed} steps=${s.steps}` +
      (s.escalationType ? ` escalationType=${s.escalationType}` : ""),
    )
  const sessionsSection = sessionLines.length
    ? sessionLines.join("\n")
    : "(no scored sessions yet for this squad-def version — propose conservatively)"

  const memberLines: string[] = []
  for (const [role, slot] of Object.entries(active.slots)) {
    if (slot.kind !== "agent") continue
    const root = accountRoleRoot(`mh-${slot.role}`)
    const ver = activeVersion(root)
    const s = readScore(root, ver)
    memberLines.push(`- ${role} (mh-${slot.role} ${ver}): nPass=${s.nPass} nFail=${s.nFail}`)
  }
  const membersSection = memberLines.length ? memberLines.join("\n") : "(no agent-kind slots found)"

  const diagnosisPath = `${stagingPath}.diagnosis.md`

  return `# Squad-def proposer — tier-2 flow-knob evolution (spec §1.5.1, §6 channel 2)

You are proposing ONE candidate mutation of the '${type}' squad's FLOW KNOBS —
never its structure. Whether an edge EXISTS is code's frozen decision; how
often it fires, who approves, and what re-entry carries are flow's evolvable
decisions. The squad def is this node's OWN evolvable artifact (§6): a
\`done\` outcome is good fitness for it, an \`Exhausted\` escalation is bad.

## Active squad.json (version ${version}) — verbatim

\`\`\`json
${JSON.stringify(active, null, 2)}
\`\`\`

## Squad-level outcome evidence — score.json sessions, active version ${version}

${sessionsSection}

## Member aggregates — one line per role, from that role's OWN active-version store

${membersSection}

## Flow-knob semantics cheat-sheet (spec §1.5.1 — read before proposing)

| Field | Parameterizes | §3 rules |
|---|---|---|
| \`bounds.R1\` | in-slot retries (self-check redo, syntax redo) — a SHARED counter for the evaluator across its spec-authoring and verdict modes | 1, 4, 8, 9 |
| \`bounds.R2\` | upstream hops (ambiguity, design-decision, FAIL-design/intent) | 5, 7, 11, 12 |
| \`bounds.R3\` | macro loop (FAIL-impl → Implementer) | 10 |
| \`bounds.globalBudgetSteps\` | whole-squad hard cap (ping-pong backstop) | 14 |
| \`gatePolicy.gate1\` / \`gatePolicy.gate2\` | who decides at each gate: \`"human"\` pauses for a person, \`"auto"\` auto-approves / auto-picks the recommended alternative | §3.4 |
| \`reentry\` | \`"delta"\` — upstream re-entry carries {prior artifact + question}, expects a REVISION, not a rewrite; \`"full"\` — regenerate from scratch | §3.7-2 |

## Your task

Propose exactly ONE mutation of \`flow\` (bounds / gatePolicy / reentry) and
nothing else. \`type\`, \`slots\`, and \`wire\` are FROZEN for this proposer —
copy them into your output UNCHANGED, verbatim.

Legal ranges (a mutation outside these is rejected outright, no candidate
written):
- \`bounds.R1\`, \`bounds.R2\`, \`bounds.R3\`: integers in [1, 10]
- \`bounds.globalBudgetSteps\`: integer in [10, 200]
- \`gatePolicy.gate1\`, \`gatePolicy.gate2\`: \`"human"\` | \`"auto"\`
- \`reentry\`: \`"delta"\` | \`"full"\`

## Write the results

**Required FIRST** — write your diagnosis (which evidence above motivates
this change, and why this knob specifically) to the sibling markdown file,
starting with a \`## Diagnosis\` heading:

\`\`\`bash
mkdir -p "$(dirname "${diagnosisPath}")"
cat > "${diagnosisPath}" << 'ENDOFDIAGNOSIS'
## Diagnosis

<your reasoning, citing the outcome evidence and/or member aggregates above>
ENDOFDIAGNOSIS
\`\`\`

**Required** — write the COMPLETE squad.json (the full def — \`type\`/\`slots\`/
\`wire\` copied unchanged, only \`flow\` mutated) to the staging path:

\`\`\`bash
cat > "${stagingPath}" << 'ENDOFSQUADJSON'
<the complete squad.json — valid JSON, matching the SquadDef shape above>
ENDOFSQUADJSON
\`\`\`

Do not create, modify, or delete anything else. Your ONLY write targets are
the two absolute paths named above — never the active def, any candidate
directory, or any role store.`
}

function checkIntBound(name: string, value: unknown, lo: number, hi: number, errors: string[]): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < lo || value > hi) {
    errors.push(`flow.bounds.${name} must be an integer in [${lo}, ${hi}] — got ${JSON.stringify(value)}`)
  }
}

/**
 * Hard mutation gate (spec §1.5.1 v1 rule): `proposed.slots` and
 * `proposed.wire` must be deep-equal to `active` (structure/bindings
 * frozen — flow knobs only), `proposed.type` must be unchanged, and every
 * `flow` field must be in its legal range/enum. Every violation is
 * collected and returned together — never short-circuits on the first
 * error — so a caller (or a human reading the die message) sees the whole
 * picture in one shot.
 */
export function validateFlowMutation(active: SquadDef, proposed: SquadDef): { ok: boolean; errors: string[] } {
  // Robustness guard (review finding): `proposed` is only TYPED as SquadDef —
  // it's actually `JSON.parse`d from an LLM-staged file (cmdSquadPropose)
  // and can be `null` (bare `null` is valid JSON) or a non-object (a bare
  // string/number/array) at runtime. Property access below would otherwise
  // throw a TypeError that escapes as an unhandled rejection instead of the
  // clean `{ok:false}` every other invalid-shape case returns.
  const p: unknown = proposed
  if (p === null || typeof p !== "object" || Array.isArray(p)) {
    return { ok: false, errors: ["proposed def is not an object"] }
  }

  const errors: string[] = []

  if (proposed.type !== active.type) {
    errors.push(`type must be unchanged (frozen): active='${active.type}', proposed='${proposed.type}'`)
  }
  if (!isDeepStrictEqual(proposed.slots, active.slots)) {
    errors.push("slots must be deep-equal to active (frozen — flow knobs only, v1 rule)")
  }
  if (!isDeepStrictEqual(proposed.wire, active.wire)) {
    errors.push("wire must be deep-equal to active (frozen — flow knobs only, v1 rule)")
  }

  const bounds = proposed.flow?.bounds as Record<string, unknown> | undefined
  if (!bounds || typeof bounds !== "object") {
    errors.push("flow.bounds is missing")
  } else {
    checkIntBound("R1", bounds["R1"], 1, 10, errors)
    checkIntBound("R2", bounds["R2"], 1, 10, errors)
    checkIntBound("R3", bounds["R3"], 1, 10, errors)
    checkIntBound("globalBudgetSteps", bounds["globalBudgetSteps"], 10, 200, errors)
  }

  const gatePolicy = proposed.flow?.gatePolicy as Record<string, unknown> | undefined
  if (!gatePolicy || typeof gatePolicy !== "object") {
    errors.push("flow.gatePolicy is missing")
  } else {
    if (gatePolicy["gate1"] !== "human" && gatePolicy["gate1"] !== "auto") {
      errors.push(`flow.gatePolicy.gate1 must be "human" | "auto" — got ${JSON.stringify(gatePolicy["gate1"])}`)
    }
    if (gatePolicy["gate2"] !== "human" && gatePolicy["gate2"] !== "auto") {
      errors.push(`flow.gatePolicy.gate2 must be "human" | "auto" — got ${JSON.stringify(gatePolicy["gate2"])}`)
    }
  }

  const reentry = proposed.flow?.reentry
  if (reentry !== "delta" && reentry !== "full") {
    errors.push(`flow.reentry must be "delta" | "full" — got ${JSON.stringify(reentry)}`)
  }

  return { ok: errors.length === 0, errors }
}

/** Poll for `filePath` to appear, capped at `timeoutMs` total — an initial
 * immediate check (the common case: the exec call already blocked until
 * the child wrote it) plus short-interval retries for the remaining
 * budget only (never re-adds a full timeout on top of the exec call's
 * own wait). */
async function waitForStagingFile(filePath: string, timeoutMs: number, intervalMs = 50): Promise<boolean> {
  if (existsSync(filePath)) return true
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - Date.now()))))
    if (existsSync(filePath)) return true
  }
  return existsSync(filePath)
}

/**
 * Spawn one one-shot opencode session to propose a flow-knob mutation for
 * `type`'s active squad def, validate it, and — only if valid — write a new
 * INACTIVE candidate version (`candidates/<vN>/squad.json` + a copied
 * `diagnosis.md` if the session wrote one). Never touches `active/`.
 * Dies (throws `BenchError`, via `die`) on: an invalid mutation (all
 * violations listed) or a timeout waiting for the staged file — in both
 * cases NOTHING is written.
 */
export async function cmdSquadPropose(
  args: { squadType?: string; model?: string; timeoutSec?: number },
  execFn: ExecFn = defaultExec,
): Promise<SquadProposeResult> {
  const type = args.squadType ?? "standard"
  const active = readActiveSquadDef(type)
  const timeoutSec = args.timeoutSec ?? 600
  const model = args.model ?? "anthropic/claude-opus-4-8"

  const stagingDir = join(squadRoot(type), ".staging")
  mkdirSync(stagingDir, { recursive: true })
  const stagingPath = join(stagingDir, `propose-${Date.now()}-${randomBytes(4).toString("hex")}.json`)
  const diagnosisPath = `${stagingPath}.diagnosis.md`

  const prompt = buildSquadProposerPrompt(type, active, stagingPath)
  const scratch = mkdtempSync(join(tmpdir(), "mh-squad-propose-"))
  // Credential isolation (review finding): this spawns a real, unrestricted
  // --auto bash session that would otherwise inherit the operator's ambient
  // env wholesale. Same scrub fleet/run.ts's cmdRoleRun applies to
  // bash:allow roles — env overrides + tmp git/gh config, shredded in the
  // `finally` below regardless of how the drive exits.
  const sbx = sandboxEnv(PROPOSER_SANDBOX_SPEC)

  try {
    const argv = ["opencode", "run", "--dir", scratch, "--auto", "--format", "json", "--model", model, prompt]

    const startedAt = Date.now()
    await execFn(argv, { timeoutSec, env: sbx?.env })
    const elapsedMs = Date.now() - startedAt
    const remainingMs = Math.max(0, timeoutSec * 1000 - elapsedMs)
    const found = await waitForStagingFile(stagingPath, remainingMs)

    if (!found) {
      die(`squad-propose: timed out after ${timeoutSec}s waiting for staged squad.json at ${stagingPath}`)
    }

    let proposed: SquadDef
    try {
      proposed = JSON.parse(readFileSync(stagingPath, "utf-8")) as SquadDef
    } catch (e) {
      die(`squad-propose: staged squad.json at ${stagingPath} is not valid JSON: ${(e as Error).message}`)
    }

    const { ok, errors } = validateFlowMutation(active, proposed)
    if (!ok) {
      die(
        `squad-propose: proposed squad.json for '${type}' violates the flow-mutation rule (structure/bindings frozen):\n` +
          errors.map((e) => `  - ${e}`).join("\n"),
      )
    }

    const version = nextSquadVersion(type)
    writeJsonAtomic(join(squadRoot(type), "candidates", version, "squad.json"), proposed)
    if (existsSync(diagnosisPath)) {
      writeTextAtomic(join(squadRoot(type), "candidates", version, "diagnosis.md"), readFileSync(diagnosisPath, "utf-8"))
    }

    log(`squad-propose: candidate ${version} written for squad '${type}' (active untouched)`)
    return { version, def: proposed }
  } finally {
    sbx?.cleanup()
    rmSync(scratch, { recursive: true, force: true })
  }
}
