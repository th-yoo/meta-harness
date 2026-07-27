/**
 * minimal/cover.ts — line-coverage capture for the adequacy probe's S1 fix
 * (docs/2026-07-27-probe-grip-fix-design.md): which lines of the gate
 * artifact does the agent's verify.sh actually execute?
 *
 * Zero-dependency by design: task images need nothing installed. The hook is
 * a sitecustomize.py dropped on PYTHONPATH — every python process spawned
 * under the verify run auto-imports it, so python children of a bash
 * verify.sh are captured too. Appends executed 1-based line numbers of
 * COV_TARGET to COV_OUT at interpreter exit (append: multiple python
 * processes merge; parseCoveredLines dedups). Inert without both env vars;
 * every failure path is silent — coverage capture must never break a verify
 * run (fail-open, the caller treats missing output as "no coverage data").
 */

export const COVERAGE_HOOK_PY = `import os, sys, atexit, threading
_t = os.environ.get("COV_TARGET")
_o = os.environ.get("COV_OUT")
if _t and _o:
    try:
        _t = os.path.realpath(_t)
    except OSError:
        _t = None
if _t and _o:
    _lines = set()
    _cache = {}
    def _match(fn):
        v = _cache.get(fn)
        if v is None:
            try:
                v = os.path.realpath(fn) == _t
            except OSError:
                v = False
            _cache[fn] = v
        return v
    def _tr(frame, event, arg):
        if event == "line" and _match(frame.f_code.co_filename):
            _lines.add(frame.f_lineno)
        return _tr
    sys.settrace(_tr)
    threading.settrace(_tr)
    def _dump():
        try:
            with open(_o, "a") as f:
                for n in sorted(_lines):
                    f.write("%d\\n" % n)
        except OSError:
            pass
    atexit.register(_dump)
`

/** Parse COV_OUT content: one 1-based line number per line, junk ignored. */
export function parseCoveredLines(text: string): Set<number> {
  const out = new Set<number>()
  for (const l of text.split("\n")) {
    const n = Number.parseInt(l.trim(), 10)
    if (Number.isInteger(n) && n > 0) out.add(n)
  }
  return out
}
