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

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function tag(text, on) {
  return el('span', 'tag' + (on ? ' on' : ''), text);
}

function renderStatus(state) {
  const box = $('status');
  if (!state) {
    box.textContent = 'not an MLB.tv tab';
    return;
  }
  const signal = state.listening
    ? `speech ${state.recentDb}dB spread ${state.spreadDb ?? '?'}dB / floor ${state.floorDb}dB`
    : 'tab audio flag';
  const lines = [
    `panes    ${state.totalPanes}`,
    `playing  ${state.audible}`,
    `signal   ${signal}`,
    `phase    ${state.stale ? 'not running' : state.phase}`,
  ];
  if (state.replayMode) lines.push('mode     replay night — non-break panes are watchable');
  if (state.viewing && state.viewing.length) lines.push(`viewing  ${state.viewing.join(', ')}`);
  if (state.games && state.games.apiError) lines.push(`api      ${state.games.apiError}`);
  if (state.tuneTripped) lines.push('tune     paused — rail clicks not landing');
  box.textContent = lines.join('\n');
}

// ----------------------------------------------------------- team priorities

async function saveTeams(teams) {
  settings = { ...settings, teamPriorities: teams };
  await Settings.save({ teamPriorities: teams });
  renderTeams();
}

function renderTeams() {
  const list = $('teams');
  const teams = settings.teamPriorities || [];
  list.innerHTML = '';
  if (!teams.length) {
    list.appendChild(el('li', 'empty', 'No teams ranked — using per-feed order below.'));
    return;
  }
  teams.forEach((team, i) => {
    const li = el('li');
    li.appendChild(el('span', 'pane-name', `${i + 1}. ${team}`));
    for (const [delta, glyph, title] of [
      [-1, '↑', 'Higher'],
      [1, '↓', 'Lower'],
    ]) {
      const button = el('button', 'move', glyph);
      button.title = title;
      button.disabled = (delta === -1 && i === 0) || (delta === 1 && i === teams.length - 1);
      button.addEventListener('click', () => saveTeams(Selector.reorder(teams, team, delta)));
      li.appendChild(button);
    }
    const remove = el('button', 'move', '×');
    remove.title = 'Remove';
    remove.addEventListener('click', () => saveTeams(teams.filter((t) => t !== team)));
    li.appendChild(remove);
    list.appendChild(li);
  });
}

async function addTeam(raw) {
  const team = String(raw || '').trim();
  if (!team) return;
  const teams = settings.teamPriorities || [];
  if (teams.some((t) => t.toLowerCase() === team.toLowerCase())) return;
  await saveTeams([...teams, team]);
  $('teamInput').value = '';
}

// ------------------------------------------------------------------- panes

function renderPanes(state) {
  const list = $('panes');
  list.innerHTML = '';
  const panes = (state && state.panes) || [];
  if (!panes.length) {
    list.appendChild(el('li', 'empty', 'No games detected yet.'));
    return;
  }
  for (const pane of panes) {
    const li = el('li');
    li.appendChild(el('span', 'pane-name', pane.label));
    if (pane.stateText) li.appendChild(tag(pane.stateText));
    if (pane.inBreak) li.appendChild(tag('break'));
    else if (!pane.live) li.appendChild(tag(state.replayMode ? 'replay' : 'dead'));
    if (pane.isPrimary) li.appendChild(tag('audio', true));
    list.appendChild(li);
  }
}

// ---------------------------------------------------------- league overview

function startTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

function renderGames(state) {
  const list = $('games');
  list.innerHTML = '';
  const games = state && state.games;
  if (!games || (!games.live.length && !games.upcoming.length)) {
    list.appendChild(el('li', 'empty', games && games.apiError ? 'Stats API unreachable.' : 'No games right now.'));
    return;
  }
  for (const game of games.live) {
    const li = el('li');
    li.appendChild(el('span', 'pane-name', game.matchup));
    li.appendChild(tag(game.state, true));
    addQuickAdd(li, game.teams);
    list.appendChild(li);
  }
  for (const game of games.upcoming) {
    const li = el('li');
    li.appendChild(el('span', 'pane-name offscreen', game.matchup));
    li.appendChild(tag(startTime(game.startISO)));
    addQuickAdd(li, game.teams);
    list.appendChild(li);
  }
}

/** One-click "rank this team" buttons next to each league game. */
function addQuickAdd(li, teams) {
  const ranked = new Set((settings.teamPriorities || []).map((t) => t.toLowerCase()));
  for (const team of teams || []) {
    if (ranked.has(String(team).toLowerCase())) continue;
    const button = el('button', 'move', `+${team}`);
    button.title = `Rank ${team}`;
    button.addEventListener('click', () => addTeam(team));
    li.appendChild(button);
  }
}

// ------------------------------------------------------------------ refresh

async function refresh() {
  if (tabId == null) return;
  const state = await send({ type: 'popupStatus', tabId });
  renderStatus(state);
  renderPanes(state);
  renderGames(state);
}

async function setListenMode(on) {
  settings = { ...settings, listenMode: on };
  await Settings.save({ listenMode: on });

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
    await Settings.save({ listenMode: false });
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
    await Settings.save({ listenMode: false });
  }
}

(async function init() {
  settings = await Settings.load();
  const tab = await activeTab();
  tabId = tab ? tab.id : null;

  $('enabled').checked = settings.enabled;
  $('autoTune').checked = settings.autoTune;
  $('listenMode').checked = settings.listenMode;
  renderTeams();

  $('enabled').addEventListener('change', async () => {
    settings = { ...settings, enabled: $('enabled').checked };
    await Settings.save({ enabled: settings.enabled });
  });

  $('autoTune').addEventListener('change', async () => {
    settings = { ...settings, autoTune: $('autoTune').checked };
    await Settings.save({ autoTune: settings.autoTune });
  });

  $('listenMode').addEventListener('change', () => setListenMode($('listenMode').checked));

  $('teamAdd').addEventListener('click', () => addTeam($('teamInput').value));
  $('teamInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') addTeam($('teamInput').value);
  });

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
