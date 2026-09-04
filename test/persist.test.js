// test/persist.test.js
// [persist] Dois rankings (rodada × live) e retomada da rodada pelo servidor.
//
// Cobre o pedido do cliente:
//   "cada rodada meio que zere esse ranking de vilão e herói, mas que tenha um ranking que
//    mostra quem deu mais moedas em toda a live"
//   "tem que sincronizar esse joguinho, mesmo que reinicie a página tem que continuar"
//
// Parte 1 — StatsStore puro (rápido, sem rede).
// Parte 2 — servidor de verdade: WebSocket + HTTP, incluindo F5 do overlay, restart do
//           processo e a eleição de dono da partida (dois overlays não contam em dobro).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

import { StatsStore } from '../server/stats.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };

/** StatsStore que não escreve em disco (debounce alto + path em tmp). */
function memStore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'snake-persist-'));
  return new StatsStore({ path: path.join(dir, 'stats.json'), log: quietLog, debounceMs: 10_000 });
}

const gift = (userId, coins, team, count = 1) => ({
  user: { userId, uniqueId: userId, nickname: userId, avatarUrl: null },
  coins, count, team,
});

/* ================================================================================================
 * Parte 1 — StatsStore: os dois rankings
 * ============================================================================================== */

describe('[persist] dois rankings: rodada × live', () => {
  test('addGift alimenta o ranking da LIVE e o da RODADA ao mesmo tempo', () => {
    const s = memStore();
    s.startRound(1);
    s.addGift(gift('ana', 100, 'villain'));
    s.addGift(gift('bob', 40, 'hero'));

    const lb = s.leaderboard;
    assert.equal(lb.teams.villain.coins, 100, 'live: vilões');
    assert.equal(lb.teams.hero.coins, 40, 'live: heróis');
    assert.ok(lb.round, 'o payload precisa trazer o bloco `round`');
    assert.equal(lb.round.roundId, 1);
    assert.equal(lb.round.villain.coins, 100, 'rodada: vilões');
    assert.equal(lb.round.hero.coins, 40, 'rodada: heróis');
  });

  test('startRound zera SÓ o ranking da rodada — o da live continua acumulando', () => {
    const s = memStore();
    s.startRound(1);
    s.addGift(gift('ana', 100, 'villain'));
    s.addGift(gift('bob', 40, 'hero'));

    // Rodada 2: o duelo recomeça do zero.
    s.startRound(2);
    let lb = s.leaderboard;
    assert.equal(lb.round.roundId, 2);
    assert.equal(lb.round.villain.coins, 0, 'rodada nova começa zerada (vilões)');
    assert.equal(lb.round.hero.coins, 0, 'rodada nova começa zerada (heróis)');
    assert.equal(lb.round.top.length, 0, 'ranking da rodada sem gifters');
    // …mas o ranking da LIVE não perdeu nada.
    assert.equal(lb.teams.villain.coins, 100, 'live: vilões preservados');
    assert.equal(lb.teams.hero.coins, 40, 'live: heróis preservados');
    assert.equal(lb.leader.userId, 'ana');
    assert.equal(lb.leader.coins, 100);

    // Um presente novo na rodada 2 entra nos dois de novo.
    s.addGift(gift('carla', 25, 'hero'));
    lb = s.leaderboard;
    assert.equal(lb.round.hero.coins, 25, 'rodada 2 conta só o presente da rodada 2');
    assert.equal(lb.teams.hero.coins, 65, 'live soma 40 + 25');
  });

  test('o mesmo gifter acumula na live entre rodadas, mas reaparece zerado na rodada', () => {
    const s = memStore();
    s.startRound(1);
    s.addGift(gift('ana', 30, 'villain'));
    s.startRound(2);
    s.addGift(gift('ana', 70, 'villain'));

    const lb = s.leaderboard;
    const liveAna = lb.top.find((g) => g.userId === 'ana');
    assert.equal(liveAna.coins, 100, 'live: 30 + 70');
    assert.equal(liveAna.villainCoins, 100);

    const roundAna = lb.round.top.find((g) => g.userId === 'ana');
    assert.equal(roundAna.coins, 70, 'rodada 2: só os 70 desta rodada');
    assert.equal(roundAna.villainCoins, 70);
  });

  test('resetLeaderboard (painel / troca de sala) zera os dois', () => {
    const s = memStore();
    s.startRound(1);
    s.addGift(gift('ana', 100, 'villain'));
    s.resetLeaderboard('sala-nova');
    const lb = s.leaderboard;
    assert.equal(lb.teams.villain.coins, 0);
    assert.equal(lb.round.villain.coins, 0);
    assert.equal(lb.roomId, 'sala-nova');
  });

  test('presente sem moedas (0 coins) ainda move o duelo da rodada', () => {
    const s = memStore();
    s.startRound(1);
    s.addGift(gift('ana', 0, 'villain', 3)); // 3 unidades grátis
    assert.equal(s.leaderboard.round.villain.coins, 3, 'peso = contagem quando coins = 0');
    assert.equal(s.roundLeaderboard.villain.coins, 3);
  });
});

/* ================================================================================================
 * Parte 1b — StatsStore: estado da rodada (retomada)
 * ============================================================================================== */

describe('[persist] estado autoritativo da rodada', () => {
  test('beginLiveRound + updateLive guardam o suficiente para retomar', () => {
    const s = memStore();
    s.beginLiveRound(7, { startedAt: 1000 });
    assert.equal(s.live.roundId, 7);
    assert.equal(s.live.startedAt, 1000);

    s.updateLive({ roundId: 7, phase: 'playing', length: 12, apples: 9, progress: 0.4, elapsedMs: 30_000 });
    const live = s.live;
    assert.equal(live.roundId, 7);
    assert.equal(live.phase, 'playing');
    assert.equal(live.length, 12);
    assert.equal(live.apples, 9);
    assert.equal(live.progress, 0.4);
    assert.equal(live.elapsedMs, 30_000);
    assert.ok(live.updatedAt > 0, 'updatedAt marca a idade do estado');
  });

  test('isLiveFresh: rodada recente retoma; antiga, terminada ou vazia, não', () => {
    const s = memStore();
    assert.equal(s.isLiveFresh(), false, 'store novo não tem o que retomar');

    s.beginLiveRound(3);
    s.updateLive({ roundId: 3, phase: 'playing', elapsedMs: 5000 });
    assert.equal(s.isLiveFresh(), true, 'rodada em andamento é retomável');

    // Estado velho: sem snapshot há mais que o limite. (-1 ms é sempre "mais velho que o
    // limite" — com 0 o teste ficaria na fronteira do mesmo milissegundo.)
    assert.equal(s.isLiveFresh(-1), false, 'estado mais velho que o limite não retoma');

    // Rodada terminada não pode ser retomada (senão o F5 ressuscitaria uma partida morta).
    s.endLiveRound('win');
    assert.equal(s.live.phase, 'won');
    assert.equal(s.isLiveFresh(), false, 'rodada terminada não retoma');
  });

  test('as metas atravessam o snapshot (é o que o overlay restaura depois do F5)', () => {
    const s = memStore();
    s.beginLiveRound(2);
    s.updateLive({ roundId: 2, phase: 'playing', goals: { goalIndex: 3, goalBase: 470, ctaIndex: 5 } });
    assert.deepEqual(s.live.goals, { goalIndex: 3, goalBase: 470, ctaIndex: 5 });
    // Um snapshot sem `goals` não apaga as metas já guardadas.
    s.updateLive({ roundId: 2, phase: 'playing', length: 20 });
    assert.equal(s.live.goals.goalIndex, 3, 'metas preservadas quando o snapshot não as manda');
    assert.equal(s.live.length, 20);
  });

  test('beginLiveRound zera os contadores da rodada mas mantém as metas (progresso da live)', () => {
    const s = memStore();
    s.beginLiveRound(1);
    s.updateLive({ roundId: 1, phase: 'playing', apples: 15, length: 18, goals: { goalIndex: 2, goalBase: 170 } });
    s.beginLiveRound(2);
    const live = s.live;
    assert.equal(live.roundId, 2);
    assert.equal(live.apples, 0, 'maçãs zeram na rodada nova');
    assert.equal(live.length, 0);
    assert.equal(live.goals.goalIndex, 2, 'metas continuam: são progresso da LIVE inteira');
  });

  test('sobrevive a um ciclo salvar → carregar (o que faz o restart do servidor funcionar)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'snake-persist-'));
    const file = path.join(dir, 'stats.json');

    const a = new StatsStore({ path: file, log: quietLog, debounceMs: 1 });
    a.startRound(11);
    a.addGift(gift('ana', 250, 'villain'));
    a.addGift(gift('bob', 90, 'hero'));
    a.beginLiveRound(11, { startedAt: Date.now() - 20_000 });
    a.updateLive({ roundId: 11, phase: 'playing', length: 22, apples: 19, progress: 0.33, goals: { goalIndex: 2, goalBase: 170 } });
    await a.flush();
    assert.ok(existsSync(file), 'o arquivo foi escrito');

    const b = new StatsStore({ path: file, log: quietLog, debounceMs: 10_000 });
    await b.load();

    // Os dois rankings voltaram do disco.
    assert.equal(b.leaderboard.teams.villain.coins, 250, 'ranking da live veio do disco');
    assert.equal(b.leaderboard.round.villain.coins, 250, 'ranking da rodada veio do disco');
    assert.equal(b.leaderboard.round.roundId, 11);
    // E o estado da rodada também.
    assert.equal(b.live.roundId, 11);
    assert.equal(b.live.length, 22);
    assert.equal(b.live.apples, 19);
    assert.equal(b.live.goals.goalIndex, 2);
    assert.equal(b.isLiveFresh(), true, 'rodada recente continua retomável após o restart');
  });

  test('um arquivo da versão 1 (sem round/live) carrega sem quebrar', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'snake-persist-'));
    const file = path.join(dir, 'stats.json');
    const v1 = {
      version: 1,
      stats: { wins: 4, losses: 2, rounds: 6, currentStreak: 1, bestWinStreak: 3, history: [] },
      leaderboard: { scope: 'live', roomId: 'x', gifters: { ana: { userId: 'ana', nickname: 'Ana', coins: 80, gifts: 2, villainCoins: 80, heroCoins: 0, lastAt: 1 } } },
      settings: { username: 'alguem', signApiKey: null, config: {} },
    };
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, JSON.stringify(v1), 'utf8');

    const s = new StatsStore({ path: file, log: quietLog, debounceMs: 10_000 });
    await s.load();
    assert.equal(s.stats.wins, 4, 'placar antigo preservado');
    assert.equal(s.leaderboard.teams.villain.coins, 80, 'ranking da live preservado');
    assert.equal(s.leaderboard.round.villain.coins, 0, 'ranking da rodada começa vazio');
    assert.equal(s.isLiveFresh(), false, 'sem estado de rodada, nada a retomar');
  });
});

/* ================================================================================================
 * Parte 2 — Servidor de verdade
 * ============================================================================================== */

const PORT = 4800 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'snake-persist-srv-'));

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
        } catch { /* still booting */ }
        await new Promise((r) => setTimeout(r, 120));
      }
      reject(new Error(`server did not answer /api/status in time:\n${out}`));
    })();
  });
}

/**
 * Cliente WS que se identifica como overlay (entra na eleição de dono).
 * `expectOwner` espera o 'role' de dono antes de devolver o cliente — o servidor só libera a
 * posse quando o 'close' do dono anterior é processado, o que é assíncrono; sem esperar, um
 * teste poderia mandar `round_start` enquanto ainda é espelho e ser ignorado.
 */
function connectOverlay({ identify = true } = {}) {
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
    ws.on('open', () => {
      const api = {
        ws, inbox,
        next(pred, ms = 4000) {
          const hit = inbox.find(pred);
          if (hit) return Promise.resolve(hit);
          return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error(`timeout; tipos vistos: ${inbox.map((m) => m.type).join(',')}`)), ms);
            waiters.push({ pred, resolve: res, t });
          });
        },
        send(obj) { ws.send(JSON.stringify({ ts: Date.now(), ...obj })); },
        close() { return new Promise((r) => { ws.on('close', r); ws.close(); }); },
      };
      if (identify) api.send({ type: 'identify', role: 'overlay' });
      resolve(api);
    });
  });
}

/** Conecta e só devolve quando este cliente for o DONO da partida. */
async function connectOwner() {
  const c = await connectOverlay();
  await c.next((m) => m.type === 'hello');
  await c.next((m) => m.type === 'role' && m.role === 'owner', 6000);
  return c;
}

async function post(url, body) {
  const r = await fetch(BASE + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { status: r.status, json: await r.json().catch(() => null) };
}

const status = () => fetch(`${BASE}/api/status`).then((r) => r.json());

describe('[persist] servidor: rankings e retomada de rodada', () => {
  before(async () => { server = await startServer(); });
  after(() => { if (server) server.kill('SIGTERM'); });

  test('round_start zera o ranking da rodada e preserva o da live', async () => {
    const c = await connectOwner();

    c.send({ type: 'round_start', roundId: 1 });
    await post('/api/sim/gift', { nickname: 'Vilma', giftName: 'Rosa', count: 5, diamondCount: 1 });
    const lb1 = await c.next((m) => m.type === 'leaderboard' && m.round && m.round.villain.coins >= 5);
    assert.equal(lb1.round.roundId, 1);
    assert.ok(lb1.teams.villain.coins >= 5, 'live também contou');

    // Rodada 2: o duelo zera, a live não.
    const liveBefore = lb1.teams.villain.coins;
    c.send({ type: 'round_start', roundId: 2 });
    const lb2 = await c.next((m) => m.type === 'leaderboard' && m.round && m.round.roundId === 2);
    assert.equal(lb2.round.villain.coins, 0, 'ranking da rodada zerou');
    assert.equal(lb2.teams.villain.coins, liveBefore, 'ranking da live intacto');
    await c.close();
  });

  test('hello traz o estado da rodada para retomar (o F5 não perde a partida)', async () => {
    const c = await connectOwner();

    const startedAt = Date.now();
    c.send({ type: 'round_start', roundId: 42 });
    await post('/api/sim/gift', { nickname: 'Heroina', giftName: 'GG', count: 3, diamondCount: 1 });
    c.send({ type: 'snapshot', roundId: 42, phase: 'playing', length: 17, apples: 14, bombs: 2, progress: 0.27, bombsEaten: 1, elapsedMs: 45_000, goals: { goalIndex: 2, goalBase: 170, ctaIndex: 4 } });
    // deixa o servidor processar o snapshot
    await c.next((m) => m.type === 'leaderboard');
    await new Promise((r) => setTimeout(r, 200));

    // "F5": a aba morre e uma nova conecta.
    await c.close();
    const fresh = await connectOverlay();
    const hello = await fresh.next((m) => m.type === 'hello');

    assert.equal(hello.resume, true, 'o servidor manda retomar');
    assert.equal(hello.live.roundId, 42, 'MESMA rodada');
    assert.equal(hello.live.length, 17);
    assert.equal(hello.live.apples, 14);
    assert.equal(hello.live.bombsEaten, 1);
    assert.ok(Math.abs(hello.live.startedAt - startedAt) < 5000, 'o relógio da rodada veio junto');
    assert.equal(hello.live.goals.goalIndex, 2, 'metas no ponto em que estavam');
    // Rankings preenchidos no hello.
    assert.ok(hello.leaderboard.round.hero.coins >= 3, 'ranking da rodada veio no hello');
    assert.ok(hello.leaderboard.teams.hero.coins >= 3, 'ranking da live veio no hello');
    await fresh.close();
  });

  test('rodada terminada não é retomada (hello.resume = false)', async () => {
    const c = await connectOwner();
    c.send({ type: 'round_start', roundId: 77 });
    c.send({ type: 'snapshot', roundId: 77, phase: 'playing', length: 8, apples: 5, bombs: 0, progress: 0.1 });
    c.send({ type: 'round_end', roundId: 77, result: 'loss', apples: 5, bombsEaten: 3, length: 3, durationMs: 30_000 });
    await c.next((m) => m.type === 'stats');
    await c.close();

    const fresh = await connectOverlay();
    const hello = await fresh.next((m) => m.type === 'hello');
    assert.equal(hello.resume, false, 'partida morta não é retomada — começa rodada nova');
    await fresh.close();
  });

  test('dono × espelho: o segundo overlay não conta o placar em dobro', async () => {
    const before = (await status()).stats;

    const owner = await connectOwner(); // só segue quando a posse está firmada
    const mirror = await connectOverlay();
    await mirror.next((m) => m.type === 'hello');
    const mirrorRole = await mirror.next((m) => m.type === 'role');
    assert.equal(mirrorRole.role, 'mirror', 'o segundo overlay é espelho');

    // Os DOIS mandam o mesmo fim de rodada (é exatamente o bug que a eleição evita).
    owner.send({ type: 'round_start', roundId: 500 });
    owner.send({ type: 'round_end', roundId: 500, result: 'win', apples: 10, bombsEaten: 0, length: 30, durationMs: 60_000 });
    mirror.send({ type: 'round_end', roundId: 500, result: 'win', apples: 10, bombsEaten: 0, length: 30, durationMs: 60_000 });
    await owner.next((m) => m.type === 'stats');
    await new Promise((r) => setTimeout(r, 300));

    const after = (await status()).stats;
    assert.equal(after.wins, before.wins + 1, 'a vitória foi contada UMA vez, não duas');
    await mirror.close();
    await owner.close();
  });

  test('o espelho é promovido a dono quando o dono cai', async () => {
    const owner = await connectOwner();
    const mirror = await connectOverlay();
    await mirror.next((m) => m.type === 'hello');
    assert.equal((await mirror.next((m) => m.type === 'role')).role, 'mirror');

    await owner.close();
    const promoted = await mirror.next((m) => m.type === 'role' && m.role === 'owner', 5000);
    assert.equal(promoted.role, 'owner', 'o espelho assume a partida');
    assert.equal(promoted.promoted, true);
    await mirror.close();
  });

  test('reconectar não zera o ranking da rodada nem reinicia a partida', async () => {
    const c = await connectOwner();
    c.send({ type: 'round_start', roundId: 900 });
    await post('/api/sim/gift', { nickname: 'Fiel', giftName: 'Rosa', count: 7, diamondCount: 1 });
    await c.next((m) => m.type === 'leaderboard' && m.round && m.round.villain.coins >= 7);
    c.send({ type: 'snapshot', roundId: 900, phase: 'playing', length: 11, apples: 8, bombs: 1, progress: 0.2 });
    await new Promise((r) => setTimeout(r, 200));
    await c.close();

    // Reconexão: o hello traz tudo de volta, sem `round_start` novo → o duelo continua.
    const again = await connectOverlay();
    const hello = await again.next((m) => m.type === 'hello');
    assert.equal(hello.live.roundId, 900, 'mesma rodada');
    assert.ok(hello.leaderboard.round.villain.coins >= 7, 'ranking da rodada sobreviveu à reconexão');
    await again.close();
  });

  test('matar o servidor e subir de novo: o estado volta do disco', async () => {
    const c = await connectOwner();
    c.send({ type: 'round_start', roundId: 1234 });
    await post('/api/sim/gift', { nickname: 'Persistente', giftName: 'Rosa', count: 9, diamondCount: 1 });
    await c.next((m) => m.type === 'leaderboard' && m.round && m.round.villain.coins >= 9);
    c.send({ type: 'snapshot', roundId: 1234, phase: 'playing', length: 25, apples: 22, bombs: 3, progress: 0.4, bombsEaten: 2, goals: { goalIndex: 1, goalBase: 50 } });
    await c.close();

    // Espera o writer debounced e reinicia o processo.
    await new Promise((r) => setTimeout(r, 1200));
    server.kill('SIGTERM');
    await new Promise((r) => server.on('exit', r));
    server = await startServer();

    const st = await status();
    assert.equal(st.live.roundId, 1234, 'a rodada voltou do disco');
    assert.equal(st.live.length, 25);
    assert.equal(st.live.apples, 22);
    assert.equal(st.live.goals.goalIndex, 1, 'metas voltaram do disco');
    assert.ok(st.roundLeaderboard.villain.coins >= 9, 'ranking da rodada voltou do disco');
    assert.ok(st.leaderboard.teams.villain.coins >= 9, 'ranking da live voltou do disco');
    assert.equal(st.resumable, true, 'o overlay que conectar agora retoma a rodada');

    // E o arquivo em disco tem mesmo os dois blocos.
    const raw = JSON.parse(readFileSync(path.join(DATA_DIR, 'stats.json'), 'utf8'));
    assert.ok(raw.round, 'data/stats.json guarda o ranking da rodada');
    assert.ok(raw.live, 'data/stats.json guarda o estado da rodada');
    assert.equal(raw.live.roundId, 1234);
  });
});
