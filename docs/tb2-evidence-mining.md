# tb2-evidence-mining — offline distillation procedure

Phase 8 / W4b. This is the manual (or Claude-assisted) procedure for filling
`evidence/tb2-leaderboard/<task>/<agent>.md` — distilled strategy notes mined
from OTHER agents' Terminal-Bench-2 leaderboard submissions, fed to the
evolution loop's proposer as an untrusted, contamination-guarded evidence
INDEX (`buildExternalEvidenceSection`, `opencode-plugin/src/evidence.ts`).

Deliberately **no LLM-driven subcommand** — the volume is small (a handful
of high-variance held-in tasks at a time) and the generality tag on each
note needs a human in the loop; automating it would just move the judgment
call somewhere less visible.

## Why this exists

The evolution loop's proposer only ever sees evidence from ITS OWN runs
(this harness's trajectories, scores, diagnoses). Other agents' TB2
leaderboard submissions are a second, much larger pool of strategy signal
for the SAME task set — worth mining, but two things make it dangerous to
just dump in:

1. **Contamination.** A note distilled from a task's leaderboard trial is,
   by construction, strategy information about that exact task. If that
   task is (or later becomes, via fold rotation) HELD-OUT for this harness's
   own A/B gate, showing the proposer that note is a held-out leak — the
   proposer could shape its rule around the held-out task's specifics,
   inflating the measured gate result without a real generalization gain.
2. **Prompt injection.** The mined artifacts are untrusted third-party
   content (another agent's trajectory / a task's HF dataset entry). A
   naive dump into the proposer prompt is an injection surface, same class
   of risk `untrustedSection` already closes for this harness's OWN
   trajectories (propose.ts).

The design answers (1) with a LIVE contamination guard re-checked on every
prompt build (`validateEvidenceDir`, pure, driven by the CURRENT split —
never a distill-time snapshot) and (2) by keeping the proposer-prompt
section an INDEX only (relative paths + first line), with its own
UNTRUSTED header restating the same untrusted-evidence clause, emitted
strictly after `untrustedSection`.

## Procedure

### 1. Pick candidate tasks

Pick a small number of HIGH-VARIANCE, currently HELD-IN tasks — variance
across leaderboard submissions is where "what did other agents do
differently" is most likely to carry a real lesson. The variance data
already lives in `opencode-plugin/src/bench/leaderboard.ts`
(`harnessVariance`/`tierVariance`, fed by `term-bench2/leaderboard/matrix.json`
— see `term-bench2/leaderboard/curate-band.ts` for how the band selection
already uses this).

Confirm each candidate is presently **held-in** (never distill a held-out
task's evidence — the guard would just discard it later, and it's wasted
effort up front):

```bash
bun opencode-plugin/src/bench/cli.ts split show --split-file term-bench2/splits.json
```

(swap `--split-file` for whichever split file is the operator's active one
— see `MhConfig.activeSplitFile`, below).

### 2. Fetch the source trial artifacts

`term-bench2/leaderboard/pull-leaderboard.ts` already knows the leaderboard
HF dataset's URL layout — reuse its resolve-URL prefix rather than
re-deriving it:

```ts
const RES = "https://huggingface.co/datasets/harborframework/terminal-bench-2-leaderboard/resolve/main/"
```

Given a submission id and a trial path (from `term-bench2/leaderboard/
matrix.json` / `submissions.json`, or by browsing the HF dataset tree API
the way `pull-leaderboard.ts`'s `listSubmissions`/`fetchSubmission` do),
fetch `RES + trialPath + "/result.json"` for the reward/metadata, and
whatever transcript/log artifacts that submission's trial directory
exposes (varies by submission — some include a full agent transcript,
others only the terminal recording). Fetch by hand (`curl`, or a one-off
`bun -e` snippet using the same `RES` prefix) — this is deliberately NOT a
committed subcommand; see "no LLM-driven subcommand" above.

### 3. Distill — NOT transcribe

Read the fetched artifact and write a SHORT (~40 lines), BEHAVIORAL note —
the recurring approach/technique that worked or failed, generalizable
beyond this one trial. Copy `evidence/tb2-leaderboard/TEMPLATE.md` to
`evidence/tb2-leaderboard/<task-id>/<agent-slug>.md` and fill it in.

**Hard rule: no literal solution transcripts.** Do not paste the winning
command sequence, the exact patch, or any other verbatim task-specific
answer. Two independent reasons this is non-negotiable, not just style:

- **Contamination-in-waiting.** Even though step 1 confirmed the task is
  held-in TODAY, `validateEvidenceDir` only stops the file from being SHOWN
  to the proposer once it rotates held-out — the file itself stays
  committed. A literal answer sitting in a skipped-but-present file is a
  standing liability the moment someone reads `git log` or the file directly
  outside the guarded path.
- **Prompt injection.** This file is untrusted content fed into a future
  agentic proposer session's prompt. A literal transcript is exactly the
  kind of content that can carry embedded "instructions" indistinguishable
  from the lesson itself.

Tag each note's `generality` (`universal` | `vendor` | `model`), mirroring
`PlaybookBullet.generality` (`opencode-plugin/src/harness-store.ts`) — a
single leaderboard trial is ONE model's run, so treat anything beyond
`universal` as a hypothesis needing corroboration, same caution the
proposer prompt already applies to its own playbook edits.

### 4. Validate before committing (offline pre-check)

Run the SAME validator the live guard uses, against the split that will be
active when this lands:

```bash
bun -e 'import("./opencode-plugin/src/evidence.ts").then(async m => {
  const { loadActiveSplit } = await import("./opencode-plugin/src/bench/splits.ts")
  const { heldOut } = loadActiveSplit("term-bench2/splits.json")
  const offending = m.validateEvidenceDir("evidence/tb2-leaderboard", heldOut)
  console.log(offending.length === 0 ? "clean" : offending)
})'
```

An empty result means nothing under `evidence/tb2-leaderboard/` is
currently held-out. If your new file shows up as offending, do not commit
it as-is — either the task was already held-out (redo step 1) or the split
rotated since you picked it.

**This offline run is a courtesy pre-check, not the enforcement point.**
The real guard runs LIVE, inside `buildExternalEvidenceSection`, on every
proposer-prompt build — even a file that passed this check today will be
silently skipped (with a logged warning) the moment a fold rotation moves
its task to held-out. That is by design: it is the fix for the exact gap an
architect review caught in round 2 (a held-in-at-distillation task can
become held-out later).

### 5. Commit

Commit the new `evidence/tb2-leaderboard/<task>/<agent>.md` file(s), noting
the source submission/trial in the file's `source:` field for provenance.
No code changes needed to pick it up — the section is index-built from
whatever's on disk under the configured `externalEvidenceDir`.

## Turning the seam on

The whole feature is config-gated and OFF by default (`MhConfig.
externalEvidenceDir` defaults to `""`). To enable it, set in `<accountMetaRoot>/
config.json` (see `readMhConfig`, `opencode-plugin/src/harness-store.ts`):

```json
{
  "externalEvidenceDir": "evidence/tb2-leaderboard",
  "activeSplitFile": ""
}
```

`activeSplitFile` only needs to be set when the operator's active split ISN'T
the default `term-bench2/splits.json` — e.g. when Phase 6's loop2 split is
live, set it to `term-bench2/splits/loop2.json`, matching whatever
`--split-file` value that run's `ab`/`split` invocations use. `""` (default)
resolves to `makeBenchPaths().splitsFile` at prompt-build time.

**Fail-safe:** if the resolved split file doesn't exist on disk when a
propose cycle runs, `triggerPropose` logs a warning and disables the
external-evidence section entirely for that cycle — the harness never shows
evidence it couldn't freshly re-validate against the current split.
