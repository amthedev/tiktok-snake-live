/**
 * proxy.js — image proxy `GET /img?u=<absolute http(s) URL>` (SPEC §6.4).
 *
 * TikTok CDN images cannot be drawn on a canvas by the overlay because of CORS, so the server
 * fetches them and re-serves them with `Access-Control-Allow-Origin: *`.
 *
 * Safety: only http(s); the hostname is resolved and private/loopback/link-local addresses are
 * rejected (SSRF); redirects are followed manually (max 3) with the same checks per hop; only
 * `image/*` content types; 5 s timeout; 3 MB cap; in-memory LRU (200 entries, 10 min).
 */

import dns from 'node:dns/promises';
import net from 'node:net';

const TIMEOUT_MS = 5_000;
const MAX_BYTES = 3 * 1024 * 1024;
const CACHE_MAX = 200;
const CACHE_TTL_MS = 10 * 60 * 1000;
const NEGATIVE_TTL_MS = 60 * 1000;
const MAX_REDIRECTS = 3;

/* ------------------------------------------------------------------------------------------------
 * Address checks
 * ---------------------------------------------------------------------------------------------- */

/** True when an IPv4 dotted-quad is private / loopback / link-local / reserved. */
export function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true; // this-net, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0) return true; // IETF / benchmarking ranges
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true; // multicast / reserved / broadcast
  return false;
}

/** True when an IPv6 address is loopback / unique-local / link-local / mapped-private. */
export function isPrivateIPv6(ip) {
  const low = ip.toLowerCase();
  if (low === '::' || low === '::1') return true;
  if (low.startsWith('fc') || low.startsWith('fd')) return true; // fc00::/7
  if (low.startsWith('fe8') || low.startsWith('fe9') || low.startsWith('fea') || low.startsWith('feb')) return true; // fe80::/10
  const mapped = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

export function isPrivateAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateIPv4(ip);
  if (family === 6) return isPrivateIPv6(ip);
  return true;
}

/**
 * Parse + validate a target URL. Resolves the hostname and rejects private targets.
 * @returns {Promise<URL>} throws with a pt-BR message otherwise
 */
export async function validateTarget(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('URL inválida.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Somente http(s) é permitido.');
  if (url.username || url.password) throw new Error('Credenciais na URL não são permitidas.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error('Host não permitido.');
  }
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error('Endereço privado não permitido.');
    return url;
  }
  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error('Não foi possível resolver o host.');
  }
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new Error('Endereço privado não permitido.');
  }
  return url;
}

/* ------------------------------------------------------------------------------------------------
 * LRU cache
 * ---------------------------------------------------------------------------------------------- */

class Lru {
  constructor(max) {
    this.max = max;
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (entry.expires < Date.now()) {
      this.map.delete(key);
      return null;
    }
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry;
  }

  set(key, value, ttl) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { ...value, expires: Date.now() + ttl });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }

  clear() {
    this.map.clear();
  }

  get size() {
    return this.map.size;
  }
}

/* ------------------------------------------------------------------------------------------------
 * Fetching
 * ---------------------------------------------------------------------------------------------- */

/** Read a response body with a hard byte cap; throws when exceeded. */
async function readCapped(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('Imagem grande demais.');
  const chunks = [];
  let total = 0;
  const reader = res.body?.getReader?.();
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error('Imagem grande demais.');
    return buf;
  }
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      throw new Error('Imagem grande demais.');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * Fetch an image following up to MAX_REDIRECTS redirects, validating every hop.
 * @returns {Promise<{ body: Buffer, type: string }>}
 */
export async function fetchImage(rawUrl, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let url = await validateTarget(rawUrl);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await fetchImpl(url, {
        signal: controller.signal,
        redirect: 'manual',
        headers: {
          Accept: 'image/*,*/*;q=0.5',
          'User-Agent': 'Mozilla/5.0 (compatible; TikTokSnakeLive/1.0)',
          Referer: 'https://www.tiktok.com/',
        },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        try {
          await res.body?.cancel?.();
        } catch {
          /* ignore */
        }
        if (!loc) throw new Error('Redirecionamento sem destino.');
        if (hop === MAX_REDIRECTS) throw new Error('Redirecionamentos demais.');
        url = await validateTarget(new URL(loc, url).toString());
        continue;
      }
      if (!res.ok) {
        try {
          await res.body?.cancel?.();
        } catch {
          /* ignore */
        }
        throw new Error(`Origem respondeu HTTP ${res.status}.`);
      }
      const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!type.startsWith('image/')) {
        try {
          await res.body?.cancel?.();
        } catch {
          /* ignore */
        }
        throw new Error('A origem não devolveu uma imagem.');
      }
      const body = await readCapped(res, maxBytes);
      return { body, type };
    }
    throw new Error('Redirecionamentos demais.');
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------------------------------------
 * Express handler
 * ---------------------------------------------------------------------------------------------- */

/**
 * Create the `/img` request handler.
 * @param {{ log?: Console, fetchImpl?: typeof fetch }} opts
 */
export function createImageProxy({ log = console, fetchImpl = globalThis.fetch } = {}) {
  const cache = new Lru(CACHE_MAX);
  const inflight = new Map(); // url → Promise (coalesce identical concurrent requests)

  async function load(url) {
    const hit = cache.get(url);
    if (hit) return hit;
    if (inflight.has(url)) return inflight.get(url);
    const p = (async () => {
      try {
        const img = await fetchImage(url, { fetchImpl });
        const entry = { ok: true, body: img.body, type: img.type };
        cache.set(url, entry, CACHE_TTL_MS);
        return entry;
      } catch (err) {
        const message = err?.name === 'AbortError' ? 'Tempo esgotado ao buscar a imagem.' : err?.message || 'Falha ao buscar a imagem.';
        const entry = { ok: false, message };
        cache.set(url, entry, NEGATIVE_TTL_MS);
        return entry;
      } finally {
        inflight.delete(url);
      }
    })();
    inflight.set(url, p);
    return p;
  }

  const handler = async (req, res) => {
    const u = typeof req.query?.u === 'string' ? req.query.u.trim() : '';
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (!u) {
      res.status(400).json({ ok: false, error: 'Parâmetro "u" obrigatório.' });
      return;
    }
    if (u.startsWith('data:')) {
      res.status(400).json({ ok: false, error: 'URIs data: não passam pelo proxy — use diretamente.' });
      return;
    }
    if (u.length > 4096) {
      res.status(414).json({ ok: false, error: 'URL longa demais.' });
      return;
    }
    let entry;
    try {
      entry = await load(u);
    } catch (err) {
      log.warn?.('[proxy] erro inesperado:', err?.message);
      entry = { ok: false, message: 'Falha ao buscar a imagem.' };
    }
    if (!entry.ok) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(502).json({ ok: false, error: entry.message });
      return;
    }
    res.setHeader('Content-Type', entry.type);
    res.setHeader('Content-Length', String(entry.body.length));
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.status(200).end(entry.body);
  };

  handler.cache = cache;
  return handler;
}
