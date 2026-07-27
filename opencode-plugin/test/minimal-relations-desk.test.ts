import { test, expect } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, cpSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Desk validation (false-accept probes plan Task 5/6): every relation must
// PASS on the oracle artifact (zero false alarms) and the suite must FAIL a
// deliberately degraded artifact (grip). Real python3 — no fakes.

const TASKS = join(import.meta.dir, "../../minimal/tasks")

// Overriding HOME (below) isolates ~/.bashrc + the tmux socket from the real
// host, but it also changes where Python resolves user-site packages (e.g.
// rdflib lives under the real $HOME/.local/...). Capture the real, unmodified
// sys.path once and force it via PYTHONPATH so module resolution is unaffected
// by the HOME override.
const PY_SITE_PATH = Bun.spawnSync(["python3", "-c", "import sys,os; print(os.pathsep.join(p for p in sys.path if p))"], {
  timeout: 10_000,
})
  .stdout.toString()
  .trim()

function runRelation(scriptPath: string, appdir: string, artifact: string): { code: number; out: string } {
  const r = Bun.spawnSync(["python3", scriptPath], {
    cwd: appdir,
    env: { ...process.env, APPDIR: appdir, ARTIFACT: artifact, HOME: appdir, TMUX_TMPDIR: appdir, PYTHONPATH: PY_SITE_PATH },
    timeout: 60_000,
  })
  return { code: r.exitCode ?? 1, out: r.stdout.toString() + r.stderr.toString() }
}

function headlessAppdir(artifactSource: string): { appdir: string; artifact: string } {
  const dir = mkdtempSync(join(tmpdir(), "mh-desk-headless-"))
  cpSync(join(TASKS, "headless-terminal/fixtures/base_terminal.py"), join(dir, "base_terminal.py"))
  const artifact = join(dir, "headless_terminal.py")
  writeFileSync(artifact, artifactSource)
  // tmux spawns the pane shell as a login shell (argv0 "-bash"), which reads
  // ~/.profile (not ~/.bashrc directly) when no ~/.bash_profile/~/.bash_login
  // exists — mirror the real host's Debian-skel ~/.profile so the isolated
  // appdir still exercises "does an interactive shell source ~/.bashrc".
  writeFileSync(
    join(dir, ".profile"),
    'if [ -n "$BASH_VERSION" ]; then\n  if [ -f "$HOME/.bashrc" ]; then\n    . "$HOME/.bashrc"\n  fi\nfi\n',
  )
  return { appdir: dir, artifact }
}

const RELDIR = join(TASKS, "headless-terminal/relations")
const ORACLE = readFileSync(join(TASKS, "headless-terminal/oracle/headless_terminal.py"), "utf-8")

test("headless: every relation PASSES on the oracle artifact", () => {
  const { appdir, artifact } = headlessAppdir(ORACLE)
  for (const f of readdirSync(RELDIR).filter((f) => f.endsWith(".py"))) {
    const r = runRelation(join(RELDIR, f), appdir, artifact)
    expect({ relation: f, code: r.code, out: r.out.slice(-300) }).toEqual({ relation: f, code: 0, out: r.out.slice(-300) })
  }
  Bun.spawnSync(["tmux", "kill-server"], { env: { ...process.env, TMUX_TMPDIR: appdir } })
}, 120_000)

test("headless: degraded artifact (drops modifier keys) violates at least one relation", () => {
  // Degradation: strip control characters before sending — Ctrl-C/Ctrl-D become no-ops.
  const degraded = ORACLE.replace(
    "def send_keystrokes(self, keystrokes: str, wait_sec: float = 0.0) -> None:",
    'def send_keystrokes(self, keystrokes: str, wait_sec: float = 0.0) -> None:\n        keystrokes = "".join(c for c in keystrokes if c >= " " or c == "\\n")',
  )
  expect(degraded).not.toBe(ORACLE) // the anchor line must exist
  const { appdir, artifact } = headlessAppdir(degraded)
  const codes = readdirSync(RELDIR)
    .filter((f) => f.endsWith(".py"))
    .map((f) => runRelation(join(RELDIR, f), appdir, artifact).code)
  expect(codes.some((c) => c !== 0)).toBe(true)
  Bun.spawnSync(["tmux", "kill-server"], { env: { ...process.env, TMUX_TMPDIR: appdir } })
}, 120_000)

function sparqlAppdir(query: string): { appdir: string; artifact: string } {
  const dir = mkdtempSync(join(tmpdir(), "mh-desk-sparql-"))
  cpSync(join(TASKS, "sparql-university/fixtures/university_graph.ttl"), join(dir, "university_graph.ttl"))
  const artifact = join(dir, "solution.sparql")
  writeFileSync(artifact, query)
  return { appdir: dir, artifact }
}

const SP_RELDIR = join(TASKS, "sparql-university/relations")
const SP_ORACLE = readFileSync(join(TASKS, "sparql-university/oracle/solution.sparql"), "utf-8")

test("sparql: every relation PASSES on the oracle query", () => {
  const { appdir, artifact } = sparqlAppdir(SP_ORACLE)
  for (const f of readdirSync(SP_RELDIR).filter((f) => f.endsWith(".py"))) {
    const r = runRelation(join(SP_RELDIR, f), appdir, artifact)
    expect({ relation: f, code: r.code, out: r.out.slice(-300) }).toEqual({ relation: f, code: 0, out: r.out.slice(-300) })
  }
}, 120_000)

test("sparql: degraded query (hardcoded professor names) violates mr-rename", () => {
  // Degradation of the false-accept class: replace the data-driven professor
  // pattern with hardcoded VALUES of whatever names the oracle returns —
  // looks right on today's graph, breaks the isomorphism relation.
  const { appdir, artifact } = sparqlAppdir(SP_ORACLE)
  const namesOut = Bun.spawnSync(
    [
      "python3",
      "-c",
      `import rdflib,os; g=rdflib.Graph(); g.parse(os.path.join(${JSON.stringify(join(TASKS, "sparql-university/fixtures"))},"university_graph.ttl"),format="turtle"); print("\\n".join(sorted({str(r[0]) for r in g.query(open(${JSON.stringify(artifact)}).read())})))`,
    ],
    { timeout: 60_000 },
  )
  const names = namesOut.stdout.toString().trim().split("\n").filter(Boolean)
  expect(names.length).toBeGreaterThan(0)
  const hardcoded = `PREFIX uni: <http://university.org/ontology/>
SELECT ?professorName (GROUP_CONCAT(DISTINCT ?country; separator=", ") AS ?countries)
WHERE {
  ?professor a uni:Person ; uni:hasName ?professorName ; uni:worksIn ?dept .
  ?dept uni:belongsTo ?u . ?u uni:locatedInCountry ?country .
  VALUES ?professorName { ${names.map((n) => JSON.stringify(n)).join(" ")} }
}
GROUP BY ?professorName`
  const { appdir: appdir2, artifact: artifact2 } = sparqlAppdir(hardcoded)
  const r = runRelation(join(SP_RELDIR, "mr-rename.py"), appdir2, artifact2)
  expect(r.code).not.toBe(0)
}, 120_000)
