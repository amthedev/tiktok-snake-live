// public/js/config.js
// CONFIG defaults + overrides (SPEC §3).
//
// Precedence (highest wins): URL search params > server `hello.config` > localStorage 'snake.config' > DEFAULTS.
// `loadConfig()` is pure with respect to the DOM except for reading `location.search` and `localStorage`,
// both guarded so the module can be imported in environments where they do not exist.

export const DEFAULTS = {
  gridSize: 16,             // even, 8..24
  // [ritmo 2026-09-04 v2] O cliente mostrou uma live de referência e pediu: "ela começa mais
  // devagar, depois vai aumentando a velocidade". A curva anterior (11 / 0,16 / 28) já nascia
  // acelerada, então não havia progressão perceptível — a cobra parecia sempre no mesmo ritmo.
  // Agora começa em 5 casas/s (dá para acompanhar cada movimento, o começo respira) e termina em
  // 32 (frenético, com a cobra gigante desenhando o tabuleiro). São mais de 6× de aceleração ao
  // longo da rodada, contra 2,5× antes: a tensão sobe de forma óbvia para quem assiste.
  // Rodada média medida: 8,7 min.
  baseSpeed: 5,             // cells per second at length 3
  speedPerSegment: 0.14,    // added per extra segment
  maxSpeed: 32,
  // [itens] Balanceamento da bomba (cliente: "a bomba é muito fraquinha").
  // Dano = bombShrink + floor(tamanho * bombShrinkPct), e a cobra nasce com startLength.
  // Só dobrar o valor fixo acabava com a rodada em ~3 s; medido em docs/DECISOES-LIVE.md.
  bombShrink: 4,
  bombShrinkPct: 0.2,       // +20% do tamanho atual: bomba nunca é fraca numa cobra grande
  startLength: 10,          // fôlego inicial para a bomba mais forte não matar de cara
  bombFuseSec: 90,          // 0 = never
  foodFuseSec: 45,          // comida dourada dos heróis; 0 = nunca some
  maxFoodOnBoard: 30,
  shieldMaxSec: 120,
  maxBombsOnBoard: 60,
  roundRestartDelaySec: 8,
  countdownSec: 3,          // "3-2-1" before the snake moves
  shortcutMaxFill: 0.5,     // AI: allow apple shortcuts while length < shortcutMaxFill * cells
  quality: 'high',          // 'low' | 'medium' | 'high'
  obs: false,               // hide dev panel & cursor, OBS-friendly
  audio: true,
  wsUrl: null,              // default: same host, path /ws
  leaderScope: 'live'       // informational; server decides
};

export const STORAGE_KEY = 'snake.config';

const NUMBER_KEYS = new Set([
  'gridSize', 'baseSpeed', 'speedPerSegment', 'maxSpeed', 'bombShrink', 'bombShrinkPct', 'startLength', // [itens]
  'bombFuseSec', 'foodFuseSec', 'maxFoodOnBoard', 'shieldMaxSec', 'maxBombsOnBoard', 'roundRestartDelaySec',
  'countdownSec', 'shortcutMaxFill'
]);
const BOOLEAN_KEYS = new Set(['obs', 'audio']);
const STRING_KEYS = new Set(['quality', 'wsUrl', 'leaderScope']);
const QUALITIES = new Set(['low', 'medium', 'high']);

/** Coerce a raw value (string from URL, or anything from JSON) into the type expected for `key`. */
function coerce(key, raw) {
  if (raw === undefined || raw === null) return undefined;
  if (NUMBER_KEYS.has(key)) {
    const n = typeof raw === 'number' ? raw : Number(String(raw).trim().replace(',', '.'));
    return Number.isFinite(n) ? n : undefined;
  }
  if (BOOLEAN_KEYS.has(key)) {
    if (typeof raw === 'boolean') return raw;
    const s = String(raw).trim().toLowerCase();
    if (s === '' || s === '1' || s === 'true' || s === 'yes' || s === 'on' || s === 'sim') return true;
    if (s === '0' || s === 'false' || s === 'no' || s === 'off' || s === 'nao' || s === 'não') return false;
    return undefined;
  }
  if (STRING_KEYS.has(key)) {
    if (raw === '' ) return undefined;
    const s = String(raw).trim();
    return s === 'null' ? null : s;
  }
  return undefined; // unknown key: ignored
}

/** Keep only known keys, coerced to their expected types. */
export function sanitizeOverrides(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const key of Object.keys(DEFAULTS)) {
    if (!(key in obj)) continue;
    const v = coerce(key, obj[key]);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/** Parse `?gridSize=12&obs=1` style overrides. */
export function parseSearchParams(search) {
  const src = search ?? (typeof location !== 'undefined' ? location.search : '');
  const out = {};
  let params;
  try { params = new URLSearchParams(src); } catch { return out; }
  for (const [k, v] of params.entries()) {
    if (!(k in DEFAULTS)) continue;
    const c = coerce(k, v);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

/** Read the persisted local override object (never throws). */
export function readLocalConfig() {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return sanitizeOverrides(JSON.parse(raw));
  } catch {
    return {};
  }
}

/** Merge `patch` into the persisted local override object. Returns the new stored object. */
export function saveLocalConfig(patch) {
  const merged = { ...readLocalConfig(), ...sanitizeOverrides(patch) };
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  } catch { /* quota / private mode: ignore */ }
  return merged;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Validate/normalise a full config object (returns a new plain object). */
export function validateConfig(cfg) {
  const c = { ...DEFAULTS, ...cfg };
  // gridSize: even, 8..24
  let g = Math.round(Number(c.gridSize) || DEFAULTS.gridSize);
  g = clamp(g, 8, 24);
  if (g % 2 !== 0) g += (g < 24 ? 1 : -1);
  c.gridSize = g;
  c.baseSpeed = clamp(Number(c.baseSpeed) || DEFAULTS.baseSpeed, 0.5, 40);
  c.maxSpeed = clamp(Number(c.maxSpeed) || DEFAULTS.maxSpeed, c.baseSpeed, 60);
  c.speedPerSegment = clamp(Number(c.speedPerSegment) || 0, 0, 5);
  c.bombShrink = clamp(Math.round(Number(c.bombShrink) || DEFAULTS.bombShrink), 0, 50);
  // [itens] 0..1 (fração do tamanho somada ao dano) e tamanho inicial 3..40.
  c.bombShrinkPct = clamp(Number(c.bombShrinkPct) ?? DEFAULTS.bombShrinkPct, 0, 1);
  c.startLength = clamp(Math.round(Number(c.startLength) || DEFAULTS.startLength), 3, 40);
  c.bombFuseSec = clamp(Number(c.bombFuseSec) || 0, 0, 36000);
  c.maxBombsOnBoard = clamp(Math.round(Number(c.maxBombsOnBoard) || DEFAULTS.maxBombsOnBoard), 0, g * g);
  c.roundRestartDelaySec = clamp(Number(c.roundRestartDelaySec) ?? DEFAULTS.roundRestartDelaySec, 1, 600);
  c.foodFuseSec = clamp(Number(c.foodFuseSec) ?? DEFAULTS.foodFuseSec, 0, 3600);
  c.maxFoodOnBoard = clamp(Math.round(Number(c.maxFoodOnBoard) || DEFAULTS.maxFoodOnBoard), 0, 200);
  c.shieldMaxSec = clamp(Number(c.shieldMaxSec) ?? DEFAULTS.shieldMaxSec, 0, 3600);
  c.countdownSec = clamp(Math.round(Number(c.countdownSec) ?? DEFAULTS.countdownSec), 0, 30);
  c.shortcutMaxFill = clamp(Number(c.shortcutMaxFill) ?? DEFAULTS.shortcutMaxFill, 0, 1);
  c.quality = QUALITIES.has(c.quality) ? c.quality : DEFAULTS.quality;
  c.obs = !!c.obs;
  c.audio = !!c.audio;
  c.wsUrl = typeof c.wsUrl === 'string' && c.wsUrl ? c.wsUrl : null;
  c.leaderScope = typeof c.leaderScope === 'string' && c.leaderScope ? c.leaderScope : DEFAULTS.leaderScope;
  return c;
}

/**
 * Build the effective, frozen CONFIG.
 * @param {object|null} serverOverrides  `hello.config` from the server (optional). Applied between
 *                                       localStorage and URL params so URL params still win.
 */
export function loadConfig(serverOverrides = null) {
  const merged = {
    ...DEFAULTS,
    ...readLocalConfig(),
    ...sanitizeOverrides(serverOverrides),
    ...parseSearchParams()
  };
  return Object.freeze(validateConfig(merged));
}
