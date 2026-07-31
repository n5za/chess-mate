const $ = (id) => document.getElementById(id);
const KEYS = ['enabled', 'mode', 'depth', 'movetime', 'liveMovetime', 'liveOnlyOwnTurn', 'showEval', 'hideMode', 'delayMin', 'delayMax', 'autoPlay', 'autoPlayDelayMin', 'autoPlayDelayMax', 'autoPlaySecondChance', 'naturalThink', 'idleMouse'];
const AP_MIN = 3, AP_MAX = 15;

chrome.storage.sync.get(Object.fromEntries(KEYS.map((k) => [k, undefined])), (s) => {
  $('enabled').checked = s.enabled !== false;
  $('mode').value = s.mode || 'both';
  $('depth').value = s.depth ?? 18;
  $('movetime').value = s.movetime ?? 2500;
  $('liveMovetime').value = s.liveMovetime ?? 2000;
  $('liveOnlyOwnTurn').checked = s.liveOnlyOwnTurn !== false;
  $('showEval').checked = s.showEval !== false;
  $('hideMode').value = s.hideMode || 'always';
  $('delayMin').value = s.delayMin ?? 0;
  $('delayMax').value = s.delayMax ?? 0;
  $('autoPlay').checked = !!s.autoPlay;
  $('autoPlayDelayMin').value = s.autoPlayDelayMin ?? AP_MIN;
  $('autoPlayDelayMax').value = s.autoPlayDelayMax ?? AP_MAX;
  $('autoPlaySecondChance').value = s.autoPlaySecondChance ?? 10;
  $('naturalThink').checked = s.naturalThink !== false;
  $('idleMouse').checked = s.idleMouse !== false;
  syncLabels();
});

function save() {
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
    idleMouse: $('idleMouse').checked
  };
  if (data.delayMax < data.delayMin) data.delayMax = data.delayMin;
  if (data.autoPlayDelayMax < data.autoPlayDelayMin) data.autoPlayDelayMax = data.autoPlayDelayMin;
  chrome.storage.sync.set(data);
  syncLabels();
}

function syncLabels() {
  $('depthVal').textContent = $('depth').value;
  $('movetimeVal').textContent = (parseInt($('movetime').value, 10) / 1000) + 's';
  $('liveMovetimeVal').textContent = (parseInt($('liveMovetime').value, 10) / 1000) + 's';
  $('delayVal').textContent = parseFloat($('delayMin').value) + '–' + parseFloat($('delayMax').value) + 's';
  $('autoDelayVal').textContent = parseFloat($('autoPlayDelayMin').value) + '–' + parseFloat($('autoPlayDelayMax').value) + 's';
  $('secondChanceVal').textContent = parseInt($('autoPlaySecondChance').value, 10) + '%';
}

for (const id of KEYS) {
  const el = $(id);
  if (el) el.addEventListener('change', save);
  if (el && el.tagName === 'INPUT' && el.type === 'range') el.addEventListener('input', syncLabels);
}
