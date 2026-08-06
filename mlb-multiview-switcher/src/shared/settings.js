/* Shared defaults + storage helpers. Loaded as a classic script by the content
 * script, the popup, and the options page. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MLBSettings = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DEFAULTS = {
    enabled: true,
    // How long the tab must stay silent before we move on. Note that Chrome
    // itself sits on the audible flag for ~2s before flipping it false, so the
    // wall-clock delay is roughly this value plus 2 seconds.
    silenceThresholdMs: 3000,
    // Breathing room after a switch, so a pane that is still buffering does not
    // immediately count as silent.
    graceMs: 4000,
    // Cooldown after cycling every pane without finding audio.
    backoffMs: 20000,
    // CSS selector for pane containers. Empty means "infer from the video
    // elements", which is what you want unless the heuristic misfires.
    paneSelector: '',
    // Matched (case-insensitively) against each pane's text. MLB renders
    // "Commercial Break in Progress" over the paused game, which is a far more
    // reliable break signal than anything we can infer from the audio.
    breakText: 'commercial break',
    // Pane keys, best first. Managed from the popup.
    priorities: [],
    // Team names/abbreviations, best first ("SD", "Padres", ...). Outranks the
    // per-feed list: a game featuring a ranked team beats any unranked game.
    teamPriorities: [],
    // Manual pane->gamePk assignments from the popup, for layouts where
    // automatic identification has nothing to read. {paneKey: gamePk}
    paneAssignments: {},
    // Swap panes showing dead games (final / not started) for live games found
    // on the rail. The point of knowing every game's state.
    autoTune: true,
    // Focus layout (one main stage + side tiles): when the switcher moves
    // audio to a tile, press the tile's swap control so the audible game
    // takes the main stage with it. User clicks never rearrange the layout.
    pushToMain: true,
    // CSS selector for rail game cards, same escape-hatch idea as paneSelector.
    railSelector: '',
    // Analyse captured tab audio to notice when commentary stops even without a
    // break banner. Costs a tabCapture permission prompt, so it is opt-in.
    listenMode: false,
    // How far above the ambient floor commentary has to sit, in dB.
    speechMarginDb: 7,
    // Leave the page alone while the user has the tab explicitly muted.
    respectTabMute: true,
    debugOverlay: false,
  };

  const RANGES = {
    silenceThresholdMs: [500, 60000],
    graceMs: [500, 60000],
    backoffMs: [0, 600000],
    speechMarginDb: [1, 40],
  };

  function clampNumbers(values) {
    const out = { ...values };
    for (const [key, [min, max]] of Object.entries(RANGES)) {
      const n = Number(out[key]);
      out[key] = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : DEFAULTS[key];
    }
    return out;
  }

  async function load() {
    const stored = await chrome.storage.sync.get(DEFAULTS);
    return clampNumbers({ ...DEFAULTS, ...stored });
  }

  /**
   * Merges over what is *stored*, not over DEFAULTS — the options page only
   * knows about its own fields, and merging over defaults would silently reset
   * everything it does not render (the priority list, most importantly).
   */
  async function save(patch) {
    const current = await load();
    await chrome.storage.sync.set(clampNumbers({ ...current, ...patch }));
  }

  /** Fires `handler(settings)` whenever any setting changes. */
  function onChange(handler) {
    chrome.storage.onChanged.addListener(async (_changes, area) => {
      if (area !== 'sync') return;
      handler(await load());
    });
  }

  return { DEFAULTS, RANGES, clampNumbers, load, save, onChange };
});
