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
 *  - WORKDIR and other lifecycle directives (ARG/CMD/ENTRYPOINT/EXPOSE/...)
 *    are ignored exactly as gen_setup_deps.py ignores them — the generator's
 *    WORKDIR handler is a no-op (`pass`), and the generated scripts always
 *    operate against a fixed $WORKDIR (here, the podman container's fixed
 *    /app), never the Dockerfile's own WORKDIR value.
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
 *    template never actually reads).
 *  - RUN: apt-get/apt install lines are dropped (informational only — the
 *    shared image's package union covers them; runtime staging never runs
 *    apt). pip3/pip/uv-pip-install/uv-add lines contribute package specs
 *    (verbatim, version pins included) to ONE combined venv+`uv pip install`
 *    step — mirroring gen_setup_deps.py's make_pip_section, which always
 *    combines every task's pip packages into a single install line
 *    regardless of how many RUN lines matched. `uv run ...` lines and any
 *    other unclassified RUN line become verbatim "run" steps, executed with
 *    cwd /app. Lines that are pure cleanup (`rm ...`, `find ... -delete`,
 *    `apt-get clean`/`autoremove`) are dropped outright, matching the
 *    generator. A RUN line that still mentions `apt`/`apt-get` as a whole
 *    word (e.g. a bare `apt-get update`, with no `install`) is *also*
 *    dropped outright here: the generated script wraps such lines in
 *    `if [[ -z "$SKIP_APT" ]]; then ...; fi`, and every current caller of
 *    the scripts-mode setup path always sets SKIP_APT=1 — so the observable
 *    behavior this must match is "no-op", which dropping the step achieves
 *    directly (see report.md's circuit-fibsqrt/distribution-search cases).
 *  - Steps execute in the SAME fixed phase order the generated script's
 *    template uses: env (informational; already folded into the exported
 *    prelude) -> copy -> one combined pip install -> run — NOT Dockerfile
 *    source order across categories. This is a deliberate, documented
 *    departure from "interleaved as written" and mirrors
 *    SETUP_DEPS_TEMPLATE's fixed section order in gen_setup_deps.py.
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
}

export interface TaskStaging {
  steps: StagingStep[]
  /** Flat accumulated ENV map (later directives win on key collision) */
  envs: Record<string, string>
  baseImage: string
}

// Lifecycle / metadata directives gen_setup_deps.py's parser silently
// ignores (no branch touches them at all — parse_instruction's kw simply
// never matches, and the loop just moves on). WORKDIR is the one directive
// worth calling out explicitly: its handler is a literal `pass` in the
// generator (workspace path is "handled by runner" instead) — it does NOT
// `cd` anywhere, so there is nothing else to honor here either.
const IGNORABLE_KEYWORDS = new Set([
  "WORKDIR",
  "ARG",
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

/** Classify one RUN body, mutating the accumulators — port of gen_setup_deps.py's
 * RUN-handling branch inside parse_dockerfile. */
function classifyRun(body: string, pipPackages: string[], rawRunLines: string[]): void {
  const bodyLower = body.toLowerCase()
  let classified = false

  if (hasApt(bodyLower)) {
    // apt lines: informational only under this port (the shared image's
    // package union covers them) — dropped, no step emitted.
    classified = true
  }
  if (hasPip(bodyLower)) {
    pipPackages.push(...extractPipPackages(body))
    classified = true
  }
  if (hasUvRun(bodyLower)) {
    // `uv run ...` is always kept verbatim, unconditionally — matches
    // gen_setup_deps.py appending to raw_runs inside this same branch,
    // bypassing the cleanup/apt-word checks below entirely.
    rawRunLines.push(body)
    classified = true
  }

  if (!classified) {
    if (CLEANUP_ONLY_RE.test(body.trim())) {
      return // pure cleanup line — dropped, matches the generator exactly
    }
    if (APT_WORD_RE.test(body)) {
      // The generated script wraps this in `if [[ -z "$SKIP_APT" ]]; then
      // ...; fi`; every current caller sets SKIP_APT=1, so the observable
      // behavior is a no-op — drop the step outright to match it.
      return
    }
    rawRunLines.push(body)
  }
}

/** Resolve one raw (src, dst) COPY pair into a StagingStep, checking the
 * source on the host (parse_dockerfile / make_copy_section's src_is_dir /
 * dir_target logic, ported verbatim). */
function resolveCopyStep(paths: BenchPaths, task: string, src: string, dst: string): StagingStep {
  const envDir = join(paths.tbRoot, task, "environment")
  const srcTrimmed = src.replace(/\/+$/, "")
  let srcIsDir = false
  try {
    srcIsDir = statSync(join(envDir, srcTrimmed)).isDirectory()
  } catch {
    srcIsDir = false
  }

  // xlate(): "./" or "." -> "/app/"; anything else is already a real
  // absolute container path (no more ${EXTRAS_ROOT} indirection — see
  // module header). Every COPY dst across the full 91-task upstream corpus
  // is one of these two forms (verified empirically; see bench-staging test).
  const dstResolved = dst === "./" || dst === "." ? "/app/" : dst

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
  const rawCopies: { src: string; dst: string }[] = []
  const pipPackages: string[] = []
  const rawRunLines: string[] = []

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
          // Only the first source and the last token (dst) are honored —
          // a multi-source `COPY a b dst` silently drops the middle
          // sources, verbatim port of gen_setup_deps.py's `parts[0], parts[-1]`
          // (see build-pmars for the one real instance of this in the
          // upstream corpus; it is not part of the Gate-B baseline set).
          rawCopies.push({ src: parts[0]!, dst: parts[parts.length - 1]! })
        }
        break
      }
      case "RUN": {
        classifyRun(body, pipPackages, rawRunLines)
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

  // Fixed phase order, matching SETUP_DEPS_TEMPLATE exactly: env -> copy ->
  // one combined pip step -> run. NOT Dockerfile source order across
  // categories (see module header).
  const steps: StagingStep[] = []
  for (const [k, v] of envPairs) steps.push({ kind: "env", key: k, value: v })
  for (const rc of rawCopies) steps.push(resolveCopyStep(paths, task, rc.src, rc.dst))
  if (pipPackages.length > 0) steps.push({ kind: "pip", packages: pipPackages })
  for (const cmd of rawRunLines) steps.push({ kind: "run", cmd })

  return { steps, envs, baseImage }
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
        [
          "command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/install.sh | sh",
          'uv venv --python python3 "/app/.venv" 2>/dev/null || true',
          'source "/app/.venv/bin/activate"',
          `uv pip install ${pkgs}`,
        ].join("\n")
    } else {
      script = `${setE}${prelude}${step.cmd}`
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
