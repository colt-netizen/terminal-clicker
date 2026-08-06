const Settings = globalThis.MLBSettings;
const $ = (id) => document.getElementById(id);

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function render(tab, state) {
  const el = $('status');
  if (!tab) {
    el.textContent = 'no active tab';
    return;
  }
  if (!state) {
    el.textContent = 'not an MLB.tv tab';
    return;
  }
  el.textContent = [
    `panes    ${state.totalPanes}`,
    `audible  ${state.audible}`,
    `muted    ${state.muted}`,
    `phase    ${state.stale ? 'not running' : state.phase}`,
  ].join('\n');
}

async function refresh() {
  const tab = await activeTab();
  if (!tab) return render(null, null);
  const state = await chrome.runtime.sendMessage({ type: 'popupStatus', tabId: tab.id }).catch(() => null);
  render(tab, state);
}

(async function init() {
  const settings = await Settings.load();
  $('enabled').checked = settings.enabled;

  $('enabled').addEventListener('change', async () => {
    await Settings.save({ ...settings, enabled: $('enabled').checked });
  });

  $('switchNow').addEventListener('click', async () => {
    const tab = await activeTab();
    if (!tab) return;
    const result = await chrome.runtime
      .sendMessage({ type: 'popupSwitch', tabId: tab.id })
      .catch(() => null);
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
