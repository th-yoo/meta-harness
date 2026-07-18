const sub = process.argv[2]
const API = "https://huggingface.co/api/datasets/harborframework/terminal-bench-2-leaderboard/tree/main/"
const RES = "https://huggingface.co/datasets/harborframework/terminal-bench-2-leaderboard/resolve/main/"
async function j(url: string, tries = 4): Promise<any> {
  for (let a = 0; a < tries; a++) {
    try {
      const r = await fetch(url)
      if (r.status === 429) { await Bun.sleep(3000 * (a + 1)); continue }
      if (!r.ok) { await Bun.sleep(1000); continue }
      const v = await r.json()
      if (Array.isArray(v) || typeof v === "object") return v
    } catch { await Bun.sleep(1000) }
  }
  return null
}
const base = `submissions/terminal-bench/2.0/${sub}`
const top = await j(API + base)
if (!Array.isArray(top)) { console.log(sub + ": TOP LISTING FAILED"); process.exit(1) }
const jobs = top.filter((e: any) => e.type === "directory").map((e: any) => e.path)
const trials: string[] = []
for (const jb of jobs) {
  const t = await j(API + jb)
  if (Array.isArray(t)) trials.push(...t.filter((e: any) => e.type === "directory").map((e: any) => e.path))
}
const agg: Record<string, number[]> = {}
let i = 0
async function worker() {
  while (i < trials.length) {
    const tr = trials[i++]
    const r = await j(RES + tr + "/result.json")
    if (r && r.task_name) (agg[r.task_name] ??= []).push(r.verifier_result?.rewards?.reward ?? 0)
  }
}
await Promise.all(Array.from({ length: 12 }, worker))
await Bun.write(`agg-${sub}.json`, JSON.stringify(agg))
const tasks = Object.keys(agg); const tot = tasks.reduce((a, t) => a + agg[t].length, 0)
const pass = tasks.reduce((a, t) => a + agg[t].reduce((x: number, y: number) => x + y, 0), 0)
console.log(`${sub}: ${tasks.length} tasks, ${tot} trials, ${(100 * pass / (tot || 1)).toFixed(1)}%`)
