/**
 * fleet-helpers.ts — shared fleet-test seeding idiom (mirrors
 * fleet-render.test.ts's beforeEach). Headless-drive tests (fleet-run,
 * fleet-score, …) need a rendered persona md on disk before they can
 * exercise anything — this is that precondition, factored out so each
 * suite doesn't hand-roll the same squad-def + account-role + render dance.
 */
import { renderRole, type RenderStamp } from "../src/fleet/render.ts"
import { writeSquadDefV1, STANDARD_SQUAD } from "../src/fleet/squad-def.ts"
import { accountRoleRoot, createCandidate, writeActive } from "../src/harness-store.ts"
import { roleSpec } from "../src/fleet/roles.ts"

const ANALYZER_BODY =
  "You are the analyzer.\nEmit `## Use Cases` and `## Functional Spec`; escalate with `## Clarify`."

/**
 * Writes the standard squad def (once) + a role's account-global v1 layer
 * body, then renders it to `<project>/.opencode/agents/mh-<role>.md`.
 * Defaults to the analyzer role with a wire-compliant body (same fixture
 * text fleet-render.test.ts seeds) — pass `role`/`body` for other roles.
 * Call once per test (a second `writeSquadDefV1` in the same
 * META_HARNESS_HOME dies — same one-shot contract squad-def.ts documents).
 */
export function seedRenderedRole(
  project: string,
  role: string = "analyzer",
  body: string = ANALYZER_BODY,
): { path: string; stamp: RenderStamp } {
  writeSquadDefV1(STANDARD_SQUAD)
  const agent = roleSpec(role).agent
  const root = accountRoleRoot(agent)
  createCandidate(root, "v1", body)
  writeActive(root, "v1", body, null, null, null, null)
  return renderRole(project, role)
}

/**
 * Wire-compliant fallback payload per DRIVING PHASE (fleet-squad.test.ts's
 * `scripted()` fixture) — keyed by squad.ts's `Phase` values, not the 4
 * collapsed wire slots (squad.ts's DriveFn is called with the phase itself;
 * see squad.ts's header note). `evaluator-spec`/`evaluator-verdict` are two
 * distinct keys even though they share the "evaluator" wire slot.
 */
export const OK: Record<string, string> = {
  analyzer: "## Use Cases\nu\n## Functional Spec\nf",
  "evaluator-spec": "## Test Spec\n- t1",
  designer: "## Alternatives\nA,B\n## Recommended\nA",
  implementer: "## Implementation Report\ndone",
  "evaluator-verdict": "## Test Spec\nran\nVERDICT: PASS",
}

/**
 * DriveFn/ScoreFn pair for squad.ts tests: returns queued payloads per
 * phase (falling back to `OK`), and records every score() call for
 * assertions. `queues[phase]` is shift()ed front-to-back as that phase
 * drives repeatedly (redos, re-entries); once empty it falls back to `OK`.
 */
export function scripted(queues: Record<string, string[]>) {
  const scores: Array<{ id: string; verdict: string; gate: string }> = []
  let n = 0
  const drive = async (slot: string, _input: string) => {
    const q = queues[slot]
    const payload = q?.length ? q.shift()! : OK[slot]
    return { id: `d${++n}-${slot}`, payload: payload! }
  }
  const score = async (id: string, verdict: "good" | "bad", gate: string) => {
    scores.push({ id, verdict, gate })
  }
  return { drive, score, scores }
}
