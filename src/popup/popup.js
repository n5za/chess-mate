const $ = (id) => document.getElementById(id);
const KEYS = ['enabled', 'mode', 'depth', 'movetime', 'liveMovetime', 'liveOnlyOwnTurn', 'showEval', 'hideMode', 'delayMin', 'delayMax', 'autoPlay', 'speed', 'autoPlaySecondChance', 'naturalThink', 'idleMouse', 'autoNextGame', 'autoNextTime'];
let loaded = null;

// Local storage is the source of truth (settings survive extension reloads).
// Sync is only a fallback/mirror.
function readStore(cb) {
  chrome.storage.local.get(Object.fromEntries(KEYS.map((k) => [k, undefined])), (loc) => {
    if (chrome.runtime.lastError) loc = {};
    if (loc && Object.keys(loc).length > 0) { cb(loc || {}); return; }
    chrome.storage.sync.get(Object.fromEntries(KEYS.map((k) => [k, undefined])), (syn) => {
      cb(chrome.runtime.lastError ? {} : (syn || {}));
    });
  });
}

function writeStore(data, cb) {
  chrome.storage.local.set(data, () => {
    if (chrome.runtime.lastError) console.warn('[ChessMate] local save failed:', chrome.runtime.lastError);
    if (cb) cb();
  });
  chrome.storage.sync.set(data, () => {
    if (chrome.runtime.lastError) console.warn('[ChessMate] sync save failed:', chrome.runtime.lastError);
  });
}

// Keep our view of storage fresh so we never overwrite newer values.
chrome.storage.onChanged.addListener((changes, area) => {
  if (!loaded || (area !== 'local' && area !== 'sync')) return;
  for (const k of Object.keys(changes)) {
    if (changes[k].newValue === undefined) delete loaded[k];
    else loaded[k] = changes[k].newValue;
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
