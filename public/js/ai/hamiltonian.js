/**
 * Autonomous snake AI — Hamiltonian cycle with safe shortcuts (SPEC §1, §4.1).
 *
 * Pure ESM: no DOM, no three.js. Importable from Node tests and from the browser.
 *
 * Core idea
 * ---------
 * The board is covered by one Hamiltonian cycle. If the snake body always occupies
 * cells whose cycle positions strictly increase from tail to head (cyclically, with a
 * total span < n), then every cell strictly *ahead* of the head along the cycle and
 * strictly *before* the anchor (the cell that will be the tail after the move) is
 * guaranteed to be free. Moving onto such a cell keeps the ordering invariant, so
 * the snake can never run into itself, and the cycle successor of the head is always
 * one of those cells (dist = 1), so a legal move always exists. Walls are never an
 * issue because candidates are taken from the 4-neighbour table (out-of-bounds = -1).
 *
 * Proof sketch of the safety rule (see SPEC §4.1)
 * ------------------------------------------------
 * Let offsets be measured from the anchor `a` (tail if growing, second-to-last segment
 * otherwise): d(c) = distFwd(a, c). Body cells other than the tail satisfy
 * 0 <= d(body) <= d(head) = S < n. A neighbour c with 0 < distFwd(head, c) < distFwd(head, a)
 * has d(c) = S + distFwd(head, c) in (S, n) — strictly beyond every body cell and
 * strictly before wrapping back onto the anchor. Hence c is free (it is not a body cell
 * that survives the move), and the new body [c, head, ..., a] is again strictly increasing
 * with span d(c) < n. When not growing, the old tail leaves the board, which is why the
 * anchor is the second-to-last segment: the head may legally step onto the old tail cell.
 * The cycle successor has distFwd(head, succ) = 1; distFwd(head, a) >= 2 whenever a is a
 * body cell different from head and different from succ (the only cell with distFwd 1 is
 * succ itself; when growing succ === apple which is never a body cell). Therefore the
 * successor is always safe.
 */

/** Direction table, same order as the prototype: 0 up (-z), 1 right (+x), 2 down (+z), 3 left (-x). */
export const DIRS = Object.freeze([
  Object.freeze({ x: 0, z: -1 }),
  Object.freeze({ x: 1, z: 0 }),
  Object.freeze({ x: 0, z: 1 }),
  Object.freeze({ x: -1, z: 0 }),
]);

const DEFAULT_SHORTCUT_MAX_FILL = 0.5;

/**
 * Emit the canonical zig-zag cycle over a W×H grid whose H is even, as (u, v) pairs:
 * row 0 left→right, rows 1..H-1 zig-zag over columns 1..W-1, then column 0 upward.
 * The caller maps (u, v) to real coordinates (possibly transposed).
 */
function emitCanonicalCycle(W, H, emit) {
  for (let u = 0; u < W; u++) emit(u, 0);
  for (let v = 1; v < H; v++) {
    if (v & 1) {
      for (let u = W - 1; u >= 1; u--) emit(u, v);
    } else {
      for (let u = 1; u < W; u++) emit(u, v);
    }
  }
  for (let v = H - 1; v >= 1; v--) emit(0, v);
}

/**
 * Build a Hamiltonian cycle for a w×h board.
 * @returns {{ w:number, h:number, n:number, pos:Int32Array, cells:Int32Array }}
 *   pos[cellIdx] = cycle position, cells[position] = cellIdx.
 * @throws {RangeError} if w*h is odd or w < 2 or h < 2 (no Hamiltonian cycle exists).
 */
export function buildCycle(w, h) {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 2 || h < 2 || (w * h) % 2 !== 0) {
    throw new RangeError(`buildCycle: tabuleiro inválido ${w}x${h} (w e h devem ser inteiros >= 2 e w*h par)`);
  }
  const n = w * h;
  const pos = new Int32Array(n);
  const cells = new Int32Array(n);
  let k = 0;
  const put = (x, z) => {
    const idx = z * w + x;
    cells[k] = idx;
    pos[idx] = k;
    k++;
  };
  if (h % 2 === 0) {
    // Canonical construction (SPEC §4.1): u = x, v = z.
    emitCanonicalCycle(w, h, (u, v) => put(u, v));
  } else {
    // h odd, therefore w even: transpose the construction (u = z, v = x).
    emitCanonicalCycle(h, w, (u, v) => put(v, u));
  }
  return { w, h, n, pos, cells };
}

/** Forward distance along the cycle from cell a to cell b: (pos[b] - pos[a] + n) % n. */
export function distFwd(cycle, aCell, bCell) {
  const n = cycle.n;
  return (cycle.pos[bCell] - cycle.pos[aCell] + n) % n;
}

/**
 * Validate that `cycle` is a closed Hamiltonian cycle over its w×h grid:
 * every cell exactly once, consecutive cells 4-adjacent (including last→first), pos = cells⁻¹.
 */
export function isHamiltonianCycle(cycle) {
  if (!cycle || typeof cycle !== 'object') return false;
  const { w, h, n, pos, cells } = cycle;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || n !== w * h) return false;
  if (!pos || !cells || pos.length !== n || cells.length !== n) return false;
  const seen = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    const c = cells[p];
    if (!Number.isInteger(c) || c < 0 || c >= n || seen[c]) return false;
    seen[c] = 1;
    if (pos[c] !== p) return false;
    const nx = cells[(p + 1) % n];
    if (!Number.isInteger(nx) || nx < 0 || nx >= n) return false;
    const dx = Math.abs((nx % w) - (c % w));
    const dz = Math.abs(Math.floor(nx / w) - Math.floor(c / w));
    if (dx + dz !== 1) return false;
  }
  return true;
}

/**
 * Check the body-ordering invariant that the AI relies on (exported for tests and debugging).
 * Returns null when the snake is valid, otherwise a short reason string.
 * Checks: in-bounds cells, no duplicates, consecutive segments 4-adjacent, cycle positions
 * strictly increasing from tail to head with total span < n.
 */
export function validateSnake(cycle, snake) {
  const { w, h, n, pos } = cycle;
  const len = snake.length;
  if (len < 1) return 'snake vazia';
  const seen = new Uint8Array(n);
  for (let i = 0; i < len; i++) {
    const c = snake[i];
    if (!Number.isInteger(c) || c < 0 || c >= n) return `segmento ${i} fora do tabuleiro: ${c}`;
    if (seen[c]) return `célula duplicada ${c} (segmento ${i})`;
    seen[c] = 1;
    if (i > 0) {
      const p = snake[i - 1];
      const dx = Math.abs((p % w) - (c % w));
      const dz = Math.abs(Math.floor(p / w) - Math.floor(c / w));
      if (dx + dz !== 1) return `segmentos ${i - 1} e ${i} não são adjacentes (${p} -> ${c})`;
    }
    if (w * h !== n) return 'ciclo inconsistente';
  }
  const tail = snake[len - 1];
  let prevOff = 0;
  for (let i = len - 2; i >= 0; i--) {
    const off = (pos[snake[i]] - pos[tail] + n) % n;
    if (off <= prevOff) return `ordem no ciclo quebrada no segmento ${i} (offset ${off} <= ${prevOff})`;
    prevOff = off;
  }
  return null; // prevOff < n is implied by the modulo
}

// ---------------------------------------------------------------------------------------
// Precomputed per-cycle tables (neighbour lists), cached by cycle object identity.
// ---------------------------------------------------------------------------------------

const tableCache = new WeakMap();

function getTables(cycle) {
  let t = tableCache.get(cycle);
  if (t) return t;
  const { w, h, n } = cycle;
  const nbr = new Int32Array(n * 4).fill(-1); // nbr[cell*4 + dir], -1 = wall
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      const i = z * w + x;
      if (z > 0) nbr[i * 4] = i - w;
      if (x < w - 1) nbr[i * 4 + 1] = i + 1;
      if (z < h - 1) nbr[i * 4 + 2] = i + w;
      if (x > 0) nbr[i * 4 + 3] = i - 1;
    }
  }
  t = { nbr };
  tableCache.set(cycle, t);
  return t;
}

// ---------------------------------------------------------------------------------------
// safeMoves
// ---------------------------------------------------------------------------------------

/**
 * All safe neighbours of the head (SPEC §4.1 safety rule).
 * @returns {Array<{cell:number, dir:number, dist:number}>} never empty for a valid snake.
 */
export function safeMoves(cycle, snake, apple) {
  const { n, pos } = cycle;
  const { nbr } = getTables(cycle);
  const len = snake.length;
  const head = snake[0];
  const tail = snake[len - 1];
  const anchorNoGrow = len >= 2 ? snake[len - 2] : head;
  const hp = pos[head];
  // When the anchor coincides with the head (len 1, or len 2 not growing) every cell is
  // strictly ahead of the head, so the limit is the full circle.
  const limitGrow = tail === head ? n : (pos[tail] - hp + n) % n;
  const limitNoGrow = anchorNoGrow === head ? n : (pos[anchorNoGrow] - hp + n) % n;
  const out = [];
  const base = head * 4;
  for (let d = 0; d < 4; d++) {
    const c = nbr[base + d];
    if (c < 0) continue;
    const dist = (pos[c] - hp + n) % n;
    const limit = c === apple ? limitGrow : limitNoGrow;
    if (dist > 0 && dist < limit) out.push({ cell: c, dir: d, dist });
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// nextMove — bombs are IGNORED by design: the product rule (client request 2026-09-03) is
// that the snake ploughs through bombs on its route, shrinking when it hits one. Routing
// only cares about the apple and the safety invariant.
// ---------------------------------------------------------------------------------------

const CAND_CELL = new Int32Array(4);
const CAND_DIR = new Int32Array(4);
const CAND_DIST = new Int32Array(4);

/**
 * Decide the next move (SPEC §4.1 move policy).
 * @param {object} cycle from buildCycle
 * @param {ArrayLike<number>} snake cell indices, head first (length >= 1)
 * @param {number} apple cell index or -1
 * @param {{shortcutMaxFill?:number, allowShortcuts?:boolean}} [opts]
 * @returns {{cell:number, dir:number, shortcut:boolean, eatsApple:boolean}}
 */
export function nextMove(cycle, snake, apple, opts) {
  const { n, pos } = cycle;
  const { nbr } = getTables(cycle);
  const len = snake.length;
  if (len < 1) throw new RangeError('nextMove: a cobra precisa ter pelo menos 1 segmento');

  const shortcutMaxFill = opts && Number.isFinite(opts.shortcutMaxFill) ? opts.shortcutMaxFill : DEFAULT_SHORTCUT_MAX_FILL;
  const allowShortcuts = !opts || opts.allowShortcuts !== false;
  if (!Number.isInteger(apple) || apple < 0 || apple >= n) apple = -1;

  const head = snake[0];
  const tail = snake[len - 1];
  const anchorNoGrow = len >= 2 ? snake[len - 2] : head;
  const hp = pos[head];
  const limitGrow = tail === head ? n : (pos[tail] - hp + n) % n;
  const limitNoGrow = anchorNoGrow === head ? n : (pos[anchorNoGrow] - hp + n) % n;

  // 1. Safe candidates (into scratch arrays).
  let count = 0;
  const base = head * 4;
  for (let d = 0; d < 4; d++) {
    const c = nbr[base + d];
    if (c < 0) continue;
    const dist = (pos[c] - hp + n) % n;
    if (dist === 0 || dist >= (c === apple ? limitGrow : limitNoGrow)) continue;
    CAND_CELL[count] = c;
    CAND_DIR[count] = d;
    CAND_DIST[count] = dist;
    count++;
  }
  if (count === 0) return fallbackMove(cycle, nbr, snake, apple);

  // 2./3. Apple ahead on the free arc → shortcut mode while the board is not too full.
  const distApple = apple >= 0 ? (pos[apple] - hp + n) % n : -1;
  const appleAhead = apple >= 0 && distApple > 0 && distApple < limitNoGrow;
  const useShortcuts = allowShortcuts && len < shortcutMaxFill * n && appleAhead;

  // 4. Pick: preferred-set membership → larger dist (shortcuts) / smaller dist (cycle).
  let bestI = 0;
  for (let i = 1; i < count; i++) {
    if (isBetterCandidate(i, bestI, useShortcuts, distApple)) bestI = i;
  }

  const cell = CAND_CELL[bestI];
  return {
    cell,
    dir: CAND_DIR[bestI],
    shortcut: CAND_DIST[bestI] !== 1,
    eatsApple: cell === apple,
  };
}

/** Compare candidates i and j from the scratch arrays; true when i should replace j. */
function isBetterCandidate(i, j, useShortcuts, distApple) {
  const di = CAND_DIST[i];
  const dj = CAND_DIST[j];
  const pi = useShortcuts ? di <= distApple : di === 1;
  const pj = useShortcuts ? dj <= distApple : dj === 1;
  if (pi !== pj) return pi;
  return useShortcuts ? di > dj : di < dj;
}

/**
 * Last-resort move when no candidate satisfies the safety rule. This is unreachable while
 * the body invariant holds (the cycle successor is always safe); it only protects the game
 * loop from freezing if a caller feeds an arbitrary snake. Prefers a free neighbour, then
 * the cycle successor.
 */
function fallbackMove(cycle, nbr, snake, apple) {
  const { n, pos, cells } = cycle;
  const len = snake.length;
  const head = snake[0];
  const occupied = new Uint8Array(n);
  for (let i = 0; i < len; i++) occupied[snake[i]] = 1;
  const succ = cells[(pos[head] + 1) % n];
  let pick = -1;
  let pickDir = -1;
  for (let d = 0; d < 4; d++) {
    const c = nbr[head * 4 + d];
    if (c < 0 || occupied[c]) continue;
    if (pick < 0 || c === succ) {
      pick = c;
      pickDir = d;
    }
  }
  if (pick < 0) {
    pick = succ;
    for (let d = 0; d < 4; d++) if (nbr[head * 4 + d] === succ) pickDir = d;
  }
  return {
    cell: pick,
    dir: pickDir,
    shortcut: pick !== succ,
    eatsApple: pick === apple,
  };
}
