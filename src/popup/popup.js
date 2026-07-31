const $ = (id) => document.getElementById(id);
const KEYS = ['enabled', 'mode', 'depth', 'movetime', 'liveMovetime', 'liveOnlyOwnTurn', 'showEval', 'hideMode', 'delayMin', 'delayMax', 'autoPlay', 'autoPlayDelayMin', 'autoPlayDelayMax', 'autoPlaySecondChance', 'naturalThink', 'idleMouse', 'autoNextGame', 'autoNextTime'];
const AP_MIN = 3, AP_MAX = 15;
let loaded = null;

chrome.storage.sync.get(Object.fromEntries(KEYS.map((k) => [k, undefined])), (s) => {
  if (chrome.runtime.lastError) {
    console.warn('[ChessMate] storage read failed:', chrome.runtime.lastError);
    s = {};
  }
  loaded = s || {};
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
  $('autoPlayDelayMin').value = st.autoPlayDelayMin ?? AP_MIN;
  $('autoPlayDelayMax').value = st.autoPlayDelayMax ?? AP_MAX;
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
    autoPlayDelayMin: parseFloat($('autoPlayDelayMin').value),
    autoPlayDelayMax: parseFloat($('autoPlayDelayMax').value),
    autoPlaySecondChance: parseInt($('autoPlaySecondChance').value, 10),
    naturalThink: $('naturalThink').checked,
    idleMouse: $('idleMouse').checked,
    autoNextGame: $('autoNextGame').checked,
    autoNextTime: $('autoNextTime').value
  };
  if (data.delayMax < data.delayMin) data.delayMax = data.delayMin;
  if (data.autoPlayDelayMax < data.autoPlayDelayMin) data.autoPlayDelayMax = data.autoPlayDelayMin;
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
  chrome.storage.sync.set(diff, () => {
    if (chrome.runtime.lastError) {
      console.warn('[ChessMate] save failed:', chrome.runtime.lastError);
      return;
    }
    for (const k of Object.keys(diff)) loaded[k] = diff[k];
  });
  syncLabels();
}

function syncLabels() {
  $('depthVal').textContent = $('depth').value;
  $('movetimeVal').textContent = (parseInt($('movetime').value, 10) / 1000) + 's';
  $('liveMovetimeVal').textContent = (parseInt($('liveMovetime').value, 10) / 1000) + 's';
  $('delayVal').textContent = parseFloat($('delayMin').value) + '–' + parseFloat($('delayMax').value) + 's';
  $('autoDelayVal').textContent = parseFloat($('autoPlayDelayMin').value) + '–' + parseFloat($('autoPlayDelayMax').value) + 's';
  $('secondChanceVal').textContent = parseInt($('autoPlaySecondChance').value, 10) + '%';
  const nt = $('autoNextTime').value;
  $('autoNextTimeVal').textContent = nt + ' min';
}

for (const id of KEYS) {
  const el = $(id);
  if (el) el.addEventListener('change', save);
  if (el && el.tagName === 'INPUT' && el.type === 'range') el.addEventListener('input', syncLabels);
}
