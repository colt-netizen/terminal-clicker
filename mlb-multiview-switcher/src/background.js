/*
 * Service worker. Four jobs:
 *
 *  1. Know the state of every MLB game. Source of truth is MLB's own public
 *     stats API (statsapi.mlb.com — free, no key, one small fetch a minute,
 *     only while an MLB tab is open). It reports Preview/Live/Final, the
 *     inning ("Bot 8"), and both teams for every game. The page's game rail
 *     prints the same facts as text, parsed as a fallback for when the API is
 *     unreachable.
 *
 *  2. Decide whether the tab currently has commentary on it. Listen mode (the
 *     offscreen analyser) wins when fresh; otherwise Chrome's per-tab audible
 *     flag. Web Audio on the <video> itself is not an option — MLB.tv is
 *     Widevine protected, so createMediaElementSource yields silence, and its
 *     rerouting is irreversible.
 *
 *  3. Own audio placement: the highest-priority pane that is showing live
 *     baseball gets the sound. Priorities are teams first, manual feed order
 *     second.
 *
 *  4. Auto-tune: when a pane's game is dead (final / not started) and a live
 *     game exists off-screen, drive the page's rail to swap it in.
 *
 * Deliberately no timers: MV3 workers are killed after ~30s idle, so the clock
 * lives in the content script and this is woken by its messages.
 */

importScripts('shared/pane-selector.js', 'shared/settings.js', 'shared/game-intel.js');
const Selector = globalThis.MLBPaneSelector;
const Settings = globalThis.MLBSettings;
const Intel = globalThis.MLBGameIntel;

/** tabId -> Map<frameId, {panes, primaryLocal, ts}> */
const frames = new Map();
/** tabId -> {frameId, cards: [{text, tokens, viewing}], ts} — the game rail. */
const rails = new Map();
/** tabId -> last status pushed by the coordinator frame, for the popup. */
const status = new Map();
/** tabId -> {speechPresent, recentDb, floorDb, ts} from the offscreen analyser. */
const speech = new Map();
/**
 * tabId -> index of the pane we most recently promoted.
 *
 * Rotation is stateful rather than re-derived because MLB re-asserts its own
 * mute state after a click, so a moment later no pane looks primary at all —
 * and a findIndex that returns -1 would send every switch back to pane 0.
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

// ------------------------------------------------------------ settings cache

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
  if (areaName !== 'sync') return;
  settingsCache = null;
  // Toggling settings is the user's "try again" gesture for auto-tune.
  tuneTripped.clear();
  tuneFailures.clear();
});

// ------------------------------------------------------------- schedule cache

// Short enough that the between-innings signal (linescore.inningState) is
// fresh; still ~5KB a pull, and only while an MLB tab is ticking.
const SCHEDULE_TTL_MS = 20000;
const schedule = { games: [], fetchedAt: 0, fetching: false, failures: 0, nextTryAt: 0, error: null };

const isoDay = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Refresh the schedule when stale; callers keep using the last good copy in
 * the meantime. Yesterday..tomorrow covers late games across every timezone
 * without caring what MLB thinks the "baseball day" is.
 */
function maybeRefreshSchedule() {
  const now = Date.now();
  if (schedule.fetching || now - schedule.fetchedAt < SCHEDULE_TTL_MS || now < schedule.nextTryAt) {
    return;
  }
  schedule.fetching = true;
  (async () => {
    try {
      const today = new Date();
      const from = new Date(today);
      from.setDate(today.getDate() - 1);
      const to = new Date(today);
      to.setDate(today.getDate() + 1);
      const url =
        'https://statsapi.mlb.com/api/v1/schedule?sportId=1' +
        `&startDate=${isoDay(from)}&endDate=${isoDay(to)}&hydrate=team,linescore`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      schedule.games = (data.dates || []).flatMap((d) => d.games || []);
      schedule.fetchedAt = Date.now();
      schedule.failures = 0;
      schedule.nextTryAt = 0;
      schedule.error = null;
    } catch (error) {
      schedule.failures += 1;
      schedule.nextTryAt = Date.now() + Math.min(300000, 15000 * 2 ** schedule.failures);
      schedule.error = String((error && error.message) || error);
    } finally {
      schedule.fetching = false;
    }
  })();
}

function scheduleGames() {
  maybeRefreshSchedule();
  return schedule.games;
}

// ---------------------------------------------------------------- pane roster

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
 * Flatten every frame's panes into one addressable list, then attach what we
 * know about each pane's game: which game it is, whether baseball is being
 * played on it, and how the user ranks it.
 */
function paneList(tabId, now) {
  const games = scheduleGames();
  const out = [];
  for (const frame of liveFrames(tabId, now)) {
    (frame.panes || []).forEach((pane, local) => {
      const game =
        Intel.matchByKey(games, pane.key) ||
        Intel.matchGame(games, pane.tokens && pane.tokens.length ? pane.tokens : Intel.tokensFromKey(pane.key));
      const liveness = Intel.paneLiveness(pane, game);
      out.push({
        frameId: frame.frameId,
        local,
        key: pane.key,
        label: pane.label,
        tokens: pane.tokens || [],
        inBreak: Boolean(pane.inBreak),
        isPrimary: frame.primaryLocal === local,
        gamePk: game ? game.gamePk : null,
        stateText: game ? Intel.describeApiGame(game) : '',
        live: liveness.live,
        liveReason: liveness.reason,
        // For the selector: dead-but-not-break panes are ineligible with a
        // specific reason; breaks keep their own path.
        notLive: !liveness.live && !pane.inBreak,
        notLiveReason: liveness.reason,
        // Between half-innings: never a destination, never a reason to leave.
        paused: Boolean(game) && Intel.betweenInnings(game),
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

// -------------------------------------------------------------- auto-tuning

const TUNE_COOLDOWN_MS = 30000;
const TUNE_VERIFY_MS = 10000;
const TUNE_FAILURE_BAN_MS = 10 * 60 * 1000;
const TUNE_TRIP_AFTER = 3;

/** tabId -> {gamePk, sentAt} — a rail click we are waiting to see succeed. */
const pendingTune = new Map();
/** tabId -> timestamp of the last tune attempt. */
const lastTune = new Map();
/** gamePk -> retry-after timestamp for games whose rail click did nothing. */
const tuneFailures = new Map();
/** tabId -> consecutive failures; at TUNE_TRIP_AFTER we stop driving the rail. */
const tuneStrikes = new Map();
const tuneTripped = new Set();

/**
 * Resolve a pending tune: success clears the strike count, silence past the
 * verify window bans that game for a while and adds a strike. Three strikes
 * means rail clicks do not work on this layout — stop trying rather than
 * clicking the page forever.
 */
function settlePendingTune(tabId, panes, now) {
  const pending = pendingTune.get(tabId);
  if (!pending) return;
  if (panes.some((p) => p.gamePk === pending.gamePk)) {
    pendingTune.delete(tabId);
    tuneStrikes.delete(tabId);
    return;
  }
  if (now - pending.sentAt > TUNE_VERIFY_MS) {
    pendingTune.delete(tabId);
    tuneFailures.set(pending.gamePk, now + TUNE_FAILURE_BAN_MS);
    const strikes = (tuneStrikes.get(tabId) || 0) + 1;
    tuneStrikes.set(tabId, strikes);
    if (strikes >= TUNE_TRIP_AFTER) tuneTripped.add(tabId);
  }
}

/**
 * Swap a dead pane for the best off-screen live game, by driving the page's
 * own rail: focus the pane being given up, then click the target's rail card.
 */
async function maybeTune(tabId, panes, settings, now) {
  if (!settings.autoTune || tuneTripped.has(tabId)) return null;
  if (pendingTune.has(tabId)) return null;
  if (now - (lastTune.get(tabId) || 0) < TUNE_COOLDOWN_MS) return null;

  const rail = rails.get(tabId);
  if (!rail || now - rail.ts > FRAME_TTL_MS) return null;

  const skip = [];
  for (const [gamePk, until] of tuneFailures) {
    if (now < until) skip.push(gamePk);
    else tuneFailures.delete(gamePk);
  }

  const target = Intel.pickTuneTarget({
    panes: panes.map((p) => ({
      live: p.live,
      gamePk: p.gamePk,
      rank: Selector.rankOf(p.key, settings.priorities),
    })),
    games: scheduleGames(),
    railCards: rail.cards.map((c) => ({ tokens: c.tokens, viewing: c.viewing })),
    teamPriorities: settings.teamPriorities,
    skipGamePks: skip,
  });
  if (!target) return null;

  pendingTune.set(tabId, { gamePk: target.gamePk, sentAt: now });
  lastTune.set(tabId, now);

  const give = panes[target.replaceIndex];
  const card = rail.cards[target.cardIndex];
  // Focus the pane being replaced first — MLB loads a rail selection into the
  // focused pane — then click the card. The coordinator handles the pacing.
  if (give) {
    await chrome.tabs
      .sendMessage(tabId, { type: 'focusPane', local: give.local }, { frameId: give.frameId })
      .catch(() => null);
  }
  await chrome.tabs
    .sendMessage(tabId, { type: 'clickRail', tokens: card.tokens, text: card.text }, { frameId: rail.frameId })
    .catch(() => null);

  return { gamePk: target.gamePk, card: card.text };
}

// ----------------------------------------------------------------- evaluate

/**
 * Decide whether the audio should move, and move it; then see whether a pane
 * should be re-tuned to a different game. Break banners and game states are
 * checked every tick — they are definite facts and do not wait out the silence
 * timer the way ambiguous dead air does.
 */
async function evaluate(tabId, { audioDead, blocked }) {
  const now = Date.now();
  const panes = paneList(tabId, now);
  settlePendingTune(tabId, panes, now);

  if (blocked || panes.length < 2) return { switched: false };

  const settings = await currentSettings();
  if (!settings.enabled) return { switched: false };

  const feedPriorities = Selector.mergePriorities(
    settings.priorities,
    panes.map((p) => p.key)
  );
  // Persist newly seen games so they show up in the popup's priority list.
  if (feedPriorities.length !== (settings.priorities || []).length) {
    settingsCache = { ...settings, priorities: feedPriorities };
    await Settings.save({ priorities: feedPriorities });
  }

  // Teams outrank the manual feed order; with no team priorities set this is
  // exactly the manual order.
  const priorities = Intel.orderKeys(panes, {
    games: scheduleGames(),
    teamPriorities: settings.teamPriorities,
    feedPriorities,
  });

  let switched = { switched: false };
  if (now - (lastSwitch.get(tabId) || 0) >= SWITCH_COOLDOWN_MS) {
    const decision = Selector.choose({
      panes,
      priorities,
      currentIndex: currentIndex(tabId, panes),
      audioDead,
    });
    if (decision) {
      const result = await promoteIndex(tabId, panes, decision.index);
      switched = { switched: result.ok, ...result, reason: decision.reason };
    }
  }

  const tuned = await maybeTune(tabId, panes, settings, now);
  if (tuned) switched.tuned = tuned;
  return switched;
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

// ------------------------------------------------------------ popup payloads

/** Compact game summaries for the popup: what's live, what's coming up. */
function gamesForPopup() {
  const games = scheduleGames();
  const compact = (g) => {
    const away = g.teams.away.team;
    const home = g.teams.home.team;
    return {
      gamePk: g.gamePk,
      matchup: `${away.abbreviation || away.teamName} @ ${home.abbreviation || home.teamName}`,
      state: Intel.describeApiGame(g),
      kind: Intel.classifyApiGame(g),
      startISO: g.gameDate,
      teams: [away.abbreviation || away.teamName, home.abbreviation || home.teamName],
    };
  };
  const live = games.filter((g) => Intel.classifyApiGame(g) === 'live').map(compact);
  const upcoming = games
    .filter((g) => Intel.classifyApiGame(g) === 'preview')
    .sort((a, b) => String(a.gameDate).localeCompare(String(b.gameDate)))
    .slice(0, 8)
    .map(compact);
  return { live, upcoming, apiError: schedule.error, apiAgeMs: schedule.fetchedAt ? Date.now() - schedule.fetchedAt : null };
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
      if (msg.rail) {
        rails.set(tabId, { frameId: sender.frameId ?? 0, cards: msg.rail, ts: Date.now() });
      }
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
        const panes = paneList(tabId, now);
        const rail = rails.get(tabId);
        sendResponse({
          ...audioState(tabId, info, now),
          totalPanes: panes.length,
          panes: panes.map((p) => ({
            label: p.label,
            stateText: p.stateText,
            live: p.live,
            liveReason: p.liveReason,
            inBreak: p.inBreak,
            isPrimary: p.isPrimary,
          })),
          railCards: rail && now - rail.ts <= FRAME_TTL_MS ? rail.cards.length : 0,
          apiGames: schedule.games.length,
          tuneTripped: tuneTripped.has(tabId),
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
            stateText: p.stateText,
            live: p.live,
          })),
          games: gamesForPopup(),
          tuneTripped: tuneTripped.has(msg.tabId),
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
  rails.delete(tabId);
  status.delete(tabId);
  cursor.delete(tabId);
  lastSwitch.delete(tabId);
  pendingTune.delete(tabId);
  lastTune.delete(tabId);
  tuneStrikes.delete(tabId);
  tuneTripped.delete(tabId);
  if (speech.has(tabId)) stopListening(tabId);
});
