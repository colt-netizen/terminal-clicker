/*
 * Service worker. Three jobs:
 *
 *  1. Decide whether the tab currently has commentary on it. Two sources, in
 *     order of preference:
 *       - Listen mode: the offscreen document analyses captured tab audio and
 *         reports whether anyone is talking. This is the only thing that
 *         notices a commercial break, because a break is not silent — crowd
 *         noise and PA echo keep the tab "audible" the whole way through.
 *       - Otherwise Chrome's per-tab `audible` flag, which costs nothing and
 *         needs no permission, but is a boolean: it only goes false on true
 *         silence.
 *     Web Audio on the <video> itself is not an option — MLB.tv is Widevine
 *     protected, so createMediaElementSource yields silence, and its rerouting
 *     is irreversible.
 *
 *  2. Own the rotation cursor. Panes may all live in the top document or each
 *     be its own iframe; frames report what they see and this stitches them
 *     into one ordered list.
 *
 *  3. Manage the offscreen document's lifecycle.
 *
 * Deliberately no timers: MV3 workers are killed after ~30s idle, so the clock
 * lives in the content script and this is woken by its messages.
 */

importScripts('shared/pane-selector.js', 'shared/settings.js');
const Selector = globalThis.MLBPaneSelector;
const Settings = globalThis.MLBSettings;

/** tabId -> Map<frameId, {panes, primaryLocal, ts}> */
const frames = new Map();
/** tabId -> last status pushed by the coordinator frame, for the popup. */
const status = new Map();
/** tabId -> {speechPresent, recentDb, floorDb, ts} from the offscreen analyser. */
const speech = new Map();
/**
 * tabId -> index of the pane we most recently promoted.
 *
 * This is why rotation is stateful rather than re-derived each pass. MLB
 * re-asserts its own mute state after a click, so a moment later no pane looks
 * primary at all — and a findIndex that returns -1 sends every rotation back to
 * pane 0. Remembering where we went keeps the cursor moving.
 */
const cursor = new Map();

const FRAME_TTL_MS = 5000;
const SPEECH_TTL_MS = 2000;
/**
 * Quiet window after a switch. Frames only report once a second, so for a beat
 * after a promotion the roster still names the *old* pane as primary — without
 * this, the next evaluation would decide to switch again and keep re-promoting
 * until the reports caught up.
 */
const SWITCH_COOLDOWN_MS = 2500;

/** tabId -> timestamp of the last promotion. */
const lastSwitch = new Map();

/**
 * Settings are read on every tick, which is three times a second per tab. Cache
 * them and let storage events invalidate, rather than hitting chrome.storage in
 * a hot path.
 */
let settingsCache = null;
async function currentSettings() {
  if (!settingsCache) settingsCache = await Settings.load();
  return settingsCache;
}
chrome.storage.onChanged.addListener((_changes, areaName) => {
  if (areaName === 'sync') settingsCache = null;
});

function frameMap(tabId) {
  let m = frames.get(tabId);
  if (!m) {
    m = new Map();
    frames.set(tabId, m);
  }
  return m;
}

/** Frames that have reported recently, main frame first. */
function liveFrames(tabId, now) {
  const m = frames.get(tabId);
  if (!m) return [];
  for (const [frameId, info] of m) {
    if (now - info.ts > FRAME_TTL_MS) m.delete(frameId);
  }
  return [...m.entries()]
    .map(([frameId, info]) => ({ frameId, ...info }))
    .sort((a, b) => a.frameId - b.frameId);
}

/**
 * Flatten every frame's panes into one addressable list. Order is by frame id
 * then DOM order — not necessarily visual order, which is fine: we only need a
 * stable rotation, not a specific one.
 */
function paneList(tabId, now) {
  const out = [];
  for (const frame of liveFrames(tabId, now)) {
    (frame.panes || []).forEach((pane, local) => {
      out.push({
        frameId: frame.frameId,
        local,
        key: pane.key,
        label: pane.label,
        inBreak: Boolean(pane.inBreak),
        isPrimary: frame.primaryLocal === local,
      });
    });
  }
  return out;
}

async function tabAudio(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return { audible: Boolean(tab.audible), muted: Boolean(tab.mutedInfo && tab.mutedInfo.muted) };
  } catch {
    return { audible: false, muted: false, gone: true };
  }
}

/**
 * The signal the silence machine actually runs on. Listen mode wins when its
 * reading is fresh; otherwise fall back to the tab flag.
 */
function audioState(tabId, tabInfo, now) {
  const heard = speech.get(tabId);
  if (heard && now - heard.ts < SPEECH_TTL_MS) {
    return {
      ...tabInfo,
      audible: heard.speechPresent,
      source: 'speech',
      recentDb: heard.recentDb,
      floorDb: heard.floorDb,
      listening: true,
    };
  }
  return { ...tabInfo, source: 'tab-flag', listening: false };
}

/** Where the audio is right now: what the page reports, else where we put it. */
function currentIndex(tabId, panes) {
  const detected = panes.findIndex((p) => p.isPrimary);
  if (detected >= 0) return detected;
  const remembered = cursor.has(tabId) ? cursor.get(tabId) : -1;
  return remembered < panes.length ? remembered : -1;
}

/** Move the audio to a specific pane. */
async function promoteIndex(tabId, panes, index) {
  const target = panes[index];
  if (!target) return { ok: false, reason: 'pane index out of range' };
  cursor.set(tabId, index);
  lastSwitch.set(tabId, Date.now());

  const sends = liveFrames(tabId, Date.now()).map((frame) => {
    const message =
      frame.frameId === target.frameId
        ? { type: 'promote', local: target.local }
        : { type: 'demote' };
    return chrome.tabs
      .sendMessage(tabId, message, { frameId: frame.frameId })
      .catch(() => null); // a frame can vanish mid-switch; not fatal
  });
  await Promise.all(sends);
  return { ok: true, index, label: target.label };
}

/**
 * Decide whether the audio should move, and move it. Break banners are checked
 * every tick — a break is a definite, per-pane fact, so it does not need to
 * wait out the silence timer the way ambiguous dead air does.
 */
async function evaluate(tabId, { audioDead, blocked }) {
  const now = Date.now();
  if (now - (lastSwitch.get(tabId) || 0) < SWITCH_COOLDOWN_MS) return { switched: false };

  const panes = paneList(tabId, now);
  if (blocked || panes.length < 2) return { switched: false };

  const settings = await currentSettings();
  if (!settings.enabled) return { switched: false };

  const priorities = Selector.mergePriorities(
    settings.priorities,
    panes.map((p) => p.key)
  );
  // Persist newly seen games so they show up in the popup's priority list.
  if (priorities.length !== (settings.priorities || []).length) {
    settingsCache = { ...settings, priorities };
    await Settings.save({ priorities });
  }

  const decision = Selector.choose({
    panes,
    priorities: settingsCache ? settingsCache.priorities : priorities,
    currentIndex: currentIndex(tabId, panes),
    audioDead,
  });
  if (!decision) return { switched: false };

  const result = await promoteIndex(tabId, panes, decision.index);
  return { switched: result.ok, ...result, reason: decision.reason };
}

/** Manual "switch now": step to the next pane regardless of state. */
async function rotate(tabId) {
  const panes = paneList(tabId, Date.now());
  if (panes.length < 2) return { ok: false, reason: 'need at least two panes' };
  const from = currentIndex(tabId, panes);
  return promoteIndex(tabId, panes, (from + 1) % panes.length);
}

// ------------------------------------------------------------- listen mode

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length) return;
  await chrome.offscreen.createDocument({
    url: 'src/offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Analyse captured tab audio to detect when commentary stops.',
  });
}

async function startListening({ tabId, streamId, cfg, band }) {
  try {
    await ensureOffscreen();
    const result = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'startCapture',
      tabId,
      streamId,
      cfg,
      band,
    });
    if (!result || !result.ok) {
      speech.delete(tabId);
      return result || { ok: false, reason: 'offscreen did not respond' };
    }
    return { ok: true };
  } catch (error) {
    speech.delete(tabId);
    return { ok: false, reason: String((error && error.message) || error) };
  }
}

async function stopListening(tabId) {
  speech.delete(tabId);
  try {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stopCapture' });
  } catch {
    // Offscreen document may already be gone.
  }
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    // Not open; nothing to close.
  }
  return { ok: true };
}

// ----------------------------------------------------------------- routing

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab && sender.tab.id;

  switch (msg.type) {
    // Every frame, once a second: what it can see.
    case 'report': {
      if (tabId == null) return false;
      frameMap(tabId).set(sender.frameId ?? 0, {
        panes: msg.panes || [],
        primaryLocal: msg.primaryLocal,
        ts: Date.now(),
      });
      return false;
    }

    // The coordinator asking whether the audio should move.
    case 'evaluate': {
      if (tabId == null) return false;
      evaluate(tabId, msg).then(sendResponse);
      return true;
    }

    // The coordinator frame's tick.
    case 'getState': {
      if (tabId == null) return false;
      if (msg.status) status.set(tabId, { ...msg.status, ts: Date.now() });
      tabAudio(tabId).then((info) => {
        const now = Date.now();
        sendResponse({
          ...audioState(tabId, info, now),
          totalPanes: paneList(tabId, now).length,
        });
      });
      return true;
    }

    case 'requestSwitch': {
      if (tabId == null) return false;
      rotate(tabId).then(sendResponse);
      return true;
    }

    // From the offscreen analyser.
    case 'speech': {
      speech.set(msg.tabId, {
        speechPresent: msg.speechPresent,
        recentDb: msg.recentDb,
        floorDb: msg.floorDb,
        ts: Date.now(),
      });
      return false;
    }

    case 'captureEnded': {
      speech.delete(msg.tabId);
      return false;
    }

    // Popup controls.
    case 'popupSwitch': {
      rotate(msg.tabId).then(sendResponse);
      return true;
    }

    case 'startListening': {
      startListening(msg).then(sendResponse);
      return true;
    }

    case 'stopListening': {
      stopListening(msg.tabId).then(sendResponse);
      return true;
    }

    case 'popupStatus': {
      tabAudio(msg.tabId).then((info) => {
        const now = Date.now();
        const known = status.get(msg.tabId);
        const panes = paneList(msg.tabId, now);
        sendResponse({
          ...audioState(msg.tabId, info, now),
          totalPanes: panes.length,
          panes: panes.map((p) => ({
            key: p.key,
            label: p.label,
            inBreak: p.inBreak,
            isPrimary: p.isPrimary,
          })),
          phase: known ? known.phase : 'unknown',
          stale: !known || now - known.ts > FRAME_TTL_MS,
        });
      });
      return true;
    }

    default:
      return false;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  frames.delete(tabId);
  status.delete(tabId);
  cursor.delete(tabId);
  lastSwitch.delete(tabId);
  if (speech.has(tabId)) stopListening(tabId);
});
