/**
 * roles.ts — the fleet role manifest (spec §1, §1.5 rule 3).
 * Frontmatter/permission templates ONLY — payload headings live in the
 * SquadDef wire block (squad-def.ts), owned by the consuming squad.
 * Permission keys are bash/edit/write; `shell` is silently ignored by
 * opencode (oc-test KNOWN-ISSUES.md) and must never appear here.
 */
import { die } from "../bench/util.ts"

export type FleetRoleName = "analyzer" | "designer" | "implementer" | "evaluator"

export interface RoleSpec {
  role: FleetRoleName
  agent: string
  description: string
  mode: "all"
  model: string
  temperature: number
  permission: Record<string, "allow" | "deny">
}

const RO = { bash: "deny", edit: "deny", write: "deny" } as const

export const FLEET_ROLES: RoleSpec[] = [
  {
    role: "analyzer",
    agent: "mh-analyzer",
    description: "Turns a slice into use cases + functional spec; escalates genuine intent forks",
    mode: "all",
    model: "anthropic/claude-haiku-4-5",
    temperature: 0.2,
    permission: { ...RO },
  },
  {
    role: "designer",
    agent: "mh-designer",
    description: "Turns an approved spec into design alternatives + recommendation",
    mode: "all",
    model: "anthropic/claude-sonnet-4-6",
    temperature: 0.3,
    permission: { ...RO },
  },
  {
    role: "implementer",
    agent: "mh-implementer",
    description: "Turns a decided design into minimal tested code; commits locally, never pushes",
    mode: "all",
    model: "anthropic/claude-sonnet-4-6",
    temperature: 0.1,
    permission: { bash: "allow", edit: "allow", write: "allow" },
  },
  {
    role: "evaluator",
    agent: "mh-evaluator",
    description: "Authors test-spec from intent; runs checks and emits the VERDICT",
    mode: "all",
    model: "anthropic/claude-haiku-4-5",
    temperature: 0.1,
    permission: { bash: "allow", edit: "deny", write: "deny" },
  },
]

export function roleSpec(role: string): RoleSpec {
  const spec = FLEET_ROLES.find((r) => r.role === role)
  if (!spec) die(`unknown fleet role: ${role} (want one of ${FLEET_ROLES.map((r) => r.role).join("|")})`)
  return spec as RoleSpec
}
