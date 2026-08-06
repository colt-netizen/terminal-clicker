/*
 * Offscreen document: the only place in an MV3 extension with both a DOM and a
 * long-lived AudioContext, which is what analysing tab audio needs.
 *
 * Capturing a tab's audio hands us the mixed output *below* the DRM boundary,
 * so unlike createMediaElementSource this works on protected MLB.tv streams and
 * never touches the page's media elements.
 *
 * The one hazard: chrome.tabCapture mutes the tab for the user unless the
 * captured stream is played back. So the graph deliberately forks — one branch
 * to the analyser, one straight to the speakers. If anything throws we tear the
 * whole capture down, which restores normal tab audio.
 */
const Detector = globalThis.MLBSpeechDetector;

const FRAME_MS = 50;
const REPORT_MS = 200;
const FFT_SIZE = 2048;

let ctx = null;
let stream = null;
let analyser = null;
let bins = null;
let detector = null;
let timer = null;
let reportTimer = null;
let capturedTabId = null;
let latest = null;

async function stop(reason) {
  clearInterval(timer);
  clearInterval(reportTimer);
  timer = reportTimer = null;

  if (stream) for (const track of stream.getTracks()) track.stop();
  if (ctx && ctx.state !== 'closed') await ctx.close().catch(() => {});

  ctx = stream = analyser = bins = detector = latest = null;
  const tabId = capturedTabId;
  capturedTabId = null;

  if (tabId != null) {
    chrome.runtime
      .sendMessage({ type: 'captureEnded', tabId, reason: reason || 'stopped' })
      .catch(() => {});
  }
}

async function start({ streamId, tabId, cfg, band }) {
  await stop('restarting');

  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
  });

  ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);

  analyser = ctx.createAnalyser();
  analyser.fftSize = FFT_SIZE;
  // No smoothing: the detector does its own averaging over a known window, and
  // stacking two smoothers just blurs the speech gaps it relies on.
  analyser.smoothingTimeConstant = 0;
  bins = new Float32Array(analyser.frequencyBinCount);

  source.connect(analyser);
  source.connect(ctx.destination); // keep the tab audible

  detector = Detector.create(cfg);
  capturedTabId = tabId;

  // If the user closes the tab or stops sharing, the track ends.
  for (const track of stream.getTracks()) {
    track.addEventListener('ended', () => stop('track-ended'));
  }

  timer = setInterval(() => {
    if (!analyser || !detector) return;
    analyser.getFloatFrequencyData(bins);
    const db = Detector.bandEnergyDb(
      bins,
      ctx.sampleRate,
      FFT_SIZE,
      band && band.lowHz,
      band && band.highHz
    );
    latest = Detector.push(detector, db, Date.now());
  }, FRAME_MS);

  // Reporting is throttled well below the analysis rate — the service worker
  // only needs the current verdict, not every frame.
  reportTimer = setInterval(() => {
    if (!latest || capturedTabId == null) return;
    chrome.runtime
      .sendMessage({
        type: 'speech',
        tabId: capturedTabId,
        speechPresent: latest.speechPresent,
        recentDb: Math.round(latest.recentDb * 10) / 10,
        floorDb: Math.round(latest.floorDb * 10) / 10,
      })
      .catch(() => {});
  }, REPORT_MS);

  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return false;

  if (msg.type === 'startCapture') {
    start(msg)
      .then(sendResponse)
      .catch((error) => {
        stop('start-failed');
        sendResponse({ ok: false, reason: String((error && error.message) || error) });
      });
    return true;
  }

  if (msg.type === 'stopCapture') {
    stop('stopped').then(() => sendResponse({ ok: true }));
    return true;
  }

  return false;
});
