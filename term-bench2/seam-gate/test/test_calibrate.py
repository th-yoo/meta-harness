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
        """A spec in the pre-calibration shape (Task 7 id-only artifactIds):
        s4 targets a separate 'clusters' artifact id. rewrite_spec must fix
        this up regardless of whether s4 already points at 'projected' or
        still at 'clusters' -- see test_idempotent_on_already_migrated_spec.

        Migration note (Task 7 item 1): this fixture used to carry a
        top-level "artifacts" id->path dict (e.g.
        {"points": "/app/.seam/points.txt", ...}); that shape is gone
        entirely (structural id-join -- see spec_check.py/SPEC.md). Updated
        to the id-only "artifactIds" list shape, and the "projection" id
        renamed to "projected" (matching the file rewrite_spec's onFail text
        already referenced, "projected.txt", and the convention id ->
        "<root>/.seam/<id>.txt" now enforces literally).
        """
        return {
            "seamSpecVersion": 1,
            "task": "gcode-to-text-gate",
            "artifactIds": ["points", "projected", "clusters"],
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
        self.assertNotIn("clusters", out["artifactIds"])
        self.assertNotIn("clusters", {s.get("artifact") for s in out["seams"]})

    def test_s4_retargeted_to_projected_with_calibrated_predicate(self):
        spec = self._old_shape_spec()
        out = calibrate_gcode.rewrite_spec(spec, cell=0.4, lo=25, hi=38)
        s4 = find_seam(out, "s4")
        self.assertEqual(s4["artifact"], "projected")
        self.assertEqual(
            s4["predicate"],
            {"op": "cluster_count_in_range", "method": "conncomp2d", "cell": 0.4, "min": 25, "max": 38},
        )
        # onFail evidence text should reflect the new artifact, not the old one.
        self.assertIn("projected.txt", s4["onFail"])

    def test_provisional_key_dropped_when_s4_was_the_only_entry(self):
        # Fix-round ruling (task-3-review.md LOW-1): once s4's bounds are the
        # measured calibrated numbers, they're no longer placeholders, so the
        # top-level `provisional` key -- whose documented meaning is exactly
        # "placeholder bounds pending calibration" -- is stripped entirely
        # when calibration empties it. `provisional` remains an OPTIONAL key
        # in the *format* (schema.json / spec_check.py accept a spec with or
        # without it); only this now-calibrated spec instance drops it.
        spec = self._old_shape_spec()
        out = calibrate_gcode.rewrite_spec(spec, cell=0.4, lo=25, hi=38)
        self.assertNotIn("provisional", out)
        self.assertEqual(check_spec(out), [])

    def test_provisional_key_kept_with_other_entries_when_not_only_s4(self):
        # If some OTHER seam is also listed provisional, only "s4" is
        # stripped out of the list -- the key/list survives for the rest.
        spec = self._old_shape_spec()
        spec["provisional"] = ["s4", "s1"]
        out = calibrate_gcode.rewrite_spec(spec, cell=0.4, lo=25, hi=38)
        self.assertEqual(out["provisional"], ["s1"])

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
        # Task 7 item 2: --emit-evidence is a third documented mode.
        self.assertIn("--emit-evidence", out)


# --------------------------------------------------------------------------
# --emit-evidence (Task 7 item 2): pure-logic tests against the small
# synthetic fixture -- never skip, no real checkout needed. The exact
# measured numbers against the real fixture are covered by
# TestEndToEndRealFixture below (skips if that checkout is absent).
# --------------------------------------------------------------------------

class TestEmitEvidence(unittest.TestCase):
    def test_variance_ratio_component_flat_cloud_near_zero(self):
        points = [(x, y, 0.0) for x in range(20) for y in range(20)]
        ratio = calibrate_gcode.variance_ratio_component(points, 2, np)
        self.assertLess(ratio, 1e-9)

    def test_variance_ratio_component_out_of_range_component_is_nan(self):
        points = [(x, y) for x in range(5) for y in range(5)]  # only 2 columns
        ratio = calibrate_gcode.variance_ratio_component(points, 2, np)
        self.assertTrue(np.isnan(ratio))

    def test_column_spreads_matches_manual_std(self):
        points = [(0.0, 0.0), (1.0, 10.0), (2.0, 20.0)]
        spreads = calibrate_gcode.column_spreads(points, np)
        self.assertEqual(len(spreads), 2)
        self.assertAlmostEqual(spreads[0], float(np.std([0.0, 1.0, 2.0])))
        self.assertAlmostEqual(spreads[1], float(np.std([0.0, 10.0, 20.0])))

    def test_column_spreads_empty_input_returns_empty_list(self):
        self.assertEqual(calibrate_gcode.column_spreads([], np), [])

    def test_cluster_count_sweep_covers_every_candidate_cell(self):
        rows = [(b * 5.0 + i * 0.1, i * 0.1) for b in range(15) for i in range(6)]
        results = calibrate_gcode.cluster_count_sweep(rows, np)
        self.assertEqual([c for c, _ in results], calibrate_gcode.CELL_CANDIDATES)

    def test_emit_evidence_block_contains_every_required_section(self):
        path = os.path.join(tempfile.mkdtemp(prefix="seam-gate-evidence-test-"), "t.gcode")
        with open(path, "w") as f:
            f.write(SYNTHETIC_GCODE)
        oracle_points, bad_points = calibrate_gcode.collect_points(path)
        oracle_proj = calibrate_gcode.svd_plane_project(oracle_points, np)
        oracle_ratio = calibrate_gcode.affine_residual_ratio(oracle_points, np)
        block = calibrate_gcode.emit_evidence_block(path, oracle_points, bad_points, oracle_proj, oracle_ratio, np)
        self.assertIn("row_count:", block)
        self.assertIn("affine_residual_ratio", block)
        self.assertIn("variance_ratio", block)
        self.assertIn("spread (points", block)
        self.assertIn("spread (projected", block)
        self.assertIn("cluster_count_vs_cell", block)
        for cell in calibrate_gcode.CELL_CANDIDATES:
            self.assertIn(f"cell={cell} ->", block)

    def test_cli_emit_evidence_mode_never_touches_spec(self):
        path = os.path.join(tempfile.mkdtemp(prefix="seam-gate-evidence-cli-test-"), "t.gcode")
        with open(path, "w") as f:
            f.write(SYNTHETIC_GCODE)
        # A --spec pointing at a nonexistent path -- if --emit-evidence
        # touched it, this would fail with a file-not-found error.
        code, out, err = run_calibrate_subprocess(
            [path, "--emit-evidence", "--spec", "/nonexistent/does-not-matter.json"]
        )
        self.assertEqual(code, 0, f"stdout:\n{out}\nstderr:\n{err}")
        self.assertIn("SEAM-GATE EVIDENCE", out)


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
        # Task 7 item 4: s7 (source_crosscheck) must also fail on the bad
        # set -- bad's points.txt is the whole-file unscoped G1 set, so its
        # sampled rows don't match the S0-scoped source at the same indices.
        self.assertIn("SEAM s7 FAIL", bad_section)

        # Rewritten spec must still be a valid seam spec (spec_check.py is
        # the authoritative, dependency-free checker the real validator
        # runs -- see SPEC.md).
        with open(scratch_spec) as f:
            rewritten = json.load(f)
        self.assertEqual(check_spec(rewritten), [], "rewritten spec must validate")
        self.assertNotIn("clusters", rewritten["artifactIds"])
        s4 = find_seam(rewritten, "s4")
        self.assertEqual(s4["artifact"], "projected")
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

    def test_emit_evidence_against_real_fixture_matches_measured_numbers(self):
        # Task 7 item 2, end-to-end: --emit-evidence's cluster-count sweep and
        # row counts against the REAL fixture, pinned to the exact numbers
        # measured during Task 7 (also recorded in the join-probe verdict,
        # docs/loop-probes/census-e2e-20260819/gcode-card/verdict.md,
        # "Consequences" item 2): 0.3->57, 0.4->30, 0.5->29, 0.8->23, 1.0->11
        # components; 38972 scoped / 60761 whole-file rows.
        code, out, err = run_calibrate_subprocess([self.gcode_path, "--emit-evidence"])
        self.assertEqual(code, 0, f"stderr:\n{err}\nstdout:\n{out}")
        self.assertIn("row_count: scoped(S0-extruding, oracle)=38972 whole_file(G1, unscoped)=60761", out)
        self.assertIn("cell=0.3 -> 57 components", out)
        self.assertIn("cell=0.4 -> 30 components", out)
        self.assertIn("cell=0.5 -> 29 components", out)
        self.assertIn("cell=0.8 -> 23 components", out)
        self.assertIn("cell=1.0 -> 11 components", out)

    def test_literal_brief_bad_shape_fails_overall_but_coincidentally_passes_s4(self):
        # Fix-round finding (task-3-review.md MEDIUM): the brief's own
        # one-sentence description of the BAD artifact set is a single
        # coherent pipeline run -- whole-file unfiltered points, AND a
        # raw-XY "projection" of THAT SAME unfiltered set (u=X, v=Y, no
        # plane fit) -- not the hybrid this harness actually builds
        # (points.txt from the unfiltered set, projected.txt's raw-XY from
        # the correctly-scoped oracle set instead; see calibrate_gcode.py's
        # inline comment by `bad_proj` for why). The review independently
        # measured that this literal shape still fails overall (>=2 seams,
        # via s1/s3/s6) but *coincidentally PASSES* s4 -- 27 components at
        # cell=0.4 lands inside the calibrated [25,38] band, purely because
        # the travel-inflated whole-file cloud's raw x,y happens to
        # rasterize into a plausible-looking count on this fixture. That
        # finding was previously only recorded in report prose; this test
        # pins it in code so a future bounds/parsing change that breaks the
        # coincidence shows up as a test delta, not silence.
        #
        # This is exactly why the harness deliberately builds the committed
        # hybrid bad set instead of the literal one (it reliably fails s4
        # too, not just coincidentally) -- but the point stands either way:
        # individual seams are coincidence-spoofable; discrimination lives
        # in the seam stack, not any single seam. The row-count/affine/
        # variance seams over points.txt alone already clear the >=2-seam
        # bar for this literal shape, with or without s4's help.
        scratch_spec = self.write_scratch_spec(load_reference_spec())
        code, _, err = run_calibrate_subprocess([self.gcode_path, "--spec", scratch_spec])
        self.assertEqual(code, 0, f"pre-calibration step failed, stderr:\n{err}")
        with open(scratch_spec) as f:
            calibrated_spec = json.load(f)
        cell, lo, hi = calibrate_gcode.extract_cluster_predicate(calibrated_spec)

        _, whole_file_points = calibrate_gcode.collect_points(self.gcode_path)
        literal_bad_proj = np.array([[p[0], p[1]] for p in whole_file_points], dtype=float)
        literal_bad_ratio = calibrate_gcode.affine_residual_ratio(whole_file_points, np)
        cluster_rows = calibrate_gcode.compute_cluster_rows(literal_bad_proj, cell, np)

        literal_bad_root = os.path.join(self.tmpdir, "literal_bad_root")
        calibrate_gcode.write_artifact_set(
            literal_bad_root, whole_file_points, literal_bad_proj, literal_bad_ratio, cluster_rows
        )

        code, lines, fails = calibrate_gcode.run_validator(scratch_spec, literal_bad_root)
        fail_ids = {l.split()[1] for l in fails}
        pass_ids = {l.split()[1] for l in lines if " PASS " in l}

        # (a) overall exit 1, >=2 seams failing, naming s1 and s3 among them.
        self.assertEqual(code, 1, f"literal bad shape should still fail overall:\n" + "\n".join(lines))
        self.assertGreaterEqual(len(fail_ids), 2, f"expected >=2 failing seams:\n" + "\n".join(lines))
        self.assertIn("s1", fail_ids, "row_count_in_range should fail (whole-file row count)")
        self.assertIn("s3", fail_ids, "affine_residual_below should fail (travel off the plane)")

        # (b) s4 EXPLICITLY passes here -- the pinned coincidence. If a
        # future recalibration or parsing change makes s4 start failing
        # this literal shape too, that's fine (arguably an improvement) --
        # but it must show up as a failure of THIS assertion, not silently.
        self.assertIn(
            "s4", pass_ids,
            "s4 was measured to COINCIDENTALLY PASS on the literal brief-shape "
            "bad artifact (27 components landed inside the calibrated range by "
            "chance, not by design) -- individual seams are coincidence-"
            "spoofable, discrimination lives in the seam stack. If this now "
            "fails, the coincidence broke (interesting!) -- update this "
            "assertion deliberately, don't just delete it.",
        )
        s4_line = next(l for l in lines if l.split()[1] == "s4")
        self.assertIn("PASS", s4_line, f"expected s4 to PASS, got: {s4_line}")


if __name__ == "__main__":
    unittest.main()
