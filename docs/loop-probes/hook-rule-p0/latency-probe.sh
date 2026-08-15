#!/bin/bash
# Mean per-call cost of a 13-pattern ERE loop (the bench evaluator shape;
# r16 excluded — see step description) —
# 10000 iterations inside one process, wall-clocked by `time`.
# Run: /bin/bash docs/loop-probes/hook-rule-p0/latency-probe.sh
PATTERNS=(
  '^(npm|yarn) +(install|add)( |$)'
  '^pip +install '
  '^rm +-rf +/(etc|usr|var)(/|$)'
  '^git +push +.*--force'
  '^curl +[^|]*\| *(bash|sh)( |$)'
  '^(cat|head|tail) +[^ ]*\.(log|ndjson)'
  '^sed +-i '
  '^echo +.*>>? *[^ ]+\.(ts|js|py)( |$)'
  '^(python|python3) +-m +pytest'
  '^docker '
  '^grep +[^ ]*-r'
  '^find +[./]'
  '^(ls|pwd|whoami)( |$)'
)
LONG=$(printf 'x%.0s' $(seq 1 10000))
INPUTS=("ls -la" "npm install left-pad" "git status --porcelain" "true $LONG")
ITERS=10000
run() {
  local i input p n=0
  for ((i = 0; i < ITERS; i++)); do
    input="${INPUTS[$((i % ${#INPUTS[@]}))]}"
    for p in "${PATTERNS[@]}"; do
      [[ $input =~ $p ]] && n=$((n + 1))
    done
  done
  echo "matches: $n"
}
echo "iters: $ITERS (mean per-call = real_seconds / $ITERS)"
time run
