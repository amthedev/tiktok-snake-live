/**
 * tiktok.js — TikTokBridge (SPEC §6.5).
 *
 * Owns the connection lifecycle to a TikTok LIVE room (via `tiktok-live-connector`), turns raw
 * events into the normalized wire events and applies the gift pipeline:
 *
 *   raw → normalize → streak delta → gift rules → leaderboard → emit
 *
 * The SAME pipeline is used by the simulation endpoints (`simulateGift` etc.), so the overlay
 * cannot tell a simulated gift from a real one.
 *
 * Events emitted: 'status', 'gift', 'chat', 'like', 'follow', 'share', 'member', 'viewers', 'leaderboard'.
 *
 * Reconnect policy: on unexpected disconnect / error retry with backoff 5 s → 60 s (cap);
 * when the user is offline go to `waiting_live` and poll `fetchIsLive()` every 60 s; on a sign-server
 * rate limit wait 90 s (or the server's `retryAfter`); `streamEnd` → `waiting_live`.
 */

import { EventEmitter } from 'node:events';
import {
  normalizeGift,
  normalizeChat,
  normalizeLike,
  normalizeSocial,
  normalizeMember,
  normalizeRoomUser,
  StreakTracker,
  avatarDataUri,
  isHttpUrl,
  str,
  int,
} from './normalize.js';
import { resolveGift, normalizeName } from './gifts.js';

const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;
const RATE_LIMIT_WAIT_MS = 90_000;
const LIVE_POLL_MS = 60_000;
const MEMBER_RATE_PER_SEC = 2;
const SIM_STREAK_STEP_MS = 120;
const SIM_MAX_UNITS = 200;

const STATUS_MESSAGES = {
  disconnected: 'Desconectado.',
  connecting: 'Conectando…',
  connected: 'Conectado à live.',
  waiting_live: 'Aguardando a live começar…',
  error: 'Erro na conexão.',
};

/**
 * Clean a username: accepts "@nome", "nome" or a full profile/live URL.
 * @returns {string|null} null when invalid
 */
export function cleanUsername(input) {
  let s = str(input, '');
  if (!s) return null;
  const m = s.match(/@([A-Za-z0-9._]+)/);
  if (m) s = m[1];
  s = s.replace(/^@+/, '').trim();
  if (!/^[A-Za-z0-9._]{1,30}$/.test(s)) return null;
  return s;
}

/** Cheap error classifier that also works without the real connector classes. */
function classifyError(err, mod) {
  if (!err) return 'unknown';
  if (mod?.UserOfflineError && err instanceof mod.UserOfflineError) return 'offline';
  if (mod?.SignatureRateLimitError && err instanceof mod.SignatureRateLimitError) return 'rate_limit';
  if (mod?.AlreadyConnectingError && err instanceof mod.AlreadyConnectingError) return 'already';
  if (mod?.AlreadyConnectedError && err instanceof mod.AlreadyConnectedError) return 'already';
  if (mod?.InvalidUniqueIdError && err instanceof mod.InvalidUniqueIdError) return 'invalid_user';
  const msg = String(err.message || '').toLowerCase();
  if (msg.includes("isn't online") || msg.includes('not online') || msg.includes('offline')) return 'offline';
  if (msg.includes('rate limit') || msg.includes('too many connections')) return 'rate_limit';
  if (msg.includes('already connect')) return 'already';
  return 'unknown';
}

/** pt-BR message for a connect failure. */
function describeError(kind, err) {
  switch (kind) {
    case 'offline':
      return 'O usuário não está ao vivo. Aguardando a live começar…';
    case 'rate_limit':
      return 'Limite de conexões do servidor de assinatura atingido. Nova tentativa em instantes (configure SIGN_API_KEY para evitar).';
    case 'invalid_user':
      return 'Nome de usuário inválido.';
    default:
      return `Falha ao conectar: ${str(err?.message, 'erro desconhecido').slice(0, 200)}`;
  }
}

export class TikTokBridge extends EventEmitter {
  /**
   * @param {{ rules: object|(() => object), stats: import('./stats.js').StatsStore, log?: Console, connectorLoader?: () => Promise<any> }} opts
   */
  constructor({ rules, stats, log = console, connectorLoader } = {}) {
    super();
    this._rules = rules;
    this.stats = stats;
    this.log = log;
    this._loadConnector = connectorLoader || (() => import('tiktok-live-connector'));
    this._mod = null;

    this.streaks = new StreakTracker();
    this._status = { status: 'disconnected', username: null, roomId: null, message: null, viewers: 0 };

    this._wanted = false; // true while the operator wants a connection
    this._conn = null;
    this._gen = 0; // generation counter: callbacks from older connections are ignored
    this._backoffMs = BACKOFF_MIN_MS;
    this._retryTimer = null;
    this._pollTimer = null;
    this._expectDisconnect = false;
    this._seq = 0;

    this._memberTokens = MEMBER_RATE_PER_SEC;
    this._memberRefillAt = Date.now();

    this._simTimers = new Set();
    this._destroyed = false;
  }

  /* ---------------------------------------------------------------------------------------------
   * Rules / status
   * ------------------------------------------------------------------------------------------- */

  get rules() {
    return typeof this._rules === 'function' ? this._rules() : this._rules;
  }

  setRules(rules) {
    this._rules = rules;
  }

  /** Current `TikTokStatus` (copy). */
  get status() {
    return { ...this._status };
  }

  _setStatus(patch) {
    const next = { ...this._status, ...patch };
    if (next.status !== this._status.status && patch.message === undefined) next.message = STATUS_MESSAGES[next.status] || null;
    const changed = JSON.stringify(next) !== JSON.stringify(this._status);
    this._status = next;
    if (changed) this.emit('status', this.status);
  }

  /* ---------------------------------------------------------------------------------------------
   * Connection lifecycle
   * ------------------------------------------------------------------------------------------- */

  /**
   * Start (or restart) a connection to `username`'s live. Resolves as soon as the attempt is
   * scheduled; failures are reported through the 'status' event, never thrown.
   */
  async connect(username) {
    const name = cleanUsername(username);
    if (!name) {
      this._setStatus({ status: 'error', message: 'Nome de usuário inválido.' });
      return false;
    }
    if (this._wanted && this._status.username === name && (this._status.status === 'connected' || this._status.status === 'connecting')) {
      return true;
    }
    await this._teardown();
    this._wanted = true;
    this._backoffMs = BACKOFF_MIN_MS;
    this._setStatus({ status: 'connecting', username: name, roomId: null, viewers: 0, message: `Conectando a @${name}…` });
    this._attempt();
    return true;
  }

  /** Stop and forget the current connection. */
  async disconnect() {
    await this._teardown();
    this._setStatus({ status: 'disconnected', roomId: null, viewers: 0, message: 'Desconectado pelo painel.' });
  }

  /** Stop timers, drop the connection instance. Does not change the public status. */
  async _teardown() {
    this._wanted = false;
    this._gen += 1;
    this._clearTimers();
    const conn = this._conn;
    this._conn = null;
    if (conn) {
      this._expectDisconnect = true;
      try {
        conn.removeAllListeners?.();
        await conn.disconnect?.();
      } catch (err) {
        this.log.debug?.('[tiktok] disconnect:', err?.message);
      }
      this._expectDisconnect = false;
    }
  }

  _clearTimers() {
    if (this._retryTimer) clearTimeout(this._retryTimer);
    if (this._pollTimer) clearTimeout(this._pollTimer);
    this._retryTimer = null;
    this._pollTimer = null;
  }

  async _loadModule() {
    if (this._mod) return this._mod;
    this._mod = await this._loadConnector();
    return this._mod;
  }

  _buildOptions() {
    const opts = {
      enableExtendedGiftInfo: true,
      processInitialData: false,
      signApiKey: process.env.SIGN_API_KEY || undefined,
    };
    const sessionId = str(process.env.TIKTOK_SESSION_ID, '');
    const idc = str(process.env.TIKTOK_TT_TARGET_IDC, '');
    if (sessionId && idc) {
      opts.session = { cookie: { type: 'cookie', value: { sessionId, ttTargetIdc: idc } } };
    }
    return opts;
  }

  /** One connection attempt for the current generation. */
  async _attempt() {
    if (!this._wanted || this._destroyed) return;
    const gen = ++this._gen;
    const username = this._status.username;
    this._clearTimers();
    this._setStatus({ status: 'connecting', message: `Conectando a @${username}…` });

    let mod;
    try {
      mod = await this._loadModule();
    } catch (err) {
      this.log.error?.('[tiktok] não foi possível carregar tiktok-live-connector:', err?.message);
      this._wanted = false;
      this._setStatus({ status: 'error', message: 'Biblioteca tiktok-live-connector indisponível. Rode "npm install".' });
      return;
    }
    if (gen !== this._gen || !this._wanted) return;

    let conn;
    try {
      conn = new mod.TikTokLiveConnection(username, this._buildOptions());
    } catch (err) {
      this._onConnectError(gen, err, mod);
      return;
    }
    this._conn = conn;
    this._bind(conn, gen, mod);

    try {
      const state = await conn.connect();
      if (gen !== this._gen || !this._wanted) return;
      const roomId = str(state?.roomId ?? conn.roomId, '') || null;
      this._backoffMs = BACKOFF_MIN_MS;
      this._setStatus({ status: 'connected', roomId, message: `Ao vivo: @${username}` });
      this._onRoomChanged(roomId);
      this.log.info?.(`[tiktok] conectado a @${username} (roomId ${roomId})`);
    } catch (err) {
      this._onConnectError(gen, err, mod);
    }
  }

  /** Leaderboard scope 'live': a new room means a new leaderboard. */
  _onRoomChanged(roomId) {
    if (!this.stats) return;
    const current = this.stats.leaderboard?.roomId ?? null;
    if (roomId && roomId !== current) {
      const lb = this.stats.resetLeaderboard(roomId);
      this.streaks.clear();
      this.emit('leaderboard', lb);
    }
  }

  _onConnectError(gen, err, mod) {
    if (gen !== this._gen || !this._wanted) return;
    const kind = classifyError(err, mod);
    const message = describeError(kind, err);
    this.log.warn?.(`[tiktok] ${message}`);
    switch (kind) {
      case 'offline':
        this._setStatus({ status: 'waiting_live', roomId: null, message });
        this._scheduleLivePoll(LIVE_POLL_MS);
        break;
      case 'rate_limit': {
        const retryAfter = Number(err?.retryAfter);
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.max(RATE_LIMIT_WAIT_MS, retryAfter * 1000) : RATE_LIMIT_WAIT_MS;
        this._setStatus({ status: 'error', roomId: null, message });
        this._scheduleRetry(wait);
        break;
      }
      case 'invalid_user':
        this._wanted = false;
        this._setStatus({ status: 'error', roomId: null, message });
        break;
      case 'already':
        // The connector thinks it is still busy: retry shortly.
        this._scheduleRetry(BACKOFF_MIN_MS);
        break;
      default:
        this._setStatus({ status: 'error', roomId: null, message });
        this._scheduleRetry(this._backoffMs);
        this._backoffMs = Math.min(BACKOFF_MAX_MS, this._backoffMs * 2);
    }
  }

  _scheduleRetry(ms) {
    this._clearTimers();
    if (!this._wanted) return;
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this._attempt();
    }, ms);
    this._retryTimer.unref?.();
  }

  /** Poll `fetchIsLive()` until the streamer goes live, then reconnect. */
  _scheduleLivePoll(ms) {
    this._clearTimers();
    if (!this._wanted) return;
    const gen = this._gen;
    this._pollTimer = setTimeout(async () => {
      this._pollTimer = null;
      if (!this._wanted || gen !== this._gen) return;
      let live = false;
      try {
        const conn = this._conn || (this._mod ? new this._mod.TikTokLiveConnection(this._status.username, this._buildOptions()) : null);
        if (!conn) throw new Error('conector indisponível');
        this._conn = conn;
        live = !!(await conn.fetchIsLive());
      } catch (err) {
        if (!this._wanted || gen !== this._gen) return;
        const kind = classifyError(err, this._mod);
        this.log.warn?.('[tiktok] verificação de live falhou:', err?.message);
        this._scheduleLivePoll(kind === 'rate_limit' ? RATE_LIMIT_WAIT_MS : LIVE_POLL_MS);
        return;
      }
      if (!this._wanted || gen !== this._gen) return;
      if (live) this._attempt();
      else this._scheduleLivePoll(LIVE_POLL_MS);
    }, ms);
    this._pollTimer.unref?.();
  }

  /** Attach connector listeners for generation `gen`. */
  _bind(conn, gen, mod) {
    const alive = () => gen === this._gen && this._conn === conn;
    const W = mod.WebcastEvent || {};
    const C = mod.ControlEvent || {};

    conn.on(C.DISCONNECTED || 'disconnected', (info) => {
      if (!alive() || this._expectDisconnect) return;
      if (!this._wanted) return;
      if (this._status.status === 'waiting_live') return; // streamEnd already handled
      const reason = str(info?.reason, '');
      this.log.warn?.(`[tiktok] desconectado (${info?.code ?? '?'}) ${reason}`);
      this._setStatus({ status: 'error', roomId: null, viewers: 0, message: `Conexão perdida${reason ? ` (${reason})` : ''}. Reconectando…` });
      this._scheduleRetry(this._backoffMs);
      this._backoffMs = Math.min(BACKOFF_MAX_MS, this._backoffMs * 2);
    });

    conn.on(C.ERROR || 'error', (e) => {
      // Message-level errors (decode failures etc.) are not fatal; the socket stays up.
      this.log.debug?.('[tiktok] erro:', e?.info || e?.exception?.message || e);
    });

    conn.on(W.STREAM_END || 'streamEnd', () => {
      if (!alive()) return;
      this.log.info?.('[tiktok] a live terminou');
      this._setStatus({ status: 'waiting_live', roomId: null, viewers: 0, message: 'A live terminou. Aguardando a próxima…' });
      this._scheduleLivePoll(LIVE_POLL_MS);
    });

    const guard = (fn) => (data) => {
      if (!alive()) return;
      try {
        fn(data);
      } catch (err) {
        this.log.error?.('[tiktok] falha ao processar evento:', err);
      }
    };
    conn.on(W.GIFT || 'gift', guard((d) => this.ingestGift(d, 'tiktok')));
    conn.on(W.CHAT || 'chat', guard((d) => this.ingestChat(d)));
    conn.on(W.LIKE || 'like', guard((d) => this.ingestLike(d)));
    conn.on(W.FOLLOW || 'follow', guard((d) => this.ingestFollow(d)));
    conn.on(W.SHARE || 'share', guard((d) => this.ingestShare(d)));
    conn.on(W.MEMBER || 'member', guard((d) => this.ingestMember(d)));
    conn.on(W.ROOM_USER || 'roomUser', guard((d) => this.ingestRoomUser(d)));
  }

  /* ---------------------------------------------------------------------------------------------
   * Pipeline (shared by real and simulated events)
   * ------------------------------------------------------------------------------------------- */

  _nextId(prefix) {
    this._seq = (this._seq + 1) % 1_000_000;
    return `${prefix}${Date.now().toString(36)}-${this._seq.toString(36)}`;
  }

  /**
   * Full gift pipeline. Returns the emitted `GiftEvent` (SPEC §6.1).
   * @param {object} raw raw connector payload (v3 or legacy) or a sim-built equivalent
   */
  ingestGift(raw, source = 'tiktok') {
    const g = normalizeGift(raw);
    const { count, repeatCount, streakEnd } = this.streaks.apply(g);
    const rule = resolveGift(this.rules, { giftId: g.giftId, giftName: g.giftName, diamondCount: g.diamondCount, count });
    const evt = {
      id: this._nextId('g'),
      user: g.user,
      giftId: g.giftId,
      giftName: g.giftName,
      giftImageUrl: g.giftImageUrl,
      diamondCount: g.diamondCount,
      count,
      repeatCount,
      coins: g.diamondCount * count,
      streakEnd,
      rule: {
        show: rule.show,
        matched: rule.matched,
        ruleName: rule.ruleName,
        team: rule.team,
        tier: rule.tier,
        effects: rule.effects,
        desc: rule.desc,
        // legacy mirrors
        bombs: rule.bombs,
        effect: rule.effect,
      },
      source,
    };
    this.emit('gift', evt);
    if (count > 0 && rule.countCoins && this.stats) {
      const lb = this.stats.addGift({ ...evt, team: rule.team });
      this.emit('leaderboard', lb);
    }
    return evt;
  }

  ingestChat(raw) {
    const evt = normalizeChat(raw);
    if (!evt.text) return null;
    this.emit('chat', evt);
    return evt;
  }

  ingestLike(raw) {
    const evt = normalizeLike(raw);
    this.emit('like', evt);
    return evt;
  }

  ingestFollow(raw) {
    const evt = normalizeSocial(raw);
    this.emit('follow', evt);
    return evt;
  }

  ingestShare(raw) {
    const evt = normalizeSocial(raw);
    this.emit('share', evt);
    return evt;
  }

  /** Rate-limited to ≤ 2 events per second (token bucket); extra joins are dropped. */
  ingestMember(raw) {
    const now = Date.now();
    const elapsed = (now - this._memberRefillAt) / 1000;
    if (elapsed > 0) {
      this._memberTokens = Math.min(MEMBER_RATE_PER_SEC, this._memberTokens + elapsed * MEMBER_RATE_PER_SEC);
      this._memberRefillAt = now;
    }
    if (this._memberTokens < 1) return null;
    this._memberTokens -= 1;
    const evt = normalizeMember(raw);
    this.emit('member', evt);
    return evt;
  }

  ingestRoomUser(raw) {
    const { count } = normalizeRoomUser(raw);
    if (count === this._status.viewers) return null;
    this._status = { ...this._status, viewers: count };
    this.emit('viewers', { count });
    return { count };
  }

  /* ---------------------------------------------------------------------------------------------
   * Simulation (panel / dev) — builds raw-looking payloads and feeds the real pipeline
   * ------------------------------------------------------------------------------------------- */

  /** Build a raw v3-like user for a simulated viewer (deterministic id `sim:<uniqueId>`). */
  _simUser({ nickname, uniqueId, avatarUrl } = {}) {
    const nick = str(nickname, '') || 'Visitante';
    const uid = (str(uniqueId, '') || normalizeName(nick).replace(/[^a-z0-9._]+/g, '_') || 'visitante').slice(0, 40);
    const user = { id: `sim:${uid}`, displayId: uid, nickname: nick };
    if (isHttpUrl(avatarUrl)) user.avatarThumb = { urlList: [avatarUrl] };
    else if (typeof avatarUrl === 'string' && avatarUrl.startsWith('data:image/')) user.avatarUrl = avatarUrl;
    else user.avatarUrl = avatarDataUri(nick, uid);
    return user;
  }

  /**
   * Simulate a gift. `streak: true` replays a real streak (N events with growing repeatCount and a
   * closing `repeatEnd`), spaced by ~120 ms; otherwise a single event with `count` units.
   * @returns {{ ok: true, streak: boolean, units: number, event?: object }}
   */
  simulateGift({ nickname, uniqueId, giftName, giftId, count = 1, diamondCount = 1, avatarUrl, giftImageUrl, streak = false } = {}) {
    const name = str(giftName, '') || 'Rosa';
    const units = Math.min(SIM_MAX_UNITS, Math.max(1, int(count, 1)));
    const coins = int(diamondCount, 1);
    const id = str(giftId, '') || `sim-${normalizeName(name).replace(/[^a-z0-9]+/g, '-') || 'gift'}`;
    const user = this._simUser({ nickname, uniqueId, avatarUrl });
    const gift = { id, name, type: streak ? 1 : 0, diamondCount: coins };
    if (isHttpUrl(giftImageUrl)) gift.image = { urlList: [giftImageUrl] };
    const groupId = `sim-${Date.now().toString(36)}-${(this._seq + 1).toString(36)}`;

    if (!streak) {
      const evt = this.ingestGift({ giftId: id, repeatCount: units, repeatEnd: 1, groupId, user, gift }, 'sim');
      return { ok: true, streak: false, units, event: evt };
    }

    for (let i = 1; i <= units; i++) {
      this._later(SIM_STREAK_STEP_MS * (i - 1), () => this.ingestGift({ giftId: id, repeatCount: i, repeatEnd: 0, groupId, user, gift }, 'sim'));
    }
    this._later(SIM_STREAK_STEP_MS * units + 300, () => this.ingestGift({ giftId: id, repeatCount: units, repeatEnd: 1, groupId, user, gift }, 'sim'));
    return { ok: true, streak: true, units };
  }

  simulateChat({ nickname, uniqueId, text, avatarUrl } = {}) {
    return this.ingestChat({ user: this._simUser({ nickname, uniqueId, avatarUrl }), content: str(text, '') || 'Olá!' });
  }

  simulateLike({ nickname, uniqueId, count = 1, avatarUrl } = {}) {
    const n = Math.max(1, int(count, 1));
    this._simLikes = (this._simLikes || 0) + n;
    return this.ingestLike({ user: this._simUser({ nickname, uniqueId, avatarUrl }), count: n, total: this._simLikes });
  }

  simulateFollow({ nickname, uniqueId, avatarUrl } = {}) {
    return this.ingestFollow({ user: this._simUser({ nickname, uniqueId, avatarUrl }) });
  }

  simulateShare({ nickname, uniqueId, avatarUrl } = {}) {
    return this.ingestShare({ user: this._simUser({ nickname, uniqueId, avatarUrl }) });
  }

  simulateMember({ nickname, uniqueId, avatarUrl } = {}) {
    return this.ingestMember({ user: this._simUser({ nickname, uniqueId, avatarUrl }) });
  }

  simulateViewers(count) {
    return this.ingestRoomUser({ total: String(int(count, 0)) });
  }

  _later(ms, fn) {
    const t = setTimeout(() => {
      this._simTimers.delete(t);
      if (this._destroyed) return;
      try {
        fn();
      } catch (err) {
        this.log.error?.('[tiktok] simulação falhou:', err);
      }
    }, ms);
    this._simTimers.add(t);
  }

  /** Release everything (process shutdown). */
  async destroy() {
    this._destroyed = true;
    for (const t of this._simTimers) clearTimeout(t);
    this._simTimers.clear();
    await this._teardown();
    this.removeAllListeners();
  }
}
