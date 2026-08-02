// Content-script suite: exercises the ChessMate logic hooks against a fake
// chess.com page. Run with: xvfb-run -a node test-content.js
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.resolve(__dirname, '../src/content.js'), 'utf8');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/opt/brave-bin/brave',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });

  const results = [];

  async function test(name, bodyHtml, run, store) {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 200)));
    await page.goto('file://' + path.resolve(__dirname, 'harness.html'));
    const chromeMock = `
      window.__sent = [];
      window.__store = ${JSON.stringify(store || {})};
      window.chrome = {
        storage: {
          local: {
            get: (d, cb) => {
              const out = {};
              if (d === null) { Object.assign(out, window.__store); }
              else if (typeof d === 'string') { if (d in window.__store) out[d] = window.__store[d]; }
              else if (Array.isArray(d)) { for (const k of d) if (k in window.__store) out[k] = window.__store[k]; }
              else { for (const k of Object.keys(d)) if (k in window.__store) out[k] = window.__store[k]; }
              cb(out);
            },
            set: (o, cb) => { Object.assign(window.__store, o); if (cb) cb(); },
            remove: (k, cb) => { if (cb) cb(); }
          },
          sync: { get: (d, cb) => cb({}), set: (o, cb) => { if (cb) cb(); }, remove: (k, cb) => { if (cb) cb(); } },
          onChanged: { addListener: () => {} }
        },
        runtime: { sendMessage: (m) => { window.__sent.push(m); }, onMessage: { addListener: () => {} } }
      };
    `;
    await page.evaluate(() => { window.__CHESSMATE_TEST__ = true; });
    await page.evaluate(chromeMock);
    try {
      await page.evaluate(SRC);
    } catch (e) {
      console.log('FAIL: ' + name + ' (content.js crashed: ' + String(e).slice(0, 150) + ')');
      results.push(false);
      await page.close();
      return;
    }
    if (bodyHtml) await page.evaluate(bodyHtml);
    const out = await page.evaluate(run);
    const pass = !!out.ok;
    console.log((pass ? 'PASS' : 'FAIL') + ': ' + name);
    if (!pass) console.log('     got:', JSON.stringify(out.detail || out));
    results.push(pass);
    await page.close();
  }

  // 1. detectTimeControl from the game header
  await test('detectTimeControl: reads "10 min" from the game header', () => {
    const h = document.createElement('div');
    h.className = 'game-header';
    h.textContent = 'GAME - 10 min';
    document.body.appendChild(h);
  }, () => ({ ok: window.__chessmate.detectTimeControl() === 10 }));

  // 2. header takes priority over decoy page text
  await test('detectTimeControl: header "1 | 0" beats decoy "60 min" in page text', () => {
    const h = document.createElement('div');
    h.className = 'game-header';
    h.textContent = '1 | 0';
    document.body.appendChild(h);
    const d = document.createElement('div');
    d.textContent = 'Daily puzzle resets in 60 min';
    document.body.appendChild(d);
  }, () => ({ ok: window.__chessmate.detectTimeControl() === 1 }));

  // 3. body-text fallback only
  await test('detectTimeControl: body-text fallback "15 min"', () => {
    const d = document.createElement('div');
    d.textContent = 'Play 15 min games here';
    document.body.appendChild(d);
  }, () => ({ ok: window.__chessmate.detectTimeControl() === 15 }));

  // 4. reset clears the cache
  await test('detectTimeControl: reset clears the cache', () => {
    const h = document.createElement('div');
    h.className = 'game-header';
    h.textContent = '5 min';
    document.body.appendChild(h);
  }, () => {
    window.__chessmate.detectTimeControl();
    window.__chessmate.resetTimeControl();
    return { ok: window.__chessmate.detectTimeControl() === 5 };
  });

  // 5. adaptive delay ranges per time control
  await test('adaptiveDelayRange: 1 min -> [1,2]s, 10 min -> [3,15]s', () => {
    const h = document.createElement('div');
    h.className = 'game-header';
    h.textContent = '1 min';
    document.body.appendChild(h);
  }, () => {
    const r1 = window.__chessmate.adaptiveDelayRange();
    window.__chessmate.resetTimeControl();
    document.body.innerHTML = '';
    const h = document.createElement('div');
    h.className = 'game-header';
    h.textContent = '10 min';
    document.body.appendChild(h);
    const r10 = window.__chessmate.adaptiveDelayRange();
    return {
      ok: r1[0] === 1 && r1[1] === 2 && r10[0] === 3 && r10[1] === 15,
      detail: { r1, r10 }
    };
  });

  // 6. engine time cap for fast games
  await test('engineTimeMs: 1 min caps the engine time', () => {
    const h = document.createElement('div');
    h.className = 'game-header';
    h.textContent = '1 min';
    document.body.appendChild(h);
  }, () => ({ ok: window.__chessmate.engineTimeMs() <= 800 }));

  // 7. clock pressure applies even with naturalThink off
  await test('humanThinkDelay: clock <10s forces 0.5-1.5s even when naturalThink is off', () => {
    const clock = document.createElement('div');
    clock.className = 'clock-bottom';
    clock.textContent = '00:05';
    document.body.appendChild(clock);
  }, () => {
    let ok = true;
    for (let i = 0; i < 20; i++) {
      const d = window.__chessmate.humanThinkDelay({ move: 'e2e4', scoreCp: 30 });
      if (d < 0.4 || d > 1.6) ok = false;
    }
    return { ok };
  });

  // 7b. all time-control buckets: 1/3/5/10 min -> delay range + engine cap
  await test('time-control buckets: 1, 3, 5, 10 min each get their own delay range and engine cap', null, () => {
    const setControl = (t) => {
      window.__chessmate.resetTimeControl();
      document.body.innerHTML = '';
      const h = document.createElement('div');
      h.className = 'game-header';
      h.textContent = t;
      document.body.appendChild(h);
    };
    const results = {};
    const expectations = { 1: [1, 2], 3: [1.5, 4], 5: [2, 7], 10: [3, 15] };
    const caps = { 1: 800, 3: 1500, 5: 2000, 10: null };
    for (const [min, exp] of Object.entries(expectations)) {
      setControl(min + ' min');
      const r = window.__chessmate.adaptiveDelayRange();
      const t = window.__chessmate.engineTimeMs();
      results[min] = { range: r, engine: t };
      const okRange = r[0] === exp[0] && r[1] === exp[1];
      const okEngine = caps[min] === null ? t === 5000 : t <= caps[min];
      if (!okRange || !okEngine) return { ok: false, detail: results };
    }
    return { ok: true, detail: results };
  }, { liveMovetime: 5000 });

  // 8. pickMoveToPlay: with 100% second-chance, gap <= 120 picks move2; gap > 120 keeps move
  await test('pickMoveToPlay: 2nd move when gap <= 120, 1st when gap > 120', null, () => ({
    ok: window.__chessmate.pickMoveToPlay({ move: 'e2e4', scoreCp: 100, move2: 'e2e3', score2Cp: 0 }) === 'e2e3' &&
      window.__chessmate.pickMoveToPlay({ move: 'e2e4', scoreCp: 200, move2: 'e2e3', score2Cp: 0 }) === 'e2e4'
  }), { autoPlaySecondChance: 100 });

  // 9. scoreGapCp
  await test('scoreGapCp: returns the gap, null on mate lines', null, () => ({
    ok: window.__chessmate.scoreGapCp({ move: 'a', scoreCp: 100, move2: 'b', score2Cp: 40 }) === 60 &&
      window.__chessmate.scoreGapCp({ move: 'a', scoreMate: 2, move2: 'b', score2Mate: 3 }) === null
  }));

  // 10. settings: old flat keys migrate into the single key, values clamp
  await test('settings: flat keys migrate into chessmateSettings and clamp', null, () => ({
    ok: window.__chessmate.getSettings().depth === 30 &&
      window.__chessmate.getSettings().movetime === 100 &&
      window.__chessmate.getSettings().mode === 'both' &&
      window.__chessmate.getSettings().speed === 'fast' &&
      window.__chessmate.getSettings().autoPlaySecondChance === 100 &&
      window.__store.chessmateSettings !== undefined
  }), { depth: 99, movetime: -5, speed: 'fast', autoPlaySecondChance: 1000 });

  // 11. settings: single-key storage loads as-is with sanitization
  await test('settings: single-key object loads, out-of-range values clamped', null, () => ({
    ok: window.__chessmate.getSettings().depth === 30 &&
      window.__chessmate.getSettings().delayMax === 0 &&
      window.__chessmate.getSettings().autoPlaySecondChance === 25
  }), { chessmateSettings: { autoPlay: true, depth: 999, delayMax: -3, autoPlaySecondChance: 25 } });

  // 12. settings: empty storage falls back to defaults
  await test('settings: empty storage -> defaults', null, () => {
    const s = window.__chessmate.getSettings();
    return { ok: s.depth === 18 && s.enabled === true && s.speed === 'auto' && s.mode === 'both' };
  });

  // 14. auto-next one-shot guard: while the game-over screen lingers, repeated
  // doStartNextGame calls must not re-click (no endless re-queue loop)
  await test('auto-next: one-shot guard, no re-arm while game-over lingers', () => {
    window.__clicks = [];
    document.addEventListener('click', (e) => {
      if (e.target && e.target.__marker) window.__clicks.push(e.target.__marker);
    }, true);
    const go = document.createElement('div');
    go.className = 'game-over-modal';
    const lobby = document.createElement('div');
    lobby.className = 'lobby-container';
    const card = document.createElement('button');
    card.className = 'time-control';
    card.textContent = '10 min';
    card.style.cssText = 'position:fixed;left:100px;top:100px;width:60px;height:30px';
    card.__marker = 'card';
    const play = document.createElement('button');
    play.textContent = 'Play';
    play.style.cssText = 'position:fixed;left:200px;top:200px;width:60px;height:30px';
    play.__marker = 'play';
    lobby.appendChild(card);
    lobby.appendChild(play);
    document.body.appendChild(go);
    document.body.appendChild(lobby);
  }, () => new Promise((resolve) => {
    window.__chessmate.doStartNextGame();
    window.__chessmate.doStartNextGame();
    window.__chessmate.doStartNextGame();
    window.__chessmate.doStartNextGame();
    setTimeout(() => {
      const clicks = window.__clicks;
      resolve({
        ok: clicks.filter((c) => c === 'card').length === 1 &&
          clicks.filter((c) => c === 'play').length === 1,
        detail: { clicks }
      });
    }, 5000);
  }), { chessmateSettings: { autoNextGame: true, autoNextTime: '10' } });

  // 13. auto-next lobby queue: the time card is clicked at most once even when
  // doLobbyQueue is re-entered repeatedly, then Play once, no spam
  await test('lobby queue: 10 min card clicked once, not spammed on re-entry', () => {
    window.__clicks = [];
    document.addEventListener('click', (e) => {
      const el = e.target;
      if (el && el.__marker) window.__clicks.push(el.__marker);
    }, true);
    const lobby = document.createElement('div');
    lobby.className = 'lobby-container';
    const card = document.createElement('button');
    card.className = 'time-control';
    card.textContent = '10 min';
    card.style.position = 'fixed';
    card.style.left = '100px';
    card.style.top = '100px';
    card.style.width = '60px';
    card.style.height = '30px';
    card.__marker = 'card';
    const play = document.createElement('button');
    play.textContent = 'Play';
    play.style.position = 'fixed';
    play.style.left = '200px';
    play.style.top = '200px';
    play.style.width = '60px';
    play.style.height = '30px';
    play.__marker = 'play';
    lobby.appendChild(card);
    lobby.appendChild(play);
    document.body.appendChild(lobby);
  }, () => new Promise((resolve) => {
    window.__chessmate.doLobbyQueue();
    window.__chessmate.doLobbyQueue();
    window.__chessmate.doLobbyQueue();
    setTimeout(() => {
      const clicks = window.__clicks;
      const cardClicks = clicks.filter((c) => c === 'card').length;
      const playClicks = clicks.filter((c) => c === 'play').length;
      resolve({
        ok: cardClicks === 1 && playClicks === 1,
        detail: { clicks }
      });
    }, 4500);
  }), { chessmateSettings: { autoNextGame: true, autoNextTime: '10' }, chessmateAutoQueue: { time: '10', ts: Date.now() } });

  const passCount = results.filter(Boolean).length;
  console.log('\n==== CONTENT RESULT: ' + passCount + ' passed, ' + (results.length - passCount) + ' failed ====');
  await browser.close();
  process.exit(passCount === results.length ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
