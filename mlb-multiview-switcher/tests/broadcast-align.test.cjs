const test = require('node:test');
const assert = require('node:assert');

const Align = require('../src/shared/broadcast-align.js');

// A synthetic game: half-innings ~20 game-minutes apart, ad pods of 135s.
const T0 = Date.parse('2026-08-05T18:10:00Z');
const MIN = 60 * 1000;
function synthPlayByPlay() {
  const plays = [];
  let t = T0;
  const halves = [
    ['top', 1], ['bottom', 1], ['top', 2], ['bottom', 2], ['top', 3], ['bottom', 3],
  ];
  // Varied plays per half-inning: real games are irregular, and that
  // irregularity is exactly what makes two-break intersection unambiguous.
  // (A perfectly periodic fixture aliases — every offset shifted by one
  // period ties — which the resolver rightly refuses.)
  const playsPerHalf = [2, 5, 3, 6, 2, 4];
  for (const [idx, [half, inning]] of halves.entries()) {
    for (let i = 0; i < playsPerHalf[idx]; i++) {
      plays.push({
        about: {
          inning,
          halfInning: half,
          startTime: new Date(t).toISOString(),
          endTime: new Date(t + 3 * MIN).toISOString(),
        },
      });
      t += 3 * MIN + 20000;
    }
    t += 135000; // the ad pod
  }
  return { allPlays: plays };
}

const PBP = synthPlayByPlay();
const WINDOWS = Align.adWindows(PBP);

test('ad windows are the gaps between half-innings, with plausible lengths', () => {
  assert.strictEqual(WINDOWS.length, 5, 'five boundaries between six half-innings');
  for (const w of WINDOWS) {
    const len = w.end - w.start;
    assert.ok(len >= 60000 && len <= 360000, `window length ${len}`);
  }
});

test('one confirmed break yields one candidate per window — ambiguous', () => {
  const pos = 40 * MIN; // playback position when the break was confirmed
  const sets = [Align.offsetCandidates(WINDOWS, pos)];
  assert.strictEqual(sets[0].length, WINDOWS.length);
  assert.strictEqual(Align.resolveOffset(sets), null, 'a single break cannot resolve');
});

test('two breaks at different points resolve to the true offset', () => {
  const trueOffset = T0 - 7 * MIN; // broadcast starts 7min into the file
  // Break confirmed inside window 1 and later inside window 3.
  const posA = WINDOWS[1].start + 30000 - trueOffset;
  const posB = WINDOWS[3].start + 60000 - trueOffset;
  const sets = [Align.offsetCandidates(WINDOWS, posA), Align.offsetCandidates(WINDOWS, posB)];
  const resolved = Align.resolveOffset(sets);
  assert.ok(resolved, 'two detections should resolve');
  assert.ok(Math.abs(resolved.offset - trueOffset) < 90000, `offset off by ${resolved.offset - trueOffset}`);
});

test('a resolved offset predicts ad windows and game action correctly', () => {
  const trueOffset = T0 - 7 * MIN;
  const posA = WINDOWS[1].start + 30000 - trueOffset;
  const posB = WINDOWS[3].start + 60000 - trueOffset;
  const { offset } = Align.resolveOffset([
    Align.offsetCandidates(WINDOWS, posA),
    Align.offsetCandidates(WINDOWS, posB),
  ]);

  const inPod = WINDOWS[2].start + 60000 - trueOffset;
  const midAction = WINDOWS[2].end + 3 * MIN - trueOffset;
  assert.strictEqual(Align.inAdWindow(WINDOWS, offset, inPod), true, 'mid-pod predicted');
  assert.strictEqual(Align.inAdWindow(WINDOWS, offset, midAction), false, 'action not flagged');
});

test('window edges are shrunk so predictions never clip action', () => {
  const offset = 0;
  const justInside = WINDOWS[0].start + 5000; // within 10s edge margin
  assert.strictEqual(Align.inAdWindow(WINDOWS, offset, justInside), false);
});

test('one break plus negative evidence resolves without a second break', () => {
  const trueOffset = T0 - 7 * MIN;
  // One confirmed break inside window 1.
  const posA = WINDOWS[1].start + 30000 - trueOffset;
  const sets = [Align.offsetCandidates(WINDOWS, posA)];
  assert.strictEqual(Align.resolveOffset(sets), null, 'one break alone is ambiguous');

  // Confirmed commentary, sampled every 5s the way ambient listening does:
  // the FULL action span between each pair of ad windows (staying 60s clear
  // of the edges, as sustained-speech detection naturally does). Each sample
  // rules out every offset that would have placed it inside a window.
  let bad = [];
  for (let w = 0; w + 1 < WINDOWS.length; w++) {
    for (let wall = WINDOWS[w].end + 60000; wall <= WINDOWS[w + 1].start - 60000; wall += 5000) {
      const pos = wall - trueOffset;
      bad = Align.mergeIntervals([...bad, ...Align.offsetCandidates(WINDOWS, pos)]);
    }
  }
  const resolved = Align.resolveOffset(sets, 20000, bad);
  assert.ok(resolved, 'listening should whittle the candidates to one');
  assert.strictEqual(resolved.support, 1);
  assert.ok(Math.abs(resolved.offset - trueOffset) < 90000, `off by ${resolved.offset - trueOffset}`);
});

test('windowRemaining reports time left in the current pod', () => {
  const offset = 0;
  const pos = WINDOWS[0].start + 30000;
  const remaining = Align.windowRemaining(WINDOWS, offset, pos);
  assert.ok(Math.abs(remaining - (WINDOWS[0].end - WINDOWS[0].start - 30000)) < 5);
  assert.strictEqual(Align.windowRemaining(WINDOWS, null, pos), null);
});
