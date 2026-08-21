# The minimal fixture the D&C machinery can actually run on (2026-08-21)

Zero model spend. The shipped D&C library is pure functions, so it was run
directly against every rung of the raman ablation ladder.

## 1. Engagement across the existing ladder — the machinery is excluded from both minimal rungs

| rung | task | rows | anchors | `mergeCheck` |
|---|---|---|---|---|
| 0 | `raman-value-report` | — | — | **no series artifact at all** — the value is inline in the instruction, the divide step has no input |
| 1 | `raman-peak-report` | 1500 | **1** | `insufficient-anchors` |
| 2 | `raman-fitting-audit` | 3565 | 17 | engages |

Rung 1's single anchor is **by design** — its generator declares *"single peak
... the only rung"*. So the over-determined method, whose entire mechanism is
having more anchors than fitted parameters, is structurally excluded from the
cleanest instruments we own: **the minimal task is n=1 by construction, and the
method needs n>=3.**

Rung 2's 17 anchors are NOT 17 Raman peaks — only two are (1579.9 G, 2670.2 2D);
the other 15 are baseline maxima. They are still valid anchors, because
`shift = 1e7/x` is exactly affine in `u = 1/x`, so every detected maximum lies on
the conversion line. 17 anchors against 2 fitted parameters is what makes the
over-determined check work, and it is why §6.1 forbids trimming the survivor set
by expected count.

## 2. MEASURED DEFECT — the documented floor and the operable floor disagree

`mergeCheck` guards `anchorsU.length < 3 -> insufficient-anchors`, and §6 states
n >= 3 throughout. But `conditioningCheck` adds its fixed +-1-index-shift
alternates only under `if (n - 1 >= 3)`, i.e. **n >= 4**. On geometry with no
automorphisms the alternate set is then EMPTY and the check fail-closes.

Built the input that shows it: a 3-band fixture (D, G, 2D) whose `inv-x` fit is
**exact** — `a = 2.3e-13`, `b = 1.00000e7`, the true conversion — and which
`mergeCheck` **REFUSES** as `degenerate-constellation`.

**The real operable floor of the shipped machinery is n = 4, not n = 3.** A
correct claim on a three-anchor spectrum can never be accepted.

## 3. `raman-quartet-report` — rung 1.5, the minimal runnable fixture

Four Lorentzian bands (D, G, D', 2D) on the same wavelength-nm trap axis, same
conventions as rung 1 (ascending, dot decimals, tab-separated, seed 42). G and 2D
parameters mirror `terminal-bench/raman-fitting`'s ground truth exactly; D and D'
are defect-activated bands whose parameters are only physically ordinary and
whose amplitudes the verifier never reads.

**First successful engagement of the D&C merge machinery on any real fixture:**

| check | result |
|---|---|
| detector | exactly **4 anchors** = the 4 real bands (2670.2 / 1619.5 / 1580.4 / 1349.3) |
| honest claim, `inv-x` | **ok = true**, `a = -2.3e-13`, `b = 1.00000e7` |
| wrong family, `x` | rejected — `residual` |
| shifted pairing | rejected — `residual` |

Reference solution (local argmax per band + `1e7/x`) passes all four within
0.24 cm^-1 against a +-5 tolerance. The instruction carries **no numeric
literal** — the only digits in it are inside the band name `2D` and the field
name `x0` — so the conversion and the band conventions must both come from the
model.

## Authorship boundary — declared

This is a **self-authored instrument**, not evidence about the benchmark
population. Per the authorship-boundary law it can measure what the machinery
does; it can never be counted toward generality, and it must be excluded from any
task-population denominator exactly as the other five self-authored raman probes
now are.

Its legitimate use is narrow and stated: it is the smallest fixture on which the
merge gate can be exercised at all, which makes it the right place to test the
gate's behaviour — and the wrong place to claim the gate matters.
