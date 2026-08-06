/*
 * Runs in every frame on mlb.com.
 *
 * Non-top frames just report the panes they can see and carry out promote /
 * demote orders. The top frame additionally acts as coordinator: it owns the
 * clock, runs the silence machine, and asks the worker to rotate.
 *
 * The clock lives here rather than in the service worker because MV3 workers
 * are torn down after ~30s idle, which no amount of alarms fixes at the 300ms
 * resolution this needs.
 */
(() => {
  const { PHASES, initialState, step } = globalThis.MLBSilenceMachine;
  const Settings = globalThis.MLBSettings;

  const TICK_MS = 300;
  const REPORT_MS = 1000;
  // Ignore thumbnails, ad pixels, and picture-in-picture stubs.
  const MIN_PANE_WIDTH = 200;
  const MIN_PANE_HEIGHT = 100;
  // How long to let MLB's own click handling settle before we assert the audio
  // state ourselves.
  const SETTLE_MS = 350;

  const isCoordinator = window.top === window.self;

  let settings = Settings.DEFAULTS;
  let machine = initialState();
  let lastAction = 'none yet';
  let ticking = false;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Messaging that tolerates the worker being asleep or the extension reloading. */
  async function toWorker(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- panes

  const area = (r) => r.width * r.height;

  /**
   * Climb from the <video> to the outermost ancestor that is still essentially
   * the same box. That element is the clickable "pane" as far as the page is
   * concerned — the video is usually wrapped in a couple of positioning divs
   * plus an overlay that swallows clicks.
   */
  function findPaneContainer(video) {
    const videoArea = area(video.getBoundingClientRect());
    if (videoArea === 0) return video;
    let best = video;
    let node = video.parentElement;
    while (node && node !== document.body) {
      if (area(node.getBoundingClientRect()) > videoArea * 1.8) break;
      best = node;
      node = node.parentElement;
    }
    return best;
  }

  function discoverPanes() {
    if (settings.paneSelector) {
      try {
        return [...document.querySelectorAll(settings.paneSelector)]
          .map((container) => ({ container, video: container.querySelector('video') }))
          .filter((p) => p.video);
      } catch {
        // Bad selector in options; fall through to the heuristic.
      }
    }
    return [...document.querySelectorAll('video')]
      .filter((v) => {
        const r = v.getBoundingClientRect();
        return r.width >= MIN_PANE_WIDTH && r.height >= MIN_PANE_HEIGHT;
      })
      .map((video) => ({ video, container: findPaneContainer(video) }));
  }

  /** Index of the pane currently carrying audio, or null. */
  function primaryIndex(panes) {
    const i = panes.findIndex((p) => !p.video.muted && p.video.volume > 0);
    return i === -1 ? null : i;
  }

  // ------------------------------------------------------------ promotion

  /** A click the page will believe, aimed at whatever is actually on top. */
  function realClick(element) {
    const r = element.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const clientX = r.left + r.width / 2;
    const clientY = r.top + r.height / 2;
    const target = document.elementFromPoint(clientX, clientY) || element;

    const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX, clientY, button: 0 };
    const pointer = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    target.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, buttons: 1 }));
    target.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
    target.dispatchEvent(new PointerEvent('pointerup', { ...pointer, buttons: 0 }));
    target.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
    target.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0 }));
    return true;
  }

  const AUDIO_CONTROL = /\b(unmute|mute|audio|sound|volume|listen)\b/i;

  /**
   * Prefer the pane's own audio control when there is one — going through the
   * page's UI keeps MLB's state in sync with reality.
   */
  function clickAudioControl(pane) {
    const controls = pane.container.querySelectorAll('button, [role="button"], [aria-label], [title]');
    for (const control of controls) {
      const label = `${control.getAttribute('aria-label') || ''} ${control.getAttribute('title') || ''}`;
      if (AUDIO_CONTROL.test(label)) return realClick(control);
    }
    return false;
  }

  /**
   * Assert the outcome directly on the media elements. This is the backstop
   * that makes the feature work even if none of the DOM heuristics match the
   * page — MLB's UI may briefly disagree about which pane is labelled active,
   * but the sound lands where we asked for it.
   */
  function applyAudio(panes, index) {
    // Carry the outgoing pane's level over rather than jumping to full volume.
    const outgoing = panes.find((p, i) => i !== index && !p.video.muted && p.video.volume > 0);
    const level = outgoing ? outgoing.video.volume : 1;

    panes.forEach((pane, i) => {
      const { video } = pane;
      if (i === index) {
        video.muted = false;
        if (video.volume === 0) video.volume = level;
        if (video.paused) video.play().catch(() => {});
      } else {
        video.muted = true;
      }
    });
  }

  async function promote(local) {
    const panes = discoverPanes();
    const pane = panes[local];
    if (!pane) return { ok: false, reason: 'pane index out of range' };

    if (!clickAudioControl(pane)) realClick(pane.container);

    // The click may have caused MLB to re-lay-out (and re-create) the players,
    // so re-discover before asserting anything.
    await sleep(SETTLE_MS);
    const after = discoverPanes();
    if (after.length) applyAudio(after, Math.min(local, after.length - 1));

    lastAction = `promoted pane ${local + 1}/${after.length || panes.length}`;
    return { ok: true };
  }

  function demote() {
    for (const pane of discoverPanes()) pane.video.muted = true;
    return { ok: true };
  }

  // ------------------------------------------------------------ debug HUD

  let hud = null;

  function renderHud(info) {
    if (!settings.debugOverlay || !isCoordinator) {
      if (hud) {
        hud.remove();
        hud = null;
      }
      return;
    }
    if (!hud) {
      hud = document.createElement('div');
      hud.id = 'mlb-multiview-switcher-hud';
      Object.assign(hud.style, {
        position: 'fixed',
        right: '12px',
        bottom: '12px',
        zIndex: '2147483647',
        background: 'rgba(0,0,0,.82)',
        color: '#e8e8e8',
        font: '12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
        padding: '8px 10px',
        borderRadius: '6px',
        pointerEvents: 'none',
        whiteSpace: 'pre',
      });
      document.documentElement.appendChild(hud);
    }
    hud.textContent = [
      `phase    ${machine.phase}`,
      `audible  ${info.audible}`,
      `panes    ${info.totalPanes}`,
      `attempts ${machine.attempts}`,
      `last     ${lastAction}`,
    ].join('\n');
  }

  // ---------------------------------------------------------------- loops

  async function report() {
    const panes = discoverPanes();
    await toWorker({ type: 'report', paneCount: panes.length, primaryLocal: primaryIndex(panes) });
  }

  async function tick() {
    if (!isCoordinator || ticking) return;
    ticking = true;
    try {
      const state = await toWorker({
        type: 'getState',
        status: { phase: machine.phase, lastAction },
      });
      if (!state) return;

      const blocked = !settings.enabled || (settings.respectTabMute && state.muted);
      const out = step(machine, {
        now: Date.now(),
        audible: state.audible,
        blocked,
        paneCount: state.totalPanes,
        cfg: settings,
      });
      machine = out.state;

      if (out.action) {
        lastAction = `switch requested @ ${new Date().toLocaleTimeString()}`;
        await toWorker({ type: 'requestSwitch' });
      }
      renderHud(state);
    } finally {
      ticking = false;
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'promote') {
      promote(msg.local).then(sendResponse);
      return true;
    }
    if (msg.type === 'demote') {
      sendResponse(demote());
      return false;
    }
    return false;
  });

  (async function start() {
    settings = await Settings.load();
    Settings.onChange((next) => {
      settings = next;
    });
    setInterval(report, REPORT_MS);
    report();
    if (isCoordinator) setInterval(tick, TICK_MS);
  })();
})();
