"""Tests for term-bench2/seam-gate/validator.py (plain unittest, no pytest).

Run with:
    python3 -m unittest discover -s term-bench2/seam-gate/test -p 'test_*.py'

Task 7 migration note: this file was rewritten wholesale for the structural
id-join fix (item 1). The spec format's top-level "artifacts" id->path map is
gone -- specs now carry a flat "artifactIds" list of bare ids, and
validator.py resolves each id to "<root>/.seam/<id>.txt" by convention (see
validator.resolve_artifact_id). Every test helper (`minimal_spec`,
`write_artifact`, `write_binary_artifact`) and every call site that used to
pass a spec-style path (e.g. "/app/.seam/artifact.txt") now passes a bare
artifact id (e.g. "artifact") instead -- same assertions, new invocation
shape. `TestResolveArtifactPath` (which exercised the deleted
`resolve_artifact_path` path-heuristic function) is replaced by
`TestResolveArtifactId` (exercises the new id-convention resolver). New
`TestSourceCrosscheck` class covers Task 7 item 4's `source_crosscheck` op.
"""

import contextlib
import io
import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
import unittest

# validator.py / spec_check.py live one directory up from this test file.
# unittest discover does not automatically put that directory on sys.path.
_SEAM_GATE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _SEAM_GATE_DIR not in sys.path:
    sys.path.insert(0, _SEAM_GATE_DIR)

import validator  # noqa: E402
import readers  # noqa: E402

VALIDATOR_PATH = os.path.join(_SEAM_GATE_DIR, "validator.py")
REFERENCE_SPEC_PATH = os.path.join(_SEAM_GATE_DIR, "specs", "gcode-to-text-gate.json")


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

def run_validator_inprocess(spec_path, root, extra_args=None):
    """Call validator.main() in-process, capturing stdout.

    Returns (exit_code, stdout_text). Used for the majority of tests since it's
    fast and gives direct access to the return code without shelling out.
    """
    argv = ["--spec", spec_path, "--root", root] + (extra_args or [])
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = validator.main(argv)
    return code, buf.getvalue()


def run_validator_subprocess(spec_path, root, extra_args=None, extra_env=None):
    """Shell out to `python3 validator.py ...` for true end-to-end exit-code
    checks (proves sys.exit(main(...)) actually wires the return value to the
    OS-level process exit code, not just the Python function return value).
    """
    cmd = [sys.executable, VALIDATOR_PATH, "--spec", spec_path, "--root", root] + (extra_args or [])
    env = dict(os.environ)
    if extra_env:
        env.update(extra_env)
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=_SEAM_GATE_DIR, env=env)
    return proc.returncode, proc.stdout, proc.stderr


def run_validator_argv_subprocess(argv, extra_env=None):
    """Like run_validator_subprocess, but for raw argv (e.g. missing/unknown
    flags) rather than a well-formed --spec/--root pair.
    """
    cmd = [sys.executable, VALIDATOR_PATH] + argv
    env = dict(os.environ)
    if extra_env:
        env.update(extra_env)
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=_SEAM_GATE_DIR, env=env)
    return proc.returncode, proc.stdout, proc.stderr


@contextlib.contextmanager
def env_var(key, value):
    """Temporarily set (or, if value is None, unset) an environment variable
    for the duration of the block, restoring the prior state afterward.
    """
    had_old = key in os.environ
    old = os.environ.get(key)
    if value is None:
        os.environ.pop(key, None)
    else:
        os.environ[key] = value
    try:
        yield
    finally:
        if had_old:
            os.environ[key] = old
        else:
            os.environ.pop(key, None)


def write_binary_artifact(root, artifact_id, data):
    """Like write_artifact, but writes raw (possibly non-UTF-8) bytes."""
    full = validator.resolve_artifact_id(artifact_id, root)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "wb") as f:
        f.write(data)
    return full


def write_spec(tmpdir, spec_dict, name="spec.json"):
    path = os.path.join(tmpdir, name)
    with open(path, "w") as f:
        json.dump(spec_dict, f)
    return path


def write_artifact(root, artifact_id, lines):
    """artifact_id is a bare id like 'artifact'; resolved via the same
    convention validator.py itself uses (<root>/.seam/<id>.txt), so tests
    exercise the real resolution logic rather than a parallel implementation
    of it.
    """
    full = validator.resolve_artifact_id(artifact_id, root)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w") as f:
        f.write("\n".join(lines))
        if lines:
            f.write("\n")
    return full


def minimal_spec(predicate, artifact_id="a1", seam_id="s1", on_fail="test onFail"):
    return {
        "seamSpecVersion": 1,
        "task": "test-task",
        "artifactIds": [artifact_id],
        "seams": [
            {"id": seam_id, "artifact": artifact_id, "predicate": predicate, "onFail": on_fail},
        ],
    }


def rows_to_lines(rows, sep=" "):
    return [sep.join(str(v) for v in row) for row in rows]


ARTIFACT_ID = "artifact"


class ValidatorTestCase(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="seam-gate-test-")
        random.seed(0)

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def assertSeamLine(self, stdout, seam_id, status):
        self.assertIn(f"SEAM {seam_id} {status}", stdout, f"stdout was:\n{stdout}")


# --------------------------------------------------------------------------
# Artifact id resolution
# --------------------------------------------------------------------------

class TestResolveArtifactId(unittest.TestCase):
    def test_resolves_under_seam_dir(self):
        self.assertEqual(
            validator.resolve_artifact_id("points", "/tmp/root"),
            os.path.join("/tmp/root", ".seam", "points.txt"),
        )

    def test_in_container_root(self):
        # In-container usage: --root /app.
        self.assertEqual(
            validator.resolve_artifact_id("points", "/app"),
            "/app/.seam/points.txt",
        )

    def test_different_ids_resolve_to_different_files(self):
        self.assertNotEqual(
            validator.resolve_artifact_id("points", "/app"),
            validator.resolve_artifact_id("projected", "/app"),
        )


# --------------------------------------------------------------------------
# artifact_exists
# --------------------------------------------------------------------------

class TestArtifactExists(ValidatorTestCase):
    def test_pass_when_file_present_and_nonempty(self):
        write_artifact(self.tmpdir, ARTIFACT_ID, ["1 2 3"])
        spec = minimal_spec({"op": "artifact_exists"}, artifact_id=ARTIFACT_ID)
        spec_path = write_spec(self.tmpdir, spec)
        code, out = run_validator_inprocess(spec_path, self.tmpdir)
        self.assertEqual(code, 0)
        self.assertSeamLine(out, "s1", "PASS")

    def test_fail_when_file_missing(self):
        spec = minimal_spec({"op": "artifact_exists"}, artifact_id=ARTIFACT_ID)
        spec_path = write_spec(self.tmpdir, spec)
        code, out = run_validator_inprocess(spec_path, self.tmpdir)
        self.assertEqual(code, 1)
        self.assertSeamLine(out, "s1", "FAIL")
        self.assertIn("not found", out)


# --------------------------------------------------------------------------
# row_count_in_range
# --------------------------------------------------------------------------

class TestRowCountInRange(ValidatorTestCase):
    def test_pass_when_count_in_range(self):
        lines = [f"{i} {i*2}" for i in range(100)]
        write_artifact(self.tmpdir, ARTIFACT_ID, lines)
        spec = minimal_spec({"op": "row_count_in_range", "min": 50, "max": 150}, artifact_id=ARTIFACT_ID)
        spec_path = write_spec(self.tmpdir, spec)
        code, out = run_validator_inprocess(spec_path, self.tmpdir)
        self.assertEqual(code, 0)
        self.assertSeamLine(out, "s1", "PASS")

    def test_fail_when_count_out_of_range(self):
        lines = [f"{i} {i*2}" for i in range(10)]
        write_artifact(self.tmpdir, ARTIFACT_ID, lines)
        spec = minimal_spec({"op": "row_count_in_range", "min": 50, "max": 150}, artifact_id=ARTIFACT_ID)
        spec_path = write_spec(self.tmpdir, spec)
        code, out = run_validator_inprocess(spec_path, self.tmpdir)
        self.assertEqual(code, 1)
        self.assertSeamLine(out, "s1", "FAIL")

    def test_non_numeric_lines_skipped(self):
        lines = ["# comment", "not a number", "1 2", "3 4"]
        write_artifact(self.tmpdir, ARTIFACT_ID, lines)
        spec = minimal_spec({"op": "row_count_in_range", "min": 2, "max": 2}, artifact_id=ARTIFACT_ID)
        spec_path = write_spec(self.tmpdir, spec)
        code, out = run_validator_inprocess(spec_path, self.tmpdir)
        self.assertEqual(code, 0)
        self.assertSeamLine(out, "s1", "PASS")


# --------------------------------------------------------------------------
# numeric_cols
# --------------------------------------------------------------------------

class TestNumericCols(ValidatorTestCase):
    def test_pass_when_every_row_has_n_cols(self):
        lines = [f"{i} {i} {i}" for i in range(20)]
        write_artifact(self.tmpdir, ARTIFACT_ID, lines)
        spec = minimal_spec({"op": "numeric_cols", "n": 3}, artifact_id=ARTIFACT_ID)
        spec_path = write_spec(self.tmpdir, spec)
        code, out = run_validator_inprocess(spec_path, self.tmpdir)
        self.assertEqual(code, 0)
        self.assertSeamLine(out, "s1", "PASS")

    def test_fail_when_a_row_has_wrong_col_count(self):
        lines = [f"{i} {i} {i}" for i in range(20)]
        lines[5] = "1 2"  # only 2 columns
        write_artifact(self.tmpdir, ARTIFACT_ID, lines)
        spec = minimal_spec({"op": "numeric_cols", "n": 3}, artifact_id=ARTIFACT_ID)
        spec_path = write_spec(self.tmpdir, spec)
        code, out = run_validator_inprocess(spec_path, self.tmpdir)
        self.assertEqual(code, 1)
        self.assertSeamLine(out, "s1", "FAIL")
        self.assertIn("row 5", out)

    # comma-separated is also valid per SPEC.md ("whitespace- or comma-separated")
    def test_comma_separated_rows_parse(self):
        lines = ["1,2,3", "4, 5, 6"]
        write_artifact(self.tmpdir, ARTIFACT_ID, lines)
        spec = minimal_spec({"op": "numeric_cols", "n": 3}, artifact_id=ARTIFACT_ID)
        spec_path = write_spec(self.tmpdir, spec)
        code, out = run_validator_inprocess(spec_path, self.tmpdir)
        self.assertEqual(code, 0)
        self.assertSeamLine(out, "s1", "PASS")


# --------------------------------------------------------------------------
# affine_residual_below -- includes the required planar-vs-spherical case
# --------------------------------------------------------------------------

class TestAffineResidualBelow(ValidatorTestCase):
    def _planar_rows(self, n=500):
        rows = []
        for _ in range(n):
            x = random.uniform(-5, 5)
            y = random.uniform(-5, 5)
            z = 2 * x - y + 3  # exact plane, no noise
            rows.append((x, y, z))
        return rows

    def _spherical_rows(self, n=500, r=10.0):
        rows = []
        for _ in range(n):
            x = random.uniform(-5, 5)
            y = random.uniform(-5, 5)
            z = (r ** 2 - x ** 2 - y ** 2) ** 0.5  # hemisphere: not a plane
            rows.append((x, y, z))
        return rows

    def test_planar_cloud_passes(self):
        write_artifact(self.tmpdir, ARTIFACT_ID, rows_to_lines(self._planar_rows()))
        spec = minimal_spec(
            {"op": "affine_residual_below", "cols": [0, 1, 2], "max_ratio": 0.02},
            artifact_id=ARTIFACT_ID,
        )
        spec_path = write_spec(self.tmpdir, spec)
        code, out = run_validator_inprocess(spec_path, self.tmpdir)
        self.assertEqual(code, 0)
        self.assertSeamLine(out, "s1", "PASS")

    def test_spherical_cloud_fails(self):
        write_artifact(self.tmpdir, ARTIFACT_ID, rows_to_lines(self._spherical_rows()))
        spec = minimal_spec(
            {"op": "affine_residual_below", "cols": [0, 1, 2], "max_ratio": 0.02},
            artifact_id=ARTIFACT_ID,
        )
        spec_path = write_spec(self.tmpdir, spec)
        code, out = run_validator_inprocess(spec_path, self.tmpdir)
        self.assertEqual(code, 1)
        self.assertSeamLine(out, "s1", "FAIL")


# --------------------------------------------------------------------------
# variance_ratio_below
# --------------------------------------------------------------------------

class TestVarianceRatioBelow(ValidatorTestCase):
    def test_flat_cloud_passes(self):
        rows = []
        for _ in range(500):
            x = random.uniform(-5, 5)
            y = random.uniform(-5, 5)
            z = 0.0  # perfectly flat: no 3rd-component variance at all
            rows.append((x, y, z))
        write_artifact(self.tmpdir, ARTIFACT_ID, rows_to_lines(rows))
        spec = minimal_spec({"op": "variance_ratio_below", "component": 2, "max": 0.01}, artifact_id=ARTIFACT_ID)
        spec_path = write_spec(self.tmpdir, spec)
        code, out = run_validator_inprocess(spec_path, self.tmpdir)
        self.assertEqual(code, 0)
        self.assertSeamLine(out, "s1", "PASS")

    def test_cloud_with_real_third_dimension_spread_fails(self):
        rows = []
        for _ in range(500):
            x = random.uniform(-5, 5)
            y = random.uniform(-5, 5)
            z = random.uniform(-5, 5)  # genuine 3D spread, isotropic
            rows.append((x, y, z))
        write_artifact(self.tmpdir, ARTIFACT_ID, rows_to_lines(rows))
        spec = minimal_spec({"op": "variance_ratio_below", "component": 2, "max": 0.01}, artifact_id=ARTIFACT_ID)
        spec_path = write_spec(self.tmpdir, spec)
        code, out = run_validator_inprocess(spec_path, self.tmpdir)
        self.assertEqual(code, 1)
        self.assertSeamLine(out, "s1", "FAIL")


# --------------------------------------------------------------------------
# spread_above
# --------------------------------------------------------------------------

class TestSpreadAbove(ValidatorTestCase):
    def test_pass_when_column_has_spread(self):
        rows = [(i, random.uniform(-50, 50)) for i in range(500)]
        write_artifact(self.tmpdir, ARTIFACT_ID, rows_to_lines(rows))
        spec = minimal_spec({"op": "spread_above", "col": 1, "min_std": 1.0}, artifact_id=ARTIFACT_ID)
        spec_path = write_spec(self.tmpdir, spec)
        code, out = run_validator_inprocess(spec_path, self.tmpdir)
        self.assertEqual(code, 0)
        self.assertSeamLine(out, "s1", "PASS")

    def test_fail_when_column_is_degenerate(self):
        rows = [(i, 7.0) for i in range(500)]  # column 1 is constant
        write_artifact(self.tmpdir, ARTIFACT_ID, rows_to_lines(rows))
        spec = minimal_spec({"op": "spread_above", "col": 1, "min_std": 1.0}, artifact_id=ARTIFACT_ID)
        spec_path = write_spec(self.tmpdir, spec)
        code, out = run_validator_inprocess(spec_path, self.tmpdir)
        self.assertEqual(code, 1)
        self.assertSeamLine(out, "s1", "FAIL")


# --------------------------------------------------------------------------
# cluster_count_in_range (conncomp2d)
# --------------------------------------------------------------------------

class TestClusterCountInRange(ValidatorTestCase):
    def _blobs(self, n_blobs, spacing=5.0, spread=1.4, per_blob=8):
        rows = []
        for b in range(n_blobs):
            base_x = b * spacing
            for _ in range(per_blob):
                x = base_x + random.uniform(0, spread)
                y = random.uniform(0, spread)
                rows.append((x, y))
        return rows

    def test_pass_when_component_count_in_range(self):
        rows = self._blobs(20)
        write_artifact(self.tmpdir, ARTIFACT_ID, rows_to_lines(rows))
        spec = minimal_spec(
            {"op": "cluster_count_in_range", "method": "conncomp2d", "cell": 0.5, "min": 10, "max": 40},
            artifact_id=ARTIFACT_ID,
        )
        spec_path = write_spec(self.tmpdir, spec)
        code, out = run_validator_inprocess(spec_path, self.tmpdir)
        self.assertEqual(code, 0)
        self.assertSeamLine(out, "s1", "PASS")
        self.assertIn("20 components", out)

    def test_fail_when_all_points_merge_into_one_component(self):
        # Same points but rasterized at a huge cell size -- everything falls
        # into one occupied grid cell/component, well outside [10,40].
        rows = self._blobs(20)
        write_artifact(self.tmpdir, ARTIFACT_ID, rows_to_lines(rows))
        spec = minimal_spec(
            {"op": "cluster_count_in_range", "method": "conncomp2d", "cell": 1000.0, "min": 10, "max": 40},
            artifact_id=ARTIFACT_ID,
        )
        spec_path = write_spec(self.tmpdir, spec)
        code, out = run_validator_inprocess(spec_path, self.tmpdir)
        self.assertEqual(code, 1)
        self.assertSeamLine(out, "s1", "FAIL")

    def test_singleton_pixels_below_min_floor_are_discarded(self):
        # Each point isolated (spacing > cell, one point per blob, well
        # within the grid-size cap) -> every component is exactly 1 pixel,
        # below the min-floor of 3 -> 0 counted.
        rows = [(b * 2.0, 0.0) for b in range(20)]
        write_artifact(self.tmpdir, ARTIFACT_ID, rows_to_lines(rows))
        spec = minimal_spec(
            {"op": "cluster_count_in_range", "method": "conncomp2d", "cell": 0.5, "min": 1, "max": 40},
            artifact_id=ARTIFACT_ID,
        )
        spec_path = write_spec(self.tmpdir, spec)
        code, out = run_validator_inprocess(spec_path, self.tmpdir)
        self.assertEqual(code, 1)
        self.assertIn("0 components", out)

    def test_pathological_coordinate_range_fails_predicate_not_oom(self):
        # LOW-5: a huge coordinate range combined with a small cell size
        # would otherwise size an unbounded rasterization grid (memory bound
        # is agent-controllable). Two points ~1,000,000 units apart at
        # cell=0.001 would need a ~1e9-cell grid; the cap must turn this into
        # a normal predicate FAIL, not a MemoryError/OOM.
        rows = [(0.0, 0.0), (1_000_000.0, 0.0)]
        write_artifact(self.tmpdir, ARTIFACT_ID, rows_to_lines(rows))
        spec = minimal_spec(
            {"op": "cluster_count_in_range", "method": "conncomp2d", "cell": 0.001, "min": 1, "max": 40},
            artifact_id=ARTIFACT_ID,
        )
        spec_path = write_spec(self.tmpdir, spec)
        code, out = run_validator_inprocess(spec_path, self.tmpdir)
        self.assertEqual(code, 1)
        self.assertSeamLine(out, "s1", "FAIL")
        self.assertIn("exceeds grid bounds", out)


# --------------------------------------------------------------------------
# value_in_range
# --------------------------------------------------------------------------

class TestValueInRange(ValidatorTestCase):
    def test_pass_when_value_in_range(self):
        write_artifact(self.tmpdir, ARTIFACT_ID, ["0.97"])
        spec = minimal_spec({"op": "value_in_range", "row": 0, "col": 0, "min": 0.9, "max": 1.0}, artifact_id=ARTIFACT_ID)
        spec_path = write_spec(self.tmpdir, spec)
        code, out = run_validator_inprocess(spec_path, self.tmpdir)
        self.assertEqual(code, 0)
        self.assertSeamLine(out, "s1", "PASS")

    def test_fail_when_value_out_of_range(self):
        write_artifact(self.tmpdir, ARTIFACT_ID, ["0.5"])
        spec = minimal_spec({"op": "value_in_range", "row": 0, "col": 0, "min": 0.9, "max": 1.0}, artifact_id=ARTIFACT_ID)
        spec_path = write_spec(self.tmpdir, spec)
        code, out = run_validator_inprocess(spec_path, self.tmpdir)
        self.assertEqual(code, 1)
        self.assertSeamLine(out, "s1", "FAIL")


# --------------------------------------------------------------------------
# source_crosscheck (Task 7 item 4)
# --------------------------------------------------------------------------

# A small synthetic gcode fixture: 6 S0-scoped extruding G1 points, in order.
_SOURCE_GCODE = """\
M486 S0
G1 X0 Y0 Z0.2 E0.1
G1 X1 Y0 Z0.2 E0.1
G1 X2 Y0 Z0.2 E0.1
G1 X3 Y0 Z0.2 E0.1
G1 X4 Y0 Z0.2 E0.1
G1 X5 Y0 Z0.2 E0.1
M486 S-1
"""
_SOURCE_POINTS = [(float(i), 0.0, 0.2) for i in range(6)]


class TestSourceCrosscheck(ValidatorTestCase):
    def _write_source(self, text=_SOURCE_GCODE):
        path = os.path.join(self.tmpdir, "source.gcode")
        with open(path, "w") as f:
            f.write(text)
        return path

    def test_matching_artifact_passes(self):
        source_path = self._write_source()
        write_artifact(self.tmpdir, ARTIFACT_ID, rows_to_lines(_SOURCE_POINTS))
        spec = minimal_spec(
            {"op": "source_crosscheck", "reader": "gcode_g1_points", "sample": 3},
            artifact_id=ARTIFACT_ID,
        )
        spec_path = write_spec(self.tmpdir, spec)
        code, out = run_validator_inprocess(spec_path, self.tmpdir, extra_args=["--source", source_path])
        self.assertEqual(code, 0, out)
        self.assertSeamLine(out, "s1", "PASS")
        self.assertIn("0 mismatched", out)

    def test_mismatched_artifact_fails(self):
        source_path = self._write_source()
        # Deliberately wrong rows -- none of these correspond to the source.
        bad_rows = [(100.0 + i, 200.0 + i, 300.0 + i) for i in range(6)]
        write_artifact(self.tmpdir, ARTIFACT_ID, rows_to_lines(bad_rows))
        spec = minimal_spec(
            {"op": "source_crosscheck", "reader": "gcode_g1_points", "sample": 3},
            artifact_id=ARTIFACT_ID,
        )
        spec_path = write_spec(self.tmpdir, spec)
        code, out = run_validator_inprocess(spec_path, self.tmpdir, extra_args=["--source", source_path])
        self.assertEqual(code, 1, out)
        self.assertSeamLine(out, "s1", "FAIL")
        self.assertIn("mismatched", out)

    def test_sampling_is_deterministic_every_floor_len_over_n_th_row(self):
        # len=6, sample=3 -> step=2 -> indices [0, 2, 4]. Make ONLY those
        # three rows match the source; the untested rows (1, 3, 5) are
        # deliberately wrong. Must still PASS -- the odd-indexed rows are
        # never sampled.
        source_path = self._write_source()
        rows = list(_SOURCE_POINTS)
        rows[1] = (999.0, 999.0, 999.0)
        rows[3] = (999.0, 999.0, 999.0)
        rows[5] = (999.0, 999.0, 999.0)
        write_artifact(self.tmpdir, ARTIFACT_ID, rows_to_lines(rows))
        spec = minimal_spec(
            {"op": "source_crosscheck", "reader": "gcode_g1_points", "sample": 3},
            artifact_id=ARTIFACT_ID,
        )
        spec_path = write_spec(self.tmpdir, spec)
        code, out = run_validator_inprocess(spec_path, self.tmpdir, extra_args=["--source", source_path])
        self.assertEqual(code, 0, out)
        self.assertIn("step=2", out)

    def test_sampling_catches_a_mismatch_at_a_sampled_index(self):
        # Same setup, but corrupt row 2 (a SAMPLED index at step=2) instead.
        source_path = self._write_source()
        rows = list(_SOURCE_POINTS)
        rows[2] = (999.0, 999.0, 999.0)
        write_artifact(self.tmpdir, ARTIFACT_ID, rows_to_lines(rows))
        spec = minimal_spec(
            {"op": "source_crosscheck", "reader": "gcode_g1_points", "sample": 3},
            artifact_id=ARTIFACT_ID,
        )
        spec_path = write_spec(self.tmpdir, spec)
        code, out = run_validator_inprocess(spec_path, self.tmpdir, extra_args=["--source", source_path])
        self.assertEqual(code, 1, out)
        self.assertIn("row 2", out)

    def test_within_tolerance_passes(self):
        source_path = self._write_source()
        rows = [(x + 0.0005, y, z) for x, y, z in _SOURCE_POINTS]  # under 1e-3
        write_artifact(self.tmpdir, ARTIFACT_ID, rows_to_lines(rows))
        spec = minimal_spec(
            {"op": "source_crosscheck", "reader": "gcode_g1_points", "sample": 3},
            artifact_id=ARTIFACT_ID,
        )
        spec_path = write_spec(self.tmpdir, spec)
        code, out = run_validator_inprocess(spec_path, self.tmpdir, extra_args=["--source", source_path])
        self.assertEqual(code, 0, out)

    def test_beyond_tolerance_fails(self):
        source_path = self._write_source()
        rows = [(x + 0.01, y, z) for x, y, z in _SOURCE_POINTS]  # over 1e-3
        write_artifact(self.tmpdir, ARTIFACT_ID, rows_to_lines(rows))
        spec = minimal_spec(
            {"op": "source_crosscheck", "reader": "gcode_g1_points", "sample": 3},
            artifact_id=ARTIFACT_ID,
        )
        spec_path = write_spec(self.tmpdir, spec)
        code, out = run_validator_inprocess(spec_path, self.tmpdir, extra_args=["--source", source_path])
        self.assertEqual(code, 1, out)

    def test_missing_source_arg_fails_predicate_not_internal_error(self):
        write_artifact(self.tmpdir, ARTIFACT_ID, rows_to_lines(_SOURCE_POINTS))
        spec = minimal_spec(
            {"op": "source_crosscheck", "reader": "gcode_g1_points", "sample": 3},
            artifact_id=ARTIFACT_ID,
        )
        spec_path = write_spec(self.tmpdir, spec)
        code, out = run_validator_inprocess(spec_path, self.tmpdir)  # no --source
        self.assertEqual(code, 1, out)
        self.assertSeamLine(out, "s1", "FAIL")
        self.assertNotIn("SEAM-GATE INTERNAL ERROR", out)
        self.assertIn("no --source provided", out)

    def test_unknown_reader_id_fails_predicate_not_internal_error(self):
        source_path = self._write_source()
        write_artifact(self.tmpdir, ARTIFACT_ID, rows_to_lines(_SOURCE_POINTS))
        spec = minimal_spec(
            {"op": "source_crosscheck", "reader": "totally_bogus_reader", "sample": 3},
            artifact_id=ARTIFACT_ID,
        )
        spec_path = write_spec(self.tmpdir, spec)
        code, out = run_validator_inprocess(spec_path, self.tmpdir, extra_args=["--source", source_path])
        self.assertEqual(code, 1, out)
        self.assertSeamLine(out, "s1", "FAIL")
        self.assertNotIn("SEAM-GATE INTERNAL ERROR", out)
        self.assertIn("unknown reader id", out)

    def test_leak_rule_rejects_tests_path(self):
        write_artifact(self.tmpdir, ARTIFACT_ID, rows_to_lines(_SOURCE_POINTS))
        spec = minimal_spec(
            {"op": "source_crosscheck", "reader": "gcode_g1_points", "sample": 3},
            artifact_id=ARTIFACT_ID,
        )
        spec_path = write_spec(self.tmpdir, spec)
        leaky_source = os.path.join(self.tmpdir, "tests", "hidden.gcode")
        os.makedirs(os.path.dirname(leaky_source), exist_ok=True)
        with open(leaky_source, "w") as f:
            f.write(_SOURCE_GCODE)
        code, out = run_validator_inprocess(spec_path, self.tmpdir, extra_args=["--source", leaky_source])
        self.assertEqual(code, 1, out)
        self.assertSeamLine(out, "s1", "FAIL")
        self.assertNotIn("SEAM-GATE INTERNAL ERROR", out)
        self.assertIn("refuses source path", out)

    def test_leak_rule_rejects_solution_path(self):
        write_artifact(self.tmpdir, ARTIFACT_ID, rows_to_lines(_SOURCE_POINTS))
        spec = minimal_spec(
            {"op": "source_crosscheck", "reader": "gcode_g1_points", "sample": 3},
            artifact_id=ARTIFACT_ID,
        )
        spec_path = write_spec(self.tmpdir, spec)
        leaky_source = os.path.join(self.tmpdir, "solution", "answer.gcode")
        os.makedirs(os.path.dirname(leaky_source), exist_ok=True)
        with open(leaky_source, "w") as f:
            f.write(_SOURCE_GCODE)
        code, out = run_validator_inprocess(spec_path, self.tmpdir, extra_args=["--source", leaky_source])
        self.assertEqual(code, 1, out)
        self.assertSeamLine(out, "s1", "FAIL")
        self.assertNotIn("SEAM-GATE INTERNAL ERROR", out)
        self.assertIn("refuses source path", out)

    def test_not_enough_rows_to_sample_fails_predicate_cleanly(self):
        source_path = self._write_source()
        write_artifact(self.tmpdir, ARTIFACT_ID, rows_to_lines(_SOURCE_POINTS[:2]))  # only 2 rows
        spec = minimal_spec(
            {"op": "source_crosscheck", "reader": "gcode_g1_points", "sample": 50},
            artifact_id=ARTIFACT_ID,
        )
        spec_path = write_spec(self.tmpdir, spec)
        code, out = run_validator_inprocess(spec_path, self.tmpdir, extra_args=["--source", source_path])
        self.assertEqual(code, 1, out)
        self.assertSeamLine(out, "s1", "FAIL")
        self.assertNotIn("SEAM-GATE INTERNAL ERROR", out)
        self.assertIn("not enough artifact rows", out)

    def test_missing_source_file_fails_predicate_not_internal_error(self):
        write_artifact(self.tmpdir, ARTIFACT_ID, rows_to_lines(_SOURCE_POINTS))
        spec = minimal_spec(
            {"op": "source_crosscheck", "reader": "gcode_g1_points", "sample": 3},
            artifact_id=ARTIFACT_ID,
        )
        spec_path = write_spec(self.tmpdir, spec)
        code, out = run_validator_inprocess(
            spec_path, self.tmpdir, extra_args=["--source", os.path.join(self.tmpdir, "nope.gcode")]
        )
        self.assertEqual(code, 1, out)
        self.assertSeamLine(out, "s1", "FAIL")
        self.assertNotIn("SEAM-GATE INTERNAL ERROR", out)

    def test_readers_registry_leak_rule_direct(self):
        # Same leak rule, exercised directly against readers.py (not through
        # the validator CLI) -- see also test_readers.py for the fuller
        # readers-module-level coverage.
        with self.assertRaises(readers.ReaderError):
            readers.read_source("gcode_g1_points", "/some/tests/hidden.gcode")
        with self.assertRaises(readers.ReaderError):
            readers.read_source("gcode_g1_points", "/some/solution/answer.gcode")


# --------------------------------------------------------------------------
# C1 fix-round regression (final-review.md): a missing/corrupt readers.py or
# spec_check.py next to validator.py used to make the interpreter exit 1
# with an uncaught ModuleNotFoundError traceback -- BEFORE main()'s
# fail-open try/except existed to catch it, which hook.py's
# post_validator_decision then read as a predicate-fail and BLOCKED the
# stop on a gate-internal breakage. Both imports are now lazy, inside
# run() (the same pattern already used for numpy's ImportError) -- this
# class proves that end to end via a real subprocess invocation of
# validator.py from a directory that does NOT have readers.py/spec_check.py
# next to it (so Python's own same-directory import resolution can't find
# them), not an in-process mock.
# --------------------------------------------------------------------------

class TestMissingKernelModuleFailsOpen(ValidatorTestCase):
    def _stage_validator_only(self):
        """Copies ONLY validator.py into a fresh temp dir -- neither
        readers.py nor spec_check.py travel with it, reproducing "the
        pre-Task-7 file set" / "a corrupted readers.py" the review names.
        """
        stage_dir = tempfile.mkdtemp(prefix="seam-gate-missing-kernel-module-")
        self.addCleanup(shutil.rmtree, stage_dir, ignore_errors=True)
        shutil.copy(VALIDATOR_PATH, os.path.join(stage_dir, "validator.py"))
        return stage_dir

    def test_missing_readers_and_spec_check_fails_open_not_uncaught_traceback(self):
        stage_dir = self._stage_validator_only()
        write_artifact(self.tmpdir, ARTIFACT_ID, ["1 2 3"])
        spec = minimal_spec({"op": "artifact_exists"}, artifact_id=ARTIFACT_ID)
        spec_path = write_spec(self.tmpdir, spec)
        proc = subprocess.run(
            [sys.executable, os.path.join(stage_dir, "validator.py"), "--spec", spec_path, "--root", self.tmpdir],
            capture_output=True, text=True, cwd=stage_dir,
        )
        self.assertEqual(proc.returncode, 0, f"stdout:\n{proc.stdout}\nstderr:\n{proc.stderr}")
        self.assertIn("SEAM-GATE INTERNAL ERROR", proc.stdout)
        self.assertNotIn("Traceback", proc.stderr)
        self.assertNotIn("SEAM s1", proc.stdout)  # never reached seam evaluation

    def test_missing_readers_module_named_in_error_detail(self):
        stage_dir = self._stage_validator_only()
        write_artifact(self.tmpdir, ARTIFACT_ID, ["1 2 3"])
        spec = minimal_spec({"op": "artifact_exists"}, artifact_id=ARTIFACT_ID)
        spec_path = write_spec(self.tmpdir, spec)
        proc = subprocess.run(
            [sys.executable, os.path.join(stage_dir, "validator.py"), "--spec", spec_path, "--root", self.tmpdir],
            capture_output=True, text=True, cwd=stage_dir,
        )
        self.assertEqual(proc.returncode, 0)
        # Whichever of the two missing modules Python's import machinery
        # reaches first (readers is imported before spec_check in run()).
        self.assertIn("readers", proc.stdout)


# --------------------------------------------------------------------------
# Fail-open contract
# --------------------------------------------------------------------------

class TestFailOpenContract(ValidatorTestCase):
    def test_malformed_spec_json_fails_open(self):
        # Valid JSON, but violates the frozen schema (unknown top-level key) --
        # check_spec() rejects it, which must route through the fail-open path,
        # not a predicate FAIL.
        spec = minimal_spec({"op": "artifact_exists"}, artifact_id=ARTIFACT_ID)
        spec["totallyUnknownKey"] = True
        spec_path = write_spec(self.tmpdir, spec)
        code, out = run_validator_inprocess(spec_path, self.tmpdir)
        self.assertEqual(code, 0)
        self.assertIn("SEAM-GATE INTERNAL ERROR", out)
        self.assertNotIn("SEAM s1", out)  # never reached seam evaluation

    def test_corrupt_json_fails_open(self):
        spec_path = os.path.join(self.tmpdir, "corrupt.json")
        with open(spec_path, "w") as f:
            f.write("{ this is not valid json ")
        code, out = run_validator_inprocess(spec_path, self.tmpdir)
        self.assertEqual(code, 0)
        self.assertIn("SEAM-GATE INTERNAL ERROR", out)

    def test_missing_spec_file_fails_open(self):
        code, out = run_validator_inprocess(os.path.join(self.tmpdir, "nope.json"), self.tmpdir)
        self.assertEqual(code, 0)
        self.assertIn("SEAM-GATE INTERNAL ERROR", out)

    def test_numpy_unavailable_fails_open(self):
        # Undocumented env-var test hook (validator._TEST_NO_NUMPY_ENV, per
        # MEDIUM-4's ruling -- NOT a --help-visible CLI flag): setting it
        # simulates `import numpy` raising ImportError, without needing a
        # real broken environment.
        spec = minimal_spec({"op": "artifact_exists"}, artifact_id=ARTIFACT_ID)
        write_artifact(self.tmpdir, ARTIFACT_ID, ["1 2 3"])
        spec_path = write_spec(self.tmpdir, spec)
        with env_var(validator._TEST_NO_NUMPY_ENV, "1"):
            code, out = run_validator_inprocess(spec_path, self.tmpdir)
        self.assertEqual(code, 0)
        self.assertIn("SEAM-GATE INTERNAL ERROR", out)
        self.assertIn("numpy", out)

    def test_numpy_unavailable_fails_open_subprocess(self):
        # Same as above but as a true subprocess, proving the OS-level exit
        # code (not just the Python function's return value) is 0, and that
        # the env var (not a CLI flag) is what the real process reads.
        spec = minimal_spec({"op": "artifact_exists"}, artifact_id=ARTIFACT_ID)
        write_artifact(self.tmpdir, ARTIFACT_ID, ["1 2 3"])
        spec_path = write_spec(self.tmpdir, spec)
        code, out, err = run_validator_subprocess(
            spec_path, self.tmpdir, extra_env={validator._TEST_NO_NUMPY_ENV: "1"}
        )
        self.assertEqual(code, 0)
        self.assertIn("SEAM-GATE INTERNAL ERROR", out)

    def test_force_no_numpy_cli_flag_no_longer_exists(self):
        # MEDIUM-4: the old --_force-no-numpy CLI flag must be gone entirely
        # (not --help-visible, not accepted at all) -- passing it is now just
        # an unknown flag, which itself must still fail open via MEDIUM-3's
        # fix (argparse errors funnel through the same INTERNAL ERROR path).
        spec = minimal_spec({"op": "artifact_exists"}, artifact_id=ARTIFACT_ID)
        write_artifact(self.tmpdir, ARTIFACT_ID, ["1 2 3"])
        spec_path = write_spec(self.tmpdir, spec)
        code, out, err = run_validator_subprocess(
            spec_path, self.tmpdir, extra_args=["--_force-no-numpy"]
        )
        self.assertEqual(code, 0)
        self.assertIn("SEAM-GATE INTERNAL ERROR", out)
        self.assertNotIn("--help", err)  # sanity: didn't silently no-op into a clean run
        self.assertNotIn("SEAM s1", out)  # never reached seam evaluation

    def test_help_flag_still_omits_it(self):
        proc = subprocess.run(
            [sys.executable, VALIDATOR_PATH, "--help"],
            capture_output=True, text=True, cwd=_SEAM_GATE_DIR,
        )
        self.assertNotIn("force-no-numpy", proc.stdout)
        self.assertNotIn("numpy", proc.stdout.lower())

    def test_binary_artifact_content_is_predicate_fail_not_internal_error(self):
        # HIGH-1: non-UTF-8 bytes must fail the seam (exit 1), not escape as
        # SEAM-GATE INTERNAL ERROR (exit 0).
        write_binary_artifact(self.tmpdir, ARTIFACT_ID, b"\xff\xfe\x00\x01garbage\x80\x81")
        spec = minimal_spec({"op": "row_count_in_range", "min": 1, "max": 10}, artifact_id=ARTIFACT_ID)
        spec_path = write_spec(self.tmpdir, spec)
        code, out = run_validator_inprocess(spec_path, self.tmpdir)
        self.assertEqual(code, 1)
        self.assertSeamLine(out, "s1", "FAIL")
        self.assertNotIn("SEAM-GATE INTERNAL ERROR", out)

    def test_binary_artifact_content_across_ops(self):
        # Same garbage content, exercised against every op that parses
        # artifact content (all but artifact_exists) -- none may crash to
        # INTERNAL ERROR.
        write_binary_artifact(self.tmpdir, ARTIFACT_ID, b"\x00\xff\xfe\xfd not utf-8 \x80")
        predicates = [
            {"op": "row_count_in_range", "min": 1, "max": 10},
            {"op": "numeric_cols", "n": 3},
            {"op": "affine_residual_below", "cols": [0, 1, 2], "max_ratio": 0.02},
            {"op": "variance_ratio_below", "component": 2, "max": 0.01},
            {"op": "spread_above", "col": 1, "min_std": 1.0},
            {"op": "cluster_count_in_range", "method": "conncomp2d", "cell": 0.5, "min": 1, "max": 40},
            {"op": "value_in_range", "row": 0, "col": 0, "min": 0.0, "max": 1.0},
        ]
        for predicate in predicates:
            with self.subTest(op=predicate["op"]):
                spec = minimal_spec(predicate, artifact_id=ARTIFACT_ID)
                spec_path = write_spec(self.tmpdir, spec, name=f"spec-{predicate['op']}.json")
                code, out = run_validator_inprocess(spec_path, self.tmpdir)
                self.assertEqual(code, 1, f"op {predicate['op']} did not fail-predicate:\n{out}")
                self.assertSeamLine(out, "s1", "FAIL")
                self.assertNotIn("SEAM-GATE INTERNAL ERROR", out)

    def test_nan_inf_tokens_fail_affine_residual_below_predicate(self):
        # HIGH-2: a row containing a nan/inf token must not crash
        # np.linalg.lstsq -- it's skipped like a non-numeric line, and the
        # remaining rows still get evaluated normally.
        rows = [(x, y, 2 * x - y + 3) for x, y in [(1.0, 1.0), (2.0, 3.0), (3.0, 1.0), (4.0, 2.0)]]
        lines = rows_to_lines(rows) + ["3 nan 1", "inf 1 2", "1 2 -inf"]
        write_artifact(self.tmpdir, ARTIFACT_ID, lines)
        spec = minimal_spec({"op": "affine_residual_below", "cols": [0, 1, 2], "max_ratio": 0.02}, artifact_id=ARTIFACT_ID)
        spec_path = write_spec(self.tmpdir, spec)
        code, out = run_validator_inprocess(spec_path, self.tmpdir)
        # Only 4 clean planar rows remain after nan/inf rows are skipped --
        # still a valid (small) fit, still passes; the key assertion is no
        # internal error, regardless of pass/fail direction.
        self.assertNotIn("SEAM-GATE INTERNAL ERROR", out)
        self.assertIn("SEAM s1 ", out)

    def test_nan_inf_tokens_fail_cluster_count_in_range_predicate(self):
        # HIGH-2: a nan/inf x,y row must not corrupt grid-index casting
        # (np.floor(nan).astype(int) -> undefined huge int -> out-of-bounds
        # index) -- it's skipped at parse time instead.
        rows = self._nan_inf_cluster_rows()
        write_artifact(self.tmpdir, ARTIFACT_ID, rows)
        spec = minimal_spec(
            {"op": "cluster_count_in_range", "method": "conncomp2d", "cell": 0.5, "min": 1, "max": 40},
            artifact_id=ARTIFACT_ID,
        )
        spec_path = write_spec(self.tmpdir, spec)
        code, out = run_validator_inprocess(spec_path, self.tmpdir)
        self.assertNotIn("SEAM-GATE INTERNAL ERROR", out)
        self.assertIn("SEAM s1 ", out)

    @staticmethod
    def _nan_inf_cluster_rows():
        rows = []
        for b in range(5):
            base_x = b * 5.0
            for _ in range(4):
                rows.append(f"{base_x + random.uniform(0, 1.4)} {random.uniform(0, 1.4)}")
        rows += ["nan 1.0", "1.0 inf", "-inf -inf"]
        return rows


# --------------------------------------------------------------------------
# CLI argument-parsing failures (MEDIUM-3): argparse errors must fail open
# --------------------------------------------------------------------------

class TestArgparseFailuresFailOpen(ValidatorTestCase):
    def test_missing_required_root_exits_0_not_2(self):
        spec = minimal_spec({"op": "artifact_exists"}, artifact_id=ARTIFACT_ID)
        spec_path = write_spec(self.tmpdir, spec)
        code, out, err = run_validator_argv_subprocess(["--spec", spec_path])  # no --root
        self.assertEqual(code, 0)
        self.assertIn("SEAM-GATE INTERNAL ERROR", out)

    def test_unknown_flag_exits_0_not_2(self):
        spec = minimal_spec({"op": "artifact_exists"}, artifact_id=ARTIFACT_ID)
        spec_path = write_spec(self.tmpdir, spec)
        code, out, err = run_validator_argv_subprocess(
            ["--spec", spec_path, "--root", self.tmpdir, "--totally-bogus-flag"]
        )
        self.assertEqual(code, 0)
        self.assertIn("SEAM-GATE INTERNAL ERROR", out)

    def test_no_args_at_all_exits_0_not_2(self):
        code, out, err = run_validator_argv_subprocess([])
        self.assertEqual(code, 0)
        self.assertIn("SEAM-GATE INTERNAL ERROR", out)

    def test_help_flag_still_exits_0_cleanly(self):
        # -h/--help's own sys.exit(0) must be left alone -- no spurious
        # INTERNAL ERROR line should be printed on top of argparse's help text.
        code, out, err = run_validator_argv_subprocess(["--help"])
        self.assertEqual(code, 0)
        self.assertNotIn("SEAM-GATE INTERNAL ERROR", out)
        self.assertIn("usage", out.lower())

    def test_main_never_raises_systemexit_in_process(self):
        # validator.main() must return an int, not let argparse's SystemExit
        # propagate -- this would otherwise kill the calling process/test
        # runner outright rather than following the documented 0/1 contract.
        argv = ["--spec", "/nonexistent/spec.json"]  # missing --root
        buf = io.StringIO()
        err_buf = io.StringIO()
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(err_buf):
            code = validator.main(argv)  # must not raise SystemExit
        self.assertEqual(code, 0)
        self.assertIn("SEAM-GATE INTERNAL ERROR", buf.getvalue())


# --------------------------------------------------------------------------
# Exit-code contract (process-level, via subprocess)
# --------------------------------------------------------------------------

class TestExitCodeContract(ValidatorTestCase):
    def test_all_pass_exits_0(self):
        write_artifact(self.tmpdir, ARTIFACT_ID, ["1 2 3"])
        spec = minimal_spec({"op": "artifact_exists"}, artifact_id=ARTIFACT_ID)
        spec_path = write_spec(self.tmpdir, spec)
        code, out, err = run_validator_subprocess(spec_path, self.tmpdir)
        self.assertEqual(code, 0)
        self.assertEqual(err, "")
        self.assertSeamLine(out, "s1", "PASS")

    def test_any_fail_exits_1(self):
        spec = minimal_spec({"op": "artifact_exists"}, artifact_id=ARTIFACT_ID)  # artifact never written
        spec_path = write_spec(self.tmpdir, spec)
        code, out, err = run_validator_subprocess(spec_path, self.tmpdir)
        self.assertEqual(code, 1)
        self.assertSeamLine(out, "s1", "FAIL")

    def test_mixed_seams_one_failure_still_exits_1_and_reports_both(self):
        write_artifact(self.tmpdir, "ok", ["1 2 3"])
        spec = {
            "seamSpecVersion": 1,
            "task": "test-task",
            "artifactIds": ["ok", "missing"],
            "seams": [
                {"id": "s1", "artifact": "ok", "predicate": {"op": "artifact_exists"}, "onFail": "x"},
                {"id": "s2", "artifact": "missing", "predicate": {"op": "artifact_exists"}, "onFail": "y"},
            ],
        }
        spec_path = write_spec(self.tmpdir, spec)
        code, out, err = run_validator_subprocess(spec_path, self.tmpdir)
        self.assertEqual(code, 1)
        self.assertSeamLine(out, "s1", "PASS")
        self.assertSeamLine(out, "s2", "FAIL")


# --------------------------------------------------------------------------
# Reference spec integration: gcode-to-text-gate.json, 7 seams
# --------------------------------------------------------------------------

class TestReferenceSpecIntegration(ValidatorTestCase):
    def _write_good_fixtures(self):
        """Writes points.txt/projected.txt AND a matching synthetic gcode
        source file (so s7's source_crosscheck can also be exercised
        end-to-end) -- the source's S0-scoped extruding G1 lines are
        generated FROM the same `rows` written to points.txt, in the same
        order, so a reader re-parse reproduces them exactly. Returns the
        source gcode file's path.
        """
        rows = []
        for _ in range(40000):
            x = random.uniform(0, 50)
            y = random.uniform(0, 50)
            z = 2 * x + 3 * y + 1
            rows.append((x, y, z))
        write_artifact(self.tmpdir, "points", rows_to_lines(rows))

        gcode_path = os.path.join(self.tmpdir, "source.gcode")
        with open(gcode_path, "w") as f:
            f.write("M486 S0\n")
            for x, y, z in rows:
                f.write(f"G1 X{x} Y{y} Z{z} E0.1\n")
            f.write("M486 S-1\n")

        # projected.txt: seam s4 (cluster_count_in_range) targets THIS
        # artifact as of Task 3's calibration (retargeted from the original,
        # broken "clusters" centroid artifact -- conncomp2d rasterizes the
        # artifact's own points, and a file of pre-computed centroids
        # collapses every component to 1 pixel, under the validator's
        # 3-pixel floor, which would false-FAIL any real oracle; see
        # calibrate_gcode.py's module docstring). Lay out well-separated
        # point clumps (6 cols x 5 rows, spacing 5.0mm, each clump a 12-point
        # 0.6x0.6mm box) so conncomp2d finds exactly 30 components at the
        # calibrated cell=0.4 -- comfortably inside the calibrated [25,38]
        # band with margin -- while spanning enough of both axes that
        # column 1 (v)'s spread also clears s5's min_std=1.0.
        proj_rows = []
        for b in range(30):
            base_u = (b % 6) * 5.0
            base_v = (b // 6) * 5.0
            for _ in range(12):
                proj_rows.append((base_u + random.uniform(0, 0.6), base_v + random.uniform(0, 0.6)))
        write_artifact(self.tmpdir, "projected", rows_to_lines(proj_rows))
        return gcode_path

    def test_reference_spec_all_pass_on_good_fixtures(self):
        gcode_path = self._write_good_fixtures()
        code, out = run_validator_inprocess(REFERENCE_SPEC_PATH, self.tmpdir, extra_args=["--source", gcode_path])
        self.assertEqual(code, 0, f"expected all 7 seams to pass, got:\n{out}")
        for sid in ("s1", "s2", "s3", "s4", "s5", "s6", "s7"):
            self.assertSeamLine(out, sid, "PASS")

    def test_reference_spec_unfiltered_points_fail_plane_seams(self):
        # v1-arm failure shape (per Task 3's brief): whole-file unfiltered
        # points including travel moves off the extrusion plane -- s3 and s6
        # (both recompute planarity from points.txt) must fail. s7 also
        # fails here (a natural consequence, not a separate migration): the
        # overwritten points.txt no longer matches the original good
        # fixture's source gcode at all.
        gcode_path = self._write_good_fixtures()
        rows = []
        for _ in range(40000):
            x = random.uniform(0, 50)
            y = random.uniform(0, 50)
            z = random.uniform(0, 50)  # not on any plane
            rows.append((x, y, z))
        write_artifact(self.tmpdir, "points", rows_to_lines(rows))
        code, out = run_validator_inprocess(REFERENCE_SPEC_PATH, self.tmpdir, extra_args=["--source", gcode_path])
        self.assertEqual(code, 1)
        self.assertSeamLine(out, "s3", "FAIL")
        self.assertSeamLine(out, "s6", "FAIL")
        self.assertSeamLine(out, "s7", "FAIL")


if __name__ == "__main__":
    unittest.main()
