#!/bin/sh
# Scorer for sparql-university — mirrors the upstream tests/test.sh (uvx with
# pinned pytest/rdflib against /tests/test_outputs.py), minus the TB2
# ctrf/reward.txt plumbing: minimal's reward contract is this script's exit
# code. Runs INSIDE the container, injected only after the agent's attempt.
set -e
export PATH="$HOME/.local/bin:$PATH"
if ! command -v uv >/dev/null 2>&1; then
  command -v curl >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq curl >/dev/null; }
  curl -LsSf https://astral.sh/uv/0.9.5/install.sh | sh >/dev/null
fi
cd /app
exec uvx -p 3.13 -w pytest==8.4.1 -w rdflib==7.1.4 pytest /tests/test_outputs.py -rA
