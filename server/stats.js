/**
 * stats.js — StatsStore: wins/losses/history + gifter leaderboard + small settings bag, persisted to
 * `data/stats.json` with debounced atomic writes (temp file + rename).
 *
 * File layout (version 1):
 * {
 *   version: 1,
 *   stats: { wins, losses, rounds, currentStreak, bestWinStreak, history: [...] },
 *   leaderboard: { scope: 'live', roomId, gifters: { [userId]: Gifter } },
 *   settings: { username: string|null, signApiKey: string|null, config: object }
 * }
 */

import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

const HISTORY_MAX = 50;
const TOP_MAX = 10;
const VERSION = 1;

function emptyStats() {
  return { wins: 0, losses: 0, rounds: 0, currentStreak: 0, bestWinStreak: 0, history: [] };
}

function emptyLeaderboard(roomId = null) {
  return { scope: 'live', roomId, gifters: {} };
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
    this.data = { version: VERSION, stats: emptyStats(), leaderboard: emptyLeaderboard(), settings: { username: null, signApiKey: null, config: {} } };
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
   * Public `Leaderboard` shape (SPEC §6.1 v2): overall top 10 desc by coins, plus the
   * VILÕES × HERÓIS battle — per-team coin totals and per-team top 3 (ranked by the coins
   * each gifter spent on THAT team).
   */
  get leaderboard() {
    const lb = this.data.leaderboard;
    const all = Object.values(lb.gifters).map((g) => ({
      villainCoins: 0,
      heroCoins: 0,
      ...g,
    }));
    const top = all
      .map((g) => ({ ...g }))
      .sort((a, b) => b.coins - a.coins || b.gifts - a.gifts || a.lastAt - b.lastAt)
      .slice(0, TOP_MAX);
    const teamTop = (key) => all
      .filter((g) => g[key] > 0)
      .map((g) => ({ ...g }))
      .sort((a, b) => b[key] - a[key] || a.lastAt - b.lastAt)
      .slice(0, 3);
    const total = (key) => all.reduce((acc, g) => acc + g[key], 0);
    return {
      scope: 'live',
      roomId: lb.roomId,
      leader: top[0] || null,
      top,
      teams: {
        villain: { coins: total('villainCoins'), top: teamTop('villainCoins') },
        hero: { coins: total('heroCoins'), top: teamTop('heroCoins') },
      },
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
    const gifters = this.data.leaderboard.gifters;
    const cur = gifters[user.userId] || {
      userId: user.userId, uniqueId: user.uniqueId, nickname: user.nickname, avatarUrl: user.avatarUrl,
      coins: 0, gifts: 0, villainCoins: 0, heroCoins: 0, lastAt: 0,
    };
    cur.villainCoins = n(cur.villainCoins);
    cur.heroCoins = n(cur.heroCoins);
    cur.uniqueId = user.uniqueId || cur.uniqueId;
    cur.nickname = user.nickname || cur.nickname;
    if (user.avatarUrl) cur.avatarUrl = user.avatarUrl;
    cur.coins += coins;
    cur.gifts += count;
    const team = evt?.team === 'hero' ? 'hero' : evt?.team === 'villain' ? 'villain' : null;
    // A 0-coin gift (e.g. some free stickers) still counts 1 "point" per unit for its team,
    // so cheap gifts visibly move the battle bar.
    const weight = coins > 0 ? coins : count;
    if (team === 'hero') cur.heroCoins += weight;
    else if (team === 'villain') cur.villainCoins += weight;
    cur.lastAt = Date.now();
    gifters[user.userId] = cur;
    this._schedule();
    return this.leaderboard;
  }

  /** Start a fresh leaderboard (new live / panel reset). */
  resetLeaderboard(roomId = this.data.leaderboard.roomId) {
    this.data.leaderboard = emptyLeaderboard(roomId === undefined || roomId === null ? null : String(roomId));
    this._schedule();
    return this.leaderboard;
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
