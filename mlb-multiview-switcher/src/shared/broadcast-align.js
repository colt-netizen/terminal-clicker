/*
 * Predictive ad-break detection for replays, from public data.
 *
 * MLB's play-by-play for a finished game carries wall-clock timestamps for
 * every play. The gaps between half-innings ARE the ad windows, to the second.
 * A replay pane's playback position (video.currentTime) is readable even on
 * DRM streams. The only unknown is the OFFSET between playback time and the
 * broadcast's wall clock — and every confirmed break (one audio detection, or
 * one user click-away) narrows it: at that moment the position must sit inside
 * SOME ad window, which yields a set of candidate offsets. Two confirmations
 * at different points of the game intersect to a single answer, after which
 * every remaining ad window on that pane is known in advance. Seeks and pauses
 * do not break the alignment — the offset is a property of the recording.
 *
 * Pure: the worker feeds it play-by-play JSON, positions and timestamps.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MLBBroadcastAlign = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  /** Plausible ad-pod length; gaps outside this are data noise, not breaks. */
  const MIN_GAP_MS = 60 * 1000;
  const MAX_GAP_MS = 6 * 60 * 1000;

  /**
   * Extract ad windows (wall-clock ms) from a playByPlay response: the gap
   * between the last play of one half-inning and the first play of the next.
   */
  function adWindows(playByPlay) {
    const plays = (playByPlay && playByPlay.allPlays) || [];
    const windows = [];
    for (let i = 1; i < plays.length; i++) {
      const a = plays[i - 1].about || {};
      const b = plays[i].about || {};
      if (a.inning === b.inning && a.halfInning === b.halfInning) continue;
      const start = Date.parse(a.endTime || '');
      const end = Date.parse(b.startTime || '');
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      const gap = end - start;
      if (gap >= MIN_GAP_MS && gap <= MAX_GAP_MS) windows.push({ start, end });
    }
    return windows;
  }

  /**
   * A confirmed break at playback position posMs means the offset (wall - pos)
   * lies inside one of these intervals — one candidate per ad window.
   */
  function offsetCandidates(windows, posMs) {
    return (windows || []).map((w) => ({ lo: w.start - posMs, hi: w.end - posMs }));
  }

  /**
   * Intersect candidate sets from multiple confirmed breaks. Resolved when
   * exactly one candidate from the newest set is supported by at least two
   * sets (within tolerance) and no rival ties it.
   */
  function resolveOffset(sets, tolMs = 20000, bad = []) {
    if (!sets || !sets.length) return null;
    // Negative evidence gets a wide safety margin: a candidate's midpoint can
    // sit ~half a window away from the true offset, and speech detected just
    // outside a real break must never disqualify the true candidate.
    const badMargin = Math.max(tolMs, 45000);
    const isBad = (x) => (bad || []).some((iv) => x > iv.lo + badMargin && x < iv.hi - badMargin);
    const support = (x) =>
      sets.filter((set) => set.some((iv) => x >= iv.lo - tolMs && x <= iv.hi + tolMs)).length;
    const latest = sets[sets.length - 1];
    let bestSup = 0;
    const scored = latest
      .map((iv) => {
        const mid = (iv.lo + iv.hi) / 2;
        return { mid, sup: support(mid) };
      })
      // Negative evidence: offsets that would have placed confirmed commentary
      // inside an ad window are impossible.
      .filter((s) => !isBad(s.mid));
    for (const s of scored) if (s.sup > bestSup) bestSup = s.sup;
    if (!scored.length) return null;
    // Two positive detections agreeing, OR one detection whittled to a single
    // survivor by negative evidence — either resolves.
    const winners = scored.filter((s) => s.sup === bestSup);
    if (winners.length !== 1) return null;
    if (bestSup >= 2) return { offset: winners[0].mid, support: bestSup };
    if (sets.length === 1 && scored.length === 1) return { offset: winners[0].mid, support: 1 };
    return null;
  }

  /** Merge overlapping/adjacent intervals; keeps the bad-evidence list small. */
  function mergeIntervals(list, joinMs = 5000) {
    const sorted = [...(list || [])].sort((a, b) => a.lo - b.lo);
    const out = [];
    for (const iv of sorted) {
      const last = out[out.length - 1];
      if (last && iv.lo <= last.hi + joinMs) last.hi = Math.max(last.hi, iv.hi);
      else out.push({ ...iv });
    }
    return out;
  }

  /**
   * Is this playback position inside a known ad window? Edges are shrunk so a
   * prediction never clips live action at a boundary.
   */
  function inAdWindow(windows, offset, posMs, edgeMs = 10000) {
    if (!Number.isFinite(offset)) return false;
    const wall = posMs + offset;
    return (windows || []).some((w) => wall >= w.start + edgeMs && wall <= w.end - edgeMs);
  }

  /** Milliseconds until the current predicted window ends (for logs/HUD). */
  function windowRemaining(windows, offset, posMs) {
    if (!Number.isFinite(offset)) return null;
    const wall = posMs + offset;
    const w = (windows || []).find((x) => wall >= x.start && wall <= x.end);
    return w ? w.end - wall : null;
  }

  return { adWindows, offsetCandidates, resolveOffset, mergeIntervals, inAdWindow, windowRemaining };
});
