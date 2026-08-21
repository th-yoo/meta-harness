# Graphene sits 10x outside the §8.2(b) validated noise domain (2026-08-21)

Zero-spend measurement, found while empirically probing a cross-lane review
claim rather than accepting its (correct) argument. Reproduce with the command
at the bottom.

## Measurement

`sigmaFraction = max(sigma_u) / span(u)`, the §8.2(b) domain statistic, computed
from `derive.py:series_sigmas` on the committed fixtures:

| fixture | family | n | max sigma_u / span | median sigma_u / span | vs bound 0.01 |
|---|---|---|---|---|---|
| graphene | `x` | 17 | **0.10456** | 0.01504 | **OUT (10.5x)** |
| graphene | `1/x` | 17 | **0.15011** | 0.01530 | **OUT (15.0x)** |
| fixture-2 | `x` | 6 | 0.00074 | 0.00063 | IN |
| fixture-2 | `1/x` | 6 | 0.00127 | 0.00050 | IN |

The median anchor is also outside, so this is the fixture's noise regime and not
a single badly-tracked anchor.

## Consequence

**Under §8.2(b) the armed gate returns `uncheckable` on the real raman fixture,
always.** It never reaches the L-A / value-truth question. Arming buys nothing on
the motivating task, for a reason unrelated to source coverage.

Fixture-2 being comfortably inside is what rules out the alternative reading —
that the bound is vacuous and no real series could ever pass it.

## Why this was not visible earlier

`derive.py` V11 reports `accept` on graphene, and the reference is validated
11/11. But **`derive.py` implements no domain gate at all** — clause §8.2(b)
exists only in the spec text. The port is the first artifact where the clause and
the reference meet, and they disagree.

Generalisable: *a reference implementation validated N/N is silent about every
clause it never implemented.* "The port reproduces the reference" would have
hidden this completely, and the regression set built to pin the port to the
reference (Task 8) inherits the same blind spot by construction.

## What must NOT happen next

Do not choose a friendlier aggregator. `max` is fail-closed; the median (0.015)
is also outside; some statistic surely exists that lets graphene through, and
searching for it is fitting the bound to the fixture we want to pass — the §1
violation this plan exists to avoid.

The aggregator is **undetermined by the evidence**: V7's noise sweep was
homoscedastic, so it distinguishes no aggregator at all. Resolution requires the
heteroscedastic fixture already named as transfer debt, **pre-registered before
it runs**. That fixture is therefore promoted from deferred debt to a blocking
item for any claim about raman.

Until then: `max`, fail-closed, `uncheckable`, and the plan says so up front.

## Reproduce

```
python3 -B -c "
import importlib.util, statistics
spec = importlib.util.spec_from_file_location('derive','docs/loop-probes/derived-thresholds-20260821/derive.py')
d = importlib.util.module_from_spec(spec); spec.loader.exec_module(d)
for name, path, ufn, lbl in [
  ('graphene','term-bench2/probe-tasks/raman-fitting-audit/environment/task-deps/graphene.dat',lambda x:x,'x'),
  ('graphene','term-bench2/probe-tasks/raman-fitting-audit/environment/task-deps/graphene.dat',lambda x:1/x,'1/x'),
  ('fixture2','docs/loop-probes/dnc-second-fixture-20260820/fixture.dat',lambda x:x,'x'),
  ('fixture2','docs/loop-probes/dnc-second-fixture-20260820/fixture.dat',lambda x:1/x,'1/x')]:
    xs, us, sig_u, sy = d.series_sigmas(path, ufn)
    span = max(us)-min(us)
    print(name, lbl, len(us), max(sig_u)/span, statistics.median(sig_u)/span)
"
```

## Companion probe

`probe-rebuilt-battery.py` (+ `-output.txt`) records the finding that motivated
this measurement: a claim battery rebuilt from each parameter value's own anchors
yields a CONSTANT verdict vector while the anchor count moves 21 -> 17 -> 6 -> 4,
because `honest` is affine in `us` by construction. That is why Task 16's plateau
certificate references the DEFAULT parameters' output instead.
