/**
 * Pure game state for TikTok Snake LIVE (SPEC §2, §4.3, §4.4).
 *
 * No DOM, no three.js: importable from Node tests and from the browser.
 * The snake is driven by the Hamiltonian AI (../ai/hamiltonian.js); this class owns the
 * board occupancy, apple, bombs (fuse + FIFO queue), win/lose and the snapshot.
 *
 * Loss rule (client request 2026-09-03): no life/heart system. The AI ignores bombs; when
 * the head lands on one the snake shrinks by `bombShrink` segments, and if that would
 * leave it below MIN_LENGTH the round is lost. Losing all its size is the only defeat.
 *
 * Extensions beyond the SPEC signatures (documented, backwards compatible):
 *  - `reset()` and `start()` return GameEvent[] (`apple_spawn` / `start`) instead of void, so
 *    the orchestrator can dispatch them like any other event. Ignoring the return is fine.
 *  - Bombs are never placed on the cell directly in front of the head (head + dir) while
 *    another free cell exists — the renderer is already sliding the head into that cell.
 *  - The bomb queue is capped at MAX_BOMB_QUEUE entries (memory safety on very long rounds).
 */

import { DIRS, buildCycle, distFwd, nextMove } from '../ai/hamiltonian.js';

/** Defaults mirrored from SPEC §3 so the state works with a partial config (tests, panel). */
const DEFAULTS = Object.freeze({
  gridSize: 16,
  baseSpeed: 6,
  speedPerSegment: 0.03,
  maxSpeed: 13,
  bombShrink: 3,
  bombFuseSec: 90,
  maxBombsOnBoard: 60,
  foodFuseSec: 45,          // golden bonus food (hero gifts); 0 = never expires
  maxFoodOnBoard: 30,
  shieldMaxSec: 120,        // cap for stacked hero shields
  shortcutMaxFill: 0.5,
});

const MIN_LENGTH = 3;
const MAX_BOMB_QUEUE = 1000;
const OCC_SNAKE = 1;
const OCC_BOMB = 2;
const OCC_FOOD = 4;

/**
 * Deterministic PRNG (mulberry32). Returns a function producing floats in [0, 1).
 * @param {number} seed any 32-bit integer
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function dirBetween(fromCell, toCell, w) {
  const dx = (toCell % w) - (fromCell % w);
  const dz = Math.floor(toCell / w) - Math.floor(fromCell / w);
  for (let d = 0; d < 4; d++) if (DIRS[d].x === dx && DIRS[d].z === dz) return d;
  return -1;
}

export class GameState {
  /**
   * @param {object} config SPEC §3 config object (missing keys fall back to DEFAULTS)
   * @param {{ rng?: () => number, now?: () => number }} [deps] injectable randomness / clock
   */
  constructor(config = {}, { rng = Math.random, now = () => Date.now() } = {}) {
    const cfg = { ...DEFAULTS, ...(config || {}) };
    const size = Math.trunc(numberOr(cfg.gridSize, DEFAULTS.gridSize));
    // loadConfig() already validates 8..24; the state itself only needs an even size >= 4
    // (small boards keep the tests fast).
    if (!Number.isInteger(size) || size < 4 || size > 64 || size % 2 !== 0) {
      throw new RangeError(`GameState: gridSize inválido (${cfg.gridSize}); use um número par entre 4 e 64`);
    }
    this._config = Object.freeze({
      gridSize: size,
      baseSpeed: Math.max(0.1, numberOr(cfg.baseSpeed, DEFAULTS.baseSpeed)),
      speedPerSegment: Math.max(0, numberOr(cfg.speedPerSegment, DEFAULTS.speedPerSegment)),
      maxSpeed: Math.max(0.1, numberOr(cfg.maxSpeed, DEFAULTS.maxSpeed)),
      bombShrink: Math.max(1, Math.trunc(numberOr(cfg.bombShrink, DEFAULTS.bombShrink))),
      bombFuseSec: Math.max(0, numberOr(cfg.bombFuseSec, DEFAULTS.bombFuseSec)),
      maxBombsOnBoard: Math.max(0, Math.trunc(numberOr(cfg.maxBombsOnBoard, DEFAULTS.maxBombsOnBoard))),
      foodFuseSec: Math.max(0, numberOr(cfg.foodFuseSec, DEFAULTS.foodFuseSec)),
      maxFoodOnBoard: Math.max(0, Math.trunc(numberOr(cfg.maxFoodOnBoard, DEFAULTS.maxFoodOnBoard))),
      shieldMaxSec: Math.max(0, numberOr(cfg.shieldMaxSec, DEFAULTS.shieldMaxSec)),
      shortcutMaxFill: Math.min(1, Math.max(0, numberOr(cfg.shortcutMaxFill, DEFAULTS.shortcutMaxFill))),
    });
    if (typeof rng !== 'function') throw new TypeError('GameState: rng deve ser uma função');
    if (typeof now !== 'function') throw new TypeError('GameState: now deve ser uma função');
    this._rng = rng;
    this._now = now;

    this._w = size;
    this._h = size;
    this._n = size * size;
    this._cycle = buildCycle(this._w, this._h);
    this._aiOpts = { shortcutMaxFill: this._config.shortcutMaxFill, allowShortcuts: true };

    this._roundId = 0;
    this._bombSeq = 0; // bomb ids are unique for the lifetime of the instance
    this._occ = new Uint8Array(this._n); // OCC_SNAKE | OCC_BOMB flags per cell
    this._snake = []; // cell indices, head first
    this._bombs = new Map(); // id → { id, cell, x, z, fuseLeft, meta }
    this._bombCells = new Set(); // cell indices
    this._bombQueue = []; // FIFO of { meta }
    this._food = new Map(); // id → { id, cell, x, z, fuseLeft, meta } — hero bonus food
    this._foodSeq = 0;
    this._snakeCache = null; // memoised snapshot arrays, invalidated on every body change
    this._setupRound();
  }

  // ------------------------------------------------------------------ public accessors

  /** Effective (validated, frozen) config. */
  get config() { return this._config; }
  /** Hamiltonian cycle used by the AI (read-only; useful for tests). */
  get cycle() { return this._cycle; }
  get w() { return this._w; }
  get h() { return this._h; }
  get cells() { return this._n; }
  get phase() { return this._phase; }
  get roundId() { return this._roundId; }

  // ------------------------------------------------------------------ round lifecycle

  /** New round: roundId++, snake of length 3 at the centre heading right, bombs reset. */
  reset() {
    this._roundId += 1;
    return this._setupRound();
  }

  /** 'countdown' → 'playing'. Returns [{ type: 'start', roundId }] (empty if not in countdown). */
  start() {
    if (this._phase !== 'countdown') return [];
    this._phase = 'playing';
    return [{ type: 'start', roundId: this._roundId }];
  }

  /** Board setup shared by the constructor and reset(); does not touch roundId. */
  _setupRound() {
    this._phase = 'countdown';
    this._apples = 0;
    this._bombsEaten = 0;
    this._foodEaten = 0;
    this._growthPending = 0;
    this._shieldLeft = 0;
    this._food.clear();
    this._occ.fill(0);
    this._bombs.clear();
    this._bombCells.clear();
    this._bombQueue.length = 0;
    this._apple = -1;
    this._lastMove = null;
    this._startedAt = this._now();
    this._endedAt = null;
    this._placeSnake();
    return this._ensureApple();
  }

  /**
   * Place a 3-segment snake on a central row, heading right, laid out along the cycle so
   * the body-ordering invariant holds from the first step. On the canonical cycle one of
   * the two central rows always runs left→right; the fallback (tiny boards) follows the
   * cycle predecessors of the centre cell whatever their shape.
   */
  _placeSnake() {
    const { w, h, n } = { w: this._w, h: this._h, n: this._n };
    const { pos, cells } = this._cycle;
    const xc = w >> 1;
    let snake = null;
    for (const zc of [h >> 1, (h >> 1) - 1]) {
      const head = zc * w + xc;
      const p = pos[head];
      const c1 = cells[(p - 1 + n) % n];
      const c2 = cells[(p - 2 + n) % n];
      if (c1 === head - 1 && c2 === head - 2) { snake = [head, c1, c2]; break; }
    }
    if (!snake) {
      const head = (h >> 1) * w + xc;
      const p = pos[head];
      snake = [head, cells[(p - 1 + n) % n], cells[(p - 2 + n) % n]];
    }
    this._snake = snake;
    for (const c of snake) this._occ[c] |= OCC_SNAKE;
    this._dir = dirBetween(snake[1], snake[0], w);
    this._prevDir = this._dir;
    this._snakeCache = null;
  }

  // ------------------------------------------------------------------ stepping

  /** One grid step (only while 'playing'): applies the AI move and returns the events. */
  step() {
    if (this._phase !== 'playing') return [];
    const events = [];
    const snake = this._snake;
    const w = this._w;
    const head = snake[0];

    // The AI is blind to bombs on purpose: bombs on the route are hit, not dodged.
    // It chases the NEAREST food along the cycle (main apple or a hero bonus food).
    let move = nextMove(this._cycle, snake, this._nearestFood(head), this._aiOpts);
    if (!this._isLegalTarget(head, move.cell, false)) {
      // Unreachable while the invariant holds; keeps the round alive instead of freezing.
      move = this._emergencyMove(head);
      if (!move) return events;
    }
    const cell = move.cell;
    const eatsApple = cell === this._apple;
    const food = this._foodAt(cell);
    const bomb = this._bombAt(cell);

    // Growth is only realised when it cannot break the body-ordering invariant: keeping the
    // tail is safe iff distFwd(head, cell) < distFwd(head, tail) (the grow window). Food or
    // apples eaten outside that window (possible when the cell was not the AI's target) and
    // hero growSnake() convert into growth CREDIT, consumed on later safe steps.
    const tailCell = snake[snake.length - 1];
    const dFwd = distFwd(this._cycle, head, cell);
    const growWindow = tailCell === head ? this._n : distFwd(this._cycle, head, tailCell);
    const wantsGrow = eatsApple || food !== null || this._growthPending > 0;
    const grows = wantsGrow && dFwd < growWindow;

    this._prevDir = this._dir;
    this._dir = move.dir;
    this._lastMove = move;
    events.push({ type: 'move', cell, dir: move.dir, shortcut: move.shortcut });

    if (!grows) {
      // Tail leaves first so the head may legally step onto the old tail cell.
      const tc = snake.pop();
      this._occ[tc] &= ~OCC_SNAKE;
      if (wantsGrow) this._growthPending += 1; // deferred growth (unsafe to keep the tail now)
    } else if (!eatsApple && food === null) {
      this._growthPending -= 1; // growth credit realised
      events.push({ type: 'grow_step', length: snake.length + 1, pending: this._growthPending });
    }
    if (bomb) this._removeBomb(bomb);
    if (food) this._removeFood(food);
    snake.unshift(cell);
    this._occ[cell] |= OCC_SNAKE;
    this._snakeCache = null;
    const x = cell % w;
    const z = Math.floor(cell / w);

    if (eatsApple) {
      this._apple = -1;
      this._apples += 1;
      events.push({ type: 'eat_apple', x, z, apples: this._apples, length: snake.length });
    }
    if (food) {
      this._foodEaten += 1;
      events.push({ type: 'eat_food', id: food.id, x, z, foodEaten: this._foodEaten, length: snake.length, meta: food.meta });
    }
    if (snake.length >= this._n) {
      this._endRound('won', events);
      return events;
    }
    if (bomb) {
      this._bombsEaten += 1;
      if (this._shieldLeft > 0) {
        // Hero shield: the bomb pops harmlessly.
        events.push({ type: 'eat_bomb', id: bomb.id, x, z, length: snake.length, shrink: 0, fatal: false, shielded: true });
      } else {
        // Losing all its size is the only defeat: growth credit is eaten first, then body
        // segments; if the full shrink would leave the snake below MIN_LENGTH, it dies.
        let toShrink = this._config.bombShrink;
        const fromCredit = Math.min(this._growthPending, toShrink);
        this._growthPending -= fromCredit;
        toShrink -= fromCredit;
        const fatal = snake.length - toShrink < MIN_LENGTH;
        const shrink = fatal ? snake.length - MIN_LENGTH : toShrink;
        for (let i = 0; i < shrink; i++) {
          const c = snake.pop();
          this._occ[c] &= ~OCC_SNAKE;
        }
        this._snakeCache = null;
        events.push({ type: 'eat_bomb', id: bomb.id, x, z, length: snake.length, shrink, fatal, shielded: false });
        if (fatal) {
          this._endRound('lost', events);
          return events;
        }
      }
    }

    // Apple has priority over queued bombs for freed cells (SPEC §2.2).
    events.push(...this._ensureApple());
    events.push(...this._drainBombQueue());
    return events;
  }

  /** Advance bomb fuses by dtSec (any phase except won/lost); expire bombs; drain the queue. */
  tick(dtSec) {
    if (this._phase === 'won' || this._phase === 'lost') return [];
    if (typeof dtSec !== 'number' || !Number.isFinite(dtSec) || dtSec <= 0) return [];
    const events = [];
    if (this._shieldLeft > 0) {
      this._shieldLeft = Math.max(0, this._shieldLeft - dtSec);
      if (this._shieldLeft === 0) events.push({ type: 'shield_end' });
    }
    if (this._bombs.size > 0) {
      let expired = null;
      for (const bomb of this._bombs.values()) {
        if (bomb.fuseLeft === Infinity) continue;
        bomb.fuseLeft -= dtSec;
        if (bomb.fuseLeft <= 0) (expired ??= []).push(bomb);
      }
      if (expired) {
        for (const bomb of expired) {
          this._removeBomb(bomb);
          events.push({ type: 'bomb_expire', id: bomb.id, x: bomb.x, z: bomb.z });
        }
      }
    }
    if (this._food.size > 0) {
      let gone = null;
      for (const f of this._food.values()) {
        if (f.fuseLeft === Infinity) continue;
        f.fuseLeft -= dtSec;
        if (f.fuseLeft <= 0) (gone ??= []).push(f);
      }
      if (gone) {
        for (const f of gone) {
          this._removeFood(f);
          events.push({ type: 'food_expire', id: f.id, x: f.x, z: f.z });
        }
      }
    }
    if (events.length > 0 || this._apple < 0 || this._bombQueue.length > 0) {
      events.push(...this._ensureApple());
      events.push(...this._drainBombQueue());
    }
    return events;
  }

  // ------------------------------------------------------------------ items

  /**
   * Place up to `count` bombs now (respecting maxBombsOnBoard and free cells); the rest wait
   * in the FIFO queue. `meta` (gift info) is copied onto every bomb.
   */
  spawnBombs(count, meta = {}) {
    if (this._phase === 'won' || this._phase === 'lost') return [];
    let c = Math.trunc(numberOr(count, 0));
    if (c <= 0) return [];
    const events = [];
    const metaCopy = meta && typeof meta === 'object' ? { ...meta } : {};
    while (c > 0 && this._canPlaceBomb()) {
      const ev = this._placeBomb(metaCopy);
      if (!ev) break;
      events.push(ev);
      c--;
    }
    if (c > 0) {
      const room = Math.max(0, MAX_BOMB_QUEUE - this._bombQueue.length);
      const queued = Math.min(c, room);
      for (let i = 0; i < queued; i++) this._bombQueue.push({ meta: metaCopy });
    }
    return events;
  }

  /** Ensure exactly one apple exists whenever a free non-bomb cell exists. */
  spawnApple() {
    if (this._phase === 'won' || this._phase === 'lost') return [];
    return this._ensureApple();
  }

  /**
   * Hero effect: place up to `count` golden bonus foods on free cells (each grows the snake
   * by 1 when eaten; expires after config.foodFuseSec). Overflow is dropped, not queued.
   */
  spawnFood(count, meta = {}) {
    if (this._phase === 'won' || this._phase === 'lost') return [];
    let c = Math.trunc(numberOr(count, 0));
    if (c <= 0) return [];
    const events = [];
    const metaCopy = meta && typeof meta === 'object' ? { ...meta } : {};
    while (c > 0 && this._food.size < this._config.maxFoodOnBoard) {
      const ev = this._placeFood(metaCopy);
      if (!ev) break;
      events.push(ev);
      c--;
    }
    return events;
  }

  /** Hero effect: grow the snake by `amount` segments (realised over the next safe steps). */
  growSnake(amount) {
    if (this._phase === 'won' || this._phase === 'lost') return [];
    const a = Math.max(0, Math.trunc(numberOr(amount, 0)));
    if (a === 0) return [];
    const room = Math.max(0, this._n - this._snake.length - this._growthPending);
    const granted = Math.min(a, room);
    if (granted === 0) return [];
    this._growthPending += granted;
    return [{ type: 'grow', amount: granted, pending: this._growthPending, length: this._snake.length }];
  }

  /** Hero effect: bomb shield for `seconds` (stacking, capped at config.shieldMaxSec). */
  applyShield(seconds) {
    if (this._phase === 'won' || this._phase === 'lost') return [];
    const sec = Math.max(0, numberOr(seconds, 0));
    if (sec === 0) return [];
    this._shieldLeft = Math.min(this._shieldLeft + sec, this._config.shieldMaxSec);
    return [{ type: 'shield_start', seconds: this._shieldLeft }];
  }

  /**
   * Villain effect: direct attack — the snake loses up to `amount` segments immediately
   * (growth credit is consumed first). NEVER fatal: bombs are the only way to die.
   */
  attackShrink(amount) {
    if (this._phase === 'won' || this._phase === 'lost') return [];
    let a = Math.max(0, Math.trunc(numberOr(amount, 0)));
    if (a === 0) return [];
    const fromCredit = Math.min(this._growthPending, a);
    this._growthPending -= fromCredit;
    a -= fromCredit;
    const shrink = Math.min(a, Math.max(0, this._snake.length - MIN_LENGTH));
    for (let i = 0; i < shrink; i++) {
      const c = this._snake.pop();
      this._occ[c] &= ~OCC_SNAKE;
    }
    if (shrink > 0) this._snakeCache = null;
    if (fromCredit === 0 && shrink === 0) return [];
    return [{ type: 'attack', shrink, fromCredit, length: this._snake.length }];
  }

  /** Remove every bomb on the board and empty the queue (panel command). */
  clearBombs() {
    const ids = [];
    for (const bomb of this._bombs.values()) ids.push(bomb.id);
    for (const cell of this._bombCells) this._occ[cell] &= ~OCC_BOMB;
    this._bombs.clear();
    this._bombCells.clear();
    this._bombQueue.length = 0;
    const events = [];
    if (ids.length > 0) events.push({ type: 'bomb_clear', ids });
    if (this._phase !== 'won' && this._phase !== 'lost') events.push(...this._ensureApple());
    return events;
  }

  // ------------------------------------------------------------------ snapshot

  /** Plain-data view of the state (safe to JSON, fresh arrays on every call). */
  get snapshot() {
    const w = this._w;
    const cache = this._snakeCache ?? this._buildSnakeCache();
    const bombs = new Array(this._bombs.size);
    let i = 0;
    for (const b of this._bombs.values()) {
      bombs[i++] = { id: b.id, x: b.x, z: b.z, fuseLeft: b.fuseLeft, meta: b.meta };
    }
    const foods = new Array(this._food.size);
    let fi = 0;
    for (const f of this._food.values()) {
      foods[fi++] = { id: f.id, x: f.x, z: f.z, fuseLeft: f.fuseLeft, meta: f.meta };
    }
    const length = this._snake.length;
    const endedAt = this._endedAt;
    return {
      roundId: this._roundId,
      phase: this._phase,
      w,
      h: this._h,
      cells: this._n,
      snake: cache.snake.map((p) => ({ x: p.x, z: p.z })),
      snakeIdx: cache.idx.slice(),
      dir: this._dir,
      prevDir: this._prevDir,
      apple: this._apple >= 0 ? { x: this._apple % w, z: Math.floor(this._apple / w) } : null,
      bombs,
      bombQueue: this._bombQueue.length,
      foods,
      shieldLeft: this._shieldLeft,
      growthPending: this._growthPending,
      // One more bomb kills when the shrink (after credit) would push the length below MIN_LENGTH.
      danger: this._shieldLeft <= 0 && length + this._growthPending - this._config.bombShrink < MIN_LENGTH,
      apples: this._apples,
      bombsEaten: this._bombsEaten,
      foodEaten: this._foodEaten,
      length,
      progress: length / this._n,
      speed: this._speedFor(length),
      startedAt: this._startedAt,
      endedAt,
      durationMs: Math.max(0, (endedAt ?? this._now()) - this._startedAt),
      lastMove: this._lastMove ? { ...this._lastMove } : null,
    };
  }

  _buildSnakeCache() {
    const w = this._w;
    const snake = this._snake;
    const len = snake.length;
    const xz = new Array(len);
    const idx = new Array(len);
    for (let i = 0; i < len; i++) {
      const c = snake[i];
      idx[i] = c;
      xz[i] = { x: c % w, z: Math.floor(c / w) };
    }
    this._snakeCache = { snake: xz, idx };
    return this._snakeCache;
  }

  _speedFor(length) {
    const { baseSpeed, speedPerSegment, maxSpeed } = this._config;
    const raw = baseSpeed + (length - MIN_LENGTH) * speedPerSegment;
    return Math.min(maxSpeed, Math.max(baseSpeed, raw));
  }

  // ------------------------------------------------------------------ internals

  _endRound(phase, events) {
    this._phase = phase;
    this._endedAt = this._now();
    const summary = {
      result: phase === 'won' ? 'win' : 'loss',
      apples: this._apples,
      bombsEaten: this._bombsEaten,
      foodEaten: this._foodEaten,
      length: this._snake.length,
      durationMs: Math.max(0, this._endedAt - this._startedAt),
      roundId: this._roundId,
    };
    events.push({ type: phase === 'won' ? 'win' : 'lose', summary });
  }

  /** True when `cell` is adjacent to `head` and not occupied by a segment that stays. */
  _isLegalTarget(head, cell, growing) {
    if (!Number.isInteger(cell) || cell < 0 || cell >= this._n) return false;
    if (dirBetween(head, cell, this._w) < 0) return false;
    if ((this._occ[cell] & OCC_SNAKE) === 0) return true;
    const snake = this._snake;
    return !growing && snake.length >= 2 && cell === snake[snake.length - 1] && snake.length > 1;
  }

  /** Any legal neighbour (free first, then the departing tail); null when boxed in. */
  _emergencyMove(head) {
    const w = this._w;
    const x = head % w;
    const z = Math.floor(head / w);
    let tailMove = null;
    for (let d = 0; d < 4; d++) {
      const nx = x + DIRS[d].x;
      const nz = z + DIRS[d].z;
      if (nx < 0 || nz < 0 || nx >= w || nz >= this._h) continue;
      const cell = nz * w + nx;
      const growing = cell === this._apple;
      if (!this._isLegalTarget(head, cell, growing)) continue;
      const move = { cell, dir: d, shortcut: true, eatsApple: growing };
      if ((this._occ[cell] & OCC_SNAKE) === 0) return move;
      tailMove ??= move;
    }
    return tailMove;
  }

  _bombAt(cell) {
    if (!this._bombCells.has(cell)) return null;
    for (const bomb of this._bombs.values()) if (bomb.cell === cell) return bomb;
    return null;
  }

  /** Nearest edible target (main apple or bonus food) by forward distance along the cycle. */
  _nearestFood(head) {
    let target = this._apple;
    let best = target >= 0 ? distFwd(this._cycle, head, target) : Infinity;
    for (const f of this._food.values()) {
      const d = distFwd(this._cycle, head, f.cell);
      if (d < best) { best = d; target = f.cell; }
    }
    return target;
  }

  _foodAt(cell) {
    if ((this._occ[cell] & OCC_FOOD) === 0) return null;
    for (const f of this._food.values()) if (f.cell === cell) return f;
    return null;
  }

  _removeFood(food) {
    this._food.delete(food.id);
    this._occ[food.cell] &= ~OCC_FOOD;
  }

  _placeFood(meta) {
    const cell = this._pickFreeCell(this._frontCell());
    if (cell < 0) return null;
    const w = this._w;
    const fuse = this._config.foodFuseSec;
    const food = {
      id: 'f' + (++this._foodSeq),
      cell,
      x: cell % w,
      z: Math.floor(cell / w),
      fuseLeft: fuse > 0 ? fuse : Infinity,
      meta,
    };
    this._food.set(food.id, food);
    this._occ[cell] |= OCC_FOOD;
    return { type: 'food_spawn', id: food.id, x: food.x, z: food.z, fuseSec: food.fuseLeft, meta };
  }

  _removeBomb(bomb) {
    this._bombs.delete(bomb.id);
    this._bombCells.delete(bomb.cell);
    this._occ[bomb.cell] &= ~OCC_BOMB;
  }

  _canPlaceBomb() {
    return this._bombs.size < this._config.maxBombsOnBoard;
  }

  /**
   * Pick a uniformly random free cell (not snake, not bomb, not apple, not `avoid`).
   * Falls back to allowing `avoid` when it is the only option. Returns -1 when none.
   */
  _pickFreeCell(avoid) {
    const occ = this._occ;
    const n = this._n;
    const apple = this._apple;
    let count = 0;
    for (let c = 0; c < n; c++) if (occ[c] === 0 && c !== apple && c !== avoid) count++;
    if (count === 0) {
      if (avoid >= 0 && occ[avoid] === 0 && avoid !== apple) return avoid;
      return -1;
    }
    let k = Math.floor(this._rng() * count);
    if (!(k >= 0 && k < count)) k = 0; // guards a misbehaving rng (NaN / 1.0)
    for (let c = 0; c < n; c++) {
      if (occ[c] === 0 && c !== apple && c !== avoid) {
        if (k === 0) return c;
        k--;
      }
    }
    return -1;
  }

  _frontCell() {
    const head = this._snake[0];
    const w = this._w;
    const x = (head % w) + DIRS[this._dir].x;
    const z = Math.floor(head / w) + DIRS[this._dir].z;
    if (x < 0 || z < 0 || x >= w || z >= this._h) return -1;
    return z * w + x;
  }

  _placeBomb(meta) {
    const cell = this._pickFreeCell(this._frontCell());
    if (cell < 0) return null;
    const w = this._w;
    const fuse = this._config.bombFuseSec;
    const bomb = {
      id: 'b' + (++this._bombSeq),
      cell,
      x: cell % w,
      z: Math.floor(cell / w),
      fuseLeft: fuse > 0 ? fuse : Infinity,
      meta,
    };
    this._bombs.set(bomb.id, bomb);
    this._bombCells.add(cell);
    this._occ[cell] |= OCC_BOMB;
    return { type: 'bomb_spawn', id: bomb.id, x: bomb.x, z: bomb.z, fuseSec: bomb.fuseLeft, meta };
  }

  _drainBombQueue() {
    const events = [];
    while (this._bombQueue.length > 0 && this._canPlaceBomb()) {
      const ev = this._placeBomb(this._bombQueue[0].meta);
      if (!ev) break; // no free cell right now; keep waiting
      this._bombQueue.shift();
      events.push(ev);
    }
    return events;
  }

  _ensureApple() {
    if (this._apple >= 0) return [];
    const cell = this._pickFreeCell(-1);
    if (cell < 0) return [];
    this._apple = cell;
    const w = this._w;
    return [{ type: 'apple_spawn', x: cell % w, z: Math.floor(cell / w) }];
  }
}
