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
 *
 * Route variety (client request 2026-09-04)
 * -----------------------------------------
 * The safety argument above depends ONLY on the ordering invariant, never on the *shape* of
 * the cycle. So each round may run on a different Hamiltonian cycle and the snake still can
 * never collide. `buildCycle(w, h, { seed })` generates a genuinely random cycle via the
 * classic spanning-tree construction: a uniform-ish random spanning tree of the reduced
 * (w/2 x h/2) grid, whose perimeter walk is exactly one Hamiltonian cycle of the full grid.
 * That gives combinatorially many distinct routes (a 16x16 board has a 8x8 reduced grid,
 * i.e. astronomically many spanning trees) instead of the single canonical zig-zag.
 *
 * `buildCycle(w, h)` with no options still returns the exact canonical cycle, so existing
 * callers and tests are unaffected.
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

/** Small deterministic PRNG (mulberry32), duplicated here so the AI has no imports. */
function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Random spanning tree of the W×H reduced grid (randomised Kruskal with union-find).
 * `forced` edges are added first (the caller guarantees they are acyclic) and `forbidden`
 * edges are never added — together they pin down the local shape the game start needs.
 * @returns {Set<number>} undirected edge keys (min*N + max)
 */
function randomSpanningTree(W, H, rng, forced, forbidden) {
  const N = W * H;
  const edgeKey = (a, b) => (a < b ? a * N + b : b * N + a);
  const tree = new Set();
  const parent = new Int32Array(N);
  for (let i = 0; i < N; i++) parent[i] = i;
  const find = (a) => {
    let r = a;
    while (parent[r] !== r) r = parent[r];
    while (parent[a] !== r) { const nx = parent[a]; parent[a] = r; a = nx; } // path compression
    return r;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return false;
    parent[ra] = rb;
    return true;
  };
  for (let i = 0; i < forced.length; i++) {
    const [a, b] = forced[i];
    if (union(a, b)) tree.add(edgeKey(a, b));
  }
  // All grid edges, shuffled (Fisher-Yates) — a random-weight Kruskal run.
  const all = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (x + 1 < W) all.push(i, i + 1);
      if (y + 1 < H) all.push(i, i + W);
    }
  }
  const m = all.length >> 1;
  for (let i = m - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const ai = i << 1;
    const aj = j << 1;
    const t0 = all[ai]; const t1 = all[ai + 1];
    all[ai] = all[aj]; all[ai + 1] = all[aj + 1];
    all[aj] = t0; all[aj + 1] = t1;
  }
  for (let e = 0; e < m; e++) {
    const a = all[e << 1];
    const b = all[(e << 1) + 1];
    const k = edgeKey(a, b);
    if (tree.has(k) || forbidden.has(k)) continue;
    if (union(a, b)) tree.add(k);
  }
  return tree;
}

/**
 * Trace the perimeter walk of a spanning tree of the (w/2)×(h/2) reduced grid. Each tree
 * node is a 2×2 block of board cells; walking clockwise around every block and crossing into
 * the neighbouring block wherever a tree edge exists visits every cell exactly once and
 * returns to the start — i.e. a Hamiltonian cycle. Requires w and h even.
 */
function cycleFromTree(w, h, tree) {
  const W = w >> 1;
  const H = h >> 1;
  const N = W * H;
  const n = w * h;
  const edgeKey = (a, b) => (a < b ? a * N + b : b * N + a);
  const has = (a, b) => tree.has(edgeKey(a, b));
  const cells = new Int32Array(n);
  const pos = new Int32Array(n);
  let x = 0;
  let y = 0;
  let k = 0;
  do {
    const idx = y * w + x;
    cells[k] = idx;
    pos[idx] = k;
    k++;
    if (k > n) throw new Error('cycleFromTree: caminhada não fechou');
    const X = x >> 1;
    const Y = y >> 1;
    const node = Y * W + X;
    const sx = x & 1;
    const sy = y & 1;
    // Clockwise inside the block: (0,0) → (1,0) → (1,1) → (0,1) → (0,0); a tree edge on the
    // side we are facing sends us into the neighbouring block instead.
    if (sx === 0 && sy === 0) {
      if (Y > 0 && has(node, node - W)) y -= 1; else x += 1;
    } else if (sx === 1 && sy === 0) {
      if (X + 1 < W && has(node, node + 1)) x += 1; else y += 1;
    } else if (sx === 1 && sy === 1) {
      if (Y + 1 < H && has(node, node + W)) y += 1; else x -= 1;
    } else {
      if (X > 0 && has(node, node - 1)) x -= 1; else y -= 1;
    }
  } while (!(x === 0 && y === 0));
  if (k !== n) throw new Error(`cycleFromTree: caminhada visitou ${k}/${n} células`);
  return { w, h, n, pos, cells };
}

/**
 * Tree constraints that guarantee the game's starting placement exists on the generated
 * cycle: the three cells (xc-2, zc), (xc-1, zc), (xc, zc) must appear consecutively, in that
 * forward order, where xc = w/2 and zc is a central row.
 *
 * Reading the walk rule in cycleFromTree, a cell can be left RIGHTWARDS only from sub-row
 * sy = 0 (an even z), and then:
 *   sub-cell (0,0) → right iff its block has NO up-edge;
 *   sub-cell (1,0) → right iff its block HAS a right-edge.
 * So the run must sit on the even one of the two central rows (h is even, so exactly one of
 * h/2 and h/2 - 1 is even — and `_placeSnake` tries both). The two leftmost cells of the run
 * carry one constraint each; they touch either one block (xc even) or two adjacent blocks
 * (xc odd), and in both cases the forced and forbidden edges are distinct, so a spanning tree
 * satisfying them always exists.
 *
 * @returns {{ forced: Array<[number, number]>, forbidden: Set<number>, zc: number }}
 */
function startRunConstraints(w, h) {
  const W = w >> 1;
  const H = h >> 1;
  const N = W * H;
  const edgeKey = (a, b) => (a < b ? a * N + b : b * N + a);
  const xc = w >> 1;
  // The even central row — the only one that can carry a left-to-right run.
  const mid = h >> 1;
  const zc = mid % 2 === 0 ? mid : mid - 1;
  const Y = zc >> 1;
  const forced = [];
  const forbidden = new Set();
  // One constraint per departure: cells (xc-2, zc) and (xc-1, zc) must both step right.
  for (const x of [xc - 2, xc - 1]) {
    const X = x >> 1;
    const node = Y * W + X;
    if ((x & 1) === 0) {
      // sub-cell (0,0): must NOT have an up-edge.
      if (Y > 0) forbidden.add(edgeKey(node, node - W));
    } else {
      // sub-cell (1,0): must have a right-edge.
      if (X + 1 < W) forced.push([node, node + 1]);
    }
  }
  return { forced, forbidden, zc };
}

/**
 * True when the board can carry a randomly generated cycle: both sides even and at least 4,
 * so the reduced grid is a real 2×2-or-bigger grid and the start-run constraints fit.
 */
function supportsRandomCycle(w, h) {
  return w % 2 === 0 && h % 2 === 0 && w >= 4 && h >= 4;
}

/**
 * True when the cycle contains the run the game's start placement needs: the three cells
 * (xc-2, zc), (xc-1, zc), (xc, zc) consecutive in forward order, on one of the two central
 * rows. `startRunConstraints` is designed to guarantee this; this is the verification.
 */
function hasStartRun(cycle) {
  const { w, h, n, pos } = cycle;
  const xc = w >> 1;
  if (xc < 2) return false;
  for (const zc of [h >> 1, (h >> 1) - 1]) {
    if (zc < 0) continue;
    const head = zc * w + xc;
    if ((pos[head] - pos[head - 1] + n) % n === 1 && (pos[head - 1] - pos[head - 2] + n) % n === 1) {
      return true;
    }
  }
  return false;
}

/** Cache of generated cycles, keyed by `${w}x${h}:${seed}` (see buildCycle opts.cache). */
const cycleCache = new Map();
const CYCLE_CACHE_MAX = 64;

/** Build the canonical zig-zag cycle (the original, deterministic construction). */
function buildCanonicalCycle(w, h) {
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

/**
 * Build a Hamiltonian cycle for a w×h board.
 *
 * With no `opts` (or no `opts.seed`) this returns the canonical zig-zag cycle, byte for byte
 * what it always returned — existing callers and tests keep their exact behaviour.
 *
 * With `opts.seed` it returns a RANDOM Hamiltonian cycle for that seed (see the module header):
 * different seeds give visually different routes, the same seed always gives the same cycle,
 * and every result is a genuine Hamiltonian cycle, so the AI's safety guarantee is untouched.
 * Random generation needs both sides even and >= 4; other shapes fall back to the canonical
 * cycle. Results are cached by (w, h, seed) — generation is ~0.1 ms on 24x24, but the game
 * loop never pays even that twice.
 *
 * @param {number} w
 * @param {number} h
 * @param {{ seed?:number, cache?:boolean }} [opts]
 * @returns {{ w:number, h:number, n:number, pos:Int32Array, cells:Int32Array, seed:number, variant:string }}
 *   pos[cellIdx] = cycle position, cells[position] = cellIdx.
 * @throws {RangeError} if w*h is odd or w < 2 or h < 2 (no Hamiltonian cycle exists).
 */
export function buildCycle(w, h, opts) {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 2 || h < 2 || (w * h) % 2 !== 0) {
    throw new RangeError(`buildCycle: tabuleiro inválido ${w}x${h} (w e h devem ser inteiros >= 2 e w*h par)`);
  }
  const seed = opts && Number.isFinite(opts.seed) ? Math.trunc(opts.seed) >>> 0 : null;
  if (seed === null || !supportsRandomCycle(w, h)) {
    const cycle = buildCanonicalCycle(w, h);
    cycle.seed = seed ?? 0;
    cycle.variant = 'canonical';
    return cycle;
  }
  const useCache = !opts || opts.cache !== false;
  const key = `${w}x${h}:${seed}`;
  if (useCache) {
    const hit = cycleCache.get(key);
    if (hit) return hit;
  }
  const { forced, forbidden } = startRunConstraints(w, h);
  const tree = randomSpanningTree(w >> 1, h >> 1, makeRng(seed), forced, forbidden);
  const cycle = cycleFromTree(w, h, tree);
  // Cheap contract check: the generated route must be usable by the game's start placement.
  // Falling back to the canonical cycle is always correct (just less varied) and is strictly
  // better than handing the caller a cycle its snake cannot be laid out on.
  if (!hasStartRun(cycle)) {
    const fallback = buildCanonicalCycle(w, h);
    fallback.seed = seed;
    fallback.variant = 'canonical';
    return fallback;
  }
  cycle.seed = seed;
  cycle.variant = 'tree';
  if (useCache) {
    // Bounded LRU-ish: drop the oldest entry once the map is full.
    if (cycleCache.size >= CYCLE_CACHE_MAX) cycleCache.delete(cycleCache.keys().next().value);
    cycleCache.set(key, cycle);
  }
  return cycle;
}

/** Drop every cached generated cycle (tests / memory pressure). */
export function clearCycleCache() {
  cycleCache.clear();
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
