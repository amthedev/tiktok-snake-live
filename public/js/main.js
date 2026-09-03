// public/js/main.js
// Bootstrap + game loop + glue between GameState, Renderer3D, HUD, audio and the WebSocket (SPEC §9).
//
// Resilience rules:
//  * The renderer/state modules are imported dynamically inside try/catch so a missing or broken module
//    never leaves the OBS source blank: the HUD still renders and a pt-BR toast explains the problem.
//  * The rAF loop is wrapped in try/catch: an exception shows a red toast and rendering continues.
//    In OBS mode, if exceptions keep happening for 60 s the page reloads itself.
//  * All network handlers are guarded; malformed payloads are ignored.

import { loadConfig, saveLocalConfig } from './config.js';
import { createNet } from './net.js';
import { createAudio } from './audio.js';
import { createHud } from './ui/hud.js';

const HELLO_TIMEOUT_MS = 2000;
const HUD_HZ = 10;
const SNAPSHOT_HZ = 1;
const MAX_STEPS_PER_FRAME = 6;      // spiral-of-death guard when a frame is very late
const ERROR_TOAST_GAP_MS = 5000;
const ERROR_RELOAD_AFTER_MS = 60000;
const ERROR_QUIET_RESET_MS = 10000;

// Dev-panel gift presets. Names match the pt-BR aliases in config/gifts.json (matching is
// case/diacritic-insensitive); when online the server resolves the rule, offline we use `bombs`/`effect`.
const SIM_GIFTS = {
  rose:   { giftName: 'Rosa',    giftId: '5655', diamondCount: 1,     count: 1, team: 'villain', tier: 'normal',  effects: { bombs: 1 } },
  gg:     { giftName: 'GG',      giftId: '',     diamondCount: 1,     count: 1, team: 'hero',    tier: 'normal',  effects: { food: 1 } },
  crane:  { giftName: 'Tsuru de Papel', giftId: '', diamondCount: 99, count: 1, team: 'hero',    tier: 'normal',  effects: { grow: 3 } },
  swan:   { giftName: 'Cisne',   giftId: '',     diamondCount: 699,   count: 1, team: 'hero',    tier: 'mega',    effects: { clearBombs: true } },
  galaxy: { giftName: 'Galáxia', giftId: '',     diamondCount: 1000,  count: 1, team: 'hero',    tier: 'mega',    effects: { clearBombs: true, shieldSec: 30 } },
  moto:   { giftName: 'Moto',    giftId: '',     diamondCount: 2988,  count: 1, team: 'villain', tier: 'mega',    effects: { bombs: 20, attack: 4 } },
  lion:   { giftName: 'Leão',    giftId: '',     diamondCount: 29999, count: 1, team: 'villain', tier: 'supreme', effects: { bombs: 40, attack: 6 } },
  universe: { giftName: 'Universo TikTok', giftId: '', diamondCount: 44999, count: 1, team: 'hero', tier: 'supreme', effects: { grow: 15, food: 10, clearBombs: true, shieldSec: 60 } }
};

const SIM_NAMES = ['Ana', 'Bruno', 'Carla', 'Diego', 'Eduarda', 'Felipe', 'Gabi', 'Heitor'];
const SIM_CHATS = ['vai cobra!!!', 'manda bomba kkk', 'que jogo é esse?', 'cobra brava 🐍', 'GG', 'bora vencer', 'kkkkkk'];

const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------------------------

class App {
  constructor() {
    this.config = loadConfig();
    this.net = null;
    this.hud = null;
    this.audio = null;
    this.renderer = null;
    this.state = null;
    this.hello = null;
    this.latestStats = null;
    this.latestLeaderboard = null;
    this.viewers = 0;

    this.paused = false;
    this.progress = 0;
    this.elapsed = 0;
    this.lastFrameTs = 0;
    this.rafId = 0;
    this.hudAcc = 0;
    this.snapAcc = 0;
    this.roundToken = 0;         // incremented every time a new round is requested (cancels pending waits)
    this.roundBusy = false;      // true while countdown / round-end overlays are running
    this.pendingConfig = null;   // set_config from the panel: applied on the next round
    this.items = new Set();      // ids of items currently registered in the renderer
    this.rendererBoard = null;   // {w,h} last passed to renderer.setBoard
    this.errors = { firstAt: 0, lastAt: 0, count: 0, lastToastAt: 0 };
    this.devStatus = document.getElementById('dev-status');
    this.gameReady = false;
  }

  // ---- bootstrap ---------------------------------------------------------------------------

  async boot() {
    const root = document.getElementById('hud') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'hud' }));
    this.hud = createHud(root, { obs: this.config.obs });
    this.audio = createAudio(this.config.audio, { autoResume: true });
    this.net = createNet(this.config.wsUrl, { log: (m, e) => console.warn(m, e) });
    this.bindNet();
    this.bindDevPanel();
    this.bindHotkeys();
    this.bindWindow();
    this.setDevStatus('conectando ao servidor…');

    // Wait for hello (max 2 s) so server config overrides apply before the state is created.
    const hello = await this.net.waitFor('hello', HELLO_TIMEOUT_MS);
    if (hello) {
      this.applyHello(hello);
    } else {
      this.hud.showToast('Servidor não respondeu — jogando offline com a configuração padrão', 'warn');
    }
    // Final config precedence: URL > hello.config > localStorage > DEFAULTS
    this.config = loadConfig(hello?.config || null);
    this.audio.setEnabled(this.config.audio);
    document.body.classList.toggle('obs', this.config.obs);

    // Load the game modules (written by other engineers) defensively.
    let Renderer3D = null;
    let GameState = null;
    try {
      const [r, s] = await Promise.all([import('./render/renderer.js'), import('./game/state.js')]);
      Renderer3D = r.Renderer3D;
      GameState = s.GameState;
      if (typeof Renderer3D !== 'function' || typeof GameState !== 'function') {
        throw new Error('exports Renderer3D/GameState ausentes');
      }
    } catch (err) {
      console.error('[main] falha ao carregar módulos do jogo', err);
      this.hud.showToast('Falha ao carregar os módulos do jogo: ' + shortError(err), 'error');
      this.setDevStatus('módulos do jogo indisponíveis');
      this.startIdleLoop();
      return;
    }

    try {
      this.renderer = new Renderer3D(document.getElementById('stage'), { gridSize: this.config.gridSize, quality: this.config.quality });
      this.renderer.resize();
    } catch (err) {
      console.error('[main] falha ao iniciar o renderizador', err);
      this.hud.showToast('Falha ao iniciar o renderizador 3D: ' + shortError(err), 'error');
      this.renderer = null;
    }

    try {
      this.state = new GameState(this.config);
    } catch (err) {
      console.error('[main] falha ao criar o estado do jogo', err);
      this.hud.showToast('Falha ao criar o estado do jogo: ' + shortError(err), 'error');
      this.startIdleLoop();
      return;
    }

    if (this.latestLeaderboard) this.safe(() => this.renderer?.setLeader(this.latestLeaderboard.leader || null));
    else this.safe(() => this.renderer?.setLeader(null));

    this.gameReady = true;
    this.setDevStatus('pronto');
    this.startLoop();
    this.startRound();
  }

  applyHello(hello) {
    this.hello = hello;
    if (hello.stats) { this.latestStats = hello.stats; this.hud.setStats(hello.stats); }
    if (hello.leaderboard) { this.latestLeaderboard = hello.leaderboard; this.hud.setLeaderboard(hello.leaderboard); }
    if (hello.tiktok) this.hud.setTiktokStatus(hello.tiktok);
  }

  // ---- round lifecycle ---------------------------------------------------------------------

  /** Start a brand-new round (cancels any countdown/round-end wait in progress). */
  async startRound() {
    if (!this.gameReady || !this.state) return;
    const token = ++this.roundToken;
    this.roundBusy = true;
    this.hud.hideOverlays();
    try {
      // Apply config changes requested by the panel (set_config) before the state is reset.
      if (this.pendingConfig) {
        const patch = this.pendingConfig;
        this.pendingConfig = null;
        saveLocalConfig(patch);
        this.config = loadConfig(this.hello?.config || null);
        this.state = new this.state.constructor(this.config);
        this.audio.setEnabled(this.config.audio);
      }

      this.state.reset();
      this.progress = 0;
      this.paused = false;
      const snap = this.state.snapshot;

      // Sync the renderer with the fresh board.
      this.clearRendererItems();
      if (this.renderer) {
        const cur = this.rendererBoard || { w: 0, h: 0 };
        if (cur.w !== snap.w || cur.h !== snap.h) {
          this.safe(() => this.renderer.setBoard(snap.w, snap.h));
          this.rendererBoard = { w: snap.w, h: snap.h };
        }
        this.safe(() => this.renderer.setPhase('countdown'));
        this.safe(() => this.renderer.updateSnake({ cells: snap.snake, dir: snap.dir, prevDir: snap.prevDir, progress: 0, phase: snap.phase }));
      }
      if (snap.apple) {
        this.addItem('apple', () => this.renderer?.addApple('apple', snap.apple.x, snap.apple.z));
      } else {
        this.dispatch(this.state.spawnApple());
      }
      this.hud.update(this.state.snapshot);

      await this.hud.showCountdown(snap.roundId, this.config.countdownSec, { onTick: () => this.audio.play('tick') });
      if (token !== this.roundToken) return; // a newer round superseded this one

      this.state.start();
      this.audio.play('start');
      this.safe(() => this.renderer?.setPhase('playing'));
      this.net.send('round_start', { roundId: snap.roundId });
      this.hud.flash('green');
    } catch (err) {
      this.reportError(err, 'iniciar rodada');
    } finally {
      if (token === this.roundToken) this.roundBusy = false;
    }
  }

  /** Called from the loop when a 'win' or 'lose' event arrives. */
  async endRound(ev) {
    const token = this.roundToken;
    this.roundBusy = true;
    const win = ev.type === 'win';
    const snap = this.state.snapshot;
    const summary = ev.summary || {
      result: win ? 'win' : 'loss',
      apples: snap.apples, bombsEaten: snap.bombsEaten, length: snap.length,
      durationMs: snap.durationMs, roundId: snap.roundId
    };
    try {
      this.safe(() => this.renderer?.setPhase(win ? 'won' : 'lost'));
      this.audio.play(win ? 'win' : 'lose');
      this.hud.flash(win ? 'gold' : 'red');
      if (!win) this.safe(() => this.renderer?.shake(2));
      this.net.send('round_end', {
        roundId: summary.roundId ?? snap.roundId,
        result: summary.result || (win ? 'win' : 'loss'),
        apples: summary.apples ?? 0,
        bombsEaten: summary.bombsEaten ?? 0,
        length: summary.length ?? 0,
        durationMs: summary.durationMs ?? 0
      });
      // Give the server a moment to broadcast the updated stats before the panel shows.
      await sleep(250);
      if (token !== this.roundToken) return;
      await this.hud.showRoundEnd(summary, this.config.roundRestartDelaySec, this.latestStats);
      if (token !== this.roundToken) return;
    } catch (err) {
      this.reportError(err, 'fim de rodada');
      await sleep(Math.max(1000, this.config.roundRestartDelaySec * 1000));
      if (token !== this.roundToken) return;
    }
    this.startRound();
  }

  // ---- render loop -------------------------------------------------------------------------

  startLoop() {
    if (this.rafId) return;
    this.lastFrameTs = performance.now();
    const frame = (ts) => {
      this.rafId = requestAnimationFrame(frame);
      this.tickFrame(ts);
    };
    this.rafId = requestAnimationFrame(frame);
  }

  /** Loop used when the game modules failed to load: keeps the HUD alive (timers) and nothing else. */
  startIdleLoop() {
    if (this.rafId) return;
    const frame = () => { this.rafId = requestAnimationFrame(frame); };
    this.rafId = requestAnimationFrame(frame);
  }

  tickFrame(ts) {
    const dt = clamp((ts - this.lastFrameTs) / 1000, 0, 0.1);
    this.lastFrameTs = ts;
    this.elapsed += dt;
    try {
      const state = this.state;
      let snap = state.snapshot;

      if (!this.paused && snap.phase === 'playing') {
        this.progress += (snap.speed || 0) * dt;
        let steps = 0;
        while (this.progress >= 1 && steps < MAX_STEPS_PER_FRAME) {
          this.progress -= 1;
          steps += 1;
          const events = state.step();
          const ended = this.dispatch(events);
          if (ended) { this.progress = 0; break; }
        }
        if (this.progress >= 1) this.progress = 0.999; // frame was extremely late: drop the backlog
      }
      if (!this.paused && snap.phase !== 'won' && snap.phase !== 'lost') {
        this.dispatch(state.tick(dt));
      }

      snap = state.snapshot;
      if (this.renderer) {
        const visualProgress = snap.phase === 'playing' ? clamp(this.progress, 0, 1) : 0;
        this.renderer.updateSnake({ cells: snap.snake, dir: snap.dir, prevDir: snap.prevDir, progress: visualProgress, phase: snap.phase });
      }

      this.hudAcc += dt;
      if (this.hudAcc >= 1 / HUD_HZ) {
        this.hudAcc = 0;
        this.hud.update(snap);
        if (this.renderer && Array.isArray(snap.bombs)) {
          for (const b of snap.bombs) {
            if (Number.isFinite(b.fuseLeft)) this.renderer.setBombFuse(b.id, b.fuseLeft);
          }
        }
      }

      this.snapAcc += dt;
      if (this.snapAcc >= 1 / SNAPSHOT_HZ) {
        this.snapAcc = 0;
        this.net.send('snapshot', {
          roundId: snap.roundId, phase: snap.phase, length: snap.length, danger: snap.danger === true, paused: this.paused === true,
          apples: snap.apples, bombs: Array.isArray(snap.bombs) ? snap.bombs.length : 0, progress: snap.progress
        }, { queue: false });
      }

      if (this.renderer) this.renderer.frame(dt, this.elapsed);
      this.noteQuietFrame();
    } catch (err) {
      this.reportError(err, 'loop');
      // Keep rendering even when the game logic threw.
      try { this.renderer?.frame(dt, this.elapsed); } catch { /* renderer broken too: nothing more to do */ }
    }
  }

  // ---- game events → renderer / hud / audio -------------------------------------------------

  /** Dispatch GameEvents. Returns true when the round ended (win/lose). */
  dispatch(events) {
    if (!Array.isArray(events) || events.length === 0) return false;
    let ended = false;
    for (const ev of events) {
      if (!ev || typeof ev !== 'object') continue;
      try {
        switch (ev.type) {
          case 'move':
            break;
          case 'eat_apple':
            this.removeItem('apple', 'eaten');
            this.audio.play('eat');
            break;
          case 'apple_spawn':
            this.addItem('apple', () => this.renderer?.addApple('apple', ev.x, ev.z));
            break;
          case 'eat_bomb':
            this.removeItem(ev.id, 'eaten');
            this.safe(() => this.renderer?.explode(ev.x, ev.z, { color: 0xff3b3b, size: 1.2 }));
            this.safe(() => this.renderer?.shake(1));
            this.hud.flash('red');
            this.audio.play('bomb');
            if (ev.shielded) this.hud.showToast('🛡️ O escudo segurou a bomba!', 'success');
            else if (!ev.fatal) this.hud.showToast(`💥 Bomba! A cobra encolheu −${ev.shrink ?? this.config.bombShrink} · tamanho ${ev.length}`, 'warn');
            break;
          case 'bomb_spawn':
            this.addItem(ev.id, () => this.renderer?.addBomb(ev.id, ev.x, ev.z, {
              fuseSec: ev.fuseSec > 0 ? ev.fuseSec : Infinity,
              giftImageUrl: ev.meta?.giftImageUrl ?? null,
              nickname: ev.meta?.nickname ?? undefined
            }));
            break;
          case 'bomb_expire':
            this.removeItem(ev.id, 'expired');
            this.audio.play('expire');
            break;
          case 'bomb_clear':
            for (const id of ev.ids || []) this.removeItem(id, 'cleared');
            break;
          case 'food_spawn':
            this.addItem(ev.id, () => (this.renderer?.addFood ?? this.renderer?.addApple)?.call(this.renderer, ev.id, ev.x, ev.z, { golden: true, meta: ev.meta }));
            break;
          case 'eat_food':
            this.removeItem(ev.id, 'eaten');
            this.audio.play('eat');
            this.safe(() => this.renderer?.explode(ev.x, ev.z, { color: 0xfbbf24, size: 0.9 }));
            break;
          case 'food_expire':
            this.removeItem(ev.id, 'expired');
            break;
          case 'grow':
            this.hud.showToast(`🍀 A cobra vai crescer +${ev.amount}!`, 'success');
            break;
          case 'grow_step':
            break;
          case 'attack':
            if (ev.shrink > 0 || ev.fromCredit > 0) {
              this.safe(() => this.renderer?.shake(1.2));
              this.hud.flash('red');
              this.audio.play('bomb');
              this.hud.showToast(`⚔️ Ataque vilão! A cobra perdeu ${ev.shrink + (ev.fromCredit || 0)} segmento${ev.shrink + (ev.fromCredit || 0) === 1 ? '' : 's'}`, 'warn');
            }
            break;
          case 'shield_start':
            this.safe(() => this.renderer?.setShield?.(true));
            this.hud.showToast(`🛡️ Escudo ativado! ${Math.round(ev.seconds)} s de proteção`, 'success');
            break;
          case 'shield_end':
            this.safe(() => this.renderer?.setShield?.(false));
            this.hud.showToast('🛡️ O escudo acabou…', 'info');
            break;
          case 'win':
          case 'lose':
            ended = true;
            this.endRound(ev);
            break;
          case 'start':
          default:
            break;
        }
      } catch (err) {
        this.reportError(err, 'evento ' + ev.type);
      }
      if (ended) break;
    }
    return ended;
  }

  addItem(id, fn) {
    if (!this.renderer) return;
    if (this.items.has(id)) this.safe(() => this.renderer.removeItem(id, 'cleared'));
    this.items.add(id);
    this.safe(fn);
  }

  removeItem(id, reason) {
    if (!this.items.has(id)) return;
    this.items.delete(id);
    if (this.renderer) this.safe(() => this.renderer.removeItem(id, reason));
  }

  clearRendererItems() {
    for (const id of Array.from(this.items)) this.removeItem(id, 'cleared');
    this.items.clear();
  }

  // ---- network -----------------------------------------------------------------------------

  bindNet() {
    const net = this.net;
    net.on('open', () => { this.hud.setConnection(true); this.setDevStatus('online'); });
    net.on('close', () => { this.hud.setConnection(false); this.setDevStatus('offline — reconectando…'); });
    net.on('reconnecting', ({ attempt, delayMs }) => this.setDevStatus(`reconectando (${attempt}) em ${Math.round(delayMs / 1000)}s`));
    net.on('bad_message', () => console.warn('[net] mensagem inválida ignorada'));

    net.on('hello', (msg) => {
      // Re-sent after every reconnect: refresh stats/leaderboard/status.
      this.applyHello(msg);
      if (this.latestLeaderboard) this.safe(() => this.renderer?.setLeader(this.latestLeaderboard.leader || null));
    });
    net.on('tiktok_status', (msg) => this.hud.setTiktokStatus(msg));
    net.on('viewers', (msg) => this.hud.setViewers(msg.count));
    net.on('stats', (msg) => { this.latestStats = msg; this.hud.setStats(msg); });
    net.on('leaderboard', (msg) => {
      this.latestLeaderboard = msg;
      this.hud.setLeaderboard(msg);
      this.safe(() => this.renderer?.setLeader(msg.leader || null));
    });
    net.on('gift', (msg) => this.onGift(msg));
    net.on('chat', (msg) => this.hud.pushChat(msg));
    net.on('like', (msg) => this.hud.showLike(msg));
    net.on('follow', (msg) => this.hud.showSocial('follow', msg.user));
    net.on('share', (msg) => this.hud.showSocial('share', msg.user));
    net.on('member', (msg) => this.hud.showSocial('member', msg.user));
    net.on('command', (msg) => this.onCommand(msg));
  }

  onGift(ev) {
    try {
      if (!ev || !ev.rule) return;
      const rule = ev.rule;
      const count = Number(ev.count) || 0;
      if (rule.show) this.hud.showGift(ev);
      if (count <= 0) return; // streak close of an already counted event: nothing to spawn
      const fx = rule.effects && typeof rule.effects === 'object' ? rule.effects : { bombs: Number(rule.bombs) || 0 };
      const tier = rule.tier === 'supreme' ? 'supreme' : rule.tier === 'mega' || rule.effect === 'mega' ? 'mega' : 'normal';
      const anyEffect = (fx.bombs | fx.food | fx.grow | fx.attack) > 0 || fx.shieldSec > 0 || fx.clearBombs === true;
      if (rule.show || anyEffect) this.audio.play(tier === 'normal' ? 'gift' : 'mega');
      if (!this.state) return;
      const meta = {
        giftName: ev.giftName, giftImageUrl: ev.giftImageUrl ?? null, team: rule.team ?? null,
        nickname: ev.user?.nickname ?? '', avatarUrl: ev.user?.avatarUrl ?? null
      };
      let popCell = null;
      const track = (events) => {
        if (!popCell) {
          const first = events.find((e) => e.type === 'bomb_spawn' || e.type === 'food_spawn');
          if (first) popCell = { x: first.x, z: first.z };
        }
        this.dispatch(events);
      };
      // Effect order: sweep → direct damage → growth → food → bombs → shield.
      if (fx.clearBombs === true) {
        track(this.state.clearBombs());
        this.hud.showToast('✨ ' + (ev.user?.nickname ?? 'Herói') + ' limpou as bombas!', 'success');
      }
      if (fx.attack > 0) track(this.state.attackShrink(fx.attack));
      if (fx.grow > 0) track(this.state.growSnake(fx.grow));
      if (fx.food > 0) track(this.state.spawnFood(fx.food, meta));
      if (fx.bombs > 0) {
        track(this.state.spawnBombs(fx.bombs, meta));
        if (this.state.snapshot.phase === 'playing') this.hud.flash('red');
      }
      if (fx.shieldSec > 0) track(this.state.applyShield(fx.shieldSec));
      if (rule.team === 'hero' && this.state.snapshot.phase === 'playing') this.hud.flash('green');
      if (!popCell && rule.show) popCell = this.randomFreeCell();
      if (popCell && this.renderer) {
        this.safe(() => this.renderer.giftPop({
          imageUrl: ev.giftImageUrl ?? null, nickname: ev.user?.nickname ?? '', count: Math.max(1, Number(ev.repeatCount) || count),
          x: popCell.x, z: popCell.z, effect: tier === 'normal' ? 'normal' : 'mega', team: rule.team ?? null
        }));
      }
    } catch (err) {
      this.reportError(err, 'presente');
    }
  }

  randomFreeCell() {
    const snap = this.state?.snapshot;
    if (!snap) return null;
    const occupied = new Set(snap.snakeIdx || []);
    for (const b of snap.bombs || []) occupied.add(b.z * snap.w + b.x);
    for (const f of snap.foods || []) occupied.add(f.z * snap.w + f.x);
    if (snap.apple) occupied.add(snap.apple.z * snap.w + snap.apple.x);
    const free = [];
    for (let i = 0; i < snap.cells; i++) if (!occupied.has(i)) free.push(i);
    if (!free.length) return { x: Math.floor(snap.w / 2), z: Math.floor(snap.h / 2) };
    const idx = free[Math.floor(Math.random() * free.length)];
    return { x: idx % snap.w, z: Math.floor(idx / snap.w) };
  }

  onCommand(msg) {
    const action = msg?.action;
    const payload = msg?.payload || {};
    try {
      switch (action) {
        case 'new_round':
          this.hud.showToast('🔄 Nova rodada!', 'info');
          this.startRound();
          break;
        case 'pause':
          this.setPaused(true);
          break;
        case 'resume':
          this.setPaused(false);
          break;
        case 'spawn_bomb': {
          if (!this.state) break;
          const n = clamp(Math.floor(Number(payload.count) || 1), 1, 100);
          this.dispatch(this.state.spawnBombs(n, { giftName: 'Painel', nickname: 'Painel' }));
          break;
        }
        case 'spawn_apple':
          if (this.state) this.dispatch(this.state.spawnApple());
          break;
        case 'clear_bombs':
          if (this.state) { this.dispatch(this.state.clearBombs()); this.hud.showToast('🧹 Bombas removidas', 'info'); }
          break;
        case 'set_config':
          this.pendingConfig = { ...(this.pendingConfig || {}), ...(payload && typeof payload === 'object' ? payload : {}) };
          this.hud.showToast('⚙️ Configuração recebida — aplicada na próxima rodada', 'info');
          break;
        case 'reload':
          this.hud.showToast('♻️ Recarregando…', 'info');
          setTimeout(() => location.reload(), 300);
          break;
        default:
          console.warn('[main] comando desconhecido', action);
      }
    } catch (err) {
      this.reportError(err, 'comando ' + action);
    }
  }

  setPaused(p) {
    const next = !!p;
    if (next === this.paused) return;
    this.paused = next;
    this.hud.showToast(next ? '⏸ Pausado' : '▶️ Retomado', 'info');
    this.setDevStatus(next ? 'pausado' : 'jogando');
  }

  // ---- dev panel + hotkeys -----------------------------------------------------------------

  async simApi(path, body) {
    if (!this.net.online) return false;
    try {
      const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Simulate a gift: through the server when online, otherwise locally with a fake GiftEvent. */
  async simGift(key) {
    const preset = SIM_GIFTS[key] || SIM_GIFTS.rose;
    const nickname = rand(SIM_NAMES);
    const ok = await this.simApi('/api/sim/gift', {
      nickname, giftName: preset.giftName, giftId: preset.giftId, count: preset.count, diamondCount: preset.diamondCount
    });
    if (ok) return;
    // Offline fallback: same pipeline as a real gift, but with a locally resolved rule.
    this.onGift({
      id: 'local-' + Date.now(),
      user: { userId: 'sim:' + nickname.toLowerCase(), uniqueId: nickname.toLowerCase(), nickname, avatarUrl: null },
      giftId: preset.giftId, giftName: preset.giftName, giftImageUrl: null,
      diamondCount: preset.diamondCount, count: preset.count, repeatCount: preset.count,
      coins: preset.diamondCount * preset.count, streakEnd: true,
      rule: {
        show: true, matched: true, ruleName: preset.giftName,
        team: preset.team, tier: preset.tier, effects: { bombs: 0, food: 0, grow: 0, attack: 0, shieldSec: 0, clearBombs: false, ...preset.effects },
        bombs: preset.effects.bombs || 0, effect: preset.tier === 'normal' ? 'normal' : 'mega'
      }
    });
  }

  async simChat() {
    const nickname = rand(SIM_NAMES);
    const text = rand(SIM_CHATS);
    if (await this.simApi('/api/sim/chat', { nickname, text })) return;
    this.hud.pushChat({ user: { userId: 'sim:' + nickname, uniqueId: nickname, nickname, avatarUrl: null }, text });
  }

  async simLike() {
    const nickname = rand(SIM_NAMES);
    const count = 5 + Math.floor(Math.random() * 20);
    if (await this.simApi('/api/sim/like', { nickname, count })) return;
    this.hud.showLike({ user: { userId: 'sim:' + nickname, nickname }, count });
  }

  async simFollow() {
    const nickname = rand(SIM_NAMES);
    if (await this.simApi('/api/sim/follow', { nickname })) return;
    this.hud.showSocial('follow', { userId: 'sim:' + nickname, uniqueId: nickname, nickname, avatarUrl: null });
  }

  runDevAction(action) {
    switch (action) {
      case 'gift:rose': return this.simGift('rose');
      case 'gift:gg': return this.simGift('gg');
      case 'gift:crane': return this.simGift('crane');
      case 'gift:swan': return this.simGift('swan');
      case 'gift:galaxy': return this.simGift('galaxy');
      case 'gift:moto': return this.simGift('moto');
      case 'gift:lion': return this.simGift('lion');
      case 'gift:universe': return this.simGift('universe');
      case 'chat': return this.simChat();
      case 'like': return this.simLike();
      case 'follow': return this.simFollow();
      case 'apple':
        if (this.state) this.dispatch(this.state.spawnApple());
        return;
      case 'bomb':
        if (this.state) this.dispatch(this.state.spawnBombs(1, { giftName: 'Dev', nickname: 'Dev' }));
        return;
      case 'new_round':
        return this.startRound();
      case 'pause':
        return this.setPaused(!this.paused);
      case 'hud':
        return this.hud.toggle();
      case 'audio': {
        const next = !this.audio.enabled;
        this.audio.setEnabled(next);
        this.hud.showToast(next ? '🔊 Som ligado' : '🔇 Som desligado', 'info');
        return;
      }
      default:
        return;
    }
  }

  bindDevPanel() {
    const panel = document.getElementById('devpanel');
    if (!panel) return;
    if (this.config.obs) { panel.remove(); return; }
    panel.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      this.audio.resume();
      Promise.resolve(this.runDevAction(btn.dataset.action)).catch((err) => this.reportError(err, 'painel dev'));
    });
  }

  bindHotkeys() {
    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const map = { '1': 'apple', '2': 'bomb', '3': 'gift:rose', '4': 'gift:lion', '5': 'gift:gg', '6': 'gift:galaxy', 'n': 'new_round', 'p': 'pause', 'h': 'hud' };
      const action = map[e.key.toLowerCase()];
      if (!action) return;
      e.preventDefault();
      Promise.resolve(this.runDevAction(action)).catch((err) => this.reportError(err, 'atalho'));
    });
  }

  bindWindow() {
    let resizeTimer = 0;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => this.safe(() => this.renderer?.resize()), 80);
    });
    window.addEventListener('error', (e) => this.reportError(e.error || e.message, 'janela'));
    window.addEventListener('unhandledrejection', (e) => this.reportError(e.reason, 'promessa'));
    window.addEventListener('beforeunload', () => {
      try { this.net?.close(); } catch { /* ignore */ }
      try { this.audio?.dispose(); } catch { /* ignore */ }
      try { this.renderer?.dispose(); } catch { /* ignore */ }
      if (this.rafId) cancelAnimationFrame(this.rafId);
    });
  }

  // ---- errors ------------------------------------------------------------------------------

  /** Run `fn` swallowing (but logging) exceptions — used for renderer calls, which are cosmetic. */
  safe(fn) {
    try { return fn?.(); } catch (err) { this.reportError(err, 'renderizador'); return undefined; }
  }

  reportError(err, where) {
    const now = performance.now();
    const e = this.errors;
    if (!e.firstAt || now - e.lastAt > ERROR_QUIET_RESET_MS) { e.firstAt = now; e.count = 0; }
    e.lastAt = now;
    e.count += 1;
    console.error(`[main] erro em ${where}:`, err);
    if (now - e.lastToastAt > ERROR_TOAST_GAP_MS && this.hud) {
      e.lastToastAt = now;
      this.hud.showToast(`Erro (${where}): ${shortError(err)}`, 'error');
    }
    if (this.config.obs && e.count >= 5 && now - e.firstAt > ERROR_RELOAD_AFTER_MS) {
      console.error('[main] erros persistentes em modo OBS — recarregando a página');
      location.reload();
    }
  }

  noteQuietFrame() {
    // Called on every successful frame; resets the error window after a quiet period.
    const e = this.errors;
    if (e.firstAt && performance.now() - e.lastAt > ERROR_QUIET_RESET_MS) { e.firstAt = 0; e.count = 0; }
  }

  setDevStatus(text) {
    if (this.devStatus) this.devStatus.textContent = text;
  }
}

function shortError(err) {
  const msg = err && typeof err === 'object' ? (err.message || String(err)) : String(err);
  return msg.length > 90 ? msg.slice(0, 90) + '…' : msg;
}

// ---------------------------------------------------------------------------------------------

const app = new App();
window.__snakeApp = app; // handy for debugging in the console (not used by the game)
app.boot().catch((err) => {
  console.error('[main] falha na inicialização', err);
  try { app.hud?.showToast('Falha na inicialização: ' + shortError(err), 'error'); } catch { /* ignore */ }
});
