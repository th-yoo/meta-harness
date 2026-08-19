#!/usr/bin/env bun
/**
 * check-dockerfile-staging.ts — drives the REAL runtime staging parser
 * (opencode-plugin/src/bench/staging.ts's `parseTaskDockerfile`, unchanged,
 * not a hand-mirror) over gcode-to-text-gate's REAL
 * environment/Dockerfile, and asserts the resolved staging plan matches
 * what the task actually needs.
 *
 * Why this exists (Task-4 review CRITICAL): smoke-container.sh's staging
 * step hand-mirrors the intended `pip install numpy` / COPY behavior with
 * its own podman commands -- it never parses the Dockerfile text at all, so
 * a Dockerfile authored in a way the real parser misreads (e.g. a `||
 * echo "...install..."` fallback whose prose contains the literal word
 * "install", which extractPipSegments treats as a second pip-install
 * marker and folds the rest of the message into the package list) is
 * invisible to that smoke evidence. This script closes that gap by calling
 * the actual parser used by `bun term-bench2/runner.ts run`/`prep`/`oracle`
 * and failing loudly if its output ever drifts from what the task expects.
 *
 * Usage:
 *   bun term-bench2/seam-gate/test/check-dockerfile-staging.ts
 *
 * Exit 0 + a summary on success; exit 1 + a diff-style explanation on any
 * mismatch. No podman, no model calls -- pure parse.
 */

import { makeBenchPaths } from "../../../opencode-plugin/src/bench/paths.ts"
import { parseTaskDockerfile } from "../../../opencode-plugin/src/bench/staging.ts"

const TASK = "gcode-to-text-gate"
const PROBE_TASKS_DIR = new URL("../../probe-tasks/", import.meta.url).pathname

let failures = 0

function fail(msg: string) {
  console.error(`FAIL: ${msg}`)
  failures++
}

function pass(msg: string) {
  console.log(`PASS: ${msg}`)
}

const paths = makeBenchPaths({ tbRoot: PROBE_TASKS_DIR })
const staging = parseTaskDockerfile(paths, TASK)

// ---------------------------------------------------------------------
// 1. Exactly one pip step, resolving to exactly ["numpy"] -- the Task-4
//    review's CRITICAL bug produced ["numpy", "failed", "continuing",
//    "fails", "open", "without", "it)"] instead; this is the direct
//    regression guard for that.
// ---------------------------------------------------------------------
const pipSteps = staging.steps.filter((s): s is Extract<typeof s, { kind: "pip" }> => s.kind === "pip")
if (pipSteps.length !== 1) {
  fail(`expected exactly 1 pip staging step, got ${pipSteps.length}: ${JSON.stringify(pipSteps)}`)
} else {
  const packages = pipSteps[0]!.packages
  const expected = ["numpy"]
  if (JSON.stringify(packages) !== JSON.stringify(expected)) {
    fail(
      `pip package list resolved to ${JSON.stringify(packages)}, expected exactly ${JSON.stringify(expected)} ` +
        `-- a prose word in the Dockerfile's RUN line is very likely being misparsed as a package name again ` +
        `(see this file's header docstring)`,
    )
  } else {
    pass(`pip packages resolve to exactly ${JSON.stringify(packages)}`)
  }
}

// ---------------------------------------------------------------------
// 2. COPY entries include the seam/ directory staged to /app/.seam/ and
//    dot-claude/settings.json staged to /app/.claude/settings.json.
// ---------------------------------------------------------------------
const copySteps = staging.steps.filter((s): s is Extract<typeof s, { kind: "copy" }> => s.kind === "copy")

const seamCopy = copySteps.find((s) => s.src === "task-deps/seam/")
if (!seamCopy) {
  fail(`no COPY step found with src "task-deps/seam/" (COPY steps seen: ${JSON.stringify(copySteps)})`)
} else if (seamCopy.dst !== "/app/.seam/" || !seamCopy.contentsOnly) {
  fail(
    `COPY task-deps/seam/ resolved to dst=${JSON.stringify(seamCopy.dst)} contentsOnly=${seamCopy.contentsOnly}, ` +
      `expected dst="/app/.seam/" contentsOnly=true`,
  )
} else {
  pass(`COPY task-deps/seam/ -> /app/.seam/ (contents-only) present and correct`)
}

const settingsCopy = copySteps.find((s) => s.src === "task-deps/dot-claude/settings.json")
if (!settingsCopy) {
  fail(
    `no COPY step found with src "task-deps/dot-claude/settings.json" (COPY steps seen: ${JSON.stringify(copySteps)})`,
  )
} else if (settingsCopy.dst !== "/app/.claude/settings.json") {
  fail(`COPY task-deps/dot-claude/settings.json resolved to dst=${JSON.stringify(settingsCopy.dst)}, expected "/app/.claude/settings.json"`)
} else {
  pass(`COPY task-deps/dot-claude/settings.json -> /app/.claude/settings.json present and correct`)
}

// ---------------------------------------------------------------------
// 3. Base image sanity (the task's own FROM line, not an approximation).
// ---------------------------------------------------------------------
if (staging.baseImage !== "python:3.13-slim-bookworm") {
  fail(`baseImage resolved to ${JSON.stringify(staging.baseImage)}, expected "python:3.13-slim-bookworm"`)
} else {
  pass(`baseImage resolves to "python:3.13-slim-bookworm"`)
}

console.log("==================================================")
if (failures > 0) {
  console.error(`check-dockerfile-staging: ${failures} check(s) FAILED`)
  process.exit(1)
}
console.log("check-dockerfile-staging: all checks PASSED (real parseTaskDockerfile, real Dockerfile)")
process.exit(0)
