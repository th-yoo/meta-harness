import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"

export const AUDIT_PROMPT_VERSION = "lane-a-v1"

export function auditPrompt(): string {
  return readFileSync(join(dirname(new URL(import.meta.url).pathname), "convention-audit-prompt.txt"), "utf-8")
}
