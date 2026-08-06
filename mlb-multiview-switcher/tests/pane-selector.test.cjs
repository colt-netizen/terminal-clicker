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
