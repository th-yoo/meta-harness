/**
 * minimal/spec-probe.ts — spec-coverage probe for the completion gate
 * (false-accept fix L1, docs/2026-07-27-probe-grip-fix-design.md §5.1).
 *
 * A frozen per-task requirements.json (hand-compiled from instruction.md,
 * RTM-style: id + text + observable markers) is matched against the agent's
 * verify.sh. A requirement is "covered" iff any marker appears (case-
 * insensitive substring) in the COMMENT-STRIPPED script — mentioning
 * markers in a bash comment does not count. Derives only from the
 * instruction the agent already sees (invariant 1 intact).
 */

export interface Requirement {
  id: string
  text: string
  markers: string[]
}

export function parseRequirements(raw: string): Requirement[] | undefined {
  try {
    const j = JSON.parse(raw)
    if (!Array.isArray(j.requirements) || j.requirements.length === 0) return undefined
    const out: Requirement[] = []
    for (const r of j.requirements) {
      if (typeof r.id !== "string" || typeof r.text !== "string" || !Array.isArray(r.markers)) return undefined
      if (!r.markers.every((m: unknown) => typeof m === "string") || r.markers.length === 0) return undefined
      out.push({ id: r.id, text: r.text, markers: r.markers })
    }
    return out
  } catch {
    return undefined
  }
}

/** Remove #-to-EOL bash comments outside single/double quotes (crude lexer —
 * good enough for agent-written verify scripts; heredoc bodies keep their
 * text since they contain no unquoted leading `#` in practice). */
export function stripBashComments(script: string): string {
  return script
    .split("\n")
    .map((line) => {
      let inS = false
      let inD = false
      for (let i = 0; i < line.length; i++) {
        const c = line[i]
        if (c === "'" && !inD) inS = !inS
        else if (c === '"' && !inS) inD = !inD
        else if (c === "#" && !inS && !inD) return line.slice(0, i)
      }
      return line
    })
    .join("\n")
}

export function uncoveredRequirements(reqs: Requirement[], verifyText: string): Requirement[] {
  const hay = stripBashComments(verifyText).toLowerCase()
  return reqs.filter((r) => !r.markers.some((m) => hay.includes(m.toLowerCase())))
}
