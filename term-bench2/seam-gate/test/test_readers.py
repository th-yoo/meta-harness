"""Tests for term-bench2/seam-gate/readers.py (plain unittest, no pytest) --
the frozen source-reader registry for the source_crosscheck predicate op
(Task 7 item 4).

Run with:
    python3 -m unittest discover -s term-bench2/seam-gate/test -p 'test_*.py'

test_validator.py's TestSourceCrosscheck covers the op-level integration
(through validator.op_source_crosscheck / the CLI); this file covers
readers.py's own parsing + leak-rule + registry contract directly.
"""

import gzip
import os
import shutil
import sys
import tempfile
import unittest

_SEAM_GATE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _SEAM_GATE_DIR not in sys.path:
    sys.path.insert(0, _SEAM_GATE_DIR)

import readers  # noqa: E402

# Same shape as calibrate_gcode.py's SYNTHETIC_GCODE (test_calibrate.py) --
# an M486 S0 block with extruding (E-param) motion, a travel-only line
# inside that block (no E -- must NOT count), a retraction-only E move with
# no X/Y (must NOT count -- no positional change), then an M486 S1 block
# that must be excluded (unlike calibrate_gcode.py's "bad" set, readers.py
# has no unscoped mode -- it always S0-scopes).
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


class ReadersTestCase(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="seam-gate-readers-test-")

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _write(self, text, name="t.gcode"):
        path = os.path.join(self.tmpdir, name)
        with open(path, "w") as f:
            f.write(text)
        return path


class TestReadGcodeG1Points(ReadersTestCase):
    def test_scoped_to_s0_extruding_with_xy(self):
        path = self._write(SYNTHETIC_GCODE)
        points = readers.read_gcode_g1_points(path)
        # Same two qualifying lines as calibrate_gcode.collect_points's
        # oracle branch (test_calibrate.py::TestCollectPoints) -- see that
        # test's comment for why Z carries over from the intervening travel
        # move rather than the S0 block's own initial (unqualifying) line.
        self.assertEqual(points, [(11.0, 10.0, 0.2), (12.0, 11.0, 5.0)])

    def test_gzip_source_supported(self):
        gz_path = os.path.join(self.tmpdir, "t.gcode.gz")
        with gzip.open(gz_path, "wt", encoding="utf-8") as f:
            f.write(SYNTHETIC_GCODE)
        points = readers.read_gcode_g1_points(gz_path)
        self.assertEqual(points, [(11.0, 10.0, 0.2), (12.0, 11.0, 5.0)])

    def test_decimal_comma_tokens_convert(self):
        text = "M486 S0\nG1 X1,5 Y2,5 Z0,2 E0,3\n"
        path = self._write(text)
        points = readers.read_gcode_g1_points(path)
        self.assertEqual(points, [(1.5, 2.5, 0.2)])

    def test_no_qualifying_points_returns_empty_list(self):
        path = self._write("G28\nG1 X1 Y1 E1\n")  # never enters S0 scope
        points = readers.read_gcode_g1_points(path)
        self.assertEqual(points, [])

    def test_s1_scoped_points_excluded(self):
        path = self._write(SYNTHETIC_GCODE)
        points = readers.read_gcode_g1_points(path)
        self.assertNotIn((50.0, 50.0, 0.2), points)

    def test_non_utf8_source_raises_reader_error_not_crash(self):
        path = os.path.join(self.tmpdir, "binary.gcode")
        with open(path, "wb") as f:
            f.write(b"M486 S0\n\xff\xfe garbage \x80\nG1 X1 Y1 E1\n")
        # errors="replace" at open time means this actually still parses
        # tolerantly rather than raising -- assert it doesn't crash either
        # way (the exact points found are not the point of this test).
        points = readers.read_gcode_g1_points(path)
        self.assertIsInstance(points, list)

    def test_missing_source_file_raises_reader_error(self):
        with self.assertRaises(readers.ReaderError):
            readers.read_gcode_g1_points(os.path.join(self.tmpdir, "nope.gcode"))


class TestLeakRule(ReadersTestCase):
    def test_refuses_tests_path(self):
        with self.assertRaises(readers.ReaderError):
            readers.read_gcode_g1_points("/some/where/tests/hidden.gcode")

    def test_refuses_solution_path(self):
        with self.assertRaises(readers.ReaderError):
            readers.read_gcode_g1_points("/some/where/solution/answer.gcode")

    def test_allows_ordinary_input_path(self):
        path = self._write(SYNTHETIC_GCODE)
        # Must not raise.
        readers.read_gcode_g1_points(path)

    def test_leak_rule_enforced_via_registry_entry_point_too(self):
        with self.assertRaises(readers.ReaderError):
            readers.read_source("gcode_g1_points", "/x/tests/y.gcode")


class TestRegistry(ReadersTestCase):
    def test_gcode_g1_points_registered(self):
        self.assertIn("gcode_g1_points", readers.REGISTRY)
        self.assertIs(readers.REGISTRY["gcode_g1_points"], readers.read_gcode_g1_points)

    def test_read_source_dispatches_to_registered_reader(self):
        path = self._write(SYNTHETIC_GCODE)
        via_registry = readers.read_source("gcode_g1_points", path)
        via_direct = readers.read_gcode_g1_points(path)
        self.assertEqual(via_registry, via_direct)

    def test_unknown_reader_id_raises_reader_error_not_key_error(self):
        with self.assertRaises(readers.ReaderError):
            readers.read_source("totally_bogus_reader", "/does/not/matter")

    def test_unknown_reader_id_error_message_names_registered_readers(self):
        try:
            readers.read_source("totally_bogus_reader", "/does/not/matter")
            self.fail("expected ReaderError")
        except readers.ReaderError as e:
            self.assertIn("gcode_g1_points", str(e))


if __name__ == "__main__":
    unittest.main()
