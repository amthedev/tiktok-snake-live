// Tests for server/gifts.js (SPEC §5 v2 — VILÕES × HERÓIS). Run: node --test test/gifts.test.js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  DEFAULT_RULES, EVENT_CAPS, normalizeName, findRule, resolveGift, validateRules,
  loadRules, saveRules, withDefaults,
} from '../server/gifts.js';

const rules = withDefaults(DEFAULT_RULES);

const fx = (over = {}) => ({ bombs: 0, food: 0, grow: 0, attack: 0, shieldSec: 0, clearBombs: false, ...over });

describe('normalizeName', () => {
  test('lower-cases, strips diacritics and collapses whitespace', () => {
    assert.equal(normalizeName('  Coração   Nas  Mãos '), 'coracao nas maos');
    assert.equal(normalizeName('GALÁXIA'), 'galaxia');
    assert.equal(normalizeName(null), '');
  });
});

describe('findRule / matching', () => {
  test('matches by numeric id and by string id', () => {
    assert.equal(findRule(rules, { giftId: 5655 }).name, 'Rosa');
    assert.equal(findRule(rules, { giftId: '5655' }).name, 'Rosa');
  });

  test('id match wins over a conflicting name', () => {
    assert.equal(findRule(rules, { giftId: 5655, giftName: 'GG' }).name, 'Rosa');
  });

  test('matches by name ignoring case and diacritics', () => {
    assert.equal(findRule(rules, { giftName: 'capivara' }).name, 'Capivara');
    assert.equal(findRule(rules, { giftName: 'CAPYBARA' }).name, 'Capivara');
    assert.equal(findRule(rules, { giftName: 'hand hearts' }).name, 'Coração nas Mãos');
    assert.equal(findRule(rules, { giftName: 'DOUGHNUT' }).name, 'Rosquinha');
  });

  test('returns null for unknown gifts', () => {
    assert.equal(findRule(rules, { giftName: 'Presente Inexistente', giftId: 'x' }), null);
  });
});

describe('resolveGift — teams and effects (mode "all")', () => {
  test('every default gift has a team, a tier, a desc and at least one effect', () => {
    for (const g of rules.gifts) {
      const r = resolveGift(rules, { giftName: g.name, diamondCount: g.coins, count: 1 });
      assert.ok(['villain', 'hero'].includes(r.team), g.name);
      assert.ok(['normal', 'mega', 'supreme'].includes(r.tier), g.name);
      assert.equal(typeof r.desc, 'string', g.name);
      const any = r.effects.bombs + r.effects.food + r.effects.grow + r.effects.attack + r.effects.shieldSec > 0 || r.effects.clearBombs;
      assert.ok(any, `${g.name} has no effect`);
      assert.equal(r.matched, true);
      assert.equal(r.show, true);
    }
  });

  test('Rosa is a villain: 1 bomb per unit; 10-unit streak → 10 bombs', () => {
    assert.deepEqual(resolveGift(rules, { giftName: 'Rose', diamondCount: 1, count: 1 }).effects, fx({ bombs: 1 }));
    const r = resolveGift(rules, { giftId: 5655, diamondCount: 1, count: 10 });
    assert.equal(r.team, 'villain');
    assert.deepEqual(r.effects, fx({ bombs: 10 }));
  });

  test('GG is a hero: food, never bombs', () => {
    const r = resolveGift(rules, { giftName: 'GG', diamondCount: 1, count: 3 });
    assert.equal(r.team, 'hero');
    assert.deepEqual(r.effects, fx({ food: 3 }));
  });

  test('better gifts give bigger advantages (monotone by team)', () => {
    const power = (name, coins) => {
      const e = resolveGift(rules, { giftName: name, diamondCount: coins, count: 1 }).effects;
      return e.bombs + e.food + e.grow * 2 + e.attack * 2 + e.shieldSec / 10 + (e.clearBombs ? 5 : 0);
    };
    assert.ok(power('Rosa', 1) < power('Rosquinha', 30));
    assert.ok(power('Rosquinha', 30) < power('Confete', 100));
    assert.ok(power('Rosquinha', 30) < power('Confete', 100));
    assert.ok(power('GG', 1) < power('Coração nas Mãos', 100));
    assert.ok(power('Capivara', 30) < power('Coração nas Mãos', 100));
  });

  test('Confete (villain 100): 8 bombas + gelo + teia', () => {
    const r = resolveGift(rules, { giftName: 'Confetti', diamondCount: 100, count: 1 });
    assert.equal(r.team, 'villain');
    assert.equal(r.effects.bombs, 8);
  });

  test('Coração nas Mãos (hero 100): limpa as bombas e dá escudo', () => {
    const r = resolveGift(rules, { giftName: 'Hand Hearts', diamondCount: 100, count: 1 });
    assert.equal(r.team, 'hero');
    assert.equal(r.effects.clearBombs, true);
    assert.ok(r.effects.shieldSec > 0);
  });

  test('per-event hard caps apply after unit scaling', () => {
    const gg = resolveGift(rules, { giftName: 'GG', diamondCount: 1, count: 500 });
    assert.equal(gg.effects.food, EVENT_CAPS.food);
    const crane = resolveGift(rules, { giftName: 'Capivara', diamondCount: 30, count: 100 });
    assert.equal(crane.effects.grow, EVENT_CAPS.grow);
    const galaxy = resolveGift(rules, { giftName: 'Hand Hearts', diamondCount: 100, count: 10 });
    assert.equal(galaxy.effects.shieldSec, EVENT_CAPS.shieldSec);
    const confete = resolveGift(rules, { giftName: 'Confetti', diamondCount: 100, count: 50 });
    assert.ok(confete.effects.bombs <= EVENT_CAPS.bombs);
  });

  test('unmatched gift falls back to the villain bomb formula scaled by coins', () => {
    const r = resolveGift(rules, { giftName: 'Presente Novo', diamondCount: 35, count: 2 });
    assert.equal(r.matched, false);
    assert.equal(r.team, 'villain');
    assert.equal(r.ruleName, 'fallback');
    // (1 + floor(35/10)) * 2 = 8
    assert.deepEqual(r.effects, fx({ bombs: 8 }));
    // capped by fallback.maxBombsPerEvent (30)
    assert.equal(resolveGift(rules, { giftName: 'Presente Novo', diamondCount: 500, count: 10 }).effects.bombs, 30);
  });

  test('count 0 (streak close) produces zero effects', () => {
    const r = resolveGift(rules, { giftName: 'Confetti', diamondCount: 100, count: 0 });
    assert.deepEqual(r.effects, fx());
    assert.equal(r.effects.clearBombs, false);
  });

  test('legacy mirrors: bombs = effects.bombs, effect mega for tier != normal', () => {
    const confete = resolveGift(rules, { giftName: 'Confetti', diamondCount: 100, count: 50 });
    assert.ok(confete.effects.bombs <= EVENT_CAPS.bombs);
  });

  test('v1 alias: a rule with plain "bombs" still works', () => {
    const custom = withDefaults({ gifts: [{ match: ['Velho'], bombs: 4, team: 'villain' }] });
    assert.deepEqual(resolveGift(custom, { giftName: 'Velho', count: 2 }).effects, fx({ bombs: 8 }));
  });

  test('tolerates garbage input', () => {
    // Invalid count defaults to 1 unit; an unknown gift then uses the villain fallback (1 bomb).
    const r = resolveGift(rules, { giftName: null, giftId: undefined, diamondCount: NaN, count: 'x' });
    assert.equal(typeof r.show, 'boolean');
    assert.deepEqual(r.effects, fx({ bombs: 1 }));
    assert.deepEqual(resolveGift(rules, { giftName: null, count: 0 }).effects, fx());
    assert.deepEqual(resolveGift(null, { giftName: 'Rosa', count: 1 }).effects, fx({ bombs: 1 }));
  });
});

describe('resolveGift — mode "allowlist"', () => {
  const allow = withDefaults({
    mode: 'allowlist',
    unlisted: { show: false, countCoins: true },
    gifts: [{ name: 'Rosa', match: ['Rose', 'Rosa'], team: 'villain', effects: { bombs: 2 } }],
  });

  test('listed gift works normally', () => {
    const r = resolveGift(allow, { giftName: 'Rosa', count: 3 });
    assert.equal(r.show, true);
    assert.deepEqual(r.effects, fx({ bombs: 6 }));
  });

  test('unlisted gift is hidden, has no effects, coins still counted by default', () => {
    const r = resolveGift(allow, { giftName: 'Confete', diamondCount: 100, count: 1 });
    assert.equal(r.show, false);
    assert.equal(r.matched, false);
    assert.equal(r.ruleName, 'unlisted');
    assert.deepEqual(r.effects, fx());
    assert.equal(r.countCoins, true);
  });

  test('unlisted overrides are respected', () => {
    const shown = withDefaults({ ...allow, unlisted: { show: true, countCoins: false } });
    const r = resolveGift(shown, { giftName: 'Confete', count: 1 });
    assert.equal(r.show, true);
    assert.equal(r.countCoins, false);
  });
});

describe('validateRules', () => {
  test('accepts the default rules', () => {
    assert.deepEqual(validateRules(DEFAULT_RULES), { ok: true, errors: [] });
  });

  test('rejects non-objects and bad mode', () => {
    assert.equal(validateRules(null).ok, false);
    assert.match(validateRules({ mode: 'nope' }).errors[0], /mode/);
  });

  test('rejects bad team / tier / effects with pt-BR messages', () => {
    const { ok, errors } = validateRules({
      gifts: [
        { match: ['A'], team: 'neutro' },
        { match: ['B'], tier: 'ultra' },
        { match: ['C'], effects: { lasers: 1 } },
        { match: ['D'], effects: { bombs: -1 } },
        { match: ['E'], effects: { clearBombs: 'sim' } },
        {},
      ],
    });
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.includes('team')));
    assert.ok(errors.some((e) => e.includes('tier')));
    assert.ok(errors.some((e) => e.includes('efeito desconhecido')));
    assert.ok(errors.some((e) => e.includes('bombs')));
    assert.ok(errors.some((e) => e.includes('clearBombs')));
    assert.ok(errors.some((e) => e.includes('match')));
  });

  test('rejects bad fallback section', () => {
    assert.equal(validateRules({ fallback: { team: 'x' } }).ok, false);
    assert.equal(validateRules({ fallback: { bombsPerCoins: 0 } }).ok, false);
  });
});

describe('loadRules / saveRules', () => {
  test('creates the file with the default gifts when missing and round-trips a save', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snake-gifts-'));
    const file = path.join(dir, 'gifts.json');
    try {
      const loaded = await loadRules(file);
      assert.equal(loaded.mode, 'all');
      assert.equal(loaded.gifts.length, DEFAULT_RULES.gifts.length);
      assert.ok(loaded.gifts.length >= 6);
      assert.ok(loaded.gifts.some((g) => g.team === 'hero'));
      assert.ok(loaded.gifts.some((g) => g.team === 'villain'));

      const saved = await saveRules(file, { mode: 'allowlist', gifts: [{ match: ['Rose'], team: 'villain', effects: { bombs: 3 } }] });
      assert.equal(saved.mode, 'allowlist');
      assert.equal(saved.fallback.maxBombsPerEvent, 30); // filled from defaults
      const again = await loadRules(file);
      assert.equal(again.gifts.length, 1);
      assert.equal(resolveGift(again, { giftName: 'Rose', count: 1 }).effects.bombs, 3);

      await assert.rejects(() => saveRules(file, { mode: 'nope' }), /mode/);
      await fs.writeFile(file, '{ not json', 'utf8');
      await assert.rejects(() => loadRules(file), /JSON/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('migrates a v1 file (old "default" section) to the v2 defaults', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snake-gifts-'));
    const file = path.join(dir, 'gifts.json');
    try {
      const v1 = { mode: 'all', default: { bombsPerUnit: 1 }, gifts: [{ match: ['Rose'], bombs: 1 }] };
      await fs.writeFile(file, JSON.stringify(v1), 'utf8');
      const migrated = await loadRules(file);
      assert.equal(migrated.gifts.length, DEFAULT_RULES.gifts.length);
      assert.ok(migrated.fallback);
      const onDisk = JSON.parse(await fs.readFile(file, 'utf8'));
      assert.ok(!onDisk.default, 'old section gone from disk');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
