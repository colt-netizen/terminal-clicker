/*
 * Understands the state of every game, from two independent sources:
 *
 *  - MLB's public stats API (statsapi.mlb.com — free, no key). One schedule
 *    fetch returns every game's state (Preview/Live/Final), inning, and teams.
 *  - The multiview page's own game rail, whose cards print the same facts as
 *    text: "Bot 8", "Final", "1:20 PM", plus team abbreviations.
 *
 * Between them the extension knows, for every pane and every off-screen game,
 * whether actual baseball is being played — which is what "should the audio be
 * here" and "should this pane be replaced" both reduce to.
 *
 * Pure: no DOM, no chrome.*, no fetch. The worker feeds it API JSON and rail
 * text; the tests feed it fixtures.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MLBGameIntel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // ------------------------------------------------------------ rail text

  // No word boundaries: rail card text arrives via textContent, which
  // concatenates child elements without whitespace ("FinalTORHOU"), so \b
  // never fires where humans see a break.
  const INNING = /(top|bot(?:tom)?|mid(?:dle)?|end)\s*(\d{1,2})/i;
  const FINAL = /final/i;
  const NOT_PLAYING = /postponed|ppd|suspended|delay|warmup|pre-?game/i;
  const START_TIME = /(\d{1,2}:\d{2}\s*(?:am|pm)?)/i;

  /**
   * Classify one rail card's text. "Bot 8" style inning markers win over
   * everything, because a card can contain both a state and other numbers.
   */
  function parseRailState(text) {
    const s = String(text || '');
    const inning = s.match(INNING);
    if (inning) {
      const half = inning[1].slice(0, 3).toLowerCase();
      return { kind: 'live', half, inning: Number(inning[2]) };
    }
    if (FINAL.test(s)) return { kind: 'final' };
    if (NOT_PLAYING.test(s)) return { kind: 'paused' };
    const time = s.match(START_TIME);
    if (time) return { kind: 'preview', startText: time[1] };
    return { kind: 'unknown' };
  }

  // ------------------------------------------------------------- API state

  /**
   * Collapse the stats API's status object into what we act on.
   *
   *   live    baseball is being played
   *   paused  officially live but nothing happening (rain delay, suspended)
   *   preview not started (Scheduled / Pre-Game / Warmup)
   *   final   over
   */
  function classifyApiGame(game) {
    const status = (game && game.status) || {};
    const abstract = String(status.abstractGameState || '');
    const detailed = String(status.detailedState || '');
    if (abstract === 'Final' || /game over/i.test(detailed)) return 'final';
    if (abstract === 'Preview') return 'preview';
    if (abstract === 'Live') {
      if (/delay|suspend/i.test(detailed)) return 'paused';
      return 'live';
    }
    return 'unknown';
  }

  /**
   * Between half-innings — the broadcast's commercial window, straight from
   * the data. Only meaningful for live games.
   */
  function betweenInnings(game) {
    if (classifyApiGame(game) !== 'live') return false;
    return /^(middle|end)$/i.test(String((game.linescore || {}).inningState || ''));
  }

  /** "Bot 8" for the HUD/popup, from a hydrated schedule game. */
  function describeApiGame(game) {
    const kind = classifyApiGame(game);
    if (kind === 'live' || kind === 'paused') {
      const ls = game.linescore || {};
      // inningState carries Middle/End between half-innings; inningHalf only
      // knows Top/Bottom. Prefer the one that reflects the break.
      const state = /^(middle|end)$/i.test(String(ls.inningState || ''))
        ? ls.inningState
        : ls.inningHalf;
      const half = state ? String(state).slice(0, 3) : '?';
      const label = ls.currentInning ? `${half} ${ls.currentInning}` : 'Live';
      return kind === 'paused' ? `${label} (delay)` : label;
    }
    if (kind === 'final') return 'Final';
    if (kind === 'preview') return 'Preview';
    return 'Unknown';
  }

  // ---------------------------------------------------------- team matching

  /** Normalise any team token — "D-backs", "AZ", "San Diego Padres" — for comparison. */
  function normalizeToken(s) {
    return String(s || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
  }

  /** Every normalised name a schedule team object answers to. */
  function teamAliases(team) {
    if (!team) return [];
    return [
      team.abbreviation,
      team.teamName,
      team.name,
      team.clubName,
      team.shortName,
      team.locationName,
      team.teamCode,
    ]
      .map(normalizeToken)
      .filter(Boolean);
  }

  /** Does this token refer to this team? Exact alias match only — substring
   * matching would make "LA" claim both LAD and LAA. */
  function tokenMatchesTeam(token, team) {
    const t = normalizeToken(token);
    if (!t) return false;
    return teamAliases(team).includes(t);
  }

  function gameTeams(game) {
    const teams = (game && game.teams) || {};
    return [teams.away && teams.away.team, teams.home && teams.home.team].filter(Boolean);
  }

  /**
   * Find the schedule game a set of tokens (pane logo alts, rail abbrs) refers
   * to.
   *
   * Two ambiguity problems live here. Tokens like "Chicago" name two
   * franchises — those must refuse to match. And the schedule window spans
   * yesterday..tomorrow, so mid-series the same matchup appears two or three
   * times; a pane showing today's live game must not match yesterday's final.
   * So: tokens must identify a single set of franchises, and among that
   * matchup's games the one actually being played wins, then the next to
   * start, then the most recent final.
   */
  function matchGame(games, tokens) {
    const clean = (tokens || []).map(normalizeToken).filter(Boolean);
    if (!clean.length) return null;

    const hits = (games || []).filter((game) => {
      const teams = gameTeams(game);
      return clean.every((token) => teams.some((team) => tokenMatchesTeam(token, team)));
    });
    if (!hits.length) return null;

    // Every token must resolve to exactly one franchise across the hits —
    // otherwise "Chicago" would happily claim both the Cubs and the White Sox.
    for (const token of clean) {
      const franchises = new Set();
      for (const game of hits) {
        for (const team of gameTeams(game)) {
          if (tokenMatchesTeam(token, team)) franchises.add(normalizeToken(team.abbreviation));
        }
      }
      if (franchises.size > 1) return null;
    }

    // Series preference: playing now > starting next > most recently finished.
    return (
      hits.find((g) => {
        const kind = classifyApiGame(g);
        return kind === 'live' || kind === 'paused';
      }) ||
      hits.find((g) => classifyApiGame(g) === 'preview') ||
      hits[hits.length - 1]
    );
  }

  /**
   * Match a pane to a game from its visible text — the scorebug ("SF 0 TEX 0"),
   * a graphic ("REDS BULLPEN"). Finds which franchises the text mentions; one
   * or two distinct franchises resolve through matchGame, anything else (a
   * ticker naming half the league, a press conference naming nobody) is null.
   */
  function matchGameByText(games, text) {
    const words = String(text || '').match(/[A-Za-z][A-Za-z-]{1,15}/g) || [];
    if (!words.length) return null;
    const tokens = new Set(words.map(normalizeToken));

    const franchises = new Map(); // abbr -> a token that named it
    for (const game of games || []) {
      for (const team of gameTeams(game)) {
        const abbr = normalizeToken(team.abbreviation);
        if (franchises.has(abbr)) continue;
        const alias = teamAliases(team).find((a) => tokens.has(a));
        if (alias) franchises.set(abbr, alias);
      }
    }
    if (franchises.size === 0 || franchises.size > 2) return null;
    return matchGame(games, [...franchises.keys()]);
  }

  /** Match by gamePk when the pane key carries one ("game:824158"). */
  function matchByKey(games, key) {
    const m = /^game:(\d+)$/.exec(String(key || ''));
    if (!m) return null;
    const pk = Number(m[1]);
    return (games || []).find((g) => g.gamePk === pk) || null;
  }

  // ------------------------------------------------------------- rankings

  /**
   * Rank of a game under the user's team priorities: the best (lowest) rank of
   * any team playing in it. Games with none of the user's teams rank after all
   * games that have one.
   */
  function teamRankOfGame(game, teamPriorities) {
    const priorities = (teamPriorities || []).map(normalizeToken).filter(Boolean);
    if (!priorities.length || !game) return Number.MAX_SAFE_INTEGER;
    let best = Number.MAX_SAFE_INTEGER;
    for (const team of gameTeams(game)) {
      const aliases = teamAliases(team);
      for (let i = 0; i < priorities.length; i++) {
        if (i < best && aliases.includes(priorities[i])) best = i;
      }
    }
    return best;
  }

  /**
   * Order pane keys for the selector: team priority first, the user's manual
   * feed order second, display position last. With no team priorities set this
   * degrades to exactly the old behaviour.
   */
  function orderKeys(panes, { games, teamPriorities, feedPriorities }) {
    const feedRank = (key) => {
      const i = (feedPriorities || []).indexOf(key);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    const scored = (panes || []).map((pane, index) => {
      const game =
        matchByKey(games, pane.key) || matchGame(games, pane.tokens || tokensFromKey(pane.key));
      return { key: pane.key, index, team: teamRankOfGame(game, teamPriorities), feed: feedRank(pane.key) };
    });
    scored.sort((a, b) => a.team - b.team || a.feed - b.feed || a.index - b.index);
    return scored.map((s) => s.key);
  }

  /** Recover team tokens from a "teams:padres v d-backs" pane key. */
  function tokensFromKey(key) {
    const m = /^teams:(.+) v (.+)$/.exec(String(key || ''));
    return m ? [m[1], m[2]] : [];
  }

  // ------------------------------------------------------------- interest

  /**
   * How watchable a game is, from its score and inning: closeness plus
   * lateness. A one-run game in the 9th far outranks a blowout in the 3rd.
   * Replays score by how close the final was; previews barely register (they
   * only matter when nothing is live).
   */
  function interestScore(game) {
    const kind = classifyApiGame(game);
    const ls = (game && game.linescore) || {};
    const runsAway = ls.teams && ls.teams.away ? ls.teams.away.runs : undefined;
    const runsHome = ls.teams && ls.teams.home ? ls.teams.home.runs : undefined;
    const haveRuns = Number.isFinite(runsAway) && Number.isFinite(runsHome);
    const diff = haveRuns ? Math.abs(runsAway - runsHome) : 2;
    const closeness = Math.max(0, 20 - diff * 4);
    const inning = ls.currentInning || 0;

    if (kind === 'live' || kind === 'paused') {
      let score = 50 + Math.min(27, inning * 3) + closeness;
      if (inning > 9) score += 10; // extra innings
      return score;
    }
    if (kind === 'final') return 30 + closeness;
    if (kind === 'preview') return 10;
    return 0;
  }

  /**
   * Is a ranked team getting blown out? Down six or more from the sixth inning
   * on, the designation stops pinning the audio — the user asked for a more
   * interesting game when their team is losing heavily.
   */
  function teamBlowoutLoss(game, teamPriorities) {
    const priorities = (teamPriorities || []).map(normalizeToken).filter(Boolean);
    if (!priorities.length || !game) return false;
    const ls = game.linescore || {};
    if (!ls.teams || (ls.currentInning || 0) < 6) return false;

    const sides = [
      { team: game.teams.away.team, runs: ls.teams.away && ls.teams.away.runs },
      { team: game.teams.home.team, runs: ls.teams.home && ls.teams.home.runs },
    ];
    for (let i = 0; i < sides.length; i++) {
      const mine = sides[i];
      const theirs = sides[1 - i];
      if (!Number.isFinite(mine.runs) || !Number.isFinite(theirs.runs)) continue;
      const ranked = teamAliases(mine.team).some((a) => priorities.includes(a));
      if (ranked && theirs.runs - mine.runs >= 6) return true;
    }
    return false;
  }

  /**
   * The full pecking order:
   *   1. the pane the user manually placed the audio on — their click is the
   *      strongest evidence of what matters and defaults to the top;
   *   2. panes with a designated team (best rank first) — unless that team is
   *      being blown out, in which case interest takes over;
   *   3. everything else by interest, most watchable first.
   *
   * Position 0 of the result is the only pane upgrades may return to; the rest
   * of the order just decides where escapes land.
   *
   * @param {Array<{key, teamRank, interest, blowout}>} entries in display order
   */
  function buildPriorities(entries, heldKey) {
    const list = (entries || []).map((e, index) => ({ ...e, index }));
    const held = heldKey ? list.filter((e) => e.key === heldKey) : [];
    const heldKeys = new Set(held.map((e) => e.key));
    const teamed = list
      .filter((e) => !heldKeys.has(e.key) && e.teamRank !== Number.MAX_SAFE_INTEGER && !e.blowout)
      .sort((a, b) => a.teamRank - b.teamRank || a.index - b.index);
    const taken = new Set([...heldKeys, ...teamed.map((e) => e.key)]);
    const rest = list
      .filter((e) => !taken.has(e.key))
      .sort((a, b) => (b.interest || 0) - (a.interest || 0) || a.index - b.index);
    return [...held, ...teamed, ...rest].map((e) => e.key);
  }

  // ----------------------------------------------------------- break episodes

  /**
   * Break state as an episode with realistic timing, instead of reacting to
   * every banner flicker. MLB's between-inning ad pods run ~2:15 (2:40 for
   * national broadcasts), so:
   *
   *  - a sighting only *confirms* a break after persisting confirmMs (one
   *    stray scan never triggers anything);
   *  - once confirmed, the pane is locked in-break for minBreakMs regardless
   *    of banner flicker — there is no point re-checking a 15s-old ad pod;
   *  - past the lock, the break ends when the banner has been gone clearMs;
   *  - after ending, the pane cools coolMs before it can receive audio again.
   */
  function breakEpisode(prev, sighted, now, opts = {}) {
    const confirmMs = opts.confirmMs ?? 2000;
    const minBreakMs = opts.minBreakMs ?? 110000;
    const clearMs = opts.clearMs ?? 6000;
    const coolMs = opts.coolMs ?? 30000;

    let s = prev ? { ...prev } : null;
    if (sighted) {
      // A sighting extends the current episode while that episode is still
      // in-break; otherwise (retired, cooling, or a stale unconfirmed blip)
      // it starts a new pod.
      let sameEpisode = false;
      if (s) {
        if (s.confirmedAt) {
          const locked = now - s.confirmedAt < minBreakMs;
          const recent = now - s.lastSeen < clearMs;
          sameEpisode = locked || recent;
        } else {
          sameEpisode = now - s.lastSeen <= 30000;
        }
      }
      if (!sameEpisode) s = { firstSeen: now, lastSeen: now, confirmedAt: 0 };
      else s.lastSeen = now;
      if (!s.confirmedAt && now - s.firstSeen >= confirmMs) s.confirmedAt = now;
    }
    if (!s) return { state: null, inBreak: false, cooling: false };

    const confirmed = Boolean(s.confirmedAt);
    const locked = confirmed && now - s.confirmedAt < minBreakMs;
    const recentlySeen = now - s.lastSeen < clearMs;
    const inBreak = confirmed && (locked || recentlySeen);
    const endedAt = confirmed ? Math.max(s.lastSeen + clearMs, s.confirmedAt + minBreakMs) : 0;
    const cooling = confirmed && !inBreak && now - endedAt < coolMs;
    // Retire stale state so a new sighting starts a fresh episode.
    if (!inBreak && !cooling && confirmed) return { state: null, inBreak: false, cooling: false };
    return { state: s, inBreak, cooling };
  }

  // -------------------------------------------------------------- liveness

  /** Pane text that means "this feed is filler, not baseball". */
  const PREGAME_TEXT = /\b(coming up|first pitch|lineups|pregame|postgame|game over|watch live|starts? (at|in))\b/i;

  /** Exposed so the worker can spot filler feeds in replay mode. */
  function looksLikeFiller(text) {
    return PREGAME_TEXT.test(String(text || ''));
  }

  /**
   * Is actual baseball playing on this pane right now?
   *
   * The break banner is authoritative for breaks; the matched game's state is
   * authoritative for final/preview; the pane's own text catches filler feeds
   * when no game could be matched at all.
   */
  function paneLiveness(pane, game) {
    if (pane && pane.inBreak) return { live: false, reason: 'commercial break' };
    if (game) {
      const kind = classifyApiGame(game);
      if (kind === 'final') return { live: false, reason: 'game is final' };
      if (kind === 'preview') return { live: false, reason: 'game has not started' };
      if (kind === 'paused') return { live: false, reason: 'game is delayed' };
      return { live: true, reason: 'in progress' };
    }
    if (pane && pane.railState) {
      if (pane.railState.kind === 'final') return { live: false, reason: 'rail says final' };
      if (pane.railState.kind === 'preview') return { live: false, reason: 'rail says not started' };
      if (pane.railState.kind === 'paused') return { live: false, reason: 'rail says delayed' };
      if (pane.railState.kind === 'live') return { live: true, reason: 'rail says in progress' };
    }
    if (pane && PREGAME_TEXT.test(pane.text || '')) {
      return { live: false, reason: 'pane is showing filler' };
    }
    // No evidence either way: assume live rather than yank the audio around.
    return { live: true, reason: 'assumed live' };
  }

  // -------------------------------------------------------------- tuning

  /**
   * Should a pane be swapped for an off-screen game, and which rail card gets
   * us there?
   *
   * Fires only when (a) some pane is not showing live baseball and (b) a live
   * game exists that is not on screen. Among candidates, the user's team
   * priorities pick the winner. Returns the rail card to click and the pane to
   * give up, or null.
   */
  function pickTuneTarget({ panes, games, railCards, teamPriorities, skipGamePks, replayMode }) {
    // Only expendable panes are up for replacement. The caller may mark them
    // explicitly (replay mode has its own rules); the default is truly dead
    // panes only. A commercial break is NOT dead — that game is about to come
    // back, and replacing (or even focusing) its pane is exactly the "it
    // clicked into the break window" bug.
    const deadPanes = (panes || [])
      .map((pane, index) => ({ pane, index }))
      .filter(({ pane }) =>
        pane.expendable !== undefined ? pane.expendable : !pane.live && !pane.inBreak
      );
    if (!deadPanes.length) return null;

    const onScreen = new Set(
      (panes || []).map((p) => p.gamePk).filter((pk) => pk != null)
    );
    const skip = new Set(skipGamePks || []);

    // The hunt ladder: live games first; when nothing is live, the soonest
    // upcoming game (its pregame feed turns into the game); on replay nights,
    // finished games. A pane already showing an upcoming game is never
    // replaced by another upcoming game — that would just churn pregame feeds.
    const ladder = replayMode ? ['final'] : ['live', 'preview'];

    let best = null;
    let bestKind = null;
    for (const wantKind of ladder) {
      /**
       * A card is clickable for a game only if its own printed state agrees
       * ("Bot 3" for live hunting, "Final" for replays; unparseable text
       * defers to the API). This disambiguates doubleheaders: both cards
       * carry the same team tokens but print different states.
       */
      const cardShowsPlayable = (c) => {
        const kind = parseRailState(c.text || '').kind;
        return kind === wantKind || kind === 'unknown';
      };

      const candidates = (games || [])
        .filter((g) => classifyApiGame(g) === wantKind)
        .filter((g) => !onScreen.has(g.gamePk) && !skip.has(g.gamePk))
        .map((g) => {
          const card = (railCards || []).findIndex(
            (c) => !c.viewing && cardShowsPlayable(c) && matchGame([g], c.tokens || []) === g
          );
          return { game: g, cardIndex: card, rank: teamRankOfGame(g, teamPriorities) };
        })
        .filter((c) => c.cardIndex !== -1);
      if (!candidates.length) continue;

      if (wantKind === 'preview') {
        // Soonest first — the next game to start.
        candidates.sort(
          (a, b) =>
            a.rank - b.rank ||
            String(a.game.gameDate || '').localeCompare(String(b.game.gameDate || '')) ||
            a.game.gamePk - b.game.gamePk
        );
      } else {
        // Designated teams first, then the most watchable game.
        candidates.sort(
          (a, b) =>
            a.rank - b.rank ||
            interestScore(b.game) - interestScore(a.game) ||
            a.game.gamePk - b.game.gamePk
        );
      }
      best = candidates[0];
      bestKind = wantKind;
      break;
    }
    if (!best) return null;

    // Loading a preview over a preview is churn, not progress.
    const replaceable =
      bestKind === 'preview' ? deadPanes.filter(({ pane }) => pane.kind !== 'preview') : deadPanes;
    if (!replaceable.length) return null;

    // Give up the least-loved dead pane (by the user's team priorities), and
    // among equals the later display position — the favourite's pane is the
    // last one sacrificed.
    const paneRank = ({ pane }) =>
      teamRankOfGame(
        (games || []).find((g) => g.gamePk === pane.gamePk),
        teamPriorities
      );
    replaceable.sort((a, b) => paneRank(b) - paneRank(a) || b.index - a.index);

    return {
      gamePk: best.game.gamePk,
      cardIndex: best.cardIndex,
      replaceIndex: replaceable[0].index,
    };
  }

  return {
    parseRailState,
    classifyApiGame,
    betweenInnings,
    describeApiGame,
    normalizeToken,
    teamAliases,
    tokenMatchesTeam,
    matchGame,
    matchGameByText,
    matchByKey,
    teamRankOfGame,
    interestScore,
    teamBlowoutLoss,
    buildPriorities,
    breakEpisode,
    orderKeys,
    tokensFromKey,
    paneLiveness,
    pickTuneTarget,
  };
});
