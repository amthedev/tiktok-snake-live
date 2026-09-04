/**
 * index.js — HTTP + WebSocket server for "TikTok Snake LIVE" (SPEC §6).
 *
 *   GET  /            overlay (public/index.html)      GET /painel   control panel
 *   GET  /vendor/three/*  three.js from node_modules   GET /img?u=   image proxy
 *   WS   /ws          JSON protocol (§6.1 / §6.2)      /api/*        JSON API (§6.3)
 *
 * Run: `npm start` (or `npm run dev` for auto-restart). Environment: see `.env.example`.
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';

import { loadRules, saveRules, validateRules, withDefaults, DEFAULT_RULES } from './gifts.js';
import { StatsStore } from './stats.js';
import { TikTokBridge, cleanUsername } from './tiktok.js';
import { createImageProxy } from './proxy.js';
import { str, int } from './normalize.js';

/* ------------------------------------------------------------------------------------------------
 * Paths & environment
 * ---------------------------------------------------------------------------------------------- */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const THREE_DIR = path.join(ROOT, 'node_modules', 'three');
const GIFTS_PATH = path.join(ROOT, 'config', 'gifts.json');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const STATS_PATH = path.join(DATA_DIR, 'stats.json');

// Node ≥ 21.7 can read a .env file natively; values already in the environment win.
try {
  process.loadEnvFile?.(path.join(ROOT, '.env'));
} catch {
  /* no .env — fine */
}

const PORT = int(process.env.PORT, 3000) || 3000;
const HOST = str(process.env.HOST, '127.0.0.1');
const DEBUG = /^(1|true|yes)$/i.test(str(process.env.DEBUG, ''));
const HEARTBEAT_MS = 25_000;
// [persist] Rodada guardada sem snapshot há mais que isso → o overlay começa uma rodada nova.
const RESUME_MAX_AGE_MS = 5 * 60 * 1000;
const COMMANDS = new Set(['new_round', 'pause', 'resume', 'spawn_bomb', 'spawn_apple', 'clear_bombs', 'set_config', 'reload']);

/* ------------------------------------------------------------------------------------------------
 * Logger
 * ---------------------------------------------------------------------------------------------- */

const stamp = () => new Date().toISOString().slice(11, 19);
const log = {
  info: (...a) => console.log(stamp(), ...a),
  warn: (...a) => console.warn(stamp(), '⚠', ...a),
  error: (...a) => console.error(stamp(), '✖', ...a),
  debug: (...a) => {
    if (DEBUG) console.log(stamp(), '·', ...a);
  },
};

/* ------------------------------------------------------------------------------------------------
 * State
 * ---------------------------------------------------------------------------------------------- */

const stats = new StatsStore({ path: STATS_PATH, log });
await stats.load();

let rules;
try {
  rules = await loadRules(GIFTS_PATH);
} catch (err) {
  log.error(`regras de presentes inválidas, usando padrão: ${err.message}`);
  rules = withDefaults(DEFAULT_RULES);
}

const bridge = new TikTokBridge({ rules: () => rules, stats, log });

let envConfig = {};
if (process.env.OVERLAY_CONFIG) {
  try {
    const parsed = JSON.parse(process.env.OVERLAY_CONFIG);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) envConfig = parsed;
  } catch (err) {
    log.warn('OVERLAY_CONFIG não é JSON válido:', err.message);
  }
}

/** Config overrides sent in `hello` (env < panel `set_config`). */
function overlayConfig() {
  return { ...envConfig, ...(stats.settings.config || {}) };
}

let lastSnapshot = null; // last overlay snapshot (for the panel)
let lastRound = null; // { roundId, startedAt }

/* ---- [persist] Dono da partida -----------------------------------------------------------------
 *
 * DECISÃO: o PRIMEIRO overlay conectado é o DONO ("owner"); qualquer overlay que conecte depois
 * entra em MODO ESPELHO ("mirror") e só EXIBE. Motivo: `round_end` incrementa vitórias/derrotas e
 * as metas acumulam moedas — com dois overlays abertos (o do OBS e um no navegador, por exemplo)
 * os dois mandariam `round_end` da mesma rodada e o placar contaria em dobro.
 *
 * Regras:
 *  • O papel é decidido pelo servidor e vai no `hello` (`role: 'owner' | 'mirror'`).
 *  • Só o dono tem `round_start` / `round_end` / `snapshot` aceitos; do espelho eles são ignorados.
 *  • Se o dono cair (F5, OBS fechado, queda de rede), o próximo overlay da fila é promovido e
 *    recebe um `role` avisando da promoção — a partida continua de onde parou, porque o estado
 *    mora aqui no servidor, não no navegador.
 * ---------------------------------------------------------------------------------------------- */

let ownerWs = null;

// Só um overlay declarado pode ser dono: o painel (`identify role=panel`) nunca joga, e um cliente
// que ainda não se identificou não é elegível — senão o painel viraria dono por chegar primeiro.
const isOverlay = (ws) => ws.role === 'overlay';

/**
 * Promove o overlay mais antigo ainda conectado a dono da partida.
 * @param {{notify?: boolean}} [o] notify=false no `hello` inicial (o papel já vai no próprio hello)
 */
function electOwner({ promotion = false } = {}) {
  // Um dono que já não está OPEN (o socket fechou, ou está fechando) perde a posse na hora: o
  // evento 'close' do ws é assíncrono, e esperar por ele deixaria um overlay morto segurando a
  // partida enquanto o overlay novo — o F5 do streamer — já está conectado e sendo ignorado.
  if (ownerWs && ownerWs.readyState === WebSocket.OPEN) return ownerWs;
  ownerWs = null;
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN || !isOverlay(client)) continue;
    if (!ownerWs || client.connectedAt < ownerWs.connectedAt) ownerWs = client;
  }
  if (ownerWs && ownerWs.announcedRole !== 'owner') {
    // Avisa só quando o papel MUDA para este cliente: `electOwner` roda em vários caminhos
    // (identify, round_start, snapshot, saída do dono) e reenviar 'role' a cada chamada
    // encheria o cliente de mensagens iguais.
    ownerWs.announcedRole = 'owner';
    // `promotion` vem do handler de close: o dono anterior caiu e este overlay o substitui —
    // é o caso em que o cliente precisa saber que ASSUMIU a partida em andamento.
    send(ownerWs, 'role', { role: 'owner', promoted: promotion === true });
    log.info(`overlay dono da partida definido (${wss.clients.size} cliente(s))`);
  }
  return ownerWs;
}

function roleOf(ws) {
  if (ownerWs === ws) return 'owner';
  // Ninguém é dono ainda (este cliente acabou de conectar e o `identify` está a caminho):
  // 'owner' é o palpite certo — senão o overlay começaria como espelho e não mandaria o
  // primeiro `round_start`, deixando o jogo parado até o `role` chegar.
  if (!ownerWs || ownerWs.readyState !== WebSocket.OPEN) return 'owner';
  return 'mirror';
}

/** [persist] Estado da rodada mandado no `hello` — `resume:true` quando dá para retomar. */
function resumePayload() {
  const live = stats.live;
  const fresh = stats.isLiveFresh(RESUME_MAX_AGE_MS);
  return {
    resume: fresh,
    live,
    ageMs: live.updatedAt ? Date.now() - live.updatedAt : null,
    maxAgeMs: RESUME_MAX_AGE_MS,
  };
}

/* ------------------------------------------------------------------------------------------------
 * HTTP app
 * ---------------------------------------------------------------------------------------------- */

const app = express();
app.disable('x-powered-by');
app.set('etag', false);
app.use(express.json({ limit: '256kb' }));

const staticHeaders = (res, filePath) => {
  if (filePath.endsWith('.js') || filePath.endsWith('.mjs')) res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
  if (filePath.endsWith('.json')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
};

function sendPage(file) {
  return (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(PUBLIC_DIR, file), (err) => {
      if (err && !res.headersSent) {
        res.status(404).type('text/plain; charset=utf-8').send(`Arquivo não encontrado: public/${file}`);
      }
    });
  };
}

app.get('/', sendPage('index.html'));
app.get('/painel', sendPage('painel.html'));
app.get('/img', createImageProxy({ log }));

app.use(
  '/vendor/three',
  express.static(THREE_DIR, {
    index: false,
    dotfiles: 'ignore',
    fallthrough: true,
    maxAge: '1h',
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.js')) res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=3600');
    },
  }),
);
app.use(express.static(PUBLIC_DIR, { index: false, dotfiles: 'ignore', setHeaders: staticHeaders }));

/* ---- helpers ---------------------------------------------------------------------------------- */

const ok = (res, payload = {}) => res.json({ ok: true, ...payload });
const fail = (res, status, error, extra = {}) => res.status(status).json({ ok: false, error, ...extra });
const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

/* ---- status / tiktok -------------------------------------------------------------------------- */

app.get('/api/status', (_req, res) => {
  res.json({
    tiktok: bridge.status,
    stats: stats.stats,
    leaderboard: stats.leaderboard,
    clients: wss.clients.size,
    snapshot: lastSnapshot,
    round: lastRound,
    live: stats.live,                 // [persist] estado autoritativo da rodada
    roundLeaderboard: stats.roundLeaderboard, // [persist] ranking da rodada
    resumable: stats.isLiveFresh(RESUME_MAX_AGE_MS),
    settings: { username: stats.settings.username, config: overlayConfig() },
    uptimeSec: Math.round(process.uptime()),
  });
});

app.post('/api/tiktok/connect', async (req, res) => {
  const b = body(req);
  const username = cleanUsername(b.username ?? stats.settings.username ?? process.env.TIKTOK_USERNAME);
  if (!username) return fail(res, 400, 'Informe um nome de usuário válido do TikTok (sem @).');
  // Optional Euler Stream key from the panel: save when sent, clear when explicitly empty.
  if (typeof b.signApiKey === 'string') {
    const key = b.signApiKey.trim();
    stats.setSetting('signApiKey', key || null);
    log.info(key ? 'chave Euler Stream atualizada pelo painel' : 'chave Euler Stream removida pelo painel');
  }
  stats.setSetting('username', username);
  await bridge.connect(username);
  return ok(res, { tiktok: bridge.status });
});

app.post('/api/tiktok/disconnect', async (_req, res) => {
  await bridge.disconnect();
  return ok(res, { tiktok: bridge.status });
});

/* ---- stats / leaderboard ---------------------------------------------------------------------- */

app.get('/api/stats', (_req, res) => res.json(stats.stats));
app.post('/api/stats/reset', (_req, res) => {
  const s = stats.resetStats();
  broadcast('stats', s);
  log.info('placar zerado pelo painel');
  return ok(res, { stats: s });
});

app.get('/api/leaderboard', (_req, res) => res.json(stats.leaderboard));
app.post('/api/leaderboard/reset', (_req, res) => {
  const lb = stats.resetLeaderboard();
  bridge.streaks.clear();
  broadcast('leaderboard', lb);
  log.info('ranking zerado pelo painel');
  return ok(res, { leaderboard: lb });
});

/* ---- gift rules ------------------------------------------------------------------------------- */

app.get('/api/gifts', (_req, res) => res.json(rules));
app.get('/api/gifts/default', (_req, res) => res.json(withDefaults(DEFAULT_RULES)));
// Dry-run validation for the panel editor (nothing is saved).
app.post('/api/gifts/validate', (req, res) => {
  const { ok: valid, errors } = validateRules(req.body);
  return res.status(valid ? 200 : 400).json({ ok: valid, errors });
});
app.put('/api/gifts', async (req, res) => {
  const candidate = req.body;
  const { ok: valid, errors } = validateRules(candidate);
  if (!valid) return fail(res, 400, 'Regras inválidas.', { errors });
  try {
    rules = await saveRules(GIFTS_PATH, candidate);
  } catch (err) {
    log.error('falha ao salvar config/gifts.json:', err.message);
    return fail(res, 500, `Não foi possível salvar as regras: ${err.message}`);
  }
  broadcast('rules', rules);
  log.info(`regras de presentes atualizadas (${rules.gifts.length} regras, modo ${rules.mode})`);
  return ok(res, { rules });
});

/* ---- commands --------------------------------------------------------------------------------- */

app.post('/api/command', (req, res) => {
  const { action, payload } = body(req);
  if (!COMMANDS.has(action)) return fail(res, 400, `Comando desconhecido: ${String(action)}`);
  if (action === 'set_config') {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return fail(res, 400, 'set_config precisa de um objeto em payload.');
    stats.setSetting('config', { ...(stats.settings.config || {}), ...payload });
  }
  broadcast('command', { action, payload: payload ?? null });
  log.info(`comando: ${action}`);
  return ok(res, { action });
});

/* ---- simulation (same pipeline as real events) ----------------------------------------------- */

app.post('/api/sim/gift', (req, res) => {
  const b = body(req);
  if (!str(b.giftName, '')) return fail(res, 400, 'Informe giftName.');
  const result = bridge.simulateGift({
    nickname: b.nickname,
    uniqueId: b.uniqueId,
    giftName: b.giftName,
    giftId: b.giftId,
    count: b.count,
    diamondCount: b.diamondCount,
    avatarUrl: b.avatarUrl,
    giftImageUrl: b.giftImageUrl,
    streak: b.streak === true || b.streak === 'true' || b.streak === 1,
  });
  return res.json(result);
});

app.post('/api/sim/chat', (req, res) => {
  const b = body(req);
  const evt = bridge.simulateChat({ nickname: b.nickname, uniqueId: b.uniqueId, text: b.text, avatarUrl: b.avatarUrl });
  return ok(res, { event: evt });
});

app.post('/api/sim/like', (req, res) => {
  const b = body(req);
  return ok(res, { event: bridge.simulateLike({ nickname: b.nickname, uniqueId: b.uniqueId, count: b.count, avatarUrl: b.avatarUrl }) });
});

app.post('/api/sim/follow', (req, res) => {
  const b = body(req);
  return ok(res, { event: bridge.simulateFollow({ nickname: b.nickname, uniqueId: b.uniqueId, avatarUrl: b.avatarUrl }) });
});

app.post('/api/sim/share', (req, res) => {
  const b = body(req);
  return ok(res, { event: bridge.simulateShare({ nickname: b.nickname, uniqueId: b.uniqueId, avatarUrl: b.avatarUrl }) });
});

app.post('/api/sim/member', (req, res) => {
  const b = body(req);
  return ok(res, { event: bridge.simulateMember({ nickname: b.nickname, uniqueId: b.uniqueId, avatarUrl: b.avatarUrl }) });
});

app.post('/api/sim/viewers', (req, res) => ok(res, { event: bridge.simulateViewers(body(req).count) }));

/* ---- fallbacks -------------------------------------------------------------------------------- */

app.use('/api', (_req, res) => fail(res, 404, 'Rota não encontrada.'));
app.use((_req, res) => res.status(404).type('text/plain; charset=utf-8').send('Não encontrado.'));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err?.type === 'entity.parse.failed') return fail(res, 400, 'JSON inválido no corpo da requisição.');
  if (err?.type === 'entity.too.large') return fail(res, 413, 'Corpo da requisição grande demais.');
  log.error('erro HTTP:', err?.stack || err);
  if (res.headersSent) return;
  return fail(res, err?.status || 500, 'Erro interno do servidor.');
});

/* ------------------------------------------------------------------------------------------------
 * WebSocket
 * ---------------------------------------------------------------------------------------------- */

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });

function send(ws, type, payload = {}) {
  if (ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify({ type, ts: Date.now(), ...payload }));
    return true;
  } catch (err) {
    log.debug('ws send falhou:', err.message);
    return false;
  }
}

/** Send `{type, ts, ...payload}` to every open client (optionally skipping one). */
function broadcast(type, payload = {}, { except = null } = {}) {
  const frame = JSON.stringify({ type, ts: Date.now(), ...payload });
  let n = 0;
  for (const client of wss.clients) {
    if (client === except || client.readyState !== WebSocket.OPEN) continue;
    try {
      client.send(frame);
      n += 1;
    } catch (err) {
      log.debug('ws broadcast falhou:', err.message);
    }
  }
  return n;
}

function helloPayload(ws = null) {
  return {
    config: overlayConfig(),
    stats: stats.stats,
    leaderboard: stats.leaderboard, // [persist] já inclui o bloco `round`
    tiktok: bridge.status,
    rules,
    snapshot: lastSnapshot,
    round: lastRound,
    // [persist] papel deste cliente + estado da rodada para retomar depois de um F5.
    role: ws ? roleOf(ws) : 'mirror',
    ...resumePayload(),
  };
}

function handleClientMessage(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(String(raw));
  } catch {
    return;
  }
  if (!msg || typeof msg !== 'object') return;

  // [persist] Só o overlay DONO altera o estado da partida; os espelhos são ignorados (senão
  // dois overlays abertos contariam a mesma vitória duas vezes). Ver "Dono da partida" acima.
  //
  // Um cliente que manda mensagens de partida sem ter feito `identify` (overlay antigo) se
  // declara overlay aqui e entra na eleição — assim continua funcionando como antes quando é o
  // único conectado, mas ainda perde para um dono já eleito.
  const claimsGame = msg.type === 'round_start' || msg.type === 'round_end' || msg.type === 'snapshot';
  if (claimsGame && ws.role === 'unknown') ws.role = 'overlay';
  if (claimsGame) electOwner();
  const owner = ownerWs === ws;

  switch (msg.type) {
    case 'identify': {
      ws.role = str(msg.role, 'unknown').slice(0, 20);
      if (ws.role === 'overlay') electOwner();
      const mine = roleOf(ws);
      if (ws.announcedRole !== mine) {
        ws.announcedRole = mine;
        send(ws, 'role', { role: mine });
      }
      break;
    }
    case 'round_start': {
      if (!owner) { log.debug('round_start ignorado (overlay espelho)'); break; }
      const roundId = int(msg.roundId, 0);
      lastRound = { roundId, startedAt: Date.now() };
      // [persist] Nova rodada zera SÓ o ranking da rodada (o da live continua somando).
      stats.startRound(roundId);
      stats.beginLiveRound(roundId, { startedAt: lastRound.startedAt });
      log.info(`rodada ${roundId} começou — ranking da rodada zerado`);
      broadcast('round_start', { roundId }, { except: ws });
      broadcast('leaderboard', stats.leaderboard);
      break;
    }
    case 'round_end': {
      if (!owner) { log.debug('round_end ignorado (overlay espelho)'); break; }
      const summary = {
        roundId: int(msg.roundId, 0),
        result: msg.result === 'win' ? 'win' : 'loss',
        apples: int(msg.apples, 0),
        bombsEaten: int(msg.bombsEaten, 0),
        length: int(msg.length, 0),
        durationMs: int(msg.durationMs, 0),
      };
      const s = stats.recordRound(summary);
      stats.endLiveRound(summary.result); // [persist] rodada morta: não retomar numa reconexão
      log.info(`rodada ${summary.roundId}: ${summary.result === 'win' ? 'VITÓRIA' : 'DERROTA'} (maçãs ${summary.apples}, bombas ${summary.bombsEaten})`);
      broadcast('stats', s);
      break;
    }
    case 'snapshot': {
      const snap = {
        roundId: int(msg.roundId, 0),
        phase: str(msg.phase, 'unknown'),
        length: int(msg.length, 0),
        danger: msg.danger === true,
        apples: int(msg.apples, 0),
        bombs: int(msg.bombs, 0),
        progress: typeof msg.progress === 'number' && Number.isFinite(msg.progress) ? Math.max(0, Math.min(1, msg.progress)) : 0,
        paused: msg.paused === true,
        at: Date.now(),
      };
      if (!owner) { log.debug('snapshot ignorado (overlay espelho)'); break; }
      lastSnapshot = snap;
      // [persist] Guarda o estado corrente em disco (debounced pelo StatsStore) para que um F5
      // ou um restart do servidor retomem a mesma rodada, no mesmo ponto.
      stats.updateLive({
        roundId: snap.roundId,
        phase: snap.phase,
        length: snap.length,
        apples: snap.apples,
        bombsEaten: int(msg.bombsEaten, stats.live.bombsEaten),
        progress: snap.progress,
        elapsedMs: int(msg.elapsedMs, 0),
        goals: msg.goals && typeof msg.goals === 'object' && !Array.isArray(msg.goals) ? msg.goals : undefined,
      });
      broadcast('snapshot', lastSnapshot, { except: ws });
      break;
    }
    case 'ping':
      send(ws, 'pong');
      break;
    default:
      log.debug('ws mensagem ignorada:', msg.type);
  }
}

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.role = 'unknown';
  ws.connectedAt = Date.now(); // [persist] desempata a eleição do dono (o mais antigo vence)
  const ip = req.socket.remoteAddress;
  log.debug(`ws conectado (${ip}) — ${wss.clients.size} cliente(s)`);
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  ws.on('message', (data) => handleClientMessage(ws, data));
  ws.on('error', (err) => log.debug('ws erro:', err.message));
  ws.on('close', () => {
    // [persist] Se o dono caiu (F5 / OBS fechado), promove o próximo overlay da fila.
    if (ownerWs === ws) {
      ownerWs = null;
      log.debug('overlay dono desconectou — elegendo outro');
      electOwner({ promotion: true });
    }
    log.debug(`ws fechado — ${wss.clients.size} cliente(s)`);
  });
  // O papel definitivo sai no `role` que responde ao `identify` do cliente; o `hello` já leva o
  // papel atual para o caso de um overlay antigo que não se identifica.
  send(ws, 'hello', helloPayload(ws));
});

wss.on('error', (err) => log.error('WebSocketServer:', err.message));

// Heartbeat: ping every 25 s, drop clients that did not answer the previous ping.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      ws.terminate();
    }
  }
}, HEARTBEAT_MS);
heartbeat.unref();

/* ------------------------------------------------------------------------------------------------
 * Bridge → clients
 * ---------------------------------------------------------------------------------------------- */

bridge.on('status', (s) => {
  log.info(`tiktok: ${s.status}${s.username ? ` @${s.username}` : ''}${s.message ? ` — ${s.message}` : ''}`);
  broadcast('tiktok_status', s);
});
bridge.on('gift', (evt) => {
  log.info(`🎁 ${evt.user.nickname}: ${evt.giftName} ×${evt.count} (streak ${evt.repeatCount}${evt.streakEnd ? ' fim' : ''}) → ${evt.rule.bombs} bomba(s)`);
  broadcast('gift', evt);
});
bridge.on('leaderboard', (lb) => broadcast('leaderboard', lb));
bridge.on('chat', (evt) => broadcast('chat', evt));
bridge.on('like', (evt) => broadcast('like', evt));
bridge.on('follow', (evt) => broadcast('follow', evt));
bridge.on('share', (evt) => broadcast('share', evt));
bridge.on('member', (evt) => broadcast('member', evt));
bridge.on('viewers', (evt) => broadcast('viewers', evt));

/* ------------------------------------------------------------------------------------------------
 * Boot & shutdown
 * ---------------------------------------------------------------------------------------------- */

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') log.error(`a porta ${PORT} já está em uso. Defina PORT=outra no .env.`);
  else log.error('servidor HTTP:', err.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  log.info(`TikTok Snake LIVE`);
  log.info(`  overlay : http://localhost:${PORT}/?obs=1`);
  log.info(`  painel  : http://localhost:${PORT}/painel`);
  log.info(`  regras  : ${rules.gifts.length} presente(s), modo "${rules.mode}"`);
  log.info(`  placar  : ${stats.stats.wins} vitórias × ${stats.stats.losses} derrotas`);

  const autoConnect = /^(1|true|yes)$/i.test(str(process.env.AUTO_CONNECT, ''));
  const username = cleanUsername(process.env.TIKTOK_USERNAME || stats.settings.username);
  if (autoConnect && username) {
    log.info(`  tiktok  : conectando automaticamente a @${username}`);
    bridge.connect(username).catch((err) => log.error('auto-connect:', err.message));
  } else if (autoConnect) {
    log.warn('AUTO_CONNECT=true mas TIKTOK_USERNAME está vazio.');
  }
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`encerrando (${signal})…`);
  clearInterval(heartbeat);
  const force = setTimeout(() => process.exit(0), 3000);
  force.unref();
  try {
    for (const ws of wss.clients) ws.close(1001, 'servidor encerrando');
    await bridge.destroy();
    await stats.close();
    await new Promise((resolve) => server.close(() => resolve()));
  } catch (err) {
    log.error('erro ao encerrar:', err.message);
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('exit', () => stats.flushSync());
process.on('unhandledRejection', (err) => log.error('promise rejeitada sem tratamento:', err?.stack || err));
process.on('uncaughtException', (err) => {
  log.error('exceção não tratada:', err?.stack || err);
  stats.flushSync();
  process.exit(1);
});
