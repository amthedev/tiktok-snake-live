/**
 * normalize.js — pure functions that turn raw TikTok payloads (tiktok-live-connector v2 / proto v3,
 * plus the legacy v1 field names) into the normalized shapes described in SPEC §6.
 *
 * Nothing in this file touches the network or the filesystem, so it is unit-testable in Node.
 */

const PROXY_PREFIX = '/img?u=';

/* ------------------------------------------------------------------------------------------------
 * Small helpers
 * ---------------------------------------------------------------------------------------------- */

/** Coerce anything to a trimmed string (or the fallback when empty). */
export function str(v, fallback = '') {
  if (v === null || v === undefined) return fallback;
  const s = String(v).trim();
  return s.length ? s : fallback;
}

/** Coerce anything to a finite integer ≥ 0 (or the fallback). */
export function int(v, fallback = 0) {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.max(0, Math.trunc(n));
}

/**
 * Extract the first usable URL from the many "image" shapes TikTok uses:
 * `{ urlList: [] }` (v3), `{ url_list: [] }` (webcast JSON), `{ urls: [] }` (legacy), or a plain string.
 */
export function pickImageUrl(img) {
  if (!img) return null;
  if (typeof img === 'string') return isHttpUrl(img) ? img : null;
  const lists = [img.urlList, img.url_list, img.urls];
  for (const list of lists) {
    if (Array.isArray(list)) {
      const found = list.find((u) => typeof u === 'string' && isHttpUrl(u));
      if (found) return found;
    }
  }
  if (typeof img.url === 'string' && isHttpUrl(img.url)) return img.url;
  return null;
}

/** True for absolute http(s) URLs. */
export function isHttpUrl(u) {
  return typeof u === 'string' && /^https?:\/\/\S+$/i.test(u);
}

/**
 * Turn an absolute image URL into its proxied form (`/img?u=<encoded>`).
 * `data:` URIs and already-proxied paths are returned untouched; anything else becomes null.
 */
export function toProxyUrl(u) {
  if (!u || typeof u !== 'string') return null;
  if (u.startsWith('data:image/')) return u;
  if (u.startsWith(PROXY_PREFIX)) return u;
  if (!isHttpUrl(u)) return null;
  return PROXY_PREFIX + encodeURIComponent(u);
}

/* ------------------------------------------------------------------------------------------------
 * Generated avatars for simulated users (no external services)
 * ---------------------------------------------------------------------------------------------- */

const AVATAR_HUES = [200, 260, 320, 20, 40, 140, 170, 350, 290, 80];

/** Deterministic small hash (FNV-1a) used to pick a colour per user. */
export function hashString(s) {
  let h = 0x811c9dc5;
  const text = String(s ?? '');
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Up to two initials from a display name ("Maria Silva" → "MS", "joão" → "J"). */
export function initials(name) {
  const parts = str(name, '?').split(/[\s._-]+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((p) => p[0].toUpperCase());
  return (letters.join('') || '?').slice(0, 2);
}

/**
 * Build an SVG data-URI avatar: initials on a coloured circle. Safe to put straight in an <img>.
 */
export function avatarDataUri(name, seed = name) {
  const hue = AVATAR_HUES[hashString(seed) % AVATAR_HUES.length];
  const text = initials(name).replace(/[<>&"']/g, '');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="hsl(${hue},80%,60%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360},75%,40%)"/>` +
    `</linearGradient></defs>` +
    `<circle cx="48" cy="48" r="48" fill="url(#g)"/>` +
    `<text x="48" y="60" text-anchor="middle" font-family="system-ui,Segoe UI,Roboto,Arial,sans-serif" ` +
    `font-size="38" font-weight="800" fill="#fff">${text}</text></svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

/* ------------------------------------------------------------------------------------------------
 * Users
 * ---------------------------------------------------------------------------------------------- */

/**
 * Normalize a TikTok user object (v3 `User` or legacy) into a `UserRef`.
 * The avatar URL comes back already proxied (or as a data: URI, or null).
 */
export function normalizeUser(raw) {
  const u = raw && typeof raw === 'object' ? raw : {};
  const userId = str(u.userId ?? u.id ?? u.user_id ?? u.secUid, '');
  const uniqueId = str(u.uniqueId ?? u.displayId ?? u.unique_id ?? u.display_id, '') || userId || 'anonimo';
  const nickname = str(u.nickname ?? u.nickName ?? u.nick_name, '') || uniqueId;

  let avatar =
    pickImageUrl(u.avatarThumb) ||
    pickImageUrl(u.avatarMedium) ||
    pickImageUrl(u.avatarLarge) ||
    pickImageUrl(u.profilePicture) ||
    pickImageUrl(u.profilePictureUrl) ||
    pickImageUrl(u.avatarUrl) ||
    null;
  // Simulated users may already carry a data: URI.
  if (!avatar && typeof u.avatarUrl === 'string' && u.avatarUrl.startsWith('data:image/')) avatar = u.avatarUrl;

  return {
    userId: userId || `anon:${uniqueId}`,
    uniqueId,
    nickname,
    avatarUrl: toProxyUrl(avatar),
  };
}

/* ------------------------------------------------------------------------------------------------
 * Gifts
 * ---------------------------------------------------------------------------------------------- */

/**
 * Normalize a raw gift message. Returned shape (not yet the wire `GiftEvent`, streak deltas are
 * applied later by `StreakTracker`):
 * `{ giftId, giftName, giftImageUrl, diamondCount, giftType, repeatCount, repeatEnd, groupId, user }`
 */
export function normalizeGift(raw) {
  const g = raw && typeof raw === 'object' ? raw : {};
  const v3 = g.gift && typeof g.gift === 'object' ? g.gift : null; // proto v3 embedded gift struct
  const ext = g.extendedGiftInfo && typeof g.extendedGiftInfo === 'object' ? g.extendedGiftInfo : null; // webcast JSON
  const legacy = g.giftDetails && typeof g.giftDetails === 'object' ? g.giftDetails : null; // v1 names

  const giftId = str(g.giftId ?? v3?.id ?? ext?.id ?? g.gift_id ?? legacy?.giftId, '') || 'unknown';
  const giftName =
    str(v3?.name, '') ||
    str(ext?.name, '') ||
    str(legacy?.giftName, '') ||
    str(g.giftName, '') ||
    `Presente #${giftId}`;

  const diamondCount = int(
    v3?.diamondCount ?? ext?.diamond_count ?? ext?.diamondCount ?? legacy?.diamondCount ?? g.diamondCount,
    0,
  );

  const rawType = v3?.type ?? ext?.type ?? legacy?.giftType ?? g.giftType;
  const giftType = rawType === null || rawType === undefined ? null : int(rawType, 0);

  const image =
    pickImageUrl(v3?.image) ||
    pickImageUrl(v3?.icon) ||
    pickImageUrl(ext?.image) ||
    pickImageUrl(ext?.icon) ||
    pickImageUrl(legacy?.giftImage?.giftPictureUrl) ||
    pickImageUrl(legacy?.giftImage) ||
    pickImageUrl(g.giftPictureUrl) ||
    pickImageUrl(g.giftImageUrl) ||
    null;

  const repeatCount = int(g.repeatCount ?? g.repeat_count, 1);
  const repeatEndRaw = g.repeatEnd ?? g.repeat_end;
  const repeatEnd = repeatEndRaw === true || repeatEndRaw === 1 || repeatEndRaw === '1';
  const groupId = str(g.groupId ?? g.group_id, '0');

  return {
    giftId,
    giftName,
    giftImageUrl: toProxyUrl(image),
    diamondCount,
    giftType,
    repeatCount,
    repeatEnd,
    groupId,
    user: normalizeUser(g.user),
  };
}

/* ------------------------------------------------------------------------------------------------
 * Chat / like / social / member / viewers
 * ---------------------------------------------------------------------------------------------- */

export function normalizeChat(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  return {
    user: normalizeUser(c.user),
    text: str(c.content ?? c.comment ?? c.text, '').slice(0, 300),
  };
}

export function normalizeLike(raw) {
  const l = raw && typeof raw === 'object' ? raw : {};
  return {
    user: normalizeUser(l.user),
    count: int(l.count ?? l.likeCount ?? l.like_count, 1) || 1,
    total: int(l.total ?? l.totalLikeCount ?? l.total_like_count, 0),
  };
}

/** follow / share / member all reduce to `{ user }`. */
export function normalizeSocial(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return { user: normalizeUser(s.user) };
}

export const normalizeMember = normalizeSocial;

/** roomUser → `{ count }` (viewer count). */
export function normalizeRoomUser(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return { count: int(r.total ?? r.viewerCount ?? r.viewer_count ?? r.totalUser ?? r.memberCount, 0) };
}

/* ------------------------------------------------------------------------------------------------
 * Streak tracking (SPEC §6.5)
 * ---------------------------------------------------------------------------------------------- */

/**
 * Tracks running gift streaks so that each event carries only the NEW units (`count`).
 *
 * `giftType === 1` gifts arrive repeatedly with an increasing `repeatCount` and a final `repeatEnd`.
 * Key `userId:giftId:groupId → lastCount`; `count = max(0, repeatCount - lastCount)`; the key is
 * removed on `repeatEnd`. Non-streakable gifts: `count = max(1, repeatCount)`, `streakEnd = true`.
 * Keys expire after `ttlMs` (60 s) of inactivity.
 *
 * Unknown `giftType` (null) is treated like a streak so that repeated events are never double counted.
 */
export class StreakTracker {
  constructor({ ttlMs = 60_000, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.map = new Map(); // key → { count, at }
  }

  get size() {
    return this.map.size;
  }

  /** Drop keys idle for longer than the TTL. */
  prune() {
    const t = this.now();
    for (const [key, entry] of this.map) {
      if (t - entry.at > this.ttlMs) this.map.delete(key);
    }
  }

  /**
   * @param {ReturnType<typeof normalizeGift>} g normalized gift
   * @returns {{ count: number, repeatCount: number, streakEnd: boolean }}
   */
  apply(g) {
    this.prune();
    const streakable = g.giftType === 1 || g.giftType === null || g.giftType === undefined;
    if (!streakable) {
      const n = Math.max(1, int(g.repeatCount, 1));
      return { count: n, repeatCount: n, streakEnd: true };
    }

    const key = `${g.user?.userId ?? '?'}:${g.giftId}:${g.groupId ?? '0'}`;
    const last = this.map.get(key)?.count ?? 0;
    const repeat = int(g.repeatCount, 0);
    const running = Math.max(last, repeat);
    const count = Math.max(0, repeat - last);

    if (g.repeatEnd) {
      this.map.delete(key);
    } else {
      this.map.set(key, { count: running, at: this.now() });
    }
    return { count, repeatCount: running, streakEnd: !!g.repeatEnd };
  }

  clear() {
    this.map.clear();
  }
}
