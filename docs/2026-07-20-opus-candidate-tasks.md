# Opus candidate tasks — leaderboard-derived target band (2026-07-20)

**Why this doc:** openssl-selfsigned-cert turned out to be a *poor single target* (near-ceiling
for any decent harness → n=2 lift was noisy + artifact-dominated). This doc replaces the
cherry-picked task with a *principled candidate set* derived from the official Terminal-Bench 2.0
leaderboard, so the opus re-baseline targets tasks with **genuine workflow headroom** and skips
capability-bound ones.

## Method — cross-reference two leaderboard entries (scraped via playwright, ground truth)

| Entry | Agent (harness) | Model | Trials/task | Overall |
|---|---|---|---|---|
| **My-harness family** | **OpenCode** (Anomaly Innovations) | Claude Opus 4.5 | **1** | **51.7%** |
| **Strong-harness ref** | **WOZCODE** | Claude Opus 4.7 | 5 | 80.2% |

(Other Opus entries seen: Meta-Harness/Opus-4.6/Stanford-IRIS **76.4%** #11; Claude-Code/Opus-4.6
58.0% #50; Claude-Code/Opus-4.5 52.1% #61. My bench driver = **opencode**, so #64 is the harness
match. My model = **opus-4-8**, newer than anything on the board — 4.8 is *stronger* than 4.5, so
the re-baseline MUST re-measure; the leaderboard gives the candidate POOL, not the final band.)

**Headline insight:** opencode+opus-4.5 = 51.7% vs wozcode+opus-4.7 = 80.2% — **same model class,
~28pp gap is almost entirely HARNESS/WORKFLOW.** That gap *is* the research target. openssl was
just 1 of ~26 tasks inside it.

**Classification rule** (per task where opencode+opus-4.5 FAILED, i.e. 0/1):
- wozcode ≥80% → **Category A: workflow-fixable, HIGH headroom** (strong harness reliably solves;
  my harness whiffs → the failure is workflow/tooling, low capability risk).
- wozcode 20–60% → **Category B: partial even for the strong harness** (capability-tinged, flaky).
- wozcode <20% → **SKIP: capability-bound** (no harness fixes it — the trap that killed the haiku
  experiment).

## Category A — primary re-baseline pool (26 tasks) → `splits/opus-candidates-A.txt`

break-filter-js-from-html·(100) build-pmars·(100) cancel-async-tasks·(100) chess-best-move·(80)
configure-git-webserver·(100) count-dataset-tokens·(100) **db-wal-recovery·(100)** extract-elf·(80)
feal-linear-cryptanalysis·(100) financial-document-processor·(100) headless-terminal·(100)
mailman·(100) make-mips-interpreter·(100) **openssl-selfsigned-cert·(100)** **path-tracing·(80)**
path-tracing-reverse·(100) polyglot-c-py·(100) polyglot-rust-c·(80) pytorch-model-recovery·(100)
qemu-startup·(100) query-optimize·(100) sanitize-git-repo·(100) sparql-university·(100)
torch-pipeline-parallelism·(100) winning-avg-corewars·(80) write-compressor·(100)

(parenthetical = wozcode opus-4.7 resolution %. **Bold** = the 3 tasks the detection prototype
already classified: openssl→looks_done, db-wal-recovery→looks_done, path-tracing→incomplete/
time-mgmt. All three land in Category A → validates the pick.)

## Category B — secondary (9 tasks) → `splits/opus-candidates-B.txt`

dna-insert·(40) gcode-to-text·(40) gpt2-codegolf·(20) model-extraction-relu-logits·(40)
mteb-leaderboard·(40) mteb-retrieve·(40) protein-assembly·(60) torch-tensor-parallelism·(60)
video-processing·(20)

## SKIP — capability-bound (8 tasks, no headroom)

caffe-cifar-10 filter-js-from-html install-windows-3.11 make-doom-for-mips raman-fitting
regex-chess sam-cell-seg train-fasttext

## Caveats

1. **opencode entry is 1-trial** → each 0/1 is a *noisy* point estimate; a "fail" may pass
   sometimes. The re-baseline (k≥3–5) is what actually measures my harness.
2. **My model is opus-4-8 > 4.5** → some Category-A tasks may now pass unprompted on 4.8. The
   re-baseline keeps only tasks that land **0 < pass < 1** on opus-4-8+opencode = the evolvable band.
3. WebFetch's earlier summary of the wozcode page was **wrong on several tasks** — these numbers
   come from playwright DOM scrape (ground truth). Don't trust the WebFetch version.

## Next step

**Opus-4.8 re-baseline of Category A** (k≥3–5) in my harness (`--layers account`,
`META_HARNESS_HOME=<repo>/.meta-harness`). Keep tasks with `0 < pass < 1` → the evolvable band.
Then: failure-taxonomy → distilled lesson (memory/risk-hints) → inject → McNemar + held-out gate.
