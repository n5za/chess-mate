const ENGINE_SCRIPT = 'engine/stockfish-18-lite-single.js';

let worker = null;
let isReady = false;
let initAttempts = 0;
const MAX_INIT = 3;
let currentRequestId = null;
let searchTimeout = null;
let bestInfo = null;
let secondInfo = null;
let searching = false;
let stopPending = false;
let pendingSearch = null;
let gen = 0;
let currentGen = 0;
let bestInfoGen = 0;
let selectedMove = null;
let strengthLimited = false;
let candidates = new Map();

function postToEngine(cmd) {
  if (!worker) return false;
  try {
    worker.postMessage(cmd);
    return true;
  } catch (e) {
    return false;
  }
}

function sendBestmove(requestId, result) {
  try {
    const delivery = chrome.runtime.sendMessage({
      action: 'chessmate-bestmove',
      requestId,
      result
    });
    if (delivery?.catch) delivery.catch(() => {});
  } catch (e) {}
}

function resetEngine(retry = false) {
  if (worker) worker.terminate();
  worker = null;
  isReady = false;
  searching = false;
  stopPending = false;
  clearTimeout(searchTimeout);
  searchTimeout = null;
  if (currentRequestId !== null) sendBestmove(currentRequestId, null);
  currentRequestId = null;
  bestInfo = secondInfo = null;
  bestInfoGen = 0;
  if (!retry) initAttempts = 0;
  if (retry) setTimeout(initEngine, 1200);
  else initEngine();
}

function initEngine() {
  if (worker || initAttempts >= MAX_INIT) return;
  initAttempts++;
  try {
    worker = new Worker(ENGINE_SCRIPT);
    worker.onmessage = (e) => {
      const data = e.data;
      if (typeof data !== 'string') return;
      if (data === 'readyok') {
        isReady = true;
        initAttempts = 0;
        tryLaunch();
        return;
      }
      if (data.startsWith('info')) {
        parseInfo(data);
        return;
      }
      if (data.startsWith('bestmove')) {
        selectedMove = data.split(/\s+/)[1];
        searching = false;
        if (searchTimeout) {
          clearTimeout(searchTimeout);
          searchTimeout = null;
        }
        if (stopPending) {
          stopPending = false;
          const id = currentRequestId;
          const result = null;
          currentRequestId = null;
          bestInfo = null;
          secondInfo = null;
          bestInfoGen = 0;
          if (id) sendBestmove(id, result);
          tryLaunch();
          return;
        }
        finishSearch();
      }
    };
    worker.onerror = (e) => {
      console.error('[ChessMate] engine worker error:', e.message);
      resetEngine(true);
    };
    worker.postMessage('uci');
    worker.postMessage('setoption name Threads value 1');
    worker.postMessage('setoption name Hash value 16');
    worker.postMessage('isready');
  } catch (e) {
    console.error('[ChessMate] engine init failed:', e);
    worker = null;
    setTimeout(initEngine, 1200);
  }
}

function parseInfo(line) {
  if (!searching || bestInfoGen !== currentGen) return;
  const pvMatch = line.match(/\spv\s+(.+)$/);
  if (!pvMatch) return;
  const mpMatch = line.match(/\bmultipv\s+(\d+)/);
  const mp = mpMatch ? parseInt(mpMatch[1], 10) : 1;
  const depthMatch = line.match(/\bdepth\s+(\d+)/);
  const depth = depthMatch ? parseInt(depthMatch[1], 10) : 0;
  const seldepthMatch = line.match(/\bseldepth\s+(\d+)/);
  const seldepth = seldepthMatch ? parseInt(seldepthMatch[1], 10) : depth;
  let scoreCp = null;
  let scoreMate = null;
  const cp = line.match(/\bscore\s+cp\s+(-?\d+)/);
  if (cp) scoreCp = parseInt(cp[1], 10);
  const mate = line.match(/\bscore\s+mate\s+(-?\d+)/);
  if (mate) scoreMate = parseInt(mate[1], 10);
  if (scoreCp === null && scoreMate === null) return;
  const entry = {
    depth,
    seldepth,
    scoreCp,
    scoreMate,
    move: pvMatch[1].trim().split(/\s+/)[0],
    pv: pvMatch[1].trim().split(/\s+/).slice(0, 8).join(' ')
  };
  candidates.set(entry.move, entry);
  if (mp > 2) return;
  if (mp === 2) {
    if (!secondInfo || depth >= secondInfo.depth) secondInfo = entry;
  } else if (!bestInfo || depth >= bestInfo.depth) {
    bestInfo = entry;
  }
}

function buildResult() {
  if (!selectedMove || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(selectedMove)) return null;
  const info = candidates.get(selectedMove);
  const r = { depth: 0, scoreCp: null, scoreMate: null, ...(info || {}), move: selectedMove, strengthLimited };
  if (secondInfo && secondInfo.move !== selectedMove && !strengthLimited) {
    r.move2 = secondInfo.move;
    r.score2Cp = secondInfo.scoreCp;
    r.score2Mate = secondInfo.scoreMate;
  }
  return r;
}

function finishSearch() {
  if (!currentRequestId) return;
  const id = currentRequestId;
  currentRequestId = null;
  const result = bestInfoGen === currentGen ? buildResult() : null;
  bestInfo = null;
  secondInfo = null;
  bestInfoGen = 0;
  sendBestmove(id, result);
  tryLaunch();
}

function launchSearch(msg) {
  if (searchTimeout) {
    clearTimeout(searchTimeout);
    searchTimeout = null;
  }
  const myGen = ++gen;
  currentGen = myGen;
  currentRequestId = msg.requestId;
  bestInfo = null;
  secondInfo = null;
  bestInfoGen = myGen;
  selectedMove = null;
  candidates.clear();
  strengthLimited = msg.strengthMode === 'elo';

  if (isReady) {
    const bounded = (v, min, max, fallback) => Number.isFinite(Number(v)) ? Math.max(min, Math.min(max, Math.round(Number(v)))) : fallback;
    const commands = [
      'setoption name UCI_LimitStrength value ' + strengthLimited,
      'setoption name UCI_Elo value ' + bounded(msg.targetElo, 1320, 3190, 1600),
      'setoption name Skill Level value 20',
      'setoption name MultiPV value ' + bounded(msg.multipv, 1, 2, 1),
      'position fen ' + msg.fen,
      'go depth ' + bounded(msg.depth, 1, 30, 22) + ' movetime ' + Math.max(100, Math.min(60000, Number(msg.movetime) || 3000))
    ];
    commands.forEach((c) => postToEngine(c));
    searching = true;
  } else {
    pendingSearch = msg;
    initEngine();
  }

  const guardMs = Math.max(100, Math.min(60000, Number(msg.movetime) || 3000)) + 5000;
  searchTimeout = setTimeout(() => {
    if (myGen !== currentGen || !currentRequestId) return;
    postToEngine('stop');
    setTimeout(() => {
      if (myGen !== currentGen || !currentRequestId) return;
      resetEngine();
    }, 400);
  }, guardMs);
}

function tryLaunch() {
  if (!pendingSearch || !isReady || searching) return;
  const msg = pendingSearch;
  pendingSearch = null;
  launchSearch(msg);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;
  if (msg.action === 'chessmate-ping') {
    sendResponse({ pong: true });
    return false;
  }
  if (msg.action === 'chessmate-offscreen-reset') {
    resetEngine();
    sendResponse({ ok: true });
    return false;
  }
  if (msg.action !== 'chessmate-engine-analyze') return false;
  if (msg.requestId === currentRequestId || msg.requestId === pendingSearch?.requestId) {
    sendResponse({ ok: true });
    return false;
  }
  if (typeof msg.fen !== 'string' || /[\r\n]/.test(msg.fen)) return false;
  if (pendingSearch) sendBestmove(pendingSearch.requestId, null);
  pendingSearch = msg;
  if (!worker) initEngine();
  if (searching) {
    stopPending = true;
    postToEngine('stop');
  } else {
    tryLaunch();
  }
  sendResponse({ ok: true });
  return false;
});

initEngine();
