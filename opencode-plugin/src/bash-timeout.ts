/**
 * Fast-command timeout heuristic — loose port of meta-harness marker-based polling.
 *
 * The original Python harness appended `echo '__CMDEND__N__'` after every
 * command and polled for the marker, exiting early if the shell returned
 * before the stated duration. opencode's bash tool already streams output
 * and resolves as soon as the process exits — so the polling win is
 * already partially realized.
 *
 * What this module adds is a per-command timeout cap: commands that look
 * instantaneous (cd, ls, echo, cat, pwd, etc.) are capped at a short
 * timeout so opencode doesn't hold the LLM turn open for the default 2 min
 * when the process finishes in milliseconds.
 *
 * Limitation: this is a heuristic based on the first token of the command
 * string. It cannot replicate the exact marker semantics without source
 * changes to the bash tool.
 */

/** Commands that almost always return in under a second. */
const FAST_COMMANDS = new Set([
  "cd", "chdir", "ls", "ll", "la", "echo", "printf", "cat", "head", "tail",
  "pwd", "which", "type", "env", "export", "unset", "alias", "unalias",
  "true", "false", "exit", "return", "source", ".", "set", "unset",
  "date", "hostname", "uname", "id", "whoami", "groups",
  "touch", "mkdir", "rmdir", "rm", "mv", "cp", "ln",
  "chmod", "chown", "stat", "file",
])

/** Commands that can be slow — leave timeout alone. */
const SLOW_COMMANDS = new Set([
  "make", "cmake", "cargo", "npm", "yarn", "pnpm", "bun",
  "pip", "pip3", "apt", "apt-get", "brew",
  "wget", "curl", "scp", "rsync",
  "python", "python3", "node", "java", "go", "rustc", "gcc", "g++",
  "docker", "kubectl", "terraform",
  "git", // git can be slow (fetch/push/clone)
])

/** Timeout (ms) to apply to fast commands. */
const FAST_TIMEOUT_MS = 5_000

/**
 * Given a bash command string, return an adjusted timeout in milliseconds,
 * or undefined if no adjustment should be made.
 *
 * Only lowers the timeout — never raises it.
 */
export function adjustedTimeout(command: string, currentTimeoutMs?: number): number | undefined {
  const firstToken = command.trimStart().split(/\s+/)[0] ?? ""

  // Strip any path prefix (e.g. /usr/bin/ls → ls)
  const cmd = firstToken.split("/").at(-1) ?? firstToken

  if (SLOW_COMMANDS.has(cmd)) return undefined

  if (FAST_COMMANDS.has(cmd)) {
    // Only lower — never extend beyond what the LLM/user already set
    const current = currentTimeoutMs ?? Infinity
    return Math.min(current, FAST_TIMEOUT_MS)
  }

  return undefined
}
