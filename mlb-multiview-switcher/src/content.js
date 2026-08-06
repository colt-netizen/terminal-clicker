/*
 * Runs in every frame on mlb.com.
 *
 * Non-top frames just report the panes they can see and carry out promote /
 * demote orders. The top frame additionally acts as coordinator: it owns the
 * clock and asks the worker to re-evaluate which pane should have the audio.
 *
 * The clock lives here rather than in the service worker because MV3 workers
 * are torn down after ~30s idle, which no amount of alarms fixes at the 300ms
 * resolution this needs.
 */
(() => {
  const { initialState, step } = globalThis.MLBSilenceMachine;
  const Settings = globalThis.MLBSettings;

  const TICK_MS = 300;
  const REPORT_MS = 1000;
  // Ignore thumbnails, ad pixels, and picture-in-picture stubs.
  const MIN_PANE_WIDTH = 200;
  const MIN_PANE_HEIGHT = 100;
  // How long to let MLB's own click handling settle before we assert the audio
  // state ourselves.
  const SETTLE_MS = 350;
  // Break banners are short and sit near the top of the pane's text.
  const TEXT_SCAN_LIMIT = 400;

  const isCoordinator = window.top === window.self;

  let settings = Settings.DEFAULTS;
  let machine = initialState();
  let lastAction = 'none yet';
  let ticking = false;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Messaging that tolerates the worker being asleep, the extension reloading,
   * or — critically — a worker handler that never responds. Without the
   * timeout, one unanswered message left the tick loop's in-flight guard set
   * forever and every decision stopped ("phase not running") while reports
   * kept flowing.
   */
  function toWorker(message) {
    return Promise.race([
      chrome.runtime.sendMessage(message).catch(() => null),
      sleep(3000).then(() => null),
    ]);
  }

  // ------------------------------------------------------------ deep DOM
  //
  // MLB's player is built from web components: the videos sit in the light
  // DOM (so pane counting always worked) but overlays, banners and the rail
  // live inside shadow roots, which querySelectorAll and TreeWalker silently
  // skip. Every scan that kept "finding nothing that was visibly on screen"
  // — rail 0 cards, break slates never marked — was this.

  /** querySelectorAll that descends into open shadow roots. */
  function deepQueryAll(selector, root = document, out = []) {
    for (const el of root.querySelectorAll(selector)) out.push(el);
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) deepQueryAll(selector, el.shadowRoot, out);
    }
    return out;
  }

  /** Visible-ish text of a subtree including shadow content, space-joined. */
  function deepText(node, limit) {
    const parts = [];
    let length = 0;
    const visit = (n) => {
      if (length >= limit) return;
      if (n.nodeType === Node.TEXT_NODE) {
        const value = (n.nodeValue || '').trim();
        if (value) {
          parts.push(value);
          length += value.length + 1;
        }
        return;
      }
      if (n.shadowRoot) visit(n.shadowRoot);
      for (const child of n.childNodes) visit(child);
    };
    visit(node);
    return parts.join(' ').slice(0, limit);
  }

  // ---------------------------------------------------------------- panes

  const area = (r) => r.width * r.height;

  /**
   * Climb from the <video> to the outermost ancestor that is still essentially
   * the same box. That element is the clickable "pane" as far as the page is
   * concerned — the video is usually wrapped in a couple of positioning divs
   * plus an overlay that swallows clicks.
   *
   * Hard stop at any ancestor holding a second <video>: crossing that boundary
   * means we have grabbed the whole multiview grid, and one game's break banner
   * would then appear to belong to every pane.
   */
  function findPaneContainer(video) {
    const videoArea = area(video.getBoundingClientRect());
    if (videoArea === 0) return video;
    let best = video;
    let node = video.parentElement;
    while (node && node !== document.body) {
      if (node.querySelectorAll('video').length > 1) break;
      if (area(node.getBoundingClientRect()) > videoArea * 1.6) break;
      best = node;
      node = node.parentElement;
    }
    return best;
  }

  function paneText(container) {
    // deepText, not innerText: pane overlays live in shadow roots that
    // innerText does not include.
    return deepText(container, TEXT_SCAN_LIMIT);
  }

  function breakPattern() {
    try {
      return new RegExp(settings.breakText || Settings.DEFAULTS.breakText, 'i');
    } catch {
      return new RegExp(Settings.DEFAULTS.breakText, 'i');
    }
  }

  /**
   * A stable-ish identity for the game in this pane, so priorities survive a
   * switch between 2/3/4-game layouts (where display position changes but the
   * game does not). Falls back to position when the page gives us nothing.
   */
  function derivePaneKey(container, index) {
    // Team logos carry alt text; two of them make a recognisable matchup and
    // give the worker tokens to match against the stats API's team names.
    const alts = deepQueryAll('img[alt]', container)
      .map((img) => img.alt.trim())
      .filter((alt) => alt && alt.length < 40);
    const tokens = alts.slice(0, 2);

    const idHolder =
      container.querySelector('[data-game-pk],[data-gamepk],[data-game-id]') ||
      container.closest('[data-game-pk],[data-gamepk],[data-game-id]');
    if (idHolder) {
      const id =
        idHolder.getAttribute('data-game-pk') ||
        idHolder.getAttribute('data-gamepk') ||
        idHolder.getAttribute('data-game-id');
      if (id) return { key: `game:${id}`, label: `Game ${id}`, tokens };
    }

    if (alts.length >= 2) {
      const matchup = `${alts[0]} v ${alts[1]}`;
      return { key: `teams:${matchup.toLowerCase()}`, label: matchup, tokens };
    }

    const link = container.querySelector('a[href*="gamePk="], a[href*="/gameday/"]');
    if (link) {
      return { key: `href:${link.getAttribute('href')}`, label: link.textContent.trim() || 'Game', tokens };
    }

    return { key: `pos:${index}`, label: `Pane ${index + 1}`, tokens };
  }

  /** MLB outlines the active pane; class names are the cheapest way to spot it. */
  const ACTIVE_CLASS = /(^|[-_ ])(active|selected|primary|focused)([-_ ]|$)/i;

  function looksActive(container) {
    let node = container;
    for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) {
      const className = typeof node.className === 'string' ? node.className : '';
      if (ACTIVE_CLASS.test(className)) return true;
      if (node.getAttribute && node.getAttribute('aria-current')) return true;
    }
    return false;
  }

  function discoverPanes() {
    let containers;
    if (settings.paneSelector) {
      try {
        containers = [...document.querySelectorAll(settings.paneSelector)]
          .map((container) => ({ container, video: container.querySelector('video') }))
          .filter((p) => p.video);
      } catch {
        containers = null; // Bad selector in options; fall through to the heuristic.
      }
    }
    if (!containers) {
      containers = [...document.querySelectorAll('video')]
        .filter((v) => {
          const r = v.getBoundingClientRect();
          return r.width >= MIN_PANE_WIDTH && r.height >= MIN_PANE_HEIGHT;
        })
        .map((video) => ({ video, container: findPaneContainer(video) }));
    }

    const pattern = breakPattern();
    const overlays = breakOverlayRects(pattern);
    return containers.map((pane, index) => {
      const { key, label, tokens } = derivePaneKey(pane.container, index);
      const text = paneText(pane.container);
      const rect = pane.container.getBoundingClientRect();
      return {
        ...pane,
        key,
        label,
        tokens,
        text: text.slice(0, 200),
        inBreak: pattern.test(text) || overlays.some((r) => centreInside(rect, r)),
        active: looksActive(pane.container),
      };
    });
  }

  /**
   * The break slate is rendered in an overlay that MLB's app portals OUTSIDE
   * the pane's own subtree, so scanning the pane container's text never sees
   * it — which is why break panes kept reading as watchable. Instead: find the
   * break text anywhere in the document and remember where it sits on screen;
   * a pane is in break if one of those rectangles lands inside it.
   */
  function breakOverlayRects(pattern) {
    const rects = [];
    const scanRoot = (root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (node.nodeType === Node.TEXT_NODE) {
          if (!pattern.test(node.nodeValue || '')) continue;
          const el = node.parentElement;
          if (!el) continue;
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) rects.push(r);
        } else if (node.shadowRoot) {
          scanRoot(node.shadowRoot); // TreeWalker will not descend on its own
        }
      }
    };
    scanRoot(document.body || document.documentElement);
    return rects;
  }

  function centreInside(outer, r) {
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    return cx >= outer.left && cx <= outer.right && cy >= outer.top && cy <= outer.bottom;
  }

  // ------------------------------------------------------------- game rail
  //
  // The rail across the top of multiview is a row of cards, one per game in
  // the league, each printing its state ("Bot 8", "Final", "1:20 PM") and two
  // team abbreviations. It is both a state source and a control surface: the
  // worker asks us to click a card to load that game into the focused pane.

  // No word boundaries anywhere here: textContent concatenates child elements
  // without whitespace, so a card reads "FinalTORHOU" — \b never fires where a
  // human sees a break. That was why the rail scan found 0 cards.
  const RAIL_STATE = /(?:top|bot(?:tom)?|mid(?:dle)?|end)\s*\d{1,2}|final|ppd|postponed|delay|suspended|warmup|\d{1,2}:\d{2}\s*(?:am|pm)?/i;
  const NOT_TEAM_TOKENS = new Set(['AM', 'PM', 'ET', 'PT', 'CT', 'MT', 'TV', 'PPD', 'TBD', 'MLB']);

  /** Uppercase runs in concatenated text: "FinalTORHOU" -> TOR, HOU. Noise
   * tokens get through; the worker filters against real team abbreviations. */
  function railTokens(text) {
    return (String(text).match(/[A-Z]{2,3}/g) || []).filter((t) => !NOT_TEAM_TOKENS.has(t));
  }

  /**
   * Find rail cards: small subtrees whose text is a game state plus two team
   * abbreviations. textContent (not innerText) keeps this cheap — no layout —
   * and the innermost-match dedupe drops the ancestors that also match because
   * they contain a card.
   */
  function scanRail() {
    let candidates = null;
    if (settings.railSelector) {
      try {
        candidates = [...document.querySelectorAll(settings.railSelector)];
      } catch {
        candidates = null; // bad selector; fall back to the heuristic
      }
    }
    if (!candidates || !candidates.length) {
      candidates = [];
      for (const el of deepQueryAll('a, button, li, div')) {
        const text = (el.textContent || '').trim();
        if (text.length < 4 || text.length > 80) continue;
        if (!RAIL_STATE.test(text)) continue;
        if (railTokens(text).length < 2) continue;
        candidates.push(el);
      }
      // Keep innermost matches only.
      candidates = candidates.filter((el) => !candidates.some((other) => other !== el && el.contains(other)));
    }

    return candidates.slice(0, 40).map((el) => {
      const text = (el.textContent || '').trim().slice(0, 80);
      return { el, text, tokens: railTokens(text), viewing: /\bviewing\b/i.test(text) };
    });
  }

  /** Click the rail card whose team tokens match the worker's request. */
  function clickRailCard(tokens) {
    const want = (tokens || []).map((t) => String(t).toUpperCase());
    if (!want.length) return { ok: false, reason: 'no tokens' };
    const card = scanRail().find((c) => want.every((t) => c.tokens.includes(t)));
    if (!card) return { ok: false, reason: 'card not found' };
    realClick(card.el);
    lastAction = `rail click: ${card.text}`;
    return { ok: true, text: card.text };
  }

  /**
   * Which pane holds the audio. The media flags are authoritative when they say
   * something useful; the page's own active styling is the tiebreaker, since
   * MLB re-asserts its mute state after our clicks and can briefly leave every
   * element muted.
   */
  function primaryIndex(panes) {
    const byAudio = panes.findIndex((p) => !p.video.muted && p.video.volume > 0);
    if (byAudio !== -1) return byAudio;
    const byClass = panes.findIndex((p) => p.active);
    return byClass === -1 ? null : byClass;
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

  /**
   * Which pane should carry audio in THIS frame, as far as the worker has told
   * us. undefined = never instructed (leave the page alone), -1 = mute all
   * (another frame has the audio), n = pane n has it.
   *
   * This exists because one-shot mute writes do not survive: MLB's player
   * re-asserts its own audio state after our changes (its focus never moved —
   * synthetic clicks don't convince it), which produced an audible ping-pong:
   * we mute the break pane, MLB unmutes it, we switch away again, forever. So
   * instead of asking MLB and hoping, the desired state is *enforced* on a
   * timer: MLB can re-assert whenever it likes and loses within half a second.
   */
  let desired;

  /** The bare video elements, without the text/identity work — cheap enough
   * to call several times a second from the enforcement loop. */
  function paneVideos() {
    return [...document.querySelectorAll('video')].filter((v) => {
      const r = v.getBoundingClientRect();
      return r.width >= MIN_PANE_WIDTH && r.height >= MIN_PANE_HEIGHT;
    });
  }

  /** Re-assert the desired audio state. Writes only on mismatch. */
  function enforceAudio() {
    if (desired === undefined) return;
    const videos = paneVideos();
    videos.forEach((video, i) => {
      const shouldMute = desired === -1 || i !== desired;
      if (video.muted !== shouldMute) video.muted = shouldMute;
      if (!shouldMute && video.volume === 0) video.volume = 1;
    });
  }

  /** Jump a live feed to its live edge (a few seconds back from the boundary
   * so the player has buffer to stand on). Only called for games the API says
   * are in progress — never for finals, where the position is someone's
   * deliberate replay spot. */
  function seekToLiveEdge(video) {
    try {
      const s = video.seekable;
      if (!s || !s.length) return;
      const end = s.end(s.length - 1);
      if (Number.isFinite(end) && end - video.currentTime > 12) {
        video.currentTime = Math.max(0, end - 4);
      }
    } catch {
      // Some players refuse external seeks; the audio still switched.
    }
  }

  async function promote(local, goLive) {
    const panes = discoverPanes();
    const pane = panes[local];
    if (!pane) return { ok: false, reason: 'pane index out of range' };

    desired = local;
    enforceAudio();
    if (pane.video.paused) pane.video.play().catch(() => {});
    if (goLive) {
      // Let the unmute settle, then snap to now.
      await sleep(SETTLE_MS);
      const current = discoverPanes()[local];
      if (current) {
        if (current.video.paused) current.video.play().catch(() => {});
        seekToLiveEdge(current.video);
      }
    }

    lastAction = `promoted ${pane.label}`;
    return { ok: true, label: pane.label };
  }

  function demote() {
    desired = -1;
    enforceAudio();
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

    const lines = [
      `phase    ${machine.phase}${info.replayMode ? '   mode replay-night' : ''}`,
      `signal   ${info.source}${info.listening ? ` ${info.recentDb}dB spread ${info.spreadDb ?? '?'}dB / floor ${info.floorDb}dB` : ''}`,
      `audible  ${info.audible}`,
      `panes    ${info.totalPanes}   rail ${info.railCards ?? 0} cards   api ${info.apiGames ?? 0} games`,
    ];
    if (info.viewing && info.viewing.length) lines.push(`viewing  ${info.viewing.join(', ')}`);
    (info.panes || []).forEach((p, i) => {
      const marks = [
        p.stateText || '?',
        p.inBreak ? 'BREAK' : p.live ? 'live' : info.replayMode ? 'replay' : `dead: ${p.liveReason}`,
        p.isPrimary ? 'audio' : '',
      ].filter(Boolean);
      lines.push(`  ${i + 1}. ${p.label} [${marks.join(' | ')}]`);
    });
    if (info.tuneTripped) lines.push('tune     PAUSED (rail clicks not landing)');
    lines.push(`last     ${lastAction}`);
    hud.textContent = lines.join('\n');
  }

  // ---------------------------------------------------------------- loops

  let reportCount = 0;

  async function report() {
    const panes = discoverPanes();
    const message = {
      type: 'report',
      panes: panes.map((p) => ({
        key: p.key,
        label: p.label,
        tokens: p.tokens,
        text: p.text,
        inBreak: p.inBreak,
      })),
      primaryLocal: primaryIndex(panes),
    };
    // The rail scan walks a lot of DOM, so run it at a third of the report
    // rate, and only from the top frame (the rail lives in the main document).
    if (isCoordinator && reportCount % 3 === 0) {
      message.rail = scanRail().map((c) => ({ text: c.text, tokens: c.tokens, viewing: c.viewing }));
    }
    reportCount += 1;
    await toWorker(message);
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

      // The worker decides *where* to go; the machine only decides *when* the
      // audio has been dead long enough to count. Break banners are evaluated
      // worker-side on every tick, so a break moves us without waiting.
      const result = await toWorker({
        type: 'evaluate',
        audioDead: Boolean(out.action),
        blocked,
      });
      if (result && result.switched) {
        lastAction = `${result.reason} -> ${result.label || `pane ${result.index + 1}`}`;
      }
      renderHud(state);
    } catch (error) {
      lastAction = `tick error: ${(error && error.message) || error}`;
    } finally {
      ticking = false;
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'promote') {
      promote(msg.local, msg.goLive).then(sendResponse);
      return true;
    }
    if (msg.type === 'demote') {
      sendResponse(demote());
      return false;
    }
    // Auto-tune step 1: focus the pane being given up, without touching audio —
    // MLB loads rail selections into the focused pane.
    if (msg.type === 'focusPane') {
      const pane = discoverPanes()[msg.local];
      if (!pane) {
        sendResponse({ ok: false, reason: 'pane index out of range' });
        return false;
      }
      realClick(pane.container);
      sendResponse({ ok: true });
      return false;
    }
    // Auto-tune step 2: click the target game's rail card. Wait out MLB's
    // focus handling from step 1 before clicking, or the selection can land in
    // the wrong pane.
    if (msg.type === 'clickRail') {
      setTimeout(() => sendResponse(clickRailCard(msg.tokens)), SETTLE_MS);
      return true;
    }
    return false;
  });

  (async function start() {
    settings = await Settings.load();
    Settings.onChange((next) => {
      settings = next;
    });

    // A real user click on a pane is the strongest signal there is: adopt it
    // as the enforced audio target immediately (before the worker even hears
    // about it) and tell the worker so it holds the choice. isTrusted filters
    // out our own synthetic clicks.
    document.addEventListener(
      'pointerdown',
      (event) => {
        if (!event.isTrusted) return;
        const panes = discoverPanes();
        const index = panes.findIndex((p) => p.container.contains(event.target));
        if (index === -1) return;
        desired = index;
        toWorker({ type: 'userSelect', local: index });
      },
      true
    );

    setInterval(report, REPORT_MS);
    report();
    setInterval(enforceAudio, 400);
    if (isCoordinator) setInterval(tick, TICK_MS);
  })();
})();
