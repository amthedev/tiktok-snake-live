// Tests for route variety in public/js/ai/hamiltonian.js (client request 2026-09-04:
// "quero que essa minhoca não faça o mesmo percurso sempre").
// Run: node --test test/ai-variety.test.js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIRS,
  buildCycle,
  clearCycleCache,
  distFwd,
  nextMove,
  isHamiltonianCycle,
  validateSnake,
} from '../public/js/ai/hamiltonian.js';
import { GameState, mulberry32 } from '../public/js/game/state.js';

// ------------------------------------------------------------------ helpers

function idx(w, x, z) {
  return z * w + x;
}

function isAdjacent(w, a, b) {
  const dx = Math.abs((a % w) - (b % w));
  const dz = Math.abs(Math.floor(a / w) - Math.floor(b / w));
  return dx + dz === 1;
}

/** Canonical fingerprint of a cycle's route, independent of where the walk starts. */
function routeKey(cycle) {
  const { n, cells } = cycle;
  // Rotate so the walk starts at cell 0, then take the lexicographically smaller of the
  // forward and backward readings — two cycles are the same ROUTE iff their keys match.
  const start = cycle.pos[0];
  const fwd = new Array(n);
  const bwd = new Array(n);
  for (let i = 0; i < n; i++) {
    fwd[i] = cells[(start + i) % n];
    bwd[i] = cells[(start - i + n) % n];
  }
  const a = fwd.join(',');
  const b = bwd.join(',');
  return a < b ? a : b;
}

/** The 3-segment start placement GameState uses; null when the cycle cannot host it. */
function startRun(cycle) {
  const { w, h, n, pos } = cycle;
  const xc = w >> 1;
  for (const zc of [h >> 1, (h >> 1) - 1]) {
    const head = zc * w + xc;
    if ((pos[head] - pos[head - 1] + n) % n === 1 && (pos[head - 1] - pos[head - 2] + n) % n === 1) {
      return [head, head - 1, head - 2];
    }
  }
  return null;
}

/**
 * Play one full game on `cycle` from the standard 3-segment start, asserting after EVERY step
 * that the body invariant holds and that the head never lands on a surviving body segment.
 * No bombs: the snake must fill the whole board.
 */
function playToWin(cycle, seed, { shortcutMaxFill } = {}) {
  const { w, n } = cycle;
  const rng = mulberry32(seed);
  const snake = startRun(cycle);
  assert.ok(snake, `cycle ${w}x${cycle.h} has no valid start placement`);
  const occ = new Uint8Array(n);
  for (const c of snake) occ[c] = 1;
  const opts = shortcutMaxFill === undefined ? undefined : { shortcutMaxFill };
  const pickFree = () => {
    let count = 0;
    for (let c = 0; c < n; c++) if (!occ[c]) count++;
    if (count === 0) return -1;
    let k = Math.floor(rng() * count);
    for (let c = 0; c < n; c++) {
      if (!occ[c]) {
        if (k === 0) return c;
        k--;
      }
    }
    return -1;
  };
  let apple = pickFree();
  const limit = 4 * n * n;
  let steps = 0;
  let shortcuts = 0;
  while (snake.length < n && steps < limit) {
    const head = snake[0];
    const mv = nextMove(cycle, snake, apple, opts);
    assert.ok(mv.cell >= 0 && mv.cell < n, `off-board move (step ${steps})`);
    assert.ok(isAdjacent(w, head, mv.cell), `non-adjacent move (step ${steps})`);
    const growing = mv.cell === apple;
    // Collision check independent of the invariant: the target may only be occupied when it
    // is the tail that leaves this very step.
    if (occ[mv.cell] && !(mv.cell === snake[snake.length - 1] && !growing)) {
      assert.fail(`body collision at step ${steps} (seed ${seed})`);
    }
    if (mv.shortcut) shortcuts++;
    if (growing) {
      apple = -1;
    } else {
      occ[snake.pop()] = 0;
    }
    snake.unshift(mv.cell);
    occ[mv.cell] = 1;
    const err = validateSnake(cycle, snake);
    assert.equal(err, null, `invariant broken at step ${steps} (seed ${seed}): ${err}`);
    if (apple < 0 && snake.length < n) apple = pickFree();
    steps++;
  }
  return { won: snake.length === n, steps, shortcuts, n };
}

// ------------------------------------------------------------------ (a) real variety

describe('buildCycle variety', () => {
  test('backwards compatible: no opts (and no seed) still returns the canonical cycle', () => {
    for (const [w, h] of [[4, 4], [8, 8], [16, 16], [24, 24], [6, 5], [4, 7], [2, 2]]) {
      const plain = buildCycle(w, h);
      const empty = buildCycle(w, h, {});
      const noSeed = buildCycle(w, h, { seed: undefined });
      assert.deepEqual(Array.from(empty.cells), Array.from(plain.cells), `${w}x${h} opts {}`);
      assert.deepEqual(Array.from(noSeed.cells), Array.from(plain.cells), `${w}x${h} seed undefined`);
      assert.equal(plain.variant, 'canonical');
    }
    // The exact canonical 4x4 route the original construction produced.
    assert.deepEqual(Array.from(buildCycle(4, 4).cells), [
      [0, 0], [1, 0], [2, 0], [3, 0],
      [3, 1], [2, 1], [1, 1],
      [1, 2], [2, 2], [3, 2],
      [3, 3], [2, 3], [1, 3],
      [0, 3], [0, 2], [0, 1],
    ].map(([x, z]) => idx(4, x, z)));
  });

  test('50 seeds produce ≥ 48 distinct routes on every board size', () => {
    for (const size of [8, 10, 12, 16, 24]) {
      const routes = new Set();
      for (let seed = 1; seed <= 50; seed++) routes.add(routeKey(buildCycle(size, size, { seed })));
      assert.ok(routes.size >= 48, `size ${size}: only ${routes.size}/50 distinct routes`);
    }
  });

  test('a generated route differs from the canonical one almost always', () => {
    const canonical = routeKey(buildCycle(16, 16));
    let same = 0;
    for (let seed = 1; seed <= 50; seed++) {
      if (routeKey(buildCycle(16, 16, { seed })) === canonical) same++;
    }
    assert.ok(same <= 1, `${same}/50 generated routes were the canonical zig-zag`);
  });

  test('generated routes really look different: many more turns, no long sweeps', () => {
    // The point of the change is VISUAL. The canonical cycle is a sweep: long straight runs,
    // few turns. Measure both on the route itself so "variety" is not just data churn.
    const shape = (cycle) => {
      const { w, n, cells } = cycle;
      const dirOf = (a, b) => {
        const dx = (b % w) - (a % w);
        if (dx === 1) return 'R';
        if (dx === -1) return 'L';
        return Math.floor(b / w) - Math.floor(a / w) === 1 ? 'D' : 'U';
      };
      let turns = 0;
      let maxRun = 1;
      let run = 1;
      let prev = dirOf(cells[0], cells[1]);
      for (let p = 1; p < n; p++) {
        const d = dirOf(cells[p], cells[(p + 1) % n]);
        if (d === prev) run++; else { turns++; if (run > maxRun) maxRun = run; run = 1; }
        prev = d;
      }
      if (run > maxRun) maxRun = run;
      return { turnPct: (100 * turns) / n, maxRun };
    };
    const canonical = shape(buildCycle(16, 16));
    assert.ok(canonical.turnPct < 20, `sanity: canonical should be sweepy (${canonical.turnPct}%)`);
    for (let seed = 1; seed <= 20; seed++) {
      const s = shape(buildCycle(16, 16, { seed, cache: false }));
      assert.ok(s.turnPct > 25, `seed ${seed}: only ${s.turnPct.toFixed(1)} % turns (still a sweep)`);
      assert.ok(s.maxRun < 16, `seed ${seed}: straight run of ${s.maxRun} cells (sweep-like)`);
    }
  });

  test('the same seed always rebuilds the same cycle (determinism)', () => {
    clearCycleCache();
    const a = buildCycle(16, 16, { seed: 12345, cache: false });
    clearCycleCache();
    const b = buildCycle(16, 16, { seed: 12345, cache: false });
    assert.deepEqual(Array.from(a.cells), Array.from(b.cells));
    assert.deepEqual(Array.from(a.pos), Array.from(b.pos));
  });

  test('odd-sided boards (no reduced grid) fall back to the canonical cycle, still valid', () => {
    for (const [w, h] of [[6, 5], [4, 7], [2, 6], [6, 2], [2, 2]]) {
      const c = buildCycle(w, h, { seed: 99 });
      assert.equal(c.variant, 'canonical', `${w}x${h}`);
      assert.ok(isHamiltonianCycle(c), `${w}x${h} not a Hamiltonian cycle`);
      assert.deepEqual(Array.from(c.cells), Array.from(buildCycle(w, h).cells));
    }
  });

  test('rejects invalid boards exactly like before', () => {
    assert.throws(() => buildCycle(3, 3, { seed: 1 }), RangeError);
    assert.throws(() => buildCycle(5, 7, { seed: 1 }), RangeError);
    assert.throws(() => buildCycle(1, 4, { seed: 1 }), RangeError);
  });
});

// ------------------------------------------------------------------ (b) all still valid cycles

describe('generated cycles are genuine Hamiltonian cycles', () => {
  test('200 seeds × 5 sizes: every cell exactly once, consecutive cells 4-adjacent, closed', () => {
    let checked = 0;
    for (const size of [4, 8, 12, 16, 24]) {
      for (let seed = 1; seed <= 200; seed++) {
        const c = buildCycle(size, size, { seed, cache: false });
        assert.ok(isHamiltonianCycle(c), `size ${size} seed ${seed}: not a Hamiltonian cycle`);
        // Independent re-check (does not trust isHamiltonianCycle).
        const seen = new Set();
        for (let p = 0; p < c.n; p++) {
          const cell = c.cells[p];
          assert.ok(!seen.has(cell), `size ${size} seed ${seed}: cell ${cell} repeated`);
          seen.add(cell);
          assert.equal(c.pos[cell], p);
          assert.ok(isAdjacent(size, cell, c.cells[(p + 1) % c.n]), `size ${size} seed ${seed}: pos ${p} not adjacent`);
        }
        assert.equal(seen.size, c.n);
        checked++;
      }
    }
    assert.equal(checked, 1000);
  });

  test('non-square even boards generate valid cycles too', () => {
    for (const [w, h] of [[8, 12], [12, 8], [6, 10], [24, 16], [4, 6]]) {
      for (let seed = 1; seed <= 30; seed++) {
        const c = buildCycle(w, h, { seed, cache: false });
        assert.ok(isHamiltonianCycle(c), `${w}x${h} seed ${seed}`);
        assert.equal(c.n, w * h);
      }
    }
  });

  test('every generated cycle can host the standard 3-segment start (heading right)', () => {
    for (const size of [8, 10, 12, 16, 24]) {
      for (let seed = 1; seed <= 100; seed++) {
        const c = buildCycle(size, size, { seed, cache: false });
        const run = startRun(c);
        assert.ok(run, `size ${size} seed ${seed}: no start placement on a central row`);
        assert.equal(validateSnake(c, run), null, `size ${size} seed ${seed}: start breaks the invariant`);
      }
    }
  });
});

// ------------------------------------------------------------------ (c) 200+ games, zero collisions

describe('simulated games on generated cycles', () => {
  test('250 games across 5 sizes: zero collisions, invariant every step, 100 % wins', () => {
    const plan = [[8, 50], [10, 50], [12, 50], [16, 50], [24, 50]];
    let games = 0;
    for (const [size, count] of plan) {
      for (let g = 0; g < count; g++) {
        const seed = size * 1000 + g;
        const cycle = buildCycle(size, size, { seed, cache: false });
        const r = playToWin(cycle, seed);
        assert.ok(r.won, `size ${size} seed ${seed} did not fill the board (${r.steps} steps)`);
        games++;
      }
    }
    assert.equal(games, 250);
  });

  test('wins hold across the whole randomised shortcut range (0.6..1.15 × 0.5)', () => {
    for (const factor of [0.6, 0.75, 0.9, 1.0, 1.15]) {
      const shortcutMaxFill = Math.min(1, 0.5 * factor);
      for (const size of [8, 12, 16]) {
        for (let g = 0; g < 6; g++) {
          const seed = size * 100 + g;
          const cycle = buildCycle(size, size, { seed, cache: false });
          const r = playToWin(cycle, seed, { shortcutMaxFill });
          assert.ok(r.won, `size ${size} seed ${seed} fill ${shortcutMaxFill} did not win`);
        }
      }
    }
  });

  test('shortcuts still happen on generated cycles (the route is not a plain sweep)', () => {
    for (const size of [12, 16]) {
      for (let seed = 1; seed <= 5; seed++) {
        const cycle = buildCycle(size, size, { seed, cache: false });
        const r = playToWin(cycle, seed);
        assert.ok(r.shortcuts > 0, `size ${size} seed ${seed}: no shortcut was ever taken`);
      }
    }
  });
});

// ------------------------------------------------------------------ GameState integration

describe('GameState picks a new route every round', () => {
  test('20 rounds give ≥ 18 distinct routes and never repeat the previous one', () => {
    const state = new GameState({ gridSize: 16 }, { rng: mulberry32(2026), now: () => 0 });
    const routes = [];
    for (let r = 0; r < 20; r++) {
      state.reset();
      routes.push(routeKey(state.cycle));
      assert.ok(isHamiltonianCycle(state.cycle), `round ${r}: invalid cycle`);
    }
    for (let i = 1; i < routes.length; i++) {
      assert.notEqual(routes[i], routes[i - 1], `round ${i} repeated the previous route`);
    }
    assert.ok(new Set(routes).size >= 18, `only ${new Set(routes).size}/20 distinct routes`);
  });

  test('the snake still starts on a central row heading right on every generated route', () => {
    for (const size of [8, 12, 16, 24]) {
      const state = new GameState({ gridSize: size }, { rng: mulberry32(size), now: () => 0 });
      for (let r = 0; r < 12; r++) {
        state.reset();
        const s = state.snapshot;
        const [head, mid, tail] = s.snake;
        assert.equal(head.x, size / 2, `size ${size} round ${r}`);
        assert.ok(head.z === size / 2 || head.z === size / 2 - 1, `size ${size} round ${r}: z ${head.z}`);
        assert.deepEqual(mid, { x: head.x - 1, z: head.z });
        assert.deepEqual(tail, { x: head.x - 2, z: head.z });
        assert.equal(s.dir, 1, `size ${size} round ${r}: heading right`);
        assert.equal(validateSnake(state.cycle, s.snakeIdx), null);
      }
    }
  });

  test('rounds on fresh routes still play out with the invariant intact every step', () => {
    const state = new GameState({ gridSize: 10, maxBombsOnBoard: 0 }, { rng: mulberry32(4242), now: () => 0 });
    for (let round = 0; round < 8; round++) {
      state.reset();
      state.start();
      for (let i = 0; i < 400 && state.phase === 'playing'; i++) {
        state.step();
        const s = state.snapshot;
        const err = validateSnake(state.cycle, s.snakeIdx);
        assert.equal(err, null, `round ${round} step ${i}: ${err}`);
        assert.equal(new Set(s.snakeIdx).size, s.length, `round ${round} step ${i}: duplicate segment`);
      }
    }
  });

  test('same rng seed ⇒ same routes (rounds stay reproducible for the tests)', () => {
    const routesFor = () => {
      const st = new GameState({ gridSize: 12 }, { rng: mulberry32(555), now: () => 0 });
      const out = [];
      for (let r = 0; r < 6; r++) {
        st.reset();
        out.push(routeKey(st.cycle));
      }
      return out;
    };
    assert.deepEqual(routesFor(), routesFor());
  });
});

// ------------------------------------------------------------------ (d) performance

describe('cycle generation performance', () => {
  test('generating a fresh 24x24 cycle costs < 30 ms (median over 50, cache off)', () => {
    const times = [];
    for (let seed = 1; seed <= 50; seed++) {
      const t0 = performance.now();
      const c = buildCycle(24, 24, { seed, cache: false });
      times.push(performance.now() - t0);
      assert.equal(c.n, 576);
    }
    times.sort((a, b) => a - b);
    const median = times[times.length >> 1];
    const worst = times[times.length - 1];
    console.log(`  buildCycle 24x24: median ${median.toFixed(3)} ms, worst ${worst.toFixed(3)} ms`);
    assert.ok(median < 30, `median ${median} ms exceeds 30 ms`);
    assert.ok(worst < 30, `worst ${worst} ms exceeds 30 ms`);
  });

  test('the cache makes a repeated (w, h, seed) lookup essentially free', () => {
    clearCycleCache();
    buildCycle(24, 24, { seed: 777 });
    const t0 = performance.now();
    let last = null;
    for (let i = 0; i < 1000; i++) last = buildCycle(24, 24, { seed: 777 });
    const ms = performance.now() - t0;
    assert.ok(ms < 30, `1000 cached lookups took ${ms} ms`);
    assert.equal(last.seed, 777);
  });

  test('a full round of resets never blocks the loop (20 resets on 24x24 < 100 ms)', () => {
    const state = new GameState({ gridSize: 24 }, { rng: mulberry32(31337), now: () => 0 });
    const t0 = performance.now();
    for (let r = 0; r < 20; r++) state.reset();
    const ms = performance.now() - t0;
    console.log(`  20 resets on 24x24: ${ms.toFixed(1)} ms`);
    assert.ok(ms < 100, `20 resets took ${ms} ms`);
  });
});

// ------------------------------------------------------------------ safety rules unchanged

describe('safety rules are untouched by the new cycles', () => {
  test('the cycle successor is always a safe move on a generated cycle', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const cycle = buildCycle(12, 12, { seed, cache: false });
      const { n, pos, cells } = cycle;
      const rng = mulberry32(seed);
      const snake = startRun(cycle);
      for (let step = 0; step < 500; step++) {
        const head = snake[0];
        const succ = cells[(pos[head] + 1) % n];
        assert.equal(distFwd(cycle, head, succ), 1);
        const mv = nextMove(cycle, snake, -1);
        assert.equal(mv.cell, succ, `seed ${seed} step ${step}: no apple ⇒ follow the cycle`);
        assert.equal(mv.dir, DIRS.findIndex((d) => idx(12, (head % 12) + d.x, Math.floor(head / 12) + d.z) === mv.cell));
        snake.pop();
        snake.unshift(mv.cell);
        assert.equal(validateSnake(cycle, snake), null, `seed ${seed} step ${step}`);
        if (rng() < 0) break; // rng kept in play so the loop stays seed-dependent
      }
    }
  });
});
