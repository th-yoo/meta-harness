"""Tests for term-bench2/seam-gate/validator.py (plain unittest, no pytest).

Run with:
    python3 -m unittest discover -s term-bench2/seam-gate/test -p 'test_*.py'
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


def write_binary_artifact(root, artifact_path, data):
    """Like write_artifact, but writes raw (possibly non-UTF-8) bytes."""
    full = validator.resolve_artifact_path(artifact_path, root)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "wb") as f:
        f.write(data)
    return full


def write_spec(tmpdir, spec_dict, name="spec.json"):
    path = os.path.join(tmpdir, name)
    with open(path, "w") as f:
        json.dump(spec_dict, f)
    return path


def write_artifact(root, artifact_path, lines):
    """artifact_path is a spec-style absolute path like '/app/.seam/points.txt';
    resolved via the same rule validator.py itself uses, so tests exercise the
    real resolution logic rather than a parallel implementation of it.
    """
    full = validator.resolve_artifact_path(artifact_path, root)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w") as f:
        f.write("\n".join(lines))
        if lines:
            f.write("\n")
    return full


def minimal_spec(artifact_path, predicate, artifact_id="a1", seam_id="s1", on_fail="test onFail"):
    return {
        "seamSpecVersion": 1,
        "task": "test-task",
        "artifacts": {artifact_id: artifact_path},
        "seams": [
            {"id": seam_id, "artifact": artifact_id, "predicate": predicate, "onFail": on_fail},
        ],
    }


def rows_to_lines(rows, sep=" "):
    return [sep.join(str(v) for v in row) for row in rows]


ARTIFACT_PATH = "/app/.seam/artifact.txt"


class ValidatorTestCase(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="seam-gate-test-")
        random.seed(0)

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def assertSeamLine(self, stdout, seam_id, status):
        self.assertIn(f"SEAM {seam_id} {status}", stdout, f"stdout was:\n{stdout}")


# --------------------------------------------------------------------------
# Path resolution
# --------------------------------------------------------------------------

class TestResolveArtifactPath(unittest.TestCase):
    def test_drops_container_root_segment(self):
        self.assertEqual(
            validator.resolve_artifact_path("/app/.seam/points.txt", "/tmp/root"),
            os.path.join("/tmp/root", ".seam", "points.txt"),
        )

    def test_identity_when_root_matches_dropped_segment(self):
        # In-container usage: --root /app should round-trip "/app/..." paths
        # to themselves.
        self.assertEqual(
            validator.resolve_artifact_path("/app/.seam/points.txt", "/app"),
            "/app/.seam/points.txt",
        )


# --------------------------------------------------------------------------
# artifact_exists
# --------------------------------------------------------------------------

class TestArtifactExists(ValidatorTestCase):
    def test_pass_when_file_present_and_nonempty(self):
        write_artifact(self.tmpdir, ARTIFACT_PATH, ["1 2 3"])
        spec = minimal_spec(ARTIFACT_PATH, {"op": "artifact_exists"})
        spec_path = write_spec(self.tmpdir, spec)
        code, out = run_validator_inprocess(spec_path, self.tmpdir)
        self.assertEqual(code, 0)
        self.assertSeamLine(out, "s1", "PASS")

    def test_fail_when_file_missing(self):
        spec = minimal_spec(ARTIFACT_PATH, {"op": "artifact_exists"})
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
        write_artifact(self.tmpdir, ARTIFACT_PATH, lines)
        spec = minimal_spec(ARTIFACT_PATH, {"op": "row_count_in_range", "min": 50, "max": 150})
        spec_path = write_spec(self.tmpdir, spec)
        code, out = run_validator_inprocess(spec_path, self.tmpdir)
        self.assertEqual(code, 0)
        self.assertSeamLine(out, "s1", "PASS")

    def test_fail_when_count_out_of_range(self):
        lines = [f"{i} {i*2}" for i in range(10)]
        write_artifact(self.tmpdir, ARTIFACT_PATH, lines)
        spec = minimal_spec(ARTIFACT_PATH, {"op": "row_count_in_range", "min": 50, "max": 150})
        spec_path = write_spec(self.tmpdir, spec)
        code, out = run_validator_inprocess(spec_path, self.tmpdir)
        self.assertEqual(code, 1)
        self.assertSeamLine(out, "s1", "FAIL")

    def test_non_numeric_lines_skipped(self):
        lines = ["# comment", "not a number", "1 2", "3 4"]
        write_artifact(self.tmpdir, ARTIFACT_PATH, lines)
        spec = minimal_spec(ARTIFACT_PATH, {"op": "row_count_in_range", "min": 2, "max": 2})
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
        write_artifact(self.tmpdir, ARTIFACT_PATH, lines)
        spec = minimal_spec(ARTIFACT_PATH, {"op": "numeric_cols", "n": 3})
        spec_path = write_spec(self.tmpdir, spec)
        code, out = run_validator_inprocess(spec_path, self.tmpdir)
        self.assertEqual(code, 0)
        self.assertSeamLine(out, "s1", "PASS")

    def test_fail_when_a_row_has_wrong_col_count(self):
        lines = [f"{i} {i} {i}" for i in range(20)]
        lines[5] = "1 2"  # only 2 columns
        write_artifact(self.tmpdir, ARTIFACT_PATH, lines)
        spec = minimal_spec(ARTIFACT_PATH, {"op": "numeric_cols", "n": 3})
        spec_path = write_spec(self.tmpdir, spec)
        code, out = run_validator_inprocess(spec_path, self.tmpdir)
        self.assertEqual(code, 1)
        self.assertSeamLine(out, "s1", "FAIL")
        self.assertIn("row 5", out)

    # comma-separated is also valid per SPEC.md ("whitespace- or comma-separated")
    def test_comma_separated_rows_parse(self):
        lines = ["1,2,3", "4, 5, 6"]
        write_artifact(self.tmpdir, ARTIFACT_PATH, lines)
        spec = minimal_spec(ARTIFACT_PATH, {"op": "numeric_cols", "n": 3})
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
        write_artifact(self.tmpdir, ARTIFACT_PATH, rows_to_lines(self._planar_rows()))
        spec = minimal_spec(
            ARTIFACT_PATH,
            {"op": "affine_residual_below", "cols": [0, 1, 2], "max_ratio": 0.02},
        )
        spec_path = write_spec(self.tmpdir, spec)
        code, out = run_validator_inprocess(spec_path, self.tmpdir)
        self.assertEqual(code, 0)
        self.assertSeamLine(out, "s1", "PASS")

    def test_spherical_cloud_fails(self):
        write_artifact(self.tmpdir, ARTIFACT_PATH, rows_to_lines(self._spherical_rows()))
        spec = minimal_spec(
            ARTIFACT_PATH,
            {"op": "affine_residual_below", "cols": [0, 1, 2], "max_ratio": 0.02},
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
        write_artifact(self.tmpdir, ARTIFACT_PATH, rows_to_lines(rows))
        spec = minimal_spec(ARTIFACT_PATH, {"op": "variance_ratio_below", "component": 2, "max": 0.01})
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
        write_artifact(self.tmpdir, ARTIFACT_PATH, rows_to_lines(rows))
        spec = minimal_spec(ARTIFACT_PATH, {"op": "variance_ratio_below", "component": 2, "max": 0.01})
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
        write_artifact(self.tmpdir, ARTIFACT_PATH, rows_to_lines(rows))
        spec = minimal_spec(ARTIFACT_PATH, {"op": "spread_above", "col": 1, "min_std": 1.0})
        spec_path = write_spec(self.tmpdir, spec)
        code, out = run_validator_inprocess(spec_path, self.tmpdir)
        self.assertEqual(code, 0)
        self.assertSeamLine(out, "s1", "PASS")

    def test_fail_when_column_is_degenerate(self):
        rows = [(i, 7.0) for i in range(500)]  # column 1 is constant
        write_artifact(self.tmpdir, ARTIFACT_PATH, rows_to_lines(rows))
        spec = minimal_spec(ARTIFACT_PATH, {"op": "spread_above", "col": 1, "min_std": 1.0})
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
        write_artifact(self.tmpdir, ARTIFACT_PATH, rows_to_lines(rows))
        spec = minimal_spec(
            ARTIFACT_PATH,
            {"op": "cluster_count_in_range", "method": "conncomp2d", "cell": 0.5, "min": 10, "max": 40},
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
        write_artifact(self.tmpdir, ARTIFACT_PATH, rows_to_lines(rows))
        spec = minimal_spec(
            ARTIFACT_PATH,
            {"op": "cluster_count_in_range", "method": "conncomp2d", "cell": 1000.0, "min": 10, "max": 40},
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
        write_artifact(self.tmpdir, ARTIFACT_PATH, rows_to_lines(rows))
        spec = minimal_spec(
            ARTIFACT_PATH,
            {"op": "cluster_count_in_range", "method": "conncomp2d", "cell": 0.5, "min": 1, "max": 40},
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
        write_artifact(self.tmpdir, ARTIFACT_PATH, rows_to_lines(rows))
        spec = minimal_spec(
            ARTIFACT_PATH,
            {"op": "cluster_count_in_range", "method": "conncomp2d", "cell": 0.001, "min": 1, "max": 40},
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
        write_artifact(self.tmpdir, ARTIFACT_PATH, ["0.97"])
        spec = minimal_spec(ARTIFACT_PATH, {"op": "value_in_range", "row": 0, "col": 0, "min": 0.9, "max": 1.0})
        spec_path = write_spec(self.tmpdir, spec)
        code, out = run_validator_inprocess(spec_path, self.tmpdir)
        self.assertEqual(code, 0)
        self.assertSeamLine(out, "s1", "PASS")

    def test_fail_when_value_out_of_range(self):
        write_artifact(self.tmpdir, ARTIFACT_PATH, ["0.5"])
        spec = minimal_spec(ARTIFACT_PATH, {"op": "value_in_range", "row": 0, "col": 0, "min": 0.9, "max": 1.0})
        spec_path = write_spec(self.tmpdir, spec)
        code, out = run_validator_inprocess(spec_path, self.tmpdir)
        self.assertEqual(code, 1)
        self.assertSeamLine(out, "s1", "FAIL")


# --------------------------------------------------------------------------
# Fail-open contract
# --------------------------------------------------------------------------

class TestFailOpenContract(ValidatorTestCase):
    def test_malformed_spec_json_fails_open(self):
        # Valid JSON, but violates the frozen schema (unknown top-level key) --
        # check_spec() rejects it, which must route through the fail-open path,
        # not a predicate FAIL.
        spec = minimal_spec(ARTIFACT_PATH, {"op": "artifact_exists"})
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
        spec = minimal_spec(ARTIFACT_PATH, {"op": "artifact_exists"})
        write_artifact(self.tmpdir, ARTIFACT_PATH, ["1 2 3"])
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
        spec = minimal_spec(ARTIFACT_PATH, {"op": "artifact_exists"})
        write_artifact(self.tmpdir, ARTIFACT_PATH, ["1 2 3"])
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
        spec = minimal_spec(ARTIFACT_PATH, {"op": "artifact_exists"})
        write_artifact(self.tmpdir, ARTIFACT_PATH, ["1 2 3"])
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
        write_binary_artifact(self.tmpdir, ARTIFACT_PATH, b"\xff\xfe\x00\x01garbage\x80\x81")
        spec = minimal_spec(ARTIFACT_PATH, {"op": "row_count_in_range", "min": 1, "max": 10})
        spec_path = write_spec(self.tmpdir, spec)
        code, out = run_validator_inprocess(spec_path, self.tmpdir)
        self.assertEqual(code, 1)
        self.assertSeamLine(out, "s1", "FAIL")
        self.assertNotIn("SEAM-GATE INTERNAL ERROR", out)

    def test_binary_artifact_content_across_ops(self):
        # Same garbage content, exercised against every op that parses
        # artifact content (all but artifact_exists) -- none may crash to
        # INTERNAL ERROR.
        write_binary_artifact(self.tmpdir, ARTIFACT_PATH, b"\x00\xff\xfe\xfd not utf-8 \x80")
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
                spec = minimal_spec(ARTIFACT_PATH, predicate)
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
        write_artifact(self.tmpdir, ARTIFACT_PATH, lines)
        spec = minimal_spec(ARTIFACT_PATH, {"op": "affine_residual_below", "cols": [0, 1, 2], "max_ratio": 0.02})
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
        write_artifact(self.tmpdir, ARTIFACT_PATH, rows)
        spec = minimal_spec(
            ARTIFACT_PATH,
            {"op": "cluster_count_in_range", "method": "conncomp2d", "cell": 0.5, "min": 1, "max": 40},
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
        spec = minimal_spec(ARTIFACT_PATH, {"op": "artifact_exists"})
        spec_path = write_spec(self.tmpdir, spec)
        code, out, err = run_validator_argv_subprocess(["--spec", spec_path])  # no --root
        self.assertEqual(code, 0)
        self.assertIn("SEAM-GATE INTERNAL ERROR", out)

    def test_unknown_flag_exits_0_not_2(self):
        spec = minimal_spec(ARTIFACT_PATH, {"op": "artifact_exists"})
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
        write_artifact(self.tmpdir, ARTIFACT_PATH, ["1 2 3"])
        spec = minimal_spec(ARTIFACT_PATH, {"op": "artifact_exists"})
        spec_path = write_spec(self.tmpdir, spec)
        code, out, err = run_validator_subprocess(spec_path, self.tmpdir)
        self.assertEqual(code, 0)
        self.assertEqual(err, "")
        self.assertSeamLine(out, "s1", "PASS")

    def test_any_fail_exits_1(self):
        spec = minimal_spec(ARTIFACT_PATH, {"op": "artifact_exists"})  # artifact never written
        spec_path = write_spec(self.tmpdir, spec)
        code, out, err = run_validator_subprocess(spec_path, self.tmpdir)
        self.assertEqual(code, 1)
        self.assertSeamLine(out, "s1", "FAIL")

    def test_mixed_seams_one_failure_still_exits_1_and_reports_both(self):
        write_artifact(self.tmpdir, "/app/.seam/present.txt", ["1 2 3"])
        spec = {
            "seamSpecVersion": 1,
            "task": "test-task",
            "artifacts": {
                "ok": "/app/.seam/present.txt",
                "missing": "/app/.seam/absent.txt",
            },
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
# Reference spec integration: gcode-to-text-gate.json, 6 seams
# --------------------------------------------------------------------------

class TestReferenceSpecIntegration(ValidatorTestCase):
    def _write_good_fixtures(self):
        rows = []
        for _ in range(40000):
            x = random.uniform(0, 50)
            y = random.uniform(0, 50)
            z = 2 * x + 3 * y + 1
            rows.append((x, y, z))
        write_artifact(self.tmpdir, "/app/.seam/points.txt", rows_to_lines(rows))

        proj_rows = [(random.uniform(0, 100), random.uniform(0, 20)) for _ in range(1000)]
        write_artifact(self.tmpdir, "/app/.seam/projected.txt", rows_to_lines(proj_rows))

        cluster_rows = []
        for b in range(20):
            base_x = b * 5.0
            for _ in range(8):
                cluster_rows.append((base_x + random.uniform(0, 1.4), random.uniform(0, 1.4)))
        write_artifact(self.tmpdir, "/app/.seam/clusters.txt", rows_to_lines(cluster_rows))

    def test_reference_spec_all_pass_on_good_fixtures(self):
        self._write_good_fixtures()
        code, out = run_validator_inprocess(REFERENCE_SPEC_PATH, self.tmpdir)
        self.assertEqual(code, 0, f"expected all 6 seams to pass, got:\n{out}")
        for sid in ("s1", "s2", "s3", "s4", "s5", "s6"):
            self.assertSeamLine(out, sid, "PASS")

    def test_reference_spec_unfiltered_points_fail_plane_seams(self):
        # v1-arm failure shape (per Task 3's brief): whole-file unfiltered
        # points including travel moves off the extrusion plane -- s3 and s6
        # (both recompute planarity from points.txt) must fail.
        self._write_good_fixtures()
        rows = []
        for _ in range(40000):
            x = random.uniform(0, 50)
            y = random.uniform(0, 50)
            z = random.uniform(0, 50)  # not on any plane
            rows.append((x, y, z))
        write_artifact(self.tmpdir, "/app/.seam/points.txt", rows_to_lines(rows))
        code, out = run_validator_inprocess(REFERENCE_SPEC_PATH, self.tmpdir)
        self.assertEqual(code, 1)
        self.assertSeamLine(out, "s3", "FAIL")
        self.assertSeamLine(out, "s6", "FAIL")


if __name__ == "__main__":
    unittest.main()
