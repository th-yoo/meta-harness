# RESUME — start here

**New session / new host: read this first.** (Personal memory is host-local and
does NOT transfer; this file + the repo are the source of truth.)

## Where we are (2026-07-14)

First propose→ab improvement loop (#5). Done: baseline (haiku pass@5 **0.381**),
14-task band split, store-writing run, **propose → account-global `v1`**
(a real generalized playbook). **NEXT: run `ab` (v0 vs v1) — the verdict step.**

Full detail + v1's diagnosis & playbook: **[loop-1-state.md](loop-1-state.md)**.

## Resume the loop (Path A — keeps this exact v1)

1. `cd ~/z2/meta-harness && git pull`
2. Bring the account store over (holds v0 diet + **v1** — NOT in git). On the target host:
   ```
   [ -d ~/.config/meta-harness ] && mv ~/.config/meta-harness ~/.config/meta-harness.bak
   scp -r th-yoo@<linux-host>:~/.config/meta-harness ~/.config/
   ls ~/.config/meta-harness/global/candidates/    # expect: v0 v1
   ```
3. Bench prereqs (macOS): `podman machine start` (if needed) → `bun term-bench2/runner.ts prep --apply`. Needs the TB2 task repo at `~/z2/terminal-bench-2`.
4. Run `ab` (detached, ~3–5 hr, resumable):
   ```
   nohup bun term-bench2/runner.ts ab --layer account-global --candidate v1 \
     --split-file term-bench2/splits/loop1.json --model anthropic/claude-haiku-4-5 \
     --k 2 --resume > term-bench2/logs/loop1-ab.log 2>&1 &
   ```
5. Verdict: `bun term-bench2/runner.ts report-loop`; on accept → `/mh-activate account v1`.

**No scp?** Path B (re-derives a DIFFERENT v1): after step 1, store-writing run
`run --task-file term-bench2/splits/loop1-band.txt --k 2 --layers account --model anthropic/claude-haiku-4-5`,
then start opencode + `/mh-propose account` (the `external_directory` grant is already in `opencode.json`), then `ab` as above.

## Gotchas (already handled, don't re-hit)
- Account-scope propose needs `opencode.json` → `"permission": {"external_directory": "allow"}` (committed) — else the headless proposer hangs on a permission prompt.
- `--results-file` forces `--no-store` (a run feeds the store OR writes results, never both); store-writing runs aren't resumable; `ab` is.

## Bigger map
`docs/INDEX.md` → all design docs. Saved-but-unexecuted plan:
`docs/superpowers/plans/2026-07-14-cc-opencode-prompt-mining.md`.
