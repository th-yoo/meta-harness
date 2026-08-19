"""Tests for the rung-5 dev instrument (render_glyphs.py).

SKIPPED, not failed, when numpy/cv2 are absent: every other module in
seam-gate/ is stdlib-only because it runs in-container, and this suite is the
gate's own. A dev tool's tests must never be able to turn a missing optional
dependency into a gate-suite failure.

Covers the two claims the rung-5 dry-run verdict rests on that were otherwise
evidenced only by "the render came out upright":
  - orient_u_by_file_order corrects a backwards reading order by rotating 180
    degrees (BOTH axes), never by mirroring u alone
  - separation_margin reports how close the merge's decisions sit to flipping,
    derived from the artifact instead of from a shipped constant -- including
    a regression guard proving the boolean it used to return could not fire
"""

import os
import sys
import unittest

_SEAM_GATE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _SEAM_GATE_DIR not in sys.path:
    sys.path.insert(0, _SEAM_GATE_DIR)

try:
    import numpy as np
    import render_glyphs as rg
    _DEPS = True
except ImportError:
    _DEPS = False


@unittest.skipUnless(_DEPS, "render_glyphs needs numpy + cv2 (dev tool, never staged in-container)")
class TestOrientUByFileOrder(unittest.TestCase):
    """u's sign is recovered from the order the slicer emitted points in."""

    @staticmethod
    def _text_like(n=200):
        """Points whose u runs forward with file index and whose v is
        deliberately ASYMMETRIC about 0 -- an asymmetric v is what makes a
        mirror distinguishable from a rotation."""
        u = np.linspace(-10.0, 10.0, n)
        v = np.linspace(0.0, 3.0, n) ** 2
        return np.column_stack([u, v])

    def test_forward_order_is_left_untouched(self):
        xy = self._text_like()
        out, r = rg.orient_u_by_file_order(xy)
        self.assertGreater(r, 0.9)
        np.testing.assert_allclose(out, xy)

    def test_backwards_order_is_corrected(self):
        xy = self._text_like()
        out, r = rg.orient_u_by_file_order(xy[::-1].copy())
        self.assertGreater(r, 0.9)
        # reading order now runs forward with file index again
        self.assertLess(out[0, 0], out[-1, 0])

    def test_correction_is_a_rotation_not_a_mirror(self):
        """The load-bearing one. A 180-degree rotation negates BOTH axes;
        mirroring u alone would leave v untouched, silently undoing the
        viewing-side pin the plane normal established and rendering the text
        mirrored. Asserted on v, because that is the axis the two differ on."""
        xy = self._text_like()[::-1].copy()
        out, _ = rg.orient_u_by_file_order(xy)
        np.testing.assert_allclose(out, -xy)
        # explicitly: v was negated, not carried through unchanged
        self.assertFalse(np.allclose(out[:, 1], xy[:, 1]))
        np.testing.assert_allclose(out[:, 1], -xy[:, 1])

    def test_handedness_is_preserved(self):
        """Signed area of a triangle is invariant under rotation and flips
        sign under a mirror -- the coordinate-free statement of the above."""
        xy = self._text_like()[::-1].copy()
        out, _ = rg.orient_u_by_file_order(xy)

        def signed_area(p):
            a, b, c = p[0], p[len(p) // 2], p[-1]
            return float(np.cross(b - a, c - a))

        before, after = signed_area(xy), signed_area(out)
        self.assertNotAlmostEqual(before, 0.0, msg="degenerate fixture: collinear points")
        self.assertAlmostEqual(before, after, places=6)

    def test_rotating_the_input_180_degrees_is_a_no_op(self):
        """The property version, which holds for ANY fixture rather than the
        one whose answer was already known: rotating the whole cloud 180
        degrees in-plane (negating both coordinates) reverses the reading
        order, so the correction must undo it exactly and return the same
        projection and the same |r|."""
        xy = self._text_like()
        base, r_base = rg.orient_u_by_file_order(xy)
        rotated, r_rot = rg.orient_u_by_file_order(-xy)
        np.testing.assert_allclose(rotated, base)
        self.assertAlmostEqual(r_base, r_rot, places=12)

    def test_mirroring_one_axis_is_not_absorbed(self):
        """The companion negative: a MIRROR is a different cloud, not the same
        one rotated, so the function must not silently normalize it away. This
        pins the distinction the live bug turned on -- correcting with a
        single-axis flip would have made these two indistinguishable."""
        xy = self._text_like()
        base, _ = rg.orient_u_by_file_order(xy)
        mirrored, _ = rg.orient_u_by_file_order(xy * np.array([1.0, -1.0]))
        self.assertFalse(np.allclose(mirrored, base))

    def test_weak_correlation_is_reported_not_hidden(self):
        """A fixture whose file order does not run along the text must surface
        a low |r| so the caller can refuse, rather than be handed an
        orientation this rule cannot justify."""
        rs = np.random.RandomState(0)
        xy = np.column_stack([rs.uniform(-10, 10, 400), rs.uniform(-3, 3, 400)])
        _, r = rg.orient_u_by_file_order(xy)
        self.assertLess(r, 0.5)


@unittest.skipUnless(_DEPS, "render_glyphs needs numpy + cv2 (dev tool, never staged in-container)")
class TestSeparationMargin(unittest.TestCase):
    """The merge is justified per artifact, never by a shipped tolerance."""

    @staticmethod
    def _spans(pairs, height=9.0):
        """Fake components: each (lo, hi) becomes a 2-point index array whose
        u-span is exactly that interval. Height is the v-extent every
        component spans -- font-fixed in a real artifact, which is why the
        fragility denominator uses it."""
        xy = []
        comps = []
        for lo, hi in pairs:
            comps.append(np.array([len(xy), len(xy) + 1]))
            xy.extend([[lo, 0.0], [hi, height]])
        return np.array(xy, dtype=float), comps

    @staticmethod
    def _healthy(n=10, width=5.7, gap=0.6):
        """n glyphs, each two overlapping components, cleanly separated."""
        pairs, x = [], 0.0
        for _ in range(n):
            pairs += [(x, x + width * 0.53), (x + width * 0.44, x + width)]
            x += width + gap
        return pairs

    @staticmethod
    def _shattered(n=30, width=1.0, gap=2.0):
        """The failure mode: every glyph broken into narrow fragments with
        wide gaps between them -- what a too-small cell or broken projection
        produces."""
        pairs, x = [], 0.0
        for _ in range(n):
            pairs.append((x, x + width))
            x += width + gap
        return pairs

    def test_margins_describe_the_closest_decisions(self):
        # two glyphs of two overlapping components each, a wide gap between
        xy, comps = self._spans([(0.0, 2.0), (1.5, 3.0), (6.0, 8.0), (7.5, 9.0)])
        max_intra, min_inter, fragility, coverage = rg.separation_margin(xy, comps)
        self.assertLess(max_intra, 0.0)      # intra-glyph gaps are overlaps
        self.assertGreater(min_inter, 0.0)
        self.assertGreater(fragility, 0.0)
        self.assertGreater(coverage, 0.5)

    def test_fragility_is_not_inflated_by_a_shattered_divide(self):
        """Regression guard for a metric that rewarded the failure it was
        meant to catch. Normalizing by median glyph WIDTH used the partition
        under test as its own denominator, so a shattered divide -- narrow
        fragments, wide gaps -- scored ~23x SAFER than a healthy one (0.088 vs
        2.000, measured). Median glyph HEIGHT is orthogonal to every
        horizontal merge decision, so shattering can no longer inflate it."""
        _, _, healthy_frag, _ = rg.separation_margin(*self._spans(self._healthy()))
        _, _, shattered_frag, _ = rg.separation_margin(*self._spans(self._shattered()))
        self.assertLess(
            shattered_frag, 1.0,
            "shattered divide must not score as near-certainly-safe")
        self.assertLess(
            healthy_frag, shattered_frag * 20,
            "shattered divide must not dwarf the healthy one -- the old width "
            "denominator produced exactly that inversion")

    def test_coverage_detects_shattering_directly(self):
        """Fragility says how close decisions came to flipping; it cannot say
        the partition is RIGHT. Coverage can: glyphs should account for most
        of the string's extent."""
        _, _, _, healthy_cov = rg.separation_margin(*self._spans(self._healthy()))
        _, _, _, shattered_cov = rg.separation_margin(*self._spans(self._shattered()))
        self.assertGreater(healthy_cov, 0.8)
        self.assertLess(shattered_cov, 0.5)

    def test_height_denominator_ignores_horizontal_decisions(self):
        """The property that makes the denominator trustworthy: same glyph
        heights, wildly different horizontal partitions -> the scale used for
        fragility must not move with the partition."""
        tall_healthy = self._spans(self._healthy(), height=9.0)
        tall_shattered = self._spans(self._shattered(), height=9.0)
        _, _, f1, _ = rg.separation_margin(*tall_healthy)
        _, _, f2, _ = rg.separation_margin(*self._spans(self._healthy(), height=18.0))
        # doubling the font height halves fragility; the horizontal layout is
        # unchanged, so this is the denominator responding only to v
        self.assertAlmostEqual(f1, f2 * 2, places=6)
        self.assertTrue(np.isfinite(rg.separation_margin(*tall_shattered)[2]))

    def test_max_intra_below_min_inter_is_vacuous(self):
        """Regression guard for a guard that could not fire. The classifier is
        `lo <= right`, so intra gaps are always <= 0 and inter gaps always > 0
        and `max_intra < min_inter` holds for EVERY artifact -- including this
        deliberately awful one, whose 0.05 split is plainly fragile. Any future
        boolean built on that comparison is dead code."""
        xy, comps = self._spans([(0.0, 5.0), (0.1, 5.1), (5.15, 6.0)])
        max_intra, min_inter, fragility, _ = rg.separation_margin(xy, comps)
        self.assertLess(max_intra, min_inter)   # vacuously true, hence useless
        self.assertLess(fragility, 0.02)        # the statistic that does discriminate

    def test_fragility_falls_when_a_decision_nears_zero(self):
        """Same glyph layout, one split narrowed towards zero: fragility must
        drop, which is the whole point of reporting it."""
        _, _, wide, _ = rg.separation_margin(*self._spans(
            [(0.0, 2.0), (1.5, 3.0), (6.0, 8.0), (7.5, 9.0)]))
        _, _, narrow, _ = rg.separation_margin(*self._spans(
            [(0.0, 2.0), (1.5, 3.0), (3.01, 5.0), (4.5, 6.0)]))
        self.assertLess(narrow, wide)

    def test_merge_at_zero_is_plain_overlap(self):
        """gap_tol=0 must be the DEFINITION of "spans overlap" -- components
        that merely touch-but-do-not-overlap stay separate glyphs."""
        xy, comps = self._spans([(0.0, 2.0), (2.5, 4.0)])
        self.assertEqual(len(rg.merge_by_u_overlap(xy, comps, 0.0)), 2)
        xy, comps = self._spans([(0.0, 2.0), (1.9, 4.0)])
        self.assertEqual(len(rg.merge_by_u_overlap(xy, comps, 0.0)), 1)


if __name__ == "__main__":
    unittest.main()
