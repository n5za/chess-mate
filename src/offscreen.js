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
    chrome.runtime.sendMessage({
      action: 'chessmate-bestmove',
      requestId,
      result
    });
  } catch (e) {}
}

function initEngine() {
  if (worker || initAttempts >= MAX_INIT) return;
  initAttempts++;
  try {
    worker = new Worker(ENGINE_SCRIPT);
    worker.onmessage = (e) => {
      const data = e.data;
      if (typeof data !== 'string') return;
      if (data === 'uciok' || data === 'readyok') {
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
        searching = false;
        if (searchTimeout) {
          clearTimeout(searchTimeout);
          searchTimeout = null;
        }
        if (stopPending) {
          stopPending = false;
          const id = currentRequestId;
          const result = buildResult();
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
      worker = null;
      isReady = false;
      setTimeout(initEngine, 1200);
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
  if (bestInfoGen !== currentGen) return;
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
  if (mp === 2) {
    if (!secondInfo || seldepth >= secondInfo.seldepth) secondInfo = entry;
  } else if (!bestInfo || seldepth >= bestInfo.seldepth) {
    bestInfo = entry;
  }
}

function buildResult() {
  if (!bestInfo) return null;
  const r = { ...bestInfo };
  if (secondInfo) {
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

  if (isReady) {
    const commands = [
      'setoption name MultiPV value ' + (msg.multipv || 1),
      'position fen ' + msg.fen,
      'go depth ' + (msg.depth || 16) + ' movetime ' + (msg.movetime || 2500)
    ];
    commands.forEach((c) => postToEngine(c));
    searching = true;
  } else {
    pendingSearch = msg;
    initEngine();
  }

  const guardMs = (msg.movetime || 2500) + 5000;
  searchTimeout = setTimeout(() => {
    if (myGen !== currentGen || !currentRequestId) return;
    postToEngine('stop');
    setTimeout(() => {
      if (myGen !== currentGen || !currentRequestId) return;
      finishSearch();
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
  if (msg.action !== 'chessmate-engine-analyze') return false;
  pendingSearch = msg;
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
