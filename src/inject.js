// ChessMate main-world bridge (lichess.org).
// Runs in the page's MAIN world (manifest "world": "MAIN") so it can read
// lichess's own controllers (round / analysis / puzzle), which are
// invisible from the isolated content-script world. Forwards the exact FEN
// (castling + en-passant rights included), my color and game-over state to
// the content script via postMessage — no DOM guessing, no heuristics.
(() => {
  const SOURCE = 'chessmate-inject';
  const TYPE = 'chessmate:state';

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

  function readFen() {
    const L = window.lichess;
    if (!L) return null;

    // live games / watched games: round controller keeps data.fen current
    const round = L.round && L.round.data;
    if (round) {
      if (round.fen && isValidFen(round.fen)) return { fen: round.fen.trim(), src: 'round' };
      const steps = round.steps;
      if (steps && steps.length) {
        const last = steps[steps.length - 1];
        if (last && last.fen && isValidFen(last.fen)) return { fen: last.fen.trim(), src: 'round-steps' };
      }
    }

    // analysis board (incl. browsing moves): node.fen is the shown position
    const analysis = L.analysis;
    if (analysis && analysis.node && analysis.node.fen && isValidFen(analysis.node.fen)) {
      return { fen: analysis.node.fen.trim(), src: 'analysis' };
    }

    // puzzles
    const puzzle = L.puzzle && L.puzzle.vm && L.puzzle.vm.node;
    if (puzzle && puzzle.fen && isValidFen(puzzle.fen)) {
      return { fen: puzzle.fen.trim(), src: 'puzzle' };
    }

    // studies (best effort — structure varies)
    const study = L.study && L.study.vm && L.study.vm.chapter;
    if (study && study.fen && isValidFen(study.fen)) {
      return { fen: study.fen.trim(), src: 'study' };
    }

    return null;
  }

  function readMeta() {
    const L = window.lichess;
    let myColor = null;
    let gameOver = null;
    if (L && L.round && L.round.data) {
      const d = L.round.data;
      const p = d.player;
      if (p && p.color) myColor = p.color === 'black' ? 'b' : 'w';
      const st = d.game && d.game.status;
      if (st) gameOver = st.id !== 'started';
    }
    return { myColor, gameOver };
  }

  let lastKey = null;

  function readAndDispatch() {
    const r = readFen();
    const meta = readMeta();
    const fen = r ? r.fen : null;
    const key = fen + '|' + meta.myColor + '|' + meta.gameOver;
    if (key === lastKey) return;
    lastKey = key;
    window.postMessage({ source: SOURCE, type: TYPE, fen, src: r ? r.src : null, myColor: meta.myColor, gameOver: meta.gameOver }, '*');
  }

  // slow safety-net poll (controllers load async)
  function loop() {
    readAndDispatch();
    setTimeout(loop, 500);
  }
  setTimeout(loop, 300);

  // instant re-read when the board mutates (moves, browsing analysis)
  function watchBoard() {
    const board = document.querySelector('.main-board, cg-board, .cg-wrap');
    if (!board) {
      setTimeout(watchBoard, 1000);
      return;
    }
    try {
      const obs = new MutationObserver(() => readAndDispatch());
      obs.observe(board, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style']
      });
    } catch (e) {}
  }
  watchBoard();
})();
