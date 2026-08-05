// RSS sizing probe for KKAMAK_ACP_MAX_SESSIONS — token-free (ANTHROPIC_BASE_URL
// pins every WarmSession at a local SSE stub; no real endpoint is ever
// reachable). Committed per CLAUDE.md's "reusable scripts / recipes /
// procedures -> the repo" rule, same convention as warm-session-measure.ts
// (Task 4 Step 4): a scratch script under /mnt/d/tmp/ or .kkamak/ would be
// host-local and would not travel, and a later re-run (this host, another
// host, or after warm-session.ts changes) needs to reproduce these numbers
// without re-deriving the script from prose. NOT matched by bun's test glob
// (no `describe`/`test` calls) -- same convention as sdk-stub.ts and
// agent-cli-stub.ts. Requires on-disk Claude Code credentials (spawns the
// REAL bundled CLI to get real process/RSS behaviour; every request that CLI
// makes is intercepted by ANTHROPIC_BASE_URL -> local stub, so it is
// zero-spend exactly like warm-session.test.ts's CLI-spawning describe
// block). Run with:
//   cd cc-gate-plugin && bun test/warm-session-rss-measure.ts
//
// The Agent SDK's `Query` does not expose the spawned CLI's pid (checked
// sdk.d.ts -- no `pid` field on Query or QueryEvents). So this measures by
// PROCESS-TREE SWEEP: snapshot this host bun process's descendant pids
// (recursively, via /proc/<pid>/task/*/children, which is not just the
// direct child -- the bundled CLI binary itself spawns a further node/bun
// process) before and after each WarmSession is created, and sum VmRSS
// across whatever pids are new. Every session this script opens is closed
// before exit, and cleanup is verified pid-scoped (never pkill -f).
import fs from "node:fs"
import { execFileSync } from "node:child_process"
import { WarmSession } from "../src/acp/warm-session.ts"
import { sseText, HAS_CLAUDE_CODE_CREDENTIALS, NO_CREDENTIALS_SKIP_REASON } from "./agent-cli-stub.ts"
import { stubServer } from "./sdk-stub.ts"

if (!HAS_CLAUDE_CODE_CREDENTIALS) {
  console.error(`ABORT: ${NO_CREDENTIALS_SKIP_REASON}`)
  process.exit(1)
}

const HAIKU = "claude-haiku-4-5"
const HOST_PID = process.pid

// Darwin has no /proc: the original readers silently returned 0/[] there and
// the whole probe measured 0 MB (caught on the MacBook 2026-08-05). Each
// reader platform-branches; the linux (/proc) branch is byte-unchanged.
const IS_DARWIN = process.platform === "darwin"

function psOut(args: string[]): string {
  try {
    return execFileSync("ps", args, { encoding: "utf8" })
  } catch {
    return ""   // ps exits 1 when the pid is gone -- treat as absent
  }
}

function vmRssKb(pid: number): number {
  if (IS_DARWIN) {
    const out = psOut(["-o", "rss=", "-p", String(pid)]).trim()
    return out ? Number(out) : 0   // ps rss is already in KB
  }
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf-8")
    const m = status.match(/^VmRSS:\s+(\d+)\s+kB/m)
    return m ? Number(m[1]) : 0
  } catch {
    return 0   // pid gone, or unreadable -- never counted
  }
}

/** Direct children of `pid`. Linux: unioned across every thread's own
 * .../task/<tid>/children (a multi-threaded process's children can be
 * reported under a non-leader task; scanning only task/<pid>/children would
 * silently miss some). Darwin: `ps -axo pid=,ppid=` scan — process-level
 * parentage only, which is all darwin exposes and all this probe needs
 * (children are processes, never bare threads). */
function directChildren(pid: number): number[] {
  if (IS_DARWIN) {
    const out = new Set<number>()
    for (const line of psOut(["-axo", "pid=,ppid="]).split("\n")) {
      const [c, p] = line.trim().split(/\s+/).map(Number)
      if (p === pid && c !== undefined && Number.isInteger(c) && c > 0) out.add(c)
    }
    return [...out]
  }
  const out = new Set<number>()
  let taskDirs: string[] = []
  try {
    taskDirs = fs.readdirSync(`/proc/${pid}/task`)
  } catch {
    return []
  }
  for (const t of taskDirs) {
    try {
      const txt = fs.readFileSync(`/proc/${pid}/task/${t}/children`, "utf-8").trim()
      if (txt) for (const s of txt.split(/\s+/)) out.add(Number(s))
    } catch {
      /* task exited mid-scan */
    }
  }
  return [...out]
}

function descendants(pid: number): number[] {
  const seen = new Set<number>()
  const stack = [pid]
  while (stack.length) {
    const p = stack.pop()
    if (p === undefined) continue
    for (const c of directChildren(p)) {
      if (!seen.has(c)) {
        seen.add(c)
        stack.push(c)
      }
    }
  }
  return [...seen]
}

function treeRssKb(pids: number[]): number {
  return pids.reduce((sum, p) => sum + vmRssKb(p), 0)
}

async function settle(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

async function waitForExit(pids: number[], timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs
  let alive = pids.filter((p) => vmRssKb(p) > 0)
  while (alive.length > 0 && Date.now() < deadline) {
    await settle(200)
    alive = pids.filter((p) => vmRssKb(p) > 0)
  }
  return alive
}

/** Pid-scoped cleanup only -- never pkill -f. Sends SIGTERM to whatever is
 * still alive after ws.close()'s own teardown had a fair chance to land. */
async function forceCleanup(pids: number[]): Promise<void> {
  const stillAlive = await waitForExit(pids, 5_000)
  if (stillAlive.length === 0) return
  console.warn("cleanup: force-terminating orphaned pids (pid-scoped):", stillAlive)
  for (const p of stillAlive) {
    try { process.kill(p, "SIGTERM") } catch { /* already gone */ }
  }
  const stillAfterTerm = await waitForExit(stillAlive, 3_000)
  for (const p of stillAfterTerm) {
    try { process.kill(p, "SIGKILL") } catch { /* already gone */ }
  }
}

function mb(kb: number): string {
  return `${(kb / 1024).toFixed(1)} MB`
}

function memAvailableKb(): number {
  if (IS_DARWIN) {
    // No MemAvailable equivalent; approximate with vm_stat's free +
    // inactive pages (inactive is reclaimable, same spirit as MemAvailable).
    // Informational lines only -- no threshold logic reads this.
    try {
      const out = execFileSync("vm_stat", { encoding: "utf8" })
      const page = Number(out.match(/page size of (\d+) bytes/)?.[1] ?? 4096)
      const free = Number(out.match(/Pages free:\s+(\d+)\./)?.[1] ?? 0)
      const inactive = Number(out.match(/Pages inactive:\s+(\d+)\./)?.[1] ?? 0)
      return Math.round(((free + inactive) * page) / 1024)
    } catch {
      return 0
    }
  }
  const meminfo = fs.readFileSync("/proc/meminfo", "utf-8")
  const m = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB/m)
  return m ? Number(m[1]) : 0
}

console.log("=== host ===")
console.log("bun host pid:", HOST_PID)
console.log("MemAvailable (before any session):", mb(memAvailableKb()))
console.log("host RSS (before any session):", mb(vmRssKb(HOST_PID)))
console.log("pre-existing children of host pid:", directChildren(HOST_PID))

const allOpened: { ws: WarmSession; cap: ReturnType<typeof stubServer>; pids: number[] }[] = []

// ---- 1. BASELINE: RSS of one warm session (host delta + CLI subtree) ----
{
  console.log("\n=== 1. BASELINE (one warm session) ===")
  const before = new Set(descendants(HOST_PID))
  const hostRssBefore = vmRssKb(HOST_PID)
  const cap = stubServer(() => sseText("ANSWER", HAIKU))
  const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url })
  const r1 = await ws.oneShot("warm this session", HAIKU, { recycle: true })
  await settle(2_000)   // "settled" per task spec
  const hostRssAfter = vmRssKb(HOST_PID)
  const newPids = descendants(HOST_PID).filter((p) => !before.has(p))
  const subtreeRss = treeRssKb(newPids)
  console.log("turn outcome:", r1.kind)
  console.log("new descendant pids (CLI subprocess tree, incl. grandchildren):", newPids)
  console.log("host (bun) process RSS: before =", mb(hostRssBefore), " after =", mb(hostRssAfter),
    " delta =", mb(hostRssAfter - hostRssBefore))
  console.log("CLI subprocess TREE RSS (sum of VmRSS over", newPids.length, "pids):", mb(subtreeRss))
  console.log("BASELINE TOTAL (host delta + CLI tree):", mb((hostRssAfter - hostRssBefore) + subtreeRss))
  allOpened.push({ ws, cap, pids: newPids })
  ws.close()
  cap.stop()
  await forceCleanup(newPids)
  allOpened.pop()
}

// ---- 2. MARGINAL: 2-4 sessions opened sequentially, kept alive together ----
{
  console.log("\n=== 2. MARGINAL (sessions opened sequentially, kept resident) ===")
  const baseline = new Set(descendants(HOST_PID))
  const sessions: { ws: WarmSession; cap: ReturnType<typeof stubServer> }[] = []
  const rows: { n: number; hostRss: number; treeRss: number; pidCount: number }[] = []
  for (let n = 1; n <= 4; n++) {
    const cap = stubServer(() => sseText(`ANSWER-${n}`, HAIKU))
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url })
    const r = await ws.oneShot(`warm session ${n}`, HAIKU, { recycle: true })
    await settle(2_000)
    sessions.push({ ws, cap })
    const allPids = descendants(HOST_PID).filter((p) => !baseline.has(p))
    const row = { n, hostRss: vmRssKb(HOST_PID), treeRss: treeRssKb(allPids), pidCount: allPids.length }
    rows.push(row)
    console.log(`session ${n} (outcome ${r.kind}): host=${mb(row.hostRss)}  cumulative CLI-tree=${mb(row.treeRss)}  pids=${row.pidCount}`)
  }
  console.log("--- marginal deltas ---")
  for (let i = 0; i < rows.length; i++) {
    const cur = rows[i]
    if (!cur) continue
    const prevHost = i === 0 ? undefined : rows[i - 1]?.hostRss
    const prevTree = i === 0 ? undefined : rows[i - 1]?.treeRss
    const hostDelta = prevHost === undefined ? cur.hostRss : cur.hostRss - prevHost
    const treeDelta = prevTree === undefined ? cur.treeRss : cur.treeRss - prevTree
    console.log(`  session ${cur.n} marginal: host delta=${mb(hostDelta)}  CLI-tree delta=${mb(treeDelta)}  total marginal=${mb(hostDelta + treeDelta)}`)
  }
  const allPids = descendants(HOST_PID).filter((p) => !baseline.has(p))
  for (const s of sessions) { s.ws.close(); s.cap.stop() }
  await forceCleanup(allPids)
}

// ---- 3. RECYCLE: does /clear return RSS to baseline or ratchet? ----
{
  console.log("\n=== 3. RECYCLE (/clear) effect on one session's RSS ===")
  const baseline = new Set(descendants(HOST_PID))
  const cap = stubServer(() => sseText("ANSWER", HAIKU))
  const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url })
  await ws.oneShot("turn 1 (warms the session)", HAIKU, { recycle: true })
  await settle(2_000)
  const pids = descendants(HOST_PID).filter((p) => !baseline.has(p))   // fixed pid set: /clear does not respawn
  const afterTurn1 = treeRssKb(pids)
  console.log("pids (same subprocess tree for the whole block, no respawn expected):", pids)
  console.log("after turn 1 (warm, pre-recycle):", mb(afterTurn1))

  await ws.oneShot("turn 2 (recycle #1 -- goes through /clear)", HAIKU, { recycle: true })
  await settle(2_000)
  const afterRecycle1 = treeRssKb(pids)
  console.log("after turn 2 (post-/clear recycle #1):", mb(afterRecycle1),
    " delta vs pre-recycle:", mb(afterRecycle1 - afterTurn1))

  await ws.oneShot("turn 3 (recycle #2)", HAIKU, { recycle: true })
  await settle(2_000)
  const afterRecycle2 = treeRssKb(pids)
  console.log("after turn 3 (post-/clear recycle #2):", mb(afterRecycle2),
    " delta vs recycle #1:", mb(afterRecycle2 - afterRecycle1))

  console.log(afterRecycle2 <= afterRecycle1 + 2_000
    ? "-> READS AS: recycled RSS is flat / does not ratchet (within ~2MB noise band)"
    : "-> READS AS: recycled RSS is CLIMBING across recycles (possible ratchet -- re-run to confirm, this is n=1)")

  ws.close()
  cap.stop()
  await forceCleanup(pids)
}

console.log("\n=== final ===")
console.log("MemAvailable (after all sessions closed):", mb(memAvailableKb()))
console.log("host RSS (after all sessions closed):", mb(vmRssKb(HOST_PID)))
const leftover = directChildren(HOST_PID)
console.log("children of host pid remaining:", leftover.length === 0 ? "none" : leftover)

process.exit(0)
