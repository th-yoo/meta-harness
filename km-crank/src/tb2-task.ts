/** Phase 2 TB2 renderers — PURE string generation for a harvested task dir
 * in the terminal-bench-2 layout. No fs. */

export const TEST_PRISTINE_GLOBS = ["test", "tests", "__tests__"]  // dirs restored by the tamper guard

export function renderTaskToml(a: {
  name: string; description: string
  agentTimeoutSec: number; verifierTimeoutSec: number
}): string {
  return `schema_version = "1.1"
artifacts = []

[task]
name = "terminal-bench/${a.name}"
description = ${JSON.stringify(a.description)}
keywords = ["harvested", "kkamak"]

[metadata]
difficulty = "medium"
category = "harvested"
tags = ["harvested", "dogfood"]

[verifier]
timeout_sec = ${a.verifierTimeoutSec}.0

[agent]
timeout_sec = ${a.agentTimeoutSec}.0

[environment]
build_timeout_sec = 900.0
cpus = 1
memory_mb = 2048
storage_mb = 10240
gpus = 0
allow_internet = true
mcp_servers = []
`
}

export function renderDockerfile(_a: Record<string, never>): string {
  return `FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates unzip git python3 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:\${PATH}"
WORKDIR /app
COPY repo/ /app/
# The materialized tree is a git-archive extract with no .git — checks that
# shell out to git (e.g. gate-check's dirtyTreeId) die on "not a git
# repository" without this. Commit BEFORE installing so node_modules never
# enters the commit even when the tree ships no .gitignore.
RUN git config --global user.email fixture@kkamak && git config --global user.name kkamak-fixture && git init -q && git add -A && git commit -qm "capture-time tree"
# Monorepo roots may have no package.json (a root \`bun install\` silently
# no-ops), so install every package dir; per-dir failures are tolerated —
# a flaky registry must not brick the build, the agent can re-run install.
RUN for d in $(find . -maxdepth 2 -name package.json -not -path '*/node_modules/*' -exec dirname {} \\;); do (cd "$d" && (bun install --frozen-lockfile || bun install)) || true; done
`
}

export function renderTestSh(a: { check: string }): string {
  return `#!/bin/bash
# Harvested-fixture verifier: restore pristine test files (tamper guard),
# then run the original failing check. Reward 1 iff it passes.
set -u
mkdir -p /logs/verifier
cd /app
# Tamper guard: the check lives inside the repo, so an agent could "pass"
# by editing the tests. Restore test dirs from the capture-time archive.
# Fail CLOSED if the archive won't extract: a torn/tampered pristine.tar
# must never let the check run against unrestored (possibly agent-edited)
# test files — reward 0 and stop, rather than continuing on a shakier
# guarantee.
if [ -f /tests/pristine.tar ]; then
  if ! tar -xf /tests/pristine.tar -C /app; then
    echo 0 > /logs/verifier/reward.txt
    exit 0
  fi
fi
if ( ${a.check} ); then
  echo 1 > /logs/verifier/reward.txt
else
  echo 0 > /logs/verifier/reward.txt
fi
`
}

export function renderInstruction(a: {
  check: string
  prompt: { firstUser?: string; lastUser?: string }
  excerpt?: string
}): string {
  const parts: string[] = ["# Task (harvested from a live blocked cycle)\n"]
  if (a.prompt.firstUser) parts.push(`## Original session ask\n\n${a.prompt.firstUser}\n`)
  if (a.prompt.lastUser && a.prompt.lastUser !== a.prompt.firstUser)
    parts.push(`## Most recent instruction before the block\n\n${a.prompt.lastUser}\n`)
  parts.push(`## Your goal\n\nThe repository in /app currently FAILS its check. Make the following command pass without weakening or deleting tests:\n\n~~~\n${a.check}\n~~~\n`)
  if (a.excerpt) parts.push(`## Failing check output at capture time\n\n~~~\n${a.excerpt}\n~~~\n`)
  return parts.join("\n")
}
