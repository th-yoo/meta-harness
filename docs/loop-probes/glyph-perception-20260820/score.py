#!/usr/bin/env python3
"""Mechanical scorer per pre-registration.md + amendment-01.md.
Usage: python3 score.py <answers-dir>"""
import os
import sys

TRUTH = "flag{gc0d3_iz_ch4LLenGiNg}"
CONFUSABLE = [set("0O"), set("1lI"), set("5S"), set("2Z")]
EXPECTED_HARD = {7, 10, 13}  # registered before scoring (amendment-01)


def confusable_with(a, b):
    return any(a in s and b in s for s in CONFUSABLE)


def levenshtein_align(w, t):
    """Per-position accuracy for arm W via simple alignment: if lengths equal,
    positional; else dynamic-programming alignment counting matches."""
    if len(w) == len(t):
        return sum(1 for a, b in zip(w, t) if a == b), False
    n, m = len(w), len(t)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            dp[i][j] = max(dp[i - 1][j], dp[i][j - 1],
                           dp[i - 1][j - 1] + (1 if w[i - 1] == t[j - 1] else 0))
    return dp[n][m], True


def main():
    d = sys.argv[1]
    g = []
    for i in range(26):
        with open(os.path.join(d, f"G-{i:02d}.txt")) as f:
            raw = f.read().strip()
        g.append(raw if raw else "?")
    with open(os.path.join(d, "W.txt")) as f:
        w = f.read().strip()

    print(f"truth : {TRUTH}")
    print(f"arm G : {''.join(c if len(c) == 1 else '#' for c in g)}   (# = multi-char answer)")
    print(f"arm W : {w}")

    g_correct = g_abstain = g_confus = 0
    rows = []
    for i, (ans, tru) in enumerate(zip(g, TRUTH)):
        ok = ans == tru
        ab = ans == "?"
        cf = (not ok and not ab and len(ans) == 1 and confusable_with(ans, tru))
        g_correct += ok
        g_abstain += ab
        g_confus += cf
        mark = "OK" if ok else ("ABSTAIN" if ab else ("CONFUSABLE" if cf else "WRONG"))
        rows.append(f"  {i:02d}: truth={tru!r} got={ans!r} {mark}{' [expected-hard]' if i in EXPECTED_HARD else ''}")
    print("\n".join(rows))

    n = len(TRUTH)
    acc_g = g_correct / n
    sub_idx = [i for i in range(n) if i not in EXPECTED_HARD and not any(TRUTH[i] in s for s in CONFUSABLE)]
    sub_correct = sum(1 for i in sub_idx if g[i] == TRUTH[i])

    w_match, w_len_err = levenshtein_align(w, TRUTH)
    acc_w = w_match / n

    print(f"\narm G per-glyph accuracy: {g_correct}/{n} = {acc_g:.3f} (abstain {g_abstain}, confusable-class errors {g_confus})")
    print(f"arm G subgroup (excl. pre-declared hard/confusable, n={len(sub_idx)}): {sub_correct}/{len(sub_idx)} = {sub_correct/len(sub_idx):.3f}")
    print(f"arm W per-position accuracy: {w_match}/{n} = {acc_w:.3f}{' [LENGTH ERROR: ' + str(len(w)) + ' chars]' if w_len_err else ''}")
    print(f"reassembled-string exact match: G={''.join(g) == TRUTH} W={w == TRUTH}")

    shared = [i for i in range(min(len(w), n)) if len(w) == n and w[i] != TRUTH[i] and g[i] != TRUTH[i]]
    if len(w) == n:
        w_only = [i for i in range(n) if w[i] != TRUTH[i] and g[i] == TRUTH[i]]
        g_only = [i for i in range(n) if w[i] == TRUTH[i] and g[i] != TRUTH[i]]
        print(f"error overlap: shared={shared} W-only={w_only} G-only={g_only}")

    print("\nregistered decision rule:")
    if acc_g >= 0.90 and acc_g - acc_w >= 0.10:
        print(f"  accG={acc_g:.3f} >= 0.90 AND lift={acc_g-acc_w:+.3f} >= 0.10 -> RUNG-5 ARM ALIVE")
    elif acc_g <= acc_w:
        print(f"  accG={acc_g:.3f} <= accW={acc_w:.3f} -> decomposition adds nothing -> RUNG-5 DEAD (this fixture class)")
    else:
        print(f"  accG={acc_g:.3f}, accW={acc_w:.3f}, lift={acc_g-acc_w:+.3f} -> INCONCLUSIVE")


if __name__ == "__main__":
    main()
