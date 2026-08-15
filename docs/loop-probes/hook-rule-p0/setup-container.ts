// Creates + starts the P0 probe container with the exact cmd-run.ts
// claude-code auth recipe (p2/PROBE.md container-setup precedent), through
// the codebase's own exec funnel (exec.ts podman() — pipes + env merge),
// NOT a hand-rolled spawn. Prints NAME and AUTH_TMP for later steps. Does
// NOT install cleanup — teardown is Task 4 (container must outlive this
// process; Task 4 Step 1 zero-fills the exported credential the way
// agent-auth's own cleanup() does).
// Run: bun docs/loop-probes/hook-rule-p0/setup-container.ts
import { prepareClaudeCodeAuth } from "../../../opencode-plugin/src/bench/agent-auth.ts"
import { buildCreateArgv, buildStartArgv } from "../../../opencode-plugin/src/bench/sandbox.ts"
import { podman } from "../../../opencode-plugin/src/bench/exec.ts"
import { dirname } from "node:path"

const name = `hookrule-p0-${Math.floor(Date.now() / 1000)}`
const auth = prepareClaudeCodeAuth()
const create = buildCreateArgv({
  image: "localhost/mh-bench:latest",
  name,
  mounts: auth.mounts,
  env: { IS_SANDBOX: "1", ...(auth.env ?? {}) },
})
for (const argv of [create, buildStartArgv(name)]) {
  const r = await podman(argv)
  if (r.rc !== 0) {
    console.error(r.stderr)
    process.exit(1)
  }
}
// tmpRoot = parent of the first mount's host path (agent-auth's mkdtemp dir).
console.log(`NAME=${name}`)
console.log(`AUTH_TMP=${dirname(auth.mounts[0]!.host)}`)
