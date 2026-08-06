/*
 * Decides whether someone is *talking*, from a stream of speech-band energy
 * measurements. Pure maths — the offscreen document feeds it real numbers, the
 * tests feed it synthetic ones.
 *
 * Why not just "is it loud": a ballpark during a break is not silent. Crowd
 * noise, walk-up music and PA echo all keep the tab audible, which is why the
 * boolean tab.audible flag never fires during a commercial. What actually stops
 * is the commentary.
 *
 * The trick is that speech sits *above* whatever the ambient bed happens to be,
 * and the ambient bed differs per stadium, per broadcast, per moment. So rather
 * than an absolute dB threshold, this tracks a noise floor that falls fast and
 * rises slowly, then calls it speech when energy sits far enough above that
 * floor. Continuous tones (music, steady crowd roar) get absorbed into the floor
 * within seconds and stop counting as speech; the gaps between words keep the
 * floor down during real commentary.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MLBSpeechDetector = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DEFAULTS = {
    // How far above the noise floor energy must sit to count as commentary.
    marginDb: 7,
    // Noise floor creeps up this slowly, so sustained speech can't drag the
    // floor up to meet itself within a normal between-pitch gap.
    floorRiseDbPerSec: 0.25,
    // ...but drops toward a quieter reading quickly, so the detector adapts
    // when a loud segment ends.
    floorFallRatio: 0.35,
    // Energy is averaged over this window before comparison, so single-frame
    // spikes (bat crack, crowd surge) don't read as speech.
    recentMs: 700,
    // Frames quieter than this are treated as true silence regardless of floor,
    // which stops the floor chasing digital silence down to -Infinity.
    absoluteFloorDb: -95,
  };

  function create(options) {
    const cfg = { ...DEFAULTS, ...(options || {}) };
    return {
      cfg,
      floorDb: null,
      recent: [], // {t, db}
      lastT: null,
    };
  }

  function mean(values) {
    if (!values.length) return 0;
    let total = 0;
    for (const v of values) total += v;
    return total / values.length;
  }

  /**
   * Feed one measurement.
   *
   * @param {object} state  from create()
   * @param {number} db     speech-band energy for this frame, in dBFS
   * @param {number} now    ms timestamp
   * @returns {{speechPresent: boolean, floorDb: number, recentDb: number}}
   */
  function push(state, db, now) {
    const { cfg } = state;
    const level = Math.max(db, cfg.absoluteFloorDb);

    state.recent.push({ t: now, db: level });
    const cutoff = now - cfg.recentMs;
    while (state.recent.length && state.recent[0].t < cutoff) state.recent.shift();

    const recentDb = mean(state.recent.map((r) => r.db));

    if (state.floorDb === null) {
      state.floorDb = level;
    } else {
      const dt = state.lastT === null ? 0 : Math.max(0, (now - state.lastT) / 1000);
      if (level < state.floorDb) {
        // Fall toward the quieter reading.
        state.floorDb += (level - state.floorDb) * cfg.floorFallRatio;
      } else {
        // Creep upward, capped so the floor never overshoots the signal.
        state.floorDb = Math.min(level, state.floorDb + cfg.floorRiseDbPerSec * dt);
      }
    }
    state.lastT = now;

    return {
      speechPresent: recentDb > state.floorDb + cfg.marginDb,
      floorDb: state.floorDb,
      recentDb,
    };
  }

  /**
   * Convert a frequency-domain frame into a single speech-band energy figure.
   * Sums power across the band that carries voice (roughly 300-3400Hz, the same
   * range telephony settled on) and returns it as dB.
   *
   * @param {Float32Array} bins  per-bin dB, as from getFloatFrequencyData
   * @param {number} sampleRate
   * @param {number} fftSize
   */
  function bandEnergyDb(bins, sampleRate, fftSize, lowHz, highHz) {
    const hzPerBin = sampleRate / fftSize;
    const first = Math.max(1, Math.floor((lowHz || 300) / hzPerBin));
    const last = Math.min(bins.length - 1, Math.ceil((highHz || 3400) / hzPerBin));

    let power = 0;
    let count = 0;
    for (let i = first; i <= last; i++) {
      if (!Number.isFinite(bins[i])) continue;
      power += Math.pow(10, bins[i] / 10);
      count++;
    }
    if (!count || power <= 0) return -Infinity;
    return 10 * Math.log10(power / count);
  }

  return { DEFAULTS, create, push, bandEnergyDb };
});
