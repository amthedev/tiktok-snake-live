/**
 * gifts.js — pure gift rules engine (SPEC §5 v2: VILÕES × HERÓIS) + JSON persistence helpers.
 *
 * Every TikTok gift belongs to a team and carries per-unit EFFECTS:
 *   villain → hurts the snake:  bombs (spawn), attack (direct shrink)
 *   hero    → helps the snake:  food (golden bonus apples), grow (instant growth),
 *             clearBombs (sweep the board), shieldSec (bomb immunity)
 * The more expensive the gift, the bigger its effect (client request 2026-09-03).
 * Matching is by numeric/string gift id OR case- and diacritic-insensitive name.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

const TEAMS = new Set(['villain', 'hero']);
const TIERS = new Set(['normal', 'mega', 'supreme']);
const MODES = new Set(['all', 'allowlist']);
const EFFECT_KEYS = ['bombs', 'food', 'grow', 'attack', 'shieldSec', 'clearBombs'];

/** Hard per-event ceilings (after multiplying by units), whatever the config says. */
export const EVENT_CAPS = Object.freeze({ bombs: 60, food: 30, grow: 40, attack: 20, shieldSec: 120 });

/**
 * The 16 default gifts — REAL TikTok gifts with their well-known coin prices.
 * `coins` is informative (the live event carries the real diamondCount); `desc` is the
 * pt-BR effect line shown on the overlay gift card. Effects are PER UNIT of the gift.
 */
export const DEFAULT_RULES = Object.freeze({
  mode: 'all',
  unlisted: { show: true, countCoins: true },
  fallback: { team: 'villain', bombsPerUnit: 1, bombsPerCoins: 10, maxBombsPerEvent: 30 },
  gifts: [
    // 😈 VILÕES ------------------------------------------------------------------------
    { name: 'Rosa', match: ['Rose', 'Rosa'], ids: [5655], coins: 1, team: 'villain', tier: 'normal',
      effects: { bombs: 1 }, desc: 'solta 1 bomba' },
    { name: 'Casquinha', match: ['Ice Cream Cone', 'Casquinha', 'Sorvete'], coins: 1, team: 'villain', tier: 'normal',
      effects: { bombs: 1 }, desc: 'solta 1 bomba' },
    { name: 'Rosquinha', match: ['Doughnut', 'Donut', 'Rosquinha'], coins: 30, team: 'villain', tier: 'normal',
      effects: { bombs: 3 }, desc: 'solta 3 bombas' },
    { name: 'Boné', match: ['Cap', 'Boné', 'Bone'], coins: 99, team: 'villain', tier: 'normal',
      effects: { bombs: 6 }, desc: 'solta 6 bombas' },
    { name: 'Confete', match: ['Confetti', 'Confete'], coins: 100, team: 'villain', tier: 'normal',
      effects: { bombs: 8 }, desc: 'chuva de 8 bombas' },
    { name: 'Arma de Dinheiro', match: ['Money Gun', 'Arma de Dinheiro'], coins: 500, team: 'villain', tier: 'mega',
      effects: { bombs: 12, attack: 2 }, desc: '12 bombas + morde −2 da cobra' },
    { name: 'Moto', match: ['Motorcycle', 'Moto'], coins: 2988, team: 'villain', tier: 'mega',
      effects: { bombs: 20, attack: 4 }, maxPerEvent: 40, desc: '20 bombas + atropela −4 da cobra' },
    { name: 'Leão', match: ['Lion', 'Leão', 'Leao'], coins: 29999, team: 'villain', tier: 'supreme',
      effects: { bombs: 40, attack: 6 }, maxPerEvent: 60, desc: '👑 40 bombas + mordida −6' },
    // 😇 HERÓIS ------------------------------------------------------------------------
    { name: 'GG', match: ['GG'], coins: 1, team: 'hero', tier: 'normal',
      effects: { food: 1 }, desc: '+1 comida dourada' },
    { name: 'Coraçãozinho', match: ['Finger Heart', 'Coraçãozinho', 'Coração'], coins: 5, team: 'hero', tier: 'normal',
      effects: { food: 2 }, desc: '+2 comidas douradas' },
    { name: 'Tsuru de Papel', match: ['Paper Crane', 'Tsuru de Papel', 'Tsuru'], coins: 99, team: 'hero', tier: 'normal',
      effects: { grow: 3 }, desc: 'a cobra cresce +3 na hora' },
    { name: 'Coração nas Mãos', match: ['Hand Hearts', 'Hands Heart', 'Coração nas Mãos'], coins: 100, team: 'hero', tier: 'normal',
      effects: { food: 4, grow: 1 }, desc: '+4 comidas e cresce +1' },
    { name: 'Cisne', match: ['Swan', 'Cisne'], coins: 699, team: 'hero', tier: 'mega',
      effects: { clearBombs: true }, desc: '✨ limpa TODAS as bombas' },
    { name: 'Galáxia', match: ['Galaxy', 'Galáxia', 'Galaxia'], coins: 1000, team: 'hero', tier: 'mega',
      effects: { clearBombs: true, shieldSec: 30 }, desc: '🛡️ escudo 30 s + limpa as bombas' },
    { name: 'Foguete', match: ['Rocket', 'Foguete'], coins: 20000, team: 'hero', tier: 'mega',
      effects: { grow: 10, food: 6, shieldSec: 30 }, desc: '🚀 cresce +10, +6 comidas, escudo 30 s' },
    { name: 'Universo TikTok', match: ['TikTok Universe', 'Universo TikTok', 'Universe'], coins: 44999, team: 'hero', tier: 'supreme',
      effects: { grow: 15, food: 10, clearBombs: true, shieldSec: 60 }, desc: '🌌 SUPREMO: +15, 10 comidas, limpa e escudo 60 s' },
  ],
});

/* ------------------------------------------------------------------------------------------------
 * Matching helpers
 * ---------------------------------------------------------------------------------------------- */

/** Lower-case, strip diacritics and collapse whitespace: "Coração" → "coracao". */
export function normalizeName(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function idsMatch(ruleIds, giftId) {
  if (!Array.isArray(ruleIds) || giftId === null || giftId === undefined || giftId === '') return false;
  const wanted = String(giftId).trim();
  return ruleIds.some((id) => String(id).trim() === wanted);
}

function namesMatch(ruleNames, giftName) {
  if (!Array.isArray(ruleNames) || !giftName) return false;
  const wanted = normalizeName(giftName);
  if (!wanted) return false;
  return ruleNames.some((n) => normalizeName(n) === wanted);
}

/** Human readable label for a rule (used in logs and the panel). */
export function ruleLabel(rule) {
  if (!rule) return null;
  if (rule.name) return String(rule.name);
  if (Array.isArray(rule.match) && rule.match.length) return String(rule.match[0]);
  if (Array.isArray(rule.ids) && rule.ids.length) return `#${rule.ids[0]}`;
  return 'regra';
}

/** Find the first rule matching by id (preferred) or by name. Returns null when none matches. */
export function findRule(rules, { giftId, giftName } = {}) {
  const list = Array.isArray(rules?.gifts) ? rules.gifts : [];
  const byId = list.find((r) => idsMatch(r.ids, giftId));
  if (byId) return byId;
  const byName = list.find((r) => namesMatch(r.match, giftName));
  return byName || null;
}

/* ------------------------------------------------------------------------------------------------
 * Resolution
 * ---------------------------------------------------------------------------------------------- */

function num(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function nonNegInt(v, fallback = 0) {
  const x = Math.trunc(num(v, fallback));
  return x >= 0 ? x : fallback;
}

/** Zeroed effects object. */
function emptyEffects() {
  return { bombs: 0, food: 0, grow: 0, attack: 0, shieldSec: 0, clearBombs: false };
}

/**
 * Resolve what a gift event does.
 *
 * @param {object} rules validated rules object (see DEFAULT_RULES)
 * @param {{ giftId?: string|number, giftName?: string, diamondCount?: number, count?: number }} gift
 * @returns {{
 *   show: boolean, matched: boolean, ruleName: string, countCoins: boolean,
 *   team: 'villain'|'hero', tier: 'normal'|'mega'|'supreme',
 *   effects: { bombs, food, grow, attack, shieldSec: number, clearBombs: boolean },
 *   desc: string|null,
 *   bombs: number, effect: 'normal'|'mega'   // legacy mirrors (bombs total; mega for tier != normal)
 * }}
 *
 * Per-unit effects are multiplied by `count` (the NEW units in this event) and capped by
 * EVENT_CAPS (bombs additionally by rule.maxPerEvent ?? fallback.maxBombsPerEvent).
 * Unmatched gifts use the villain fallback formula:
 *   bombsPerUnit + floor(diamondCount / bombsPerCoins) bombs per unit.
 */
export function resolveGift(rules, { giftId, giftName, diamondCount = 0, count = 1 } = {}) {
  const r = rules && typeof rules === 'object' ? rules : DEFAULT_RULES;
  const fb = { ...DEFAULT_RULES.fallback, ...(r.fallback || {}) };
  const unlisted = { ...DEFAULT_RULES.unlisted, ...(r.unlisted || {}) };
  const mode = MODES.has(r.mode) ? r.mode : 'all';

  const units = Math.max(0, Math.trunc(num(count, 1)));
  const coinsPerUnit = Math.max(0, num(diamondCount, 0));
  const rule = findRule(r, { giftId, giftName });

  let show = true;
  let matched = false;
  let ruleName = 'fallback';
  let countCoins = true;
  let team = TEAMS.has(fb.team) ? fb.team : 'villain';
  let tier = 'normal';
  let desc = null;
  const perUnit = emptyEffects();
  let maxBombs = nonNegInt(fb.maxBombsPerEvent, 30);

  if (rule) {
    matched = true;
    ruleName = ruleLabel(rule);
    show = rule.show !== false;
    team = TEAMS.has(rule.team) ? rule.team : team;
    tier = TIERS.has(rule.tier) ? rule.tier : 'normal';
    desc = typeof rule.desc === 'string' ? rule.desc : null;
    const fx = rule.effects && typeof rule.effects === 'object' ? rule.effects : {};
    perUnit.bombs = nonNegInt(fx.bombs ?? rule.bombs, 0); // rule.bombs = v1 alias
    perUnit.food = nonNegInt(fx.food, 0);
    perUnit.grow = nonNegInt(fx.grow, 0);
    perUnit.attack = nonNegInt(fx.attack, 0);
    perUnit.shieldSec = Math.max(0, num(fx.shieldSec, 0));
    perUnit.clearBombs = fx.clearBombs === true;
    if (rule.maxPerEvent !== undefined) maxBombs = nonNegInt(rule.maxPerEvent, maxBombs);
  } else if (mode === 'allowlist') {
    ruleName = 'unlisted';
    show = unlisted.show === true;
    countCoins = unlisted.countCoins !== false;
    // no effects at all: unlisted gifts in allowlist mode only (maybe) show and count coins
  } else {
    // mode 'all': unmatched gifts fall back to the villain bomb formula, scaled by coins.
    perUnit.bombs = nonNegInt(fb.bombsPerUnit, 1) + Math.floor(coinsPerUnit / Math.max(1, nonNegInt(fb.bombsPerCoins, 10)));
  }

  const effects = emptyEffects();
  effects.bombs = Math.min(perUnit.bombs * units, maxBombs, EVENT_CAPS.bombs);
  effects.food = Math.min(perUnit.food * units, EVENT_CAPS.food);
  effects.grow = Math.min(perUnit.grow * units, EVENT_CAPS.grow);
  effects.attack = Math.min(perUnit.attack * units, EVENT_CAPS.attack);
  effects.shieldSec = Math.min(perUnit.shieldSec * units, EVENT_CAPS.shieldSec);
  effects.clearBombs = perUnit.clearBombs && units > 0;

  return {
    show,
    matched,
    ruleName,
    countCoins,
    team,
    tier,
    effects,
    desc,
    // Legacy mirrors so older consumers keep working during the transition.
    bombs: effects.bombs,
    effect: tier === 'normal' ? 'normal' : 'mega',
  };
}

/* ------------------------------------------------------------------------------------------------
 * Validation (messages are user-facing → pt-BR)
 * ---------------------------------------------------------------------------------------------- */

function isNonNegInt(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/** Validate a rules object. Returns `{ ok, errors[] }` with pt-BR messages. */
export function validateRules(rules) {
  const errors = [];
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) {
    return { ok: false, errors: ['As regras precisam ser um objeto JSON.'] };
  }
  if (rules.mode !== undefined && !MODES.has(rules.mode)) {
    errors.push(`"mode" deve ser "all" ou "allowlist" (recebido: ${JSON.stringify(rules.mode)}).`);
  }
  if (rules.unlisted !== undefined) {
    const u = rules.unlisted;
    if (!u || typeof u !== 'object' || Array.isArray(u)) errors.push('"unlisted" deve ser um objeto.');
    else {
      if (u.show !== undefined && typeof u.show !== 'boolean') errors.push('"unlisted.show" deve ser true ou false.');
      if (u.countCoins !== undefined && typeof u.countCoins !== 'boolean') errors.push('"unlisted.countCoins" deve ser true ou false.');
    }
  }
  if (rules.fallback !== undefined) {
    const f = rules.fallback;
    if (!f || typeof f !== 'object' || Array.isArray(f)) errors.push('"fallback" deve ser um objeto.');
    else {
      if (f.team !== undefined && !TEAMS.has(f.team)) errors.push('"fallback.team" deve ser "villain" ou "hero".');
      if (f.bombsPerUnit !== undefined && !isNonNegInt(f.bombsPerUnit)) errors.push('"fallback.bombsPerUnit" deve ser um inteiro ≥ 0.');
      if (f.bombsPerCoins !== undefined && !(Number.isInteger(f.bombsPerCoins) && f.bombsPerCoins >= 1)) errors.push('"fallback.bombsPerCoins" deve ser um inteiro ≥ 1.');
      if (f.maxBombsPerEvent !== undefined && !isNonNegInt(f.maxBombsPerEvent)) errors.push('"fallback.maxBombsPerEvent" deve ser um inteiro ≥ 0.');
    }
  }
  if (rules.gifts !== undefined) {
    if (!Array.isArray(rules.gifts)) errors.push('"gifts" deve ser uma lista.');
    else {
      rules.gifts.forEach((g, i) => {
        const where = `gifts[${i}]`;
        if (!g || typeof g !== 'object' || Array.isArray(g)) { errors.push(`${where}: deve ser um objeto.`); return; }
        const hasMatch = Array.isArray(g.match) && g.match.length > 0;
        const hasIds = Array.isArray(g.ids) && g.ids.length > 0;
        if (g.match !== undefined && !Array.isArray(g.match)) errors.push(`${where}.match deve ser uma lista de nomes.`);
        if (g.ids !== undefined && !Array.isArray(g.ids)) errors.push(`${where}.ids deve ser uma lista de ids.`);
        if (!hasMatch && !hasIds) errors.push(`${where}: informe "match" (nomes) e/ou "ids" (ids do presente).`);
        if (hasMatch && g.match.some((m) => typeof m !== 'string' || !m.trim())) errors.push(`${where}.match só pode conter textos não vazios.`);
        if (hasIds && g.ids.some((id) => !(typeof id === 'number' && Number.isFinite(id)) && !(typeof id === 'string' && id.trim()))) {
          errors.push(`${where}.ids só pode conter números ou textos não vazios.`);
        }
        if (g.team !== undefined && !TEAMS.has(g.team)) errors.push(`${where}.team deve ser "villain" ou "hero".`);
        if (g.tier !== undefined && !TIERS.has(g.tier)) errors.push(`${where}.tier deve ser "normal", "mega" ou "supreme".`);
        if (g.show !== undefined && typeof g.show !== 'boolean') errors.push(`${where}.show deve ser true ou false.`);
        if (g.name !== undefined && typeof g.name !== 'string') errors.push(`${where}.name deve ser um texto.`);
        if (g.desc !== undefined && typeof g.desc !== 'string') errors.push(`${where}.desc deve ser um texto.`);
        if (g.coins !== undefined && !isNonNegInt(g.coins)) errors.push(`${where}.coins deve ser um inteiro ≥ 0.`);
        if (g.maxPerEvent !== undefined && !isNonNegInt(g.maxPerEvent)) errors.push(`${where}.maxPerEvent deve ser um inteiro ≥ 0.`);
        if (g.bombs !== undefined && g.bombs !== null && !isNonNegInt(g.bombs)) errors.push(`${where}.bombs deve ser um inteiro ≥ 0.`);
        if (g.effects !== undefined) {
          const fx = g.effects;
          if (!fx || typeof fx !== 'object' || Array.isArray(fx)) errors.push(`${where}.effects deve ser um objeto.`);
          else {
            for (const k of Object.keys(fx)) {
              if (!EFFECT_KEYS.includes(k)) { errors.push(`${where}.effects.${k}: efeito desconhecido (use ${EFFECT_KEYS.join(', ')}).`); continue; }
              if (k === 'clearBombs') { if (typeof fx[k] !== 'boolean') errors.push(`${where}.effects.clearBombs deve ser true ou false.`); }
              else if (k === 'shieldSec') { if (!(typeof fx[k] === 'number' && Number.isFinite(fx[k]) && fx[k] >= 0)) errors.push(`${where}.effects.shieldSec deve ser um número ≥ 0.`); }
              else if (!isNonNegInt(fx[k])) errors.push(`${where}.effects.${k} deve ser um inteiro ≥ 0.`);
            }
          }
        }
      });
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Fill missing top-level sections with defaults (does not touch the gifts list). */
export function withDefaults(rules) {
  const r = rules && typeof rules === 'object' ? rules : {};
  return {
    mode: MODES.has(r.mode) ? r.mode : 'all',
    unlisted: { ...DEFAULT_RULES.unlisted, ...(r.unlisted || {}) },
    fallback: { ...DEFAULT_RULES.fallback, ...(r.fallback || {}) },
    gifts: Array.isArray(r.gifts) ? r.gifts.map((g) => ({ ...g, effects: g.effects ? { ...g.effects } : undefined })) : DEFAULT_RULES.gifts.map((g) => ({ ...g, effects: { ...g.effects } })),
  };
}

/* ------------------------------------------------------------------------------------------------
 * Persistence
 * ---------------------------------------------------------------------------------------------- */

/**
 * Load rules from disk. When the file is missing OR uses the old v1 schema (a "default"
 * section instead of "fallback"), it is (re)created with DEFAULT_RULES. Invalid JSON throws.
 */
export async function loadRules(filePath) {
  let text;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      const fresh = withDefaults(DEFAULT_RULES);
      await saveRules(filePath, fresh);
      return fresh;
    }
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`config/gifts.json inválido (JSON): ${err.message}`);
  }
  // v1 → v2 migration: the old schema had a "default" section and bomb-only gifts.
  if (parsed && typeof parsed === 'object' && parsed.default && !parsed.fallback) {
    const fresh = withDefaults(DEFAULT_RULES);
    await saveRules(filePath, fresh);
    return fresh;
  }
  const { ok, errors } = validateRules(parsed);
  if (!ok) throw new Error(`config/gifts.json inválido: ${errors.join(' ')}`);
  return withDefaults(parsed);
}

/** Validate and atomically write rules to disk (temp file + rename). */
export async function saveRules(filePath, rules) {
  const { ok, errors } = validateRules(rules);
  if (!ok) {
    const err = new Error(errors.join(' '));
    err.errors = errors;
    throw err;
  }
  const full = withDefaults(rules);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(full, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, filePath);
  return full;
}
