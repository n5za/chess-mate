const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function engine() {
  const sent = [], workers = [], timers = new Map();
  let listener, serial = 0;
  const ctx = vm.createContext({ console, Map,
    setTimeout: fn => { timers.set(++serial, fn); return serial; },
    clearTimeout: id => timers.delete(id),
    Worker: class {
      constructor() { this.commands = []; workers.push(this); }
      postMessage(cmd) { this.commands.push(cmd); }
      terminate() { this.terminated = true; }
      emit(data) { this.onmessage({ data }); }
    },
    chrome: { runtime: {
      sendMessage: msg => { sent.push(msg); return Promise.resolve(); },
      onMessage: { addListener: fn => { listener = fn; } }
    } }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/offscreen.js'), 'utf8'), ctx);
  return { sent, workers, timers, send: msg => listener(msg, {}, () => {}) };
}
const request = (id, extra = {}) => ({ action: 'chessmate-engine-analyze', requestId: id,
  fen: '8/8/8/8/8/4k3/8/4K3 w - - 0 1', movetime: 3000, ...extra });
test('waits for readyok; Elo uses actual bestmove, not strongest PV', () => {
  const e = engine(), w = e.workers[0];
  e.send(request('a', { strengthMode: 'elo', targetElo: 1600 }));
  w.emit('uciok');
  assert.ok(!w.commands.some(x => x.startsWith('go ')));
  w.emit('readyok');
  assert.ok(w.commands.includes('setoption name UCI_LimitStrength value true'));
  assert.ok(w.commands.includes('setoption name UCI_Elo value 1600'));
  w.emit('info depth 12 multipv 1 score cp 40 pv e1d1 e3d3');
  w.emit('info depth 12 multipv 3 score cp -25 pv e1f1 e3d3');
  w.emit('bestmove e1f1');
  assert.equal(e.sent[0].result.move, 'e1f1');
  assert.equal(e.sent[0].result.scoreCp, -25);
  assert.equal(e.sent[0].result.strengthLimited, true);
  e.send(request('b'));
  assert.ok(w.commands.includes('setoption name UCI_LimitStrength value false'));
});
test('bestmove without a matching PV has no fabricated score; mate returns null', () => {
  const e = engine(), w = e.workers[0]; w.emit('readyok');
  e.send(request('a')); w.emit('bestmove e1d1');
  assert.equal(e.sent[0].result.move, 'e1d1');
  assert.equal(e.sent[0].result.scoreCp, null);
  e.send(request('b')); w.emit('bestmove (none)');
  assert.equal(e.sent[1].result, null);
});
test('duplicate retries do not stop searches; replaced requests complete once', () => {
  const e = engine(), w = e.workers[0]; w.emit('readyok');
  e.send(request('a')); e.send(request('a'));
  assert.ok(!w.commands.includes('stop'));
  e.send(request('b')); e.send(request('c'));
  assert.equal(e.sent[0].requestId, 'b');
  w.emit('bestmove e1d1');
  assert.equal(e.sent[1].requestId, 'a');
  assert.equal(e.sent[1].result, null);
  w.emit('bestmove e1f1');
  assert.equal(e.sent[2].requestId, 'c');
});
test('reset terminates worker and starts a fresh handshake', () => {
  const e = engine(), w = e.workers[0]; w.emit('readyok'); e.send(request('a'));
  e.send({ action: 'chessmate-offscreen-reset' });
  assert.equal(w.terminated, true);
  assert.equal(e.workers.length, 2);
  assert.equal(e.sent[0].result, null);
  e.send(request('b')); e.workers[1].emit('readyok');
  assert.ok(e.workers[1].commands.some(x => x.startsWith('go ')));
});
test('routing isolates identical content request IDs across tabs', async () => {
  let listener;
  const sent = [], delivered = [];
  const ctx = vm.createContext({ console, Map, Date, setTimeout, clearTimeout,
    chrome: {
      offscreen: { hasDocument: async () => true },
      runtime: {
        sendMessage: (m, cb) => { sent.push(m); if (cb) cb({ pong: true }); return Promise.resolve(); },
        onMessage: { addListener: f => { listener = f; } },
        onStartup: { addListener() {} }
      },
      tabs: { sendMessage: async (id, msg) => { delivered.push({ id, msg }); } },
      commands: { onCommand: { addListener() {} } }
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/background.js'), 'utf8'), ctx);
  await Promise.all([1, 2].map(id => new Promise(resolve => listener({ action: 'chessmate-analyze', requestId: 1 }, { tab: { id } }, resolve))));
  const requests = sent.filter(m => m.action === 'chessmate-engine-analyze');
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0].requestId, requests[1].requestId);
  for (const req of requests) listener({ action: 'chessmate-bestmove', requestId: req.requestId }, {}, () => {});
  assert.deepEqual(delivered.map(x => x.id), [1, 2]);
  assert.ok(delivered.every(x => x.msg.requestId === 1));
});
