"""Tests for term-bench2/seam-gate/calibrate_gcode.py (plain unittest, no pytest).

Run with:
    python3 -m unittest discover -s term-bench2/seam-gate/test -p 'test_*.py'

Two groups of tests:

  - Pure-logic tests (no external fixture needed, never skip): exercise
    `collect_points`'s gcode parsing against a small synthetic fixture,
    `rewrite_spec`'s artifact/seam retarget, and `search_cell`'s primary +
    fallback paths against synthetic projection artifacts.
  - `TestEndToEndRealFixture`: runs the harness against the *real* tb2
    gcode-to-text fixture (`~/z2/terminal-bench-2/gcode-to-text/environment/
    text.gcode.gz`, gunzipped to a temp file) and asserts the oracle-pass /
    bad-fail contract plus schema validity of the rewritten spec. SKIPS
    (not fails) with a clear message if that checkout isn't present on this
    host.
"""

import gzip
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

import numpy as np

# calibrate_gcode.py / validator.py / spec_check.py live one directory up
# from this test file. unittest discover does not automatically put that
# directory on sys.path, so add it explicitly (same pattern as
# test_validator.py / test_schema.py).
_SEAM_GATE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _SEAM_GATE_DIR not in sys.path:
    sys.path.insert(0, _SEAM_GATE_DIR)

import calibrate_gcode  # noqa: E402
import validator  # noqa: E402
from spec_check import check_spec  # noqa: E402

CALIBRATE_PATH = os.path.join(_SEAM_GATE_DIR, "calibrate_gcode.py")
REFERENCE_SPEC_PATH = os.path.join(_SEAM_GATE_DIR, "specs", "gcode-to-text-gate.json")
REAL_GCODE_GZ_PATH = os.path.expanduser(
    "~/z2/terminal-bench-2/gcode-to-text/environment/text.gcode.gz"
)


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

def load_reference_spec():
    with open(REFERENCE_SPEC_PATH) as f:
        return json.load(f)


def find_seam(spec, seam_id):
    for seam in spec["seams"]:
        if seam["id"] == seam_id:
            return seam
    return None


def run_calibrate_subprocess(args):
    """Shell out to `python3 calibrate_gcode.py ...` for a true end-to-end
    exit-code check, matching test_validator.py's subprocess-CLI pattern.
    """
    cmd = [sys.executable, CALIBRATE_PATH] + args
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=_SEAM_GATE_DIR)
    return proc.returncode, proc.stdout, proc.stderr


class CalibrateTestCase(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="seam-gate-calibrate-test-")

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def write_gcode(self, text):
        path = os.path.join(self.tmpdir, "test.gcode")
        with open(path, "w") as f:
            f.write(text)
        return path

    def write_scratch_spec(self, spec):
        path = os.path.join(self.tmpdir, "spec.json")
        with open(path, "w") as f:
            json.dump(spec, f)
        return path


# --------------------------------------------------------------------------
# collect_points: gcode parsing
# --------------------------------------------------------------------------

# A small synthetic fixture reproducing the real file's shape: an M486 S0
# ("text") block with extruding (E-param) motion, a travel-only line inside
# that same block (no E -- must NOT count as oracle), a retraction-only E
# move with no X/Y (must NOT count as oracle -- no positional change), then
# an M486 S1 ("shape") block that must be excluded from BOTH oracle and bad
# by S-scoping... except bad is deliberately *unscoped*, so its G1 lines
# still count regardless of S state.
SYNTHETIC_GCODE = """\
; header comment, ignored
G28 ; home, not G0/G1, ignored

M486 S0
G1 X10 Y10 Z0.2 F1200
G1 X11 Y10 E0.5 F900
G0 X20 Y20 Z5 F3000
G1 E-0.7 F2100
G1 X12 Y11 E0.6
M486 S-1

M486 S1
G1 X50 Y50 Z0.2 E0.4
M486 S-1
"""


class TestCollectPoints(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="seam-gate-collect-test-")

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _write(self, text):
        path = os.path.join(self.tmpdir, "t.gcode")
        with open(path, "w") as f:
            f.write(text)
        return path

    def test_oracle_points_scoped_to_s0_extruding_with_xy(self):
        path = self._write(SYNTHETIC_GCODE)
        oracle_points, bad_points = calibrate_gcode.collect_points(path)
        # Only 2 lines qualify: "G1 X11 Y10 E0.5" (E + X/Y, S0) and
        # "G1 X12 Y11 E0.6" (E + X/Y, S0, following a no-XY retraction that
        # must be skipped). "G1 X10 Y10 Z0.2" (S0, positional, no E) and the
        # travel G0 (no E, and G0 not G1) are excluded -- and Z carries over
        # from the intervening "G0 ... Z5" travel move (not respecified by
        # the second qualifying line), which is why its z is 5.0, not 0.2:
        # gcode state tracks per-axis, not per-line.
        self.assertEqual(oracle_points, [(11.0, 10.0, 0.2), (12.0, 11.0, 5.0)])

    def test_bad_points_are_every_g1_line_whole_file_unscoped(self):
        path = self._write(SYNTHETIC_GCODE)
        oracle_points, bad_points = calibrate_gcode.collect_points(path)
        # Every G1 line counts (5 total: 3 in the S0 block -- the initial
        # no-E positional move, the qualifying E+XY move, and the
        # retraction-only E move -- plus 1 more in the S0 block after the
        # travel, plus 1 in the S1 block), G0 does not.
        self.assertEqual(len(bad_points), 5)
        # The retraction-only G1 (no X/Y) still logs a point at the
        # then-current position (20, 20, 5) -- "whole-file unfiltered"
        # includes non-positional G1 invocations too.
        self.assertIn((20.0, 20.0, 5.0), bad_points)
        # The S1-scoped point is included in bad (unscoped) but was excluded
        # from oracle above.
        self.assertIn((50.0, 50.0, 0.2), bad_points)

    def test_gzip_gcode_supported(self):
        gz_path = os.path.join(self.tmpdir, "t.gcode.gz")
        with gzip.open(gz_path, "wt", encoding="utf-8") as f:
            f.write(SYNTHETIC_GCODE)
        oracle_points, _ = calibrate_gcode.collect_points(gz_path)
        self.assertEqual(oracle_points, [(11.0, 10.0, 0.2), (12.0, 11.0, 5.0)])

    def test_decimal_comma_tokens_convert(self):
        # Ruling: "decimal commas in the file must be converted". This
        # fixture's real file has none, but the parser must tolerate them.
        text = "M486 S0\nG1 X1,5 Y2,5 Z0,2 E0,3\n"
        path = self._write(text)
        oracle_points, _ = calibrate_gcode.collect_points(path)
        self.assertEqual(oracle_points, [(1.5, 2.5, 0.2)])

    def test_no_oracle_points_returns_empty_list(self):
        path = self._write("G28\nG1 X1 Y1 E1\n")  # never enters an S0 scope
        oracle_points, bad_points = calibrate_gcode.collect_points(path)
        self.assertEqual(oracle_points, [])
        self.assertEqual(bad_points, [(1.0, 1.0, 0.0)])


# --------------------------------------------------------------------------
# rewrite_spec: artifact/seam retarget
# --------------------------------------------------------------------------

class TestRewriteSpec(unittest.TestCase):
    def _old_shape_spec(self):
        """A spec in the ORIGINAL (pre-Task-3) shape: s4 targets a separate
        'clusters' artifact. rewrite_spec must fix this up regardless of
        which shape it's handed (old or already-migrated)."""
        return {
            "seamSpecVersion": 1,
            "task": "gcode-to-text-gate",
            "artifacts": {
                "points": "/app/.seam/points.txt",
                "projection": "/app/.seam/projected.txt",
                "clusters": "/app/.seam/clusters.txt",
            },
            "provisional": ["s4"],
            "seams": [
                {"id": "s1", "artifact": "points", "predicate": {"op": "artifact_exists"}, "onFail": "x"},
                {
                    "id": "s4",
                    "artifact": "clusters",
                    "predicate": {"op": "cluster_count_in_range", "method": "conncomp2d", "cell": 0.5, "min": 10, "max": 40},
                    "onFail": "old onFail",
                },
            ],
        }

    def test_clusters_artifact_and_stray_seam_removed(self):
        spec = self._old_shape_spec()
        out = calibrate_gcode.rewrite_spec(spec, cell=0.4, lo=25, hi=38)
        self.assertNotIn("clusters", out["artifacts"])
        self.assertNotIn("clusters", {s.get("artifact") for s in out["seams"]})

    def test_s4_retargeted_to_projection_with_calibrated_predicate(self):
        spec = self._old_shape_spec()
        out = calibrate_gcode.rewrite_spec(spec, cell=0.4, lo=25, hi=38)
        s4 = find_seam(out, "s4")
        self.assertEqual(s4["artifact"], "projection")
        self.assertEqual(
            s4["predicate"],
            {"op": "cluster_count_in_range", "method": "conncomp2d", "cell": 0.4, "min": 25, "max": 38},
        )
        # onFail evidence text should reflect the new artifact, not the old one.
        self.assertIn("projected.txt", s4["onFail"])

    def test_provisional_left_untouched(self):
        spec = self._old_shape_spec()
        out = calibrate_gcode.rewrite_spec(spec, cell=0.4, lo=25, hi=38)
        self.assertIn("provisional", out)
        self.assertIn("s4", out["provisional"])

    def test_rewritten_spec_still_validates(self):
        spec = self._old_shape_spec()
        out = calibrate_gcode.rewrite_spec(spec, cell=0.4, lo=25, hi=38)
        self.assertEqual(check_spec(out), [])

    def test_idempotent_on_already_migrated_spec(self):
        spec = self._old_shape_spec()
        once = calibrate_gcode.rewrite_spec(spec, cell=0.4, lo=25, hi=38)
        twice = calibrate_gcode.rewrite_spec(once, cell=0.4, lo=25, hi=38)
        self.assertEqual(once, twice)

    def test_missing_s4_raises(self):
        spec = self._old_shape_spec()
        del spec["seams"][1]
        with self.assertRaises(RuntimeError):
            calibrate_gcode.rewrite_spec(spec, cell=0.4, lo=25, hi=38)

    def test_original_spec_object_not_mutated(self):
        # rewrite_spec must deep-copy, not mutate its argument in place.
        spec = self._old_shape_spec()
        before = json.dumps(spec, sort_keys=True)
        calibrate_gcode.rewrite_spec(spec, cell=0.4, lo=25, hi=38)
        self.assertEqual(json.dumps(spec, sort_keys=True), before)


# --------------------------------------------------------------------------
# extract_cluster_predicate
# --------------------------------------------------------------------------

class TestExtractClusterPredicate(unittest.TestCase):
    def test_reads_existing_s4_predicate(self):
        spec = load_reference_spec()
        cell, lo, hi = calibrate_gcode.extract_cluster_predicate(spec)
        s4 = find_seam(spec, "s4")
        self.assertEqual(cell, s4["predicate"]["cell"])
        self.assertEqual(lo, s4["predicate"]["min"])
        self.assertEqual(hi, s4["predicate"]["max"])

    def test_falls_back_when_no_s4(self):
        spec = {"seams": []}
        cell, lo, hi = calibrate_gcode.extract_cluster_predicate(spec)
        self.assertEqual((cell, lo, hi), (0.5, 10, 40))


# --------------------------------------------------------------------------
# search_cell: primary + fallback paths (against synthetic projection
# artifacts, using validator's real op_cluster_count_in_range).
# --------------------------------------------------------------------------

class TestSearchCell(CalibrateTestCase):
    def _write_proj(self, rows):
        path = os.path.join(self.tmpdir, "projected.txt")
        with open(path, "w") as f:
            for u, v in rows:
                f.write(f"{u:.6f} {v:.6f}\n")
        return path

    def test_primary_path_picks_smallest_in_range_cell(self):
        # 30 well-separated clumps -> should land in [10,40] at multiple
        # candidate cells; the search must return the SMALLEST such cell.
        import random
        random.seed(42)
        rows = []
        for b in range(30):
            base_u = (b % 6) * 5.0
            base_v = (b // 6) * 5.0
            for _ in range(12):
                rows.append((base_u + random.uniform(0, 0.6), base_v + random.uniform(0, 0.6)))
        path = self._write_proj(rows)
        cell, count, results, is_fallback = calibrate_gcode.search_cell(path, np)
        self.assertFalse(is_fallback)
        self.assertIn(cell, calibrate_gcode.CELL_CANDIDATES)
        self.assertTrue(calibrate_gcode.TARGET_MIN <= count <= calibrate_gcode.TARGET_MAX)
        # Must be the smallest candidate (ascending order) that landed in range.
        for c, cnt in results:
            if c < cell:
                self.assertFalse(
                    cnt is not None and calibrate_gcode.TARGET_MIN <= cnt <= calibrate_gcode.TARGET_MAX,
                    f"a smaller cell {c} (count={cnt}) also landed in range but wasn't selected",
                )

    def test_fallback_path_when_nothing_in_range(self):
        # A single tight clump: at every candidate cell this rasterizes to
        # (at most) one connected component, never landing in [10,40], so
        # the search must fall back to "closest to TARGET_TRUTH" with a
        # floored bound.
        import random
        random.seed(7)
        rows = [(random.uniform(0, 0.2), random.uniform(0, 0.2)) for _ in range(20)]
        path = self._write_proj(rows)
        cell, count, results, is_fallback = calibrate_gcode.search_cell(path, np)
        self.assertTrue(is_fallback)
        self.assertIn(cell, calibrate_gcode.CELL_CANDIDATES)
        self.assertGreaterEqual(count, 0)


# --------------------------------------------------------------------------
# --help documents both required flags (controller ruling 2)
# --------------------------------------------------------------------------

class TestHelpText(unittest.TestCase):
    def test_help_documents_spec_and_check_only(self):
        code, out, err = run_calibrate_subprocess(["--help"])
        self.assertEqual(code, 0)
        self.assertIn("--spec", out)
        self.assertIn("--check-only", out)


# --------------------------------------------------------------------------
# End-to-end against the real tb2 fixture. SKIPS if that checkout is absent.
# --------------------------------------------------------------------------

class TestEndToEndRealFixture(CalibrateTestCase):
    def setUp(self):
        super().setUp()
        if not os.path.isfile(REAL_GCODE_GZ_PATH):
            self.skipTest(
                f"real gcode fixture not found at {REAL_GCODE_GZ_PATH} -- "
                "terminal-bench-2 checkout is not present on this host, "
                "skipping the end-to-end calibration test"
            )
        self.gcode_path = os.path.join(self.tmpdir, "text.gcode")
        with gzip.open(REAL_GCODE_GZ_PATH, "rb") as src, open(self.gcode_path, "wb") as dst:
            shutil.copyfileobj(src, dst)

    def _oracle_bad_sections(self, stdout):
        marker = "SEAM-GATE CALIBRATE: bad validator run:"
        self.assertIn(marker, stdout)
        oracle_section, bad_section = stdout.split(marker, 1)
        return oracle_section, bad_section

    def test_calibration_rewrites_spec_and_proves_oracle_bad_split(self):
        scratch_spec = self.write_scratch_spec(load_reference_spec())
        code, out, err = run_calibrate_subprocess([self.gcode_path, "--spec", scratch_spec])
        self.assertEqual(code, 0, f"expected calibration to succeed, stderr:\n{err}\nstdout:\n{out}")
        self.assertIn("SEAM-GATE CALIBRATE: OK", out)

        oracle_section, bad_section = self._oracle_bad_sections(out)
        self.assertNotIn(" FAIL ", oracle_section, f"oracle artifacts should pass every seam:\n{oracle_section}")
        bad_fail_count = bad_section.count(" FAIL ")
        self.assertGreaterEqual(bad_fail_count, 2, f"bad artifacts should fail >=2 seams:\n{bad_section}")
        # The brief calls out these two specifically.
        self.assertIn("SEAM s3 FAIL", bad_section)
        self.assertIn("SEAM s6 FAIL", bad_section)
        self.assertIn("SEAM s4 FAIL", bad_section)

        # Rewritten spec must still be a valid seam spec (spec_check.py is
        # the authoritative, dependency-free checker the real validator
        # runs -- see SPEC.md).
        with open(scratch_spec) as f:
            rewritten = json.load(f)
        self.assertEqual(check_spec(rewritten), [], "rewritten spec must validate")
        self.assertNotIn("clusters", rewritten["artifacts"])
        s4 = find_seam(rewritten, "s4")
        self.assertEqual(s4["artifact"], "projection")
        pred = s4["predicate"]
        self.assertIn(pred["cell"], calibrate_gcode.CELL_CANDIDATES)
        self.assertLess(pred["min"], pred["max"])

        # Best-effort cross-check against schema.json's JSON-Schema contract
        # (spec_check.check_spec above is the authoritative one that
        # actually runs in the gate; jsonschema is an optional extra
        # confirmation, not assumed installed everywhere).
        try:
            import jsonschema
        except ImportError:
            pass
        else:
            with open(os.path.join(_SEAM_GATE_DIR, "schema.json")) as f:
                schema = json.load(f)
            jsonschema.validate(rewritten, schema)

    def test_check_only_reproves_without_rewriting_spec(self):
        scratch_spec = self.write_scratch_spec(load_reference_spec())
        code, _, err = run_calibrate_subprocess([self.gcode_path, "--spec", scratch_spec])
        self.assertEqual(code, 0, err)
        with open(scratch_spec) as f:
            calibrated_bytes = f.read()

        code, out, err = run_calibrate_subprocess([self.gcode_path, "--spec", scratch_spec, "--check-only"])
        self.assertEqual(code, 0, f"check-only re-verification should succeed, stderr:\n{err}\nstdout:\n{out}")
        self.assertIn("SEAM-GATE CALIBRATE: OK", out)
        self.assertIn("--check-only", out)

        with open(scratch_spec) as f:
            after_bytes = f.read()
        self.assertEqual(calibrated_bytes, after_bytes, "--check-only must not modify --spec on disk")

    def test_committed_reference_spec_already_calibrated_and_reproved(self):
        # The repo's own specs/gcode-to-text-gate.json was calibrated by
        # this same harness (Task 3's authoritative run) and committed
        # as-is. Re-verify it in --check-only mode directly (no scratch
        # copy) so this test also catches drift between the committed spec
        # and what a fresh calibration run against the real fixture proves.
        code, out, err = run_calibrate_subprocess([self.gcode_path, "--spec", REFERENCE_SPEC_PATH, "--check-only"])
        self.assertEqual(code, 0, f"committed reference spec should still re-prove clean, stderr:\n{err}\nstdout:\n{out}")
        self.assertIn("SEAM-GATE CALIBRATE: OK", out)


if __name__ == "__main__":
    unittest.main()
