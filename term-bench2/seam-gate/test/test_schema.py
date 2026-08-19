"""Tests for term-bench2/seam-gate/spec_check.py (plain unittest, no pytest).

Run with:
    python3 -m unittest discover -s term-bench2/seam-gate/test -p 'test_*.py'
"""

import copy
import json
import os
import sys
import unittest

# spec_check.py lives one directory up from this test file. unittest discover
# does not automatically put that directory on sys.path, so add it explicitly.
_SEAM_GATE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _SEAM_GATE_DIR not in sys.path:
    sys.path.insert(0, _SEAM_GATE_DIR)

from spec_check import check_spec  # noqa: E402

REFERENCE_SPEC_PATH = os.path.join(_SEAM_GATE_DIR, "specs", "gcode-to-text-gate.json")


def load_reference_spec():
    with open(REFERENCE_SPEC_PATH) as f:
        return json.load(f)


class TestReferenceSpec(unittest.TestCase):
    def test_reference_spec_validates(self):
        spec = load_reference_spec()
        errors = check_spec(spec)
        self.assertEqual(errors, [], f"reference spec should validate, got errors: {errors}")

    def test_reference_spec_calibrated_cluster_seam_has_no_provisional_key(self):
        # Fix-round ruling (task-3-review.md LOW-1, 2026-08-19): this test
        # used to assert "s4" was listed in the top-level `provisional` key
        # (i.e. its cluster-count bounds were still placeholders). Task 3's
        # calibration harness (calibrate_gcode.py) has since measured and
        # rewritten s4's bounds against the real oracle artifact -- they are
        # no longer placeholders, so `rewrite_spec` now strips `provisional`
        # entirely once calibration empties it (s4 was the only entry).
        # `provisional` remains an OPTIONAL top-level key in the *format*
        # itself -- schema.json / spec_check.py accept a spec with or
        # without it -- only this specific, now-calibrated reference spec
        # instance drops it. This is a deliberate, ruled recalibration of
        # this test, not a relaxation of the format.
        spec = load_reference_spec()
        self.assertNotIn("provisional", spec)
        # spec_check accepts the key's absence on this spec...
        self.assertEqual(check_spec(spec), [])
        # ...and would equally accept its presence on some OTHER spec
        # instance -- the format itself is unchanged, only this reference
        # spec's calibrated state differs.
        with_provisional = copy.deepcopy(spec)
        with_provisional["provisional"] = ["s4"]
        self.assertEqual(check_spec(with_provisional), [])


class TestUnknownOpRejected(unittest.TestCase):
    def test_unknown_op_rejected(self):
        spec = load_reference_spec()
        spec = copy.deepcopy(spec)
        spec["seams"][0]["predicate"] = {"op": "totally_made_up_op"}
        errors = check_spec(spec)
        self.assertTrue(errors, "unknown op should produce at least one error")
        self.assertTrue(
            any("unknown op" in e for e in errors),
            f"expected an 'unknown op' error, got: {errors}",
        )


class TestUnknownTopLevelKeyRejected(unittest.TestCase):
    def test_unknown_top_level_key_rejected(self):
        spec = load_reference_spec()
        spec = copy.deepcopy(spec)
        spec["totallyUnexpectedKey"] = True
        errors = check_spec(spec)
        self.assertTrue(errors, "unknown top-level key should produce at least one error")
        self.assertTrue(
            any("unknown top-level key" in e for e in errors),
            f"expected an 'unknown top-level key' error, got: {errors}",
        )


class TestMissingArtifactReferenceRejected(unittest.TestCase):
    def test_missing_artifact_reference_rejected(self):
        spec = load_reference_spec()
        spec = copy.deepcopy(spec)
        spec["seams"][0]["artifact"] = "no_such_artifact_id"
        errors = check_spec(spec)
        self.assertTrue(errors, "a seam referencing an undefined artifact id should be rejected")
        self.assertTrue(
            any("not defined in top-level 'artifactIds'" in e for e in errors),
            f"expected a missing-artifact-reference error, got: {errors}",
        )


# --------------------------------------------------------------------------
# Task 7 structural id-join: "artifacts" path map is REMOVED, artifactIds is
# a flat list of bare ids only (no paths anywhere).
# --------------------------------------------------------------------------

class TestArtifactsPathMapRejected(unittest.TestCase):
    def test_legacy_artifacts_key_rejected_as_unknown_top_level_key(self):
        # The old id->path map is not merely deprecated -- carrying it at
        # all (even alongside a valid artifactIds) makes the spec invalid.
        spec = load_reference_spec()
        spec = copy.deepcopy(spec)
        spec["artifacts"] = {"points": "/app/.seam/points.txt"}
        errors = check_spec(spec)
        self.assertTrue(errors, "a spec carrying 'artifacts' should be rejected")
        self.assertTrue(
            any("unknown top-level key 'artifacts'" in e for e in errors),
            f"expected an unknown-top-level-key error for 'artifacts', got: {errors}",
        )

    def test_missing_artifact_ids_rejected(self):
        spec = load_reference_spec()
        spec = copy.deepcopy(spec)
        del spec["artifactIds"]
        errors = check_spec(spec)
        self.assertTrue(errors)
        self.assertTrue(any("missing required top-level key 'artifactIds'" in e for e in errors))

    def test_path_bearing_artifact_id_rejected(self):
        # The removed freedom (inventing a filename via a path) is
        # enforced-absent, not just undocumented: a bare id with a path
        # separator is rejected outright.
        spec = load_reference_spec()
        spec = copy.deepcopy(spec)
        spec["artifactIds"] = ["/app/.seam/points.txt", "projected"]
        errors = check_spec(spec)
        self.assertTrue(errors, "a path-bearing artifactIds entry should be rejected")
        self.assertTrue(
            any("must be a bare id, not a path" in e for e in errors),
            f"expected a bare-id error, got: {errors}",
        )

    def test_backslash_path_bearing_artifact_id_rejected(self):
        spec = load_reference_spec()
        spec = copy.deepcopy(spec)
        spec["artifactIds"] = ["points\\file", "projected"]
        errors = check_spec(spec)
        self.assertTrue(errors)
        self.assertTrue(any("must be a bare id, not a path" in e for e in errors))

    def test_duplicate_artifact_id_rejected(self):
        spec = load_reference_spec()
        spec = copy.deepcopy(spec)
        spec["artifactIds"] = ["points", "points"]
        errors = check_spec(spec)
        self.assertTrue(errors)
        self.assertTrue(any("duplicate artifactIds entry 'points'" in e for e in errors))

    def test_empty_artifact_ids_rejected(self):
        spec = load_reference_spec()
        spec = copy.deepcopy(spec)
        spec["artifactIds"] = []
        errors = check_spec(spec)
        self.assertTrue(errors)


# --------------------------------------------------------------------------
# Task 7 item 4: source_crosscheck predicate shape.
# --------------------------------------------------------------------------

class TestSourceCrosscheckShape(unittest.TestCase):
    def test_valid_source_crosscheck_predicate_accepted(self):
        spec = {
            "seamSpecVersion": 1,
            "task": "unit-test-task",
            "artifactIds": ["a"],
            "seams": [
                {
                    "id": "s1",
                    "artifact": "a",
                    "predicate": {"op": "source_crosscheck", "reader": "gcode_g1_points", "sample": 50},
                    "onFail": "mismatch",
                }
            ],
        }
        self.assertEqual(check_spec(spec), [])

    def test_source_crosscheck_missing_reader_rejected(self):
        spec = {
            "seamSpecVersion": 1,
            "task": "unit-test-task",
            "artifactIds": ["a"],
            "seams": [
                {"id": "s1", "artifact": "a", "predicate": {"op": "source_crosscheck", "sample": 50}, "onFail": "x"}
            ],
        }
        errors = check_spec(spec)
        self.assertTrue(errors)
        self.assertTrue(any("missing required param 'reader'" in e for e in errors))

    def test_source_crosscheck_non_positive_sample_rejected(self):
        spec = {
            "seamSpecVersion": 1,
            "task": "unit-test-task",
            "artifactIds": ["a"],
            "seams": [
                {
                    "id": "s1",
                    "artifact": "a",
                    "predicate": {"op": "source_crosscheck", "reader": "gcode_g1_points", "sample": 0},
                    "onFail": "x",
                }
            ],
        }
        errors = check_spec(spec)
        self.assertTrue(errors)
        self.assertTrue(any("predicate.sample must be a positive integer" in e for e in errors))


class TestMinimalValidSpec(unittest.TestCase):
    def test_minimal_spec_with_every_op_validates(self):
        spec = {
            "seamSpecVersion": 1,
            "task": "unit-test-task",
            "artifactIds": ["a"],
            "seams": [
                {"id": "s1", "artifact": "a", "predicate": {"op": "artifact_exists"}, "onFail": "missing"},
                {"id": "s2", "artifact": "a", "predicate": {"op": "row_count_in_range", "min": 1, "max": 10}, "onFail": "bad count"},
                {"id": "s3", "artifact": "a", "predicate": {"op": "numeric_cols", "n": 2}, "onFail": "bad cols"},
                {"id": "s4", "artifact": "a", "predicate": {"op": "affine_residual_below", "cols": [0, 1, 2], "max_ratio": 0.1}, "onFail": "not planar"},
                {"id": "s5", "artifact": "a", "predicate": {"op": "variance_ratio_below", "component": 1, "max": 0.5}, "onFail": "too much variance"},
                {"id": "s6", "artifact": "a", "predicate": {"op": "spread_above", "col": 0, "min_std": 0.1}, "onFail": "too flat"},
                {"id": "s7", "artifact": "a", "predicate": {"op": "cluster_count_in_range", "method": "conncomp2d", "cell": 1.0, "min": 1, "max": 5}, "onFail": "bad cluster count"},
                {"id": "s8", "artifact": "a", "predicate": {"op": "value_in_range", "row": 0, "col": 0, "min": 0, "max": 1}, "onFail": "out of range"},
                {"id": "s9", "artifact": "a", "predicate": {"op": "source_crosscheck", "reader": "gcode_g1_points", "sample": 3}, "onFail": "source mismatch"},
            ],
        }
        errors = check_spec(spec)
        self.assertEqual(errors, [])

    def test_conncomp2d_only_method_enforced(self):
        spec = {
            "seamSpecVersion": 1,
            "task": "unit-test-task",
            "artifactIds": ["a"],
            "seams": [
                {
                    "id": "s1",
                    "artifact": "a",
                    "predicate": {"op": "cluster_count_in_range", "method": "gap1d", "cell": 1.0, "min": 1, "max": 5},
                    "onFail": "banned method",
                }
            ],
        }
        errors = check_spec(spec)
        self.assertTrue(errors)
        self.assertTrue(any("conncomp2d" in e for e in errors))

    def test_unknown_seam_key_rejected(self):
        spec = {
            "seamSpecVersion": 1,
            "task": "unit-test-task",
            "artifactIds": ["a"],
            "seams": [
                {
                    "id": "s1",
                    "artifact": "a",
                    "predicate": {"op": "artifact_exists"},
                    "onFail": "missing",
                    "extraKey": "not allowed",
                }
            ],
        }
        errors = check_spec(spec)
        self.assertTrue(errors)
        self.assertTrue(any("unknown key" in e for e in errors))

    def test_missing_required_param_rejected(self):
        spec = {
            "seamSpecVersion": 1,
            "task": "unit-test-task",
            "artifactIds": ["a"],
            "seams": [
                {
                    "id": "s1",
                    "artifact": "a",
                    "predicate": {"op": "row_count_in_range", "min": 1},
                    "onFail": "missing max",
                }
            ],
        }
        errors = check_spec(spec)
        self.assertTrue(errors)
        self.assertTrue(any("missing required param 'max'" in e for e in errors))

    def test_non_dict_spec_rejected(self):
        errors = check_spec(["not", "a", "dict"])
        self.assertTrue(errors)


if __name__ == "__main__":
    unittest.main()
