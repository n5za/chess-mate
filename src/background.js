let pendingTabs = new Map();
let offscreenAlive = false;

function pingOffscreen(timeoutMs = 3000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve(ok);
    };
    const t = setTimeout(() => finish(false), timeoutMs);
    try {
      chrome.runtime.sendMessage({ action: 'chessmate-ping' }, (resp) => {
        if (chrome.runtime.lastError) return finish(false);
        finish(!!(resp && resp.pong));
      });
    } catch (e) {
      finish(false);
    }
  });
}

async function ensureOffscreen() {
  const apiOk = typeof chrome.offscreen !== 'undefined' && chrome.offscreen.hasDocument;
  const has = apiOk ? await chrome.offscreen.hasDocument() : false;
  if (has) {
    if (offscreenAlive) return true;
    if (await pingOffscreen()) {
      offscreenAlive = true;
      return true;
    }
  }
  if (apiOk) {
    try {
      await chrome.offscreen.createDocument({
        url: 'src/offscreen.html',
        reasons: ['WORKERS'],
        justification: 'Run the Stockfish WASM engine in a dedicated worker'
      });
    } catch (e) {
      if (!String(e && e.message).includes('only a single offscreen document')) throw e;
    }
  }
  if (await pingOffscreen()) {
    offscreenAlive = true;
    return true;
  }
  return false;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;

  if (msg.action === 'chessmate-ping') {
    sendResponse({ pong: true });
    return false;
  }

  if (msg.action === 'chessmate-analyze') {
    const tabId = sender.tab ? sender.tab.id : null;
    if (tabId === null || tabId === undefined) return false;
    ensureOffscreen()
      .then((ok) => {
        if (!ok) {
          console.error('[ChessMate] offscreen not available');
          sendResponse({ ok: false });
          return;
        }
        pendingTabs.set(msg.requestId, tabId);
        chrome.runtime.sendMessage({ ...msg, action: 'chessmate-engine-analyze' });
        sendResponse({ ok: true });
      })
      .catch((err) => {
        console.error('[ChessMate] offscreen init failed:', err);
        sendResponse({ ok: false, error: String(err) });
      });
    return true;
  }

  if (msg.action === 'chessmate-bestmove') {
    const tabId = pendingTabs.get(msg.requestId);
    if (tabId === undefined) return false;
    pendingTabs.delete(msg.requestId);
    chrome.tabs.sendMessage(tabId, msg).catch(() => {});
    return false;
  }

  return false;
});

chrome.commands.onCommand.addListener((cmd) => {
  if (cmd !== 'toggle-chessmate') return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab || tab.id === undefined) return;
    chrome.tabs.sendMessage(tab.id, { action: 'chessmate-toggle' }).catch(() => {});
  });
});

chrome.runtime.onStartup.addListener(() => {
  offscreenAlive = false;
});
