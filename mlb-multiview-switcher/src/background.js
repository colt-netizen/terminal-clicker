/*
 * Service worker. Two jobs:
 *
 *  1. Report the tab's `audible` flag to the content script. This is the whole
 *     audio-detection story: MLB.tv is Widevine-protected, so measuring the
 *     waveform via createMediaElementSource is not an option (it returns
 *     silence for protected media, and the rerouting is irreversible — you
 *     would lose audio permanently). Chrome's own per-tab audible flag costs
 *     nothing and works on protected streams. Because multiview keeps every
 *     non-primary pane muted, "the tab is audible" is equivalent to "the
 *     primary pane is making noise".
 *
 *  2. Act as the cross-frame registry. Panes may all live in the top document,
 *     or each be its own iframe. Frames report what they can see; the worker
 *     stitches them into one ordered pane list and routes promote/demote.
 *
 * Deliberately no timers here: MV3 workers are killed after ~30s idle, so the
 * clock lives in the content script and the worker is woken by its messages.
 */

/** tabId -> Map<frameId, {paneCount, primaryLocal, ts}> */
const frames = new Map();
/** tabId -> last status pushed by the coordinator frame, for the popup. */
const status = new Map();

const FRAME_TTL_MS = 5000;

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
    for (let local = 0; local < frame.paneCount; local++) {
      out.push({ frameId: frame.frameId, local, isPrimary: frame.primaryLocal === local });
    }
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

/** Promote the pane after the current one, wrapping around. */
async function rotate(tabId) {
  const now = Date.now();
  const panes = paneList(tabId, now);
  if (panes.length < 2) return { ok: false, reason: 'need at least two panes' };

  const current = panes.findIndex((p) => p.isPrimary);
  const target = panes[(current + 1) % panes.length];

  const sends = liveFrames(tabId, now).map((frame) => {
    const message =
      frame.frameId === target.frameId
        ? { type: 'promote', local: target.local }
        : { type: 'demote' };
    return chrome.tabs
      .sendMessage(tabId, message, { frameId: frame.frameId })
      .catch(() => null); // a frame can vanish mid-rotation; not fatal
  });
  await Promise.all(sends);

  return { ok: true, from: current, to: (current + 1) % panes.length, total: panes.length };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab && sender.tab.id;

  switch (msg.type) {
    // Every frame, once a second: what it can see.
    case 'report': {
      if (tabId == null) return false;
      frameMap(tabId).set(sender.frameId ?? 0, {
        paneCount: msg.paneCount,
        primaryLocal: msg.primaryLocal,
        ts: Date.now(),
      });
      return false;
    }

    // The coordinator frame's tick.
    case 'getState': {
      if (tabId == null) return false;
      if (msg.status) status.set(tabId, { ...msg.status, ts: Date.now() });
      tabAudio(tabId).then((audio) => {
        const panes = paneList(tabId, Date.now());
        sendResponse({ ...audio, totalPanes: panes.length });
      });
      return true;
    }

    case 'requestSwitch': {
      if (tabId == null) return false;
      rotate(tabId).then(sendResponse);
      return true;
    }

    // Popup: "switch now" and status readout.
    case 'popupSwitch': {
      rotate(msg.tabId).then(sendResponse);
      return true;
    }

    case 'popupStatus': {
      tabAudio(msg.tabId).then((audio) => {
        const panes = paneList(msg.tabId, Date.now());
        const known = status.get(msg.tabId);
        sendResponse({
          ...audio,
          totalPanes: panes.length,
          phase: known ? known.phase : 'unknown',
          stale: !known || Date.now() - known.ts > FRAME_TTL_MS,
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
});
