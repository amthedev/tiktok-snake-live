/**
 * stats.js — StatsStore: wins/losses/history + gifter leaderboards + live round state + a small
 * settings bag, persisted to `data/stats.json` with debounced atomic writes (temp file + rename).
 *
 * [persist] DOIS RANKINGS (pedido do cliente):
 *   • `leaderboard` — RANKING DA LIVE: moedas totais de cada presenteador. NUNCA zera durante a
 *     live; só em `resetLeaderboard()` (troca de roomId ou botão do painel).
 *   • `round` — RANKING DA RODADA: o duelo Vilões × Heróis do momento. `startRound(roundId)`
 *     zera só este bloco, a cada nova rodada.
 * `addGift()` alimenta os dois de uma vez, então nada é contado duas vezes nem fica dessincronizado.
 *
 * [persist] ESTADO DA RODADA (`live`): o servidor é a fonte da verdade da partida em andamento,
 * para que um F5 no overlay (ou um restart do servidor) retome a mesma rodada.
 *
 * File layout (version 2):
 * {
 *   version: 2,
 *   stats: { wins, losses, rounds, currentStreak, bestWinStreak, history: [...] },
 *   leaderboard: { scope: 'live', roomId, gifters: { [userId]: Gifter } },
 *   round: { roundId, startedAt, gifters: { [userId]: RoundGifter } },
 *   live: { roundId, phase, startedAt, elapsedMs, length, apples, bombsEaten, progress,
 *           goals: {...}, updatedAt },
 *   settings: { username: string|null, signApiKey: string|null, config: object }
 * }
 */

import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

const HISTORY_MAX = 50;
const TOP_MAX = 10;
const VERSION = 2;

function emptyStats() {
  return { wins: 0, losses: 0, rounds: 0, currentStreak: 0, bestWinStreak: 0, history: [] };
}

function emptyLeaderboard(roomId = null) {
  return { scope: 'live', roomId, gifters: {} };
}

/** [persist] Bloco do RANKING DA RODADA — zerado a cada `startRound()`. */
function emptyRound(roundId = 0) {
  return { roundId: n(roundId), startedAt: Date.now(), gifters: {} };
}

/** [persist] Estado autoritativo da rodada em andamento (retomada após F5 / restart). */
function emptyLive() {
  return {
    roundId: 0,
    phase: 'idle',
    startedAt: 0,
    elapsedMs: 0,
    length: 0,
    apples: 0,
    bombsEaten: 0,
    progress: 0,
    goals: null,
    updatedAt: 0,
  };
}

function n(v, fallback = 0) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export class StatsStore {
  /**
   * @param {{ path: string, log?: Console, debounceMs?: number }} opts
   */
  constructor({ path: filePath, log = console, debounceMs = 500 } = {}) {
    this.path = filePath || path.resolve('data/stats.json');
    this.log = log;
    this.debounceMs = debounceMs;
    this.data = {
      version: VERSION,
      stats: emptyStats(),
      leaderboard: emptyLeaderboard(),
      round: emptyRound(0),   // [persist] ranking da rodada
      live: emptyLive(),      // [persist] estado autoritativo da rodada
      settings: { username: null, signApiKey: null, config: {} },
    };
    this._timer = null;
    this._writing = null; // in-flight write promise
    this._dirty = false;
    this._closed = false;
  }

  /* ---------------------------------------------------------------------------------------------
   * Persistence
   * ------------------------------------------------------------------------------------------- */

  /** Load from disk (missing file → fresh store; corrupt file → backed up and replaced). */
  async load() {
    let text;
    try {
      text = await fsp.readFile(this.path, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return this;
      throw err;
    }
    try {
      const parsed = JSON.parse(text);
      this._adopt(parsed);
    } catch (err) {
      const backup = `${this.path}.corrupt-${Date.now()}`;
      this.log.warn?.(`[stats] data/stats.json inválido (${err.message}); backup em ${backup}`);
      try {
        await fsp.rename(this.path, backup);
      } catch {
        /* ignore */
      }
    }
    return this;
  }

  /** Merge a parsed file into memory, tolerating missing/garbled sections. */
  _adopt(parsed) {
    const src = parsed && typeof parsed === 'object' ? parsed : {};
    const s = src.stats && typeof src.stats === 'object' ? src.stats : {};
    const lb = src.leaderboard && typeof src.leaderboard === 'object' ? src.leaderboard : {};
    const settings = src.settings && typeof src.settings === 'object' ? src.settings : {};
    // [persist] Arquivos da versão 1 não têm `round`/`live`: entram vazios (ranking da rodada
    // começa zerado e a retomada só acontece a partir do próximo snapshot).
    const rd = src.round && typeof src.round === 'object' ? src.round : {};
    const lv = src.live && typeof src.live === 'object' ? src.live : {};
    this.data = {
      version: VERSION,
      stats: {
        wins: n(s.wins),
        losses: n(s.losses),
        rounds: n(s.rounds),
        currentStreak: n(s.currentStreak),
        bestWinStreak: n(s.bestWinStreak),
        history: Array.isArray(s.history) ? s.history.filter((h) => h && typeof h === 'object').slice(0, HISTORY_MAX) : [],
      },
      leaderboard: {
        scope: 'live',
        roomId: lb.roomId === undefined || lb.roomId === null ? null : String(lb.roomId),
        gifters: lb.gifters && typeof lb.gifters === 'object' && !Array.isArray(lb.gifters) ? lb.gifters : {},
      },
      // [persist] ranking da rodada
      round: {
        roundId: n(rd.roundId),
        startedAt: n(rd.startedAt, Date.now()),
        gifters: rd.gifters && typeof rd.gifters === 'object' && !Array.isArray(rd.gifters) ? rd.gifters : {},
      },
      // [persist] estado autoritativo da rodada
      live: {
        ...emptyLive(),
        roundId: n(lv.roundId),
        phase: typeof lv.phase === 'string' ? lv.phase : 'idle',
        startedAt: n(lv.startedAt),
        elapsedMs: n(lv.elapsedMs),
        length: n(lv.length),
        apples: n(lv.apples),
        bombsEaten: n(lv.bombsEaten),
        progress: n(lv.progress),
        goals: lv.goals && typeof lv.goals === 'object' && !Array.isArray(lv.goals) ? lv.goals : null,
        updatedAt: n(lv.updatedAt),
      },
      settings: {
        username: typeof settings.username === 'string' ? settings.username : null,
        signApiKey: typeof settings.signApiKey === 'string' && settings.signApiKey ? settings.signApiKey : null,
        config: settings.config && typeof settings.config === 'object' ? settings.config : {},
      },
    };
  }

  /** Schedule a debounced write. */
  _schedule() {
    this._dirty = true;
    if (this._closed || this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush().catch((err) => this.log.error?.('[stats] falha ao salvar:', err.message));
    }, this.debounceMs);
    this._timer.unref?.();
  }

  /** Write now (serialized: a write in flight is awaited first). */
  async flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._writing) await this._writing;
    if (!this._dirty) return;
    this._dirty = false;
    const snapshot = JSON.stringify(this.data, null, 2) + '\n';
    this._writing = (async () => {
      await fsp.mkdir(path.dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, snapshot, 'utf8');
      await fsp.rename(tmp, this.path);
    })();
    try {
      await this._writing;
    } finally {
      this._writing = null;
    }
    // Something changed while we were writing → write again.
    if (this._dirty) await this.flush();
  }

  /** Synchronous write for process exit handlers. */
  flushSync() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (!this._dirty) return;
    try {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.sync.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, this.path);
      this._dirty = false;
    } catch (err) {
      this.log.error?.('[stats] falha ao salvar (sync):', err.message);
    }
  }

  async close() {
    this._closed = true;
    await this.flush();
  }

  /* ---------------------------------------------------------------------------------------------
   * Stats (rounds)
   * ------------------------------------------------------------------------------------------- */

  /** Public `Stats` shape (SPEC §6.1). */
  get stats() {
    const s = this.data.stats;
    return {
      wins: s.wins,
      losses: s.losses,
      rounds: s.rounds,
      currentStreak: s.currentStreak,
      bestWinStreak: s.bestWinStreak,
      history: s.history.map((h) => ({ ...h })),
    };
  }

  /**
   * Record a finished round.
   * @param {{ roundId, result: 'win'|'loss', apples, bombsEaten, length, durationMs }} summary
   * @returns {object} updated Stats
   */
  recordRound(summary = {}) {
    const s = this.data.stats;
    const result = summary.result === 'win' ? 'win' : 'loss';
    s.rounds += 1;
    if (result === 'win') {
      s.wins += 1;
      s.currentStreak = s.currentStreak >= 0 ? s.currentStreak + 1 : 1;
      if (s.currentStreak > s.bestWinStreak) s.bestWinStreak = s.currentStreak;
    } else {
      s.losses += 1;
      s.currentStreak = s.currentStreak <= 0 ? s.currentStreak - 1 : -1;
    }
    const leader = this.leaderboard.leader;
    s.history.unshift({
      roundId: n(summary.roundId, s.rounds),
      result,
      apples: n(summary.apples),
      bombsEaten: n(summary.bombsEaten),
      length: n(summary.length),
      durationMs: n(summary.durationMs),
      endedAt: Date.now(),
      topGifter: leader ? { userId: leader.userId, uniqueId: leader.uniqueId, nickname: leader.nickname, avatarUrl: leader.avatarUrl, coins: leader.coins } : null,
    });
    if (s.history.length > HISTORY_MAX) s.history.length = HISTORY_MAX;
    this._schedule();
    return this.stats;
  }

  resetStats() {
    this.data.stats = emptyStats();
    this._schedule();
    return this.stats;
  }

  /* ---------------------------------------------------------------------------------------------
   * Leaderboard (scope: live)
   * ------------------------------------------------------------------------------------------- */

  /**
   * Per-team totals + top 3 out of a `gifters` bag. Shared by the live ranking and the
   * round ranking so both are computed exactly the same way.
   */
  _teams(gifters) {
    const all = Object.values(gifters).map((g) => ({ villainCoins: 0, heroCoins: 0, coins: 0, gifts: 0, lastAt: 0, ...g }));
    const teamTop = (key) => all
      .filter((g) => n(g[key]) > 0)
      .map((g) => ({ ...g }))
      .sort((a, b) => n(b[key]) - n(a[key]) || n(a.lastAt) - n(b.lastAt))
      .slice(0, 3);
    const total = (key) => all.reduce((acc, g) => acc + n(g[key]), 0);
    return {
      all,
      teams: {
        villain: { coins: total('villainCoins'), top: teamTop('villainCoins') },
        hero: { coins: total('heroCoins'), top: teamTop('heroCoins') },
      },
    };
  }

  /**
   * [persist] RANKING DA RODADA — só o duelo do momento (zerado por `startRound`).
   * @returns {{ roundId:number, startedAt:number, villain:{coins,top}, hero:{coins,top}, top:Gifter[] }}
   */
  get roundLeaderboard() {
    const rd = this.data.round;
    const { all, teams } = this._teams(rd.gifters);
    const top = all
      .map((g) => ({ ...g }))
      .sort((a, b) => n(b.coins) - n(a.coins) || n(b.gifts) - n(a.gifts) || n(a.lastAt) - n(b.lastAt))
      .slice(0, TOP_MAX);
    return {
      roundId: rd.roundId,
      startedAt: rd.startedAt,
      villain: teams.villain,
      hero: teams.hero,
      top,
    };
  }

  /**
   * Public `Leaderboard` shape (SPEC §6.1 v2): overall top 10 desc by coins, plus the
   * VILÕES × HERÓIS battle — per-team coin totals and per-team top 3 (ranked by the coins
   * each gifter spent on THAT team).
   *
   * [persist] `teams` continua sendo o acumulado da LIVE (compatibilidade: hud.js já lê isso),
   * e o bloco novo `round` traz o duelo DA RODADA ATUAL, que é o que a barra de cabo de guerra
   * passa a usar.
   */
  get leaderboard() {
    const lb = this.data.leaderboard;
    const { all, teams } = this._teams(lb.gifters);
    const top = all
      .map((g) => ({ ...g }))
      .sort((a, b) => b.coins - a.coins || b.gifts - a.gifts || a.lastAt - b.lastAt)
      .slice(0, TOP_MAX);
    return {
      scope: 'live',
      roomId: lb.roomId,
      leader: top[0] || null,
      top,
      teams,
      round: this.roundLeaderboard, // [persist] ranking da rodada, lado a lado com o da live
    };
  }

  /**
   * Add a counted gift event. Only `coins > 0` or `count > 0` events change anything.
   * `team` ('villain' | 'hero') feeds the battle totals; 1-coin gifts still move the war.
   * @param {{ user: UserRef, coins: number, count: number, team?: string }} evt
   * @returns {object} updated Leaderboard
   */
  addGift(evt) {
    const user = evt?.user;
    const coins = Math.max(0, n(evt?.coins));
    const count = Math.max(0, n(evt?.count));
    if (!user || !user.userId || (coins === 0 && count === 0)) return this.leaderboard;
    const team = evt?.team === 'hero' ? 'hero' : evt?.team === 'villain' ? 'villain' : null;
    // A 0-coin gift (e.g. some free stickers) still counts 1 "point" per unit for its team,
    // so cheap gifts visibly move the battle bar.
    const weight = coins > 0 ? coins : count;
    const at = Date.now();
    // [persist] O MESMO presente entra nas duas contabilidades: ranking da LIVE (acumulado) e
    // ranking da RODADA (zerado a cada rodada).
    this._creditGifter(this.data.leaderboard.gifters, user, { coins, count, team, weight, at });
    this._creditGifter(this.data.round.gifters, user, { coins, count, team, weight, at });
    this._schedule();
    return this.leaderboard;
  }

  /** [persist] Soma um presente num bag de gifters (usado pelos dois rankings). */
  _creditGifter(gifters, user, { coins, count, team, weight, at }) {
    const cur = gifters[user.userId] || {
      userId: user.userId, uniqueId: user.uniqueId, nickname: user.nickname, avatarUrl: user.avatarUrl,
      coins: 0, gifts: 0, villainCoins: 0, heroCoins: 0, lastAt: 0,
    };
    cur.coins = n(cur.coins);
    cur.gifts = n(cur.gifts);
    cur.villainCoins = n(cur.villainCoins);
    cur.heroCoins = n(cur.heroCoins);
    cur.uniqueId = user.uniqueId || cur.uniqueId;
    cur.nickname = user.nickname || cur.nickname;
    if (user.avatarUrl) cur.avatarUrl = user.avatarUrl;
    cur.coins += coins;
    cur.gifts += count;
    if (team === 'hero') cur.heroCoins += weight;
    else if (team === 'villain') cur.villainCoins += weight;
    cur.lastAt = at;
    gifters[user.userId] = cur;
    return cur;
  }

  /**
   * [persist] Nova rodada: zera SÓ o ranking da rodada. O ranking da live continua intacto.
   * @param {number} roundId
   */
  startRound(roundId = 0) {
    this.data.round = emptyRound(roundId);
    this._schedule();
    return this.roundLeaderboard;
  }

  /**
   * Start a fresh leaderboard (new live / panel reset).
   * [persist] Zerar a live também zera a rodada — senão a barra de cabo de guerra continuaria
   * mostrando moedas de um ranking que já não existe.
   */
  resetLeaderboard(roomId = this.data.leaderboard.roomId) {
    this.data.leaderboard = emptyLeaderboard(roomId === undefined || roomId === null ? null : String(roomId));
    this.data.round = emptyRound(this.data.round?.roundId ?? 0);
    this._schedule();
    return this.leaderboard;
  }

  /* ---------------------------------------------------------------------------------------------
   * [persist] Live round state — o servidor é o dono da rodada em andamento
   * ------------------------------------------------------------------------------------------- */

  /** Estado corrente da rodada (cópia). `updatedAt: 0` = nunca recebeu snapshot. */
  get live() {
    const l = this.data.live;
    return { ...l, goals: l.goals ? { ...l.goals } : null };
  }

  /**
   * Rodada começou (mensagem 'round_start' do overlay dono). Zera o tempo decorrido e as
   * contagens da rodada; NÃO mexe nas metas (são progresso da live inteira) nem no ranking
   * da live.
   */
  beginLiveRound(roundId, { startedAt = Date.now() } = {}) {
    const goals = this.data.live.goals;
    this.data.live = {
      ...emptyLive(),
      roundId: n(roundId),
      phase: 'countdown',
      startedAt: n(startedAt, Date.now()),
      goals: goals ? { ...goals } : null,
      updatedAt: Date.now(),
    };
    this._schedule();
    return this.live;
  }

  /**
   * Snapshot periódico do overlay dono (1 Hz). Guarda o suficiente para retomar a rodada.
   * A escrita é debounced pelo próprio store, então 1 snapshot/s não vira 1 write/s.
   */
  updateLive(patch = {}) {
    const l = this.data.live;
    const next = {
      roundId: n(patch.roundId, l.roundId),
      phase: typeof patch.phase === 'string' ? patch.phase : l.phase,
      startedAt: n(patch.startedAt, l.startedAt),
      elapsedMs: Math.max(0, n(patch.elapsedMs, l.elapsedMs)),
      length: n(patch.length, l.length),
      apples: n(patch.apples, l.apples),
      bombsEaten: n(patch.bombsEaten, l.bombsEaten),
      progress: Math.max(0, Math.min(1, n(patch.progress, l.progress))),
      goals: patch.goals && typeof patch.goals === 'object' ? { ...patch.goals } : l.goals,
      updatedAt: Date.now(),
    };
    // Uma rodada nova chegando por snapshot (sem round_start) também reinicia os contadores.
    if (next.roundId !== l.roundId) next.startedAt = n(patch.startedAt, Date.now());
    this.data.live = next;
    this._schedule();
    return this.live;
  }

  /** Rodada terminou: marca a fase para que uma reconexão não tente retomar uma partida morta. */
  endLiveRound(result) {
    this.data.live = {
      ...this.data.live,
      phase: result === 'win' ? 'won' : 'lost',
      updatedAt: Date.now(),
    };
    this._schedule();
    return this.live;
  }

  /**
   * A rodada guardada ainda vale a pena retomar?
   * @param {number} maxAgeMs estado sem snapshot há mais que isso → rodada nova
   */
  isLiveFresh(maxAgeMs = 5 * 60 * 1000) {
    const l = this.data.live;
    if (!l.updatedAt || !l.roundId) return false;
    if (l.phase === 'won' || l.phase === 'lost' || l.phase === 'idle') return false;
    return Date.now() - l.updatedAt <= maxAgeMs;
  }

  /* ---------------------------------------------------------------------------------------------
   * Settings
   * ------------------------------------------------------------------------------------------- */

  get settings() {
    return { ...this.data.settings, config: { ...this.data.settings.config } };
  }

  setSetting(key, value) {
    this.data.settings[key] = value;
    this._schedule();
  }
}
