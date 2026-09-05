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
// only cares about the food and the safety invariant.
//
// [ia-pro] Pro-player move policy (client request 2026-09-04: "deixe a movimentação dela
// como se fosse um jogador ... ela tá com padrão de fazer as coisas sempre as mesmas voltas")
// --------------------------------------------------------------------------------------
// The old policy ranked the safe neighbours ONLY by their distance along the Hamiltonian
// cycle ("jump as far as possible without overshooting the apple"). It never looked at the
// real board distance, which is exactly what produced the wide, sweepy, robotic laps: the
// shortcut was measured on the cycle, not on the grid.
//
// The safety net does NOT change. The candidate set is still exactly the set of cells that
// satisfy the ordering invariant (`safeMoves`), so every returned move is still provably
// collision-free and the win is still guaranteed. What changes is only HOW we rank that set:
//
//   L0  Aggressive shortest path (early/mid game): BFS over the free board from the head to
//       the target, then a "tail reachability" simulation — if I walk that path and eat, can
//       I still reach my own tail / do I still have room >= my length? This is the classic
//       human heuristic. Only the FIRST STEP is taken, and only if that first step is also in
//       the safe set. Skipped once the board gets full.
//   L1  Grid-distance scoring of the safe set: real Manhattan/BFS closeness to the target,
//       free-space flood fill after the move (never trap yourself), tail reachability bonus,
//       a straight-line bonus (no pointless turns — it reads better on stream), an
//       anti-oscillation penalty and a small seeded random jitter for round-to-round variety.
//   L2  Cycle policy (unchanged): when the board is full, or when nothing above is safe, fall
//       back to the original ranking, which is what closes out the win without knotting up.
//
// The three layers blend by fill ratio rather than switching hard, so the change of style is
// not visible as a jolt on stream.
// ---------------------------------------------------------------------------------------

const CAND_CELL = new Int32Array(4);
const CAND_DIR = new Int32Array(4);
const CAND_DIST = new Int32Array(4);
/** [ia-pro] 1 when the candidate preserves forward progress along the cycle (see nextMove). */
const CAND_OK = new Int32Array(4);

// These two thresholds were tuned by measurement, not taste (see test/ai-pro.test.js, which
// reports steps-per-apple per phase). Letting the grid-scoring layers run deep into the
// endgame is actively WORSE than the cycle policy: above ~50 % fill the greedy move keeps
// walking into pockets it then needs many steps to escape, which cost more than the direct
// approach saved. Measured over 48 games (sizes 8/10/12/16), overall steps-per-apple:
//   PATH/SCORE 0.62/0.72 -> 30.48   (worse than the old policy's 29.03)
//   PATH/SCORE 0.45/0.50 -> 25.68   (best; the values used here)
//   PATH/SCORE 0.30/0.35 -> 28.41
/** Fill ratio above which the shortest-path layer is switched off entirely (endgame). */
// [show] Subidos de 0,45/0,50 para 0,62/0,68: acima desses limiares a política do ciclo assume,
// e ela é varredura pura — visualmente robótica. Adiar a troca deixa a cobra "jogando" por muito
// mais tempo. A segurança não depende destes números (vem do invariante de ordem), então o único
// custo possível seria eficiência no fim de jogo, medida nos testes.
const PATH_MAX_FILL = 0.62;
/** Fill ratio above which grid scoring gives way to the pure cycle policy. */
const SCORE_MAX_FILL = 0.68;

// Scratch buffers for BFS / flood fill, grown on demand and reused across calls so that a
// nextMove call allocates nothing in steady state (the game loop runs this every tick).
let SCRATCH_N = 0;
let BFS_QUEUE = new Int32Array(0);
let BFS_MARK = new Int32Array(0); // generation-stamped, so no per-call clearing
let BFS_PREV = new Int32Array(0);
let BFS_GEN = 0;

function ensureScratch(n) {
  if (SCRATCH_N >= n) return;
  SCRATCH_N = n;
  BFS_QUEUE = new Int32Array(n);
  BFS_MARK = new Int32Array(n);
  BFS_PREV = new Int32Array(n);
  BFS_GEN = 0;
}

/** Manhattan distance between two cell indices on a w-wide board. */
function manhattan(w, a, b) {
  const dx = (a % w) - (b % w);
  const dz = Math.floor(a / w) - Math.floor(b / w);
  return (dx < 0 ? -dx : dx) + (dz < 0 ? -dz : dz);
}

/**
 * Breadth-first search over the free board (cells with `blocked[c] !== blockGen`), starting at
 * `from`, stopping at `to`. Returns the first step of a shortest path (the neighbour of `from`
 * to move onto), or -1 when `to` is unreachable. `to === from` returns -1.
 */
// [show] Ordens de varredura das 4 direções. O BFS sempre explorava 0,1,2,3 e, entre vários
// caminhos igualmente curtos, devolvia sempre o mesmo — daí a cobra atravessar o tabuleiro em
// linha reta com o mesmo desenho toda rodada. Sorteando a ordem por rodada, o caminho continua
// sendo O MAIS CURTO (o BFS garante isso), mas o traçado muda.
const DIR_ORDERS = [
  [0, 1, 2, 3], [1, 2, 3, 0], [2, 3, 0, 1], [3, 0, 1, 2],
  [0, 2, 1, 3], [1, 3, 0, 2], [2, 0, 3, 1], [3, 1, 2, 0],
];

/** [show] Quantas casas a cobra já vem em linha reta, lidas do corpo (limitado a `max`). */
function straightRunOf(w, snake, max) {
  if (snake.length < 3) return 0;
  const d0 = dirBetweenCells(w, snake[1], snake[0]);
  if (d0 < 0) return 0;
  let n = 0;
  for (let k = 1; k < snake.length - 1 && n < max; k++) {
    if (dirBetweenCells(w, snake[k + 1], snake[k]) !== d0) break;
    n++;
  }
  return n;
}

function bfsFirstStep(nbr, blocked, blockGen, from, to, order) {
  if (to < 0 || to === from) return -1;
  const gen = ++BFS_GEN;
  const mark = BFS_MARK;
  const prev = BFS_PREV;
  const queue = BFS_QUEUE;
  let qh = 0;
  let qt = 0;
  queue[qt++] = from;
  mark[from] = gen;
  prev[from] = -1;
  while (qh < qt) {
    const c = queue[qh++];
    const base = c * 4;
    for (let oi = 0; oi < 4; oi++) {
      const d = order ? order[oi] : oi;
      const nx = nbr[base + d];
      if (nx < 0 || mark[nx] === gen) continue;
      if (nx !== to && blocked[nx] === blockGen) continue;
      mark[nx] = gen;
      prev[nx] = c;
      if (nx === to) {
        // Walk back to the cell right after `from`.
        let cur = nx;
        while (prev[cur] !== from) cur = prev[cur];
        return cur;
      }
      queue[qt++] = nx;
    }
  }
  return -1;
}

/**
 * Simulate walking the shortest path from `head` to `target` (eating it), then check that the
 * resulting body can still reach its own tail, and that the free space around the new head is
 * at least the new length. This is the "shortest path + tail reachability" test a good human
 * player does by instinct: take the fast route only when it does not shut you in.
 *
 * Cheap approximation on purpose: instead of replaying the whole path we place the body as it
 * would be after `steps` moves along that path, using the path cells themselves. Only used as
 * a gate — whatever it returns, the move actually taken is still checked against the cycle
 * invariant, so a wrong answer here can cost efficiency but never safety.
 */
function pathIsSafe(cycle, nbr, snake, firstStep, target, blocked, occGen) {
  const n = cycle.n;
  const len = snake.length;
  ensurePathScratch(n);
  // Length of the shortest route head → target that starts with `firstStep`.
  const rest = bfsDistance(nbr, blocked, occGen, firstStep, target);
  if (rest < 0) return false;
  const pathLen = 1 + rest; // number of steps taken from the head to reach the target

  // Reconstruct the post-eat body into a dedicated buffer (never shared with the BFS marks,
  // so the reachability search below can stamp freely).
  const blk = PATH_BLOCK;
  const bgen = ++PATH_GEN;
  // After walking `pathLen` steps and growing by 1, the surviving old segments are
  // snake[0 .. survive-2]; the rest of the new body is made of the path cells.
  const survive = len + 1 - pathLen;
  let newTail = target;
  if (survive > 1) {
    for (let i = 0; i < survive - 1; i++) blk[snake[i]] = bgen;
    newTail = snake[survive - 2];
  }
  // The path cells the body now occupies. We only know the two ends cheaply (first step and
  // target); the interior is bounded by the same BFS and blocking them is not required for a
  // conservative answer — we block what we know, which keeps the test on the safe side.
  blk[target] = bgen;
  blk[firstStep] = bgen;

  // Can the new head still reach the new tail, and is there room for the new length?
  const gen = ++BFS_GEN;
  const seen = BFS_MARK;
  const q = BFS_QUEUE;
  let qh = 0;
  let qt = 0;
  q[qt++] = target;
  seen[target] = gen;
  let room = 1;
  const need = len + 1;
  let reachedTail = newTail === target;
  while (qh < qt) {
    const c = q[qh++];
    const base = c * 4;
    for (let d = 0; d < 4; d++) {
      const nx = nbr[base + d];
      if (nx < 0 || seen[nx] === gen || blk[nx] === bgen) continue;
      seen[nx] = gen;
      room++;
      if (nx === newTail) reachedTail = true;
      if (reachedTail && room >= need) return true;
      q[qt++] = nx;
    }
  }
  return reachedTail && room >= need;
}

// Dedicated post-move occupancy buffer for pathIsSafe (kept separate from the BFS marks).
let PATH_BLOCK = new Int32Array(0);
let PATH_GEN = 0;

function ensurePathScratch(n) {
  if (PATH_BLOCK.length >= n) return;
  PATH_BLOCK = new Int32Array(n);
  PATH_GEN = 0;
}

/** BFS distance over the free board; -1 when unreachable. `to` itself is always enterable. */
function bfsDistance(nbr, blocked, blockGen, from, to) {
  if (from === to) return 0;
  const gen = ++BFS_GEN;
  const mark = BFS_MARK;
  const queue = BFS_QUEUE;
  const dist = BFS_PREV; // reused as a distance array here
  let qh = 0;
  let qt = 0;
  queue[qt++] = from;
  mark[from] = gen;
  dist[from] = 0;
  while (qh < qt) {
    const c = queue[qh++];
    const dc = dist[c];
    const base = c * 4;
    for (let d = 0; d < 4; d++) {
      const nx = nbr[base + d];
      if (nx < 0 || mark[nx] === gen) continue;
      if (nx !== to && blocked[nx] === blockGen) continue;
      mark[nx] = gen;
      dist[nx] = dc + 1;
      if (nx === to) return dc + 1;
      queue[qt++] = nx;
    }
  }
  return -1;
}

// Occupancy buffer, generation-stamped like the BFS marks so it never needs clearing.
let OCC_BUF = new Int32Array(0);
let OCC_GEN = 0;

function ensureOcc(n) {
  if (OCC_BUF.length >= n) return;
  OCC_BUF = new Int32Array(n);
  OCC_GEN = 0;
}

/**
 * Decide the next move.
 *
 * @param {object} cycle from buildCycle
 * @param {ArrayLike<number>} snake cell indices, head first (length >= 1)
 * @param {number} apple cell index or -1 (the primary target)
 * @param {{shortcutMaxFill?:number, allowShortcuts?:boolean, foods?:ArrayLike<number>,
 *          rng?:function():number, style?:string}} [opts]
 *   `foods` — [ia-pro] extra edible cells (golden bonus food); the AI picks whichever target
 *   is closest ON THE GRID. Optional and backwards compatible.
 *   `rng` — injectable RNG used only to break exact ties, so tests stay deterministic.
 *   `style` — 'pro' (default) or 'cycle' to force the original cycle-only policy.
 * @returns {{cell:number, dir:number, shortcut:boolean, eatsApple:boolean}}
 */
export function nextMove(cycle, snake, apple, opts) {
  const { n, w, pos } = cycle;
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

  // 1. Safe candidates (into scratch arrays) — UNCHANGED: this is the safety net.
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

  const distApple = apple >= 0 ? (pos[apple] - hp + n) % n : -1;
  const appleAhead = apple >= 0 && distApple > 0 && distApple < limitNoGrow;
  const useShortcuts = allowShortcuts && len < shortcutMaxFill * n && appleAhead;

  // [ia-pro] The pro layers only ever run when there is something to chase and shortcuts are
  // allowed. With no target (apple = -1) the behaviour is byte-for-byte the old one: follow
  // the cycle. That also keeps `allowShortcuts:false` / `shortcutMaxFill:0` exactly as before.
  //
  // TERMINATION (why this is not just "score and pick the best"): the old policy could not
  // livelock because every move it chose advanced the head along the cycle without passing
  // the apple, so distFwd(head, apple) strictly decreased and the apple was always reached.
  // Free-form grid scoring has no such property — an early draft of this policy orbited a
  // 10-cell pocket forever, never reaching an apple two rows away, because the locally
  // "closest" neighbour kept stepping backwards along the cycle.
  //
  // The rule used here keeps that guarantee while being far less restrictive than copying the
  // old preferred set: a candidate is ELIGIBLE iff it strictly reduces the remaining forward
  // distance to the apple, i.e. distFwd(c, apple) < distFwd(head, apple). Since that quantity
  // is a non-negative integer that drops by at least 1 on every move, the apple is reached in
  // at most distFwd(head, apple) steps — so the game always progresses and the win still
  // holds. Note this admits everything the old policy allowed (any 0 < dist <= distApple has
  // distFwd(c, apple) = distApple - dist < distApple) AND the many cells the old rule threw
  // away, which is exactly the freedom the grid-distance scoring needs in order to matter.
  // The gate honours BOTH shortcut switches — a caller that passes allowShortcuts:false or
  // drives shortcutMaxFill below the current fill is asking for the plain cycle walk and must
  // keep getting exactly that. It deliberately does NOT require `appleAhead`: needing the
  // apple to sit ahead on the cycle is the old policy's own restriction, and keeping it here
  // would leave the pro layers idle for most of a game (measured: they would run on ~10 % of
  // steps, and the efficiency gain collapses to noise).
  const shortcutsOn = allowShortcuts && len < shortcutMaxFill * n;
  const styleCycle = opts && opts.style === 'cycle';
  if (!styleCycle && shortcutsOn && apple >= 0 && count > 1 && distApple > 0) {
    const fill = len / n;
    if (fill < SCORE_MAX_FILL) {
      // Mark the progress-preserving candidates.
      let eligible = 0;
      for (let i = 0; i < count; i++) {
        const remaining = (distApple - CAND_DIST[i] + n) % n; // distFwd(candidate, apple)
        const ok = remaining < distApple;
        CAND_OK[i] = ok ? 1 : 0;
        if (ok) eligible++;
      }
      if (eligible > 1) {
        const picked = proPick(cycle, nbr, snake, apple, opts, count, fill, head, w, n);
        if (picked >= 0) {
          const cell = CAND_CELL[picked];
          return {
            cell,
            dir: CAND_DIR[picked],
            shortcut: CAND_DIST[picked] !== 1,
            eatsApple: cell === apple,
          };
        }
      }
    }
  }

  // L2 / fallback: the original cycle policy, untouched.
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

/**
 * [ia-pro] Layers L0 + L1: rank the already-safe candidates by real board quality.
 * @returns {number} index into the CAND_* scratch arrays, or -1 to defer to the cycle policy.
 */
function proPick(cycle, nbr, snake, apple, opts, count, fill, head, w, n) {
  ensureScratch(n);
  ensureOcc(n);
  const len = snake.length;

  // Occupancy of the CURRENT body (generation-stamped, no clearing).
  const occ = OCC_BUF;
  const occGen = ++OCC_GEN;
  for (let i = 0; i < len; i++) occ[snake[i]] = occGen;

  // --- target selection: nearest edible ON THE GRID (apple or a bonus food) ---------------
  let target = apple;
  let targetDist = manhattan(w, head, apple);
  const foods = opts && opts.foods;
  if (foods && foods.length) {
    for (let i = 0; i < foods.length; i++) {
      const f = foods[i];
      if (!Number.isInteger(f) || f < 0 || f >= n || occ[f] === occGen) continue;
      const d = manhattan(w, head, f);
      if (d < targetDist) { targetDist = d; target = f; }
    }
  }

  // --- L0: shortest path with tail-reachability verification ------------------------------
  // Only while the board is not crowded; this is the layer that makes the snake go straight
  // at the apple like a player instead of sweeping the board.
  // [show] O caminho curto é ótimo para chegar na maçã, mas quando a cobra já vem há 5+ casas em
  // linha reta ele produz travessias de 15 casas de ponta a ponta — a imagem robótica que o
  // cliente reclamou. Nesse caso cedemos o passo para o L1, que pontua o tabuleiro de verdade e
  // hoje penaliza a continuação da reta. Custa pouca eficiência e ganha traçado de jogador.
  if (fill < PATH_MAX_FILL && straightRunOf(w, snake, 3) < 3) {
    // [show] A ordem vem do ciclo da rodada (cada rodada tem seed própria), então rodadas
    // diferentes desenham caminhos diferentes para a mesma maçã.
    // [show] A ordem muda ao longo da própria rodada, não só entre rodadas: a cada ~7 casas
    // percorridas o BFS passa a preferir outra direção no desempate. Como todos os caminhos que
    // ele devolve têm o MESMO comprimento mínimo, a cobra continua tão eficiente quanto antes —
    // só deixa de desenhar sempre a mesma linha. É o que transforma a travessia reta e previsível
    // numa rota escalonada, que é como um jogador humano realmente se move.
    const fase = ((cycle.seed >>> 0) + ((len / 7) | 0)) % DIR_ORDERS.length;
    const first = bfsFirstStep(nbr, occ, occGen, head, target, DIR_ORDERS[fase]);
    if (first >= 0) {
      // The first step must ALSO be in the safe set — the invariant is never negotiable.
      let ci = -1;
      for (let i = 0; i < count; i++) if (CAND_CELL[i] === first && CAND_OK[i]) { ci = i; break; }
      if (ci >= 0) {
        if (first === target) {
          // Eating right now: only accept if we keep room afterwards.
          if (roomAfter(nbr, snake, first, true) >= len + 1) return ci;
        } else if (pathIsSafe(cycle, nbr, snake, first, target, occ, occGen)) {
          return ci;
        }
      }
    }
  }

  // --- L1: score every safe candidate on real board terms ----------------------------------
  const rng = opts && typeof opts.rng === 'function' ? opts.rng : null;
  const prevDir = dirBetweenCells(w, snake.length >= 2 ? snake[1] : -1, head);
  // [show] Quantas casas a cobra já vem andando em linha reta, lidas do próprio corpo. É o que
  // permite o bônus de fluidez decair: reta curta ainda flui, reta longa vira varredura.
  const straightRun = straightRunOf(w, snake, 8);
  let bestI = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < count; i++) {
    if (!CAND_OK[i]) continue; // never break the progress guarantee
    const c = CAND_CELL[i];
    const eats = c === target;
    // (a) real closeness to the target — the core fix for the wide laps.
    const md = manhattan(w, c, target);
    let score = -md * 10;
    if (eats) score += 60;
    // (b) space: never walk into a pocket smaller than the body.
    const room = roomAfter(nbr, snake, c, eats);
    if (room < len + 1) score -= 400 + (len + 1 - room) * 8;
    else score += Math.min(room, len * 2) * 0.25;
    // (c) tail reachability bonus — a body that can still chase its own tail is never stuck.
    if (tailReachableAfter(nbr, snake, c, eats)) score += 25;
    // (d) [show] Fluidez com teto. O bônus de seguir reto era fixo (+12) e produzia retas de até
    //     ~15 casas — a cobra atravessava o tabuleiro inteiro em linha, que é exatamente a cara
    //     de robô varrendo que o cliente reclamou. Agora o bônus DECAI conforme a reta se estica:
    //     nas primeiras casas ainda vale a pena seguir (evita zigue-zague sem propósito), mas
    //     depois de ~4 casas em linha o incentivo some e curvar passa a ser competitivo.
    // Reta curta ainda flui; reta longa passa a CUSTAR, para a cobra desenhar escadinhas em vez
    // de atravessar o tabuleiro inteiro em linha.
    if (CAND_DIR[i] === prevDir) score += straightRun >= 2 ? -16 * (straightRun - 1) : 6 - straightRun * 6;
    // (e) keep a foot in the cycle order as the board fills — smooth handover to L2 instead
    //     of a visible switch. Weight rises from 0 to ~12 between 40 % and SCORE_MAX_FILL.
    const t = (fill - 0.25) / (SCORE_MAX_FILL - 0.25);
    if (t > 0) score += (CAND_DIST[i] === 1 ? 1 : 0) * 12 * (t > 1 ? 1 : t);
    // (f) A whisper of randomness so two identical rounds do not draw identical lines. The
    // amplitude matters: the other terms move the score in steps of 10 (grid distance) and 12
    // (straight-line bonus), so a jitter below ~6 can never flip a decision and the knob is
    // dead. 7 is large enough to break genuine near-ties (two moves that are equally close and
    // differ only by the straight bonus) and small enough that it never overrides a move that
    // is actually closer to the food.
    // [show] Amplitude subiu de 7 para 11: com o bônus de reta decaindo, os empates ficaram mais
    // frequentes e o sorteio passa a desenhar trajetos genuinamente diferentes a cada rodada.
    if (rng) score += rng() * 11;
    if (score > bestScore) { bestScore = score; bestI = i; }
  }
  return bestI;
}

/** Direction index from cell `a` to cell `b` (-1 when either is invalid / not adjacent). */
function dirBetweenCells(w, a, b) {
  if (a < 0 || b < 0) return -1;
  const dx = (b % w) - (a % w);
  if (dx === 1) return 1;
  if (dx === -1) return 3;
  const dz = Math.floor(b / w) - Math.floor(a / w);
  if (dz === 1) return 2;
  if (dz === -1) return 0;
  return -1;
}

/**
 * Free cells reachable from `cell` after the snake moves there (tail leaves unless it grows).
 * Capped at 2·len + 2 — we only need "is there enough room", never the exact number.
 */
function roomAfter(nbr, snake, cell, grows) {
  const len = snake.length;
  const gen = ++BFS_GEN;
  const mark = BFS_MARK;
  const queue = BFS_QUEUE;
  // Post-move body: all current segments except the tail (unless growing), plus `cell`.
  const bodyEnd = grows ? len : len - 1;
  for (let i = 0; i < bodyEnd; i++) mark[snake[i]] = gen;
  mark[cell] = gen;
  const cap = len * 2 + 2;
  let qh = 0;
  let qt = 0;
  let count = 0;
  // Seed with the free neighbours of `cell`.
  const base = cell * 4;
  for (let d = 0; d < 4; d++) {
    const nx = nbr[base + d];
    if (nx < 0 || mark[nx] === gen) continue;
    mark[nx] = gen;
    queue[qt++] = nx;
    count++;
  }
  while (qh < qt && count < cap) {
    const c = queue[qh++];
    const b2 = c * 4;
    for (let d = 0; d < 4; d++) {
      const nx = nbr[b2 + d];
      if (nx < 0 || mark[nx] === gen) continue;
      mark[nx] = gen;
      count++;
      if (count >= cap) break;
      queue[qt++] = nx;
    }
  }
  return count + 1; // + the cell the head now occupies
}

/** True when, after moving onto `cell`, the head can still reach its own tail cell. */
function tailReachableAfter(nbr, snake, cell, grows) {
  const len = snake.length;
  if (len < 2) return true;
  const gen = ++BFS_GEN;
  const mark = BFS_MARK;
  const queue = BFS_QUEUE;
  const bodyEnd = grows ? len : len - 1;
  for (let i = 0; i < bodyEnd; i++) mark[snake[i]] = gen;
  mark[cell] = gen;
  const goal = grows ? snake[len - 1] : snake[len - 2];
  if (goal === cell) return true;
  let qh = 0;
  let qt = 0;
  const base = cell * 4;
  for (let d = 0; d < 4; d++) {
    const nx = nbr[base + d];
    if (nx < 0) continue;
    if (nx === goal) return true;
    if (mark[nx] === gen) continue;
    mark[nx] = gen;
    queue[qt++] = nx;
  }
  while (qh < qt) {
    const c = queue[qh++];
    const b2 = c * 4;
    for (let d = 0; d < 4; d++) {
      const nx = nbr[b2 + d];
      if (nx < 0) continue;
      if (nx === goal) return true;
      if (mark[nx] === gen) continue;
      mark[nx] = gen;
      queue[qt++] = nx;
    }
  }
  return false;
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
