// Shared helpers for the renderer modules: grid constants, math, image cache,
// canvas drawing helpers (avatars, labels) and pt-BR formatting.
import * as THREE from 'three';

/** Grid directions, identical to SPEC §1 (0 up, 1 right, 2 down, 3 left). */
export const DIRS = [
  { x: 0, z: -1 },
  { x: 1, z: 0 },
  { x: 0, z: 1 },
  { x: -1, z: 0 }
];

/** World size of one grid cell (SPEC §1). */
export const CELL = 1.0;

/** Height of the snake / items above the tile tops. */
export const ITEM_Y = 0.34;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
/** Frame-rate independent exponential approach (Freya Holmér's "damp"). */
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
export const rand = (a = 0, b = 1) => a + Math.random() * (b - a);
export const TAU = Math.PI * 2;

/** Cell centre in world space (SPEC §1). */
export function cellToWorld(x, z, y = ITEM_Y, out = new THREE.Vector3()) {
  return out.set((x + 0.5) * CELL, y, (z + 0.5) * CELL);
}

/** Small deterministic string hash used to pick a stable avatar colour per user. */
export function hashString(str) {
  let h = 2166136261;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const AVATAR_COLORS = ['#22d3ee', '#fbbf24', '#fb7185', '#34d399', '#a78bfa', '#f97316', '#60a5fa', '#f472b6'];

export function colorForName(name) {
  return AVATAR_COLORS[hashString(name) % AVATAR_COLORS.length];
}

/** First letters of the first two words, upper-cased; "?" when empty. */
export function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = [...parts[0]][0] || '';
  const second = parts.length > 1 ? ([...parts[1]][0] || '') : '';
  return (first + second).toUpperCase();
}

/** Truncate to `max` characters, adding an ellipsis when cut. */
export function truncate(str, max = 14) {
  const chars = [...String(str || '')];
  return chars.length > max ? chars.slice(0, max).join('') + '…' : chars.join('');
}

const nf = (typeof Intl !== 'undefined') ? new Intl.NumberFormat('pt-BR') : null;
export function formatCoins(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  return nf ? nf.format(v) : String(v);
}

// ---------------------------------------------------------------------------
// Image loading with a bounded cache. URLs are same-origin proxied paths
// ('/img?u=...') or data: URIs; we still set crossOrigin so canvases stay
// untainted if an absolute URL slips through.
// ---------------------------------------------------------------------------
const IMAGE_CACHE = new Map(); // url -> Promise<HTMLImageElement>
const IMAGE_CACHE_MAX = 64;
const IMAGE_TIMEOUT_MS = 8000;

/**
 * Load an image (cached). Resolves with the HTMLImageElement, rejects on error
 * or timeout. Never throws synchronously.
 */
export function loadImage(url) {
  if (!url || typeof url !== 'string') return Promise.reject(new Error('empty image url'));
  const cached = IMAGE_CACHE.get(url);
  if (cached) {
    // Refresh LRU order.
    IMAGE_CACHE.delete(url);
    IMAGE_CACHE.set(url, cached);
    return cached;
  }
  const p = new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      img.src = '';
      reject(new Error('image timeout: ' + url));
    }, IMAGE_TIMEOUT_MS);
    img.onload = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!img.naturalWidth) { reject(new Error('empty image: ' + url)); return; }
      resolve(img);
    };
    img.onerror = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error('image failed: ' + url));
    };
    img.src = url;
  });
  // Failed loads are evicted so a later retry can succeed.
  p.catch(() => { if (IMAGE_CACHE.get(url) === p) IMAGE_CACHE.delete(url); });
  IMAGE_CACHE.set(url, p);
  while (IMAGE_CACHE.size > IMAGE_CACHE_MAX) {
    const oldest = IMAGE_CACHE.keys().next().value;
    IMAGE_CACHE.delete(oldest);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Canvas helpers
// ---------------------------------------------------------------------------

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * Draw a circular avatar at (cx, cy) with radius r. Uses the image when given,
 * otherwise a coloured disc with the user's initials.
 */
export function drawAvatar(ctx, cx, cy, r, img, name) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.closePath();
  ctx.clip();
  if (img) {
    // Cover-fit the image inside the circle.
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    const s = Math.max((2 * r) / iw, (2 * r) / ih);
    const dw = iw * s;
    const dh = ih * s;
    ctx.drawImage(img, cx - dw / 2, cy - dh / 2, dw, dh);
  } else {
    const grad = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
    const base = colorForName(name);
    grad.addColorStop(0, base);
    grad.addColorStop(1, '#0f172a');
    ctx.fillStyle = grad;
    ctx.fillRect(cx - r, cy - r, 2 * r, 2 * r);
    ctx.fillStyle = '#ffffff';
    ctx.font = `800 ${Math.round(r * 0.95)}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initials(name), cx, cy + r * 0.04);
  }
  ctx.restore();
}

/**
 * Copy an image into a square canvas texture. Uploading <img> elements
 * directly can fail for SVG / not-yet-decoded images ("bad image data"), so
 * every image texture goes through a canvas first.
 */
export function imageTexture(img, size = 256) {
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  const iw = img.naturalWidth || img.width || 1;
  const ih = img.naturalHeight || img.height || 1;
  const s = Math.min(size / iw, size / ih);
  const dw = iw * s, dh = ih * s;
  ctx.drawImage(img, (size - dw) / 2, (size - dh) / 2, dw, dh);
  return canvasTexture(c);
}

/** Create a CanvasTexture configured for sRGB UI content. */
export function canvasTexture(canvas) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

/** Dispose every geometry/material/texture below `obj` (inclusive). */
export function disposeObject(obj) {
  if (!obj) return;
  obj.traverse((node) => {
    if (node.geometry && typeof node.geometry.dispose === 'function') node.geometry.dispose();
    const mats = Array.isArray(node.material) ? node.material : node.material ? [node.material] : [];
    for (const m of mats) disposeMaterial(m);
  });
  if (obj.parent) obj.parent.remove(obj);
}

export function disposeMaterial(m) {
  if (!m) return;
  for (const key of Object.keys(m)) {
    const v = m[key];
    if (v && v.isTexture) v.dispose();
  }
  if (m.uniforms) {
    for (const u of Object.values(m.uniforms)) {
      if (u && u.value && u.value.isTexture) u.value.dispose();
    }
  }
  m.dispose();
}
