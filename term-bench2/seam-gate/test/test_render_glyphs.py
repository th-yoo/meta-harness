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
            # explicit 2D cross product: np.cross on 2-vectors was deprecated
            # in numpy 2.0 and REMOVED in 2.5, and this repo's own .venv
            # carries 2.5.1 -- the convenience form would fail there while
            # passing on this host's 1.26.4
            a, b, c = p[0], p[len(p) // 2], p[-1]
            (ux, uy), (vx, vy) = b - a, c - a
            return float(ux * vy - uy * vx)

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
        """A MIRROR is a different cloud, not the same one rotated, so the
        function must not silently normalize it away.

        Scope, stated precisely because an earlier docstring overclaimed it:
        this does NOT pin the single-axis-flip bug. Mirroring v leaves u
        untouched, so r stays positive, no correction runs, and the assertion
        below would pass under a buggy u-only implementation too. The bug is
        pinned by test_correction_is_a_rotation_not_a_mirror and
        test_handedness_is_preserved, both of which fail under it. This test
        guards only against a future version that tries to normalize v.
        """
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
    def _partial_fuse(n=10, width=5.7, gap=0.6, fuse=(1, 2)):
        """The LIKELY failure, as opposed to the exotic one: a few tight-kerned
        glyphs merge while the rest stay correct -- what a slightly-too-large
        cell produces. Median-based statistics cannot see it by construction,
        since a minority cannot move a median."""
        pairs, x = [], 0.0
        for i in range(n):
            if i:
                x += width + (-1.0 if i in fuse else gap)
            pairs += [(x, x + width * 0.53), (x + width * 0.44, x + width)]
        return pairs

    @staticmethod
    def _fused(n=30, width=6.0, step=1.0):
        """The OPPOSITE failure: every component overlaps its neighbour, so the
        whole string collapses into one glyph. Both fragility and coverage
        score this as ideal, which is why it must appear in every direction
        test -- a one-sided healthy/shattered pair passes on an instrument
        that is blind here."""
        return [(i * step, i * step + width) for i in range(n)]

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
        max_intra, min_inter, fragility, coverage = rg.separation_margin(xy, comps)[:4]
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
        healthy_frag = rg.separation_margin(*self._spans(self._healthy())).fragility
        shattered_frag = rg.separation_margin(*self._spans(self._shattered())).fragility
        # ORIENTATION MATTERS AND WAS WRONG HERE ONCE. "Dwarf" means shattered
        # exceeding healthy, so shattered belongs on the left. The transposed
        # form (healthy < shattered * 20) passes on the OLD broken metric --
        # 0.090 < 40 -- and so could not fail on the inversion it named. This
        # form fails on the old metric (2.000 < 1.80 is false) and passes on
        # the new one (0.222 < 1.14). Relative, not absolute: an earlier
        # `shattered < 1.0` would have let a rescaled fixture through at 0.67.
        self.assertLess(
            shattered_frag, healthy_frag * 20,
            "shattered divide must not dwarf the healthy one -- the old width "
            "denominator produced exactly that inversion")

    def test_coverage_detects_shattering_directly(self):
        """Fragility says how close decisions came to flipping; it cannot say
        the partition is RIGHT. Coverage can, in the shattering direction:
        glyphs should account for most of the string's extent."""
        healthy = rg.separation_margin(*self._spans(self._healthy()))
        shattered = rg.separation_margin(*self._spans(self._shattered()))
        self.assertGreater(healthy.coverage, 0.8)
        self.assertLess(shattered.coverage, 0.5)

    def test_fragility_and_coverage_are_both_blind_to_over_merge(self):
        """Pins the blindness itself, so nobody later mistakes either number
        for a general correctness check. A fused partition -- the entire
        string collapsed into ONE glyph -- drives coverage to its theoretical
        maximum (above the correct partition) and fragility to the highest of
        the three. Both rate the worst partition as the best one."""
        healthy = rg.separation_margin(*self._spans(self._healthy()))
        fused = rg.separation_margin(*self._spans(self._fused()))
        self.assertGreater(fused.coverage, healthy.coverage)
        self.assertAlmostEqual(fused.coverage, 1.0, places=6)
        self.assertGreater(fused.fragility, healthy.fragility)

    def test_median_aspect_is_two_sided(self):
        """The detector that does fire in BOTH directions, which neither
        fragility nor coverage does: aspect rises when glyphs fuse and falls
        when they shatter, leaving the correct partition in between. It is
        also the only one of the three carrying a prior from outside the
        artifact -- no Latin glyph is several times wider than it is tall."""
        healthy = rg.separation_margin(*self._spans(self._healthy()))
        shattered = rg.separation_margin(*self._spans(self._shattered()))
        fused = rg.separation_margin(*self._spans(self._fused()))
        self.assertLess(shattered.median_aspect, healthy.median_aspect)
        self.assertGreater(fused.median_aspect, healthy.median_aspect)
        self.assertGreater(fused.median_aspect, rg.ASPECT_HIGH)

    def test_a_few_flat_glyphs_do_not_trip_the_aspect_detector(self):
        """The real fixture contains underscores -- legitimately 6.04 wide by
        0.01 tall. A max-aspect form read 413 on it and fired a false
        OVER-MERGE alarm; the median form must not. No synthetic with uniform
        glyph heights can catch this, which is the point of the test."""
        pairs = self._healthy()
        xy, comps = self._spans(pairs)
        # two genuinely flat glyphs appended beyond the healthy run
        flat = np.array([[100.0, 0.0], [106.0, 0.01], [110.0, 0.0], [117.0, 0.25]])
        xy = np.vstack([xy, flat])
        comps = comps + [np.array([len(xy) - 4, len(xy) - 3]),
                         np.array([len(xy) - 2, len(xy) - 1])]
        m = rg.separation_margin(xy, comps)
        self.assertLess(m.median_aspect, rg.ASPECT_HIGH,
                        "a couple of flat glyphs must not read as over-merge")

    def test_partial_fusion_is_invisible_to_the_median_statistics(self):
        """Pins the blindness so nobody reads median_aspect as a correctness
        check. Three of ten glyphs fused: median aspect and fragility are
        IDENTICAL to healthy, and coverage is HIGHER -- the broken partition
        scoring better than the correct one."""
        healthy = rg.separation_margin(*self._spans(self._healthy()))
        partial = rg.separation_margin(*self._spans(self._partial_fuse()))
        self.assertLess(partial.glyph_count, healthy.glyph_count)  # glyphs were lost
        self.assertAlmostEqual(partial.median_aspect, healthy.median_aspect, places=2)
        self.assertAlmostEqual(partial.fragility, healthy.fragility, places=2)
        self.assertGreater(partial.coverage, healthy.coverage)

    def test_width_ratio_catches_partial_fusion(self):
        """The detector that does see it: one glyph far wider than the median.
        Blind to the cases median_aspect covers, which is why both are
        reported."""
        healthy = rg.separation_margin(*self._spans(self._healthy()))
        partial = rg.separation_margin(*self._spans(self._partial_fuse()))
        shattered = rg.separation_margin(*self._spans(self._shattered()))
        fused = rg.separation_margin(*self._spans(self._fused()))
        self.assertAlmostEqual(healthy.width_ratio, 1.0, places=2)
        self.assertGreater(partial.width_ratio, rg.WIDTH_RATIO_HIGH)
        # its own blind spots, pinned so they are never mistaken for health
        self.assertAlmostEqual(shattered.width_ratio, 1.0, places=2)
        self.assertAlmostEqual(fused.width_ratio, 1.0, places=2)
        self.assertEqual(fused.glyph_count, 1)

    def test_flat_glyphs_do_not_disturb_the_width_ratio(self):
        """The underscores are degenerate in HEIGHT but normal in WIDTH, which
        is why the width axis is the right one for this detector."""
        pairs = self._healthy()
        xy, comps = self._spans(pairs)
        flat = np.array([[100.0, 0.0], [106.0, 0.015], [110.0, 0.0], [117.0, 0.25]])
        xy = np.vstack([xy, flat])
        comps = comps + [np.array([len(xy) - 4, len(xy) - 3]),
                         np.array([len(xy) - 2, len(xy) - 1])]
        self.assertLess(rg.separation_margin(xy, comps).width_ratio,
                        rg.WIDTH_RATIO_HIGH)

    def test_uniform_fusion_defeats_every_trigger(self):
        """The fifth blind spot, pinned so the limits table cannot rot.

        MODELS THE MECHANISM, which an earlier version of this test did not: a
        too-large cell makes two glyphs ONE CONNECTED COMPONENT, so no intra
        gap is recorded for the weld at all. The earlier fixture welded by
        overlapping components 0.01, which recorded a -0.01 intra gap and drove
        fragility to 0.0011 -- firing a trigger the real mechanism leaves
        untouched, so the test contradicted the very cell it pinned. Here each
        fused pair is a single component spanning both glyphs.
        """
        healthy = rg.separation_margin(*self._spans(self._healthy()))
        pairs = self._healthy()
        welded = [(pairs[i][0], pairs[i + 3][1]) for i in range(0, len(pairs) - 3, 4)]
        uniform = rg.separation_margin(*self._spans(welded))

        self.assertLess(uniform.glyph_count, healthy.glyph_count)  # glyphs lost
        # every TRIGGERED statistic reads healthy or better
        self.assertLess(uniform.width_ratio, rg.WIDTH_RATIO_HIGH)
        self.assertLess(uniform.median_aspect, rg.ASPECT_HIGH)
        self.assertGreaterEqual(uniform.coverage, healthy.coverage)
        self.assertGreater(uniform.fragility, rg.FRAGILITY_LOW,
                           "the real mechanism leaves fragility untouched; a "
                           "fixture that trips it is not modelling fusion")
        # pitch_ratio is the one that moves -- which is why it is reported
        self.assertGreater(uniform.pitch_ratio, healthy.pitch_ratio)

    def test_pitch_ratio_is_blind_to_partial_fusion(self):
        """Its own limit, pinned: median width and median gap both barely move
        when a single pair merges, so pitch_ratio cannot see partial fusion --
        which is precisely what width_ratio covers."""
        healthy = rg.separation_margin(*self._spans(self._healthy()))
        partial = rg.separation_margin(*self._spans(self._partial_fuse()))
        self.assertLess(abs(partial.pitch_ratio - healthy.pitch_ratio),
                        0.25 * healthy.pitch_ratio)

    def test_trigger_constants_have_their_documented_values(self):
        """The constants are pinned by VALUE, not merely referenced. Asserting
        a metric against rg.WIDTH_RATIO_HIGH passes if the trigger is lowered,
        so the suite could not otherwise detect the tuning the source forbids
        -- e.g. dropping 2.0 to 1.9 so a known case fires."""
        self.assertEqual(rg.FRAGILITY_LOW, 0.02)
        self.assertEqual(rg.COVERAGE_LOW, 0.5)
        self.assertEqual(rg.ASPECT_HIGH, 2.5)
        self.assertEqual(rg.WIDTH_RATIO_HIGH, 2.0)

    def test_empty_components_do_not_crash(self):
        """A fixture where every component falls below the pixel floor must
        report NaNs, not raise IndexError out of the span scan."""
        m = rg.separation_margin(np.zeros((0, 2)), [])
        self.assertTrue(np.isnan(m.fragility))
        self.assertTrue(np.isnan(m.median_aspect))
        self.assertTrue(np.isnan(m.width_ratio))
        self.assertEqual(m.glyph_count, 0)

    def test_height_denominator_ignores_horizontal_decisions(self):
        """The property that makes the denominator trustworthy: same glyph
        heights, wildly different horizontal partitions -> the scale used for
        fragility must not move with the partition."""
        tall_healthy = self._spans(self._healthy(), height=9.0)
        tall_shattered = self._spans(self._shattered(), height=9.0)
        f1 = rg.separation_margin(*tall_healthy).fragility
        f2 = rg.separation_margin(*self._spans(self._healthy(), height=18.0)).fragility
        # doubling the font height halves fragility; the horizontal layout is
        # unchanged, so this is the denominator responding only to v
        self.assertAlmostEqual(f1, f2 * 2, places=6)
        self.assertTrue(np.isfinite(rg.separation_margin(*tall_shattered).fragility))

    def test_max_intra_below_min_inter_is_vacuous(self):
        """Regression guard for a guard that could not fire. The classifier is
        `lo <= right`, so intra gaps are always <= 0 and inter gaps always > 0
        and `max_intra < min_inter` holds for EVERY artifact -- including this
        deliberately awful one, whose 0.05 split is plainly fragile. Any future
        boolean built on that comparison is dead code."""
        xy, comps = self._spans([(0.0, 5.0), (0.1, 5.1), (5.15, 6.0)])
        max_intra, min_inter, fragility = rg.separation_margin(xy, comps)[:3]
        self.assertLess(max_intra, min_inter)   # vacuously true, hence useless
        self.assertLess(fragility, 0.02)        # the statistic that does discriminate

    def test_fragility_falls_when_a_decision_nears_zero(self):
        """Same glyph layout, one split narrowed towards zero: fragility must
        drop, which is the whole point of reporting it."""
        wide = rg.separation_margin(*self._spans(
            [(0.0, 2.0), (1.5, 3.0), (6.0, 8.0), (7.5, 9.0)])).fragility
        narrow = rg.separation_margin(*self._spans(
            [(0.0, 2.0), (1.5, 3.0), (3.01, 5.0), (4.5, 6.0)])).fragility
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
