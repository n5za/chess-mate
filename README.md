# ChessMate — Best Move for chess.com
src/img&videa/Pasted image.png
Chrome/Edge extension (Manifest V3) that shows the best move on chess.com
using local Stockfish. Works on live games and analysis. No internet needed
for the engine — Stockfish runs entirely on your device.

> Warning: using engine assistance in rated online play violates
> chess.com Terms of Service and can get your account banned. This tool
> is meant for analysis and learning. Use at your own risk.

## Demo

![Screenshot](src/img%26videa/Pasted%20image.png)

## Install

1. Open `chrome://extensions` (or `edge://extensions`)
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the `chessmate` folder
4. Open chess.com — arrows appear automatically

## How it works

```
chess.com page
    │  content.js: reads board FEN from DOM, draws arrow overlay
    ▼
background.js: routes requests, keeps offscreen document alive
    ▼
offscreen.html + offscreen.js: runs Stockfish (Web Worker + WASM)
```

- **FEN extraction**: `data-fen` attribute → web component `game` object →
  piece DOM (`div.piece` with `square-NN` classes + `data-piece` attribute)
  → turn from running clock (`clock-player-turn`) or move list. Pieces are
  searched through **shadow DOM** too — live 1v1 games render the board
  inside a `chess-board` shadow root, bot games use light DOM.
- **Orientation**: `orientation` attribute → `flipped` class → geometric
  vote on piece positions (works even when `a1` is empty)
- **Engine**: `stockfish-18-lite-single` (single-threaded WASM, ~7 MB,
  GPLv3). Command: `go depth N movetime M`, result: bestmove + score
- **Overlay**: fixed SVG layer with arrow + eval badge, tracks board
  position and size, respects flipped boards
- **Live play**: only shows the move when it's your turn (optional)
- **Stale results**: request-id based, results are dropped if the position
  changed while the engine was thinking

## Stealth protocol (anti-detection)

Reduces the chance of being flagged by chess.com Fair Play. None of this is
a guarantee — engine use in rated play always carries risk.

- **Hide mode** — `always` (default) / `only while holding Alt` / `only
  while mouse is over the board`. Alt and hover modes keep the screen
  clean for streams/screenshares: hold `Alt` or hover the board to peek.
- **Think delay** — random delay (0–8 s, min–max range) before the arrow
  appears in live games, so your reaction time looks human. Off by
  default; ignored in analysis view.
- **Your-turn only** — in live games the arrow never appears on the
  opponent's turn (and analysis stops running).
- **Instant hide** — press `Alt+Shift+S` anywhere on chess.com to toggle
  the arrows on/off immediately (useful if someone enters the room).
- **Blur safety** — the arrow hides automatically when the window loses
  focus.

## Settings (popup)

| Setting         | Default | Description                          |
|-----------------|---------|--------------------------------------|
| Master switch   | on      | Enable/disable arrows                |
| Mode            | both    | Live + Analysis / Live only / Analysis only |
| Depth           | 16      | Engine search depth (8–24)           |
| Analysis time   | 2.5s    | Max search time in analysis view     |
| Live time       | 1.5s    | Max search time in live play         |
| Show arrows     | always  | Always / while holding Alt / on hover |
| Think delay     | 0–0s    | Random delay before showing in live  |
| Only your turn  | on      | In live games, hide on opponent's turn |
| Show eval       | on      | Score badge next to the arrow        |

## Demo video

<video controls width="100%">
  <source src="src/img%26videa/20260731_224051.mp4" type="video/mp4">
</video>

## Files

```
chessmate/
├── manifest.json              MV3 manifest
├── src/
│   ├── content.js             FEN extraction + arrow overlay
│   ├── background.js          Message router + offscreen lifecycle
│   ├── offscreen.html/.js     Stockfish worker host
│   ├── engine/                Stockfish 18 lite (GPLv3)
│   └── popup/                 Settings UI
```

## Test

Engine + routing and content-script logic are covered by automated tests
run against Chrome for Testing:

```
node /tmp/opencode/test-e2e.js          # engine E2E (offscreen worker)
node /tmp/opencode/domtest/test-content.js  # FEN + overlay logic
```
