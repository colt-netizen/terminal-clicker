const test = require('node:test');
const assert = require('node:assert');

const Intel = require('../src/shared/game-intel.js');

// Fixtures mirror the real statsapi.mlb.com shapes captured on 2026-08-05
// (schedule?hydrate=team,linescore).
function team(abbreviation, teamName, locationName, extra = {}) {
  return {
    abbreviation,
    teamName,
    locationName,
    name: `${locationName} ${teamName}`,
    clubName: extra.clubName || teamName,
    shortName: extra.shortName || locationName,
    teamCode: extra.teamCode || abbreviation.toLowerCase(),
  };
}

function game(gamePk, away, home, status, linescore) {
  return { gamePk, teams: { away: { team: away }, home: { team: home } }, status, linescore };
}

const LIVE = { abstractGameState: 'Live', detailedState: 'In Progress' };
const FINAL = { abstractGameState: 'Final', detailedState: 'Final' };
const PREVIEW = { abstractGameState: 'Preview', detailedState: 'Scheduled' };

const SD = team('SD', 'Padres', 'San Diego');
const AZ = team('AZ', 'D-backs', 'Phoenix', { clubName: 'Diamondbacks', shortName: 'Arizona' });
const LAD = team('LAD', 'Dodgers', 'Los Angeles');
const LAA = team('LAA', 'Angels', 'Anaheim', { shortName: 'LA Angels' });
const SF = team('SF', 'Giants', 'San Francisco');
const TEX = team('TEX', 'Rangers', 'Arlington', { shortName: 'Texas' });
const CHC = team('CHC', 'Cubs', 'Chicago');

const GAMES = [
  game(1, SD, AZ, LIVE, { currentInning: 8, inningHalf: 'Bottom' }),
  game(2, LAD, CHC, FINAL),
  game(3, SF, TEX, PREVIEW),
  game(4, LAA, team('BAL', 'Orioles', 'Baltimore'), LIVE, { currentInning: 2, inningHalf: 'Top' }),
];

// ---------------------------------------------------------------- rail text

test('parses inning markers in every spelling the rail uses', () => {
  assert.deepStrictEqual(Intel.parseRailState('Bot 8'), { kind: 'live', half: 'bot', inning: 8 });
  assert.deepStrictEqual(Intel.parseRailState('Top 1'), { kind: 'live', half: 'top', inning: 1 });
  assert.deepStrictEqual(Intel.parseRailState('Mid 5'), { kind: 'live', half: 'mid', inning: 5 });
  assert.deepStrictEqual(Intel.parseRailState('Bottom 12'), { kind: 'live', half: 'bot', inning: 12 });
  assert.deepStrictEqual(Intel.parseRailState('End 9'), { kind: 'live', half: 'end', inning: 9 });
});

test('parses final, delays, and start times from rail cards', () => {
  assert.strictEqual(Intel.parseRailState('Final').kind, 'final');
  assert.strictEqual(Intel.parseRailState('Final SD 4 AZ 8').kind, 'final');
  assert.strictEqual(Intel.parseRailState('PPD').kind, 'paused');
  assert.strictEqual(Intel.parseRailState('Rain Delay').kind, 'paused');
  assert.deepStrictEqual(Intel.parseRailState('1:20 PM'), { kind: 'preview', startText: '1:20 PM' });
  assert.strictEqual(Intel.parseRailState('').kind, 'unknown');
});

test('a card with both an inning and a score reads as live, not preview', () => {
  // "Bot 8" plus "1-2" style digits elsewhere in the card.
  assert.strictEqual(Intel.parseRailState('Bot 8 SD 1 AZ 2').kind, 'live');
});

// ---------------------------------------------------------------- API state

test('classifies the API status shapes seen in production', () => {
  assert.strictEqual(Intel.classifyApiGame(GAMES[0]), 'live');
  assert.strictEqual(Intel.classifyApiGame(GAMES[1]), 'final');
  assert.strictEqual(Intel.classifyApiGame(GAMES[2]), 'preview');
  assert.strictEqual(
    Intel.classifyApiGame(game(9, SD, AZ, { abstractGameState: 'Preview', detailedState: 'Warmup' })),
    'preview'
  );
  assert.strictEqual(
    Intel.classifyApiGame(game(9, SD, AZ, { abstractGameState: 'Live', detailedState: 'Delayed: Rain' })),
    'paused'
  );
  assert.strictEqual(
    Intel.classifyApiGame(game(9, SD, AZ, { abstractGameState: 'Final', detailedState: 'Game Over' })),
    'final'
  );
  assert.strictEqual(Intel.classifyApiGame({}), 'unknown');
});

test('describes games the way the rail would', () => {
  assert.strictEqual(Intel.describeApiGame(GAMES[0]), 'Bot 8');
  assert.strictEqual(Intel.describeApiGame(GAMES[1]), 'Final');
  assert.strictEqual(Intel.describeApiGame(GAMES[3]), 'Top 2');
});

// ------------------------------------------------------------ team matching

test('tokens match on abbreviation, nickname, city, and full name', () => {
  for (const token of ['AZ', 'D-backs', 'DBACKS', 'Diamondbacks', 'Phoenix', 'Phoenix D-backs']) {
    assert.ok(Intel.tokenMatchesTeam(token, AZ), `${token} should match AZ`);
  }
  assert.ok(!Intel.tokenMatchesTeam('SD', AZ));
});

test('LA ambiguity: bare "LA" claims neither the Dodgers nor the Angels', () => {
  assert.ok(!Intel.tokenMatchesTeam('LA', LAD));
  assert.ok(!Intel.tokenMatchesTeam('LA', LAA));
  assert.ok(Intel.tokenMatchesTeam('LAD', LAD));
  assert.ok(!Intel.tokenMatchesTeam('LAD', LAA));
});

test('matches a game from two logo alts', () => {
  assert.strictEqual(Intel.matchGame(GAMES, ['Padres', 'D-backs']), GAMES[0]);
  assert.strictEqual(Intel.matchGame(GAMES, ['SF', 'TEX']), GAMES[2]);
});

test('a single unambiguous token matches; an ambiguous one does not', () => {
  assert.strictEqual(Intel.matchGame(GAMES, ['Padres']), GAMES[0]);
  // "Chicago" could be Cubs or White Sox if both played; here only one Chicago
  // team exists so it matches — then add a second and it must refuse.
  const withSox = [...GAMES, game(5, team('CWS', 'White Sox', 'Chicago'), SD, LIVE)];
  assert.strictEqual(Intel.matchGame(withSox, ['Chicago']), null);
});

test('no tokens, garbage tokens, or empty games match nothing', () => {
  assert.strictEqual(Intel.matchGame(GAMES, []), null);
  assert.strictEqual(Intel.matchGame(GAMES, ['Narwhals']), null);
  assert.strictEqual(Intel.matchGame([], ['SD']), null);
});

test('matchByKey resolves game-pk pane keys and rejects the rest', () => {
  assert.strictEqual(Intel.matchByKey(GAMES, 'game:1'), GAMES[0]);
  assert.strictEqual(Intel.matchByKey(GAMES, 'game:999'), null);
  assert.strictEqual(Intel.matchByKey(GAMES, 'teams:padres v d-backs'), null);
  assert.strictEqual(Intel.matchByKey(GAMES, 'pos:0'), null);
});

// ---------------------------------------------------------------- rankings

test('team rank takes the best team in the game', () => {
  assert.strictEqual(Intel.teamRankOfGame(GAMES[0], ['Padres', 'Cubs']), 0);
  assert.strictEqual(Intel.teamRankOfGame(GAMES[1], ['Padres', 'Cubs']), 1);
  assert.strictEqual(Intel.teamRankOfGame(GAMES[2], ['Padres', 'Cubs']), Number.MAX_SAFE_INTEGER);
});

test('orderKeys puts favourite-team games first, manual order second', () => {
  const panes = [
    { key: 'teams:giants v rangers' },
    { key: 'teams:padres v d-backs' },
    { key: 'teams:dodgers v cubs' },
  ];
  const ordered = Intel.orderKeys(panes, {
    games: GAMES,
    teamPriorities: ['Cubs'],
    feedPriorities: ['teams:padres v d-backs', 'teams:giants v rangers'],
  });
  assert.deepStrictEqual(ordered, [
    'teams:dodgers v cubs', // favourite team
    'teams:padres v d-backs', // manual order
    'teams:giants v rangers',
  ]);
});

test('orderKeys with no team priorities degrades to manual feed order', () => {
  const panes = [{ key: 'b' }, { key: 'a' }];
  const ordered = Intel.orderKeys(panes, {
    games: [],
    teamPriorities: [],
    feedPriorities: ['a', 'b'],
  });
  assert.deepStrictEqual(ordered, ['a', 'b']);
});

// ---------------------------------------------------------------- liveness

test('liveness: API state beats everything except the break banner', () => {
  assert.strictEqual(Intel.paneLiveness({ inBreak: true }, GAMES[0]).live, false);
  assert.strictEqual(Intel.paneLiveness({ inBreak: false }, GAMES[0]).live, true);
  assert.strictEqual(Intel.paneLiveness({ inBreak: false }, GAMES[1]).live, false);
  assert.strictEqual(Intel.paneLiveness({ inBreak: false }, GAMES[2]).live, false);
});

test('liveness: rail state fills in when no game matched', () => {
  assert.strictEqual(Intel.paneLiveness({ railState: { kind: 'final' } }, null).live, false);
  assert.strictEqual(Intel.paneLiveness({ railState: { kind: 'live' } }, null).live, true);
});

test('liveness: filler text marks an unmatched pane dead', () => {
  assert.strictEqual(Intel.paneLiveness({ text: 'Coming Up: Lineups & First Pitch' }, null).live, false);
  assert.strictEqual(Intel.paneLiveness({ text: '1:20 PM FIRST PITCH' }, null).live, false);
});

test('liveness: no evidence means assumed live, never a yank', () => {
  const verdict = Intel.paneLiveness({ text: 'SD 1 AZ 2' }, null);
  assert.strictEqual(verdict.live, true);
});

// ------------------------------------------------------------------ tuning

const rail = (tokens, viewing = false) => ({ tokens, viewing });

test('tunes a dead pane to the best off-screen live game', () => {
  const target = Intel.pickTuneTarget({
    panes: [
      { live: false, gamePk: 2, rank: 1 }, // Dodgers game, final
      { live: true, gamePk: 1, rank: 0 },
    ],
    games: GAMES,
    railCards: [rail(['SD', 'AZ'], true), rail(['LAA', 'BAL'])],
    teamPriorities: [],
  });
  assert.ok(target);
  assert.strictEqual(target.gamePk, 4);
  assert.strictEqual(target.cardIndex, 1);
  assert.strictEqual(target.replaceIndex, 0);
});

test('never tunes while every pane is live', () => {
  const target = Intel.pickTuneTarget({
    panes: [
      { live: true, gamePk: 1 },
      { live: true, gamePk: 4 },
    ],
    games: GAMES,
    railCards: [rail(['LAA', 'BAL'])],
    teamPriorities: [],
  });
  assert.strictEqual(target, null);
});

test('never proposes a game that is already on screen or marked viewing', () => {
  const target = Intel.pickTuneTarget({
    panes: [
      { live: false, gamePk: 4 },
      { live: true, gamePk: 1 },
    ],
    games: GAMES,
    railCards: [rail(['LAA', 'BAL'], true)],
    teamPriorities: [],
  });
  assert.strictEqual(target, null, 'only live candidate is on screen already');
});

test('skips games that failed to tune recently', () => {
  const target = Intel.pickTuneTarget({
    panes: [{ live: false, gamePk: 2 }, { live: true, gamePk: 1 }],
    games: GAMES,
    railCards: [rail(['LAA', 'BAL'])],
    teamPriorities: [],
    skipGamePks: [4],
  });
  assert.strictEqual(target, null);
});

test('team priorities pick between multiple off-screen live games', () => {
  const NYY = team('NYY', 'Yankees', 'New York');
  const BOS = team('BOS', 'Red Sox', 'Boston');
  const games = [...GAMES, game(6, NYY, BOS, LIVE, { currentInning: 5, inningHalf: 'Top' })];
  const target = Intel.pickTuneTarget({
    panes: [{ live: false, gamePk: 2 }, { live: true, gamePk: 1 }],
    games,
    railCards: [rail(['LAA', 'BAL']), rail(['NYY', 'BOS'])],
    teamPriorities: ['Red Sox'],
  });
  assert.strictEqual(target.gamePk, 6);
  assert.strictEqual(target.cardIndex, 1);
});

test('sacrifices the least-favourite dead pane, not the favourite', () => {
  const target = Intel.pickTuneTarget({
    panes: [
      { live: false, gamePk: 2 }, // Dodgers game — the ranked team's pane
      { live: false, gamePk: 3 }, // unranked, not started
    ],
    games: GAMES,
    railCards: [rail(['LAA', 'BAL'])],
    teamPriorities: ['Dodgers'],
  });
  assert.strictEqual(target.replaceIndex, 1);
});

test('a pane on a commercial break is never tune bait', () => {
  // The reported bug: the tuner counted "in break" as dead, then physically
  // clicked that pane to focus it — right into the user's commercial window.
  const target = Intel.pickTuneTarget({
    panes: [
      { live: false, inBreak: true, gamePk: 1 }, // break — coming back, hands off
      { live: true, gamePk: 4 },
    ],
    games: GAMES,
    railCards: [rail(['LAA', 'BAL'])],
    teamPriorities: [],
  });
  assert.strictEqual(target, null);
});

test('doubleheader: only the card whose printed state is live gets clicked', () => {
  const NYY = team('NYY', 'Yankees', 'New York');
  const BOS = team('BOS', 'Red Sox', 'Boston');
  const games = [
    ...GAMES,
    game(10, NYY, BOS, FINAL), // game 1 of the doubleheader, over
    game(11, NYY, BOS, LIVE, { currentInning: 3, inningHalf: 'Bottom' }),
  ];
  const target = Intel.pickTuneTarget({
    panes: [{ live: false, gamePk: 2 }, { live: true, gamePk: 1 }],
    games,
    railCards: [
      { tokens: ['NYY', 'BOS'], viewing: false, text: 'Final NYY BOS' },
      { tokens: ['NYY', 'BOS'], viewing: false, text: 'Bot 3 NYY BOS' },
    ],
    teamPriorities: [],
  });
  assert.strictEqual(target.gamePk, 11);
  assert.strictEqual(target.cardIndex, 1, 'the Final card must not be clicked');
});

test('no rail card for the candidate means no tune', () => {
  const target = Intel.pickTuneTarget({
    panes: [{ live: false, gamePk: 2 }, { live: true, gamePk: 1 }],
    games: GAMES,
    railCards: [],
    teamPriorities: [],
  });
  assert.strictEqual(target, null);
});

// --- between innings ---

test('betweenInnings reads the linescore inningState', () => {
  const mid = game(7, SD, AZ, LIVE, { currentInning: 5, inningHalf: 'Bottom', inningState: 'Middle' });
  const end = game(7, SD, AZ, LIVE, { currentInning: 5, inningHalf: 'Bottom', inningState: 'End' });
  const playing = game(7, SD, AZ, LIVE, { currentInning: 5, inningHalf: 'Bottom', inningState: 'Bottom' });
  assert.strictEqual(Intel.betweenInnings(mid), true);
  assert.strictEqual(Intel.betweenInnings(end), true);
  assert.strictEqual(Intel.betweenInnings(playing), false);
});

test('betweenInnings is false for anything not live', () => {
  assert.strictEqual(Intel.betweenInnings(GAMES[1]), false); // final
  assert.strictEqual(Intel.betweenInnings(GAMES[2]), false); // preview
  assert.strictEqual(Intel.betweenInnings(game(7, SD, AZ, LIVE, undefined)), false);
});

test('describeApiGame prefers Middle/End over the inning half', () => {
  const mid = game(7, SD, AZ, LIVE, { currentInning: 5, inningHalf: 'Bottom', inningState: 'Middle' });
  assert.strictEqual(Intel.describeApiGame(mid), 'Mid 5');
  assert.strictEqual(Intel.describeApiGame(GAMES[0]), 'Bot 8');
});

// --- series ambiguity: the same matchup appears 2-3x in a 3-day window ---

const SD_AZ_SERIES = [
  game(100, SD, AZ, { abstractGameState: 'Final', detailedState: 'Final' }), // yesterday
  game(101, SD, AZ, LIVE, { currentInning: 8, inningHalf: 'Bottom' }), // now
  game(102, SD, AZ, PREVIEW), // tomorrow
];

test('mid-series, tokens resolve to the game being played, not yesterday\'s final', () => {
  assert.strictEqual(Intel.matchGame(SD_AZ_SERIES, ['SD', 'AZ']).gamePk, 101);
  assert.strictEqual(Intel.matchGame(SD_AZ_SERIES, ['Padres']).gamePk, 101);
});

test('with no live game in the series, the next to start wins, then the latest final', () => {
  const noLive = [SD_AZ_SERIES[0], SD_AZ_SERIES[2]];
  assert.strictEqual(Intel.matchGame(noLive, ['SD', 'AZ']).gamePk, 102);
  const allFinal = [
    game(100, SD, AZ, { abstractGameState: 'Final', detailedState: 'Final' }),
    game(103, SD, AZ, { abstractGameState: 'Final', detailedState: 'Final' }),
  ];
  assert.strictEqual(Intel.matchGame(allFinal, ['SD', 'AZ']).gamePk, 103);
});

// --- matching a pane from its visible text ---

test('a scorebug matches its game', () => {
  assert.strictEqual(Intel.matchGameByText(GAMES, 'SF 0 TEX 0 CHANGEUP 84 MPH'), GAMES[2]);
});

test('a graphic naming one team matches when the team is unambiguous', () => {
  const CIN = team('CIN', 'Reds', 'Cincinnati');
  const ATH = team('ATH', 'Athletics', 'Sacramento');
  const games = [...GAMES, game(20, ATH, CIN, LIVE, { currentInning: 6, inningHalf: 'Top' })];
  assert.strictEqual(Intel.matchGameByText(games, 'KEY INGREDIENTS REDS BULLPEN ERA 3.75').gamePk, 20);
});

test('text naming too many teams, or none, matches nothing', () => {
  assert.strictEqual(Intel.matchGameByText(GAMES, 'Padres Cubs Rangers roundup tonight'), null);
  assert.strictEqual(Intel.matchGameByText(GAMES, 'PROGRESSIVE FIELD press conference'), null);
  assert.strictEqual(Intel.matchGameByText(GAMES, ''), null);
});

test('the bare LA in a scorebug does not hijack matching', () => {
  // "LA 1 CHC 0" — LA is ambiguous (Dodgers/Angels) and matches no alias;
  // CHC alone is unambiguous and carries the match.
  assert.strictEqual(Intel.matchGameByText(GAMES, 'LA 1 CHC 0 IMANAGA P: 11'), GAMES[1]);
});
