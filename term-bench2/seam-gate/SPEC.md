# Seam-gate spec format

A seam spec is a JSON document declaring the artifacts an agent must produce at
intermediate checkpoints ("seams") in a pipeline, and a predicate that must hold on
each artifact. The Stop-hook validator (Task 2) recomputes each predicate directly
from the artifact file on disk -- it never trusts an agent's self-report.

The spec is **data only**. It is drawn from a frozen predicate vocabulary; no
auditor-authored code is ever executed by the validator. This is a hard boundary:
adding a new check requires adding a new op to the vocabulary (in `schema.json` +
`spec_check.py` + the validator), never embedding code in a spec file.

## Top-level shape

```json
{
  "seamSpecVersion": 1,
  "task": "<name>",
  "artifacts": { "<id>": "/app/.seam/<file>" },
  "provisional": ["<seam-id>", "..."],
  "seams": [
    { "id": "s1", "artifact": "<id>", "predicate": { "op": "<vocab-op>", "...": "params" },
      "onFail": "<one-line evidence message for the agent>" }
  ]
}
```

| Key | Required | Meaning |
|---|---|---|
| `seamSpecVersion` | yes | Frozen at `1`. |
| `task` | yes | Task name this spec gates. |
| `artifacts` | yes | Map of artifact id -> absolute in-container path. Every `seam.artifact` must reference a key defined here. |
| `provisional` | no | List of seam ids whose predicate params are placeholder bounds pending calibration (see Task 3). Purely advisory -- the validator enforces provisional seams exactly like any other; the key just flags "these numbers are expected to be rewritten." |
| `seams` | yes | Ordered list of seam objects, evaluated independently (order has no semantic effect). |

Each seam object has exactly four keys: `id`, `artifact`, `predicate`, `onFail`. No
other keys are permitted on a seam, and no other top-level keys are permitted on the
spec -- both `schema.json` and `spec_check.py` reject unknown keys at either level.

`onFail` is shown to the agent (via the Stop hook's stderr) when the seam fails. It
should read as evidence, not instruction: state what was measured and why it fails,
not what to do about it -- the model decides the fix.

## Frozen predicate vocabulary

Exactly these eight ops exist. A spec containing any other `predicate.op` value is
invalid. Each op's params are *all* required -- no optional params, no extra params.

### `artifact_exists`

File is present and non-empty. No params.

```json
{ "op": "artifact_exists" }
```

### `row_count_in_range` {min, max}

Numeric rows in the artifact must be in `[min, max]`.

```json
{ "op": "row_count_in_range", "min": 35000, "max": 45000 }
```

Worked example (from the gcode reference spec, seam `s1`): `points.txt` holds one
row per filtered S0+E extrusion point. A correct filter over the sample gcode yields
roughly 39,000 rows; the range `[35000, 45000]` catches both "filter selected the
whole file" (too many rows) and "filter selected nothing / wrong tool state" (too
few).

### `numeric_cols` {n}

Every row in the artifact has exactly `n` numeric columns (whitespace- or
comma-separated).

```json
{ "op": "numeric_cols", "n": 3 }
```

Worked example (seam `s2`): `points.txt` rows must be `x y z` -- exactly 3 columns.
A row with 2 columns (e.g. accidental XY-only output) or 4+ columns (e.g. a stray
feedrate field left in) fails this seam.

### `affine_residual_below` {cols: [i, j, k], max_ratio}

Least-squares residual variance of column `k`, regressed on columns `i, j` plus an
intercept, divided by column `k`'s own variance, must be `< max_ratio`. This is a
planarity check computed directly from the raw artifact columns -- it recomputes
the fit itself rather than trusting a precomputed residual field.

```json
{ "op": "affine_residual_below", "cols": [0, 1, 2], "max_ratio": 0.02 }
```

Worked example (seam `s3`): `points.txt` columns are `x=0, y=1, z=2`. The text
object's extruding points lie on a plane `z = a*x + b*y + c`. Fitting that plane by
least squares over `points.txt` and dividing residual variance by `var(z)` should
land well under 2% if `points.txt` is correctly filtered to on-plane extrusion
points; an unfiltered cloud (including travel moves off the plane) inflates the
ratio past `max_ratio`.

### `variance_ratio_below` {component, max}

SVD on the artifact's numeric columns (mean-centered); the variance ratio
(singular value squared, normalized to sum to 1) of the given 0-indexed component
must be `< max`.

```json
{ "op": "variance_ratio_below", "component": 2, "max": 0.01 }
```

Worked example (seam `s6`): on `points.txt` (`x,y,z`, 3 columns), component index 2
is the smallest singular value's direction -- for points confined to a plane, that
direction should carry almost no variance. `max: 0.01` catches a cloud that still
has meaningful out-of-plane spread (i.e. isn't actually flat).

Note: `component` must be a valid 0-indexed column position for the target
artifact (an artifact with only 2 numeric columns has components `0` and `1` only
-- `component: 2` is undefined there and must reference an artifact with >= 3
columns instead).

### `spread_above` {col, min_std}

Standard deviation of a column must be above `min_std`.

```json
{ "op": "spread_above", "col": 1, "min_std": 1.0 }
```

Worked example (seam `s5`): `projected.txt` holds `u v` rows (the plane-basis
projection of the text points). Column 1 (`v`) should have real spread if the
projection basis is genuine -- a degenerate "projection" that just passes raw
`x,y` through unprojected, or one that collapses onto a line, produces low
variance and fails this seam.

### `cluster_count_in_range` {method: "conncomp2d", cell, min, max}

Rasterize columns 0 and 1 of the artifact onto a grid at the given `cell` size
(same units as the columns), take 8-connected components with a minimum pixel
floor of 3, and count components in `[min, max]`. **`method` must be
`"conncomp2d"`** -- the 1D gap-scan method is banned (measured false positive: a
naive 1D gap scan at 2.0mm returns 2 clusters on oracle-grade artifacts, where the
true glyph count is ~26; see the rung-4 plan's calibration finding).

```json
{ "op": "cluster_count_in_range", "method": "conncomp2d", "cell": 0.5, "min": 10, "max": 40 }
```

Worked example (seam `s4`, **provisional** -- see `provisional` key): `clusters.txt`
holds one row per detected connected component (`cx cy pixels`). The gcode flag
text is 26 glyphs; `[10, 40]` is a wide placeholder range pending Task 3's
calibration sweep, which rewrites `cell`/`min`/`max` against the real oracle
artifact.

### `value_in_range` {row, col, min, max}

Single scalar check: the value at `row, col` (0-indexed) must be in `[min, max]`.

```json
{ "op": "value_in_range", "row": 0, "col": 0, "min": 0.9, "max": 1.0 }
```

Worked example: a single-row summary artifact (e.g. an R^2 or fit-quality scalar
written by the agent as its own row 0, col 0) must land in a plausible range. Not
used by the gcode reference spec in this task (all its checks recompute directly
from raw data rather than trusting an agent-reported scalar), but available for
specs where a single derived number is the natural checkpoint.

## Validation

Two equivalent validators exist for this spec format:

- `schema.json` -- a JSON Schema (draft-07) documenting the full contract:
  required/optional top-level keys with `additionalProperties: false`, the seam
  shape, and a `oneOf` over the eight predicate shapes (each with its own
  `additionalProperties: false` and `const` op tag). This is the schema-as-contract
  reference; treat it as the source of truth for *shape*.
- `spec_check.py` -- a dependency-free (stdlib-only) hand-rolled checker exposing
  `check_spec(spec: dict) -> list[str]` (empty list = valid). This is what actually
  runs, in both the CLI here and inside Task 2's validator, because `jsonschema` is
  not assumed importable in the runtime environment the hook executes in. It
  enforces everything `schema.json` documents, plus the one check JSON Schema can't
  express on its own: every `seam.artifact` must reference a key present in the
  spec's `artifacts` map.

Keep the two in sync when the vocabulary changes -- `schema.json` documents the
contract, `spec_check.py` enforces it.

## Reference spec

`specs/gcode-to-text-gate.json` is the reference instance: 6 seams over 3 artifacts
(`points`, `projection`, `clusters`) gating the gcode-to-text pipeline's filter,
plane-fit, projection, and clustering checkpoints. Seam `s4` (cluster count) is
listed in `provisional` -- its `cell`/`min`/`max` are placeholder bounds; Task 3's
calibration harness rewrites them against the real oracle artifact.
