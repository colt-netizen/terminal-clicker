const test = require('node:test');
const assert = require('node:assert');

const { create, push, bandEnergyDb } = require('../src/shared/speech-detector.js');

const FRAME_MS = 50;

/**
 * Feed a sequence of dB readings and report what the detector concluded over
 * the final `tailFrames` frames — the steady-state answer, past warm-up.
 */
function feed(levels, { tailFrames = 20, cfg } = {}) {
  const state = create(cfg);
  let now = 0;
  const results = [];
  for (const db of levels) {
    results.push(push(state, db, now));
    now += FRAME_MS;
  }
  const tail = results.slice(-tailFrames);
  return {
    state,
    results,
    speechFraction: tail.filter((r) => r.speechPresent).length / tail.length,
    floorDb: state.floorDb,
  };
}

const seconds = (n) => Math.round((n * 1000) / FRAME_MS);
const steady = (db, n) => new Array(n).fill(db);

/** Alternating bursts and gaps, the shape real commentary makes. */
function speechLike(loudDb, gapDb, frames) {
  const out = [];
  for (let i = 0; i < frames; i++) {
    // ~500ms of talking, ~250ms of gap.
    out.push(i % 15 < 10 ? loudDb : gapDb);
  }
  return out;
}

test('digital silence is not speech', () => {
  const { speechFraction } = feed(steady(-100, seconds(10)));
  assert.strictEqual(speechFraction, 0);
});

test('steady crowd noise is absorbed into the floor, not called speech', () => {
  const { speechFraction } = feed(steady(-45, seconds(15)));
  assert.strictEqual(speechFraction, 0, 'constant ambience must not read as commentary');
});

test('steady music at high level is still not speech', () => {
  // Loud but unvarying — a break slate with walk-up music.
  const { speechFraction } = feed(steady(-25, seconds(15)));
  assert.strictEqual(speechFraction, 0);
});

test('commentary over a crowd bed reads as speech', () => {
  const { speechFraction } = feed(speechLike(-28, -50, seconds(15)));
  assert.ok(speechFraction > 0.5, `expected mostly speech, got ${speechFraction}`);
});

test('commentary is still detected when the crowd bed is loud', () => {
  // Playoff crowd: ambience only 12dB below the announcer.
  const { speechFraction } = feed(speechLike(-25, -40, seconds(15)));
  assert.ok(speechFraction > 0.5, `expected speech over loud ambience, got ${speechFraction}`);
});

test('a quiet echoey break after commentary stops reading as speech', () => {
  // The reported failure mode: commentary, then a break that is quieter and
  // inconsistent but definitely not silent.
  const levels = [
    ...speechLike(-28, -50, seconds(12)),
    ...[...Array(seconds(8))].map((_, i) => (i % 7 < 2 ? -52 : -58)), // echoey bed
  ];
  const { speechFraction } = feed(levels);
  assert.strictEqual(speechFraction, 0, 'quiet inconsistent ambience must not read as speech');
});

test('speech is picked back up when commentary resumes after a break', () => {
  const levels = [
    ...speechLike(-28, -50, seconds(10)),
    ...steady(-55, seconds(10)),
    ...speechLike(-28, -50, seconds(6)),
  ];
  const { speechFraction } = feed(levels);
  assert.ok(speechFraction > 0.5, `expected recovery, got ${speechFraction}`);
});

test('a single loud transient is not enough to call speech', () => {
  // Bat crack / crowd surge: one frame, well above the bed.
  const levels = [...steady(-55, seconds(8)), -20, ...steady(-55, seconds(2))];
  const { results } = feed(levels);
  const spikeWindow = results.slice(seconds(8), seconds(8) + 3);
  assert.ok(
    spikeWindow.every((r) => !r.speechPresent),
    'one loud frame should be averaged away, not treated as commentary'
  );
});

test('the floor falls faster than it rises', () => {
  const quietAfterLoud = feed([...steady(-20, seconds(5)), ...steady(-60, seconds(2))]);
  const loudAfterQuiet = feed([...steady(-60, seconds(5)), ...steady(-20, seconds(2))]);
  const fell = -20 - quietAfterLoud.floorDb;
  const rose = loudAfterQuiet.floorDb - -60;
  assert.ok(fell > rose, `floor fell ${fell}dB but rose ${rose}dB in the same time`);
});

test('sustained speech does not drag the floor up to meet itself', () => {
  // 20s of continuous commentary with normal inter-word gaps.
  const { speechFraction } = feed(speechLike(-28, -50, seconds(20)));
  assert.ok(speechFraction > 0.5, `detector went deaf to sustained speech: ${speechFraction}`);
});

test('a raised margin makes the detector stricter', () => {
  const levels = speechLike(-40, -50, seconds(12)); // only 10dB of headroom
  const loose = feed(levels, { cfg: { marginDb: 4 } });
  const strict = feed(levels, { cfg: { marginDb: 20 } });
  assert.ok(loose.speechFraction > strict.speechFraction);
  assert.strictEqual(strict.speechFraction, 0);
});

test('bandEnergyDb ignores content outside the speech band', () => {
  const fftSize = 2048;
  const sampleRate = 48000;
  const bins = new Float32Array(fftSize / 2).fill(-100);
  // Deep bass only — stadium rumble, no voice.
  const hzPerBin = sampleRate / fftSize;
  for (let i = 1; i < Math.floor(200 / hzPerBin); i++) bins[i] = -10;
  const bass = bandEnergyDb(bins, sampleRate, fftSize);

  const voice = new Float32Array(fftSize / 2).fill(-100);
  for (let i = Math.floor(400 / hzPerBin); i < Math.floor(3000 / hzPerBin); i++) voice[i] = -10;
  const speech = bandEnergyDb(voice, sampleRate, fftSize);

  assert.ok(speech > bass + 20, `speech ${speech}dB should dominate bass ${bass}dB`);
});

test('bandEnergyDb survives -Infinity bins', () => {
  const bins = new Float32Array(1024).fill(-Infinity);
  assert.strictEqual(bandEnergyDb(bins, 48000, 2048), -Infinity);
});

// --- the slate-murmur failure observed live ---

test('steady murmur after silence never reads as speech, at any loudness', () => {
  // The live failure: silence sank the floor to -90, then a slate's flat
  // -56dB crowd drone measured "27dB above floor" and read as speech for
  // minutes. Flatness must veto it.
  for (const murmur of [-75, -65, -56]) {
    const levels = [...steady(-90, seconds(6)), ...steady(murmur, seconds(20))];
    const { speechFraction } = feed(levels);
    assert.strictEqual(speechFraction, 0, `flat ${murmur}dB drone must not be speech`);
  }
});

test('commentary right after silence is still detected', () => {
  const levels = [...steady(-90, seconds(6)), ...speechLike(-28, -50, seconds(10))];
  const { speechFraction } = feed(levels);
  assert.ok(speechFraction > 0.5, `expected speech after silence, got ${speechFraction}`);
});

test('slightly wavering murmur still fails the spread gate', () => {
  // +-2dB wobble — far short of word-level modulation.
  const levels = [...Array(seconds(20))].map((_, i) => -60 + (i % 3) - 1);
  const { speechFraction } = feed(levels.map((v) => v));
  assert.strictEqual(speechFraction, 0);
});
