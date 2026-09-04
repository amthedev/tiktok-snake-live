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
// [itens] Efeitos novos: itens especiais (raio, gelo, teia, caveira, diamante, estrela, ímã,
// relógio) e os tempos de estrela/ímã/relógio. Quanto MAIOR o presente, mais espetacular o
// combo (pedido do cliente: quem manda presente caro tem que SENTIR a diferença na tela).
const ITEM_EFFECT_KEYS = ['bolt', 'ice', 'web', 'skull', 'diamond', 'star', 'magnet', 'clock'];
const TIMED_EFFECT_KEYS = ['starSec', 'magnetSec', 'fastSec'];
const EFFECT_KEYS = [
  'bombs', 'food', 'grow', 'attack', 'shieldSec', 'clearBombs',
  ...ITEM_EFFECT_KEYS, ...TIMED_EFFECT_KEYS, 'clearAll',
];

/** Hard per-event ceilings (after multiplying by units), whatever the config says. */
export const EVENT_CAPS = Object.freeze({
  bombs: 60, food: 30, grow: 40, attack: 20, shieldSec: 120,
  // [itens] tetos por evento dos itens novos — casam com ITEM_KINDS[].max no state.
  bolt: 6, ice: 4, web: 4, skull: 3, diamond: 8, star: 3, magnet: 2, clock: 3,
  starSec: 60, magnetSec: 60, fastSec: 60,
});

/**
 * The 16 default gifts — REAL TikTok gifts with their well-known coin prices.
 * `coins` is informative (the live event carries the real diamondCount); `desc` is the
 * pt-BR effect line shown on the overlay gift card. Effects are PER UNIT of the gift.
 */
export const DEFAULT_RULES = Object.freeze({
  mode: 'all',
  unlisted: { show: true, countCoins: true },
  fallback: { team: 'villain', bombsPerUnit: 1, bombsPerCoins: 10, maxBombsPerEvent: 30 },
  // [itens] ESCALA DE RECOMPENSA (pedido do cliente): 1 moeda faz algo pequeno; presente
  // supremo dispara um COMBO. A régua por faixa de preço:
  //   1–30 moedas   → 1 efeito simples (bomba/comida)
  //   ~100 moedas   → efeito simples MAIOR + 1 item especial barato (⚡ raio / 💎 diamante)
  //   500–3 000     → bombas + item de dano forte (🧊 gelo, 🕸️ teia) ou bônus (⭐, 🧲)
  //   20 000+       → combo mega: vários itens ao mesmo tempo
  //   supremo       → tudo junto: caveiras/estrelas + chuva de diamantes + limpar tudo
  gifts: [
    // 😈 VILÕES ------------------------------------------------------------------------
    { name: 'Rosa', match: ['Rose', 'Rosa'], ids: [5655], coins: 1, team: 'villain', tier: 'normal',
      effects: { bombs: 1 }, desc: 'solta 1 bomba' },
    { name: 'Casquinha', match: ['Ice Cream Cone', 'Casquinha', 'Sorvete'], coins: 1, team: 'villain', tier: 'normal',
      effects: { bombs: 1 }, desc: 'solta 1 bomba' },
    { name: 'Rosquinha', match: ['Doughnut', 'Donut', 'Rosquinha'], coins: 30, team: 'villain', tier: 'normal',
      effects: { bombs: 2, bolt: 1 }, desc: '2 bombas + ⚡ 1 raio' },
    { name: 'Boné', match: ['Cap', 'Boné', 'Bone'], coins: 99, team: 'villain', tier: 'normal',
      effects: { bombs: 4, bolt: 2 }, desc: '4 bombas + ⚡ 2 raios' },
    { name: 'Confete', match: ['Confetti', 'Confete'], coins: 100, team: 'villain', tier: 'normal',
      effects: { bombs: 6, ice: 1 }, desc: 'chuva de 6 bombas + 🧊 gelo' },
    { name: 'Arma de Dinheiro', match: ['Money Gun', 'Arma de Dinheiro'], coins: 500, team: 'villain', tier: 'mega',
      effects: { bombs: 10, attack: 2, bolt: 3, web: 1 },
      desc: '💥 10 bombas, morde −2, ⚡ 3 raios e 🕸️ teia' },
    { name: 'Moto', match: ['Motorcycle', 'Moto'], coins: 2988, team: 'villain', tier: 'mega',
      effects: { bombs: 16, attack: 4, bolt: 4, ice: 2, web: 2 }, maxPerEvent: 40,
      desc: '🏍️ 16 bombas, atropela −4, ⚡ 4 raios, 🧊 2 gelos e 🕸️ 2 teias' },
    // Os dois SUPREMOS mantêm `effects` no contrato histórico (bombas/ataque, limpeza) e
    // colocam o espetáculo novo em `combo`, aplicado logo depois pelo overlay.
    { name: 'Leão', match: ['Lion', 'Leão', 'Leao'], coins: 29999, team: 'villain', tier: 'supreme',
      effects: { bombs: 40, attack: 6 }, combo: { bolt: 6, ice: 4, web: 4, skull: 3 }, maxPerEvent: 60,
      desc: '👑 SUPREMO: 40 bombas, mordida −6, ⚡ raios, 🧊 gelo, 🕸️ teias e ☠️ 3 caveiras' },
    // 😇 HERÓIS ------------------------------------------------------------------------
    { name: 'GG', match: ['GG'], coins: 1, team: 'hero', tier: 'normal',
      effects: { food: 1 }, desc: '+1 comida dourada' },
    { name: 'Coraçãozinho', match: ['Finger Heart', 'Coraçãozinho', 'Coração'], coins: 5, team: 'hero', tier: 'normal',
      effects: { food: 2 }, desc: '+2 comidas douradas' },
    { name: 'Tsuru de Papel', match: ['Paper Crane', 'Tsuru de Papel', 'Tsuru'], coins: 99, team: 'hero', tier: 'normal',
      effects: { grow: 3, diamond: 1 }, desc: 'cresce +3 e solta 💎 1 diamante' },
    { name: 'Coração nas Mãos', match: ['Hand Hearts', 'Hands Heart', 'Coração nas Mãos'], coins: 100, team: 'hero', tier: 'normal',
      effects: { food: 3, grow: 1, diamond: 2 }, desc: '+3 comidas, cresce +1 e 💎 2 diamantes' },
    { name: 'Cisne', match: ['Swan', 'Cisne'], coins: 699, team: 'hero', tier: 'mega',
      effects: { clearBombs: true, diamond: 3, clock: 1 },
      desc: '✨ limpa TODAS as bombas, 💎 3 diamantes e ⏱️ turbo' },
    { name: 'Galáxia', match: ['Galaxy', 'Galáxia', 'Galaxia'], coins: 1000, team: 'hero', tier: 'mega',
      effects: { clearBombs: true, shieldSec: 30, star: 1, magnet: 1 },
      desc: '🛡️ escudo 30 s, limpa as bombas, ⭐ estrela e 🧲 ímã' },
    { name: 'Foguete', match: ['Rocket', 'Foguete'], coins: 20000, team: 'hero', tier: 'mega',
      effects: { grow: 10, food: 6, shieldSec: 30, diamond: 5, star: 2, clock: 2 },
      desc: '🚀 cresce +10, 6 comidas, escudo 30 s, 💎 5 diamantes, ⭐ 2 estrelas e ⏱️ turbo' },
    { name: 'Universo TikTok', match: ['TikTok Universe', 'Universo TikTok', 'Universe'], coins: 44999, team: 'hero', tier: 'supreme',
      effects: { grow: 15, food: 10, clearBombs: true, shieldSec: 60 },
      combo: { clearAll: true, diamond: 8, star: 3, magnet: 2, clock: 3, starSec: 15 },
      desc: '🌌 SUPREMO: limpa TUDO, +15, 10 comidas, 💎 chuva de diamantes, ⭐ invencível e 🧲 ímã' },
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

/**
 * Zeroed effects object (forma histórica do SPEC).
 * [itens] Os efeitos novos NÃO entram zerados: eles são adicionados só quando o presente
 * realmente os usa, para que um presente clássico continue devolvendo exatamente o mesmo
 * objeto de antes (nada quebra para quem já lia esse formato).
 */
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
  let comboPerUnit = null; // [itens] efeitos extra do presentão (ver rule.combo)
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
    // [itens] itens especiais (quantidade) e efeitos por tempo (segundos)
    for (const k of ITEM_EFFECT_KEYS) perUnit[k] = nonNegInt(fx[k], 0);
    for (const k of TIMED_EFFECT_KEYS) perUnit[k] = Math.max(0, num(fx[k], 0));
    perUnit.clearAll = fx.clearAll === true;
    if (rule.maxPerEvent !== undefined) maxBombs = nonNegInt(rule.maxPerEvent, maxBombs);
    // [itens] `combo`: efeitos EXTRA dos presentes grandes (itens especiais e tempos). Fica
    // num campo próprio no resultado, para `effects` continuar exatamente com a forma
    // histórica do SPEC; o overlay aplica os dois na sequência.
    const cb = rule.combo && typeof rule.combo === 'object' ? rule.combo : null;
    if (cb) {
      comboPerUnit = {};
      for (const k of ITEM_EFFECT_KEYS) if (cb[k] !== undefined) comboPerUnit[k] = nonNegInt(cb[k], 0);
      for (const k of TIMED_EFFECT_KEYS) if (cb[k] !== undefined) comboPerUnit[k] = Math.max(0, num(cb[k], 0));
      if (cb.clearAll === true) comboPerUnit.clearAll = true;
    }
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
  // [itens] Cada item/tempo tem seu próprio teto por evento e só aparece no resultado quando
  // o presente pede por ele (mantém a forma antiga intacta nos presentes clássicos).
  for (const k of [...ITEM_EFFECT_KEYS, ...TIMED_EFFECT_KEYS]) {
    const v = Math.min((perUnit[k] || 0) * units, EVENT_CAPS[k]);
    if (v > 0) effects[k] = v;
  }
  if (perUnit.clearAll && units > 0) effects.clearAll = true;

  // [itens] Combo do presentão: mesmo tratamento de tetos, em campo separado. Só aparece no
  // resultado quando a regra realmente define um `combo`.
  let combo = null;
  if (comboPerUnit) {
    combo = {};
    for (const k of [...ITEM_EFFECT_KEYS, ...TIMED_EFFECT_KEYS]) {
      const v = Math.min((comboPerUnit[k] || 0) * units, EVENT_CAPS[k]);
      if (v > 0) combo[k] = v;
    }
    if (comboPerUnit.clearAll && units > 0) combo.clearAll = true;
    if (Object.keys(combo).length === 0) combo = null;
  }

  return {
    show,
    matched,
    ruleName,
    countCoins,
    team,
    tier,
    effects,
    ...(combo ? { combo } : {}), // [itens]
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
        // [itens] `combo` aceita exatamente as mesmas chaves de `effects` e é validado igual.
        for (const field of ['effects', 'combo']) {
        if (g[field] !== undefined) {
          const fx = g[field];
          const where2 = `${where}.${field}`;
          if (!fx || typeof fx !== 'object' || Array.isArray(fx)) errors.push(`${where2} deve ser um objeto.`);
          else {
            for (const k of Object.keys(fx)) {
              if (!EFFECT_KEYS.includes(k)) { errors.push(`${where2}.${k}: efeito desconhecido (use ${EFFECT_KEYS.join(', ')}).`); continue; }
              if (k === 'clearBombs' || k === 'clearAll') { if (typeof fx[k] !== 'boolean') errors.push(`${where2}.${k} deve ser true ou false.`); }
              // [itens] shieldSec e os tempos novos (starSec/magnetSec/fastSec) são números ≥ 0.
              else if (k === 'shieldSec' || TIMED_EFFECT_KEYS.includes(k)) { if (!(typeof fx[k] === 'number' && Number.isFinite(fx[k]) && fx[k] >= 0)) errors.push(`${where2}.${k} deve ser um número ≥ 0.`); }
              else if (!isNonNegInt(fx[k])) errors.push(`${where2}.${k} deve ser um inteiro ≥ 0.`);
            }
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
    // [itens] `combo` é copiado junto com `effects` (mesma cópia rasa).
    gifts: Array.isArray(r.gifts)
      ? r.gifts.map((g) => ({ ...g, effects: g.effects ? { ...g.effects } : undefined, ...(g.combo ? { combo: { ...g.combo } } : {}) }))
      : DEFAULT_RULES.gifts.map((g) => ({ ...g, effects: { ...g.effects }, ...(g.combo ? { combo: { ...g.combo } } : {}) })),
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
