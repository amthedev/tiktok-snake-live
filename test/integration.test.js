// End-to-end integration test: boots the real server on a random port, talks WebSocket + HTTP
// exactly like the overlay and the control panel do, and checks the contract in docs/SPEC.md §6.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4300 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'snake-live-'));

let server;

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server/index.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), DATA_DIR, AUTO_CONNECT: 'false', TIKTOK_USERNAME: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const onData = (b) => { out += b.toString(); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { if (!child.ready) reject(new Error(`server exited early (${code}):\n${out}`)); });
    const started = Date.now();
    (async function poll() {
      while (Date.now() - started < 15000) {
        try {
          const r = await fetch(`${BASE}/api/status`);
          if (r.ok) { child.ready = true; return resolve(child); }
        } catch {}
        await new Promise(r => setTimeout(r, 150));
      }
      reject(new Error(`server did not answer /api/status in time:\n${out}`));
    })();
  });
}

function connectWs() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const inbox = [];
    const waiters = [];
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      inbox.push(msg);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].pred(msg)) { const w = waiters.splice(i, 1)[0]; clearTimeout(w.t); w.resolve(msg); }
      }
    });
    ws.on('error', reject);
    ws.on('open', () => resolve({
      ws, inbox,
      next(pred, ms = 4000) {
        const hit = inbox.find(pred);
        if (hit) return Promise.resolve(hit);
        return new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error(`timeout waiting for message; got types: ${inbox.map(m => m.type).join(',')}`)), ms);
          waiters.push({ pred, resolve: res, t });
        });
      },
      send(obj) { ws.send(JSON.stringify({ ts: Date.now(), ...obj })); },
      close() { ws.close(); },
    }));
  });
}

async function post(url, body) {
  const r = await fetch(BASE + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

before(async () => { server = await startServer(); });
after(() => { if (server) server.kill('SIGTERM'); });

test('static routes: overlay, panel and three.js are served', async () => {
  const idx = await fetch(`${BASE}/`);
  assert.equal(idx.status, 200);
  assert.match(await idx.text(), /<script type="importmap">/);
  const panel = await fetch(`${BASE}/painel`);
  assert.equal(panel.status, 200);
  const three = await fetch(`${BASE}/vendor/three/build/three.module.js`);
  assert.equal(three.status, 200);
  assert.match(three.headers.get('content-type') || '', /javascript/);
  const addon = await fetch(`${BASE}/vendor/three/examples/jsm/postprocessing/UnrealBloomPass.js`);
  assert.equal(addon.status, 200);
});

test('ws hello carries config, stats, leaderboard, tiktok status and rules', async () => {
  const c = await connectWs();
  const hello = await c.next(m => m.type === 'hello');
  assert.ok(hello.stats && typeof hello.stats.wins === 'number');
  assert.ok(hello.leaderboard && Array.isArray(hello.leaderboard.top));
  assert.ok(hello.tiktok && typeof hello.tiktok.status === 'string');
  assert.ok(hello.rules && Array.isArray(hello.rules.gifts));
  c.close();
});

test('simulated rose gift → gift event with rule + leaderboard update', async () => {
  const c = await connectWs();
  await c.next(m => m.type === 'hello');
  const r = await post('/api/sim/gift', { nickname: 'Maria Teste', giftName: 'Rose', count: 3, diamondCount: 1 });
  assert.ok(r.status < 300, `sim gift failed: ${r.status} ${r.text}`);
  const gift = await c.next(m => m.type === 'gift' && m.user && m.user.nickname === 'Maria Teste');
  assert.equal(gift.count, 3);
  assert.equal(gift.coins, 3);
  assert.equal(gift.rule.show, true);
  assert.equal(gift.rule.bombs, 3, 'Rose rule = 1 bomb per unit');
  assert.ok(gift.user.avatarUrl, 'sim users get a generated avatar');
  const lb = await c.next(m => m.type === 'leaderboard' && m.leader && m.leader.nickname === 'Maria Teste');
  assert.equal(lb.leader.coins, 3);
  c.close();
});

test('streak of 10 roses yields exactly 10 bombs in total and ends the streak', async () => {
  const c = await connectWs();
  await c.next(m => m.type === 'hello');
  const nick = 'Streaker ' + Math.random().toString(36).slice(2, 6);
  // one streak request: the server replays 10 progress events (repeatCount 1..10) and a final repeatEnd
  const r = await post('/api/sim/gift', { nickname: nick, giftName: 'Rose', count: 10, diamondCount: 1, streak: true });
  assert.ok(r.status < 300, r.text);
  await new Promise(r => setTimeout(r, 10 * 120 + 300 + 700));
  const gifts = c.inbox.filter(m => m.type === 'gift' && m.user.nickname === nick);
  const bombs = gifts.reduce((s, g) => s + g.rule.bombs, 0);
  const units = gifts.reduce((s, g) => s + g.count, 0);
  assert.equal(units, 10, `expected 10 units, events: ${JSON.stringify(gifts.map(g => [g.count, g.repeatCount, g.streakEnd]))}`);
  assert.equal(bombs, 10);
  assert.ok(gifts.some(g => g.streakEnd), 'a streakEnd event must be emitted');
  c.close();
});

test('round_end updates stats, persists to disk and survives a restart', async () => {
  const c = await connectWs();
  const hello = await c.next(m => m.type === 'hello');
  const winsBefore = hello.stats.wins;
  c.send({ type: 'round_start', roundId: 999 });
  c.send({ type: 'round_end', roundId: 999, result: 'win', apples: 12, bombsEaten: 1, length: 15, durationMs: 60000 });
  const stats = await c.next(m => m.type === 'stats' && m.wins === winsBefore + 1);
  assert.equal(stats.history[0].result, 'win');
  c.send({ type: 'round_end', roundId: 1000, result: 'loss', apples: 3, bombsEaten: 5, length: 3, durationMs: 20000 });
  const stats2 = await c.next(m => m.type === 'stats' && m.losses >= 1 && m.history[0].roundId === 1000);
  assert.equal(stats2.history[0].result, 'loss');
  c.close();
  // give the debounced writer time to flush, then restart
  await new Promise(r => setTimeout(r, 1500));
  server.kill('SIGTERM');
  await new Promise(r => server.on('exit', r));
  server = await startServer();
  const status = await (await fetch(`${BASE}/api/status`)).json();
  assert.equal(status.stats.wins, winsBefore + 1);
  assert.ok(status.stats.losses >= 1);
});

test('command endpoint broadcasts to overlays', async () => {
  const c = await connectWs();
  await c.next(m => m.type === 'hello');
  const r = await post('/api/command', { action: 'spawn_bomb', payload: { count: 2 } });
  assert.ok(r.status < 300, r.text);
  const cmd = await c.next(m => m.type === 'command' && m.action === 'spawn_bomb');
  assert.equal(cmd.payload.count, 2);
  c.close();
});

test('image proxy rejects private hosts and non-http schemes', async () => {
  for (const u of ['http://127.0.0.1:1/x.png', 'http://localhost/x.png', 'file:///etc/passwd', 'ftp://x/y', 'http://10.0.0.1/a.png']) {
    const r = await fetch(`${BASE}/img?u=${encodeURIComponent(u)}`);
    assert.ok(r.status >= 400, `${u} should be rejected, got ${r.status}`);
  }
});

test('gift rules: PUT validates and persists, GET returns them', async () => {
  const cur = await (await fetch(`${BASE}/api/gifts`)).json();
  assert.ok(Array.isArray(cur.gifts));
  const bad = await fetch(`${BASE}/api/gifts`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'nope' }) });
  assert.ok(bad.status >= 400, 'invalid rules must be rejected');
  const ok = await fetch(`${BASE}/api/gifts`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cur) });
  assert.ok(ok.status < 300, await ok.text());
});
