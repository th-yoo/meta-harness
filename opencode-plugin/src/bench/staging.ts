/**
 * staging.ts — runtime Dockerfile staging: ports term-bench2/gen_setup_deps.py's
 * parsing/translation rules into the runner itself, so a task's
 * `<tbRoot>/<task>/environment/Dockerfile` is interpreted straight from the
 * upstream checkout at run time instead of executing a vendored, committed
 * `setup_deps.sh` (see cmd-oracle.ts's `--staging scripts|runtime`).
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
 *    `uv run ...` lines and any other unclassified RUN
 *    line become verbatim "run" steps, executed with the WORKDIR-tracked cwd
 *    active at that line (default /app — see the WORKDIR porting note
 *    above). Lines that
 *    are pure cleanup (`rm ...`, `find ... -delete`, `apt-get
 *    clean`/`autoremove`) are dropped outright, matching the generator. A
 *    RUN line that still mentions `apt`/`apt-get` as a whole word but has no
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
import { buildExecArgv } from "./sandbox.ts"
import type { BenchPaths } from "./paths.ts"
import { BenchError, die, log } from "./util.ts"

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

/** Verbatim port of gen_setup_deps.py's extract_pip_packages, including its
 * quirk of skipping any token merely *starting with* "pip"/"pip3"/"uv"
 * (e.g. a hypothetical "uvicorn" package spec would also be skipped). */
function extractPipPackages(body: string): string[] {
  const packages: string[] = []
  let foundInstall = false
  for (const rawToken of body.split(/[\s&|;\\]+/)) {
    const token = rawToken.replace(/^["']+/, "").replace(/["']+$/, "")
    if (!token) continue
    if (/^(pip3?|uv)/.test(token)) continue
    if (token === "install" || token === "add") {
      foundInstall = true
      continue
    }
    if (token.startsWith("-")) {
      foundInstall = false
      continue
    }
    if (foundInstall && /^[a-zA-Z]/.test(token)) {
      packages.push(token)
    }
  }
  return packages
}

const CLEANUP_ONLY_RE = /^(rm\s|find\s.*-delete|apt-get clean|apt-get autoremove)/
const APT_WORD_RE = /\bapt(?:-get)?\b/

/** One raw RUN line kept verbatim, tagged with the WORKDIR-tracked cwd active
 * when it was encountered (see A2 porting note). */
interface RawRun {
  cmd: string
  cwd: string
}

/** Classify one RUN body, mutating the accumulators — port of gen_setup_deps.py's
 * RUN-handling branch inside parse_dockerfile. `pipCwdState` records the cwd
 * active at the last pip-classified RUN line (there is only ever ONE combined
 * pip step regardless of how many RUN lines contributed to it — see
 * parseTaskDockerfile — so this is the closest single cwd to attach to it). */
function classifyRun(
  body: string,
  cwd: string,
  pipPackages: string[],
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
    pipPackages.push(...extractPipPackages(body))
    pipCwdState.cwd = cwd
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
    if (CLEANUP_ONLY_RE.test(body.trim())) {
      return // pure cleanup line — dropped, matches the generator exactly
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
  const pipPackages: string[] = []
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
        classifyRun(body, cwd, pipPackages, rawRunLines, rawAptPackages, pipCwdState)
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
  if (pipPackages.length > 0) {
    steps.push({
      kind: "pip",
      packages: pipPackages,
      cwd: pipCwdState.cwd === DEFAULT_CWD ? undefined : pipCwdState.cwd,
    })
  }
  for (const rr of rawRunLines) {
    steps.push({ kind: "run", cmd: rr.cmd, cwd: rr.cwd === DEFAULT_CWD ? undefined : rr.cwd })
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
): Promise<void> {
  const staging = parseTaskDockerfile(paths, task)
  if (staging.baseImage && staging.baseImage !== "ubuntu:24.04") {
    log(`  staging (runtime): ${task} base image is ${staging.baseImage} (approximated by the shared bench image)`)
  }

  const prelude = envPrelude(staging.envs)
  const envDir = `/tb/${task}/environment`

  // Whole-script `set -euo pipefail`, mirroring SETUP_DEPS_TEMPLATE's line
  // 325 (module header) — applied uniformly ahead of the env prelude for
  // EVERY step kind, so a `;`-joined RUN body (e.g. `false; true`) or a
  // failing copy/pip command fails loud instead of exiting 0.
  const setE = "set -euo pipefail\n"

  // apt install — the FIRST step, ahead of copy/pip/run, when this task's
  // Dockerfile declared any `apt-get install`/`apt install` packages (Option
  // A: podman containers have real root + network, so this genuinely
  // installs — see term-bench2/Containerfile's header for why the shared
  // image no longer carries these). One exec, same set -euo pipefail guard
  // as every other step.
  if (staging.aptPackages.length > 0) {
    const aptScript = `${setE}apt-get update && apt-get install -y --no-install-recommends ${staging.aptPackages.join(" ")}`
    const aptArgv = buildExecArgv(name, ["bash", "-c", aptScript])
    const aptResult = await execFn(aptArgv)
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
    } else {
      script = `${setE}${prelude}${VENV_ACTIVATE_GUARD}${cwdPrefix(step.cwd)}${step.cmd}`
    }

    const argv = buildExecArgv(name, ["bash", "-c", script])
    const result = await execFn(argv)
    if (result.rc !== 0) {
      throw new BenchError(
        `stageTaskRuntime(${task}): step failed (${describeStep(step)}): exit ${result.rc}` +
          (result.stderr.trim() ? ` — ${result.stderr.trim()}` : ""),
      )
    }
  }
}
