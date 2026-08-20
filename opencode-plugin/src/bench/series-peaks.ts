/** Scale-persistent peak detection — D&C spec §6.1 divide step. SHIPS OFF.
 * Parameters are the probe's pre-registered values (dnc-merge-fit-20260820)
 * and are NEVER tuned against an expected peak count or identity: windows
 * odd 5..101, 90th-percentile threshold, persistence >= 5 consecutive scales
 * at +/-3 samples. Survivor set is never trimmed by expected count. */
export function detectPeaks(ys: number[]): number[] {
  const perScale: number[][] = []
  for (let w = 5; w <= 101; w += 2) {
    const half = (w / 2) | 0
    const sm: number[] = []
    for (let i = 0; i < ys.length; i++) {
      const lo = Math.max(0, i - half)
      const hi = Math.min(ys.length, i + half + 1)
      let s = 0
      for (let j = lo; j < hi; j++) s += ys[j]!
      sm.push(s / (hi - lo))
    }
    const thresh = [...sm].sort((a, b) => a - b)[(0.9 * sm.length) | 0]!
    const peaks: number[] = []
    for (let i = 1; i < sm.length - 1; i++) {
      if (sm[i]! > sm[i - 1]! && sm[i]! >= sm[i + 1]! && sm[i]! > thresh) peaks.push(i)
    }
    perScale.push(peaks)
  }
  const survivors: number[] = []
  for (const p of perScale[0]!) {
    let pos = p
    let run = 1
    for (let s = 1; s < perScale.length; s++) {
      const match = perScale[s]!.find((q) => Math.abs(q - pos) <= 3)
      if (match === undefined) break
      pos = match
      run++
    }
    if (run >= 5) survivors.push(p)
  }
  const merged: number[] = []
  for (const p of survivors.sort((a, b) => a - b)) {
    if (merged.length && p - merged[merged.length - 1]! <= 3) continue
    merged.push(p)
  }
  return merged
}
