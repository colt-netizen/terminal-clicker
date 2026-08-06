const Settings = globalThis.MLBSettings;
const Selector = globalThis.MLBPaneSelector;
const $ = (id) => document.getElementById(id);

let settings = null;
let tabId = null;

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);

function renderStatus(state) {
  const el = $('status');
  if (!state) {
    el.textContent = 'not an MLB.tv tab';
    return;
  }
  const signal = state.listening
    ? `speech ${state.recentDb}dB / floor ${state.floorDb}dB`
    : 'tab audio flag';
  el.textContent = [
    `panes    ${state.totalPanes}`,
    `playing  ${state.audible}`,
    `signal   ${signal}`,
    `phase    ${state.stale ? 'not running' : state.phase}`,
  ].join('\n');
}

/**
 * The priority list is the union of games seen on this tab and any ranked
 * earlier, so a game keeps its slot when you drop from 4-game to 2-game mode.
 */
function renderPanes(state) {
  const list = $('panes');
  const live = new Map((state && state.panes ? state.panes : []).map((p) => [p.key, p]));
  const order = Selector.mergePriorities(settings.priorities, [...live.keys()]);

  list.innerHTML = '';
  if (!order.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No games detected yet.';
    list.appendChild(li);
    return;
  }

  order.forEach((key, i) => {
    const pane = live.get(key);
    const li = document.createElement('li');

    const name = document.createElement('span');
    name.className = 'pane-name' + (pane ? '' : ' offscreen');
    name.textContent = pane ? pane.label : `${key.replace(/^[a-z]+:/, '')} (not on screen)`;
    li.appendChild(name);

    if (pane && pane.inBreak) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'break';
      li.appendChild(tag);
    }
    if (pane && pane.isPrimary) {
      const tag = document.createElement('span');
      tag.className = 'tag on';
      tag.textContent = 'audio';
      li.appendChild(tag);
    }

    for (const [delta, glyph, title] of [
      [-1, '↑', 'Higher priority'],
      [1, '↓', 'Lower priority'],
    ]) {
      const button = document.createElement('button');
      button.className = 'move';
      button.textContent = glyph;
      button.title = title;
      button.disabled = (delta === -1 && i === 0) || (delta === 1 && i === order.length - 1);
      button.addEventListener('click', async () => {
        settings = { ...settings, priorities: Selector.reorder(order, key, delta) };
        await Settings.save(settings);
        refresh();
      });
      li.appendChild(button);
    }

    list.appendChild(li);
  });
}

async function refresh() {
  if (tabId == null) return;
  const state = await send({ type: 'popupStatus', tabId });
  renderStatus(state);
  renderPanes(state);
}

async function setListenMode(on) {
  settings = { ...settings, listenMode: on };
  await Settings.save(settings);

  if (!on) {
    await send({ type: 'stopListening', tabId });
    return;
  }

  // getMediaStreamId needs the user gesture that opened this popup, so it has
  // to be called here rather than in the service worker.
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (error) {
    $('status').textContent = `capture blocked\n${(error && error.message) || error}`;
    $('listenMode').checked = false;
    settings = { ...settings, listenMode: false };
    await Settings.save(settings);
    return;
  }

  const result = await send({
    type: 'startListening',
    tabId,
    streamId,
    cfg: { marginDb: settings.speechMarginDb },
  });
  if (!result || !result.ok) {
    $('status').textContent = `listen failed\n${(result && result.reason) || 'no response'}`;
    $('listenMode').checked = false;
    settings = { ...settings, listenMode: false };
    await Settings.save(settings);
  }
}

(async function init() {
  settings = await Settings.load();
  const tab = await activeTab();
  tabId = tab ? tab.id : null;

  $('enabled').checked = settings.enabled;
  $('listenMode').checked = settings.listenMode;

  $('enabled').addEventListener('change', async () => {
    settings = { ...settings, enabled: $('enabled').checked };
    await Settings.save(settings);
  });

  $('listenMode').addEventListener('change', () => setListenMode($('listenMode').checked));

  $('switchNow').addEventListener('click', async () => {
    const result = await send({ type: 'popupSwitch', tabId });
    if (!result || !result.ok) {
      $('status').textContent = `switch failed\n${(result && result.reason) || 'no response'}`;
      return;
    }
    setTimeout(refresh, 600);
  });

  $('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());

  refresh();
  setInterval(refresh, 1000);
})();
