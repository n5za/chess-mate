# ChessMate — Best Move for chess.com and lichess.org
Chrome/Edge extension (Manifest V3) that shows the best move on chess.com
**and lichess.org** using local Stockfish. Works on live games, analysis,
studies and puzzles. No internet needed for the engine — Stockfish runs
entirely on your device.

> Warning: using engine assistance in rated online play violates
> chess.com Terms of Service and can get your account banned. This tool
> is meant for analysis and learning. Use at your own risk.

## Demo

![Screenshot](src/img-videa/Pasted%20image.png)

## Install

1. Open `chrome://extensions` (or `edge://extensions`)
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the `chessmate` folder
4. Open chess.com or lichess.org — arrows appear automatically

## How it works

```
chess.com / lichess.org page
    │  content.js: reads board FEN from DOM, draws arrow overlay
    ▼
background.js: routes requests, keeps offscreen document alive
    ▼
offscreen.html + offscreen.js: runs Stockfish (Web Worker + WASM)
```

- **chess.com FEN extraction**: `data-fen` attribute → web component `game`
  object → piece DOM (`div.piece` with `square-NN` classes + `data-piece`
  attribute) → turn from running clock (`clock-player-turn`) or move list.
  Pieces are searched through **shadow DOM** too — live 1v1 games render
  the board inside a `chess-board` shadow root, bot games use light DOM.
- **lichess FEN extraction**: main-world bridge (`src/inject.js` reads
  lichess's own round/analysis/puzzle/study state and posts the exact FEN,
  your color and game-over flag) → `/analysis/<FEN>` URL (initial position)
  → chessground piece DOM (`<piece data-role/data-color>` or `white king`
  classes + `transform: translate(x%, y%)` coordinates, orientation
  independent) → turn from the running clock (`clock-running` top/bottom)
  or the `.tview2` move list. Works on live games, analysis, studies and
  puzzles.
- **Lightweight**: in background tabs the extension does zero work
  (analysis pauses, retries wait); observers watch only the board area,
  not the whole page; engine retries are faster and capped.
- **Orientation**: `orientation` attribute → `flipped` class →
  `cg-wrap.orientation-black` (lichess) → geometric vote on piece positions
  (works even when `a1` is empty)
- **Engine**: `stockfish-18-lite-single` (single-threaded WASM, ~7 MB,
  GPLv3). Command: `go depth N movetime M`, result: bestmove + score
- **Overlay**: fixed SVG layer with arrow + eval badge, tracks board
  position and size, respects flipped boards
- **Live play**: only shows the move when it's your turn (optional)
- **Stale results**: request-id based, results are dropped if the position
  changed while the engine was thinking

## Fast search

Quick arrows is enabled by default and caps engine thinking at **200 ms** in
both live and analysis views. Board changes are coalesced over 16 ms and the
arrow renders immediately on the result, bypassing the display delay. It does
not change automatic move delays or
mouse movement speed. Disable it in the popup to use the time sliders again.
Startup, board detection and rendering add latency, so total response time is
not guaranteed below 0.5 seconds. Short searches can reduce accuracy and Elo
consistency.

## Target Elo (v1.3)

Choose **Playing strength → Target Elo** in the popup, then set **1320–3190**.
This is the range advertised by the bundled Stockfish engine. ChessMate enables
Stockfish's native `UCI_LimitStrength` and `UCI_Elo` options and uses its final
`bestmove`, including weaker choices. Full engine strength remains available.
The old random second-choice setting is disabled in Elo mode so it cannot
silently override the engine's strength selection.

The number is an approximate engine rating, not a calibrated chess.com or
lichess rating or a guarantee of human behavior. Search time, hardware and
positions affect strength. Use it as a training setting.

This release also fixes request collisions between tabs, premature search
retries, engine reset/recovery, readiness checks and stale results after
settings changes. The popup includes save feedback and keyboard focus styles.

## Settings (popup)

| Setting         | Default | Description                          |
|-----------------|---------|--------------------------------------|
| Master switch   | on      | Enable/disable arrows                |
| Mode            | both    | Live + Analysis / Live only / Analysis only |
| Playing strength | Full | Full engine or target Elo (1320–3190) |
| Depth           | 22      | Engine search depth (8–24)           |
| Analysis time   | 3s    | Max search time in analysis view     |
| Live time       | 3s    | Max search time in live play         |
| Show arrows     | always  | Always / while holding Alt / on hover |
| Think delay     | 0–0s    | Random delay before showing in live  |
| Only your turn  | on      | In live games, hide on opponent's turn |
| Show eval       | on      | Score badge next to the arrow        |

## Demo video

![Demo video](src/img-videa/20260731_224051.gif)

[Watch the original MP4 (with sound)](https://github.com/n5za/chess-mate/blob/main/src/img-videa/20260731_224051.mp4)

## Files

```
chessmate/
├── manifest.json              MV3 manifest
├── src/
│   ├── content.js             FEN extraction + arrow overlay
│   ├── inject.js              lichess main-world bridge (exact FEN/color/status)
│   ├── background.js          Message router + offscreen lifecycle
│   ├── offscreen.html/.js     Stockfish worker host
│   ├── engine/                Stockfish 18 lite (GPLv3)
│   └── popup/                 Settings UI
├── tests/
│   └── test-content.js        content-script logic tests (node test-content.js)
```

## Test

Engine + routing and content-script logic are covered by automated tests
run against Chrome for Testing:

```
cd tests && npm ci
node test-engine.js                  # engine lifecycle and routing regressions
node test-content.js       # content-script logic (lichess + chess.com)
```
