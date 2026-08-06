const Settings = globalThis.MLBSettings;

const CHECKBOXES = ['enabled', 'respectTabMute', 'debugOverlay'];
const NUMBERS = ['silenceThresholdMs', 'graceMs', 'backoffMs', 'speechMarginDb'];
const TEXTS = ['paneSelector', 'breakText'];

const $ = (id) => document.getElementById(id);

function fill(settings) {
  for (const id of CHECKBOXES) $(id).checked = Boolean(settings[id]);
  for (const id of NUMBERS) $(id).value = settings[id];
  for (const id of TEXTS) $(id).value = settings[id];
}

let savedTimer = null;
function flashSaved() {
  const el = $('saved');
  el.classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => el.classList.remove('show'), 1200);
}

async function persist() {
  const patch = {};
  for (const id of CHECKBOXES) patch[id] = $(id).checked;
  for (const id of NUMBERS) patch[id] = Number($(id).value);
  for (const id of TEXTS) patch[id] = $(id).value.trim();
  await Settings.save(patch);
  // Re-read so the user sees any clamping that was applied.
  fill(await Settings.load());
  flashSaved();
}

(async function init() {
  fill(await Settings.load());

  for (const id of [...CHECKBOXES, ...NUMBERS, ...TEXTS]) {
    $(id).addEventListener('change', persist);
  }

  $('reset').addEventListener('click', async () => {
    await Settings.save(Settings.DEFAULTS);
    fill(await Settings.load());
    flashSaved();
  });
})();
