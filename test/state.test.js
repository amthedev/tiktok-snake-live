// Tests for public/js/game/state.js (SPEC §2, §4.3, §4.4). Run: node --test test/state.test.js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { GameState, mulberry32 } from '../public/js/game/state.js';
import { validateSnake, DIRS } from '../public/js/ai/hamiltonian.js';

// ------------------------------------------------------------------ helpers

/** Fake clock: `now()` returns the current value in ms; advance with `clock.add(ms)`. */
function fakeClock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.add = (ms) => { t += ms; return t; };
  now.set = (ms) => { t = ms; };
  return now;
}

function makeState(config = {}, seed = 1, clock = fakeClock()) {
  const state = new GameState({ gridSize: 8, ...config }, { rng: mulberry32(seed), now: clock });
  return { state, clock };
}

function cellOf(w, p) {
  return p.z * w + p.x;
}

/** Assert the AI invariant plus board consistency (snake/apple/bombs disjoint, in-bounds). */
function assertConsistent(state, context = '') {
  const s = state.snapshot;
  const err = validateSnake(state.cycle, s.snakeIdx);
  assert.equal(err, null, `invariant broken ${context}: ${err}`);
  const occupied = new Set(s.snakeIdx);
  assert.equal(occupied.size, s.length, `duplicate snake cells ${context}`);
  assert.equal(s.snake.length, s.length);
  s.snake.forEach((p, i) => assert.equal(cellOf(s.w, p), s.snakeIdx[i]));
  if (s.apple) {
    const a = cellOf(s.w, s.apple);
    assert.ok(a >= 0 && a < s.cells);
    assert.ok(!occupied.has(a), `apple on the snake ${context}`);
    occupied.add(a);
  }
  const ids = new Set();
  for (const b of s.bombs) {
    const c = cellOf(s.w, b);
    assert.ok(c >= 0 && c < s.cells);
    assert.ok(!occupied.has(c), `bomb ${b.id} overlaps snake/apple/bomb ${context}`);
    occupied.add(c);
    assert.ok(!ids.has(b.id));
    ids.add(b.id);
  }
  assert.ok(s.bombs.length <= state.config.maxBombsOnBoard);
  assert.ok(s.length >= 3);
  return s;
}

/** Step until an event of `type` appears (or maxSteps), returning the events of that step. */
function stepUntil(state, type, maxSteps = 5000) {
  for (let i = 0; i < maxSteps; i++) {
    const events = state.step();
    assertConsistent(state, `after step ${i}`);
    if (events.some((e) => e.type === type)) return events;
    if (state.phase !== 'playing') return events;
  }
  return null;
}

/** Fill every free cell with a bomb (needs maxBombsOnBoard >= cells). */
function floodBombs(state, meta) {
  return state.spawnBombs(state.cells, meta);
}

// ------------------------------------------------------------------ mulberry32

describe('mulberry32', () => {
  test('is deterministic and yields floats in [0, 1)', () => {
    const a = mulberry32(123);
    const b = mulberry32(123);
    const c = mulberry32(124);
    const seqA = Array.from({ length: 1000 }, () => a());
    const seqB = Array.from({ length: 1000 }, () => b());
    assert.deepEqual(seqA, seqB);
    assert.notDeepEqual(seqA, Array.from({ length: 1000 }, () => c()));
    for (const v of seqA) assert.ok(v >= 0 && v < 1);
    assert.ok(new Set(seqA).size > 990, 'poor distribution');
  });
});

// ------------------------------------------------------------------ construction / config

describe('constructor', () => {
  test('rejects odd or tiny grid sizes and bad dependencies', () => {
    assert.throws(() => new GameState({ gridSize: 9 }), RangeError);
    assert.throws(() => new GameState({ gridSize: 2 }), RangeError);
    assert.throws(() => new GameState({ gridSize: 8 }, { rng: 'no' }), TypeError);
  });

  test('falls back to SPEC defaults for missing config keys', () => {
    const state = new GameState({});
    assert.equal(state.config.gridSize, 16);
    assert.equal(state.config.bombShrink, 3);
    assert.equal(state.config.bombFuseSec, 90);
    assert.equal(state.config.maxBombsOnBoard, 60);
    assert.equal(state.w, 16);
    assert.equal(state.cells, 256);
  });

  test('starts in countdown with a placed snake and an apple, roundId 0 until reset()', () => {
    const { state } = makeState();
    const s = assertConsistent(state);
    assert.equal(s.roundId, 0);
    assert.equal(s.phase, 'countdown');
    assert.equal(s.length, 3);
    assert.ok(s.apple);
    assert.equal(state.step().length, 0, 'step() is a no-op in countdown');
  });
});

// ------------------------------------------------------------------ snapshot

describe('snapshot', () => {
  test('has the SPEC §4.4 shape with the right types', () => {
    const { state, clock } = makeState({ gridSize: 8, baseSpeed: 6, speedPerSegment: 0.03, maxSpeed: 13 });
    state.reset();
    state.spawnBombs(2, { giftName: 'Rosa', nickname: 'ana' });
    clock.add(1500);
    const s = state.snapshot;
    assert.deepEqual(Object.keys(s).sort(), [
      'apple', 'apples', 'bombQueue', 'bombs', 'bombsEaten', 'cells', 'danger', 'dir', 'durationMs',
      'endedAt', 'foodEaten', 'foods', 'growthPending', 'h', 'lastMove', 'length', 'phase', 'prevDir',
      'progress', 'roundId', 'shieldLeft', 'snake', 'snakeIdx', 'speed', 'startedAt', 'w',
    ]);
    assert.deepEqual(s.foods, []);
    assert.equal(s.shieldLeft, 0);
    assert.equal(s.growthPending, 0);
    assert.equal(s.foodEaten, 0);
    assert.equal(s.roundId, 1);
    assert.equal(s.phase, 'countdown');
    assert.equal(s.w, 8);
    assert.equal(s.h, 8);
    assert.equal(s.cells, 64);
    assert.equal(s.snake.length, 3);
    assert.deepEqual(Object.keys(s.snake[0]), ['x', 'z']);
    assert.equal(s.snakeIdx.length, 3);
    assert.equal(s.dir, 1, 'heads right');
    assert.equal(s.prevDir, 1);
    assert.deepEqual(Object.keys(s.apple), ['x', 'z']);
    assert.equal(s.bombs.length, 2);
    assert.deepEqual(Object.keys(s.bombs[0]).sort(), ['fuseLeft', 'id', 'meta', 'x', 'z']);
    assert.equal(s.bombs[0].id, 'b1');
    assert.equal(s.bombs[0].fuseLeft, 90);
    assert.deepEqual(s.bombs[0].meta, { giftName: 'Rosa', nickname: 'ana' });
    assert.equal(s.bombQueue, 0);
    assert.equal(s.danger, true, 'length 3 with bombShrink 3: one bomb kills');
    assert.equal(s.apples, 0);
    assert.equal(s.bombsEaten, 0);
    assert.equal(s.length, 3);
    assert.equal(s.progress, 3 / 64);
    assert.equal(s.speed, 6);
    assert.equal(s.startedAt, 1_000_000);
    assert.equal(s.endedAt, null);
    assert.equal(s.durationMs, 1500);
    assert.equal(s.lastMove, null);
    // Plain data: survives JSON (Infinity fuse aside, which SPEC mandates).
    const json = JSON.parse(JSON.stringify(s));
    assert.equal(json.length, 3);
  });

  test('snake is placed on a central row heading right, along the cycle', () => {
    for (const size of [6, 8, 10, 12, 16, 22, 24]) {
      const state = new GameState({ gridSize: size }, { rng: mulberry32(1) });
      const s = assertConsistent(state, `size ${size}`);
      const [head, mid, tail] = s.snake;
      assert.equal(head.x, size / 2);
      assert.ok(head.z === size / 2 || head.z === size / 2 - 1, `centre row (size ${size}, z ${head.z})`);
      assert.deepEqual(mid, { x: head.x - 1, z: head.z });
      assert.deepEqual(tail, { x: head.x - 2, z: head.z });
      assert.equal(s.dir, 1);
    }
  });

  test('returns fresh arrays (mutating a snapshot never affects the state)', () => {
    const { state } = makeState();
    const s1 = state.snapshot;
    s1.snakeIdx.push(999);
    s1.snake[0].x = -5;
    s1.bombs.push({});
    const s2 = state.snapshot;
    assert.equal(s2.snakeIdx.length, 3);
    assert.equal(s2.bombs.length, 0);
    assert.notEqual(s2.snake[0].x, -5);
  });

  test('speed follows clamp(baseSpeed + (length-3)*speedPerSegment, baseSpeed, maxSpeed)', () => {
    const { state } = makeState({ gridSize: 8, baseSpeed: 4, speedPerSegment: 0.5, maxSpeed: 6 });
    state.reset();
    state.start();
    assert.equal(state.snapshot.speed, 4);
    stepUntil(state, 'eat_apple');
    assert.equal(state.snapshot.length, 4);
    assert.equal(state.snapshot.speed, 4.5);
    for (let i = 0; i < 6; i++) stepUntil(state, 'eat_apple');
    assert.equal(state.snapshot.length, 10);
    assert.equal(state.snapshot.speed, 6, 'clamped to maxSpeed');
    assert.equal(state.snapshot.progress, 10 / 64);
  });
});

// ------------------------------------------------------------------ round lifecycle

describe('reset / start', () => {
  test('reset() starts a new round with a clean board', () => {
    const { state, clock } = makeState({ gridSize: 8 });
    state.reset();
    state.start();
    state.spawnBombs(80, { giftName: 'Leão' });
    stepUntil(state, 'eat_bomb', 200);
    assert.ok(state.snapshot.bombQueue > 0);
    assert.ok(state.snapshot.bombsEaten > 0);
    clock.add(5000);
    const events = state.reset();
    const s = assertConsistent(state);
    assert.equal(s.roundId, 2);
    assert.equal(s.phase, 'countdown');
    assert.equal(s.length, 3);
    assert.equal(s.apples, 0);
    assert.equal(s.bombsEaten, 0);
    assert.equal(s.bombs.length, 0);
    assert.equal(s.bombQueue, 0);
    assert.ok(s.apple);
    assert.equal(s.startedAt, clock());
    assert.equal(s.endedAt, null);
    assert.equal(s.lastMove, null);
    assert.equal(s.dir, 1);
    assert.deepEqual(events.map((e) => e.type), ['apple_spawn']);
    assert.equal(state.step().length, 0, 'still in countdown');
  });

  test('start() moves countdown → playing and emits the start event once', () => {
    const { state } = makeState();
    state.reset();
    assert.deepEqual(state.start(), [{ type: 'start', roundId: 1 }]);
    assert.equal(state.phase, 'playing');
    assert.deepEqual(state.start(), []);
    assert.equal(state.phase, 'playing');
  });

  test('two states with the same seed and operations produce identical snapshots', () => {
    const a = new GameState({ gridSize: 10 }, { rng: mulberry32(77), now: () => 0 });
    const b = new GameState({ gridSize: 10 }, { rng: mulberry32(77), now: () => 0 });
    for (const st of [a, b]) {
      st.reset();
      st.start();
      st.spawnBombs(5);
      for (let i = 0; i < 300; i++) {
        st.step();
        st.tick(0.2);
      }
    }
    assert.deepEqual(a.snapshot, b.snapshot);
  });
});

// ------------------------------------------------------------------ stepping

describe('step()', () => {
  test('emits a move event every step and keeps the invariant', () => {
    const { state } = makeState();
    state.reset();
    state.start();
    for (let i = 0; i < 500; i++) {
      const before = state.snapshot;
      const events = state.step();
      const s = assertConsistent(state, `step ${i}`);
      assert.equal(events[0].type, 'move');
      assert.deepEqual(Object.keys(events[0]).sort(), ['cell', 'dir', 'shortcut', 'type']);
      assert.equal(events[0].cell, s.snakeIdx[0]);
      assert.equal(events[0].dir, s.dir);
      assert.equal(s.prevDir, before.dir);
      const head = before.snake[0];
      assert.deepEqual(s.snake[0], { x: head.x + DIRS[s.dir].x, z: head.z + DIRS[s.dir].z });
      assert.equal(s.lastMove.cell, events[0].cell);
      assert.equal(s.lastMove.shortcut, events[0].shortcut);
    }
  });

  test('is a no-op outside playing (countdown, won, lost)', () => {
    const { state } = makeState({ gridSize: 6 });
    assert.deepEqual(state.step(), []);
    state.reset();
    assert.deepEqual(state.step(), []);
    state.start();
    const win = stepUntil(state, 'win', 4 * 36 * 36);
    assert.ok(win, 'expected a win');
    assert.equal(state.phase, 'won');
    assert.deepEqual(state.step(), []);
    assert.deepEqual(state.tick(1), []);

    const lost = makeState({ gridSize: 6, maxBombsOnBoard: 100, bombFuseSec: 0 }).state;
    lost.reset();
    lost.start();
    floodBombs(lost);
    assert.ok(stepUntil(lost, 'lose', 20));
    assert.equal(lost.phase, 'lost');
    assert.deepEqual(lost.step(), []);
    assert.deepEqual(lost.tick(1), []);
  });

  test('eating the apple grows the snake and respawns exactly one apple on a free cell', () => {
    const { state } = makeState({ gridSize: 8 });
    state.reset();
    state.start();
    const before = state.snapshot;
    const events = stepUntil(state, 'eat_apple');
    assert.ok(events);
    const eat = events.find((e) => e.type === 'eat_apple');
    const spawn = events.find((e) => e.type === 'apple_spawn');
    assert.ok(spawn, 'apple_spawn in the same step');
    assert.ok(events.indexOf(eat) < events.indexOf(spawn));
    assert.deepEqual({ x: eat.x, z: eat.z }, before.apple);
    assert.equal(eat.apples, 1);
    assert.equal(eat.length, 4);
    const s = assertConsistent(state);
    assert.equal(s.length, 4);
    assert.equal(s.apples, 1);
    assert.deepEqual(s.apple, { x: spawn.x, z: spawn.z });
    assert.notDeepEqual(s.apple, before.apple);
    assert.equal(s.snakeIdx.length, new Set(s.snakeIdx).size);
  });

  test('spawnApple() is idempotent while an apple exists', () => {
    const { state } = makeState();
    state.reset();
    assert.deepEqual(state.spawnApple(), []);
  });
});

// ------------------------------------------------------------------ bombs

describe('bombs', () => {
  test('spawnBombs places up to maxBombsOnBoard, queues the rest, carries meta and ids', () => {
    const { state } = makeState({ gridSize: 8, maxBombsOnBoard: 5, bombFuseSec: 30 });
    state.reset();
    const meta = { giftName: 'Galáxia', giftImageUrl: '/img?u=x', nickname: 'joao', avatarUrl: null };
    const events = state.spawnBombs(8, meta);
    assert.equal(events.length, 5);
    events.forEach((e, i) => {
      assert.equal(e.type, 'bomb_spawn');
      assert.equal(e.id, `b${i + 1}`);
      assert.equal(e.fuseSec, 30);
      assert.deepEqual(e.meta, meta);
      assert.notEqual(e.meta, meta, 'meta is copied');
    });
    const s = assertConsistent(state);
    assert.equal(s.bombs.length, 5);
    assert.equal(s.bombQueue, 3);
    assert.deepEqual(state.spawnBombs(0), []);
    assert.deepEqual(state.spawnBombs(-2), []);
    assert.deepEqual(state.spawnBombs(NaN), []);
    assert.equal(state.snapshot.bombQueue, 3);
  });

  test('bombs never land on the snake, the apple, another bomb or the cell in front of the head', () => {
    const { state } = makeState({ gridSize: 8, maxBombsOnBoard: 100 });
    state.reset();
    const s0 = state.snapshot;
    const head = s0.snake[0];
    const front = { x: head.x + DIRS[s0.dir].x, z: head.z + DIRS[s0.dir].z };
    state.spawnBombs(59); // 64 - 3 - 1 apple - 1 front = 59 placeable
    const s = assertConsistent(state);
    assert.equal(s.bombs.length, 59);
    assert.equal(s.bombQueue, 0);
    assert.ok(!s.bombs.some((b) => b.x === front.x && b.z === front.z), 'front cell kept free');
    // The front cell is used only when nothing else is left.
    const more = state.spawnBombs(1);
    assert.equal(more.length, 1);
    assert.deepEqual({ x: more[0].x, z: more[0].z }, front);
    assertConsistent(state);
  });

  test('tick() burns fuses, expires bombs and drains the queue; fuse 0 never expires', () => {
    const { state } = makeState({ gridSize: 8, maxBombsOnBoard: 4, bombFuseSec: 2 });
    state.reset();
    state.spawnBombs(6, { giftName: 'Rosa' });
    assert.equal(state.snapshot.bombQueue, 2);
    assert.deepEqual(state.tick(1), []);
    assert.ok(state.snapshot.bombs.every((b) => Math.abs(b.fuseLeft - 1) < 1e-9));
    assert.deepEqual(state.tick(0), []);
    assert.deepEqual(state.tick(NaN), []);
    assert.deepEqual(state.tick(-1), []);
    const events = state.tick(1.01);
    const expired = events.filter((e) => e.type === 'bomb_expire');
    const spawned = events.filter((e) => e.type === 'bomb_spawn');
    assert.deepEqual(expired.map((e) => e.id), ['b1', 'b2', 'b3', 'b4']);
    assert.deepEqual(Object.keys(expired[0]).sort(), ['id', 'type', 'x', 'z']);
    assert.deepEqual(spawned.map((e) => e.id), ['b5', 'b6']);
    assert.deepEqual(spawned[0].meta, { giftName: 'Rosa' });
    const s = assertConsistent(state);
    assert.equal(s.bombs.length, 2);
    assert.equal(s.bombQueue, 0);

    const never = makeState({ gridSize: 8, bombFuseSec: 0 }).state;
    never.reset();
    never.spawnBombs(3);
    assert.ok(never.snapshot.bombs.every((b) => b.fuseLeft === Infinity));
    assert.deepEqual(never.tick(100000), []);
    assert.equal(never.snapshot.bombs.length, 3);
  });

  test('clearBombs removes every bomb and the queue', () => {
    const { state } = makeState({ gridSize: 8, maxBombsOnBoard: 3 });
    state.reset();
    state.spawnBombs(10);
    const events = state.clearBombs();
    assert.deepEqual(events, [{ type: 'bomb_clear', ids: ['b1', 'b2', 'b3'] }]);
    const s = assertConsistent(state);
    assert.equal(s.bombs.length, 0);
    assert.equal(s.bombQueue, 0);
    assert.deepEqual(state.clearBombs(), []);
    assert.equal(state.spawnBombs(1)[0].id, 'b4', 'ids keep incrementing');
  });

  test('eating a bomb shrinks the snake by bombShrink and removes the bomb (non-fatal when long enough)', () => {
    const { state } = makeState({ gridSize: 8, bombShrink: 3, maxBombsOnBoard: 100, bombFuseSec: 0 });
    state.reset();
    state.start();
    // Grow first so the bomb is survivable (length - 3 >= 3).
    while (state.snapshot.length < 8) assert.ok(stepUntil(state, 'eat_apple'));
    const lengthBefore = state.snapshot.length;
    floodBombs(state, { giftName: 'Rosa' });
    const events = stepUntil(state, 'eat_bomb', 10);
    const eat = events.find((e) => e.type === 'eat_bomb');
    assert.deepEqual(Object.keys(eat).sort(), ['fatal', 'id', 'length', 'shielded', 'shrink', 'type', 'x', 'z']);
    assert.equal(eat.shielded, false);
    assert.equal(eat.fatal, false);
    assert.equal(eat.shrink, 3);
    assert.equal(eat.length, lengthBefore - 3);
    assert.deepEqual({ x: eat.x, z: eat.z }, state.snapshot.snake[0]);
    assert.ok(!state.snapshot.bombs.some((b) => b.id === eat.id), 'bomb removed');
    const s = assertConsistent(state);
    assert.equal(s.length, lengthBefore - 3);
    assert.equal(s.bombsEaten, 1);
    assert.equal(s.phase, 'playing', 'long snake survives');
    assert.ok(s.bombs.length > 0);
  });

  test('when no free non-bomb cell exists the apple spawns as soon as one frees up (before queued bombs)', () => {
    // The AI beelines to the apple eating bombs on the way (bombShrink 1 so a well-grown
    // snake survives); the deep queue refills every cell the tail frees, so the only way
    // the apple respawns is priority over the queue.
    const { state } = makeState({ gridSize: 6, bombShrink: 1, maxBombsOnBoard: 1000, bombFuseSec: 0 });
    state.reset();
    state.start();
    while (state.snapshot.length < 20) assert.ok(stepUntil(state, 'eat_apple'));
    const len = state.snapshot.length;
    floodBombs(state);
    state.spawnBombs(500);
    assert.equal(state.snapshot.bombs.length, 36 - len - 1);
    assert.ok(state.snapshot.bombQueue > 100);
    const eatEvents = stepUntil(state, 'eat_apple', 200);
    assert.ok(eatEvents);
    assert.ok(!eatEvents.some((e) => e.type === 'apple_spawn'), 'no room for an apple yet');
    assert.equal(state.snapshot.apple, null);
    const next = state.step();
    const spawnAt = next.findIndex((e) => e.type === 'apple_spawn');
    assert.ok(spawnAt >= 0, 'apple spawned once a cell freed');
    for (const [i, e] of next.entries()) if (e.type === 'bomb_spawn') assert.ok(i > spawnAt, 'apple before bombs');
    const s = assertConsistent(state);
    assert.ok(s.apple);
  });
});

// ------------------------------------------------------------------ danger flag

describe('danger flag', () => {
  test('danger is set exactly when one more bomb would kill (length - bombShrink < 3)', () => {
    const { state } = makeState({ gridSize: 8, bombShrink: 3, maxBombsOnBoard: 100, bombFuseSec: 0 });
    state.reset();
    state.start();
    assert.equal(state.snapshot.danger, true, 'length 3');
    while (state.snapshot.length < 6) assert.ok(stepUntil(state, 'eat_apple'));
    assert.equal(state.snapshot.danger, false, 'length 6 survives a −3');
    floodBombs(state);
    const events = stepUntil(state, 'eat_bomb', 10);
    // The snake may grab the apple on the way (growing by 1 before the bomb).
    const eat = events.find((e) => e.type === 'eat_bomb');
    assert.equal(state.snapshot.length, eat.length);
    assert.ok(eat.length <= 4);
    assert.equal(state.snapshot.danger, eat.length - 3 < 3, 'danger tracks the shrink rule');
    assert.equal(state.snapshot.danger, true);
  });
});

// ------------------------------------------------------------------ win / lose

describe('win / lose', () => {
  test('wins when the snake fills the board (6x6 and 8x8), with summary and endedAt', () => {
    for (const size of [6, 8]) {
      const { state, clock } = makeState({ gridSize: size, baseSpeed: 6 }, size);
      state.reset();
      state.start();
      const n = size * size;
      let steps = 0;
      let winEvents = null;
      while (steps < 4 * n * n && !winEvents) {
        clock.add(100);
        const events = state.step();
        assertConsistent(state, `size ${size} step ${steps}`);
        if (events.some((e) => e.type === 'win')) winEvents = events;
        steps++;
      }
      assert.ok(winEvents, `size ${size} did not win in ${steps} steps`);
      const win = winEvents.find((e) => e.type === 'win');
      assert.ok(!winEvents.some((e) => e.type === 'apple_spawn'), 'no apple after the win');
      assert.deepEqual(win.summary, {
        result: 'win',
        apples: n - 3,
        bombsEaten: 0,
        foodEaten: 0,
        length: n,
        durationMs: steps * 100,
        roundId: 1,
      });
      const s = state.snapshot;
      assert.equal(s.phase, 'won');
      assert.equal(s.length, n);
      assert.equal(s.progress, 1);
      assert.equal(s.apple, null);
      assert.equal(s.endedAt, clock());
      assert.equal(s.durationMs, steps * 100);
      clock.add(5000);
      assert.equal(state.snapshot.durationMs, steps * 100, 'duration frozen after the round ends');
      assert.deepEqual(state.step(), []);
    }
  });

  test('loses when the shrink would push the snake below the minimum (only way to lose)', () => {
    const { state, clock } = makeState({ gridSize: 6, bombShrink: 3, maxBombsOnBoard: 100, bombFuseSec: 0 });
    state.reset();
    state.start();
    // Length 3, bombShrink 3: the very first bomb is fatal (3 - 3 < 3).
    floodBombs(state, { giftName: 'Leão' });
    let events;
    let steps = 0;
    do {
      clock.add(100);
      events = state.step();
      assertConsistent(state);
      steps++;
    } while (!events.some((e) => e.type === 'lose') && steps < 50);
    const lose = events.find((e) => e.type === 'lose');
    assert.ok(lose, 'expected a lose event');
    const eat = events.find((e) => e.type === 'eat_bomb');
    assert.ok(eat && eat.fatal === true, 'the fatal bomb is flagged');
    assert.ok(events.indexOf(eat) < events.indexOf(lose));
    assert.ok(!events.some((e) => e.type === 'bomb_spawn' || e.type === 'apple_spawn'), 'board frozen after the loss');
    assert.equal(lose.summary.result, 'loss');
    assert.equal(lose.summary.bombsEaten, 1);
    assert.equal(lose.summary.roundId, 1);
    assert.equal(lose.summary.durationMs, steps * 100);
    assert.equal(lose.summary.length, 3, 'the corpse keeps the minimum length for the renderer');
    const s = state.snapshot;
    assert.equal(s.phase, 'lost');
    assert.equal(s.endedAt, clock());
    assert.deepEqual(state.step(), []);
    assert.deepEqual(state.tick(5), []);
    // A new round is fully playable again.
    state.reset();
    state.start();
    assert.equal(state.step()[0].type, 'move');
  });

  test('bomb-heavy rounds: no collision ever, every round ends in won or lost (never freezes or crashes)', () => {
    let wins = 0;
    let losses = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const { state } = makeState({ gridSize: 8, bombShrink: 3, maxBombsOnBoard: 20, bombFuseSec: 5 }, seed);
      state.reset();
      state.start();
      const rng = mulberry32(seed + 99);
      for (let i = 0; i < 8000 && state.phase === 'playing'; i++) {
        if (rng() < 0.02) state.spawnBombs(1 + Math.floor(rng() * 3), { giftName: 'Rosa' });
        state.step();
        state.tick(1 / 6);
        assertConsistent(state, `seed ${seed} step ${i}`);
      }
      if (state.phase === 'won') wins++;
      if (state.phase === 'lost') losses++;
    }
    // With bombs raining and death by shrink, both outcomes must be reachable.
    assert.ok(wins + losses > 0, 'no round ever finished');
    assert.ok(losses > 0, `bombs never killed (wins ${wins}, losses ${losses}) — death rule broken?`);
  });
});


// ------------------------------------------------------------------ hero / villain effects (v2)

describe('hero and villain effects', () => {
  test('spawnFood places golden food; eating it grows the snake by 1', () => {
    const { state } = makeState({ gridSize: 8, foodFuseSec: 0 });
    state.reset();
    state.start();
    const evs = state.spawnFood(3, { giftName: 'GG' });
    assert.equal(evs.filter((e) => e.type === 'food_spawn').length, 3);
    assert.equal(state.snapshot.foods.length, 3);
    assert.equal(state.snapshot.foods[0].id[0], 'f');
    const before = state.snapshot.length + state.snapshot.growthPending;
    const eat = stepUntil(state, 'eat_food', 300);
    assert.ok(eat, 'food eaten');
    const s = assertConsistent(state);
    assert.equal(s.foodEaten, 1);
    assert.ok(s.length + s.growthPending >= before + 1, 'grew by at least 1 (directly or as credit)');
  });

  test('food expires by fuse; fuse 0 never expires', () => {
    const { state } = makeState({ gridSize: 8, foodFuseSec: 2 });
    state.reset();
    state.start();
    state.spawnFood(2);
    assert.equal(state.tick(1).length, 0);
    const evs = state.tick(1.5);
    assert.equal(evs.filter((e) => e.type === 'food_expire').length, 2);
    assert.equal(state.snapshot.foods.length, 0);
    const { state: forever } = makeState({ gridSize: 8, foodFuseSec: 0 });
    forever.reset(); forever.start();
    forever.spawnFood(1);
    forever.tick(9999);
    assert.equal(forever.snapshot.foods.length, 1);
  });

  test('growSnake adds growth credit realised over the next steps (never breaks the invariant)', () => {
    const { state } = makeState({ gridSize: 8 });
    state.reset();
    state.start();
    const evs = state.growSnake(5);
    assert.deepEqual(evs[0], { type: 'grow', amount: 5, pending: 5, length: 3 });
    let grew = 0;
    for (let i = 0; i < 60 && grew < 5; i++) {
      for (const e of state.step()) if (e.type === 'grow_step') grew++;
      assertConsistent(state, `growth step ${i}`);
    }
    const s = state.snapshot;
    assert.ok(s.length + s.growthPending >= 8, `length ${s.length} + pending ${s.growthPending}`);
  });

  test('applyShield blocks bombs (no shrink, no death) and expires via tick', () => {
    const { state } = makeState({ gridSize: 8, bombShrink: 3, bombFuseSec: 0 });
    state.reset();
    state.start();
    state.applyShield(1000); // capped by shieldMaxSec
    assert.equal(state.snapshot.shieldLeft, 120);
    floodBombs(state, { giftName: 'Leão' });
    const evs = stepUntil(state, 'eat_bomb', 10);
    const eat = evs.find((e) => e.type === 'eat_bomb');
    assert.equal(eat.shielded, true);
    assert.equal(eat.shrink, 0);
    assert.equal(eat.fatal, false);
    assert.equal(state.phase, 'playing');
    assert.equal(state.snapshot.length, 3, 'no shrink at minimum length under shield');
    // Shield runs out → next bomb is fatal at length 3.
    const endEvs = state.tick(500);
    assert.ok(endEvs.some((e) => e.type === 'shield_end'));
    assert.equal(state.snapshot.shieldLeft, 0);
    const evs2 = stepUntil(state, 'eat_bomb', 10);
    const eat2 = evs2.find((e) => e.type === 'eat_bomb');
    assert.equal(eat2.shielded, false);
    assert.equal(eat2.fatal, true);
    assert.equal(state.phase, 'lost');
  });

  test('attackShrink shrinks immediately but is NEVER fatal (bombs are the only death)', () => {
    const { state } = makeState({ gridSize: 8 });
    state.reset();
    state.start();
    while (state.snapshot.length < 8) assert.ok(stepUntil(state, 'eat_apple'));
    const len = state.snapshot.length;
    const evs = state.attackShrink(4);
    assert.equal(evs[0].type, 'attack');
    assert.equal(evs[0].shrink, 4);
    assert.equal(state.snapshot.length, len - 4);
    // Massive attack floors at the minimum, still alive.
    state.attackShrink(999);
    const s = assertConsistent(state);
    assert.equal(s.length, 3);
    assert.equal(state.phase, 'playing');
    // Growth credit is consumed before body segments.
    state.growSnake(3);
    const evs2 = state.attackShrink(2);
    assert.equal(evs2[0].fromCredit, 2);
    assert.equal(evs2[0].shrink, 0);
    assert.equal(state.snapshot.growthPending, 1);
  });

  test('effect methods are frozen after the round ends', () => {
    const { state } = makeState({ gridSize: 6, bombShrink: 3, maxBombsOnBoard: 100, bombFuseSec: 0 });
    state.reset();
    state.start();
    floodBombs(state);
    while (state.phase === 'playing') state.step();
    assert.equal(state.phase, 'lost');
    assert.deepEqual(state.spawnBombs(5), []);
    assert.deepEqual(state.spawnFood(5), []);
    assert.deepEqual(state.growSnake(5), []);
    assert.deepEqual(state.applyShield(30), []);
    assert.deepEqual(state.attackShrink(2), []);
    assert.deepEqual(state.spawnApple(), []);
    const queued = state.snapshot.bombQueue; // leftovers from before the death are fine
    state.spawnBombs(50);
    assert.equal(state.snapshot.bombQueue, queued, 'the queue does not grow after death');
  });

  test('the AI chases the nearest food and clears the whole board of foods too', () => {
    const { state } = makeState({ gridSize: 8, foodFuseSec: 0 });
    state.reset();
    state.start();
    state.spawnFood(10);
    let eaten = 0;
    for (let i = 0; i < 2000 && eaten < 10 && state.phase === 'playing'; i++) {
      for (const e of state.step()) if (e.type === 'eat_food') eaten++;
      assertConsistent(state, `chase step ${i}`);
    }
    assert.equal(eaten, 10, 'all bonus food eventually eaten');
  });
});
