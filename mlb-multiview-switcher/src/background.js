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
/**
 * Minimum time audio stays where it was put before *dead air* is allowed to
 * move it again. Definite facts (a break banner, a game going final) still act
 * after the ordinary cooldown — but the audio detector, which can be wrong,
 * gets at most one move per dwell. This is the guarantee that the user hears a
 * game rather than a slideshow of stuttering samples when detection misfires.
 */
const AUDIO_DWELL_MS = 20000;
/**
 * Impatience window after a switch: if the pane we just landed on shows a
 * break or dead air within this window, the landing was premature — bail
 * immediately (no dwell) and heat the pane so the next escape avoids it.
 * Patience is for games we are settled into, not for bad landings.
 */
const PROBE_MS = 8000;
/** How long a bad-landing pane stays heated (ineligible as a destination). */
const HEAT_MS = 30000;
/**
 * Dead air must be CONTINUOUS this long before it may move audio off a pane
 * we otherwise believe is playing. Commentators go quiet during action — the
 * crowd is flat, the spread gate reads "no speech" — and a few seconds of
 * that was ejecting the user out of live plays. A real slate murmurs for two
 * minutes; a commentary lull rarely stretches past thirty seconds.
 */
const DEAD_AIR_ESCAPE_MS = 45000;
/**
 * Heat applied to a pane we escaped for silence: roughly the remainder of an
 * ad pod. Until it expires the pane cannot receive audio again — not even as
 * the top priority — because in-stream slates leave no DOM trace and "looks
 * watchable" is no evidence. Without this, escape + return-to-top boomerangs
 * the audio straight back into the slate.
 */
const AUDIO_ESCAPE_HEAT_MS = 90000;
/**
 * Commentary confidence for the audio pane: an EMA of speech presence rather
 * than a strict continuous streak — one stray murmur spike must not reset a
 * 45-second silence clock (that reset is why audio sat on slates forever).
 * Alpha 0.03/tick at ~300ms decays ~1.0 -> 0.05 in ~30s of silence; real
 * commentary (speech most ticks) holds well above 0.3.
 */
const ALIVE_ALPHA = 0.03;
const ALIVE_ESCAPE_BELOW = 0.05;

/** tabId -> last time the audio pane demonstrably had commentary. */
const lastAlive = new Map();
/** tabId -> commentary-confidence EMA for the current audio pane. */
const aliveScore = new Map();

/**
 * tabId -> Map<paneKey, break episode state> (see Intel.breakEpisode).
 * Break timing — confirmation, the ~2min ad-pod lock, clear, cooling — all
 * lives in the episode model, dialled to how long MLB ad pods actually run.
 */
const breakSeen = new Map();
/** tabId -> Map<paneKey, heated-until timestamp> for premature landings. */
const paneHeat = new Map();

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
  tuneStrikes.clear();
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

/** Zero live baseball anywhere (and the API is actually answering): the user
 * is watching replays, and the replay rules apply. */
function isReplayContext(games) {
  return (
    schedule.fetchedAt > 0 &&
    games.length > 0 &&
    !games.some((g) => ['live', 'paused'].includes(Intel.classifyApiGame(g)))
  );
}

function knownAbbrSet(games) {
  return new Set(
    games
      .flatMap((g) => [g.teams.away.team.abbreviation, g.teams.home.team.abbreviation])
      .map(Intel.normalizeToken)
  );
}

/** "TOR @ HOU" style matchups for the rail cards marked Viewing — which games
 * the page says are on screen, even when panes can't be matched individually. */
function viewingMatchups(tabId, now) {
  const rail = rails.get(tabId);
  if (!rail || now - rail.ts > FRAME_TTL_MS) return [];
  const known = knownAbbrSet(scheduleGames());
  return rail.cards
    .filter((c) => c.viewing)
    .map((c) => (c.tokens || []).filter((t) => known.has(Intel.normalizeToken(t))))
    .filter((tokens) => tokens.length === 2)
    .map((tokens) => tokens.join(' @ '));
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
 * played on it, and how the user's team priorities rank it.
 *
 * Matching tries, in order: an explicit gamePk in the pane key; team logo
 * alts; the pane's own visible text (the scorebug "SF 0 TEX 0", a graphic
 * naming a team). If none of that lands and the stats API is down, the rail's
 * printed state fills in via matching card tokens.
 */
function paneList(tabId, now, opts) {
  const teamPriorities = (opts && opts.teamPriorities) || [];
  const assignments = (opts && opts.paneAssignments) || {};
  const games = scheduleGames();
  const rail = rails.get(tabId);
  const cards = rail && now - rail.ts <= FRAME_TTL_MS ? rail.cards : [];
  // If the API is fresh and reports no baseball anywhere, every pane is dead —
  // postgame shows, replays and pressers included — no matching required.
  const leagueDead =
    schedule.fetchedAt > 0 &&
    games.length > 0 &&
    !games.some((g) => ['live', 'paused'].includes(Intel.classifyApiGame(g)));

  let seen = breakSeen.get(tabId);
  if (!seen) {
    seen = new Map();
    breakSeen.set(tabId, seen);
  }

  const out = [];
  for (const frame of liveFrames(tabId, now)) {
    (frame.panes || []).forEach((pane, local) => {
      const tokens = pane.tokens && pane.tokens.length ? pane.tokens : Intel.tokensFromKey(pane.key);
      const assignedPk = assignments[pane.key];
      const game =
        Intel.matchByKey(games, pane.key) ||
        (assignedPk ? games.find((g) => g.gamePk === assignedPk) : null) ||
        Intel.matchGame(games, tokens) ||
        Intel.matchGameByText(games, pane.text);

      // Evidence-based break state: a sighting must persist to confirm, a
      // confirmed break locks for a realistic ad-pod length, ending requires
      // the banner to stay gone, and an ended break cools before the pane can
      // receive audio again.
      const episode = Intel.breakEpisode(seen.get(pane.key) || null, Boolean(pane.inBreak), now);
      if (episode.state) seen.set(pane.key, episode.state);
      else seen.delete(pane.key);
      const heatMap = paneHeat.get(tabId);
      // Heat (suspected dead by audio) is deliberately separate from cooling
      // (a trusted, fully-elapsed break episode): the top pane is exempt from
      // cooling but never from heat.
      const heated = heatMap ? (heatMap.get(pane.key) || 0) > now : false;
      const inBreak = episode.inBreak;
      const cooling = episode.cooling;
      pane = { ...pane, inBreak };

      let railState = null;
      if (!game && tokens.length) {
        const mine = new Set(tokens.map(Intel.normalizeToken));
        const card = cards.find((c) => (c.tokens || []).filter((t) => mine.has(Intel.normalizeToken(t))).length >= 2);
        if (card) railState = Intel.parseRailState(card.text);
      }

      let liveness = Intel.paneLiveness({ ...pane, railState }, game);
      if (liveness.live && leagueDead) {
        liveness = { live: false, reason: 'no live MLB games right now' };
      }
      const away = game && game.teams.away.team;
      const home = game && game.teams.home.team;
      out.push({
        frameId: frame.frameId,
        local,
        key: pane.key,
        label: game
          ? `${away.abbreviation || away.teamName} @ ${home.abbreviation || home.teamName}`
          : pane.label,
        tokens: tokens || [],
        text: pane.text || '',
        inBreak: Boolean(pane.inBreak),
        isPrimary: frame.primaryLocal === local,
        gamePk: game ? game.gamePk : null,
        gameLive: game ? Intel.classifyApiGame(game) === 'live' : false,
        kind: game ? Intel.classifyApiGame(game) : '',
        stateText: game ? Intel.describeApiGame(game) : railState ? railState.kind : '',
        teamRank: Intel.teamRankOfGame(game, teamPriorities),
        interest: game ? Intel.interestScore(game) : 0,
        blowout: game ? Intel.teamBlowoutLoss(game, teamPriorities) : false,
        live: liveness.live,
        liveReason: liveness.reason,
        // For the selector: dead-but-not-break panes are ineligible with a
        // specific reason; breaks keep their own path.
        notLive: !liveness.live && !pane.inBreak,
        notLiveReason: liveness.reason,
        // Between half-innings: never a destination, never a reason to leave.
        paused: Boolean(game) && Intel.betweenInnings(game),
        // Recently showed a break: never a destination until cooled.
        cooling,
        // Escaped for silence recently: never a destination, not even for
        // the top-priority pane.
        heated,
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
      spreadDb: heard.spreadDb,
      listening: true,
    };
  }
  return { ...tabInfo, source: 'tab-flag', listening: false };
}

/**
 * Where the audio is right now. Our cursor is authoritative — the content
 * script *enforces* it on a timer, so MLB's transient re-asserts (which used
 * to flip the detected primary back to its own focused pane between our
 * writes) don't get to redefine reality. Detection only seeds a fresh worker.
 */
function currentIndex(tabId, panes) {
  const remembered = cursor.has(tabId) ? cursor.get(tabId) : -1;
  if (remembered >= 0 && remembered < panes.length) return remembered;
  return panes.findIndex((p) => p.isPrimary);
}

/**
 * tabId -> {key} — the pane the user personally clicked. A human choice
 * outranks everything except that pane's game dying: we leave for breaks and
 * come back HERE, and we never bounce off it because some other pane "ranks
 * higher". Cleared when the held pane's game is no longer live, or replaced by
 * the next user click.
 */
const manualHold = new Map();

/** Move the audio to a specific pane. */
async function promoteIndex(tabId, panes, index, options) {
  const target = panes[index];
  if (!target) return { ok: false, reason: 'pane index out of range' };
  cursor.set(tabId, index);
  lastSwitch.set(tabId, Date.now());
  lastAlive.set(tabId, Date.now()); // fresh pane, fresh evidence clock
  aliveScore.set(tabId, 0.5);

  const goLive = options && 'goLive' in options ? options.goLive : Boolean(target.gameLive);
  const sends = liveFrames(tabId, Date.now()).map((frame) => {
    const message =
      frame.frameId === target.frameId
        ? // goLive: for a game the API says is in progress, snap the feed to
          // the live edge on arrival. Never for finals — that's someone's
          // replay position.
          { type: 'promote', local: target.local, goLive }
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

  const games = scheduleGames();
  const replayMode = isReplayContext(games);

  /**
   * What may be given up. Normally: dead panes only, never breaks. In replay
   * mode every pane reads "dead", so the rules are the pane's own content:
   * filler feeds are expendable, and if EVERY pane is a break slate at once
   * (nothing watchable at all), the deadlock makes them all expendable —
   * loading a different replay beats a wall of "Commercial Break in Progress".
   */
  let expendable;
  if (!replayMode) {
    expendable = (p) => !p.live && !p.inBreak;
  } else {
    const allBreak = panes.every((p) => p.inBreak);
    expendable = allBreak ? () => true : (p) => !p.inBreak && Intel.looksLikeFiller(p.text);
  }

  // Rail token extraction is loose (uppercase runs in concatenated text), so
  // keep only tokens that are real team abbreviations before matching.
  const knownAbbrs = knownAbbrSet(games);
  const cards = rail.cards.map((c) => ({
    text: c.text,
    viewing: c.viewing,
    tokens: (c.tokens || []).filter((t) => knownAbbrs.has(Intel.normalizeToken(t))),
  }));

  const target = Intel.pickTuneTarget({
    panes: panes.map((p) => ({
      live: p.live,
      inBreak: p.inBreak,
      gamePk: p.gamePk,
      kind: p.kind,
      expendable: expendable(p),
    })),
    games,
    railCards: cards,
    teamPriorities: settings.teamPriorities,
    skipGamePks: skip,
    replayMode,
  });
  if (!target) return null;

  pendingTune.set(tabId, { gamePk: target.gamePk, sentAt: now });
  lastTune.set(tabId, now);

  const give = panes[target.replaceIndex];
  const card = cards[target.cardIndex];
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
  const settings = await currentSettings();
  const panes = paneList(tabId, now, settings);
  settlePendingTune(tabId, panes, now);

  if (blocked || panes.length < 2) return { switched: false };
  if (!settings.enabled) return { switched: false };

  // The user's click is the strongest ranking there is. It holds as long as
  // the pane exists — on replay nights every pane reads "not live", and
  // dropping the hold for that would un-stick the user's choice the moment
  // they made it. A held pane that goes truly dead simply stops being an
  // eligible destination, which retires the hold without ceremony.
  let heldKey = null;
  const hold = manualHold.get(tabId);
  if (hold) {
    const held = panes.find((p) => p.key === hold.key);
    if (!held) manualHold.delete(tabId);
    else heldKey = hold.key;
  }

  // Full pecking order: the user's click, then designated teams (unless being
  // blown out), then everything else by interest — closest, latest games
  // first. Position 0 is THE most important game: the only pane upgrades may
  // return to when its ad ends. The rest of the order just aims escapes.
  const priorities = Intel.buildPriorities(
    panes.map((p) => ({ key: p.key, teamRank: p.teamRank, interest: p.interest, blowout: p.blowout })),
    heldKey
  );
  const topKey = priorities[0];

  let switched = { switched: false };
  if (now - (lastSwitch.get(tabId) || 0) >= SWITCH_COOLDOWN_MS) {
    const sinceSwitch = now - (lastSwitch.get(tabId) || 0);
    const current = panes[currentIndex(tabId, panes)];

    // Impatience: we JUST landed here. If this pane immediately shows a break
    // or dead air, the landing was bad — bail without waiting out the dwell,
    // and heat the pane so the next escape avoids it.
    const probing = sinceSwitch <= PROBE_MS;
    // Track commentary evidence for the audio pane: a fast clock for probe
    // bails, and a tolerant EMA for settled escapes.
    const heard = speech.get(tabId);
    const listening = Boolean(heard && now - heard.ts < SPEECH_TTL_MS);
    if (!lastAlive.has(tabId)) lastAlive.set(tabId, now);
    if (listening && heard.speechPresent) lastAlive.set(tabId, now);
    const deadStreak = now - lastAlive.get(tabId);
    if (listening) {
      const prev = aliveScore.has(tabId) ? aliveScore.get(tabId) : 0.5;
      aliveScore.set(tabId, prev * (1 - ALIVE_ALPHA) + (heard.speechPresent ? ALIVE_ALPHA : 0));
    }
    const confidence = aliveScore.has(tabId) ? aliveScore.get(tabId) : 0.5;

    // A landing is bad if it shows a break, or — when we can hear — stays
    // speechless for its first seconds (the alive-clock resets on promotion,
    // so deadStreak here measures silence since landing).
    const badLanding =
      probing && current && (current.inBreak || audioDead || (listening && deadStreak >= 5000));
    if (badLanding && current) {
      let heatMap = paneHeat.get(tabId);
      if (!heatMap) {
        heatMap = new Map();
        paneHeat.set(tabId, heatMap);
      }
      heatMap.set(current.key, now + HEAT_MS);
    }

    const decision = Selector.choose({
      // The most important pane is exempt from cooling: when its ad genuinely
      // ends (the episode model guarantees that took ad-pod time), the audio
      // returns without serving a second sentence.
      panes: panes.map((p) => (p.key === topKey ? { ...p, cooling: false } : p)),
      priorities,
      currentIndex: currentIndex(tabId, panes),
      // Dead air escapes come from OUR commentary-confidence EMA when we can
      // hear — not from the silence machine's pulses (whose backoff naps left
      // audio parked on slates) and not from a strict continuous streak
      // (which one stray murmur spike resets forever). The machine only
      // matters in tab-flag mode, where there is no speech stream. A
      // commentary lull during a play decays slowly and never reaches the
      // escape threshold; a slate's drone gets there in ~30s.
      audioDead:
        badLanding ||
        ((listening ? confidence < ALIVE_ESCAPE_BELOW : audioDead) &&
          sinceSwitch >= AUDIO_DWELL_MS),
      // Escapes always; upgrades only back to THE most important game (the
      // user's click or their designated team) once it is watchable again.
      allowUpgrade: 'top',
    });
    if (decision) {
      const departed = current;
      const result = await promoteIndex(tabId, panes, decision.index);
      switched = { switched: result.ok, ...result, reason: decision.reason };
      // Escaped for silence: the departed pane is suspected to be running an
      // in-stream slate. Heat it for the rest of the pod so the return rule
      // cannot boomerang the audio straight back into it.
      if (result.ok && departed && decision.reason === 'no audio on the current pane') {
        let heatMap = paneHeat.get(tabId);
        if (!heatMap) {
          heatMap = new Map();
          paneHeat.set(tabId, heatMap);
        }
        heatMap.set(departed.key, now + AUDIO_ESCAPE_HEAT_MS);
      }
    }
  }

  const tuned = await maybeTune(tabId, panes, settings, now);
  if (tuned) switched.tuned = tuned;
  return switched;
}

/** Manual "switch now": step to the next pane regardless of state. */
async function rotate(tabId) {
  const settings = await currentSettings();
  const panes = paneList(tabId, Date.now(), settings);
  if (panes.length < 2) return { ok: false, reason: 'need at least two panes' };
  const from = currentIndex(tabId, panes);
  const to = (from + 1) % panes.length;
  // Explicit user action — hold the destination like a direct click.
  manualHold.set(tabId, { key: panes[to].key });
  return promoteIndex(tabId, panes, to);
}

/** The user physically clicked a pane: adopt it, hold it, and reconcile every
 * frame's enforcement to it. No goLive snap — clicking to look at a pane is
 * not a request to lose your place in it. */
async function userSelect(tabId, frameId, local) {
  const settings = await currentSettings();
  const panes = paneList(tabId, Date.now(), settings);
  const index = panes.findIndex((p) => p.frameId === frameId && p.local === local);
  if (index === -1) return;
  manualHold.set(tabId, { key: panes[index].key });
  await promoteIndex(tabId, panes, index, { goLive: false });
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
  const finals = games
    .filter((g) => Intel.classifyApiGame(g) === 'final')
    .slice(0, 20)
    .map(compact);
  return {
    live,
    upcoming,
    all: [...live, ...upcoming, ...finals],
    apiError: schedule.error,
    apiAgeMs: schedule.fetchedAt ? Date.now() - schedule.fetchedAt : null,
  };
}

// ----------------------------------------------------------------- routing

/**
 * Every async handler answers through this, so an exception can never leave a
 * message channel hanging. An unanswered message deadlocked the content
 * script's tick loop once (its in-flight guard never cleared) — the extension
 * kept reporting but stopped deciding.
 */
function respond(sendResponse, work) {
  Promise.resolve()
    .then(work)
    .then((result) => sendResponse(result ?? { ok: true }))
    .catch((error) => sendResponse({ ok: false, error: String((error && error.message) || error) }));
  return true;
}

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
      return respond(sendResponse, () => evaluate(tabId, msg));
    }

    // A real (isTrusted) click landed on a pane.
    case 'userSelect': {
      if (tabId == null) return false;
      userSelect(tabId, sender.frameId ?? 0, msg.local).catch(() => {});
      return false;
    }

    // The coordinator frame's tick.
    case 'getState': {
      if (tabId == null) return false;
      if (msg.status) status.set(tabId, { ...msg.status, ts: Date.now() });
      return respond(sendResponse, async () => {
        const [info, settings] = await Promise.all([tabAudio(tabId), currentSettings()]);
        const now = Date.now();
        const panes = paneList(tabId, now, settings);
        const rail = rails.get(tabId);
        return {
          ...audioState(tabId, info, now),
          totalPanes: panes.length,
          panes: panes.map((p) => ({
            label: p.label,
            stateText: p.stateText,
            live: p.live,
            liveReason: p.liveReason,
            inBreak: p.inBreak,
            cooling: p.cooling,
            isPrimary: p.isPrimary,
          })),
          railCards: rail && now - rail.ts <= FRAME_TTL_MS ? rail.cards.length : 0,
          apiGames: schedule.games.length,
          conf: Math.round((aliveScore.get(tabId) ?? 0.5) * 100) / 100,
          replayMode: isReplayContext(scheduleGames()),
          viewing: viewingMatchups(tabId, now),
          tuneTripped: tuneTripped.has(tabId),
        };
      });
    }

    case 'requestSwitch': {
      if (tabId == null) return false;
      return respond(sendResponse, () => rotate(tabId));
    }

    // From the offscreen analyser.
    case 'speech': {
      speech.set(msg.tabId, {
        speechPresent: msg.speechPresent,
        recentDb: msg.recentDb,
        floorDb: msg.floorDb,
        spreadDb: msg.spreadDb,
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
      return respond(sendResponse, () => rotate(msg.tabId));
    }

    case 'startListening': {
      return respond(sendResponse, () => startListening(msg));
    }

    case 'stopListening': {
      return respond(sendResponse, () => stopListening(msg.tabId));
    }

    case 'popupStatus': {
      return respond(sendResponse, async () => {
        const [info, settings] = await Promise.all([tabAudio(msg.tabId), currentSettings()]);
        const now = Date.now();
        const known = status.get(msg.tabId);
        const panes = paneList(msg.tabId, now, settings);
        return {
          ...audioState(msg.tabId, info, now),
          totalPanes: panes.length,
          panes: panes.map((p) => ({
            key: p.key,
            label: p.label,
            inBreak: p.inBreak,
            cooling: p.cooling,
            isPrimary: p.isPrimary,
            stateText: p.stateText,
            live: p.live,
          })),
          games: gamesForPopup(),
          replayMode: isReplayContext(scheduleGames()),
          viewing: viewingMatchups(msg.tabId, now),
          tuneTripped: tuneTripped.has(msg.tabId),
          phase: known ? known.phase : 'unknown',
          stale: !known || now - known.ts > FRAME_TTL_MS,
        };
      });
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
  manualHold.delete(tabId);
  breakSeen.delete(tabId);
  paneHeat.delete(tabId);
  lastAlive.delete(tabId);
  aliveScore.delete(tabId);
  lastSwitch.delete(tabId);
  pendingTune.delete(tabId);
  lastTune.delete(tabId);
  tuneStrikes.delete(tabId);
  tuneTripped.delete(tabId);
  if (speech.has(tabId)) stopListening(tabId);
});
