#!/usr/bin/env python3
"""Hand-rolled seam-spec validator (stdlib only, no jsonschema dependency).

This mirrors the contract documented in schema.json, but is the actual
validation logic run by both the CLI here and by the Task-2 validator
(which imports check_spec directly). Keep schema.json and this file in
sync when the vocabulary changes.

Public API: check_spec(spec: dict) -> list[str]
    Returns a list of human-readable error strings. Empty list == valid.
    Never raises on malformed input -- always returns a (possibly long)
    error list instead, so callers can fail closed without a try/except.
"""

import json
import sys

SEAM_SPEC_VERSION = 1

# Task 7 (rung-4 structural fix package): the spec's top-level "artifacts" key
# used to map artifact id -> absolute in-container PATH. That map is REMOVED
# entirely -- specs now carry only "artifactIds" (a flat list of bare ids, no
# paths anywhere). validator.py resolves each id by convention:
# "<root>/.seam/<id>.txt" (see validator.resolve_artifact_id). This is a
# structural fix, not a cosmetic rename: a generated-card spec can no longer
# invent its own artifact filenames (the measured failure mode a prior probe
# round found -- see docs/loop-probes/census-e2e-20260819/gcode-card/
# verdict.md, "Card regen v4" section) because there is no path field left to
# invent. Any spec still carrying an "artifacts" key is rejected outright (an
# unknown top-level key, same as any other), and every artifactIds entry is
# checked to contain no path separator -- the removed freedom is
# enforced-absent, not just undocumented.
TOP_LEVEL_REQUIRED = {"seamSpecVersion", "task", "artifactIds", "seams"}
TOP_LEVEL_OPTIONAL = {"provisional"}
TOP_LEVEL_ALLOWED = TOP_LEVEL_REQUIRED | TOP_LEVEL_OPTIONAL

SEAM_REQUIRED = {"id", "artifact", "predicate", "onFail"}

# Frozen predicate vocabulary: op -> set of required param names (excluding "op" itself).
# No optional params in this vocabulary -- every listed param is required, and no
# other params are permitted for that op.
OP_PARAMS = {
    "artifact_exists": set(),
    "row_count_in_range": {"min", "max"},
    "numeric_cols": {"n"},
    "affine_residual_below": {"cols", "max_ratio"},
    "variance_ratio_below": {"component", "max"},
    "spread_above": {"col", "min_std"},
    "cluster_count_in_range": {"method", "cell", "min", "max"},
    "value_in_range": {"row", "col", "min", "max"},
    # Task 7 item 4: cross-checks N deterministically-sampled artifact rows
    # against the TASK'S SOURCE FILE via a frozen reader registry (see
    # readers.py). "reader" selects a registry entry by id; "sample" is the
    # target sample count N (the actual sampling rule -- every
    # floor(len/N)-th artifact row -- lives in validator.op_source_crosscheck,
    # not here; this module only checks shape).
    "source_crosscheck": {"reader", "sample"},
}


def _is_number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def _check_predicate_params(op, predicate, seam_id, errors):
    """Type/shape-check the params of a known op. Appends to errors in place."""
    if op == "row_count_in_range":
        for k in ("min", "max"):
            if not _is_number(predicate.get(k)):
                errors.append(f"seam '{seam_id}': predicate.{k} must be a number")
    elif op == "numeric_cols":
        n = predicate.get("n")
        if not _is_int(n) or n < 1:
            errors.append(f"seam '{seam_id}': predicate.n must be a positive integer")
    elif op == "affine_residual_below":
        cols = predicate.get("cols")
        if not (isinstance(cols, list) and len(cols) == 3 and all(_is_int(c) and c >= 0 for c in cols)):
            errors.append(f"seam '{seam_id}': predicate.cols must be a 3-element list of non-negative integers [i,j,k]")
        max_ratio = predicate.get("max_ratio")
        if not (_is_number(max_ratio) and max_ratio > 0):
            errors.append(f"seam '{seam_id}': predicate.max_ratio must be a positive number")
    elif op == "variance_ratio_below":
        component = predicate.get("component")
        if not (_is_int(component) and component >= 0):
            errors.append(f"seam '{seam_id}': predicate.component must be a non-negative integer")
        max_v = predicate.get("max")
        if not (_is_number(max_v) and max_v > 0):
            errors.append(f"seam '{seam_id}': predicate.max must be a positive number")
    elif op == "spread_above":
        col = predicate.get("col")
        if not (_is_int(col) and col >= 0):
            errors.append(f"seam '{seam_id}': predicate.col must be a non-negative integer")
        min_std = predicate.get("min_std")
        if not (_is_number(min_std) and min_std >= 0):
            errors.append(f"seam '{seam_id}': predicate.min_std must be a non-negative number")
    elif op == "cluster_count_in_range":
        if predicate.get("method") != "conncomp2d":
            errors.append(f"seam '{seam_id}': predicate.method must be 'conncomp2d' (the 1D gap method is banned)")
        cell = predicate.get("cell")
        if not (_is_number(cell) and cell > 0):
            errors.append(f"seam '{seam_id}': predicate.cell must be a positive number")
        for k in ("min", "max"):
            v = predicate.get(k)
            if not (_is_int(v) and v >= 0):
                errors.append(f"seam '{seam_id}': predicate.{k} must be a non-negative integer")
    elif op == "value_in_range":
        for k in ("row", "col"):
            v = predicate.get(k)
            if not (_is_int(v) and v >= 0):
                errors.append(f"seam '{seam_id}': predicate.{k} must be a non-negative integer")
        for k in ("min", "max"):
            if not _is_number(predicate.get(k)):
                errors.append(f"seam '{seam_id}': predicate.{k} must be a number")
    elif op == "artifact_exists":
        pass  # no params
    elif op == "source_crosscheck":
        reader = predicate.get("reader")
        if not (isinstance(reader, str) and reader):
            errors.append(f"seam '{seam_id}': predicate.reader must be a non-empty string")
        sample = predicate.get("sample")
        if not (_is_int(sample) and sample >= 1):
            errors.append(f"seam '{seam_id}': predicate.sample must be a positive integer")
    # unknown ops are handled by the caller before this function runs


def check_spec(spec):
    """Validate a parsed seam-spec dict against the frozen schema + vocabulary.

    Returns a list of error strings; empty list means the spec is valid.
    Defensive against any malformed shape -- never raises.
    """
    errors = []

    if not isinstance(spec, dict):
        return [f"spec must be a JSON object, got {type(spec).__name__}"]

    # --- top-level keys ---
    keys = set(spec.keys())
    unknown = keys - TOP_LEVEL_ALLOWED
    for k in sorted(unknown):
        errors.append(f"unknown top-level key '{k}'")
    missing = TOP_LEVEL_REQUIRED - keys
    for k in sorted(missing):
        errors.append(f"missing required top-level key '{k}'")

    # --- seamSpecVersion ---
    if "seamSpecVersion" in spec and spec["seamSpecVersion"] != SEAM_SPEC_VERSION:
        errors.append(f"seamSpecVersion must be {SEAM_SPEC_VERSION}, got {spec.get('seamSpecVersion')!r}")

    # --- task ---
    if "task" in spec and not (isinstance(spec["task"], str) and spec["task"]):
        errors.append("task must be a non-empty string")

    # --- artifactIds ---
    # No paths anywhere: this is a flat list of bare ids, never a path map.
    # validator.py resolves each id by convention ("<root>/.seam/<id>.txt");
    # a card/spec author has no field left in which to invent a filename.
    artifact_ids_field = spec.get("artifactIds")
    artifact_ids = set()
    if "artifactIds" in spec:
        if not isinstance(artifact_ids_field, list) or not artifact_ids_field:
            errors.append("artifactIds must be a non-empty array of artifact id strings")
        else:
            seen_artifact_ids = set()
            for idx, aid in enumerate(artifact_ids_field):
                label = f"artifactIds[{idx}]"
                if not (isinstance(aid, str) and aid):
                    errors.append(f"{label} must be a non-empty string")
                    continue
                if "/" in aid or "\\" in aid:
                    errors.append(
                        f"{label} ('{aid}') must be a bare id, not a path -- "
                        "artifactIds entries may not contain '/' or '\\\\'"
                    )
                    continue
                if aid in seen_artifact_ids:
                    errors.append(f"duplicate artifactIds entry '{aid}'")
                seen_artifact_ids.add(aid)
                artifact_ids.add(aid)

    # --- provisional (optional) ---
    if "provisional" in spec:
        provisional = spec["provisional"]
        if not isinstance(provisional, list) or not all(isinstance(s, str) for s in provisional):
            errors.append("provisional must be a list of seam id strings")

    # --- seams ---
    seams = spec.get("seams")
    if "seams" in spec:
        if not isinstance(seams, list) or not seams:
            errors.append("seams must be a non-empty array")
        else:
            seen_ids = set()
            for idx, seam in enumerate(seams):
                seam_label = f"seams[{idx}]"
                if not isinstance(seam, dict):
                    errors.append(f"{seam_label} must be an object")
                    continue

                seam_id = seam.get("id") if isinstance(seam.get("id"), str) else seam_label

                skeys = set(seam.keys())
                s_unknown = skeys - SEAM_REQUIRED
                for k in sorted(s_unknown):
                    errors.append(f"seam '{seam_id}': unknown key '{k}'")
                s_missing = SEAM_REQUIRED - skeys
                for k in sorted(s_missing):
                    errors.append(f"seam '{seam_id}': missing required key '{k}'")

                if not (isinstance(seam.get("id"), str) and seam.get("id")):
                    errors.append(f"{seam_label}: id must be a non-empty string")
                else:
                    if seam["id"] in seen_ids:
                        errors.append(f"duplicate seam id '{seam['id']}'")
                    seen_ids.add(seam["id"])

                if not (isinstance(seam.get("onFail"), str) and seam.get("onFail")):
                    errors.append(f"seam '{seam_id}': onFail must be a non-empty string")

                # artifact reference check
                artifact_ref = seam.get("artifact")
                if not (isinstance(artifact_ref, str) and artifact_ref):
                    errors.append(f"seam '{seam_id}': artifact must be a non-empty string")
                elif artifact_ref not in artifact_ids:
                    errors.append(f"seam '{seam_id}': artifact '{artifact_ref}' is not defined in top-level 'artifactIds'")

                # predicate check
                predicate = seam.get("predicate")
                if not isinstance(predicate, dict):
                    errors.append(f"seam '{seam_id}': predicate must be an object")
                    continue
                op = predicate.get("op")
                if op not in OP_PARAMS:
                    errors.append(f"seam '{seam_id}': unknown op '{op}' (allowed: {sorted(OP_PARAMS)})")
                    continue
                required_params = OP_PARAMS[op]
                pkeys = set(predicate.keys()) - {"op"}
                extra = pkeys - required_params
                for k in sorted(extra):
                    errors.append(f"seam '{seam_id}': predicate has unexpected param '{k}' for op '{op}'")
                missing_params = required_params - pkeys
                for k in sorted(missing_params):
                    errors.append(f"seam '{seam_id}': predicate missing required param '{k}' for op '{op}'")
                if not missing_params:
                    _check_predicate_params(op, predicate, seam_id, errors)

            # provisional seam-id references (best-effort, only checked if seams parsed)
            if "provisional" in spec and isinstance(spec.get("provisional"), list):
                for sid in spec["provisional"]:
                    if isinstance(sid, str) and sid not in seen_ids:
                        errors.append(f"provisional references unknown seam id '{sid}'")

    return errors


def main(argv):
    if len(argv) != 2:
        print("usage: spec_check.py <spec.json>", file=sys.stderr)
        return 2
    path = argv[1]
    try:
        with open(path) as f:
            spec = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        print(f"error reading/parsing '{path}': {e}", file=sys.stderr)
        return 2

    errors = check_spec(spec)
    if errors:
        for e in errors:
            print(f"INVALID: {e}")
        return 1
    print(f"VALID: {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
