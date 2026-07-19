# Repository guidance

## Save shareable artifacts under the repo — not host-local paths

Any artifact meant to be reused, or used on another host, MUST live under the
git-tracked repo so it travels everywhere via `git push`/`pull`. This project runs
across multiple machines (WSL2 Linux box, MacBook); **cross-host transfer is
git-only** — host-local state does NOT transfer.

**Host-local — does NOT travel (never the source of truth for shared work):**
- `.meta-harness/`, `~/.config/meta-harness/` — runtime store (gitignored)
- `/mnt/d/tmp/`, `/tmp/`, `$CLAUDE_JOB_DIR` — scratch scripts + temp files
- `~/.claude/` — personal memory
- `resource-profiles/` — deliberately host-class-keyed + gitignored

**Durable / shareable → commit under the repo:**
- loop artifacts (candidates, scores, ab-verdicts) → `term-bench2/store/` snapshot
  via **surgical, diff-first** sync (blind `store-sync.sh export` is the data-loss trap)
- reusable scripts / recipes / procedures → the repo (or transcribe the exact steps
  into `docs/resume.md` so they reconstruct on any host)
- design, state, decisions → `docs/` + the `docs/resume.md` handoff

**Live proof:** a paused k=5 ab partial left in `.meta-harness/` on one host is
stranded — another host cannot resume it. If it needs sharing, it must reach the
committed snapshot.
