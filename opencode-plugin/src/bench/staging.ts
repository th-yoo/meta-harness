/**
 * staging.ts — runtime Dockerfile staging: ports term-bench2/gen_setup_deps.py's
 * parsing/translation rules into the runner itself, so a task's
 * `<tbRoot>/<task>/environment/Dockerfile` is interpreted straight from the
 * upstream checkout at run time instead of executing a vendored, committed
 * `setup_deps.sh` (see cmd-oracle.ts's `--staging scripts|runtime`).
 *
 * Env-fidelity fix (docs/env-fidelity-spotcheck.md): `stageTaskRuntime` no
 * longer reads a task's `environment/` directory through a persistent `/tb`
 * bind mount (agent containers no longer get one at all — cmd-run.ts's own
 * header covers the container-create side of this). Instead it `podman cp`s
 * just `<tbRoot>/<task>/environment` into a throwaway in-container path
 * (`STAGE_DIR`, `/.mh-stage`) BEFORE replaying any step, resolves every COPY
 * source against that staged copy instead of `/tb/<task>/environment`, and
 * `rm -rf`s `STAGE_DIR` as the FINAL action once every step has run — so an
 * agent that inspects the filesystem after staging finds neither the host
 * mount nor a lingering pristine copy of the task's fixtures. cmd-oracle.ts's
 * own container still keeps a persistent `/tb` mount (it legitimately needs
 * live access for `solution/solve.sh`), but calls this SAME function, so its
 * staging step gets the identical stage-then-purge treatment — harmless
 * there since the mount remains available for what oracle still needs.
 *
 * Porting notes (see the task brief for the full rationale):
 *  - FROM: base image is recorded for logging only — never pulled/built. The
 *    shared bench image (term-bench2/Containerfile) is a deliberate
 *    approximation that unions every task's real dependencies, so a
 *    non-ubuntu:24.04 base is just noted, not honored.
 *  - WORKDIR is HONORED as a persistent cwd — a deliberate DEVIATION from
 *    gen_setup_deps.py (whose WORKDIR handler is a no-op `pass`; the
 *    generated scripts always operate against a fixed $WORKDIR regardless of
 *    the Dockerfile's own WORKDIR value). That no-op is a genuine generator
 *    bug: crack-7z-hash's `WORKDIR /app/john/src` then `RUN ./configure` must
 *    run in /app/john/src, not /app. This port tracks a current-workdir
 *    threaded through parseTaskDockerfile's single instruction pass
 *    (default "/app"): absolute WORKDIR replaces it, relative WORKDIR
 *    resolves against the previous value (Docker semantics), and every
 *    subsequent "run"/"pip" step records the cwd active when it was
 *    encountered (stageTaskRuntime mkdir -p's and cd's into it before the
 *    command — see cwdPrefix — but only when it differs from the default
 *    /app, so existing behavior for WORKDIR-less Dockerfiles is unchanged).
 *    COPY dst resolution ("." / "./") also resolves against the current
 *    cwd instead of a hardcoded /app.
 *  - ARG: a bare `ARG NAME` (no default) is build-arg-supplied and
 *    contributes nothing (none of our tasks pass build args). `ARG
 *    NAME=default` is a second DEVIATION from gen_setup_deps.py (which
 *    ignores ARG entirely, lumped in with the other lifecycle directives):
 *    Docker makes a defaulted ARG available to subsequent RUN steps exactly
 *    like ENV, so this port accumulates `ARG NAME=default` into the same env
 *    map ENV uses — bn-fit-modify's `ARG BN_URL=...` followed by `RUN curl
 *    "${BN_URL}"` otherwise trips `set -u` (unbound variable).
 *  - ENV: accumulated into one flat map and applied (as `export K="V"` lines,
 *    with any embedded `$VAR` reference guarded as `${VAR:-}` to survive
 *    `set -u`, mirroring gen_setup_deps.py's make_env_section) before EVERY
 *    subsequent copy/pip/run step — this is a deliberate hoist-to-top that
 *    matches the generated script's section order (env section always
 *    precedes copy/pip/raw sections there, regardless of the ENV directive's
 *    original position in the Dockerfile).
 *  - COPY: dst resolution mirrors the generated scripts' `cp` handling
 *    exactly (dir-vs-file, trailing-slash "copy contents" via `cp -r
 *    src/. dst`, mkdir -p of the right parent). `EXTRAS_ROOT` is dead: a
 *    destination outside /app is now just a real container path (the podman
 *    container filesystem is writable everywhere — see sandbox.ts). Any
 *    `COPY --from=...` (uv binary copy, or a named build stage as in
 *    financial-document-processor's multi-stage Dockerfile) is skipped
 *    entirely, matching the generator's own silent no-op for both cases
 *    (it only special-cases uv as a *flag*, `has_uv_copy`, which the codegen
 *    template never actually reads). Multi-source COPY (`COPY a b c dest/`)
 *    is a third DEVIATION from gen_setup_deps.py: the generator keeps only
 *    `parts[0]`/`parts[-1]` (bug-for-bug — a real instance is build-pmars's
 *    `COPY warriors/flashpaper.red warriors/rave.red /app/`, which the
 *    generator would silently drop rave.red from). Docker requires the dest
 *    of a multi-source COPY to be a directory, so this port instead emits a
 *    copy for EVERY source when there are 2+ of them — correctness for
 *    non-vendored tasks over exact generator parity. Single-source COPY
 *    behavior is unchanged.
 *  - RUN: apt-get/apt INSTALL lines contribute package names (verbatim port
 *    of gen_setup_deps.py's extract_apt_packages token rules — noise-word
 *    filtering, version-pin stripping, the libgl1-mesa-glx/libglib2.0-0
 *    Ubuntu-24.04 rename table, chromium/chromium-driver/sudo skip-list) into
 *    `TaskStaging.aptPackages`, deduped+sorted (matching manifest.json's
 *    `apt` field and gen_setup_deps.py's own make_apt_section, both of which
 *    apply `sorted(set(...))`). This is Option A (2026-07-11): the shared
 *    bench image no longer carries a Python-library-shadowing package union
 *    (see term-bench2/Containerfile's header for the debian-numpy-shadowing
 *    root cause) — each task now genuinely `apt-get install`s its own real
 *    Dockerfile-declared packages at staging time, since podman containers
 *    have real root + network (see stageTaskRuntime: this becomes the FIRST
 *    exec'd step, ahead of copy/pip/run, when non-empty). pip3/pip/uv-pip-
 *    install/uv-add lines contribute package specs (verbatim, version pins
 *    included) to ONE combined venv+`uv pip install` step — mirroring
 *    gen_setup_deps.py's make_pip_section, which always combines every
 *    task's pip packages into a single install line regardless of how many
 *    RUN lines matched. The venv lives at PIP_VENV (/opt/.venv, NOT /app —
 *    a DEVIATION from the generator's /$WORKDIR/.venv, made for the B1 live
 *    diagnosis fix; see PIP_VENV's own doc comment) and every subsequent
 *    "run" step's script sources it first if present (VENV_ACTIVATE_GUARD —
 *    the B2 live diagnosis fix), since each step is its own `podman exec`
 *    and a venv `source`'d in one exec never carries over to the next.
 *    EXCEPTION: a pip line carrying `--break-system-packages` (PEP 668 /
 *    Docker's explicit "install into the SYSTEM python" request) installs
 *    system-wide via `pip3 install --break-system-packages` in its OWN pip
 *    step (StagingStep.systemWide) — NOT the venv — so bare `python3`
 *    everywhere, including the task's own solve.sh run outside staging, sees
 *    those packages (the other half of the B2 fix: chess-best-move / make-
 *    mips-interpreter / make-doom-for-mips).
 *    `uv run ...` lines and any other unclassified RUN
 *    line become verbatim "run" steps, executed with the WORKDIR-tracked cwd
 *    active at that line (default /app — see the WORKDIR porting note
 *    above). Cleanup RUN lines split into two buckets (env-fidelity fix,
 *    docs/env-fidelity-spotcheck.md's path-tracing finding: dropping a file-
 *    deleting cleanup line left an answer-key file — `orig.c` — present at
 *    agent time even though the official Dockerfile deletes it):
 *      - `rm ...` / `find ... -delete` are EXECUTED, not dropped — kept as a
 *        normal "run" step but flagged `bestEffort` (StagingStep.bestEffort)
 *        so stageTaskRuntime treats a nonzero exit as non-fatal (logged, not
 *        thrown): if the target is already absent in our union environment
 *        the failure is a no-op (the end state — file absent — is already
 *        correct); if present, the deletion is fidelity-critical and now
 *        actually happens.
 *      - `apt-get clean` / `apt-get autoremove` are still DROPPED outright —
 *        pure package-cache-size noise with zero fidelity impact (Option A
 *        already runs its own fresh `apt-get install` per task; there is no
 *        shared cache for these to matter to).
 *    A RUN line that still mentions `apt`/`apt-get` as a whole word but has no
 *    `install` (e.g. a bare `apt-get update`) is *also* dropped outright
 *    here: it installs nothing by itself, and if the same Dockerfile also
 *    has a real install line, this port's own apt step already runs its own
 *    `apt-get update` first — so the bare line is redundant either way (see
 *    report.md's circuit-fibsqrt/distribution-search cases).
 *  - Steps execute in the SAME fixed phase order the generated script's
 *    template uses: apt install (if any) -> env (informational; already
 *    folded into the exported prelude) -> copy -> one combined pip install
 *    -> run — NOT Dockerfile source order across categories. This is a
 *    deliberate, documented departure from "interleaved as written" and
 *    mirrors SETUP_DEPS_TEMPLATE's fixed section order in gen_setup_deps.py
 *    (apt ahead of copy/pip there too, modulo the env section's cosmetic
 *    placement).
 *  - A Dockerfile instruction keyword we cannot classify (i.e. not one of
 *    FROM/ENV/COPY/RUN, and not a known-ignorable lifecycle directive) fails
 *    loud via BenchError naming the directive, rather than silently
 *    skipping — see the task brief's "fail loud, not silent skip" rule.
 */
import { readFileSync, statSync } from "node:fs"
import { join, posix as posixPath } from "node:path"
import { podman, type ExecResult } from "./exec.ts"
import { buildExecArgv, buildCpToArgv } from "./sandbox.ts"
import type { BenchPaths } from "./paths.ts"
import { BenchError, die, log } from "./util.ts"
import { defaultSleep, type SleepFn } from "./agent-run.ts"

/** Transient network-fetch failures from a staging apt/pip step — the signals
 * apt (`Failed to fetch … Could not connect … Network is unreachable / connection
 * timed out`) and pip (`Temporary failure resolving … Failed to establish a new
 * connection … Read timed out`) emit when a mirror is momentarily unreachable.
 * Deliberately NARROWER than agent-run.ts's provider TRANSIENT_RE: a genuine dep
 * error (`Unable to locate package …`, a build failure) must NOT match, so it
 * fails fast instead of wasting retries. */
export const STAGING_NET_RE =
  /Network is unreachable|Could not connect|Cannot initiate the connection|connection timed out|Connection timed out|Temporary failure resolving|Could not resolve host|Failed to fetch|Connection reset|Connection refused|Failed to establish a new connection|Could not fetch URL|Read timed out|Name or service not known/i

/** Total attempts (1 initial + retries) for a network-fallible staging step. */
export const STAGING_MAX_ATTEMPTS = 3

/**
 * Run a network-fallible staging step (apt/pip) with bounded retry on
 * TRANSIENT-NETWORK failures only. A transient blip (db-wal-recovery's live
 * `apt install → Network is unreachable`) previously fail-fasted the whole task
 * to setup_failed, dropping it from the ab verdict — the agent phase already
 * retries (agent-run.ts's attempt loop), staging did not. Mirrors that idiom.
 *
 * Only failures matching STAGING_NET_RE are retried; a genuine dep error returns
 * on the first attempt so the caller throws without delay. apt-get/pip installs
 * are idempotent, so re-running the same step is safe. Injectable sleepFn for
 * tests. Returns the final ExecResult — the caller still decides whether rc≠0
 * throws (so an exhausted-retry failure surfaces exactly as before). */
export async function execNetStep(
  execFn: ExecFn,
  argv: string[],
  label: string,
  sleepFn: SleepFn = defaultSleep,
  maxAttempts: number = STAGING_MAX_ATTEMPTS,
): Promise<ExecResult> {
  let res = await execFn(argv)
  for (
    let attempt = 1;
    attempt < maxAttempts && res.rc !== 0 && STAGING_NET_RE.test(`${res.stderr}\n${res.stdout}`);
    attempt++
  ) {
    const backoff = Math.min(30, 5 * attempt)
    log(`  staging ${label}: transient network failure (exit ${res.rc}) — retry ${attempt}/${maxAttempts - 1} in ${backoff}s`)
    await sleepFn(backoff)
    res = await execFn(argv)
  }
  return res
}

/**
 * One resolved, executable (or informational, for "env") unit of task
 * staging. Deliberately a single flat interface (not a discriminated union)
 * so a step is trivially printable for debugging (`console.log(step)`,
 * JSON.stringify) regardless of kind.
 */
export interface StagingStep {
  kind: "copy" | "env" | "run" | "pip"
  /** copy: Dockerfile COPY source, verbatim, relative to <task>/environment/ */
  src?: string
  /** copy: resolved absolute container destination path */
  dst?: string
  /** copy: true if the source (checked on the host at parse time) is a directory */
  srcIsDir?: boolean
  /** copy: true if `dst` should be mkdir -p'd as a directory before copying in
   * (as opposed to mkdir -p'ing its parent for an exact file->file copy) */
  dirTarget?: boolean
  /** copy: true if this copies the CONTENTS of a source directory
   * (`cp -r src/. dst`) rather than the source path itself */
  contentsOnly?: boolean
  /** env: the ENV key */
  key?: string
  /** env: the ENV value, as written in the Dockerfile (unrewritten — the
   * ${VAR:-} guard is applied at export time in stageTaskRuntime) */
  value?: string
  /** run: the verbatim RUN command body */
  cmd?: string
  /** pip: accumulated package specs (verbatim, version pins included) across
   * every pip/uv-pip/uv-add RUN line in the Dockerfile */
  packages?: string[]
  /** run/pip: the WORKDIR-tracked cwd active when this step was encountered
   * (see A2 porting note above) — undefined/omitted when it's the default
   * /app, so stageTaskRuntime only emits an extra mkdir -p/cd wrapper when
   * it actually differs. */
  cwd?: string
  /** pip: true when the originating `pip install` line carried
   * `--break-system-packages` (PEP 668 / Docker's explicit "install into the
   * SYSTEM python" request) — such packages install system-wide via `pip3
   * install --break-system-packages`, NOT into the isolated /opt/.venv, so a
   * later bare-`python3` step (including the task's own solve.sh, run outside
   * staging) can see them. See the module header's pip porting note. */
  systemWide?: boolean
  /** pip: the `--index-url` governing this step's packages (captured
   * per-&&-segment by extractPipSegments — mteb-retrieve's torch-from-
   * pytorch-cpu-index line). Absent = default index (PyPI). */
  indexUrl?: string
  /** run: true for a file-deleting cleanup line (`rm ...` / `find ...
   * -delete`) that stageTaskRuntime executes BEST-EFFORT — a nonzero exit is
   * logged, not thrown (see the module header's env-fidelity fix note and
   * FILE_DELETE_RE). Undefined/false for every other run step (unchanged
   * fail-loud behavior). */
  bestEffort?: boolean
}

export interface TaskStaging {
  steps: StagingStep[]
  /** Flat accumulated ENV map (later directives win on key collision) */
  envs: Record<string, string>
  baseImage: string
  /** Deduped, sorted apt package names extracted from RUN apt-get/apt
   * install lines (see extractAptPackages) — installed as the FIRST step in
   * stageTaskRuntime when non-empty. Matches manifest.json's `apt` field. */
  aptPackages: string[]
}

// Lifecycle / metadata directives with no effect on staging — neither the
// generator nor this port do anything with them. WORKDIR and ARG are
// deliberately NOT in this set (unlike gen_setup_deps.py, which ignores both):
// this port gives each its own case in parseTaskDockerfile's switch (WORKDIR
// tracks a persistent cwd, ARG-with-default joins the env accumulation) —
// see the module header's A1/A2 porting notes.
const IGNORABLE_KEYWORDS = new Set([
  "CMD",
  "ENTRYPOINT",
  "EXPOSE",
  "LABEL",
  "USER",
  "VOLUME",
  "STOPSIGNAL",
  "HEALTHCHECK",
  "SHELL",
  "ONBUILD",
  "MAINTAINER",
])

/** Default WORKDIR, matching this runner's container fixed workdir (see
 * sandbox.ts's SandboxSpec.workdir default). */
const DEFAULT_CWD = "/app"

/** Where the isolated per-task pip venv lives — deliberately OUTSIDE /app
 * (see the B1 live-diagnosis fix, fix-code-vulnerability). It used to be
 * /app/.venv (matching gen_setup_deps.py's make_pip_section verbatim), but
 * that leaks a stray `.venv` directory into the task's own workspace: any
 * later "run" step that expects /app to be pristine — most concretely,
 * fix-code-vulnerability's `RUN git clone ... /app` — trips Docker/git's
 * "destination path '/app' already exists and is not an empty directory",
 * even though /app WAS empty when the task's OWN Dockerfile ran that clone
 * (this port's fixed phase order runs the one combined pip step, which
 * creates the venv, BEFORE any "run" step — see the module header's phase
 * order note — regardless of the clone RUN line's earlier position in the
 * Dockerfile's own source order). /opt is never a COPY/git-clone target in
 * the upstream corpus, so relocating the venv there is safe and needs no
 * Containerfile change (both /app and /opt already exist in the shared
 * image — see the Containerfile's `RUN mkdir -p /app /tests /logs/verifier`
 * and stock Ubuntu's own /opt). */
const PIP_VENV = "/opt/.venv"

/** Where `stageTaskRuntime` `podman cp`s a task's `environment/` directory
 * BEFORE replaying any COPY step, and `rm -rf`s as the FINAL staging action
 * (env-fidelity fix — see the module header). Replaces the old
 * `/tb/<task>/environment` mount-relative path: every COPY source now
 * resolves against this throwaway in-container copy instead of a persistent
 * host bind mount, so neither the mount nor a lingering pristine copy is
 * present once staging completes. */
const STAGE_DIR = "/.mh-stage"

/** Resolve one WORKDIR directive's body against the previous cwd — Docker
 * semantics: an absolute value replaces the cwd outright; a relative value
 * resolves against the previous cwd. Trailing slashes are normalized away
 * (except the root itself). */
function resolveWorkdir(body: string, prevCwd: string): string {
  const w = body.trim()
  const next = w.startsWith("/") ? posixPath.normalize(w) : posixPath.normalize(posixPath.join(prevCwd, w))
  return next.length > 1 ? next.replace(/\/+$/, "") : next
}

// Destination paths that are always directories (COPY file <dir> puts the
// file inside) — verbatim port of gen_setup_deps.py's _KNOWN_DIR_DESTS.
const KNOWN_DIR_DESTS = new Set([
  "/app",
  "/tests",
  "/logs",
  "/root",
  "/etc",
  "/tmp",
  "/var",
  "/opt",
  "/srv",
  "/data",
  "/protected",
  "/workspace",
  "/usr",
  "/bin",
  "/home",
  "/mnt",
])

/** Join backslash-continued lines into logical instructions, dropping blank
 * lines and comments — verbatim port of gen_setup_deps.py's read_dockerfile. */
function readDockerfileInstructions(text: string): string[] {
  const instructions: string[] = []
  let buf: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const stripped = raw.trim()
    if (!stripped || stripped.startsWith("#")) continue
    if (stripped.endsWith("\\")) {
      buf.push(stripped.slice(0, -1).trimEnd())
    } else {
      buf.push(stripped)
      instructions.push(buf.join(" "))
      buf = []
    }
  }
  if (buf.length > 0) instructions.push(buf.join(" "))
  return instructions
}

/** Split "KEYWORD rest" -> [KEYWORD (upper), rest] — port of parse_instruction. */
function parseInstruction(line: string): [string, string] {
  const m = /^(\S+)(?:\s+(.*))?$/.exec(line)
  if (!m) return ["", ""]
  return [m[1]!.toUpperCase(), m[2] ?? ""]
}

function hasApt(bodyLower: string): boolean {
  return bodyLower.includes("apt-get install") || bodyLower.includes("apt install")
}

// ── apt package extraction — verbatim port of gen_setup_deps.py's ──────────
// extract_apt_packages / APT_NOISE / SKIP_APT_PACKAGES / APT_RENAME (used
// there for both the manifest's `apt` field and make_apt_section's actual
// installed package list — same function, same rules, both contexts).

const APT_NOISE = new Set([
  "apt", "get", "install", "update", "upgrade", "y", "q", "f",
  "rm", "rf", "var", "lib", "lists", "apt-get",
  "no-install-recommends", "no-install-suggests",
  "debian-frontend", "noninteractive",
  "true", "false", "clean", "autoremove",
  "source", "the", "and", "to", "e", "x",
  "amd64", "http", "https", "com", "org", "io",
  "run", "env", "export",
])

// Packages skipped entirely — already available, or provided by another
// mechanism (Playwright ships its own chromium; sudo is already installed).
const SKIP_APT_PACKAGES = new Set(["chromium", "chromium-driver", "sudo"])

// Ubuntu 24.04 package renames: old name -> new name.
const APT_RENAME: Record<string, string> = {
  "libgl1-mesa-glx": "libgl1",
  "libglib2.0-0": "libglib2.0-0t64",
  // debian/bullseye's `netcat` virtual package has no 24.04 provider under
  // that name; netcat-openbsd matches bullseye's default alternative
  // (qemu-startup / qemu-alpine-ssh).
  netcat: "netcat-openbsd",
}

const APT_PACKAGE_RE = /^[a-z0-9][a-z0-9.+-]+$/

/** Verbatim port of gen_setup_deps.py's extract_apt_packages: pulls package
 * names out of an `apt-get install ...` (or `apt install ...`) RUN body,
 * stripping version pins, applying the Ubuntu 24.04 rename table, and
 * skipping noise/flag/path tokens exactly as the generator does. */
function extractAptPackages(body: string): string[] {
  const packages: string[] = []
  let inInstall = false
  for (const rawToken of body.split(/\s+|&&|\|\||;/)) {
    const token = rawToken.replace(/^["'\\]+/, "").replace(/["'\\]+$/, "")
    if (!token) continue
    if (token === "apt-get" || token === "apt") {
      inInstall = false
      continue
    }
    if (token === "install") {
      inInstall = true
      continue
    }
    if (token === "update" || token === "upgrade" || token === "clean" || token === "autoremove" || token === "purge") {
      inInstall = false
      continue
    }
    if (["rm", "find", "echo", "mkdir", "cd", "cp", "mv", "ln"].includes(token)) {
      inInstall = false
      continue
    }
    if (token.startsWith("-")) continue
    if (token.startsWith("/")) {
      inInstall = false
      continue
    }
    if (inInstall) {
      const pkg = token.split(/[=<>]/)[0] ?? ""
      if (pkg && !APT_NOISE.has(pkg) && !SKIP_APT_PACKAGES.has(pkg) && APT_PACKAGE_RE.test(pkg)) {
        packages.push(APT_RENAME[pkg] ?? pkg)
      }
    }
  }
  return packages
}

function hasPip(bodyLower: string): boolean {
  return /\bpip3?\s+install\b|\buv\s+pip\s+install\b|\buv\s+add\b/.test(bodyLower)
}

function hasUvRun(bodyLower: string): boolean {
  return /\buv\s+run\b/.test(bodyLower)
}

/** One `pip install` command's extraction: its package specs plus the
 * `--index-url` governing THAT command (if any). */
export interface PipSegment {
  packages: string[]
  indexUrl?: string
}

/** pip flags that take a value in the following token — the value must be
 * consumed so it is never mistaken for a package spec. */
const PIP_VALUE_FLAGS = new Set([
  "--index-url",
  "-i",
  "--extra-index-url",
  "--find-links",
  "-f",
  "-r",
  "--requirement",
  "-c",
  "--constraint",
  "-t",
  "--target",
])

/** Successor to the gen_setup_deps.py extract_pip_packages port. Two fixes
 * over the generator's logic (mteb-retrieve's TB2.1 Dockerfile, oracle
 * 2026-08-16):
 *  - a "-" token no longer aborts package collection (the generator reset
 *    its found-install flag on ANY flag, so `pip install --no-cache-dir
 *    pkg==1` extracted NOTHING and staging "succeeded" without the
 *    packages). Flags are skipped; value-taking flags consume their value.
 *  - `--index-url` is captured per &&/;-segment, so a torch-from-pytorch-cpu
 *    segment keeps its index while a sibling PyPI segment doesn't.
 * The generator quirk of skipping any token merely *starting with*
 * "pip"/"pip3"/"uv" (e.g. "uvicorn") is retained. */
function extractPipSegments(body: string): PipSegment[] {
  const segments: PipSegment[] = []
  for (const seg of body.split(/&&|\|\||;/)) {
    const packages: string[] = []
    let indexUrl: string | undefined
    let foundInstall = false
    const tokens = seg
      .split(/[\s\\]+/)
      .map((t) => t.replace(/^["']+/, "").replace(/["']+$/, ""))
      .filter((t) => t.length > 0)
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!
      if (/^(pip3?|uv)/.test(token)) continue
      if (token === "install" || token === "add") {
        foundInstall = true
        continue
      }
      if (token.startsWith("-")) {
        const eq = token.indexOf("=")
        const flag = eq > 0 ? token.slice(0, eq) : token
        const inline = eq > 0 ? token.slice(eq + 1) : undefined
        if (PIP_VALUE_FLAGS.has(flag)) {
          const value = inline ?? tokens[++i]
          if ((flag === "--index-url" || flag === "-i") && value) indexUrl = value
        }
        continue
      }
      if (foundInstall && /^[a-zA-Z]/.test(token)) {
        packages.push(token)
      }
    }
    if (packages.length > 0) segments.push({ packages, indexUrl })
  }
  return segments
}

// File-deleting cleanup lines: EXECUTED (best-effort — see the module
// header's env-fidelity fix note). Package-cache cleanup lines: still
// DROPPED outright (zero fidelity impact).
const FILE_DELETE_RE = /^(rm\s|find\s.*-delete)/
const APT_CACHE_CLEANUP_RE = /^(apt-get clean|apt-get autoremove)/
const APT_WORD_RE = /\bapt(?:-get)?\b/

/** One raw RUN line kept verbatim, tagged with the WORKDIR-tracked cwd active
 * when it was encountered (see A2 porting note), and whether it's a
 * best-effort file-deleting cleanup line (see FILE_DELETE_RE). */
interface RawRun {
  cmd: string
  cwd: string
  bestEffort?: boolean
}

/** Classify one RUN body, mutating the accumulators — port of gen_setup_deps.py's
 * RUN-handling branch inside parse_dockerfile. `pipCwdState` records the cwd
 * active at the last pip-classified RUN line (there is only ever ONE combined
 * pip step regardless of how many RUN lines contributed to it — see
 * parseTaskDockerfile — so this is the closest single cwd to attach to it).
 * Every pip line routes system-wide (see the hasPip branch); segments carry
 * a per-&&-command --index-url when present — see extractPipSegments. */
function classifyRun(
  body: string,
  cwd: string,
  pipSegments: PipSegment[],
  rawRunLines: RawRun[],
  aptPackages: string[],
  pipCwdState: { cwd: string },
): void {
  const bodyLower = body.toLowerCase()
  let classified = false

  if (hasApt(bodyLower)) {
    // apt install line: extracted into aptPackages (Option A — installed for
    // real at staging time, see stageTaskRuntime); no step emitted here since
    // the apt install runs once, up front, ahead of every other step.
    aptPackages.push(...extractAptPackages(body))
    classified = true
  }
  if (hasPip(bodyLower)) {
    // ALL image-level pip installs route system-wide (2026-08-16): in a real
    // docker build `RUN pip install` lands in the image's global
    // site-packages, visible to solve.sh's / test.sh's bare `python3`. The
    // old no-flag -> isolated-venv routing (gen_setup_deps.py inheritance)
    // hid those libs from everything except staging's own run steps —
    // build-cython-ext (numpy) and multi-source-data-merger (pandas) both
    // oracle-failed on exactly this. Containers are per-attempt throwaways
    // and the bench image sets PIP_BREAK_SYSTEM_PACKAGES=1, so system-wide
    // is both safe and faithful. The venv machinery (PIP_VENV,
    // VENV_ACTIVATE_GUARD) stays for compat with any future explicit use.
    pipSegments.push(...extractPipSegments(body))
    classified = true
  }
  if (hasUvRun(bodyLower)) {
    // `uv run ...` is always kept verbatim, unconditionally — matches
    // gen_setup_deps.py appending to raw_runs inside this same branch,
    // bypassing the cleanup/apt-word checks below entirely.
    rawRunLines.push({ cmd: body, cwd })
    classified = true
  }

  if (!classified) {
    const trimmed = body.trim()
    if (APT_CACHE_CLEANUP_RE.test(trimmed)) {
      return // package-cache cleanup only — dropped, zero fidelity impact
    }
    if (FILE_DELETE_RE.test(trimmed)) {
      // Fidelity-critical (env-fidelity fix): kept as a run step, EXECUTED,
      // flagged bestEffort so stageTaskRuntime treats a nonzero exit as
      // non-fatal — see the module header's env-fidelity fix note.
      rawRunLines.push({ cmd: body, cwd, bestEffort: true })
      return
    }
    if (APT_WORD_RE.test(body)) {
      // A bare apt/apt-get reference with no "install" (e.g. `apt-get
      // update` alone) installs nothing by itself; if this Dockerfile also
      // has a real install line, this port's own apt step (see
      // stageTaskRuntime) already runs its own `apt-get update` first, so
      // this line is redundant either way — drop it outright.
      return
    }
    rawRunLines.push({ cmd: body, cwd })
  }
}

/** Resolve one raw (src, dst) COPY pair into a StagingStep, checking the
 * source on the host (parse_dockerfile / make_copy_section's src_is_dir /
 * dir_target logic, ported verbatim). `cwd` is the WORKDIR-tracked cwd active
 * at this COPY (see A2 porting note) — used only to resolve the "." / "./"
 * shorthand dst form; every other dst is already an absolute container path. */
function resolveCopyStep(paths: BenchPaths, task: string, src: string, dst: string, cwd: string): StagingStep {
  const envDir = join(paths.tbRoot, task, "environment")
  const srcTrimmed = src.replace(/\/+$/, "")
  let srcIsDir = false
  try {
    srcIsDir = statSync(join(envDir, srcTrimmed)).isDirectory()
  } catch {
    srcIsDir = false
  }

  // xlate(): "./" or "." -> "<cwd>/"; anything else is already a real
  // absolute container path (no more ${EXTRAS_ROOT} indirection — see
  // module header). Every COPY dst across the full 91-task upstream corpus
  // is one of these two forms (verified empirically; see bench-staging test).
  const dstResolved = dst === "./" || dst === "." ? `${cwd.replace(/\/+$/, "")}/` : dst

  const dstNoSlash = dstResolved.replace(/\/+$/, "")
  const dirTarget = dstResolved.endsWith("/") || KNOWN_DIR_DESTS.has(dstNoSlash) || srcIsDir
  const contentsOnly = dirTarget && srcIsDir

  return { kind: "copy", src, dst: dstResolved, srcIsDir, dirTarget, contentsOnly }
}

/**
 * PURE parse of `<tbRoot>/<task>/environment/Dockerfile` — no exec, no
 * podman. Reads the source filesystem (host-side) only to determine, for
 * each COPY, whether its source is a file or directory (needed to decide
 * "copy contents" vs "copy the path itself" — see resolveCopyStep).
 *
 * Throws BenchError (via die) if the Dockerfile is unreadable, or contains
 * an instruction keyword this parser cannot classify (multi-stage/exotic
 * syntax outside FROM/ENV/COPY/RUN and the known-ignorable lifecycle
 * directives) — "fail loud, not silent skip" per the task brief.
 */
/**
 * The task Dockerfile's FINAL WORKDIR (default /app) — the cwd the task's
 * own image would give both the agent and any relative-path grader.
 * 2026-08-12 prove-plus-comm finding: its Dockerfile seeds
 * /workspace/plus_comm.v under `WORKDIR /workspace`, but the runner
 * hardcoded /app for the container workdir AND the verifier exec, so
 * `os.path.exists("plus_comm.v")` graded from the wrong directory — 3 of 4
 * clean proofs scored passed:false. Missing/unreadable Dockerfile → /app
 * (never a new crash mode on the verifier path).
 */
export function taskWorkdir(paths: BenchPaths, task: string): string {
  let text: string
  try {
    text = readFileSync(join(paths.tbRoot, task, "environment", "Dockerfile"), "utf-8")
  } catch {
    return DEFAULT_CWD
  }
  let cwd = DEFAULT_CWD
  for (const raw of text.split("\n")) {
    const m = raw.trim().match(/^WORKDIR\s+(.+)$/i)
    if (m) cwd = resolveWorkdir(m[1]!, cwd)
  }
  return cwd
}

export function parseTaskDockerfile(paths: BenchPaths, task: string): TaskStaging {
  const dfPath = join(paths.tbRoot, task, "environment", "Dockerfile")
  let text: string
  try {
    text = readFileSync(dfPath, "utf-8")
  } catch (e) {
    return die(`parseTaskDockerfile(${task}): cannot read Dockerfile at ${dfPath}: ${(e as Error).message}`)
  }

  const instructions = readDockerfileInstructions(text)

  let baseImage = ""
  const envPairs: [string, string][] = []
  const rawCopies: { src: string; dst: string; cwd: string }[] = []
  const pipSegments: PipSegment[] = []
  const rawRunLines: RawRun[] = []
  const rawAptPackages: string[] = []
  const pipCwdState = { cwd: DEFAULT_CWD }
  let cwd = DEFAULT_CWD

  for (const line of instructions) {
    const [kw, body] = parseInstruction(line)
    if (!kw) continue

    switch (kw) {
      case "FROM": {
        if (!baseImage) {
          baseImage = body.trim().split(/\s+/)[0] ?? ""
        }
        break
      }
      case "WORKDIR": {
        cwd = resolveWorkdir(body, cwd)
        break
      }
      case "ARG": {
        // `ARG NAME=default` joins the same env accumulation ENV uses, so
        // subsequent RUN steps see it exported (Docker semantics — see A1
        // porting note). Bare `ARG NAME` (no default) is build-arg-supplied
        // and contributes nothing: none of our tasks pass build args.
        const trimmed = body.trim()
        const kv = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed)
        if (kv) {
          envPairs.push([kv[1]!, kv[2]!])
        }
        break
      }
      case "ENV": {
        const trimmed = body.trim()
        const kv = /^([A-Z_][A-Z0-9_]*)=(.+)$/.exec(trimmed)
        if (kv) {
          envPairs.push([kv[1]!, kv[2]!])
        } else {
          const kvSpace = /^(\S+)\s+(.+)$/.exec(trimmed)
          if (kvSpace) envPairs.push([kvSpace[1]!, kvSpace[2]!])
        }
        break
      }
      case "COPY": {
        if (body.includes("--from=")) {
          // Multi-stage / external-image copy (e.g. the uv binary, or a
          // named build stage as in financial-document-processor) — skip
          // entirely, matching the generator's silent no-op for both.
          break
        }
        const parts = body.trim().split(/\s+/).filter((p) => p.length > 0)
        if (parts.length >= 2) {
          const dst = parts[parts.length - 1]!
          const sources = parts.slice(0, -1)
          // Multi-source COPY (`COPY a b c dest/`): Docker requires the dest
          // to be a directory, and ALL sources copy into it — a deliberate
          // DEVIATION from gen_setup_deps.py's `parts[0]`/`parts[-1]`
          // bug-for-bug port (see module header's COPY porting note / A3;
          // build-pmars is the one real instance in the upstream corpus).
          // Single-source COPY (the overwhelmingly common case) is unchanged.
          for (const src of sources) {
            rawCopies.push({ src, dst, cwd })
          }
        }
        break
      }
      case "RUN": {
        classifyRun(body, cwd, pipSegments, rawRunLines, rawAptPackages, pipCwdState)
        break
      }
      default: {
        if (!IGNORABLE_KEYWORDS.has(kw)) {
          return die(`parseTaskDockerfile(${task}): cannot classify Dockerfile directive '${kw}' (from: ${line})`)
        }
      }
    }
  }

  const envs: Record<string, string> = {}
  for (const [k, v] of envPairs) envs[k] = v

  // Deduped + sorted, matching manifest.json's `apt` field and
  // gen_setup_deps.py's make_apt_section (both apply `sorted(set(...))`).
  const aptPackages = Array.from(new Set(rawAptPackages)).sort()

  // Fixed phase order, matching SETUP_DEPS_TEMPLATE exactly: env -> copy ->
  // one combined pip step -> run. NOT Dockerfile source order across
  // categories (see module header). apt install is NOT one of these `steps`
  // — stageTaskRuntime executes it separately, as the very first exec, ahead
  // of this whole `steps` array.
  const steps: StagingStep[] = []
  for (const [k, v] of envPairs) steps.push({ kind: "env", key: k, value: v })
  for (const rc of rawCopies) steps.push(resolveCopyStep(paths, task, rc.src, rc.dst, rc.cwd))
  // Pip steps occupy the one "pip" phase slot, ahead of every run step (see
  // module header). All are system-wide (2026-08-16 routing); segments are
  // grouped by index URL in first-encounter order — the default-index group
  // merges into a single step (preserving the old one-combined-step shape),
  // while each --index-url'd segment keeps its own step so its index only
  // governs its own packages (mteb-retrieve: torch from the pytorch CPU
  // index, mteb/transformers from PyPI).
  const pipGroups = new Map<string, string[]>()
  for (const seg of pipSegments) {
    const key = seg.indexUrl ?? ""
    const group = pipGroups.get(key)
    if (group) group.push(...seg.packages)
    else pipGroups.set(key, [...seg.packages])
  }
  for (const [indexUrl, packages] of pipGroups) {
    steps.push({
      kind: "pip",
      packages,
      systemWide: true,
      ...(indexUrl ? { indexUrl } : {}),
    })
  }
  for (const rr of rawRunLines) {
    steps.push({
      kind: "run",
      cmd: rr.cmd,
      cwd: rr.cwd === DEFAULT_CWD ? undefined : rr.cwd,
      bestEffort: rr.bestEffort,
    })
  }

  return { steps, envs, baseImage, aptPackages }
}

/** `export K="V"` lines for every accumulated ENV, with any embedded `$VAR`
 * reference guarded as `${VAR:-}` (survives `set -u`) — port of
 * gen_setup_deps.py's make_env_section value rewriting. The /app->$WORKDIR
 * rewrite that script performs is skipped: this runner's WORKDIR is always
 * literally /app, so that rewrite would be a no-op anyway. */
function envPrelude(envs: Record<string, string>): string {
  const lines = Object.entries(envs).map(([k, v]) => {
    const rewritten = v.replace(/\$([A-Z_][A-Z0-9_]*)\b/g, "${$1:-}")
    return `export ${k}="${rewritten}"`
  })
  return lines.length > 0 ? lines.join("\n") + "\n" : ""
}

export type ExecFn = (argv: string[]) => Promise<ExecResult>

/** `mkdir -p "<cwd>" && cd "<cwd>" && ` prefix for a run/pip step's script —
 * empty when `cwd` is undefined (the default /app, unchanged behavior) per
 * the A2 porting note. mkdir -p is needed because WORKDIR implicitly creates
 * the directory in Docker, and this port never runs a separate WORKDIR step. */
function cwdPrefix(cwd: string | undefined): string {
  return cwd ? `mkdir -p "${cwd}" && cd "${cwd}" && ` : ""
}

/** Guard that sources the task's pip venv (see the "pip" step's own script)
 * IF one has already been created by an earlier step in THIS SAME container —
 * i.e. an earlier RUN line in the Dockerfile that pip-installed a package.
 * Every step is its own separate `podman exec`, so environment/PATH changes
 * from an earlier step never carry over on their own (unlike a real Docker
 * build, where a later RUN layer inherits everything an earlier RUN layer
 * left on disk). Without this, a Dockerfile like chess-best-move's `RUN pip3
 * install pillow ... --break-system-packages` followed by a LATER, separate
 * `RUN python3 make.py` (which does `from PIL import Image`) fails with
 * `ModuleNotFoundError: No module named 'PIL'`, even though pip extraction
 * correctly captured pillow — the package was simply never on this step's
 * PATH. `if [ -f ... ]; then ...; fi` (not `[ -f ... ] && ...`) so a missing
 * venv — the common case, most tasks have no pip step at all — is not itself
 * a failure under this script's `set -euo pipefail`. */
const VENV_ACTIVATE_GUARD = `if [ -f "${PIP_VENV}/bin/activate" ]; then source "${PIP_VENV}/bin/activate"; fi\n`

function describeStep(step: StagingStep): string {
  switch (step.kind) {
    case "copy":
      return `copy ${step.src} -> ${step.dst}`
    case "pip":
      return `pip install ${(step.packages ?? []).join(" ")}`
    case "run":
      return `run: ${step.cmd}`
    default:
      return step.kind
  }
}

/**
 * Execute a task's staging directly against an already-created+started
 * container, via `podman exec` (one call per step; `execFn` is injectable
 * for tests — defaults to the real exec.ts funnel, never spawning podman
 * unless actually called). Throws BenchError naming the failing step on a
 * nonzero exit — the caller (cmd-oracle.ts) maps that to `setup_failed`.
 */
export async function stageTaskRuntime(
  paths: BenchPaths,
  name: string,
  task: string,
  execFn: ExecFn = podman,
  sleepFn: SleepFn = defaultSleep,
): Promise<void> {
  const staging = parseTaskDockerfile(paths, task)
  if (staging.baseImage && staging.baseImage !== "ubuntu:24.04") {
    log(`  staging (runtime): ${task} base image is ${staging.baseImage} (approximated by the shared bench image)`)
  }

  // Env-fidelity fix: stage the task's environment/ directory into the
  // container via `podman cp` BEFORE replaying any step — no persistent /tb
  // mount involved (see the module header). The container's STAGE_DIR does
  // not exist yet at this point (fresh container / first use), so podman cp
  // creates it and copies the SOURCE DIRECTORY'S CONTENTS directly into it
  // (verified podman cp semantics: dest-does-not-exist -> contents-copied-in,
  // matching the old `/tb/<task>/environment` mount's directory shape).
  const cpResult = await execFn(buildCpToArgv(name, join(paths.tbRoot, task, "environment"), STAGE_DIR))
  if (cpResult.rc !== 0) {
    throw new BenchError(
      `stageTaskRuntime(${task}): podman cp environment -> ${STAGE_DIR} failed: exit ${cpResult.rc}` +
        (cpResult.stderr.trim() ? ` — ${cpResult.stderr.trim()}` : ""),
    )
  }

  const prelude = envPrelude(staging.envs)
  const envDir = STAGE_DIR

  // Whole-script `set -euo pipefail`, mirroring SETUP_DEPS_TEMPLATE's line
  // 325 (module header) — applied uniformly ahead of the env prelude for
  // EVERY step kind, so a `;`-joined RUN body (e.g. `false; true`) or a
  // failing copy/pip command fails loud instead of exiting 0.
  const setE = "set -euo pipefail\n"

  // python-version shim — FIRST exec, ahead even of apt. When the task's
  // base image pins python:<X.Y> and X.Y != the shared image's system
  // python (3.12), shim /usr/local/bin so bare python3/python/pip3/pip
  // resolve to the uv-managed CPython X.Y pre-baked into the bench image
  // (term-bench2/Containerfile `uv python install`). Restores base-image
  // fidelity for the python:3.13 task class: C extensions build against the
  // SAME interpreter `uvx -p 3.13` tests import them with
  // (portfolio-optimization), and apt Debian python libs land in 3.12 where
  // the task python cannot see them (gcode-to-text's python3-opencv) —
  // exactly the layout of the real base image. /usr/local/bin precedes
  // /usr/bin on PATH, container is a per-attempt throwaway.
  const pyMatch = /^python:(\d+\.\d+)/.exec(staging.baseImage)
  if (pyMatch && pyMatch[1] !== "3.12") {
    const v = pyMatch[1]!
    const shim = [
      `P="$(uv python find ${v})"`,
      `ln -sfn "$P" /usr/local/bin/python3`,
      `ln -sfn "$P" /usr/local/bin/python`,
      `printf '#!/bin/sh\\nexec "%s" -m pip "$@"\\n' "$P" > /usr/local/bin/pip3`,
      `chmod +x /usr/local/bin/pip3`,
      `cp /usr/local/bin/pip3 /usr/local/bin/pip`,
      // pip installs console scripts into the uv-python's own bin dir, which
      // is not on PATH — wrap pytest (the one console script task test.sh
      // scripts invoke bare after a `pip install pytest`; headless-terminal).
      `printf '#!/bin/sh\\nexec "%s" -m pytest "$@"\\n' "$P" > /usr/local/bin/pytest`,
      `chmod +x /usr/local/bin/pytest`,
      `"$P" -m ensurepip --upgrade >/dev/null 2>&1 || true`,
    ].join("\n")
    log(`  staging (runtime): ${task} python shim -> ${v} (base ${staging.baseImage})`)
    const shimResult = await execFn(buildExecArgv(name, ["bash", "-c", `${setE}${shim}`]))
    if (shimResult.rc !== 0) {
      throw new BenchError(
        `stageTaskRuntime(${task}): python ${v} shim failed: exit ${shimResult.rc}` +
          (shimResult.stderr.trim() ? ` — ${shimResult.stderr.trim()}` : ""),
      )
    }
  }

  // apt install — the FIRST step, ahead of copy/pip/run, when this task's
  // Dockerfile declared any `apt-get install`/`apt install` packages (Option
  // A: podman containers have real root + network, so this genuinely
  // installs — see term-bench2/Containerfile's header for why the shared
  // image no longer carries these). One exec, same set -euo pipefail guard
  // as every other step.
  if (staging.aptPackages.length > 0) {
    const aptScript = `${setE}apt-get update && apt-get install -y --no-install-recommends ${staging.aptPackages.join(" ")}`
    const aptArgv = buildExecArgv(name, ["bash", "-c", aptScript])
    const aptResult = await execNetStep(execFn, aptArgv, `apt install ${staging.aptPackages.join(" ")}`, sleepFn)
    if (aptResult.rc !== 0) {
      throw new BenchError(
        `stageTaskRuntime(${task}): step failed (apt install ${staging.aptPackages.join(" ")}): exit ${aptResult.rc}` +
          (aptResult.stderr.trim() ? ` — ${aptResult.stderr.trim()}` : ""),
      )
    }
  }

  for (const step of staging.steps) {
    if (step.kind === "env") continue // already folded into `prelude`, applied to every step below

    let script: string
    if (step.kind === "copy") {
      const srcTrimmed = (step.src ?? "").replace(/\/+$/, "")
      const srcForCp = step.contentsOnly ? `"${envDir}/${srcTrimmed}/."` : `"${envDir}/${step.src}"`
      const mkdirTarget = step.dirTarget ? step.dst! : posixPath.dirname(step.dst!)
      script = `${setE}${prelude}mkdir -p "${mkdirTarget}" && cp -r ${srcForCp} "${step.dst}"`
    } else if (step.kind === "pip") {
      const pkgs = (step.packages ?? []).map((p) => `"${p}"`).join(" ")
      if (step.systemWide) {
        // --break-system-packages: install into the SYSTEM python (bare pip3),
        // NOT the isolated venv — so bare `python3` everywhere (staging run
        // steps AND the task's own solve.sh, which runs outside staging) sees
        // these packages. Docker-faithful (chess-best-move, make-mips-
        // interpreter, make-doom-for-mips). See StagingStep.systemWide.
        const indexArg = step.indexUrl ? `--index-url "${step.indexUrl}" ` : ""
        script = `${setE}${prelude}pip3 install --break-system-packages ${indexArg}${pkgs}`
      } else {
        script =
          setE +
          prelude +
          cwdPrefix(step.cwd) +
          [
            "command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/install.sh | sh",
            `uv venv --python python3 "${PIP_VENV}" 2>/dev/null || true`,
            `source "${PIP_VENV}/bin/activate"`,
            `uv pip install ${pkgs}`,
          ].join("\n")
      }
    } else {
      script = `${setE}${prelude}${VENV_ACTIVATE_GUARD}${cwdPrefix(step.cwd)}${step.cmd}`
    }

    const argv = buildExecArgv(name, ["bash", "-c", script])
    // Retry ONLY pip steps on transient network — they fetch from an index and
    // are idempotent. copy is local; a `run` step is arbitrary/possibly non-
    // idempotent, so it stays fail-fast (a re-run could double-apply).
    const result =
      step.kind === "pip" ? await execNetStep(execFn, argv, describeStep(step), sleepFn) : await execFn(argv)
    if (result.rc !== 0) {
      if (step.kind === "run" && step.bestEffort) {
        // File-deleting cleanup line (env-fidelity fix — see module header
        // and FILE_DELETE_RE): non-fatal. A failure here means the target is
        // most likely already absent in our union environment, so the end
        // state (file absent) is already correct — log and move on rather
        // than aborting the whole task's staging over it.
        log(
          `  staging (runtime): ${task} — cleanup step failed (non-fatal, best-effort): ${describeStep(step)}: exit ${result.rc}` +
            (result.stderr.trim() ? ` — ${result.stderr.trim()}` : ""),
        )
        continue
      }
      throw new BenchError(
        `stageTaskRuntime(${task}): step failed (${describeStep(step)}): exit ${result.rc}` +
          (result.stderr.trim() ? ` — ${result.stderr.trim()}` : ""),
      )
    }
  }

  // Env-fidelity fix: purge the staged copy as the FINAL staging action — an
  // agent that inspects the filesystem after staging must not find a
  // lingering pristine copy of the task's environment/ fixtures (see module
  // header). Fatal on failure (unlike the best-effort Dockerfile cleanup
  // lines above): this is OUR OWN security boundary, not an upstream line
  // whose target might legitimately already be gone.
  const rmResult = await execFn(buildExecArgv(name, ["rm", "-rf", STAGE_DIR]))
  if (rmResult.rc !== 0) {
    throw new BenchError(
      `stageTaskRuntime(${task}): failed to remove staging dir ${STAGE_DIR}: exit ${rmResult.rc}` +
        (rmResult.stderr.trim() ? ` — ${rmResult.stderr.trim()}` : ""),
    )
  }
}
