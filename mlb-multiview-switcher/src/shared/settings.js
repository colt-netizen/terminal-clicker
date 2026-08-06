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
    // Leave the page alone while the user has the tab explicitly muted.
    respectTabMute: true,
    debugOverlay: false,
  };

  const RANGES = {
    silenceThresholdMs: [500, 60000],
    graceMs: [500, 60000],
    backoffMs: [0, 600000],
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

  async function save(patch) {
    await chrome.storage.sync.set(clampNumbers({ ...DEFAULTS, ...patch }));
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
