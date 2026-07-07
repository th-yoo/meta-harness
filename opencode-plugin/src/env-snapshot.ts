/**
 * Environment snapshot — port of AgentHarness._gather_env_snapshot() from Python.
 *
 * Runs a single compound shell command to collect PWD, /app contents,
 * available language runtimes, package managers, and memory. Injected as
 * a text block into the first user message of each session so the agent
 * doesn't waste early turns on `ls`, `which python3`, etc.
 *
 * On any failure the function returns an empty string (silent fallback).
 */

const BOOTSTRAP_CMD = [
  "echo '@@PWD@@' && pwd",
  "echo '@@LS@@' && ls -la /app/ 2>/dev/null",
  "echo '@@LANG@@'",
  "(python3 --version 2>&1 || echo 'python3: not found')",
  "(gcc --version 2>&1 | head -1 || echo 'gcc: not found')",
  "(g++ --version 2>&1 | head -1 || echo 'g++: not found')",
  "(node --version 2>&1 || echo 'node: not found')",
  "(java -version 2>&1 | head -1 || echo 'java: not found')",
  "(rustc --version 2>&1 || echo 'rustc: not found')",
  "(go version 2>&1 || echo 'go: not found')",
  "echo '@@PKG@@'",
  "(pip3 --version 2>&1 || echo 'pip3: not found')",
  "(pip --version 2>&1 || echo 'pip: not found')",
  "(apt-get --version 2>&1 | head -1 || echo 'apt-get: not found')",
  "echo '@@MEM@@' && free -h 2>/dev/null | head -2 || true",
].join(" && ")

type Sections = { [key: string]: string }

function parseSections(stdout: string): Sections {
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

function buildSnapshot(sections: Sections): string {
  const parts: string[] = []

  if (sections["PWD"]) {
    parts.push(`Working directory: ${sections["PWD"].trim()}`)
  }

  if (sections["LS"]) {
    const lines = sections["LS"].trim().split("\n")
    if (lines.length <= 1 || (lines.length === 2 && lines[0]?.includes("total 0"))) {
      parts.push("/app contents: (empty directory)")
    } else if (lines.length > 25) {
      const head = lines.slice(0, 20).join("\n")
      parts.push(`/app contents (${lines.length} entries):\n${head}\n... (${lines.length - 20} more files)`)
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
 */
export async function gatherEnvSnapshot($: import("@opencode-ai/plugin").PluginInput["$"]): Promise<string> {
  try {
    const result = await $`bash -c ${BOOTSTRAP_CMD}`.quiet().nothrow()
    const stdout = result.stdout.toString("utf8").trim()
    if (!stdout) return ""
    const sections = parseSections(stdout)
    return buildSnapshot(sections)
  } catch {
    return ""
  }
}
