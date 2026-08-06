const test = require('node:test');
const assert = require('node:assert');

const { choose, mergePriorities, reorder, rankOf, UNRANKED } = require('../src/shared/pane-selector.js');

const pane = (key, inBreak = false) => ({ key, inBreak });

test('stays put when the current pane is fine and top-ranked', () => {
  const result = choose({
    panes: [pane('dbacks'), pane('mets')],
    priorities: ['dbacks', 'mets'],
    currentIndex: 0,
    audioDead: false,
  });
  assert.strictEqual(result, null);
});

test('leaves a pane that is on a commercial break', () => {
  const result = choose({
    panes: [pane('dbacks', true), pane('mets')],
    priorities: ['dbacks', 'mets'],
    currentIndex: 0,
    audioDead: false,
  });
  assert.strictEqual(result.index, 1);
  assert.match(result.reason, /commercial break/);
});

test('returns to the top-priority game when its break ends', () => {
  // We fell back to mets; dbacks is live again and outranks it.
  const result = choose({
    panes: [pane('dbacks'), pane('mets')],
    priorities: ['dbacks', 'mets'],
    currentIndex: 1,
    audioDead: false,
  });
  assert.strictEqual(result.index, 0);
  assert.match(result.reason, /higher-priority/);
});

test('does not leave a higher-priority pane for a lower one on a whim', () => {
  const result = choose({
    panes: [pane('dbacks'), pane('mets')],
    priorities: ['dbacks', 'mets'],
    currentIndex: 0,
    audioDead: false,
  });
  assert.strictEqual(result, null);
});

test('holds when every game is on a break', () => {
  const result = choose({
    panes: [pane('a', true), pane('b', true), pane('c', true)],
    priorities: ['a', 'b', 'c'],
    currentIndex: 0,
    audioDead: true,
  });
  assert.strictEqual(result, null, 'trading one break for another is pointless');
});

test('respects priority order rather than display order', () => {
  // Third pane on screen is the favourite; the first is on a break.
  const result = choose({
    panes: [pane('a', true), pane('b'), pane('c')],
    priorities: ['c', 'b', 'a'],
    currentIndex: 0,
    audioDead: false,
  });
  assert.strictEqual(result.index, 2);
});

test('picks up audio-dead panes even with no break banner', () => {
  const result = choose({
    panes: [pane('a'), pane('b')],
    priorities: ['a', 'b'],
    currentIndex: 1,
    audioDead: true,
  });
  // 'a' outranks 'b' anyway, so it moves — the point is it does not sit still.
  assert.strictEqual(result.index, 0);
});

test('audio-dead moves off the favourite when nothing outranks it', () => {
  const result = choose({
    panes: [pane('a'), pane('b')],
    priorities: ['a', 'b'],
    currentIndex: 0,
    audioDead: true,
  });
  assert.strictEqual(result.index, 1);
  assert.match(result.reason, /no audio/);
});

test('adopts a pane when nothing is currently carrying audio', () => {
  const result = choose({
    panes: [pane('a'), pane('b')],
    priorities: ['b', 'a'],
    currentIndex: -1,
    audioDead: false,
  });
  assert.strictEqual(result.index, 1, 'b is top priority and sits at display index 1');
});

test('unranked panes sort after ranked ones', () => {
  assert.strictEqual(rankOf('known', ['known']), 0);
  assert.strictEqual(rankOf('stranger', ['known']), UNRANKED);
  const result = choose({
    panes: [pane('stranger'), pane('known')],
    priorities: ['known'],
    currentIndex: 0,
    audioDead: false,
  });
  assert.strictEqual(result.index, 1);
});

test('ties break by display order so the choice is stable', () => {
  const result = choose({
    panes: [pane('x'), pane('y')],
    priorities: [],
    currentIndex: -1,
    audioDead: false,
  });
  assert.strictEqual(result.index, 0);
});

test('a single pane is never switched away from', () => {
  assert.strictEqual(
    choose({ panes: [pane('a', true)], priorities: ['a'], currentIndex: 0, audioDead: true }),
    null
  );
});

// --- priority list maintenance, across 2/3/4-game modes ---

test('new games are appended without disturbing existing priorities', () => {
  const merged = mergePriorities(['mets', 'dbacks'], ['dbacks', 'yankees', 'mets']);
  assert.deepStrictEqual(merged, ['mets', 'dbacks', 'yankees']);
});

test('dropping from 4-game to 2-game mode keeps the absent games ranked', () => {
  // Only two panes visible now, but the other two keep their slots for later.
  const merged = mergePriorities(['a', 'b', 'c', 'd'], ['a', 'c']);
  assert.deepStrictEqual(merged, ['a', 'b', 'c', 'd']);
});

test('merging is idempotent', () => {
  const once = mergePriorities(['a'], ['a', 'b']);
  assert.deepStrictEqual(mergePriorities(once, ['a', 'b']), once);
});

test('reorder moves a key up and down', () => {
  assert.deepStrictEqual(reorder(['a', 'b', 'c'], 'c', -1), ['a', 'c', 'b']);
  assert.deepStrictEqual(reorder(['a', 'b', 'c'], 'a', 1), ['b', 'a', 'c']);
});

test('reorder clamps at the ends and ignores unknown keys', () => {
  assert.deepStrictEqual(reorder(['a', 'b'], 'a', -1), ['a', 'b']);
  assert.deepStrictEqual(reorder(['a', 'b'], 'b', 1), ['a', 'b']);
  assert.deepStrictEqual(reorder(['a', 'b'], 'zz', -1), ['a', 'b']);
});

// --- notLive: game-state awareness ---

test('leaves a pane whose game is not live baseball', () => {
  const result = choose({
    panes: [{ key: 'a', inBreak: false, notLive: true, notLiveReason: 'game is final' }, pane('b')],
    priorities: ['a', 'b'],
    currentIndex: 0,
    audioDead: false,
  });
  assert.strictEqual(result.index, 1);
  assert.strictEqual(result.reason, 'game is final');
});

test('never selects a notLive pane as the destination', () => {
  const result = choose({
    panes: [pane('a', true), { key: 'b', notLive: true }, pane('c')],
    priorities: ['a', 'b', 'c'],
    currentIndex: 0,
    audioDead: false,
  });
  assert.strictEqual(result.index, 2, 'b is dead even though it outranks c');
});

test('a break slate loses to a dead-but-watchable pane (replay fallback)', () => {
  // Replay night: the user's chosen replays all read "not live". Sitting on a
  // "Commercial Break in Progress" slate while a replay plays next door is
  // wrong — anything that is not a break screen is watchable.
  const result = choose({
    panes: [pane('a', true), { key: 'b', notLive: true, notLiveReason: 'no live MLB games right now' }],
    priorities: ['a', 'b'],
    currentIndex: 0,
    audioDead: true,
  });
  assert.strictEqual(result.index, 1);
});

test('replays do not bounce among themselves', () => {
  // Both panes are dead replays, neither in break: moving gains nothing.
  const result = choose({
    panes: [
      { key: 'a', notLive: true },
      { key: 'b', notLive: true },
    ],
    priorities: ['a', 'b'],
    currentIndex: 0,
    audioDead: false,
  });
  assert.strictEqual(result, null);
});

test('a replay yields the moment genuinely live baseball appears', () => {
  const result = choose({
    panes: [{ key: 'replay', notLive: true }, pane('livegame')],
    priorities: [],
    currentIndex: 0,
    audioDead: false,
  });
  assert.strictEqual(result.index, 1);
});

test('replay night: leaves a break and returns when the break ends', () => {
  const during = choose({
    panes: [{ key: 'fav', inBreak: true }, { key: 'other', notLive: true }],
    priorities: ['fav'],
    currentIndex: 0,
    audioDead: false,
  });
  assert.strictEqual(during.index, 1, 'leave the slate for the watchable replay');

  const after = choose({
    panes: [
      { key: 'fav', notLive: true },
      { key: 'other', notLive: true },
    ],
    priorities: ['fav'],
    currentIndex: 1,
    audioDead: false,
  });
  assert.strictEqual(after.index, 0, 'ranked favourite pulls the audio back');
});

// --- paused: between half-innings (destination filter only) ---

test('being between innings is never a reason to leave', () => {
  const result = choose({
    panes: [{ key: 'a', paused: true }, pane('b')],
    priorities: ['a', 'b'],
    currentIndex: 0,
    audioDead: false,
  });
  assert.strictEqual(result, null, 'no half-inning ping-pong');
});

test('a paused pane is never picked as a destination', () => {
  const result = choose({
    panes: [pane('a', true), { key: 'b', paused: true }, pane('c')],
    priorities: ['a', 'b', 'c'],
    currentIndex: 0,
    audioDead: false,
  });
  assert.strictEqual(result.index, 2, 'b outranks c but is between innings');
});

test('return-to-favourite waits until the favourite is back in action', () => {
  const paused = choose({
    panes: [{ key: 'fav', paused: true }, pane('other')],
    priorities: ['fav', 'other'],
    currentIndex: 1,
    audioDead: false,
  });
  assert.strictEqual(paused, null, 'favourite is between innings — stay put');

  const resumed = choose({
    panes: [pane('fav'), pane('other')],
    priorities: ['fav', 'other'],
    currentIndex: 1,
    audioDead: false,
  });
  assert.strictEqual(resumed.index, 0, 'favourite resumed — go back');
});

test('a break falls back to a between-innings pane when nothing is mid-action', () => {
  // Both are ad windows, but the paused pane has baseball seconds away —
  // better than a static break slate.
  const result = choose({
    panes: [pane('a', true), { key: 'b', paused: true }],
    priorities: ['a', 'b'],
    currentIndex: 0,
    audioDead: true,
  });
  assert.strictEqual(result.index, 1);
});

// --- escape-only: upgrades never steal from a playing game ---

test('a playing pane keeps audio even when a higher-priority pane is available', () => {
  const result = choose({
    panes: [pane('fav'), pane('other')],
    priorities: ['fav', 'other'],
    currentIndex: 1,
    audioDead: false,
    allowUpgrade: false,
  });
  assert.strictEqual(result, null, 'no bopping around while the current game plays');
});

test('escapes still fire with upgrades disabled', () => {
  const fromBreak = choose({
    panes: [pane('a', true), pane('b')],
    priorities: ['a', 'b'],
    currentIndex: 0,
    audioDead: false,
    allowUpgrade: false,
  });
  assert.strictEqual(fromBreak.index, 1, 'leaving a break is an escape, not an upgrade');

  const fromDead = choose({
    panes: [{ key: 'a', notLive: true, notLiveReason: 'game is final' }, pane('b')],
    priorities: ['a', 'b'],
    currentIndex: 0,
    audioDead: false,
    allowUpgrade: false,
  });
  assert.strictEqual(fromDead.index, 1, 'leaving a dead game is an escape');
});

test('escapes land on the highest-priority watchable pane', () => {
  const result = choose({
    panes: [pane('a', true), pane('b'), pane('fav')],
    priorities: ['fav', 'a', 'b'],
    currentIndex: 0,
    audioDead: false,
    allowUpgrade: false,
  });
  assert.strictEqual(result.index, 2, 'priorities pick the destination, never cause a move');
});
