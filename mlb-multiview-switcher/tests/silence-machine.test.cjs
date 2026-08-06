const test = require('node:test');
const assert = require('node:assert');

const { PHASES, initialState, step } = require('../src/shared/silence-machine.js');

const CFG = { silenceThresholdMs: 3000, graceMs: 4000, backoffMs: 20000 };

/** Drive the machine over a script of ticks, collecting emitted actions. */
function run(ticks, { paneCount = 4, blocked = false, startAt = 0, stepMs = 300 } = {}) {
  let state = initialState();
  const switches = [];
  let now = startAt;
  for (const audible of ticks) {
    const out = step(state, { now, audible, blocked, paneCount, cfg: CFG });
    state = out.state;
    if (out.action) switches.push({ at: now, action: out.action });
    now += stepMs;
  }
  return { state, switches, endedAt: now };
}

/** `count` ticks of the same audible value. */
const held = (value, count) => new Array(count).fill(value);

test('audio flowing keeps the machine in watching and never switches', () => {
  const { state, switches } = run(held(true, 50));
  assert.strictEqual(state.phase, PHASES.WATCHING);
  assert.deepStrictEqual(switches, []);
});

test('silence shorter than the threshold does not switch', () => {
  // 9 ticks * 300ms = 2700ms of silence, under the 3000ms threshold.
  const { state, switches } = run([true, ...held(false, 9)]);
  assert.strictEqual(state.phase, PHASES.SILENT);
  assert.deepStrictEqual(switches, []);
});

test('silence past the threshold emits exactly one switch', () => {
  const { switches } = run([true, ...held(false, 12)]);
  assert.strictEqual(switches.length, 1);
  assert.deepStrictEqual(switches[0].action, { type: 'switch' });
});

test('the switch fires no earlier than the configured threshold', () => {
  // Silence starts on the tick at t=300 (index 1), so the earliest legal
  // switch is t=3300.
  const { switches } = run([true, ...held(false, 12)]);
  assert.ok(switches[0].at >= 300 + CFG.silenceThresholdMs, `switched too early at ${switches[0].at}`);
});

test('grace suppresses a second switch while the new pane spins up', () => {
  // Threshold (3s) + grace (4s) + threshold (3s) = 10s before a second switch
  // is legal; 30 ticks only covers 9s.
  const { switches } = run([true, ...held(false, 30)]);
  assert.strictEqual(switches.length, 1);
});

test('still-silent panes are cycled one at a time', () => {
  // Long enough for a full lap: each attempt costs threshold + grace = 7s.
  const { switches } = run([true, ...held(false, 120)]);
  assert.ok(switches.length >= 2, `expected repeated switching, got ${switches.length}`);
  const gap = switches[1].at - switches[0].at;
  assert.ok(gap >= CFG.graceMs, `switches only ${gap}ms apart, grace is ${CFG.graceMs}ms`);
});

test('a full lap of silent panes drops into backoff', () => {
  const paneCount = 3;
  const { state, switches } = run([true, ...held(false, 80)], { paneCount });
  assert.strictEqual(switches.length, paneCount, 'should attempt every pane once');
  assert.strictEqual(state.phase, PHASES.BACKOFF);
});

test('backoff holds off far longer than grace', () => {
  const paneCount = 2;
  const { switches } = run([true, ...held(false, 250)], { paneCount });
  // Attempts 1..2 are a lap, then backoff, then the next lap begins.
  const acrossBackoff = switches[2].at - switches[1].at;
  assert.ok(
    acrossBackoff >= CFG.backoffMs,
    `only ${acrossBackoff}ms across backoff, expected >= ${CFG.backoffMs}ms`
  );
});

test('audio returning resets the attempt counter', () => {
  // Silence -> switch -> audio comes back -> silence again. The second run of
  // silence must start a fresh lap rather than continuing toward backoff.
  const ticks = [true, ...held(false, 12), ...held(true, 5), ...held(false, 12)];
  const { state, switches } = run(ticks, { paneCount: 2 });
  assert.strictEqual(switches.length, 2);
  assert.notStrictEqual(state.phase, PHASES.BACKOFF);
});

test('a single pane is left alone entirely', () => {
  const { state, switches } = run(held(false, 100), { paneCount: 1 });
  assert.strictEqual(state.phase, PHASES.IDLE);
  assert.deepStrictEqual(switches, []);
});

test('blocked (disabled, or tab muted by the user) never switches', () => {
  const { state, switches } = run(held(false, 100), { blocked: true });
  assert.strictEqual(state.phase, PHASES.IDLE);
  assert.deepStrictEqual(switches, []);
});

test('unblocking mid-silence starts the clock fresh rather than firing instantly', () => {
  let state = initialState();
  let now = 0;
  // A long blocked stretch of silence.
  for (let i = 0; i < 100; i++) {
    state = step(state, { now, audible: false, blocked: true, paneCount: 4, cfg: CFG }).state;
    now += 300;
  }
  // First unblocked tick must not immediately switch on stale silence.
  const first = step(state, { now, audible: false, blocked: false, paneCount: 4, cfg: CFG });
  assert.strictEqual(first.action, null);
  assert.strictEqual(first.state.phase, PHASES.SILENT);
  assert.strictEqual(first.state.since, now);
});

test('step is pure — it does not mutate the state it is handed', () => {
  const state = { phase: PHASES.SILENT, since: 0, until: 0, attempts: 0 };
  const snapshot = { ...state };
  step(state, { now: 99999, audible: false, blocked: false, paneCount: 4, cfg: CFG });
  assert.deepStrictEqual(state, snapshot);
});
