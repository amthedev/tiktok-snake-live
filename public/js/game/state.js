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
  baseSpeed: 5,
  speedPerSegment: 0.14,
  maxSpeed: 32,
  bombShrink: 3,
  bombFuseSec: 90,
  maxBombsOnBoard: 60,
  foodFuseSec: 45,          // golden bonus food (hero gifts); 0 = never expires
  maxFoodOnBoard: 30,
  shieldMaxSec: 120,        // cap for stacked hero shields
  shortcutMaxFill: 0.5,
  // [itens] Balanceamento da bomba. Estes dois mantêm o comportamento histórico do SPEC para
  // quem cria um GameState "pelado" (testes, ferramentas); o balanceamento REAL da live vem do
  // config (public/js/config.js): bombShrink 4 + bombShrinkPct 0.2 + startLength 10.
  // Ver docs/DECISOES-LIVE.md para os números medidos.
  bombShrinkPct: 0,         // dano extra = floor(tamanho * pct); 0 = comportamento antigo
  startLength: 3,           // tamanho inicial da cobra (entra como crédito de crescimento)
});

const MIN_LENGTH = 3;
const MAX_BOMB_QUEUE = 1000;
const OCC_SNAKE = 1;
const OCC_BOMB = 2;
const OCC_FOOD = 4;
const OCC_ITEM = 8;           // [itens] qualquer um dos itens especiais novos
const MAGNET_STEP_SEC = 0.28; // [itens] 🧲 intervalo entre passos das comidas atraídas

/**
 * [itens] Catálogo dos itens especiais (pedido do cliente: "mais coisas além de bomba").
 *
 * Cada item tem pavio curto (aparece e some sozinho), um limite por tipo no tabuleiro e um
 * efeito próprio. Os itens de DANO não são desviados pela IA — ela continua indo atrás da
 * comida e bate neles de propósito; é isso que dá a graça. Os de BÔNUS também não são
 * caçados: a IA persegue maçã/comida dourada e pega o resto no caminho.
 *
 *  kind    → chave usada no evento e no renderer
 *  team    → 'villain' (dano) | 'hero' (bônus)
 *  fuseSec → pavio padrão (0 = eterno)
 *  max     → quantos podem existir ao mesmo tempo
 */
export const ITEM_KINDS = Object.freeze({
  // 😈 DANO ------------------------------------------------------------------------------
  bolt:    { kind: 'bolt',    team: 'villain', fuseSec: 7,  max: 6, emoji: '⚡',  label: 'Raio' },
  ice:     { kind: 'ice',     team: 'villain', fuseSec: 14, max: 4, emoji: '🧊', label: 'Gelo' },
  web:     { kind: 'web',     team: 'villain', fuseSec: 16, max: 4, emoji: '🕸️', label: 'Teia' },
  skull:   { kind: 'skull',   team: 'villain', fuseSec: 10, max: 3, emoji: '☠️', label: 'Caveira' },
  // 😇 BÔNUS -----------------------------------------------------------------------------
  diamond: { kind: 'diamond', team: 'hero',    fuseSec: 20, max: 8, emoji: '💎', label: 'Diamante' },
  star:    { kind: 'star',    team: 'hero',    fuseSec: 12, max: 3, emoji: '⭐', label: 'Estrela' },
  magnet:  { kind: 'magnet',  team: 'hero',    fuseSec: 12, max: 2, emoji: '🧲', label: 'Ímã' },
  clock:   { kind: 'clock',   team: 'hero',    fuseSec: 14, max: 3, emoji: '⏱️', label: 'Relógio' },
});

/** [itens] Quanto cada item faz quando a cobra encosta nele. */
const ITEM_EFFECT = Object.freeze({
  bolt:    { shrink: 8 },                    // encolhe muito, mas o pavio é curtíssimo
  skull:   { shrink: 14 },                   // dano pesado — só em presentes grandes
  ice:     { slowSec: 5, slowFactor: 0.45 },
  web:     { stuckSteps: 6 },
  diamond: { grow: 5 },
  star:    { starSec: 8 },                   // invencível: bombas e itens de dano não machucam
  magnet:  { magnetSec: 8 },                 // puxa as comidas para perto da cabeça
  clock:   { fastSec: 8, fastFactor: 1.8 },
});

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
      // [itens] Dano da bomba = bombShrink + floor(tamanho * bombShrinkPct). O cliente achou a
      // bomba fraca; medir mostrou que só aumentar o valor fixo acaba com a rodada em ~3 s,
      // então o dano acompanha o tamanho e a cobra começa maior (startLength).
      bombShrinkPct: Math.min(1, Math.max(0, numberOr(cfg.bombShrinkPct, DEFAULTS.bombShrinkPct))),
      startLength: Math.max(MIN_LENGTH, Math.trunc(numberOr(cfg.startLength, DEFAULTS.startLength))),
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
    // [ia] Variedade de percurso: cada rodada roda sobre um ciclo hamiltoniano novo
    // (ver _pickCycle). A rodada 1 mantém o ciclo canônico, então um estado recém-criado
    // continua reproduzível exatamente como antes.
    this._cycle = buildCycle(this._w, this._h);
    this._cycleSeed = null;
    // [ia-pro] rng injetável: a IA usa só para desempatar jogadas equivalentes, então as
    // rodadas continuam determinísticas para a mesma semente (testes) mas duas rodadas
    // iguais não desenham a mesma trajetória na tela.
    this._aiOpts = { shortcutMaxFill: this._config.shortcutMaxFill, allowShortcuts: true, rng, foods: [] };

    this._roundId = 0;
    this._bombSeq = 0; // bomb ids are unique for the lifetime of the instance
    this._occ = new Uint8Array(this._n); // OCC_SNAKE | OCC_BOMB flags per cell
    this._snake = []; // cell indices, head first
    this._bombs = new Map(); // id → { id, cell, x, z, fuseLeft, meta }
    this._bombCells = new Set(); // cell indices
    this._bombQueue = []; // FIFO of { meta }
    this._food = new Map(); // id → { id, cell, x, z, fuseLeft, meta } — hero bonus food
    this._foodSeq = 0;
    // [itens] Itens especiais (raio, gelo, teia, caveira, diamante, estrela, ímã, relógio).
    this._items = new Map();                // id → { id, kind, cell, x, z, fuseLeft, meta }
    this._itemSeq = 0;
    this._itemCounts = Object.create(null); // kind → quantos estão no tabuleiro
    this._magnetAcc = 0;
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

  /**
   * [itens] Dano atual de uma bomba: bombShrink + floor(tamanho * bombShrinkPct).
   * Escala com a cobra para a bomba nunca parecer fraca (pedido do cliente) sem transformar
   * cada rodada num estouro instantâneo — números medidos em docs/DECISOES-LIVE.md.
   */
  get bombDamage() {
    const { bombShrink, bombShrinkPct } = this._config;
    return bombShrink + Math.floor(this._snake.length * bombShrinkPct);
  }

  // ------------------------------------------------------------------ round lifecycle

  /** New round: roundId++, snake of length 3 at the centre heading right, bombs reset. */
  reset() {
    this._roundId += 1;
    this._pickCycle(); // [ia] percurso novo a cada rodada (ver _pickCycle)
    return this._setupRound();
  }

  /**
   * [ia] Variedade de percurso (pedido do cliente 2026-09-04: "que essa minhoca não faça o
   * mesmo percurso sempre"). Cada rodada roda sobre um ciclo hamiltoniano NOVO, sorteado com
   * o rng injetado (então os testes continuam determinísticos) e diferente do da rodada
   * anterior.
   *
   * A garantia de nunca colidir vem do invariante de ordem no ciclo, NÃO do formato do ciclo:
   * qualquer ciclo hamiltoniano válido serve, e buildCycle só devolve ciclos válidos. A
   * vitória continua garantida porque o ciclo cobre o tabuleiro inteiro.
   *
   * Também sorteia a agressividade dos atalhos numa faixa em volta do configurado — rodadas
   * diferentes "cortam caminho" mais ou menos, o que muda o ritmo sem mexer na segurança
   * (o atalho já passa pela regra de segurança; shortcutMaxFill só diz até que enchimento do
   * tabuleiro ele é permitido).
   */
  _pickCycle() {
    const prev = this._cycleSeed;
    let seed = 0;
    for (let attempt = 0; attempt < 8; attempt++) {
      seed = (Math.floor(this._rng() * 0xffffffff) >>> 0) || 1;
      if (seed !== prev) break;
    }
    this._cycleSeed = seed;
    this._cycle = buildCycle(this._w, this._h, { seed });
    // Faixa de atalho: 60%..115% do configurado, limitada a [0, 1].
    const base = this._config.shortcutMaxFill;
    const factor = 0.6 + this._rng() * 0.55;
    // [ia-pro] preserva rng e foods entre rodadas (ver construtor).
    this._aiOpts = {
      shortcutMaxFill: Math.min(1, Math.max(0, base * factor)),
      allowShortcuts: true,
      rng: this._rng,
      foods: [],
    };
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
    // [itens] estados temporários dos itens novos
    this._starLeft = 0;    // ⭐ invencibilidade
    this._slowLeft = 0;    // 🧊 lentidão
    this._fastLeft = 0;    // ⏱️ velocidade
    this._magnetLeft = 0;  // 🧲 atração das comidas
    this._stuckSteps = 0;  // 🕸️ passos presos
    this._magnetAcc = 0;
    this._items.clear();
    this._itemCounts = Object.create(null);
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
    // [itens] Vantagem inicial: a cobra "nasce" com startLength. Entra como crédito de
    // crescimento (realizado nos primeiros passos seguros), então o invariante do ciclo
    // continua valendo exatamente como antes — nada é colocado à força no tabuleiro.
    const headStart = Math.max(0, this._config.startLength - this._snake.length);
    if (headStart > 0) this._growthPending = Math.min(headStart, this._n - this._snake.length);
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

    // [itens] 🕸️ Teia: a cobra fica presa por N passos. Ela NÃO se move (nem cresce, nem
    // encolhe), só perde o turno — o tabuleiro continua vivo porque tick() segue rodando.
    if (this._stuckSteps > 0) {
      this._stuckSteps -= 1;
      events.push({ type: 'web_stuck', stepsLeft: this._stuckSteps });
      if (this._stuckSteps === 0) events.push({ type: 'web_end' });
      return events;
    }

    // The AI is blind to bombs on purpose: bombs on the route are hit, not dodged.
    // [ia-pro] A IA agora escolhe o alvo pela distância REAL no tabuleiro, então passamos a
    // maçã como alvo principal e as comidas bônus em opts.foods; ela pega a mais perto de
    // verdade (antes era "a mais perto ao longo do ciclo", o que causava as voltas largas).
    const aiOpts = this._aiOpts;
    const foods = aiOpts.foods;
    foods.length = 0;
    for (const f of this._food.values()) foods.push(f.cell);
    const target = this._apple >= 0 ? this._apple : this._nearestFood(head);
    let move = nextMove(this._cycle, snake, target, aiOpts);
    if (!this._isLegalTarget(head, move.cell, false)) {
      // Unreachable while the invariant holds; keeps the round alive instead of freezing.
      move = this._emergencyMove(head);
      if (!move) return events;
    }
    const cell = move.cell;
    const eatsApple = cell === this._apple;
    const food = this._foodAt(cell);
    const bomb = this._bombAt(cell);
    const item = this._itemAt(cell); // [itens] item especial pisado neste passo

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
    if (item) this._removeItem(item); // [itens]
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
    // [itens] Item especial pisado: aplica o efeito (pode ser fatal, como a bomba).
    if (item && this._applyItemPickup(item, x, z, events)) return events;
    if (snake.length >= this._n) {
      this._endRound('won', events);
      return events;
    }
    if (bomb) {
      this._bombsEaten += 1;
      // [itens] A ⭐ estrela protege igual ao escudo (invencibilidade temporária).
      if (this._shieldLeft > 0 || this._starLeft > 0) {
        // Hero shield: the bomb pops harmlessly.
        events.push({ type: 'eat_bomb', id: bomb.id, x, z, length: snake.length, shrink: 0, fatal: false, shielded: true });
      } else {
        // Losing all its size is the only defeat: growth credit is eaten first, then body
        // segments; if the full shrink would leave the snake below MIN_LENGTH, it dies.
        // [itens] O dano cresce junto com a cobra, então a bomba nunca é "fraquinha" numa
        // cobra grande nem instantaneamente fatal numa cobra pequena.
        let toShrink = this.bombDamage;
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
    // [itens] Efeitos temporários dos itens novos: cada um avisa quando acaba, para o
    // renderer/HUD desligarem o visual correspondente.
    if (this._starLeft > 0) {
      this._starLeft = Math.max(0, this._starLeft - dtSec);
      if (this._starLeft === 0) events.push({ type: 'star_end' });
    }
    if (this._slowLeft > 0) {
      this._slowLeft = Math.max(0, this._slowLeft - dtSec);
      if (this._slowLeft === 0) events.push({ type: 'slow_end' });
    }
    if (this._fastLeft > 0) {
      this._fastLeft = Math.max(0, this._fastLeft - dtSec);
      if (this._fastLeft === 0) events.push({ type: 'fast_end' });
    }
    if (this._magnetLeft > 0) {
      this._magnetLeft = Math.max(0, this._magnetLeft - dtSec);
      events.push(...this._magnetPull(dtSec));
      if (this._magnetLeft === 0) events.push({ type: 'magnet_end' });
    }
    // [itens] Pavio dos itens especiais.
    if (this._items.size > 0) {
      let goneItems = null;
      for (const it of this._items.values()) {
        if (it.fuseLeft === Infinity) continue;
        it.fuseLeft -= dtSec;
        if (it.fuseLeft <= 0) (goneItems ??= []).push(it);
      }
      if (goneItems) {
        for (const it of goneItems) {
          this._removeItem(it);
          events.push({ type: 'item_expire', id: it.id, kind: it.kind, x: it.x, z: it.z });
        }
      }
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

  /**
   * [itens] Coloca até `count` itens especiais do tipo `kind` em células livres.
   * Respeita o limite por tipo (ITEM_KINDS[kind].max) e o pavio próprio de cada item; o que
   * não couber é descartado (não entra em fila, ao contrário das bombas — item que aparece
   * tarde demais não faz sentido para o público).
   *
   * @param {string} kind uma das chaves de ITEM_KINDS
   * @param {number} count quantos
   * @param {object} [meta] info do presente (nome, avatar…) copiada para cada item
   * @returns {object[]} eventos item_spawn
   */
  spawnItem(kind, count = 1, meta = {}) {
    if (this._phase === 'won' || this._phase === 'lost') return [];
    const def = ITEM_KINDS[kind];
    if (!def) return [];
    let c = Math.trunc(numberOr(count, 0));
    if (c <= 0) return [];
    const events = [];
    const metaCopy = meta && typeof meta === 'object' ? { ...meta } : {};
    while (c > 0 && (this._itemCounts[kind] || 0) < def.max) {
      const ev = this._placeItem(def, metaCopy);
      if (!ev) break;
      events.push(ev);
      c--;
    }
    return events;
  }

  /** [itens] ⭐ Estrela: invencibilidade por `seconds` (acumula, com o mesmo teto do escudo). */
  applyStar(seconds) { return this._applyTimed('_starLeft', seconds, 'star_start'); }

  /** [itens] 🧊 Gelo: deixa a cobra lenta por `seconds`. */
  applySlow(seconds) { return this._applyTimed('_slowLeft', seconds, 'slow_start'); }

  /** [itens] ⏱️ Relógio: deixa a cobra rápida por `seconds`. */
  applyFast(seconds) { return this._applyTimed('_fastLeft', seconds, 'fast_start'); }

  /** [itens] 🧲 Ímã: atrai as comidas para perto da cabeça por `seconds`. */
  applyMagnet(seconds) { return this._applyTimed('_magnetLeft', seconds, 'magnet_start'); }

  /** [itens] Base comum dos efeitos por tempo (acumulam e respeitam shieldMaxSec). */
  _applyTimed(field, seconds, type) {
    if (this._phase === 'won' || this._phase === 'lost') return [];
    const sec = Math.max(0, numberOr(seconds, 0));
    if (sec === 0) return [];
    this[field] = Math.min(this[field] + sec, this._config.shieldMaxSec);
    return [{ type, seconds: this[field] }];
  }

  /** [itens] 🕸️ Teia: prende a cobra por `steps` passos (ela perde o turno, não encolhe). */
  applyWeb(steps) {
    if (this._phase === 'won' || this._phase === 'lost') return [];
    const n = Math.max(0, Math.trunc(numberOr(steps, 0)));
    if (n === 0) return [];
    this._stuckSteps = Math.min(this._stuckSteps + n, 30);
    return [{ type: 'web_start', steps: this._stuckSteps }];
  }

  /** [itens] Remove todos os itens especiais do tabuleiro (usado pelo efeito de limpeza). */
  clearItems() {
    const cleared = [];
    for (const it of this._items.values()) cleared.push({ id: it.id, kind: it.kind });
    if (cleared.length === 0) return [];
    for (const it of Array.from(this._items.values())) this._removeItem(it);
    return [{ type: 'item_clear', items: cleared, ids: cleared.map((c) => c.id) }];
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
    // [itens]
    const items = new Array(this._items.size);
    let ii = 0;
    for (const it of this._items.values()) {
      items[ii++] = { id: it.id, kind: it.kind, x: it.x, z: it.z, fuseLeft: it.fuseLeft, meta: it.meta };
    }
    const length = this._snake.length;
    const endedAt = this._endedAt;
    const snap = {
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
      // [itens] usa o dano REAL (escalado) e considera a estrela além do escudo.
      danger: this._shieldLeft <= 0 && this._starLeft <= 0
        && length + this._growthPending - this.bombDamage < MIN_LENGTH,
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
    // [itens] Os campos dos itens novos entram SÓ quando há item no tabuleiro, algum efeito
    // ligado ou o dano escalado configurado. Assim o snapshot de uma partida sem itens continua
    // exatamente com a forma do SPEC §4.4 (nada quebra para quem já lia esse objeto), e o
    // overlay recebe o extra na hora em que ele existe de verdade.
    if (items.length > 0 || this._starLeft > 0 || this._slowLeft > 0 || this._fastLeft > 0
        || this._magnetLeft > 0 || this._stuckSteps > 0 || this._config.bombShrinkPct > 0) {
      snap.items = items;
      snap.starLeft = this._starLeft;
      snap.slowLeft = this._slowLeft;
      snap.fastLeft = this._fastLeft;
      snap.magnetLeft = this._magnetLeft;
      snap.stuckSteps = this._stuckSteps;
      snap.bombDamage = this.bombDamage;
    }
    return snap;
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

  /**
   * Velocidade em passos/s. [itens] O 🧊 gelo divide e o ⏱️ relógio multiplica; os dois podem
   * estar ativos ao mesmo tempo (um cancela parte do outro) e o resultado nunca fica <= 0.
   */
  _speedFor(length) {
    const { baseSpeed, speedPerSegment, maxSpeed } = this._config;
    const raw = baseSpeed + (length - MIN_LENGTH) * speedPerSegment;
    let speed = Math.min(maxSpeed, Math.max(baseSpeed, raw));
    if (this._slowLeft > 0) speed *= ITEM_EFFECT.ice.slowFactor;
    if (this._fastLeft > 0) speed *= ITEM_EFFECT.clock.fastFactor;
    return Math.max(0.5, speed);
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

  // ---------------------------------------------------------------- [itens] itens especiais

  _itemAt(cell) {
    if ((this._occ[cell] & OCC_ITEM) === 0) return null;
    for (const it of this._items.values()) if (it.cell === cell) return it;
    return null;
  }

  _removeItem(item) {
    if (!this._items.delete(item.id)) return;
    this._occ[item.cell] &= ~OCC_ITEM;
    this._itemCounts[item.kind] = Math.max(0, (this._itemCounts[item.kind] || 0) - 1);
  }

  _placeItem(def, meta) {
    const cell = this._pickFreeCell(this._frontCell());
    if (cell < 0) return null;
    const w = this._w;
    const fuse = def.fuseSec;
    const item = {
      id: 'i' + (++this._itemSeq),
      kind: def.kind,
      cell,
      x: cell % w,
      z: Math.floor(cell / w),
      fuseLeft: fuse > 0 ? fuse : Infinity,
      meta,
    };
    this._items.set(item.id, item);
    this._occ[cell] |= OCC_ITEM;
    this._itemCounts[def.kind] = (this._itemCounts[def.kind] || 0) + 1;
    return {
      type: 'item_spawn', id: item.id, kind: item.kind, team: def.team,
      x: item.x, z: item.z, fuseSec: item.fuseLeft, meta,
    };
  }

  /**
   * [itens] Efeito de encostar num item. Empurra os eventos em `events`.
   * @returns {boolean} true quando o item MATOU a cobra (a rodada já foi encerrada)
   */
  _applyItemPickup(item, x, z, events) {
    const fx = ITEM_EFFECT[item.kind] || {};
    const snake = this._snake;
    const guarded = this._shieldLeft > 0 || this._starLeft > 0;
    const base = { type: 'eat_item', id: item.id, kind: item.kind, x, z, meta: item.meta };

    // --- itens de DANO -----------------------------------------------------------------
    if (fx.shrink > 0) {
      if (guarded) {
        events.push({ ...base, shielded: true, shrink: 0, fatal: false, length: snake.length });
        return false;
      }
      let toShrink = fx.shrink;
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
      events.push({ ...base, shielded: false, shrink, fromCredit, fatal, length: snake.length });
      if (fatal) { this._endRound('lost', events); return true; }
      return false;
    }
    if (fx.slowSec > 0) {
      if (guarded) { events.push({ ...base, shielded: true }); return false; }
      events.push({ ...base, shielded: false, seconds: fx.slowSec });
      events.push(...this.applySlow(fx.slowSec));
      return false;
    }
    if (fx.stuckSteps > 0) {
      if (guarded) { events.push({ ...base, shielded: true }); return false; }
      events.push({ ...base, shielded: false, steps: fx.stuckSteps });
      events.push(...this.applyWeb(fx.stuckSteps));
      return false;
    }
    // --- itens de BÔNUS ----------------------------------------------------------------
    if (fx.grow > 0) {
      events.push({ ...base, grow: fx.grow });
      events.push(...this.growSnake(fx.grow));
      return false;
    }
    if (fx.starSec > 0) {
      events.push({ ...base, seconds: fx.starSec });
      events.push(...this.applyStar(fx.starSec));
      return false;
    }
    if (fx.magnetSec > 0) {
      events.push({ ...base, seconds: fx.magnetSec });
      events.push(...this.applyMagnet(fx.magnetSec));
      return false;
    }
    if (fx.fastSec > 0) {
      events.push({ ...base, seconds: fx.fastSec });
      events.push(...this.applyFast(fx.fastSec));
      return false;
    }
    events.push(base);
    return false;
  }

  /**
   * [itens] 🧲 Ímã: enquanto ativo, cada comida dourada dá um passo em direção à cabeça (no
   * máximo um a cada MAGNET_STEP_SEC), sempre para uma célula LIVRE. Nunca move nada para cima
   * da cobra, de uma bomba ou de outro item, então não existe como quebrar o invariante.
   */
  _magnetPull(dtSec) {
    this._magnetAcc = (this._magnetAcc || 0) + dtSec;
    if (this._magnetAcc < MAGNET_STEP_SEC || this._food.size === 0) return [];
    this._magnetAcc = 0;
    const w = this._w;
    const head = this._snake[0];
    const hx = head % w;
    const hz = Math.floor(head / w);
    const events = [];
    for (const f of this._food.values()) {
      const dx = hx - f.x;
      const dz = hz - f.z;
      if (dx === 0 && dz === 0) continue;
      // Anda no eixo mais distante primeiro (movimento em L, sempre 1 célula por vez).
      const steps = Math.abs(dx) >= Math.abs(dz)
        ? [[Math.sign(dx), 0], [0, Math.sign(dz)]]
        : [[0, Math.sign(dz)], [Math.sign(dx), 0]];
      for (const [sx, sz] of steps) {
        if (sx === 0 && sz === 0) continue;
        const nx = f.x + sx;
        const nz = f.z + sz;
        if (nx < 0 || nz < 0 || nx >= w || nz >= this._h) continue;
        const cell = nz * w + nx;
        if (this._occ[cell] !== 0 || cell === this._apple) continue;
        this._occ[f.cell] &= ~OCC_FOOD;
        f.cell = cell;
        f.x = nx;
        f.z = nz;
        this._occ[cell] |= OCC_FOOD;
        events.push({ type: 'food_move', id: f.id, x: nx, z: nz });
        break;
      }
    }
    return events;
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
