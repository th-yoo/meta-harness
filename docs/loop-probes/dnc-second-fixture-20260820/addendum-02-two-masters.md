# Addendum 02 — F1 root cause: the derived delta serves two masters (2026-08-20)

Source: cross-lane review (meta-harness-1e) of addendum-01's F1 finding.
Design input for the arming increment; nothing implemented here.

## The structural read

`delta = |b| · minΔu / 2` answers ONE question correctly: *when is a claimed
pairing UNAMBIGUOUS* — a pairing-disambiguation bound, properly derived from
constellation geometry. The merge gate ALSO uses it as the RESIDUAL
ACCEPTANCE bound (*how wrong may the fit be*), whose honest source is the
measurement noise floor (instrument line width / peak-position uncertainty
under the smoothing scale) — geometry-INDEPENDENT. On a wide-span
constellation the two diverge by construction: spacing grows, noise does
not, and the residual check inherits the loose bound. Fixture 2's quadratic
arm passed residuals because 487.5 was a pairing bound doing a noise
bound's job.

## Fix shape (for the arming spec, answer-free)

TWO derived tolerances:
- `delta_pair` from spacing — pairing disambiguation only;
- `delta_fit` from the noise floor — residual acceptance.

Both derivable from the artifact; no new constant. The wide-span seam
closes structurally.

## Blocker consolidation hypothesis

The §8.2 derived R threshold and `delta_fit` are siblings — both come from
the fit's own noise/conditioning. Check whether ONE derivation discharges
BOTH before deriving them separately. If so, the arming blockers reduce
from three to two (noise-derived tolerance family + §8.8 value-truth).
