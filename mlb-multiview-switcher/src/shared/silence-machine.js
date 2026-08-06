/*
 * Pure state machine deciding *when* to promote a different multiview pane.
 *
 * Kept free of DOM and chrome.* on purpose: the content script drives it with a
 * timer, and tests/silence-machine.test.cjs drives it with a fake clock.
 *
 * Phases:
 *   idle     nothing to do (disabled, muted, or fewer than two panes)
 *   watching audio is flowing; this is the happy state
 *   silent   audio stopped at `since`; switch once threshold elapses
 *   grace    just switched, give the new pane time to come up before judging it
 *   backoff  cycled through every pane without finding audio; wait a while
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MLBSilenceMachine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const PHASES = {
    IDLE: 'idle',
    WATCHING: 'watching',
    SILENT: 'silent',
    GRACE: 'grace',
    BACKOFF: 'backoff',
  };

  const IDLE_STATE = { phase: PHASES.IDLE, since: 0, until: 0, attempts: 0 };

  function initialState() {
    return { ...IDLE_STATE };
  }

  /**
   * Advance the machine one tick.
   *
   * @param {object} state    previous state (from initialState/step)
   * @param {object} input
   * @param {number} input.now         monotonic-ish ms timestamp
   * @param {boolean} input.audible    is the tab currently producing sound
   * @param {boolean} input.blocked    user disabled us, or muted the tab
   * @param {number} input.paneCount   how many switchable panes exist
   * @param {object} input.cfg         {silenceThresholdMs, graceMs, backoffMs}
   * @returns {{state: object, action: null | {type: 'switch'}}}
   */
  function step(state, input) {
    const { now, audible, blocked, paneCount, cfg } = input;

    // Nothing to switch between, or we've been told to stay out of the way.
    if (blocked || paneCount < 2) return { state: { ...IDLE_STATE }, action: null };

    // Sound is flowing. Whatever pane we landed on is the right one, so forget
    // how many attempts it took to get here.
    if (audible) {
      return { state: { phase: PHASES.WATCHING, since: 0, until: 0, attempts: 0 }, action: null };
    }

    switch (state.phase) {
      case PHASES.IDLE:
      case PHASES.WATCHING:
        // Silence just started; start the clock.
        return { state: { ...state, phase: PHASES.SILENT, since: now, until: 0 }, action: null };

      case PHASES.SILENT: {
        if (now - state.since < cfg.silenceThresholdMs) return { state, action: null };

        const attempts = state.attempts + 1;
        // A full lap of every pane with no sound anywhere means the whole
        // multiview is quiet (between innings, say). Stop churning.
        if (attempts >= paneCount) {
          return {
            state: { phase: PHASES.BACKOFF, since: 0, until: now + cfg.backoffMs, attempts: 0 },
            action: { type: 'switch' },
          };
        }
        return {
          state: { phase: PHASES.GRACE, since: 0, until: now + cfg.graceMs, attempts },
          action: { type: 'switch' },
        };
      }

      case PHASES.GRACE:
      case PHASES.BACKOFF:
        if (now >= state.until) {
          return { state: { ...state, phase: PHASES.SILENT, since: now, until: 0 }, action: null };
        }
        return { state, action: null };

      default:
        return { state: { ...IDLE_STATE }, action: null };
    }
  }

  return { PHASES, initialState, step };
});
