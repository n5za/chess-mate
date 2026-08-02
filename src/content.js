(() => {
  'use strict';

  const OVERLAY_ID = 'chessmate-overlay';
  const SETTINGS_KEY = 'chessmateSettings';
  const DEFAULTS = {
    enabled: true,
    mode: 'both',        // 'both' | 'live' | 'analysis'
    depth: 18,
    movetime: 2500,
    liveMovetime: 2000,
    liveOnlyOwnTurn: true,
    showEval: true,
    hideMode: 'always',  // 'always' | 'alt' | 'hover'
    delayMin: 0,         // seconds, random thinking delay (live only)
    delayMax: 0,
    autoPlay: false,     // auto-play the engine move
    autoPlayDelayMin: 3, // fallback delay floor (used only when the time control can't be read)
    autoPlayDelayMax: 15,
    speed: 'auto',       // auto: adapt to the game's time control; slow/normal/fast: scale it
    autoPlaySecondChance: 10, // % chance to play the 2nd-best move
    naturalThink: true,  // human think-time model (mood, complexity, clock pressure)
    idleMouse: true,     // subtle idle mouse movement while waiting
    autoNextGame: false, // after a game ends, start the next one automatically
    autoNextTime: '10',  // time control (minutes) for the next game
    debug: false         // console logs (turn on from the console to debug)
  };

  let settings = { ...DEFAULTS };
  let boardEl = null;
  let overlay = null;
  let currentFen = null;
  let requestId = 0;
  let lastDrawKey = '';
  let mutationTimer = null;
  let boardObserver = null;
  let shadowObserver = null;
  let resizeObserver = null;
  let lastBestMove = null;
  let showTimer = null;
  let altHeld = false;
  let pointerInBoard = false;
  let pointerRaf = null;
  let retryTimer = null;
  let retryCount = 0;
  let autoMoveTimer = null;
  let autoMoveScheduled = null;
  let mouseState = { x: window.innerWidth / 2, y: window.innerHeight / 2, buttons: 0 };
  let mouseMoveGen = 0;
  let playGen = 0;
  let gameMood = null;
  let lastMoveCount = null;
  let wanderTimer = null;
  let clickPlayActive = false;
  let gameOverRetries = 0;
  let autoNextTimer = null;
  let detectedTimeMin = null;
  let queueCardClicks = 0;
  let queueCardClickedAt = 0;
  let queuePlayClicked = false;
  let nextGameBusy = false;
  let nextGameBusyAt = 0;

  function isMyTurn() {
    const fen = getFenFromDom();
    if (!fen) return false;
    return fenSideToMove(fen) === (isBoardFlipped() ? 'b' : 'w');
  }

  // Settings: one atomic key in local storage so nothing can be half-written
  // or overwritten key-by-key. Old flat keys are migrated once into it.
  function clampInt(v, lo, hi, d) {
    v = parseInt(v, 10);
    return isNaN(v) ? d : Math.min(hi, Math.max(lo, v));
  }
  function clampNum(v, lo, hi, d) {
    v = parseFloat(v);
    return isNaN(v) ? d : Math.min(hi, Math.max(lo, v));
  }
  function sanitizeSettings(s) {
    const out = { ...DEFAULTS, ...(s || {}) };
    out.depth = clampInt(out.depth, 1, 30, DEFAULTS.depth);
    out.movetime = clampInt(out.movetime, 100, 60000, DEFAULTS.movetime);
    out.liveMovetime = clampInt(out.liveMovetime, 100, 60000, DEFAULTS.liveMovetime);
    out.delayMin = clampNum(out.delayMin, 0, 120, DEFAULTS.delayMin);
    out.delayMax = clampNum(out.delayMax, 0, 120, DEFAULTS.delayMax);
    if (out.delayMax < out.delayMin) out.delayMax = out.delayMin;
    out.autoPlaySecondChance = clampInt(out.autoPlaySecondChance, 0, 100, DEFAULTS.autoPlaySecondChance);
    if (!['both', 'live', 'analysis'].includes(out.mode)) out.mode = DEFAULTS.mode;
    if (!['always', 'alt', 'hover'].includes(out.hideMode)) out.hideMode = DEFAULTS.hideMode;
    if (!['auto', 'slow', 'normal', 'fast', 'turbo'].includes(out.speed)) out.speed = DEFAULTS.speed;
    return out;
  }
  function loadSettings(cb) {
    chrome.storage.local.get(null, (loc) => {
      loc = loc || {};
      let stored = null;
      if (loc[SETTINGS_KEY] && typeof loc[SETTINGS_KEY] === 'object') {
        stored = loc[SETTINGS_KEY];
      } else {
        stored = {};
        for (const k of Object.keys(DEFAULTS)) {
          if (loc[k] !== undefined) stored[k] = loc[k];
        }
        if (Object.keys(stored).length > 0) {
          chrome.storage.local.set({ [SETTINGS_KEY]: stored });
        }
      }
      settings = sanitizeSettings(stored);
      if (cb) cb();
    });
  }

  loadSettings();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' && area !== 'local') return;
    if (changes[SETTINGS_KEY] && changes[SETTINGS_KEY].newValue) {
      settings = sanitizeSettings(changes[SETTINGS_KEY].newValue);
      if (settings.autoPlay) gameMood = null;
      return;
    }
    for (const k of Object.keys(changes)) {
      if (!(k in DEFAULTS)) continue;
      settings[k] = changes[k].newValue === undefined ? DEFAULTS[k] : changes[k].newValue;
      if (k === 'autoPlay' && changes[k].newValue) gameMood = null;
    }
  });

  // ── Board element ──────────────────────────────────────

  function findBoardElement() {
    const candidates = [
      document.querySelector('chess-board'),
      document.querySelector('wc-chess-board'),
      document.querySelector('#board-layout-chessboard'),
      document.querySelector('.board'),
      document.querySelector('[class*="board-layout"]'),
      document.querySelector('[class*="board"]')
    ].filter(Boolean);
    const visible = candidates.find((c) => c.isConnected && c.getBoundingClientRect().width > 0);
    return visible || candidates[0] || null;
  }

  function queryAllInShadow(root, selector) {
    const out = [];
    const walk = (r) => {
      if (r.shadowRoot) walk(r.shadowRoot);
      try {
        r.querySelectorAll(selector).forEach((n) => out.push(n));
      } catch (e) {}
      let hosts;
      try {
        hosts = r.querySelectorAll('*');
      } catch (e) {
        return;
      }
      for (const h of hosts) {
        if (h.shadowRoot) walk(h.shadowRoot);
      }
    };
    walk(root);
    return out;
  }

  function isBoardFlipped() {
    try {
      if (!boardEl) return false;

      // 1) orientation attribute (reliable on chess.com live)
      const orient = boardEl.getAttribute('orientation');
      if (orient) {
        const o = orient.trim().toLowerCase();
        if (o.startsWith('b')) return true;
        if (o.startsWith('w')) return false;
      }
      const rootEl = boardEl.shadowRoot || boardEl;
      const orientInside = rootEl.querySelector('[orientation]');
      if (orientInside) {
        const o = orientInside.getAttribute('orientation').toLowerCase();
        if (o.startsWith('b')) return true;
        if (o.startsWith('w')) return false;
      }

      // 2) flipped class / attribute
      if (boardEl.hasAttribute('flipped')) return true;
      if (boardEl.classList.contains('flipped')) return true;
      const wrap = boardEl.closest('.board, .board-wrapper, .board-layout-main, [class*="board-layout"]');
      if (wrap && (wrap.classList.contains('flipped') || wrap.classList.contains('orientation-black'))) return true;

      // 3) geometric vote: where do white pieces actually sit?
      const rect = boardEl.getBoundingClientRect();
      if (rect.width <= 0) return false;
      const pieces = queryAllInShadow(boardEl, '.piece');
      let whiteVotes = 0;
      let blackVotes = 0;
      let votes = 0;
      for (const p of pieces) {
        const cls = p.className || '';
        const m = cls.match(/square-(\d)(\d)/);
        if (!m) continue;
        const r = parseInt(m[2], 10);
        const pr = p.getBoundingClientRect();
        const relY = (pr.top - rect.top) / rect.height;
        const expWhite = (8 - r) / 8;
        const expBlack = (r - 1) / 8;
        if (Math.abs(relY - expBlack) < Math.abs(relY - expWhite)) blackVotes++;
        else whiteVotes++;
        votes++;
      }
      if (votes >= 1 && blackVotes !== whiteVotes) return blackVotes > whiteVotes;
      return false;
    } catch (e) {
      return false;
    }
  }

  function boardRect() {
    if (!boardEl) return null;
    const r = boardEl.getBoundingClientRect();
    if (!r || r.width <= 0 || r.height <= 0) return null;
    return r;
  }


  // ── FEN extraction ─────────────────────────────────────

  function isValidFen(fen) {
    if (!fen || typeof fen !== 'string') return false;
    const parts = fen.trim().split(/\s+/);
    const rows = parts[0].split('/');
    if (rows.length !== 8) return false;
    for (const row of rows) {
      let count = 0;
      for (const ch of row) {
        if (ch >= '1' && ch <= '8') count += parseInt(ch, 10);
        else if ('pnbrqkPNBRQK'.includes(ch)) count++;
        else return false;
      }
      if (count !== 8) return false;
    }
    return true;
  }

  function fenSideToMove(fen) {
    const p = fen.trim().split(/\s+/);
    return p[1] === 'b' ? 'b' : 'w';
  }

  function getFenFromDom() {
    if (!boardEl) return null;

    // 1) data-fen attribute (full FEN, updated every move) — incl. shadow DOM
    const roots = [boardEl, boardEl.shadowRoot].filter(Boolean);
    for (const r of roots) {
      const dfen = (r.getAttribute && r.getAttribute('data-fen')) || (r.dataset && r.dataset.fen);
      if (dfen && isValidFen(dfen)) return dfen.trim();
    }
    const fenInShadow = queryAllInShadow(boardEl, '[data-fen]')[0];
    if (fenInShadow) {
      const dfen = fenInShadow.getAttribute('data-fen') || fenInShadow.dataset?.fen;
      if (dfen && isValidFen(dfen)) return dfen.trim();
    }

    // 2) game object exposed by the board web component
    try {
      if (boardEl.game) {
        const g = boardEl.game;
        const f = typeof g.getFEN === 'function' ? g.getFEN() : g.fen;
        if (f && isValidFen(f)) return f.trim();
      }
    } catch (e) {}

    // 3) hidden input carrying a FEN-like value
    const fenInput = document.querySelector('input[type="hidden"][value*="/"]');
    if (fenInput && isValidFen(fenInput.value)) return fenInput.value.trim();

    // 4) reconstruct from piece DOM (light + shadow)
    return fenFromPieces();
  }

  function fenFromPieces() {
    const pieces = queryAllInShadow(boardEl, '.piece');
    if (pieces.length === 0) return null;

    const board = Array.from({ length: 8 }, () => Array(8).fill(null));
    const boardRect = boardEl ? boardEl.getBoundingClientRect() : null;
    let seen = 0;

    for (const p of pieces) {
      let piece = null;
      let col = -1, row = -1;

      // piece type: data-piece attribute first (e.g. "wP", "bK")
      const dp = p.getAttribute && p.getAttribute('data-piece');
      if (dp && dp.length === 2 && /^[wb][pnbrqk]$/i.test(dp)) {
        piece = dp[0].toLowerCase() === 'w' ? dp[1].toUpperCase() : dp[1].toLowerCase();
      }

      const cls = p.classList;
      if (!piece) {
        for (const c of cls) {
          const m = /^([wb])-?([pnbrqk])(?:[a-z]*)$/i.exec(c);
          if (m) {
            const upper = m[1] === 'w' || m[1] === 'W';
            piece = (upper ? m[2].toUpperCase() : m[2].toLowerCase());
            break;
          }
        }
      }

      // square from class
      for (const c of cls) {
        const sq = /^square-([1-8])([1-8])$/.exec(c);
        if (sq) {
          col = parseInt(sq[1], 10) - 1;
          row = 8 - parseInt(sq[2], 10);
          break;
        }
      }

      // square from inline style (top/left %)
      if (row < 0 || col < 0) {
        const style = p.getAttribute && (p.getAttribute('style') || '');
        const top = /top:\s*([\d.]+)%/.exec(style);
        const left = /left:\s*([\d.]+)%/.exec(style);
        if (top && left) {
          col = Math.floor(parseFloat(left[1]) * 8 / 100);
          row = Math.floor(parseFloat(top[1]) * 8 / 100);
        }
      }

      // square from geometry (relative to board rect)
      if ((row < 0 || col < 0) && boardRect && boardRect.width > 0) {
        const pr = p.getBoundingClientRect();
        col = Math.round((pr.left - boardRect.left) / (boardRect.width / 8));
        row = Math.round((pr.top - boardRect.top) / (boardRect.height / 8));
      }

      if (piece && row >= 0 && col >= 0 && row < 8 && col < 8 && !board[row][col]) {
        board[row][col] = piece;
        seen++;
      }
    }

    if (seen === 0) return null;

    let placement = '';
    for (let r = 0; r < 8; r++) {
      let empty = 0;
      for (let c = 0; c < 8; c++) {
        const pc = board[r][c];
        if (pc) {
          if (empty) { placement += empty; empty = 0; }
          placement += pc;
        } else {
          empty++;
        }
      }
      if (empty) placement += empty;
      if (r < 7) placement += '/';
    }

    const turn = detectTurn();
    const castling = detectCastling(board);
    return `${placement} ${turn} ${castling} - 0 1`;
  }

  function detectTurn() {
    // 1) running clock: the active clock tells whose turn it is
    const activeClock = document.querySelector('.clock-player-turn, [class*="clock-player-turn"]');
    if (activeClock) {
      const myColor = isBoardFlipped() ? 'b' : 'w';
      if (activeClock.classList.contains('clock-bottom') || activeClock.classList.contains('clock-player-bottom')) {
        return myColor;
      }
      return myColor === 'w' ? 'b' : 'w';
    }
    return detectTurnFromMoveList();
  }

  function detectTurnFromMoveList() {
    let count = 0;
    for (const m of moveNodes()) {
      const text = (m.innerText || m.textContent || '').trim();
      if (m.classList.contains('empty')) continue;
      if (/^\d+\.\.?\.?\s*$/.test(text)) continue;
      count++;
    }
    if (count === 0) return 'w';
    return count % 2 === 0 ? 'w' : 'b';
  }

  function moveNodes() {
    const containers = document.querySelectorAll('vertical-move-list, .move-list, .move-list-component, div[class*="move-list"], div[class*="move-list-component"]');
    let moves = [];
    if (containers.length) {
      containers.forEach((c) => {
        moves = moves.concat(Array.from(c.querySelectorAll('.node, .move-node, .move-node-content, .move, .san')));
      });
    } else {
      moves = Array.from(document.querySelectorAll('.move-node, .move-node-content, .san, .move'));
    }
    return moves;
  }

  function countMoves() {
    let count = 0;
    for (const m of moveNodes()) {
      const text = (m.innerText || m.textContent || '').trim();
      if (m.classList.contains('empty')) continue;
      if (/^\d+\.\.?\.?\s*$/.test(text)) continue;
      count++;
    }
    return count;
  }

  function readClockMs() {
    const el = document.querySelector('.clock-bottom, [class*="clock-bottom"], .clock-player-bottom, [class*="clock-player-bottom"]');
    if (!el) return null;
    const text = (el.innerText || el.textContent || '').trim();
    if (!text) return null;
    const m = text.match(/(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.\d+)?/);
    if (!m) return null;
    const h = m[1] ? parseInt(m[1], 10) : 0;
    const min = parseInt(m[2], 10);
    const sec = parseInt(m[3], 10);
    return ((h * 60 + min) * 60 + sec) * 1000;
  }

  // ── Time control detection / adaptive speed ──────────
  // Reads the game's time control (e.g. "10 min", "1 | 0", "5 min (Blitz)")
  // so the bot never loses on time. Detected once per game.
  // Reads game-area elements first (header, clocks, time selectors) so
  // unrelated page text (countdowns, ads, puzzle timers) can't fool it.
  function detectTimeControl() {
    if (detectedTimeMin !== null) return detectedTimeMin;
    const patterns = [
      { re: /(\d+)\s*\|\s*(\d+)/, parse: (m) => Math.max(1, parseInt(m[1], 10) + parseInt(m[2], 10) / 2) },
      { re: /(\d+)\s*min\b/i, parse: (m) => Math.max(1, parseInt(m[1], 10)) }
    ];
    const prioritySels = [
      '[class*="game-header"]', '[class*="board-header"]', '[class*="game-info"]',
      '[class*="time-control"]', '[class*="time-select"]', '[class*="preset"]',
      '[class*="component-timer"]', '[class*="timer"]', '[class*="clock"]'
    ].join(',');
    const seen = new Set();
    const texts = [];
    queryAllInShadow(document, prioritySels).forEach((el) => {
      const t = (el.innerText || el.textContent || '').trim();
      if (t && !seen.has(t)) {
        seen.add(t);
        texts.push(t);
      }
    });
    for (const t of texts) {
      for (const p of patterns) {
        const m = t.match(p.re);
        if (m) {
          detectedTimeMin = p.parse(m);
          debugLog('time control detected: ' + m[0] + ' (' + detectedTimeMin + ' min)');
          return detectedTimeMin;
        }
      }
    }
    // Last resort: whole page text ("X | Y" first, then a plausible "X min").
    if (document.body) {
      const bodyText = document.body.innerText;
      const m1 = bodyText.match(/(\d+)\s*\|\s*(\d+)/);
      if (m1) {
        detectedTimeMin = Math.max(1, parseInt(m1[1], 10) + parseInt(m1[2], 10) / 2);
        debugLog('time control detected (page): ' + m1[0] + ' (' + detectedTimeMin + ' min)');
        return detectedTimeMin;
      }
      const m2 = bodyText.match(/(\d+)\s*min\b/i);
      if (m2) {
        const min = parseInt(m2[1], 10);
        if (min >= 1 && min <= 180) {
          detectedTimeMin = min;
          debugLog('time control detected (page): ' + m2[1] + ' min');
          return detectedTimeMin;
        }
      }
    }
    return null;
  }

  function resetTimeControl() {
    detectedTimeMin = null;
  }

  function adaptiveDelayRange() {
    let min = settings.autoPlayDelayMin || 3;
    let max = Math.max(min, settings.autoPlayDelayMax || 15);
    const minutes = detectTimeControl();
    if (minutes !== null) {
      if (minutes <= 1) { min = 1; max = 2; }
      else if (minutes <= 3) { min = 1.5; max = 4; }
      else if (minutes <= 5) { min = 2; max = 7; }
      else if (minutes <= 10) { min = 3; max = 15; }
      else if (minutes <= 15) { min = 4; max = 20; }
      else if (minutes <= 30) { min = 5; max = 25; }
      else { min = 6; max = 30; }
    }
    const f = settings.speed === 'slow' ? 1.6 : settings.speed === 'fast' ? 0.5 : settings.speed === 'turbo' ? 0.25 : 1;
    return [Math.max(0.4, min * f), Math.max(min * f, max * f)];
  }

  function engineTimeMs() {
    const minutes = detectTimeControl();
    if (settings.speed === 'turbo') return Math.min(settings.liveMovetime, 600);
    if (minutes === null) return settings.liveMovetime;
    if (minutes <= 1) return Math.min(settings.liveMovetime, 800);
    if (minutes <= 3) return Math.min(settings.liveMovetime, 1500);
    if (minutes <= 5) return Math.min(settings.liveMovetime, 2000);
    return settings.liveMovetime;
  }

  function detectCastling(board) {
    let rights = '';
    if (board[7][4] === 'K') {
      if (board[7][7] === 'R') rights += 'K';
      if (board[7][0] === 'R') rights += 'Q';
    }
    if (board[0][4] === 'k') {
      if (board[0][7] === 'r') rights += 'k';
      if (board[0][0] === 'r') rights += 'q';
    }
    return rights || '-';
  }

  // ── Mode / turn logic ──────────────────────────────────

  function isAnalysisView() {
    return /\/analysis(?:\?|$|\/)/.test(location.pathname) ||
      !!document.querySelector('.analysis-tools, .analysis-sidebar, [class*="analysis"]');
  }

  function isLiveView() {
    return /\/game\/live\//.test(location.pathname) ||
      /\/play\/online/.test(location.pathname) ||
      /\/play\/computer/.test(location.pathname);
  }

  function shouldAnalyze(fen) {
    if (!settings.enabled) return false;
    const analysis = isAnalysisView();
    if (settings.mode === 'live' && analysis) return false;
    if (settings.mode === 'analysis' && !analysis) return false;
    if (settings.liveOnlyOwnTurn && !analysis) {
      const myColor = isBoardFlipped() ? 'b' : 'w';
      if (fenSideToMove(fen) !== myColor) return false;
    }
    return true;
  }

  // ── Engine request ─────────────────────────────────────

  function requestAnalysis(fen) {
    requestId++;
    const id = requestId;
    const payload = {
      action: 'chessmate-analyze',
      requestId: id,
      fen,
      depth: settings.depth,
      movetime: isAnalysisView() ? settings.movetime : engineTimeMs(),
      multipv: settings.autoPlay && (settings.autoPlaySecondChance || 0) > 0 ? 2 : 1
    };
    chrome.runtime.sendMessage(payload);
    scheduleRetry(id, fen, payload);
    return id;
  }

  function scheduleRetry(id, fen, payload) {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    const retryMs = settings.retryMs || 6000;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (id !== requestId) return;
      if (getFenFromDom() !== fen) return;
      if (retryCount >= 3) {
        retryCount = 0;
        if (settings.autoPlay && isMyTurn()) {
          debugLog('engine unresponsive, resetting engine and retrying');
          chrome.runtime.sendMessage({ action: 'chessmate-engine-reset' });
          chrome.runtime.sendMessage(payload);
          scheduleRetry(id, fen, payload);
        }
        return;
      }
      retryCount++;
      debugLog('no result, retrying (' + retryCount + ')');
      chrome.runtime.sendMessage(payload);
      scheduleRetry(id, fen, payload);
    }, retryMs);
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return false;
    if (msg.action === 'chessmate-toggle') {
      settings.enabled = !settings.enabled;
      if (!settings.enabled) {
        clearBestMove();
        clearOverlay();
      } else {
        update();
      }
      return false;
    }
    if (msg.action !== 'chessmate-bestmove') return false;
    if (msg.requestId !== requestId) return false;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    retryCount = 0;
    const fen = getFenFromDom();
    if (!fen || fen !== currentFen) return false;
    lastBestMove = msg.result;
    scheduleShow();
    scheduleAutoPlay(msg.result);
    return false;
  });

  // ── Stealth rendering ─────────────────────────────────

  function clearBestMove() {
    lastBestMove = null;
    cancelAutoMove();
    if (showTimer) {
      clearTimeout(showTimer);
      showTimer = null;
    }
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    retryCount = 0;
    clearOverlay();
  }

  function scheduleShow() {
    if (showTimer) {
      clearTimeout(showTimer);
      showTimer = null;
    }
    const inAnalysis = isAnalysisView();
    const delayMax = settings.delayMax || 0;
    if (!inAnalysis && delayMax > 0) {
      const lo = Math.max(0, settings.delayMin || 0);
      const hi = Math.max(lo, delayMax);
      const d = lo + Math.random() * (hi - lo);
      showTimer = setTimeout(() => {
        showTimer = null;
        renderBestMove();
      }, d * 1000);
    } else {
      renderBestMove();
    }
  }

  function renderBestMove() {
    if (!lastBestMove) return;
    const mode = settings.hideMode;
    if (mode === 'alt' && !altHeld) {
      clearOverlay();
      return;
    }
    if (mode === 'hover' && !pointerInBoard) {
      clearOverlay();
      return;
    }
    drawBestMove(lastBestMove);
  }

  // ── Arrow overlay ──────────────────────────────────────

  function getOrCreateOverlay() {
    if (overlay && document.documentElement.contains(overlay)) return overlay;
    overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    document.documentElement.appendChild(overlay);
    return overlay;
  }

  function squareCenter(square, sqSize, flipped) {
    const file = 'abcdefgh'.indexOf(square[0]);
    const rank = parseInt(square[1], 10) - 1;
    if (file < 0 || rank < 0) return { x: 0, y: 0 };
    const col = flipped ? 7 - file : file;
    const row = flipped ? rank : 7 - rank;
    return { x: (col + 0.5) * sqSize, y: (row + 0.5) * sqSize };
  }

  function drawBestMove(result) {
    const rect = boardRect();
    if (!result || !result.move || !rect) return;

    const key = `${result.move}|${result.scoreCp}|${result.scoreMate}|${rect.left},${rect.top},${rect.width}`;
    if (key === lastDrawKey) return;
    lastDrawKey = key;

    const container = getOrCreateOverlay();
    container.style.left = `${Math.round(rect.left)}px`;
    container.style.top = `${Math.round(rect.top)}px`;
    container.style.width = `${Math.round(rect.width)}px`;
    container.style.height = `${Math.round(rect.height)}px`;
    container.innerHTML = '';

    const sqSize = rect.width / 8;
    const flipped = isBoardFlipped();
    const from = squareCenter(result.move.slice(0, 2), sqSize, flipped);
    const to = squareCenter(result.move.slice(2, 4), sqSize, flipped);
    if (!from.x && !from.y && !to.x && !to.y) return;

    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', rect.width);
    svg.setAttribute('height', rect.height);
    svg.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;';

    const color = 'rgba(0, 200, 80, 0.85)';

    const defs = document.createElementNS(NS, 'defs');
    const marker = document.createElementNS(NS, 'marker');
    marker.setAttribute('id', 'chessmate-arrow-head');
    marker.setAttribute('markerWidth', '12');
    marker.setAttribute('markerHeight', '12');
    marker.setAttribute('refX', '9');
    marker.setAttribute('refY', '6');
    marker.setAttribute('orient', 'auto');
    const head = document.createElementNS(NS, 'path');
    head.setAttribute('d', 'M 0 0 L 12 6 L 0 12 z');
    head.setAttribute('fill', color);
    marker.appendChild(head);
    defs.appendChild(marker);
    svg.appendChild(defs);

    const line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', from.x);
    line.setAttribute('y1', from.y);
    line.setAttribute('x2', to.x);
    line.setAttribute('y2', to.y);
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', Math.max(3, Math.round(sqSize * 0.05)));
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('marker-end', 'url(#chessmate-arrow-head)');
    svg.appendChild(line);

    const circle = document.createElementNS(NS, 'circle');
    circle.setAttribute('cx', from.x);
    circle.setAttribute('cy', from.y);
    circle.setAttribute('r', Math.max(4, Math.round(sqSize * 0.06)));
    circle.setAttribute('fill', color);
    svg.appendChild(circle);

    if (settings.showEval) {
      const side = currentFen ? fenSideToMove(currentFen) : 'w';
      const flip = side === 'b' ? -1 : 1;
      let text = '';
      if (result.scoreMate !== null) {
        text = '#' + Math.abs(result.scoreMate * flip);
      } else if (result.scoreCp !== null) {
        const score = (result.scoreCp * flip) / 100;
        text = (score >= 0 ? '+' : '') + score.toFixed(1);
      }
      if (text) {
        const fontSize = Math.max(10, Math.round(sqSize * 0.22));
        const midX = (from.x + to.x) / 2;
        const midY = (from.y + to.y) / 2;
        const tw = text.length * fontSize * 0.55;
        const pad = Math.max(3, Math.round(fontSize * 0.4));
        const bg = document.createElementNS(NS, 'rect');
        bg.setAttribute('x', midX - tw / 2 - pad);
        bg.setAttribute('y', midY - fontSize / 2 - pad);
        bg.setAttribute('width', tw + pad * 2);
        bg.setAttribute('height', fontSize + pad * 2);
        bg.setAttribute('fill', 'rgba(0,0,0,0.8)');
        bg.setAttribute('rx', '4');
        svg.appendChild(bg);
        const label = document.createElementNS(NS, 'text');
        label.setAttribute('x', midX);
        label.setAttribute('y', midY + fontSize * 0.35);
        label.setAttribute('fill', '#fff');
        label.setAttribute('font-size', fontSize);
        label.setAttribute('font-weight', 'bold');
        label.setAttribute('font-family', 'Arial, sans-serif');
        label.setAttribute('text-anchor', 'middle');
        label.textContent = text;
        svg.appendChild(label);
      }
    }

    container.appendChild(svg);
  }

  function clearOverlay() {
    lastDrawKey = '';
    if (overlay && overlay.isConnected) overlay.innerHTML = '';
  }

  // ── Observers ──────────────────────────────────────────

  function scheduleUpdate() {
    if (mutationTimer) return;
    mutationTimer = setTimeout(() => {
      mutationTimer = null;
      update();
    }, 200);
  }

  function update() {
    boardEl = findBoardElement();
    if (!boardEl) {
      clearOverlay();
      return;
    }

    const fen = getFenFromDom();
    if (!fen || !shouldAnalyze(fen)) {
      if (!fen) debugLog('no FEN (board found, but pieces/FEN not readable)');
      else debugLog('skipped: mode=' + settings.mode + ' analysis=' + isAnalysisView() +
        ' fenTurn=' + fenSideToMove(fen) + ' myColor=' + (isBoardFlipped() ? 'b' : 'w'));
      clearBestMove();
      return;
    }
    if (fen !== currentFen) {
      currentFen = fen;
      lastDrawKey = '';
      clearBestMove();
      const mc = countMoves();
      if (lastMoveCount !== null && mc < lastMoveCount) {
        gameMood = null;
        resetTimeControl();
      }
      lastMoveCount = mc;
      requestAnalysis(fen);
      debugLog('analyzing: ' + fen);
    }

    if (isGameOver()) {
      clearOverlay();
    }

    const rect = boardRect();
    if (rect && overlay && overlay.isConnected) {
      overlay.style.left = `${Math.round(rect.left)}px`;
      overlay.style.top = `${Math.round(rect.top)}px`;
      overlay.style.width = `${Math.round(rect.width)}px`;
      overlay.style.height = `${Math.round(rect.height)}px`;
    }
  }

  function isGameOver() {
    return !!document.querySelector('.game-over-modal, .modal-game-over-component, .game-over-header-component, [class*="game-over"]');
  }

  function debugLog(msg) {
    if (settings.debug !== false) console.log('[ChessMate]', msg);
  }

  function setupObservers() {
    if (resizeObserver) resizeObserver.disconnect();
    resizeObserver = new ResizeObserver(() => {
      if (overlay && overlay.isConnected) {
        const rect = boardRect();
        if (rect) {
          overlay.style.left = `${Math.round(rect.left)}px`;
          overlay.style.top = `${Math.round(rect.top)}px`;
          overlay.style.width = `${Math.round(rect.width)}px`;
          overlay.style.height = `${Math.round(rect.height)}px`;
        }
      }
    });
    const root = findBoardElement();
    if (root) resizeObserver.observe(root);

    if (boardObserver) boardObserver.disconnect();
    boardObserver = new MutationObserver(scheduleUpdate);
    boardObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style']
    });

    // shadow DOM board (live games): observe the shadow root as well
    if (shadowObserver) shadowObserver.disconnect();
    shadowObserver = null;
    if (root && root.shadowRoot) {
      shadowObserver = new MutationObserver(scheduleUpdate);
      shadowObserver.observe(root.shadowRoot, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style']
      });
    }
  }

  function setupStealthListeners() {
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Alt' || e.code === 'AltLeft' || e.code === 'AltRight') {
        altHeld = true;
        renderBestMove();
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.key === 'Alt' || e.code === 'AltLeft' || e.code === 'AltRight') {
        altHeld = false;
        renderBestMove();
      }
    });
    window.addEventListener('blur', () => {
      altHeld = false;
      renderBestMove();
    });
    document.addEventListener('pointermove', (e) => {
      if (settings.hideMode !== 'hover') return;
      const x = e.clientX;
      const y = e.clientY;
      if (pointerRaf) return;
      pointerRaf = requestAnimationFrame(() => {
        pointerRaf = null;
        const rect = boardRect();
        const inside = rect
          ? rect.left <= x && x <= rect.right && rect.top <= y && y <= rect.bottom
          : false;
        if (inside !== pointerInBoard) {
          pointerInBoard = inside;
          renderBestMove();
        }
      });
    }, { passive: true });
  }

  // ── Auto-play (human-like mouse) ───────────────────────
  // Human-like mouse path generation, adapted from:
  //   Xetera/ghost-cursor (Bezier anchors, Fitts's law, overshoot)
  //   veemex/node-natural-mouse (noise, effect fade, flow)

  function rand(min, max) {
    return min + Math.random() * (max - min);
  }

  function vecSub(a, b) {
    return { x: a.x - b.x, y: a.y - b.y };
  }

  function vecMag(v) {
    return Math.sqrt(v.x * v.x + v.y * v.y);
  }

  function vecPerp(v) {
    return { x: v.y, y: -v.x };
  }

  function humanAnchors(a, b, spread) {
    const side = Math.random() < 0.5 ? 1 : -1;
    const mk = () => {
      const t = Math.random();
      const mid = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      const n = vecPerp(vecSub(mid, a));
      const m = vecMag(n) || 1;
      const off = rand(0.3, 1) * spread * side;
      return { x: mid.x + (n.x / m) * off, y: mid.y + (n.y / m) * off };
    };
    const c1 = mk();
    const c2 = mk();
    return c1.x <= c2.x ? [c1, c2] : [c2, c1];
  }

  function bezierPoint(p0, p1, p2, p3, t) {
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    return {
      x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
      y: a * p0.y + b * p1.y + c * p2.y + d * p3.y
    };
  }

  function humanPath(from, to) {
    const dist = vecMag(vecSub(to, from));
    const style = Math.random();
    const fitts = 2 * Math.log2(dist / 60 + 1);
    const steps = Math.max(12, Math.min(100, Math.ceil((Math.log2(fitts + 1) + rand(5, 25)) * 3)));
    const pts = [];
    if (style < 0.25) {
      const spread = Math.min(120, Math.max(2, dist * rand(0.04, 0.12)));
      const [c1, c2] = humanAnchors(from, to, spread);
      const s = Math.max(10, Math.floor(steps * 0.6));
      for (let i = 0; i <= s; i++) {
        const p = bezierPoint(from, c1, c2, to, i / s);
        pts.push({ x: p.x + (Math.random() - 0.5) * 1.2, y: p.y + (Math.random() - 0.5) * 1.2 });
      }
      pts.style = 'fast';
    } else if (style < 0.4) {
      const spread = Math.min(200, Math.max(2, dist * rand(0.2, 0.35)));
      const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
      const n = vecPerp(vecSub(to, from));
      const m = vecMag(n) || 1;
      const c1 = { x: mid.x + (n.x / m) * spread, y: mid.y + (n.y / m) * spread };
      const c2 = { x: mid.x - (n.x / m) * spread * 0.8, y: mid.y - (n.y / m) * spread * 0.8 };
      for (let i = 0; i <= steps; i++) {
        const p = bezierPoint(from, c1, c2, to, i / steps);
        const fade = Math.min(1, (i / steps) * 4) * Math.min(1, (1 - i / steps) * 4);
        pts.push({ x: p.x + (Math.random() - 0.5) * 1.6 * fade, y: p.y + (Math.random() - 0.5) * 1.6 * fade });
      }
    } else {
      const spread = Math.min(200, Math.max(2, dist * rand(0.25, 0.4)));
      const [c1, c2] = humanAnchors(from, to, spread);
      for (let i = 0; i <= steps; i++) {
        const p = bezierPoint(from, c1, c2, to, i / steps);
        const fade = Math.min(1, (i / steps) * 4) * Math.min(1, (1 - i / steps) * 4);
        pts.push({
          x: Math.max(0, p.x + (Math.random() - 0.5) * 1.6 * fade),
          y: Math.max(0, p.y + (Math.random() - 0.5) * 1.6 * fade)
        });
      }
    }
    return pts;
  }

  function dispatchPointer(type, x, y, extra) {
    const target = document.elementFromPoint(x, y) || document.documentElement;
    const opts = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      button: extra && extra.button !== undefined ? extra.button : 0,
      buttons: mouseState.buttons,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      pressure: mouseState.buttons ? 0.5 : 0
    };
    try {
      if (type.startsWith('pointer')) {
        target.dispatchEvent(new PointerEvent(type, opts));
      } else {
        const mev = new MouseEvent(type, opts);
        Object.defineProperty(mev, 'buttons', { get: () => opts.buttons });
        target.dispatchEvent(mev);
      }
    } catch (e) {}
  }

  function humanMoveTo(x, y) {
    const myGen = ++mouseMoveGen;
    const from = { ...mouseState };
    const pts = humanPath(from, { x, y });
    const fast = pts.style === 'fast';
    return new Promise((resolve) => {
      let i = 0;
      let paused = false;
      const step = () => {
        if (myGen !== mouseMoveGen || i >= pts.length) {
          mouseState.x = x;
          mouseState.y = y;
          return resolve();
        }
        const p = pts[i++];
        mouseState.x = p.x;
        mouseState.y = p.y;
        dispatchPointer('pointermove', p.x, p.y);
        dispatchPointer('mousemove', p.x, p.y);
        const progress = i / pts.length;
        const ease = 1 + 2.2 * Math.pow(progress - 0.5, 2);
        let delay = (fast ? rand(4, 10) : rand(6, 16)) * ease;
        if (!paused && Math.random() < 0.1 && i > pts.length * 0.4 && i < pts.length * 0.7) {
          paused = true;
          delay += rand(150, 400);
        }
        setTimeout(step, delay);
      };
      step();
    });
  }

  function humanClick(x, y) {
    return humanMoveTo(x, y).then(() => new Promise((resolve) => {
      setTimeout(() => {
        mouseState.buttons = 1;
        dispatchPointer('pointerdown', x, y);
        dispatchPointer('mousedown', x, y);
        setTimeout(() => {
          mouseState.buttons = 0;
          dispatchPointer('pointerup', x, y);
          dispatchPointer('mouseup', x, y);
          dispatchPointer('click', x, y);
          resolve();
        }, rand(50, 120));
      }, rand(40, 110));
    }));
  }

  function clientPointForSquare(square) {
    const rect = boardRect();
    if (!rect) return null;
    const c = squareCenter(square, rect.width / 8, isBoardFlipped());
    return { x: rect.left + c.x, y: rect.top + c.y };
  }

  function cancelAutoMove() {
    mouseMoveGen++;
    playGen++;
    clickPlayActive = false;
    if (autoMoveTimer) {
      clearTimeout(autoMoveTimer);
      autoMoveTimer = null;
    }
    autoMoveScheduled = null;
  }

  function cancelWander() {
    if (wanderTimer) {
      clearTimeout(wanderTimer);
      wanderTimer = null;
    }
  }

  function startWanderLoop() {
    if (wanderTimer) return;
    wanderTimer = setTimeout(() => {
      wanderTimer = null;
      if (settings.autoPlay && settings.idleMouse && !isGameOver() && !mouseState.buttons && document.visibilityState === 'visible') {
        doWander();
      }
      startWanderLoop();
    }, rand(4000, 9000));
  }

  function wanderTarget(rect, sq) {
    const flipped = isBoardFlipped();
    const r = Math.random();
    const at = (sqName) => {
      const c = squareCenter(sqName, sq, flipped);
      return { x: rect.left + c.x + rand(-8, 8), y: rect.top + c.y + rand(-8, 8) };
    };
    if (r < 0.5 && lastBestMove && lastBestMove.move) return at(lastBestMove.move.slice(0, 2));
    if (r < 0.75 && lastBestMove && lastBestMove.move) return at(lastBestMove.move.slice(2, 4));
    return { x: rect.left + rect.width * rand(0.15, 0.85), y: rect.top + rect.height * rand(0.15, 0.85) };
  }

  function doWander() {
    if (Math.random() < 0.4) return;
    if (clickPlayActive) return;
    const rect = boardRect();
    if (!rect) return;
    const pts = humanPath({ ...mouseState }, wanderTarget(rect, rect.width / 8));
    const myGen = ++mouseMoveGen;
    let i = 0;
    const step = () => {
      if (myGen !== mouseMoveGen || i >= pts.length || !settings.autoPlay || !settings.idleMouse) return;
      const p = pts[i++];
      mouseState.x = p.x;
      mouseState.y = p.y;
      dispatchPointer('pointermove', p.x, p.y);
      dispatchPointer('mousemove', p.x, p.y);
      setTimeout(step, rand(25, 55));
    };
    step();
  }

  function pickMoveToPlay(result) {
    const chance = Math.min(100, Math.max(0, settings.autoPlaySecondChance || 0));
    if (result.move2 && Math.random() * 100 < chance) {
      if (result.score2Cp != null && result.scoreCp != null && result.scoreCp - result.score2Cp > 120) {
        return result.move;
      }
      return result.move2;
    }
    return result.move;
  }

  function scoreGapCp(result) {
    if (!result || !result.move2) return null;
    if (result.scoreMate != null || result.score2Mate != null) return null;
    if (result.scoreCp == null || result.score2Cp == null) return null;
    return Math.abs(result.scoreCp - result.score2Cp);
  }

  function sampleMood(lo, hi) {
    const span = Math.max(0.2, hi - lo);
    const r = Math.random();
    let base;
    if (r < 0.3) base = lo + span * rand(0, 0.35);
    else if (r < 0.8) base = lo + span * rand(0.3, 0.75);
    else base = lo + span * rand(0.7, 1);
    return Math.min(hi, Math.max(lo, base));
  }

  function humanThinkDelay(result) {
    const range = adaptiveDelayRange();
    const lo = range[0];
    const hi = range[1];
    // Clock pressure always applies: never lose on time, whatever the settings.
    const clockMs = readClockMs();
    if (clockMs !== null) {
      if (clockMs < 10000) return rand(0.5, 1.5);
      if (clockMs < 30000) return rand(1, 2.5);
    }
    if (!settings.naturalThink) return rand(lo, hi);
    if (!gameMood) gameMood = sampleMood(lo, hi);
    let d = gameMood * rand(0.8, 1.2);
    const gap = scoreGapCp(result);
    if (gap !== null) {
      if (gap >= 150) d *= 0.3;
      else if (gap <= 25) d *= 1.6;
      else if (gap <= 60) d *= 1.15;
    }
    return Math.min(hi, Math.max(lo, d));
  }

  function scheduleAutoPlay(result) {
    if (!settings.autoPlay || !result || !result.move) return;
    if (isAnalysisView()) return;
    if (autoMoveTimer) {
      clearTimeout(autoMoveTimer);
      autoMoveTimer = null;
    }
    const delayMs = humanThinkDelay(result) * 1000;
    autoMoveScheduled = { fen: currentFen, result };
    debugLog('auto-play scheduled in ' + (delayMs / 1000).toFixed(1) + 's: ' + result.move);
    autoMoveTimer = setTimeout(() => {
      autoMoveTimer = null;
      executeAutoMove();
    }, delayMs);
  }

  function executeAutoMove() {
    const s = autoMoveScheduled;
    autoMoveScheduled = null;
    cancelWander();
    if (!s || !settings.autoPlay) return;
    if (isGameOver()) {
      // game-over modal lingering: retry until it clears or the position changes
      if (gameOverRetries < 8) {
        gameOverRetries++;
        autoMoveScheduled = s;
        debugLog('auto-play waiting for game to end');
        autoMoveTimer = setTimeout(() => {
          autoMoveTimer = null;
          executeAutoMove();
        }, 1500);
      }
      return;
    }
    if (isAnalysisView()) return;
    gameOverRetries = 0;
    const fen = getFenFromDom();
    if (!fen || fen !== s.fen) {
      debugLog('auto-play cancelled: position changed');
      return;
    }
    if (!isMyTurn()) {
      debugLog('auto-play cancelled: not my turn');
      return;
    }
    const move = pickMoveToPlay(s.result);
    if (!move || move.length < 4) return;
    debugLog('auto-play: ' + move);
    playMoveByClicks(move);
    verifyMovePlayed(s, move);
  }

  // If the move did not register on the board (missed click, animation, modal),
  // retry the click, then re-analyze instead of stalling forever.
  function verifyMovePlayed(s, move) {
    let attempts = 0;
    const check = () => {
      if (!settings.autoPlay) return;
      if (clickPlayActive) {
        setTimeout(check, 800);
        return;
      }
      const fen = getFenFromDom();
      if (!fen || fen !== s.fen) return; // move registered
      if (isGameOver()) return;
      if (!isMyTurn()) return;
      if (attempts >= 2) {
        attempts = 0;
        debugLog('auto-play: move ' + move + ' did not register, re-analyzing');
        currentFen = null;
        update();
        return;
      }
      attempts++;
      debugLog('auto-play: move ' + move + ' did not register, retrying click');
      playMoveByClicks(move);
      setTimeout(check, 4000);
    };
    setTimeout(check, 4000);
  }

  function clickPromotion(piece) {
    const board = findBoardElement();
    if (!board) return;
    const els = queryAllInShadow(board, '.promotion-piece, [class*="promotion"] [data-piece], [class*="promotion"] [class*="piece"]');
    const target = els.find((el) => {
      const cls = typeof el.className === 'string' ? el.className : '';
      const dp = el.getAttribute && el.getAttribute('data-piece');
      return cls.indexOf(piece) >= 0 || (dp && dp.toLowerCase().indexOf(piece) >= 0);
    });
    if (!target) {
      debugLog('auto-play promotion: piece ' + piece + ' not found among ' + els.length + ' candidates, aborting');
      return;
    }
    debugLog('auto-play promotion: piece=' + piece + ' found=' + els.length + ' target=' + (!!target));
    if (!target) return;
    const r = target.getBoundingClientRect();
    if (!r || r.width <= 0) return;
    humanClick(r.left + r.width / 2 + rand(-4, 4), r.top + r.height / 2 + rand(-4, 4));
  }

  function playMoveByClicks(move) {
    const from = clientPointForSquare(move.slice(0, 2));
    const to = clientPointForSquare(move.slice(2, 4));
    if (!from || !to) return;
    const f = { x: from.x + rand(-6, 6), y: from.y + rand(-6, 6) };
    const t = { x: to.x + rand(-6, 6), y: to.y + rand(-6, 6) };
    const myGen = ++playGen;
    clickPlayActive = true;
    const finish = () => proceed(() => { clickPlayActive = false; });
    const proceed = (fn) => {
      if (myGen !== playGen) return;
      fn();
    };
    humanClick(f.x, f.y).then(() => {
      proceed(() => setTimeout(() => {
        proceed(() => humanClick(t.x, t.y).then(() => {
          const promo = move.length === 5 ? move[4] : '';
          if (promo && 'qrbn'.indexOf(promo) >= 0) {
            proceed(() => setTimeout(() => {
              proceed(() => { clickPromotion(promo); finish(); });
            }, rand(250, 450)));
          } else {
            finish();
          }
        }));
      }, rand(80, 200)));
    });
  }

  function humanClickEl(el) {
    const r = el.getBoundingClientRect();
    if (!r || r.width <= 0 || r.height <= 0) return false;
    humanClick(r.left + r.width / 2 + rand(-3, 3), r.top + r.height / 2 + rand(-3, 3));
    return true;
  }

  function findElByText(re, sel, scopeSel, within) {
    const roots = within ? [within] : (scopeSel ? queryAllInShadow(document, scopeSel) : [document]);
    for (const root of roots) {
      const els = queryAllInShadow(root, sel);
      for (const el of els) {
        try {
          if (el.getBoundingClientRect().width <= 0) continue;
        } catch (e) {}
        const t = (el.innerText || el.textContent || '').trim();
        if (re.test(t)) return el;
      }
    }
    return null;
  }

  function isLobby() {
    return location.pathname.indexOf('/play/online') === 0 || !!document.querySelector('[class*="lobby"]');
  }

  function setAutoQueue() {
    chrome.storage.local.set({ chessmateAutoQueue: { time: String(settings.autoNextTime || '10'), ts: Date.now() } });
  }

  function clearAutoQueue() {
    queueCardClicks = 0;
    queueCardClickedAt = 0;
    queuePlayClicked = false;
    chrome.storage.local.remove('chessmateAutoQueue');
  }

  function maybeStartNextGame() {
    if (!settings.autoNextGame || autoNextTimer) return;
    if (nextGameBusy && Date.now() - nextGameBusyAt < 90000) return;
    autoNextTimer = setTimeout(() => {
      autoNextTimer = null;
      doStartNextGame();
    }, rand(2500, 5000));
  }

  // One-shot guard: after the first "next game" action (rematch click or
  // queueing), do nothing until a live game actually starts (or 90s pass),
  // so the game-over screen can't re-trigger clicking every few seconds.
  function armNextGame() {
    if (nextGameBusy) return false;
    nextGameBusy = true;
    nextGameBusyAt = Date.now();
    return true;
  }

  function doStartNextGame() {
    if (!settings.autoNextGame || !isGameOver()) return;
    if (nextGameBusy && Date.now() - nextGameBusyAt < 90000) return;
    const rematch = findElByText(/play again|rematch/i, 'button, [role="button"], [class*="game-over"] button');
    if (rematch) {
      if (!armNextGame()) return;
      debugLog('auto-next: rematch clicked');
      humanClickEl(rematch);
      return;
    }
    if (!armNextGame()) return;
    debugLog('auto-next: no rematch, queueing a new game');
    queueCardClicks = 0;
    queueCardClickedAt = 0;
    queuePlayClicked = false;
    setAutoQueue();
    if (isLobby()) {
      doLobbyQueue();
    } else {
      location.href = 'https://www.chess.com/play/online';
    }
  }

  // A card is "selected" when chess.com marks it active. Only click a card
  // when it isn't selected, at most twice per queue session, so the mouse
  // never spams the same button while the page is slow.
  function isActiveEl(el) {
    const cls = typeof el.className === 'string' ? el.className : '';
    return /active|selected|checked/i.test(cls) ||
      el.getAttribute('aria-selected') === 'true' ||
      el.getAttribute('aria-pressed') === 'true';
  }

  function doLobbyQueue() {
    const time = String(settings.autoNextTime || '10');
    const safe = time.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const findCard = () => findElByText(new RegExp('^\\s*' + safe + '\\s*min', 'i'),
      'button, [role="button"], [class*="preset"], [class*="time-control"], [class*="time-select"]');
    const findPlay = () => {
      const scopes = queryAllInShadow(document,
        '[class*="modal"], [class*="dialog"], [class*="new-game"], [class*="game-setup"], [class*="lobby"], [class*="match"], [class*="create-challenge"], main');
      for (const scope of scopes) {
        const nav = scope.closest && scope.closest('nav, header, [class*="navigation"], [class*="header"], [class*="menu"]');
        if (nav) continue;
        const btn = findElByText(/^\s*play\s*$/i, 'button, [role="button"]', null, scope);
        if (btn) return btn;
      }
      return null;
    };
    const tryPlay = (attempt) => {
      if (!settings.autoNextGame) return clearAutoQueue();
      if (queuePlayClicked) return;
      const card = findCard();
      if (card && !isActiveEl(card)) {
        if (queueCardClicks < 2 && Date.now() - queueCardClickedAt > 5000) {
          queueCardClicks++;
          queueCardClickedAt = Date.now();
          debugLog('auto-next: time control ' + time + ' min clicked');
          humanClickEl(card);
        }
      } else if (card) {
        queueCardClicks = 2;
      }
      setTimeout(() => {
        if (queuePlayClicked) return;
        const play = findPlay();
        if (play) {
          queuePlayClicked = true;
          debugLog('auto-next: play clicked');
          humanClickEl(play);
          setTimeout(() => { queueCardClicks = 0; queuePlayClicked = false; clearAutoQueue(); }, 3000);
          return;
        }
        if (attempt < 3) setTimeout(() => tryPlay(attempt + 1), 2500);
        else clearAutoQueue();
      }, rand(500, 1100));
    };
    tryPlay(0);
  }

  function handleAutoQueueIntent() {
    chrome.storage.local.get('chessmateAutoQueue', (r) => {
      const q = r && r.chessmateAutoQueue;
      if (!q) return;
      if (!settings.autoNextGame) return clearAutoQueue();
      if (Date.now() - q.ts > 120000) return clearAutoQueue();
      if (isLobby()) return doLobbyQueue();
      if (isLiveView()) {
        queueCardClicks = 0;
        queuePlayClicked = false;
        nextGameBusy = false;
        if (isGameOver()) maybeStartNextGame();
        else clearAutoQueue();
      }
    });
  }

  function boot() {
    update();
    setupObservers();
    setupStealthListeners();
    startWanderLoop();
    handleAutoQueueIntent();
    setInterval(() => {
      update();
      if (isGameOver()) maybeStartNextGame();
      handleAutoQueueIntent();
    }, 4000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  if (window.__CHESSMATE_TEST__) {
    window.__chessmate = {
      humanThinkDelay,
      readClockMs,
      pickMoveToPlay,
      scoreGapCp,
      detectTimeControl,
      adaptiveDelayRange,
      engineTimeMs,
      resetTimeControl,
      startWanderLoop,
      cancelWander,
      doWander,
      doStartNextGame,
      doLobbyQueue,
      handleAutoQueueIntent,
      maybeStartNextGame,
      resetMood: () => { gameMood = null; },
      getSettings: () => ({ ...settings }),
      sanitizeSettings
    };
  }
})();
