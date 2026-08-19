// Verify src/inject.js posts chessmate:state from simulated lichess controllers.
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const INJECT = fs.readFileSync(path.resolve(__dirname, '../src/inject.js'), 'utf8');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/opt/brave-bin/brave',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.goto('file://' + path.resolve(__dirname, 'harness.html'));

  const states = [];
  await page.evaluate((src) => {
    window.__states = [];
    window.addEventListener('message', (e) => {
      const d = e.data;
      if (d && d.source === 'chessmate-inject' && d.type === 'chessmate:state') window.__states.push(d);
    });
    // simulate lichess round state: live game, black player, status started
    window.lichess = {
      round: {
        data: {
          fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 0 3',
          player: { color: 'black' },
          game: { status: { id: 'started' } },
          steps: []
        }
      }
    };
    // eslint-disable-next-line no-eval
    (0, eval)(src);
  }, INJECT);

  await new Promise((r) => setTimeout(r, 1200));
  const got = await page.evaluate(() => window.__states);
  console.log('messages:', got.length);
  console.log(JSON.stringify(got[got.length - 1], null, 2));

  // now simulate analysis view: no round, lichess.analysis instead
  await page.evaluate(() => {
    window.__states = [];
    window.lichess = {
      analysis: { node: { fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1' } }
    };
  });
  await new Promise((r) => setTimeout(r, 700));
  const got2 = await page.evaluate(() => window.__states);
  console.log('analysis messages:', got2.length);
  console.log(JSON.stringify(got2[got2.length - 1], null, 2));

  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('ERROR:', e); process.exit(1); });
