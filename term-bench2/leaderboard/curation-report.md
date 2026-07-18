# Leaderboard band curation report

Generated 2026-07-18T13:12:57.457Z by term-bench2/leaderboard/curate-band.ts

## Inputs
- matrix.json: 43 tasks (post-fail-filter), 2 submissions
- tiers.json: 10 submissions mapped
- --results: ../results/account-global-v0-baseline-sonnet.json, ../results/account-global-v0-baseline-haiku.json
- ourRates: 43 tasks with a local pass rate
- localTasks (TB2 checkout): 89 task dirs with task.toml
- band=[0.2, 0.8]  max=30  minSubs=4  ranking=tierVariance  trustLeaderboardFails=false

## Unanimous-fail tasks excluded (46)
Every reporting submission scored 0 — excluded pending Phase 5's gate on whether this is a genuine difficulty signal or an infra/verifier artifact. Re-run with `--trust-leaderboard-fails` to include them.

- break-filter-js-from-html
- caffe-cifar-10
- chess-best-move
- circuit-fibsqrt
- compile-compcert
- crack-7z-hash
- db-wal-recovery
- dna-assembly
- dna-insert
- extract-moves-from-video
- feal-differential-cryptanalysis
- filter-js-from-html
- financial-document-processor
- fix-ocaml-gc
- gcode-to-text
- git-multibranch
- gpt2-codegolf
- install-windows-3.11
- large-scale-text-editing
- largest-eigenval
- llm-inference-batching-scheduler
- mailman
- make-doom-for-mips
- make-mips-interpreter
- mteb-retrieve
- overfull-hbox
- path-tracing-reverse
- polyglot-c-py
- polyglot-rust-c
- protein-assembly
- qemu-alpine-ssh
- query-optimize
- raman-fitting
- regex-chess
- reshard-c4-data
- rstan-to-pystan
- sam-cell-seg
- sparql-university
- sqlite-db-truncate
- torch-pipeline-parallelism
- torch-tensor-parallelism
- train-fasttext
- tune-mjcf
- video-processing
- winning-avg-corewars
- write-compressor

## Band (0/30 cap)
Local + variance-trusted + in-band + we already have a local pass rate. Sorted by tier variance, descending.


## Shortlist (0)
Same qualification as band, but no local ourRates entry yet — run these locally before promoting.


## Excluded — not in local TB2 checkout (0)
Qualifies on leaderboard variance/band criteria but has no task.toml under the local checkout — fetch via `bench task-load`.

