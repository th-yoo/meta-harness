/**
 * Environment snapshot — port of AgentHarness._gather_env_snapshot() from Python.
 *
 * Runs a single compound shell command to collect PWD, /app contents,
 * available language runtimes, package managers, and memory. Injected as
 * a text block into the first user message of each session so the agent
 * doesn't waste early turns on `ls`, `which python3`, etc.
 *
 * On any failure the function returns an empty string (silent fallback).
 *
 * Phase 4 Part C: the exact probe set is evolvable via env-policy.json (see
 * ./harness-store.ts EnvPolicy). buildBootstrapCmd(null) — no policy, or a
 * policy that leaves every knob at its default — produces a command
 * byte-identical to the original hardcoded BOOTSTRAP_CMD below.
 */

import type { EnvPolicy } from "./harness-store.ts"

const DEFAULT_LS_PATH = "/app"
const DEFAULT_MAX_LS_ENTRIES = 25

/** Fixed language-probe whitelist, in the original probing order. Must stay
 * in sync with ENV_POLICY_LANGUAGE_WHITELIST in harness-store.ts — that's
 * the set validateEnvPolicy() filters `languageProbes` down to. */
const LANGUAGE_PROBE_ORDER = ["python3", "gcc", "g++", "node", "java", "rustc", "go"] as const
const LANGUAGE_PROBE_CMDS: Record<(typeof LANGUAGE_PROBE_ORDER)[number], string> = {
  python3: "(python3 --version 2>&1 || echo 'python3: not found')",
  gcc: "(gcc --version 2>&1 | head -1 || echo 'gcc: not found')",
  "g++": "(g++ --version 2>&1 | head -1 || echo 'g++: not found')",
  node: "(node --version 2>&1 || echo 'node: not found')",
  java: "(java -version 2>&1 | head -1 || echo 'java: not found')",
  rustc: "(rustc --version 2>&1 || echo 'rustc: not found')",
  go: "(go version 2>&1 || echo 'go: not found')",
}

/**
 * Builds the compound bootstrap shell command, honoring an (already
 * validated, so safe to interpolate) EnvPolicy. `null`/`undefined` — or a
 * policy that omits every knob — reproduces the original fixed command:
 * all four sections, /app, every whitelisted language, cap 25.
 *
 * `@@PWD@@` is always emitted: it's harmless and buildSnapshot/parseSections
 * rely on at least one marker being present to parse the rest.
 */
export function buildBootstrapCmd(policy: EnvPolicy | null | undefined): string {
  const probes = policy?.probes ?? {}
  const lsPath = policy?.lsPath ?? DEFAULT_LS_PATH
  const languageProbes = policy?.languageProbes ?? LANGUAGE_PROBE_ORDER

  const parts: string[] = ["echo '@@PWD@@' && pwd"]

  if (probes.ls !== false) {
    parts.push(`echo '@@LS@@' && ls -la ${lsPath}/ 2>/dev/null`)
  }

  if (probes.lang !== false) {
    parts.push("echo '@@LANG@@'")
    for (const lang of LANGUAGE_PROBE_ORDER) {
      if (languageProbes.includes(lang)) parts.push(LANGUAGE_PROBE_CMDS[lang])
    }
  }

  if (probes.pkg !== false) {
    parts.push(
      "echo '@@PKG@@'",
      "(pip3 --version 2>&1 || echo 'pip3: not found')",
      "(pip --version 2>&1 || echo 'pip: not found')",
      "(apt-get --version 2>&1 | head -1 || echo 'apt-get: not found')",
    )
  }

  if (probes.mem !== false) {
    parts.push("echo '@@MEM@@' && free -h 2>/dev/null | head -2 || true")
  }

  return parts.join(" && ")
}

type Sections = { [key: string]: string }

export function parseSections(stdout: string): Sections {
  const sections: Sections = {}
  let currentKey: string | null = null
  const currentLines: string[] = []

  for (const line of stdout.split("\n")) {
    if (line.startsWith("@@") && line.endsWith("@@")) {
      if (currentKey !== null) {
        sections[currentKey] = currentLines.join("\n")
      }
      currentKey = line.replaceAll("@", "")
      currentLines.length = 0
    } else {
      currentLines.push(line)
    }
  }
  if (currentKey !== null) {
    sections[currentKey] = currentLines.join("\n")
  }
  return sections
}

export function buildSnapshot(sections: Sections, policy?: EnvPolicy | null): string {
  const parts: string[] = []
  const cap = policy?.maxLsEntries ?? DEFAULT_MAX_LS_ENTRIES
  const headCount = Math.max(5, cap - 5)

  if (sections["PWD"]) {
    parts.push(`Working directory: ${sections["PWD"].trim()}`)
  }

  if (sections["LS"]) {
    const lines = sections["LS"].trim().split("\n")
    if (lines.length <= 1 || (lines.length === 2 && lines[0]?.includes("total 0"))) {
      parts.push("/app contents: (empty directory)")
    } else if (lines.length > cap) {
      const head = lines.slice(0, headCount).join("\n")
      parts.push(`/app contents (${lines.length} entries):\n${head}\n... (${lines.length - headCount} more files)`)
    } else {
      parts.push(`/app contents:\n${sections["LS"].trim()}`)
    }
  }

  if (sections["LANG"]) {
    const langs = sections["LANG"]
      .trim()
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
    if (langs.length > 0) {
      parts.push("Available languages/tools: " + langs.join("; "))
    }
  }

  if (sections["PKG"]) {
    const pkgs = sections["PKG"]
      .trim()
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
    if (pkgs.length > 0) {
      parts.push("Package managers: " + pkgs.join("; "))
    }
  }

  if (sections["MEM"]) {
    const mem = sections["MEM"].trim()
    if (mem) parts.push(`Memory: ${mem}`)
  }

  if (parts.length === 0) return ""
  return "[Environment Snapshot]\n" + parts.join("\n")
}

/**
 * Executes the bootstrap command via Bun's shell and returns the snapshot
 * string. Returns "" on any error so callers can safely ignore failures.
 *
 * `policy` (an evolved EnvPolicy, Phase 4 Part C) drives which probes run,
 * the ls path/cap, and the language-probe subset. Omitted/null reproduces
 * the original fixed-probe behavior.
 */
export async function gatherEnvSnapshot(
  $: import("@opencode-ai/plugin").PluginInput["$"],
  policy?: EnvPolicy | null,
): Promise<string> {
  try {
    const cmd = buildBootstrapCmd(policy)
    const result = await $`bash -c ${cmd}`.quiet().nothrow()
    const stdout = result.stdout.toString("utf8").trim()
    if (!stdout) return ""
    const sections = parseSections(stdout)
    return buildSnapshot(sections, policy)
  } catch {
    return ""
  }
}
