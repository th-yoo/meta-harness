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

    def test_reference_spec_has_provisional_cluster_seam(self):
        spec = load_reference_spec()
        self.assertIn("provisional", spec)
        self.assertIn("s4", spec["provisional"])
        seam_ids = {s["id"] for s in spec["seams"]}
        for sid in spec["provisional"]:
            self.assertIn(sid, seam_ids, f"provisional id '{sid}' must reference a real seam")


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
            any("not defined in top-level 'artifacts'" in e for e in errors),
            f"expected a missing-artifact-reference error, got: {errors}",
        )


class TestMinimalValidSpec(unittest.TestCase):
    def test_minimal_spec_with_every_op_validates(self):
        spec = {
            "seamSpecVersion": 1,
            "task": "unit-test-task",
            "artifacts": {"a": "/app/.seam/a.txt"},
            "seams": [
                {"id": "s1", "artifact": "a", "predicate": {"op": "artifact_exists"}, "onFail": "missing"},
                {"id": "s2", "artifact": "a", "predicate": {"op": "row_count_in_range", "min": 1, "max": 10}, "onFail": "bad count"},
                {"id": "s3", "artifact": "a", "predicate": {"op": "numeric_cols", "n": 2}, "onFail": "bad cols"},
                {"id": "s4", "artifact": "a", "predicate": {"op": "affine_residual_below", "cols": [0, 1, 2], "max_ratio": 0.1}, "onFail": "not planar"},
                {"id": "s5", "artifact": "a", "predicate": {"op": "variance_ratio_below", "component": 1, "max": 0.5}, "onFail": "too much variance"},
                {"id": "s6", "artifact": "a", "predicate": {"op": "spread_above", "col": 0, "min_std": 0.1}, "onFail": "too flat"},
                {"id": "s7", "artifact": "a", "predicate": {"op": "cluster_count_in_range", "method": "conncomp2d", "cell": 1.0, "min": 1, "max": 5}, "onFail": "bad cluster count"},
                {"id": "s8", "artifact": "a", "predicate": {"op": "value_in_range", "row": 0, "col": 0, "min": 0, "max": 1}, "onFail": "out of range"},
            ],
        }
        errors = check_spec(spec)
        self.assertEqual(errors, [])

    def test_conncomp2d_only_method_enforced(self):
        spec = {
            "seamSpecVersion": 1,
            "task": "unit-test-task",
            "artifacts": {"a": "/app/.seam/a.txt"},
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
            "artifacts": {"a": "/app/.seam/a.txt"},
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
            "artifacts": {"a": "/app/.seam/a.txt"},
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
