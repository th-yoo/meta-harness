/**
 * sandbox.ts — podman argv builders (pure; nothing here spawns a process).
 *
 * Design decision: podman replaces the old Python runner's bwrap sandbox
 * (term-bench2/runner.py's `ns_wrap`, runner.py:352-433). bwrap gave one
 * process a private mount namespace over a shared, persistent $HOME work
 * root (BENCH_WORK / MH_BENCH_WORK) so concurrent runs needed careful
 * per-run path isolation (symlink farms, EXDEV-safe /tmp placement, etc).
 * podman instead gives each task attempt its own container — a real
 * clean-room — so none of that host-side isolation machinery is needed;
 * concurrency is just distinct container names (see paths.ts:containerName).
 *
 * A task attempt is multiple sequential steps (setup -> agent -> verifier)
 * that must share one filesystem, so the shape here is create+start once,
 * then `podman exec` per step against a long-lived `sleep infinity`
 * container — mirroring how bwrap's ns_wrap ran multiple run_cmd calls over
 * the same ~/bench state. `--init` lets `sleep` reap children; `podman rm -f
 * -t 0` then kills the whole process tree instantly.
 *
 * Network stays ENABLED by default (parity: bwrap shared the host network
 * namespace, and upstream test.sh self-bootstraps uvx/pytest over the
 * network). Root inside the container is fine — real sudo, real /app, real
 * apt-get — because determinism instead comes from SKIP_APT=1 plus
 * pre-unioned packages baked into the image (see term-bench2/Containerfile).
 *
 * Credential mounts for the agent phase are NOT this task's concern (P6).
 * The exec funnel that actually calls podman is P3.
 */

export interface SandboxSpec {
  image: string
  name: string
  mounts?: { host: string; container: string; ro?: boolean }[]
  env?: Record<string, string>
  /** default "/app" */
  workdir?: string
  /** default true (parity — see module header) */
  network?: boolean
}

export function buildCreateArgv(spec: SandboxSpec): string[] {
  const mounts = spec.mounts ?? []
  const env = spec.env ?? {}
  const workdir = spec.workdir ?? "/app"
  const network = spec.network ?? true
  return [
    "podman",
    "create",
    "--name",
    spec.name,
    "--init",
    ...(network ? [] : ["--network", "none"]),
    ...mounts.flatMap((m) => ["-v", `${m.host}:${m.container}${m.ro ? ":ro" : ""}`]),
    ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    "-w",
    workdir,
    spec.image,
    "sleep",
    "infinity",
  ]
}

export function buildStartArgv(name: string): string[] {
  return ["podman", "start", name]
}

export function buildExecArgv(
  name: string,
  cmd: string[],
  opts?: { env?: Record<string, string>; workdir?: string },
): string[] {
  const env = opts?.env ?? {}
  const workdir = opts?.workdir ?? "/app"
  return [
    "podman",
    "exec",
    ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    "-w",
    workdir,
    name,
    ...cmd,
  ]
}

export function buildCpToArgv(name: string, hostPath: string, containerPath: string): string[] {
  return ["podman", "cp", hostPath, `${name}:${containerPath}`]
}

export function buildCpFromArgv(name: string, containerPath: string, hostPath: string): string[] {
  return ["podman", "cp", `${name}:${containerPath}`, hostPath]
}

/** -f: remove even if running. -t 0: no graceful-stop grace period — --init
 * means `sleep infinity` has no children to signal-and-wait for. */
export function buildRmArgv(name: string): string[] {
  return ["podman", "rm", "-f", "-t", "0", name]
}

export function buildImageBuildArgv(containerfile: string, contextDir: string, tag: string): string[] {
  return ["podman", "build", "-f", containerfile, "-t", tag, contextDir]
}
