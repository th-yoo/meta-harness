/**
 * cmd-prep.ts — `prep [--apply]` subcommand.
 *
 * CLI-surface parity only with term-bench2/runner.py's cmd_prep (:448-571):
 * same --apply dry-run/execute split, but the host-apt-install logic it used
 * to print/run is entirely replaced by `podman build` of term-bench2/
 * Containerfile (see sandbox.ts's buildImageBuildArgv and P2's Containerfile).
 * `--uninstall` / `--clean-mountpoints` were bwrap-era host package/mountpoint
 * cleanup with no podman equivalent — intentionally dropped, not ported.
 */
import { join } from "node:path"
import { podman } from "./exec.ts"
import { buildImageBuildArgv } from "./sandbox.ts"
import { BENCH_IMAGE, type BenchPaths } from "./paths.ts"
import { die, log } from "./util.ts"

export async function cmdPrep(paths: BenchPaths, args: { apply?: boolean }): Promise<void> {
  const containerfile = join(paths.termBenchDir, "Containerfile")
  const argv = buildImageBuildArgv(containerfile, paths.termBenchDir, BENCH_IMAGE)

  if (!args.apply) {
    console.log("# One-time host setup — run with --apply to execute:")
    console.log()
    console.log(argv.join(" "))
    console.log()
    console.log("# Run: runner.ts prep --apply")
    return
  }

  log("Building bench image...")
  const result = await podman(argv)
  if (result.stdout) console.log(result.stdout)
  if (result.stderr) console.error(result.stderr)
  if (result.rc !== 0) {
    die(`podman build failed (exit ${result.rc})`)
  }
  log("Build complete.")
}
