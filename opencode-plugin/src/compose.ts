/**
 * compose.ts — shared layer composition for the evolvable harness.
 *
 * Both the live opencode-plugin hook (index.ts's
 * `experimental.chat.system.transform`) and the bench AGENTS.md assembler
 * (bench/record.ts's `assembleAgentsMd`) walk the same 4-layer stack
 * (account-global -> project-global -> account-role -> project-role) and
 * read each layer's system.md/tools.md text (active, or a pinned candidate
 * version for bench). This module owns that shared "walk the layers, read
 * the text" step (`composeHarness`) plus the two call sites' DIFFERENT
 * renderers:
 *   - `renderSystemBlocks` — the live hook's array of system-prompt strings
 *     (per-layer system text, then ONE combined "## Tool usage guidance"
 *     block from all layers, then an optional trailing env snapshot).
 *   - `renderAgentsMd` — bench's AGENTS.md text (per-layer LABELED system +
 *     tools sections, joined with "\n\n---\n\n").
 *
 * These renderers differ BY DESIGN (combined vs. per-layer tool guidance) —
 * this module does not homogenize them. It does NOT own layer-root
 * resolution (layersFor in harness-store.ts; layerStoreRoots in
 * bench/record.ts, which additionally supports the --layers CLI filter) —
 * callers resolve their own ordered layer list and pass it in as
 * `LayerRef[]`.
 */
import {
  readActiveSystem,
  readActiveTools,
  readCandidateSystem,
  readCandidateTools,
  readPlaybook,
  renderPlaybook,
  renderPlaybookRouted,
  type Playbook,
} from "./harness-store.ts"

/** One resolved layer to compose: a scope label + its store root. Callers
 * build this from harness-store's `layersFor` (live hook) or bench/record.ts's
 * `layerStoreRoots` (bench, --layers-filtered). */
export interface LayerRef {
  scope: string
  root: string
}

/** A layer's gathered text (active, or pinned-candidate when `pins[scope]`
 * is set). Empty strings mean "no content for this layer" — both renderers
 * skip empty system/tools identically to today's two implementations. */
export interface ComposedLayer {
  scope: string
  root: string
  system: string
  tools: string
}

/** A `TrialState` snapshot (§4.3 spec §3) to compose ONE layer's text from,
 * instead of reading its active/candidate files — the baseline arm of a
 * live gate-outcomes trial. `scope` identifies which layer the snapshot
 * applies to (v0 is project-global only, spec §1); every other layer in the
 * walk composes as it does today. */
export interface SnapshotOverride {
  scope: string
  system: string
  tools: string
  playbook: Playbook | null
}

/**
 * Walk `layers` in the given order and read each one's system.md/tools.md —
 * the active version, or the pinned candidate version when `pins[scope]` is
 * set (bench's --pin support; the live hook never passes pins and always
 * reads active text). When `snapshot` is given and a layer's scope matches
 * `snapshot.scope`, that layer composes from the snapshot's fields instead
 * of reading from disk at all (arm-aware compose, §4.3 spec §3) — every
 * other layer is unaffected.
 */
export function composeHarness(
  layers: LayerRef[],
  pins: Record<string, string> = {},
  model?: string,
  snapshot?: SnapshotOverride,
): ComposedLayer[] {
  return layers.map(({ scope, root }) => {
    if (snapshot && scope === snapshot.scope) {
      const flat = snapshot.system
      const pb = model ? snapshot.playbook : null
      // Same faithful-render guard as the disk path below: route only when
      // the snapshot's playbook faithfully renders the snapshot's system text.
      const system = pb && renderPlaybook(pb).trim() === flat.trim()
        ? renderPlaybookRouted(pb, model!)
        : flat
      return { scope, root, system, tools: snapshot.tools }
    }
    const ver = pins[scope]
    const flat = ver ? readCandidateSystem(root, ver) : readActiveSystem(root)
    const pb = model ? readPlaybook(root, ver) : null
    // Route ONLY when the playbook faithfully renders the stored system.md, so a
    // routed render can differ from `flat` only by dropping tag-mismatched bullets.
    const system = pb && renderPlaybook(pb).trim() === flat.trim()
      ? renderPlaybookRouted(pb, model!)
      : flat
    const tools = ver ? readCandidateTools(root, ver) : readActiveTools(root)
    return { scope, root, system, tools }
  })
}

/**
 * The live hook's system-prompt array: each non-empty layer's system text
 * (in layer order), then ONE combined "## Tool usage guidance" block built
 * from every non-empty layer's tools text (joined "\n\n"), then — if
 * `envSnapshot` is a non-empty string — that snapshot pushed last. Mirrors
 * index.ts's `experimental.chat.system.transform` hook body exactly (minus
 * its logging side effects, which stay in index.ts since they need the
 * plugin's `log`/`client`).
 */
export function renderSystemBlocks(layers: ComposedLayer[], envSnapshot?: string): string[] {
  const blocks: string[] = []
  for (const layer of layers) {
    if (layer.system) blocks.push(layer.system)
  }
  const toolParts = layers.filter((l) => l.tools).map((l) => l.tools)
  if (toolParts.length > 0) {
    blocks.push(`## Tool usage guidance\n\n${toolParts.join("\n\n")}`)
  }
  if (envSnapshot) blocks.push(envSnapshot)
  return blocks
}

/** (system heading, tools heading) per layer scope; "{agent}" is substituted
 * with `agent`. Caller-supplied (bench/record.ts's LAYER_LABELS) since
 * labels are bench-only — the live hook's renderSystemBlocks has no
 * headings. */
export type LayerLabels = Record<string, [string, string]>

/**
 * Bench's AGENTS.md text: per-layer LABELED system + tools sections (each
 * only emitted when non-empty), joined with "\n\n---\n\n". Mirrors
 * bench/record.ts's `assembleAgentsMd` body exactly.
 */
export function renderAgentsMd(layers: ComposedLayer[], labels: LayerLabels, agent = ""): string {
  const parts: string[] = []
  for (const layer of layers) {
    const pair = labels[layer.scope]
    if (!pair) continue
    const [sysHead, toolsHead] = pair
    if (layer.system) parts.push(`## ${sysHead.replace("{agent}", agent)}\n\n${layer.system}`)
    if (layer.tools) parts.push(`## ${toolsHead.replace("{agent}", agent)}\n\n${layer.tools}`)
  }
  return parts.join("\n\n---\n\n")
}
