# km-crank

The scheduled half-automatic evolution crank: a launchd-run script that scans
kkamak sensor streams (`.km/gate-outcomes.ndjson`) across dogfooded repos, and
— if enough new data has accumulated — runs ONE headless propose round
through the existing meta-harness engine (proposer + review gate + candidate
staging), then posts a SITREP to the user's Slack DM.

## What it does, each run

1. Reads `.km/gate-outcomes.ndjson` from each repo in `REPOS`
   (`~/z2/meta-harness`, `~/z2/squad`, `~/z2/km-play`), resuming from the
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
cp com.kkamak.crank.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.kkamak.crank.plist
```

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

## Development

```bash
cd km-crank
bun install
bun test
bunx tsc --noEmit
```

`crank.ts` itself is intentionally NOT unit-tested in v0.1 — it is a thin
orchestration layer over the tested pure pieces (`scan.ts`, `positions.ts`,
`evidence.ts`, `sitrep.ts`'s `formatSitrep`); its correctness is verified by
the first live run. `postSlack` and any real `claude` spawn are never
exercised by the test suite.
