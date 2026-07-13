/**
 * render.ts — compose a role's 4 layers into a platform persona file
 * (spec §5 render step, §10: store is truth, files are rendered outputs).
 * Stamp = attribution backbone: scores route to the versions that RAN.
 *
 * Reality-binding note (vs. the task brief's sketch): the brief imagined
 * `composeHarness(roots, pins)` returning `{ text, versions }` directly.
 * The real `composeHarness` (compose.ts:51) returns `ComposedLayer[]` — one
 * {scope,root,system,tools} per layer, text only, no version info — and is
 * a shared building block for TWO different renderers (the live hook's
 * `renderSystemBlocks` and bench's `renderAgentsMd`), neither of which is
 * "the" role body on its own. record.ts's `assembleAgentsMd` (record.ts:117)
 * is the function that already turns a (layers, metaRoot, agent, pins) tuple
 * into ONE joined+labeled body string — and it's exactly what cmd-run.ts
 * uses for `--agent` runs (cmd-run.ts:327:
 * `harnessMd = assembleAgentsMd(layers, paths.metaRoot, agent, pins)`).
 * Reusing it here is the direct binding to that real call site. Per-layer
 * VERSION attribution isn't part of composeHarness's or assembleAgentsMd's
 * return value either (they only read text) — recordToStores
 * (record.ts:307-308) shows the real pattern for turning a resolved layer
 * list into a version map: `pins[name] || activeVersion(root)`, reused
 * verbatim below.
 */
import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { roleSpec } from "./roles.ts"
import { readActiveSquadDef } from "./squad-def.ts"
import { activeVersion } from "../harness-store.ts"
import { assembleAgentsMd, layerStoreRoots, parsePins } from "../bench/record.ts"
import { die, log, writeTextAtomic } from "../bench/util.ts"

export interface RenderStamp {
  versions: Record<string, string>
  harnessHash: string
  renderedAt: string
}

const STAMP_RE = /<!-- mh-render (\{.*?\}) -->/s

export function parseStamp(md: string): RenderStamp | null {
  const m = STAMP_RE.exec(md)
  if (!m) return null
  const json = m[1]
  if (!json) return null
  try { return JSON.parse(json) as RenderStamp } catch { return null }
}

function frontmatter(role: string): string {
  const s = roleSpec(role)
  const perm = Object.entries(s.permission).map(([k, v]) => `  ${k}: ${v}`).join("\n")
  return [
    "---",
    `description: ${s.description}`,
    `mode: ${s.mode}`,
    `model: ${s.model}`,
    `temperature: ${s.temperature}`,
    "permission:",
    perm,
    "---",
  ].join("\n")
}

/**
 * Compose the role's body from its 4 store layers (account-global ->
 * project-global -> account-role -> project-role, Option Y order — the same
 * `layers="global"` + `agent` pair cmd-run.ts's `--agent` path uses), stamp
 * it with the per-layer versions that produced it + a content hash, render
 * lint against the consuming squad's wire block, and write
 * `<project>/.opencode/agents/mh-<role>.md`.
 */
export function renderRole(
  project: string,
  role: string,
  opts?: { pins?: Record<string, string>; force?: boolean; squadType?: string; now?: string },
): { path: string; stamp: RenderStamp } {
  const s = roleSpec(role)
  const def = readActiveSquadDef(opts?.squadType ?? "standard")
  const pins = opts?.pins ?? {}

  const roots = layerStoreRoots("global", s.agent, project)
  const body = assembleAgentsMd("global", project, s.agent, pins)
  const versions: Record<string, string> = {}
  for (const [name, root] of roots) {
    versions[name] = pins[name] || activeVersion(root)
  }

  // Render lint (spec §1.5 rule 3): body must teach at least one wire OR-group.
  const groups = def.wire.headings[role] ?? []
  const taught = groups.length === 0 || groups.some((g) => g.every((h) => body.includes(h)))
  if (!taught) {
    if (!opts?.force) {
      die(`render lint: mh-${role} body never mentions its wire headings (${groups.map((g) => g.join("+")).join(" | ")}) — fix the prompt or pass --force`)
    }
    log(`WARNING: --force render of mh-${role} without wire headings`)
  }

  const stampBase = { versions, harnessHash: createHash("sha256").update(body).digest("hex").slice(0, 16) }
  const stamp: RenderStamp = { ...stampBase, renderedAt: opts?.now ?? new Date().toISOString() }
  const md = `${frontmatter(role)}\n<!-- mh-render ${JSON.stringify(stamp)} -->\n${body}\n`

  const dir = join(project, ".opencode", "agents")
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `mh-${role}.md`)

  // Idempotence: if existing file differs only in renderedAt, keep it byte-stable.
  try {
    const prev = readFileSync(path, "utf-8")
    const prevStamp = parseStamp(prev)
    if (prevStamp && prevStamp.harnessHash === stamp.harnessHash
        && JSON.stringify(prevStamp.versions) === JSON.stringify(stamp.versions)) {
      return { path, stamp: prevStamp }
    }
  } catch { /* no existing file */ }

  writeTextAtomic(path, md)
  return { path, stamp }
}

export function cmdRolesRender(args: { project: string; roles?: string[]; pins?: string[]; force?: boolean }): void {
  const roles = args.roles?.length ? args.roles : ["analyzer", "designer", "implementer", "evaluator"]
  for (const role of roles) {
    // pins are parsed per-role: parsePins (record.ts:73) validates each
    // LAYER=vN against that role's OWN --agent-scoped layer roots (its
    // account-role/project-role stores differ per role), same as a single
    // `run --agent mh-<role>` invocation would.
    const agent = roleSpec(role).agent
    const pins = args.pins?.length ? parsePins(args.pins, "global", agent, args.project) : {}
    const { path, stamp } = renderRole(args.project, role, { pins, force: args.force })
    log(`rendered ${path} (hash ${stamp.harnessHash})`)
  }
}
