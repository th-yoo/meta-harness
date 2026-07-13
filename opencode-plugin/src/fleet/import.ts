/**
 * import.ts — one-time doctrine → account-role v1 (spec §10: imported ONCE,
 * store owns truth after). `map` bridges the 3-role oc-test doctrine to the
 * 4-role squad until the fleet-side split lands (spec §11): one source body
 * may seed several role stores VERBATIM.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { accountRoleRoot, createCandidate, writeActive, readActiveSystem } from "../harness-store.ts"
import { roleSpec } from "./roles.ts"
import { die, log } from "../bench/util.ts"

function stripFrontmatter(text: string): string {
  if (!text.startsWith("---\n")) return text
  const end = text.indexOf("\n---\n", 4)
  return end === -1 ? text : text.slice(end + 5)
}

export function cmdRolesImport(args: {
  from: string
  roles?: string[]
  force?: boolean
  map?: Record<string, string[]>
}): void {
  const targets = args.roles?.length ? args.roles : ["analyzer", "designer", "implementer", "evaluator"]
  // invert map: target role -> source basename
  const sourceOf: Record<string, string> = {}
  for (const t of targets) sourceOf[t] = t
  for (const [src, dests] of Object.entries(args.map ?? {})) {
    for (const d of dests) sourceOf[d] = src
  }

  for (const role of targets) {
    const spec = roleSpec(role)
    const srcPath = join(args.from, `${sourceOf[role]}.md`)
    if (!existsSync(srcPath)) die(`roles-import: source not found: ${srcPath}`)
    const body = stripFrontmatter(readFileSync(srcPath, "utf-8")).trim() + "\n"

    const root = accountRoleRoot(spec.agent)
    const existing = readActiveSystem(root)
    if (existing && existing.trim() !== "" && !args.force) {
      die(`roles-import: ${spec.agent} already has an active body — pass --force to overwrite`)
    }
    createCandidate(root, "v1", body)
    writeActive(root, "v1", body, null, null, null, null)
    log(`imported ${srcPath} -> ${spec.agent} account-role v1 (active)`)
  }
}
