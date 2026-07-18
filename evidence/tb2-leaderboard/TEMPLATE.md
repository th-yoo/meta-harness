# External-evidence template

Copy this file to `evidence/tb2-leaderboard/<task-id>/<agent-slug>.md`. This
is a DISTILLED strategy note, mined from another agent's Terminal-Bench-2
leaderboard trial for `<task-id>` — not a transcript. The proposer reads it
as an INDEX entry only (`buildExternalEvidenceSection`, `src/evidence.ts`);
keep the whole file short (~40 lines), behavioral, and generalizable, the
same bar as a playbook bullet (`PlaybookBullet`, `harness-store.ts`).

Before committing, `<task-id>` MUST be held-IN under the CURRENT split (fold
rotation can move it to held-out later — that is a LIVE guard, re-checked on
every prompt build, not just here). Run the validator first:

    bun -e 'import("./opencode-plugin/src/evidence.ts").then(async m => {
      const { loadActiveSplit } = await import("./opencode-plugin/src/bench/splits.ts")
      const { heldOut } = loadActiveSplit("term-bench2/splits.json")
      console.log(m.validateEvidenceDir("evidence/tb2-leaderboard", heldOut))
    })'

An empty array means nothing in the whole evidence dir is currently
held-out. If your new file appears in the output, do not commit it — the
task rotated held-out since you picked it.

See `docs/tb2-evidence-mining.md` for the full offline distillation
procedure (how to fetch the source trial, what "distilled" means here).

---

task: <tb2 task id — held-in at distillation time>
agent: <leaderboard submission/agent slug, e.g. NexAU-AHE__gpt-5.5>
source: <submission id + trial path this was distilled from, for provenance>
distilledBy: <human name, or "claude" + date>
generality: universal | vendor | model     # mirrors PlaybookBullet.generality
slice: <vendor or model id — set only when generality is vendor or model>

## Strategy notes

- <a recurring APPROACH or technique that worked or failed — a behavioral
  pattern that generalizes beyond this one task and this one trial, not
  "ran command X then Y then Z">
- <one bullet per distinct lesson; 1-3 sentences each; ~3-6 bullets total>

## What NOT to include (read before writing)

- No literal solution transcripts, command-by-command logs, file diffs, or
  verbatim task-specific answers. This file is untrusted third-party input
  fed straight into a future proposer's prompt (an agentic session with file
  tools) — a literal answer here is both a held-out-contamination risk (if
  the split ever rotates this task to held-out) and a prompt-injection
  surface. Distill to the LESSON, never quote the transcript.
- No instructions addressed to "the reader" / "the agent" / "the proposer" —
  this file is evidence to weigh, not directions to follow. A future
  proposer session is told this explicitly, but do not test that guard by
  writing directive-sounding text here.
