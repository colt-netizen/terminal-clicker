/*
 * Picks which pane should carry the audio.
 *
 * This replaced blind rotation once we learned MLB renders a literal
 * "Commercial break in progress" banner into the pane that is on a break. That
 * is a per-pane, unambiguous signal, so there is no need to hop around hunting
 * for sound: we can just pick the best pane directly.
 *
 * "Best" means the user's highest-priority game that is not currently on a
 * break. That definition gets return-to-favourite for free — when the top game
 * comes back from its break it outranks whatever we fell back to, so the next
 * evaluation moves back on its own.
 *
 * Pure: no DOM, no chrome.*.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MLBPaneSelector = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const UNRANKED = Number.MAX_SAFE_INTEGER;

  /** Position in the user's priority list; unlisted panes sort last. */
  function rankOf(key, priorities) {
    if (!key || !priorities) return UNRANKED;
    const i = priorities.indexOf(key);
    return i === -1 ? UNRANKED : i;
  }

  /**
   * @param {object} input
   * @param {Array<{key: string, inBreak: boolean, notLive?: boolean, notLiveReason?: string}>}
   *   input.panes  in display order; notLive marks a pane whose game is not
   *   currently being played (final, not started, delayed, filler feed)
   * @param {string[]} input.priorities     pane keys, best first
   * @param {number} input.currentIndex     pane carrying audio now, -1 if unknown
   * @param {boolean} input.audioDead       silence machine says nothing is playing
   * @returns {{index: number, reason: string} | null}  null means stay put
   */
  function choose({ panes, priorities, currentIndex, audioDead }) {
    if (!panes || panes.length < 2) return null;

    const ranked = panes.map((pane, index) => ({
      index,
      inBreak: Boolean(pane.inBreak),
      notLive: Boolean(pane.notLive),
      notLiveReason: pane.notLiveReason,
      // Between half-innings: not a reason to leave (that would bounce the
      // audio every half-inning), but never a destination either — arriving
      // during the commercial window buys zero seconds of baseball.
      paused: Boolean(pane.paused),
      rank: rankOf(pane.key, priorities),
    }));

    const available = ranked.filter((p) => !p.inBreak && !p.notLive && !p.paused);
    // Every game is on a break at once. Moving would only trade one break for
    // another, so hold and let the caller back off.
    if (!available.length) return null;

    // Lowest rank wins; ties fall back to display order so the choice is stable.
    const pick = (list) =>
      list.reduce((a, b) => (b.rank < a.rank || (b.rank === a.rank && b.index < a.index) ? b : a));

    const current = currentIndex >= 0 && currentIndex < ranked.length ? ranked[currentIndex] : null;
    if (!current) return { index: pick(available).index, reason: 'no pane is carrying audio' };

    // Everything below is about leaving where we are, so the current pane is
    // never a candidate — otherwise sitting on a live-but-silent favourite
    // would re-select itself forever.
    const alternatives = available.filter((p) => p.index !== currentIndex);
    if (!alternatives.length) return null;
    const other = pick(alternatives);

    if (current.inBreak) return { index: other.index, reason: 'current pane is on a commercial break' };
    if (current.notLive) {
      return { index: other.index, reason: current.notLiveReason || 'current pane is not live baseball' };
    }
    if (other.rank < current.rank) return { index: other.index, reason: 'a higher-priority game is available' };
    if (audioDead) return { index: other.index, reason: 'no audio on the current pane' };

    return null;
  }

  /**
   * Merge freshly discovered pane keys into a stored priority list: keep the
   * user's ordering, append anything new, and drop nothing (a game that
   * disappears when they switch from 4-game to 2-game mode should keep its
   * place for when it comes back).
   */
  function mergePriorities(priorities, keys) {
    const merged = [...(priorities || [])];
    for (const key of keys || []) {
      if (key && !merged.includes(key)) merged.push(key);
    }
    return merged;
  }

  /** Move a key one slot up or down; returns a new array. */
  function reorder(priorities, key, delta) {
    const list = [...(priorities || [])];
    const from = list.indexOf(key);
    if (from === -1) return list;
    const to = Math.min(list.length - 1, Math.max(0, from + delta));
    if (to === from) return list;
    list.splice(to, 0, list.splice(from, 1)[0]);
    return list;
  }

  return { UNRANKED, rankOf, choose, mergePriorities, reorder };
});
