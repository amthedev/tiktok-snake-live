// public/js/net.js
// WebSocket client for the overlay (SPEC §6, client side).
//
//  * tiny event emitter: on(type, fn) → unsubscribe fn, off(type, fn), once(type, fn), emit(type, data)
//  * auto-reconnect with exponential backoff + jitter (500 ms → 15 s cap), reset on a successful open
//  * send(type, payload) adds `ts`; while offline messages are queued (bounded FIFO) and flushed on open
//  * every inbound frame is JSON-parsed inside a guard; malformed frames are dropped (and reported via 'bad_message')
//
// Built-in events (besides the server message types such as 'hello', 'gift', ...):
//   'open' {}                 socket connected
//   'close' {code, reason}    socket closed (a reconnect is scheduled unless close() was called)
//   'reconnecting' {attempt, delayMs}
//   'error' {message}
//   'bad_message' {raw}
//   'message' {type, ...}     every valid inbound message (in addition to the typed emit)

/** Resolve the WebSocket URL: explicit `wsUrl` from CONFIG, else same host at /ws. */
export function resolveWsUrl(wsUrl = null) {
  if (wsUrl) {
    // Allow relative paths ("/ws") and bare host:port values.
    if (/^wss?:\/\//i.test(wsUrl)) return wsUrl;
    if (wsUrl.startsWith('/')) return baseWsOrigin() + wsUrl;
    return (isSecurePage() ? 'wss://' : 'ws://') + wsUrl;
  }
  return baseWsOrigin() + '/ws';
}

function isSecurePage() {
  return typeof location !== 'undefined' && location.protocol === 'https:';
}

function baseWsOrigin() {
  if (typeof location === 'undefined' || !location.host) return 'ws://localhost:3000';
  return (isSecurePage() ? 'wss://' : 'ws://') + location.host;
}

/**
 * @param {string|null} url          WebSocket URL (see resolveWsUrl). `null` → same host /ws.
 * @param {object} [opts]
 * @param {number} [opts.minDelayMs=500]
 * @param {number} [opts.maxDelayMs=15000]
 * @param {number} [opts.queueLimit=200]  max queued outbound messages while offline
 * @param {boolean} [opts.autoConnect=true]
 * @param {(msg:string, err?:any)=>void} [opts.log]
 */
export function createNet(url = null, opts = {}) {
  const {
    minDelayMs = 500,
    maxDelayMs = 15000,
    queueLimit = 200,
    autoConnect = true,
    connectTimeoutMs = 10000,
    log = null
  } = opts;

  const target = resolveWsUrl(url);
  const listeners = new Map(); // type → Set<fn>
  const queue = [];
  let ws = null;
  let attempt = 0;
  let reconnectTimer = null;
  let connectTimer = null;
  let closedByUser = false;
  let online = false;
  let connecting = false;

  const hasWebSocket = typeof WebSocket !== 'undefined';

  function emit(type, data) {
    const set = listeners.get(type);
    if (!set || set.size === 0) return;
    // Copy so listeners may unsubscribe during dispatch.
    for (const fn of Array.from(set)) {
      try { fn(data); } catch (err) { log?.('[net] listener error for ' + type, err); }
    }
  }

  function on(type, fn) {
    if (typeof fn !== 'function') throw new TypeError('listener must be a function');
    let set = listeners.get(type);
    if (!set) { set = new Set(); listeners.set(type, set); }
    set.add(fn);
    return () => off(type, fn);
  }

  function off(type, fn) {
    const set = listeners.get(type);
    if (!set) return;
    if (fn) set.delete(fn); else set.clear();
    if (set.size === 0) listeners.delete(type);
  }

  function once(type, fn) {
    const unsub = on(type, (data) => { unsub(); fn(data); });
    return unsub;
  }

  /** Promise for the next message of `type`, or `null` after `timeoutMs`. */
  function waitFor(type, timeoutMs = 2000) {
    return new Promise((resolve) => {
      let done = false;
      const unsub = once(type, (data) => { if (!done) { done = true; clearTimeout(t); resolve(data); } });
      const t = setTimeout(() => { if (!done) { done = true; unsub(); resolve(null); } }, timeoutMs);
    });
  }

  function clearReconnect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  }

  function scheduleReconnect() {
    if (closedByUser || reconnectTimer) return;
    attempt += 1;
    const base = Math.min(maxDelayMs, minDelayMs * Math.pow(2, attempt - 1));
    const jitter = base * 0.25 * Math.random();
    const delayMs = Math.round(base + jitter);
    emit('reconnecting', { attempt, delayMs });
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delayMs);
  }

  function detach(sock) {
    if (!sock) return;
    sock.onopen = sock.onclose = sock.onerror = sock.onmessage = null;
  }

  function connect() {
    if (closedByUser) closedByUser = false;
    if (!hasWebSocket) {
      emit('error', { message: 'WebSocket indisponível neste ambiente' });
      return;
    }
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    clearReconnect();
    connecting = true;
    let sock;
    try {
      sock = new WebSocket(target);
    } catch (err) {
      connecting = false;
      emit('error', { message: String(err?.message || err) });
      scheduleReconnect();
      return;
    }
    ws = sock;

    sock.onopen = () => {
      if (ws !== sock) return;
      clearTimeout(connectTimer);
      connectTimer = null;
      connecting = false;
      online = true;
      attempt = 0;
      flush();
      emit('open', {});
    };

    sock.onmessage = (ev) => {
      if (ws !== sock) return;
      let msg;
      try {
        msg = typeof ev.data === 'string' ? JSON.parse(ev.data) : null;
      } catch {
        msg = null;
      }
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
        emit('bad_message', { raw: typeof ev.data === 'string' ? ev.data.slice(0, 200) : ev.data });
        return;
      }
      emit('message', msg);
      emit(msg.type, msg);
    };

    sock.onerror = () => {
      if (ws !== sock) return;
      emit('error', { message: 'Falha na conexão WebSocket' });
      // Browsers always fire 'close' after 'error'; some runtimes (Node's WebSocket) do not when the
      // connection never opened. Fall back to the close path if it has not run shortly after.
      setTimeout(() => {
        if (ws === sock && sock.readyState !== WebSocket.OPEN) handleClosed(sock, 1006, 'connection failed');
      }, 250);
    };

    sock.onclose = (ev) => handleClosed(sock, ev?.code ?? 0, ev?.reason ?? '');

    // Safety net: a handshake that neither opens nor errors within connectTimeoutMs is abandoned.
    connectTimer = setTimeout(() => {
      if (ws === sock && sock.readyState !== WebSocket.OPEN) handleClosed(sock, 1006, 'connect timeout');
    }, connectTimeoutMs);
  }

  /** Idempotent close handler: detaches the socket, emits 'close' and schedules a reconnect. */
  function handleClosed(sock, code, reason) {
    if (ws !== sock) return;
    clearTimeout(connectTimer);
    connectTimer = null;
    detach(sock);
    try { if (sock.readyState !== WebSocket.CLOSED) sock.close(); } catch { /* ignore */ }
    ws = null;
    online = false;
    connecting = false;
    emit('close', { code, reason });
    if (!closedByUser) scheduleReconnect();
  }

  function flush() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    while (queue.length) {
      const frame = queue.shift();
      try { ws.send(frame); } catch (err) { log?.('[net] send failed', err); queue.unshift(frame); break; }
    }
  }

  /**
   * Send `{type, ts, ...payload}`. Returns true when sent immediately, false when queued/dropped.
   * @param {string} type
   * @param {object} [payload]
   * @param {{queue?: boolean}} [o]  queue=false → drop instead of queueing while offline (for periodic data)
   */
  function send(type, payload = {}, o = {}) {
    let frame;
    try {
      frame = JSON.stringify({ type, ts: Date.now(), ...(payload || {}) });
    } catch (err) {
      log?.('[net] cannot serialise message ' + type, err);
      return false;
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(frame); return true; } catch (err) { log?.('[net] send failed', err); }
    }
    if (o.queue === false) return false;
    queue.push(frame);
    if (queue.length > queueLimit) queue.splice(0, queue.length - queueLimit); // drop oldest
    return false;
  }

  function close() {
    closedByUser = true;
    clearReconnect();
    clearTimeout(connectTimer);
    connectTimer = null;
    const sock = ws;
    ws = null;
    online = false;
    connecting = false;
    if (sock) {
      detach(sock);
      try { sock.close(1000, 'client closed'); } catch { /* ignore */ }
    }
  }

  if (autoConnect) {
    // Defer so callers can attach listeners before the first 'open'/'error'.
    Promise.resolve().then(connect);
  }

  return {
    on, off, once, emit, waitFor, send, connect, close,
    get online() { return online; },
    get connecting() { return connecting; },
    get url() { return target; },
    get queued() { return queue.length; }
  };
}
