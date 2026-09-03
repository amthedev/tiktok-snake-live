// Tests for public/js/ai/hamiltonian.js (SPEC §4.1 / §4.2). Run: node --test test/ai.test.js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIRS,
  buildCycle,
  distFwd,
  nextMove,
  safeMoves,
  isHamiltonianCycle,
  validateSnake,
} from '../public/js/ai/hamiltonian.js';
import { mulberry32 } from '../public/js/game/state.js';

// ------------------------------------------------------------------ helpers

/** Assert the body-ordering invariant (strictly increasing cycle positions tail→head, span < n). */
function assertInvariant(cycle, snake, context = '') {
  const err = validateSnake(cycle, snake);
  assert.equal(err, null, `invariant broken ${context}: ${err}`);
}

function idx(w, x, z) {
  return z * w + x;
}

/** Initial 3-segment snake laid along the cycle around the centre cell (head first). */
function initialSnake(cycle) {
  const { w, h, n, pos, cells } = cycle;
  const head = idx(w, w >> 1, h >> 1);
  const p = pos[head];
  return [head, cells[(p - 1 + n) % n], cells[(p - 2 + n) % n]];
}

function isAdjacent(w, a, b) {
  const dx = Math.abs((a % w) - (b % w));
  const dz = Math.abs(Math.floor(a / w) - Math.floor(b / w));
  return dx + dz === 1;
}

/**
 * Pure simulation harness. Bombs spawn with probability `bombP` per step (cap `bombCap`),
 * each with a random fuse in [fuseMin, fuseMax) steps — but the AI is BLIND to them by
 * design (product rule: the snake hits bombs and shrinks; shrink itself is GameState's
 * job and is exercised in state.test.js). Here eating a bomb only removes it, and the
 * bombs exist to prove that ignoring them never breaks the invariant. Asserts the
 * invariant and the absence of collisions after EVERY step. Returns statistics.
 */
function simulate(size, seed, { bombP = 0, bombCap = 30, fuseMin = 10, fuseMax = 150, maxSteps } = {}) {
  const cycle = buildCycle(size, size);
  const n = cycle.n;
  const rng = mulberry32(seed);
  const occ = new Uint8Array(n);
  const snake = initialSnake(cycle);
  for (const c of snake) occ[c] = 1;
  const bombs = new Set();
  const fuse = new Map();
  let apple = -1;
  const pickFree = () => {
    let count = 0;
    for (let c = 0; c < n; c++) if (!occ[c] && !bombs.has(c) && c !== apple) count++;
    if (count === 0) return -1;
    let k = Math.floor(rng() * count);
    for (let c = 0; c < n; c++) {
      if (!occ[c] && !bombs.has(c) && c !== apple) {
        if (k === 0) return c;
        k--;
      }
    }
    return -1;
  };
  apple = pickFree();
  const limit = maxSteps ?? 4 * n * n;
  let steps = 0;
  let apples = 0;
  let bombsEaten = 0;
  let shortcuts = 0;
  while (snake.length < n && steps < limit) {
    if (bombP > 0) {
      if (rng() < bombP && bombs.size < bombCap) {
        const c = pickFree();
        if (c >= 0) {
          bombs.add(c);
          fuse.set(c, steps + fuseMin + Math.floor(rng() * (fuseMax - fuseMin)));
        }
      }
      for (const [c, t] of fuse) {
        if (t <= steps) {
          fuse.delete(c);
          bombs.delete(c);
        }
      }
    }
    const head = snake[0];
    const mv = nextMove(cycle, snake, apple);
    // Wall / body collision checks independent of the invariant.
    assert.ok(mv.cell >= 0 && mv.cell < n, `off-board move at step ${steps}`);
    assert.ok(isAdjacent(cycle.w, head, mv.cell), `non-adjacent move at step ${steps}`);
    assert.equal(mv.dir, DIRS.findIndex((d) => idx(cycle.w, (head % cycle.w) + d.x, Math.floor(head / cycle.w) + d.z) === mv.cell));
    const growing = mv.cell === apple;
    if (occ[mv.cell] && !(mv.cell === snake[snake.length - 1] && !growing)) {
      assert.fail(`body collision at step ${steps} (size ${size}, seed ${seed})`);
    }
    assert.equal(mv.eatsApple, growing);
    if (mv.shortcut) shortcuts++;
    if (growing) {
      apples++;
      apple = -1;
    } else {
      occ[snake.pop()] = 0;
    }
    if (bombs.has(mv.cell)) {
      bombs.delete(mv.cell);
      fuse.delete(mv.cell);
      bombsEaten++;
    }
    snake.unshift(mv.cell);
    occ[mv.cell] = 1;
    assertInvariant(cycle, snake, `(size ${size}, seed ${seed}, step ${steps})`);
    if (apple < 0 && snake.length < n) apple = pickFree();
    steps++;
  }
  return { won: snake.length === n, steps, apples, bombsEaten, shortcuts, n };
}

// ------------------------------------------------------------------ DIRS / cycle

describe('DIRS', () => {
  test('matches SPEC §1 order (up, right, down, left)', () => {
    assert.deepEqual(DIRS.map((d) => [d.x, d.z]), [[0, -1], [1, 0], [0, 1], [-1, 0]]);
  });
});

describe('buildCycle', () => {
  test('valid Hamiltonian cycle for every even square size 4..24', () => {
    for (let s = 4; s <= 24; s += 2) {
      const cycle = buildCycle(s, s);
      assert.equal(cycle.w, s);
      assert.equal(cycle.h, s);
      assert.equal(cycle.n, s * s);
      assert.ok(cycle.pos instanceof Int32Array && cycle.pos.length === s * s);
      assert.ok(cycle.cells instanceof Int32Array && cycle.cells.length === s * s);
      assert.ok(isHamiltonianCycle(cycle), `size ${s}`);
    }
  });

  test('each cell exactly once, consecutive cells 4-adjacent, closed (explicit check)', () => {
    for (const [w, h] of [[4, 4], [8, 8], [16, 16], [24, 24], [4, 6], [6, 4], [3, 4], [4, 3], [2, 2], [2, 5], [5, 2]]) {
      const cycle = buildCycle(w, h);
      const seen = new Set();
      for (let p = 0; p < cycle.n; p++) {
        const c = cycle.cells[p];
        assert.ok(!seen.has(c), `${w}x${h}: cell ${c} repeated`);
        seen.add(c);
        assert.equal(cycle.pos[c], p);
        assert.ok(isAdjacent(w, c, cycle.cells[(p + 1) % cycle.n]), `${w}x${h}: position ${p} not adjacent to next`);
      }
      assert.equal(seen.size, w * h);
    }
  });

  test('follows the canonical construction on 4x4 (row 0 → zig-zag → column 0)', () => {
    const cycle = buildCycle(4, 4);
    const expected = [
      [0, 0], [1, 0], [2, 0], [3, 0],
      [3, 1], [2, 1], [1, 1],
      [1, 2], [2, 2], [3, 2],
      [3, 3], [2, 3], [1, 3],
      [0, 3], [0, 2], [0, 1],
    ].map(([x, z]) => idx(4, x, z));
    assert.deepEqual(Array.from(cycle.cells), expected);
  });

  test('throws on odd cell count or a side smaller than 2', () => {
    assert.throws(() => buildCycle(3, 3), RangeError);
    assert.throws(() => buildCycle(5, 7), RangeError);
    assert.throws(() => buildCycle(1, 4), RangeError);
    assert.throws(() => buildCycle(4, 1), RangeError);
    assert.throws(() => buildCycle(4.5, 4), RangeError);
    assert.throws(() => buildCycle('8', 8), RangeError);
  });
});

describe('isHamiltonianCycle', () => {
  test('rejects tampered cycles', () => {
    const cycle = buildCycle(6, 6);
    assert.ok(isHamiltonianCycle(cycle));
    const broken = { ...cycle, cells: Int32Array.from(cycle.cells), pos: Int32Array.from(cycle.pos) };
    const a = broken.cells[3];
    broken.cells[3] = broken.cells[10];
    broken.cells[10] = a;
    assert.equal(isHamiltonianCycle(broken), false);
    assert.equal(isHamiltonianCycle({ ...cycle, n: cycle.n - 1 }), false);
    assert.equal(isHamiltonianCycle(null), false);
  });
});

describe('distFwd', () => {
  test('forward distance wraps around the cycle', () => {
    const cycle = buildCycle(4, 4);
    const c0 = cycle.cells[0];
    const c5 = cycle.cells[5];
    assert.equal(distFwd(cycle, c0, c5), 5);
    assert.equal(distFwd(cycle, c5, c0), 11);
    assert.equal(distFwd(cycle, c5, c5), 0);
  });
});

// ------------------------------------------------------------------ safeMoves

describe('safeMoves', () => {
  test('every in-bounds neighbour is safe for a length-1 snake', () => {
    const cycle = buildCycle(8, 8);
    const centre = safeMoves(cycle, [idx(8, 4, 4)], -1);
    assert.equal(centre.length, 4);
    const corner = safeMoves(cycle, [0], -1);
    assert.equal(corner.length, 2);
    for (const m of [...centre, ...corner]) assert.ok(m.dist > 0 && m.dist < cycle.n);
  });

  test('always contains the cycle successor and only invariant-preserving cells', () => {
    const cycle = buildCycle(10, 10);
    const rng = mulberry32(42);
    // Walk random safe moves for a while, checking the returned set at every state.
    const snake = initialSnake(cycle);
    let apple = 7;
    for (let step = 0; step < 3000; step++) {
      const head = snake[0];
      const moves = safeMoves(cycle, snake, apple);
      assert.ok(moves.length >= 1);
      const succ = cycle.cells[(cycle.pos[head] + 1) % cycle.n];
      assert.ok(moves.some((m) => m.cell === succ && m.dist === 1), 'successor missing');
      for (const m of moves) {
        assert.ok(isAdjacent(10, head, m.cell));
        assert.equal(m.dist, distFwd(cycle, head, m.cell));
        assert.equal(m.cell, idx(10, (head % 10) + DIRS[m.dir].x, Math.floor(head / 10) + DIRS[m.dir].z));
        const grow = m.cell === apple;
        const next = grow ? [m.cell, ...snake] : [m.cell, ...snake.slice(0, -1)];
        assertInvariant(cycle, next, `after safe move ${m.cell}`);
      }
      const pick = moves[Math.floor(rng() * moves.length)];
      if (pick.cell === apple) {
        snake.unshift(pick.cell);
        do apple = Math.floor(rng() * cycle.n); while (snake.includes(apple));
      } else {
        snake.pop();
        snake.unshift(pick.cell);
      }
      if (snake.length > 60) snake.length = 60; // keep the walk in mid-game territory (tail trimming keeps the invariant)
    }
  });
});

// ------------------------------------------------------------------ nextMove policy

describe('nextMove policy (8x8, head at (4,4) heading right)', () => {
  // Canonical 8x8 cycle: cell 36 = (4,4) has position 32, successor 37, other safe
  // neighbours 44 (dist 7) and 28 (dist 57). See the cycle construction in SPEC §4.1.
  const cycle = buildCycle(8, 8);
  const snake = () => [36, 35, 34];

  test('returns a safe cell with correct flags (no apple → cycle successor)', () => {
    const mv = nextMove(cycle, snake(), -1);
    assert.deepEqual(mv, { cell: 37, dir: 1, shortcut: false, eatsApple: false });
  });

  test('takes the largest safe jump that does not overshoot the apple', () => {
    // apple at (4,7) = cell 60 (dist 21): candidates 37 (1) and 44 (7) qualify, 28 (57) overshoots.
    const mv = nextMove(cycle, snake(), 60);
    assert.equal(mv.cell, 44);
    assert.equal(mv.dir, 2);
    assert.equal(mv.shortcut, true);
    assert.equal(mv.eatsApple, false);
  });

  test('eats the apple when it is a safe neighbour', () => {
    const mv = nextMove(cycle, snake(), 44);
    assert.equal(mv.cell, 44);
    assert.equal(mv.eatsApple, true);
  });

  test('follows the cycle when shortcuts are disabled or the board is too full', () => {
    assert.equal(nextMove(cycle, snake(), 60, { allowShortcuts: false }).cell, 37);
    assert.equal(nextMove(cycle, snake(), 60, { shortcutMaxFill: 0 }).cell, 37);
    // length 3 < 0.05 * 64 = 3.2 → still allowed
    assert.equal(nextMove(cycle, snake(), 60, { shortcutMaxFill: 0.05 }).cell, 44);
  });

  test('does not mutate its inputs', () => {
    const s = snake();
    nextMove(cycle, s, 60);
    assert.deepEqual(s, [36, 35, 34]);
  });

  test('rejects an empty snake', () => {
    assert.throws(() => nextMove(cycle, [], -1), RangeError);
  });
});

// ------------------------------------------------------------------ simulated games (SPEC §4.2)

describe('simulated games', () => {
  test('300 games with random expiring bombs on the board (AI blind to them): zero collisions, every game wins within 4·n² steps', () => {
    const plan = [[8, 75], [10, 75], [12, 75], [16, 75]];
    let games = 0;
    for (const [size, count] of plan) {
      for (let g = 0; g < count; g++) {
        const r = simulate(size, size * 1000 + g, { bombP: 0.08, bombCap: 30, fuseMin: 10, fuseMax: 150 });
        assert.ok(r.won, `size ${size} game ${g} did not win within ${4 * r.n * r.n} steps (${r.steps})`);
        assert.equal(r.apples, r.n - 3);
        games++;
      }
    }
    assert.equal(games, 300);
  });

  test('no bombs: wins on every seed, average steps per apple < n', () => {
    for (const size of [8, 10, 12, 16]) {
      for (let seed = 1; seed <= 10; seed++) {
        const r = simulate(size, seed, {});
        assert.ok(r.won, `size ${size} seed ${seed} did not win`);
        assert.equal(r.bombsEaten, 0);
        const stepsPerApple = r.steps / r.apples;
        assert.ok(stepsPerApple < r.n, `size ${size} seed ${seed}: ${stepsPerApple} steps/apple`);
        assert.ok(r.shortcuts > 0, 'shortcuts are used while the board is not full');
      }
    }
  });

  test('rectangular boards (h odd, w even → transposed cycle) also win', () => {
    for (const [w, h] of [[6, 5], [4, 7]]) {
      const cycle = buildCycle(w, h);
      const n = cycle.n;
      const snake = [cycle.cells[3], cycle.cells[2], cycle.cells[1]];
      const occ = new Uint8Array(n);
      for (const c of snake) occ[c] = 1;
      const rng = mulberry32(7);
      let apple = cycle.cells[10];
      let steps = 0;
      while (snake.length < n && steps < 4 * n * n) {
        const mv = nextMove(cycle, snake, apple);
        if (mv.cell === apple) {
          snake.unshift(mv.cell);
          occ[mv.cell] = 1;
          apple = -1;
          const free = [];
          for (let c = 0; c < n; c++) if (!occ[c]) free.push(c);
          if (free.length) apple = free[Math.floor(rng() * free.length)];
        } else {
          occ[snake.pop()] = 0;
          assert.equal(occ[mv.cell], 0, 'collision');
          snake.unshift(mv.cell);
          occ[mv.cell] = 1;
        }
        assertInvariant(cycle, snake, `${w}x${h} step ${steps}`);
        steps++;
      }
      assert.equal(snake.length, n);
    }
  });
});

// ------------------------------------------------------------------ performance

describe('performance', () => {
  test('10 000 nextMove calls on 24x24 mid-game take < 3 s', () => {
    const size = 24;
    const cycle = buildCycle(size, size);
    const n = cycle.n;
    const rng = mulberry32(2024);
    const occ = new Uint8Array(n);
    const snake = initialSnake(cycle);
    for (const c of snake) occ[c] = 1;
    const bombs = new Set();
    let apple = -1;
    const pickFree = () => {
      const free = [];
      for (let c = 0; c < n; c++) if (!occ[c] && !bombs.has(c) && c !== apple) free.push(c);
      return free.length ? free[Math.floor(rng() * free.length)] : -1;
    };
    apple = pickFree();
    // Collect mid-game states (30 %..70 % fill) with up to 60 bombs on the board.
    const states = [];
    let steps = 0;
    while (snake.length < 0.7 * n && steps < 4 * n * n) {
      if (bombs.size < 60 && rng() < 0.2) {
        const c = pickFree();
        if (c >= 0) bombs.add(c);
      }
      if (bombs.size > 0 && rng() < 0.05) bombs.delete([...bombs][0]);
      const mv = nextMove(cycle, snake, apple, bombs);
      if (mv.cell === apple) {
        snake.unshift(mv.cell);
        apple = -1;
      } else {
        occ[snake.pop()] = 0;
        snake.unshift(mv.cell);
      }
      occ[mv.cell] = 1;
      bombs.delete(mv.cell);
      if (apple < 0) apple = pickFree();
      if (snake.length >= 0.3 * n && steps % 100 === 0 && states.length < 1000) states.push({ snake: snake.slice(), apple, bombs: new Set(bombs) });
      steps++;
    }
    assert.ok(states.length >= 50, `collected ${states.length} states`);
    const calls = 10000;
    const t0 = performance.now();
    for (let i = 0; i < calls; i++) {
      const s = states[i % states.length];
      nextMove(cycle, s.snake, s.apple);
    }
    const ms = performance.now() - t0;
    const avgUs = (ms * 1000) / calls;
    console.log(`  nextMove 24x24: ${calls} calls in ${ms.toFixed(1)} ms (avg ${avgUs.toFixed(2)} µs, ${states.length} states)`);
    assert.ok(ms < 3000, `too slow: ${ms} ms`);
    assert.ok(avgUs < 300, `average ${avgUs} µs exceeds 0.3 ms`);
  });
});
