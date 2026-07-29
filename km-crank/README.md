# km-crank

The scheduled half-automatic evolution crank: a launchd-run script that scans
kkamak sensor streams (`.km/gate-outcomes.ndjson`) across dogfooded repos, and
— if enough new data has accumulated — runs ONE headless propose round
through the existing meta-harness engine (proposer + review gate + candidate
staging), then posts a SITREP to the user's Slack DM.

## What it does, each run

1. Reads `.km/gate-outcomes.ndjson` from each repo in `REPOS`
   (`~/z2/kkamak`, `~/z2/squad`, `~/z2/km-play`), resuming from the
   last recorded byte offset per file.
2. If fewer than 10 new lines have accumulated across all repos AND the last
   completed round was under 7 days ago AND `--force` wasn't passed: prints
   one skip line and exits. **No Slack post on routine skips** — positions
   are not advanced, so the new lines stay pending for the next run.
3. Otherwise: picks the repo with the most new lines as the target, builds
   an evidence markdown (per-repo aggregates + notable sessions), and runs a
   `project-global` propose round for that repo through
   `opencode-plugin`'s existing engine pieces (`buildProposerPrompt`,
   `ClaudeCodeHost.runTaskAgent`, `applyStagedArtifact`) — polling up to 10
   minutes for the proposer's staged artifact.
4. Posts a SITREP to Slack for every non-skip outcome: `PROPOSED+STAGED`,
   `REVIEW-REJECTED`, `NO-OP`, `PROPOSER-TIMEOUT`, or `FAILURE`.

## The two human touchpoints (v0.1 is half-automatic on purpose)

- **Reading the SITREP** — the crank never DMs anything except a summary;
  it does not auto-activate or auto-trial a candidate.
- **Launching a trial** — after a `PROPOSED+STAGED` SITREP, the user reviews
  the staged candidate and manually runs the usual A/B / trial flow
  (`bun term-bench2/runner.ts ab`, or lets the project's normal usage-trial
  machinery pick it up) — v0.1 does not do this automatically.

## Install

```bash
mkdir -p ~/.config/meta-harness/km-crank
cp com.kkamak.crank.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.kkamak.crank.plist
```

The `mkdir -p` step matters: launchd will NOT create `StandardOutPath`'s
parent directory for you, so the very first scheduled run would otherwise
fail to write `crank.log` at all. `crank.ts` also self-heals this directory
at startup (`fs.mkdirSync(..., { recursive: true })` before anything else
runs), so a bare `bun src/crank.ts` works even if this step is skipped — the
Install step just makes the very first launchd run's log capture work too.

To uninstall: `launchctl bootout gui/501/com.kkamak.crank`.

## Manual run

```bash
cd km-crank
bun src/crank.ts --force
```

`--force` bypasses the threshold/age gate (runs even with 0 new lines,
useful for a smoke test) but does NOT change the review gate or staging
behavior — a genuine no-op proposal still reports `NO-OP`.

## Where things live

- **Positions** (per-sensor-file byte offset + last-completed-run
  timestamp): `<accountMetaRoot()>/km-crank/positions.json` — typically
  `~/.config/meta-harness/km-crank/positions.json`. Host-local by design
  (each host tracks its own sensor-file offsets).
- **Evidence** (one markdown file per round, read by the proposer AND left
  for a human): `<accountMetaRoot()>/km-crank/evidence-<ts>/kkamak-sensors/km-crank.md`.
- **Logs** (launchd's stdout/stderr capture): `~/.config/meta-harness/km-crank/crank.log`.
- **Slack token**: read only inside `postSlack` from
  `~/.squad/ccacp-slack.env` (`SLACK_BOT_TOKEN`) — never logged.

## Concurrency guards

crank.ts always targets a project's `project-global` layer, so it must never
step on a candidate/trial that a live interactive Claude Code session is
managing on that same layer. Three checks run BEFORE any round-local state is
built (`nextVersion`, staging paths, evidence dir), pure-predicate logic
extracted into `src/gate.ts`'s `decideGate`:

1. **Threshold/age** (unchanged from v0.1): not enough new sensor lines and
   the last round was recent enough → routine skip.
2. **Trial-clobber guard**: `readTrial(layer.root) !== null` — a project
   layer trial is already live (started by an interactive session, or a
   prior crank round). `applyProposeArtifact`'s `startTrial` call would
   wholesale-replace `active/.trial`, losing the running trial's baseline
   snapshot and reattributing its already-scored sessions. Skip instead.
3. **Cross-process proposer guard**: `host.proposerInFlight?.(layer.root)` —
   a live CC session's own `/mh-propose` already has a lock file registered
   for this layer (`opencode-plugin/src/adapters/claude-code/proposer.ts`).
   Skip instead of racing it.

All three are routine skips: one log line, positions NOT advanced, **no
Slack post** (mirrors `triggerPropose`'s own skip behavior,
`opencode-plugin/src/propose.ts:141-149`).

**Why crank.ts does NOT call `host.stageArtifactApply`** (the mechanism
`triggerPropose` uses to register its own in-flight lock): `ClaudeCodeHost`'s
`stageArtifactApply` writes a lock file in the SAME format that
`proposer.ts`'s `applyPendingArtifacts` scans on **every** hook event
(wired in `dispatch.ts`, unconditionally, for any live CC session in the
worktree). If crank.ts registered there, a live interactive session firing
any hook (PostToolUse, Stop, …) while crank.ts's own round is in flight
would have `applyPendingArtifacts` find the same staged artifact crank.ts is
polling for and call `applyStagedArtifact` on it too — a real double-apply
race (two `createCandidate`/`startTrial` calls for one staged version), not
a hypothetical one.

So crank.ts only **checks** `proposerInFlight` (read-only, never registers
there) and instead takes a **crank-private round lock**
(`<accountMetaRoot()>/km-crank/crank.lock`, next to `positions.json`,
`src/gate.ts`'s `acquireCrankLock`/`releaseCrankLock`) that guards only
against two `crank.ts` **invocations** racing each other (e.g. a manual
`--force` run overlapping the scheduled launchd run). It is acquired right
after the gate decision — before `nextVersion()` — and released in a
`finally`, mirroring `triggerPropose`'s own `finally { inFlight.delete(...) }`.

**Accepted residual race**: because crank.ts's round is invisible to
`proposerInFlight` (by design — that lock format is CC's, not ours), a live
interactive session could start its own `/mh-propose` for the same layer in
the small window between crank.ts's `proposerInFlight` check and its
`nextVersion()` call. Worst case: two candidates land on the same layer with
adjacent version numbers (`vN` and `vN+1` both proposed off the same active
baseline) — never a corrupted or double-applied candidate, since each
process's `applyStagedArtifact` call only ever touches its own staged files.
This window is small (checked-then-acted, no I/O in between) and considered
acceptable for v0.1.

## Development

```bash
cd km-crank
bun install
bun test
bunx tsc --noEmit
```

`crank.ts` itself is intentionally NOT unit-tested in v0.1 — it is a thin
orchestration layer over the tested pure pieces (`scan.ts`, `positions.ts`,
`evidence.ts`, `sitrep.ts`'s `formatSitrep`, and `gate.ts`'s `decideGate` +
crank-lock helpers, which is WHERE the gating decisions described above
actually live and are unit-tested); its correctness is verified by
the first live run. `postSlack` and any real `claude` spawn are never
exercised by the test suite.
