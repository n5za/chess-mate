const $ = (id) => document.getElementById(id);
const SETTINGS_KEY = 'chessmateSettings';
const KEYS = ['enabled', 'mode', 'depth', 'movetime', 'liveMovetime', 'liveOnlyOwnTurn', 'showEval', 'hideMode', 'delayMin', 'delayMax', 'autoPlay', 'speed', 'autoPlaySecondChance', 'naturalThink', 'idleMouse', 'autoNextGame', 'autoNextTime'];
const DEFAULTS = {
  enabled: true, mode: 'both', depth: 18, movetime: 2500, liveMovetime: 2000,
  liveOnlyOwnTurn: true, showEval: true, hideMode: 'always', delayMin: 0, delayMax: 0,
  autoPlay: false, speed: 'auto', autoPlaySecondChance: 10, naturalThink: true,
  idleMouse: true, autoNextGame: false, autoNextTime: '10'
};
let loaded = null;

// The whole settings object lives under one key: atomic read/write, so no
// partial overwrites and no lost keys. Old flat keys are migrated into it.
function readStore(cb) {
  chrome.storage.local.get(null, (loc) => {
    loc = loc || {};
    if (chrome.runtime.lastError) loc = {};
    if (loc[SETTINGS_KEY] && typeof loc[SETTINGS_KEY] === 'object') { cb(loc[SETTINGS_KEY]); return; }
    const flat = {};
    for (const k of KEYS) if (loc[k] !== undefined) flat[k] = loc[k];
    if (Object.keys(flat).length > 0) {
      writeStore(flat);
      cb(flat);
      return;
    }
    chrome.storage.sync.get(null, (syn) => {
      const s = (syn || {})[SETTINGS_KEY];
      cb((s && typeof s === 'object') ? s : {});
    });
  });
}

function writeStore(data, cb) {
  const full = { ...DEFAULTS, ...(loaded || {}), ...data };
  chrome.storage.local.set({ [SETTINGS_KEY]: full }, () => {
    if (chrome.runtime.lastError) console.warn('[ChessMate] local save failed:', chrome.runtime.lastError);
    if (cb) cb();
  });
  chrome.storage.sync.set({ [SETTINGS_KEY]: full }, () => {
    if (chrome.runtime.lastError) console.warn('[ChessMate] sync save failed:', chrome.runtime.lastError);
  });
}

// Keep our view of storage fresh so we never overwrite newer values.
chrome.storage.onChanged.addListener((changes, area) => {
  if (!loaded || (area !== 'local' && area !== 'sync')) return;
  if (changes[SETTINGS_KEY] && changes[SETTINGS_KEY].newValue) {
    loaded = changes[SETTINGS_KEY].newValue;
  }
});

readStore((storeData) => {
  loaded = storeData || {};
  const st = loaded;
  $('enabled').checked = st.enabled !== false;
  $('mode').value = st.mode || 'both';
  $('depth').value = st.depth ?? 18;
  $('movetime').value = st.movetime ?? 2500;
  $('liveMovetime').value = st.liveMovetime ?? 2000;
  $('liveOnlyOwnTurn').checked = st.liveOnlyOwnTurn !== false;
  $('showEval').checked = st.showEval !== false;
  $('hideMode').value = st.hideMode || 'always';
  $('delayMin').value = st.delayMin ?? 0;
  $('delayMax').value = st.delayMax ?? 0;
  $('autoPlay').checked = !!st.autoPlay;
  $('speed').value = st.speed || 'auto';
  $('autoPlaySecondChance').value = st.autoPlaySecondChance ?? 10;
  $('naturalThink').checked = st.naturalThink !== false;
  $('idleMouse').checked = st.idleMouse !== false;
  $('autoNextGame').checked = !!st.autoNextGame;
  $('autoNextTime').value = st.autoNextTime || '10';
  syncLabels();
});

function collect() {
  const data = {
    enabled: $('enabled').checked,
    mode: $('mode').value,
    depth: parseInt($('depth').value, 10),
    movetime: parseInt($('movetime').value, 10),
    liveMovetime: parseInt($('liveMovetime').value, 10),
    liveOnlyOwnTurn: $('liveOnlyOwnTurn').checked,
    showEval: $('showEval').checked,
    hideMode: $('hideMode').value,
    delayMin: parseFloat($('delayMin').value),
    delayMax: parseFloat($('delayMax').value),
    autoPlay: $('autoPlay').checked,
    speed: $('speed').value,
    autoPlaySecondChance: parseInt($('autoPlaySecondChance').value, 10),
    naturalThink: $('naturalThink').checked,
    idleMouse: $('idleMouse').checked,
    autoNextGame: $('autoNextGame').checked,
    autoNextTime: $('autoNextTime').value
  };
  if (data.delayMax < data.delayMin) data.delayMax = data.delayMin;
  return data;
}

function save() {
  const data = collect();
  const diff = {};
  for (const k of KEYS) {
    const prev = loaded ? loaded[k] : undefined;
    if (prev === undefined || prev !== data[k]) diff[k] = data[k];
  }
  if (Object.keys(diff).length === 0) {
    syncLabels();
    return;
  }
  writeStore(diff, () => {
    for (const k of Object.keys(diff)) loaded[k] = diff[k];
  });
  syncLabels();
}

function syncLabels() {
  $('depthVal').textContent = $('depth').value;
  $('movetimeVal').textContent = (parseInt($('movetime').value, 10) / 1000) + 's';
  $('liveMovetimeVal').textContent = (parseInt($('liveMovetime').value, 10) / 1000) + 's';
  $('delayVal').textContent = parseFloat($('delayMin').value) + '–' + parseFloat($('delayMax').value) + 's';
  const speedMap = { auto: 'Auto', turbo: 'Turbo', slow: 'Slow', normal: 'Normal', fast: 'Fast' };
  $('speedVal').textContent = speedMap[$('speed').value] || 'Auto';
  $('secondChanceVal').textContent = parseInt($('autoPlaySecondChance').value, 10) + '%';
  const nt = $('autoNextTime').value;
  $('autoNextTimeVal').textContent = nt + ' min';
}

for (const id of KEYS) {
  const el = $(id);
  if (el) el.addEventListener('change', save);
  if (el && el.tagName === 'INPUT' && el.type === 'range') el.addEventListener('input', syncLabels);
}
