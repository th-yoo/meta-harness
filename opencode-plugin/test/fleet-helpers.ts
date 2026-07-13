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
