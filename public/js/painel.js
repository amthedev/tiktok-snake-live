/**
 * painel.js — control panel logic (pt-BR UI).
 *
 * Talks to the server through the JSON API (SPEC §6.3) and listens to the WebSocket (§6.1) for
 * live updates. Works with or without the overlay open.
 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const fmt = new Intl.NumberFormat('pt-BR');
const PHASES = { countdown: 'Contagem', playing: 'Jogando', won: 'Vitória', lost: 'Derrota', unknown: '–' };
const STATUS_LABEL = {
  disconnected: 'desconectado',
  connecting: 'conectando…',
  connected: 'AO VIVO',
  waiting_live: 'aguardando live',
  error: 'erro',
};
const STATUS_CLASS = { disconnected: 'pill-off', connecting: 'pill-busy', connected: 'pill-on', waiting_live: 'pill-busy', error: 'pill-err' };
const NICKS = ['Ana Clara', 'Bruno Games', 'Carla Souza', 'Duda', 'Enzo Live', 'Fernanda', 'Gabi', 'Heitor', 'Isa Melo', 'João Pedro', 'Kaique', 'Larissa', 'Marcos', 'Nina', 'Otávio', 'Paty', 'Rafa', 'Sofia', 'Thiago', 'Vitória'];

const state = {
  ws: null,
  wsRetryMs: 1000,
  connected: false,
  tiktok: null,
  stats: null,
  leaderboard: null,
  rules: null,
  snapshot: null,
  logPaused: false,
};

/* ------------------------------------------------------------------------------------------------
 * Toasts & log
 * ---------------------------------------------------------------------------------------------- */

function toast(text, kind = 'info', ms = 3200) {
  const box = $('#toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  box.appendChild(el);
  setTimeout(() => el.remove(), ms);
  while (box.children.length > 4) box.firstElementChild.remove();
}

function logLine(text, cls = '') {
  if (state.logPaused) return;
  const log = $('#log');
  if (!log) return;
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
  const line = document.createElement('div');
  line.className = `line ${cls}`;
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = new Date().toLocaleTimeString('pt-BR');
  const body = document.createElement('span');
  body.textContent = text;
  line.append(t, body);
  log.appendChild(line);
  while (log.children.length > 200) log.firstElementChild.remove();
  if (atBottom) log.scrollTop = log.scrollHeight;
}

/* ------------------------------------------------------------------------------------------------
 * HTTP helpers
 * ---------------------------------------------------------------------------------------------- */

async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new Error(`Servidor inacessível (${err.message}).`);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const msg = data?.error || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.errors = data?.errors;
    err.status = res.status;
    throw err;
  }
  return data;
}

const post = (url, body = {}) => api('POST', url, body);

/** Wrap a button click: shows busy state, reports errors as toasts. */
function busy(btn, fn) {
  return async (ev) => {
    ev?.preventDefault?.();
    if (btn?.classList.contains('busy')) return;
    btn?.classList.add('busy');
    try {
      await fn(ev);
    } catch (err) {
      toast(err.message || String(err), 'error');
      logLine(`erro: ${err.message}`, 'err');
    } finally {
      btn?.classList.remove('busy');
    }
  };
}

/* ------------------------------------------------------------------------------------------------
 * Rendering
 * ---------------------------------------------------------------------------------------------- */

function setPill(el, text, cls) {
  el.textContent = text;
  el.className = `pill ${cls}`;
}

function renderWs() {
  setPill($('#pill-ws'), state.connected ? 'servidor online' : 'servidor offline', state.connected ? 'pill-on' : 'pill-err');
}

function renderTiktok() {
  const s = state.tiktok || { status: 'disconnected', username: null, message: null, viewers: 0 };
  const label = STATUS_LABEL[s.status] || s.status;
  setPill($('#pill-tiktok'), `TikTok: ${label}${s.username ? ` @${s.username}` : ''}`, STATUS_CLASS[s.status] || 'pill-off');
  $('#pill-viewers').textContent = `👁 ${fmt.format(s.viewers || 0)}`;
  const msg = $('#tiktok-message');
  msg.textContent = (s.message || label) + (s.roomId ? ` · sala ${s.roomId}` : '');
  msg.className = `status-line ${s.status === 'connected' ? 'ok' : s.status === 'error' ? 'err' : s.status === 'waiting_live' || s.status === 'connecting' ? 'warn' : 'muted'}`;
  const input = $('#in-username');
  if (s.username && !input.value) input.value = s.username;
  $('#btn-connect').textContent = s.status === 'connected' || s.status === 'connecting' || s.status === 'waiting_live' ? 'Reconectar' : 'Conectar';
  $('#btn-disconnect').disabled = s.status === 'disconnected';
}

function renderSnapshot() {
  const s = state.snapshot;
  const fresh = s && Date.now() - (s.at || 0) < 6000;
  setPill($('#pill-overlay'), fresh ? 'overlay: ao vivo' : 'overlay: sem sinal', fresh ? 'pill-on' : 'pill-off');
  if (!s) return;
  $('#snap-round').textContent = fmt.format(s.roundId || 0);
  const phase = $('#snap-phase');
  phase.textContent = (PHASES[s.phase] || s.phase || '–') + (s.paused ? ' (pausado)' : '');
  phase.className = `v ${s.phase === 'won' ? 'good' : s.phase === 'lost' ? 'bad' : s.paused ? 'warn' : ''}`;
  const dangerEl = $('#snap-danger');
  dangerEl.textContent = s.danger ? '⚠️ 1 bomba mata' : 'ok';
  dangerEl.className = `v ${s.danger ? 'bad' : 'good'}`;
  $('#snap-length').textContent = fmt.format(s.length || 0);
  $('#snap-apples').textContent = fmt.format(s.apples || 0);
  $('#snap-bombs').textContent = fmt.format(s.bombs || 0);
  $('#snap-progress').style.width = `${Math.round((s.progress || 0) * 100)}%`;
  const ago = Math.max(0, Math.round((Date.now() - (s.at || 0)) / 1000));
  $('#snap-updated').textContent = fresh
    ? `Tabuleiro ${Math.round((s.progress || 0) * 100)}% preenchido · atualizado há ${ago}s`
    : `Sem dados do overlay há ${ago}s — ele está aberto (aba ou OBS)?`;
}

function renderStats() {
  const s = state.stats;
  if (!s) return;
  $('#st-wins').textContent = fmt.format(s.wins);
  $('#st-losses').textContent = fmt.format(s.losses);
  $('#st-rounds').textContent = fmt.format(s.rounds);
  const streak = $('#st-streak');
  streak.textContent = s.currentStreak > 0 ? `+${s.currentStreak} vitórias` : s.currentStreak < 0 ? `${s.currentStreak} derrotas` : '0';
  streak.className = `v ${s.currentStreak > 0 ? 'good' : s.currentStreak < 0 ? 'bad' : ''}`;
  $('#st-best').textContent = fmt.format(s.bestWinStreak);

  const tbody = $('#tbl-history tbody');
  tbody.replaceChildren();
  if (!s.history?.length) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="7" class="muted">Nenhuma rodada registrada ainda.</td>';
    tbody.appendChild(tr);
    return;
  }
  for (const h of s.history.slice(0, 12)) {
    const tr = document.createElement('tr');
    const cells = [
      ['num', String(h.roundId)],
      ['', null],
      ['num', fmt.format(h.apples)],
      ['num', fmt.format(h.bombsEaten)],
      ['num', fmt.format(h.length)],
      ['num', formatDuration(h.durationMs)],
      ['', h.topGifter ? `${h.topGifter.nickname} (🪙 ${fmt.format(h.topGifter.coins)})` : '–'],
    ];
    cells.forEach(([cls, text], i) => {
      const td = document.createElement('td');
      if (cls) td.className = cls;
      if (i === 1) {
        const chip = document.createElement('span');
        chip.className = `chip ${h.result}`;
        chip.textContent = h.result === 'win' ? 'VITÓRIA' : 'DERROTA';
        td.appendChild(chip);
      } else td.textContent = text;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
}

function formatDuration(ms) {
  const s = Math.round((ms || 0) / 1000);
  const m = Math.floor(s / 60);
  return m ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

function renderLeaderboard() {
  const lb = state.leaderboard;
  const list = $('#lb-list');
  list.replaceChildren();
  $('#lb-scope').textContent = `Escopo: live atual${lb?.roomId ? ` (sala ${lb.roomId})` : ''}.`;
  if (!lb?.top?.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'Ninguém mandou presente ainda.';
    list.appendChild(li);
    return;
  }
  lb.top.forEach((g, i) => {
    const li = document.createElement('li');
    if (i === 0) li.className = 'first';
    const rank = document.createElement('span');
    rank.className = 'rank';
    rank.textContent = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : String(i + 1);
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.src = g.avatarUrl || '';
    img.onerror = () => {
      img.onerror = null;
      img.src = '';
    };
    const who = document.createElement('span');
    who.className = 'who';
    const b = document.createElement('b');
    b.textContent = g.nickname;
    const small = document.createElement('small');
    small.textContent = `@${g.uniqueId} · ${fmt.format(g.gifts)} presente(s)`;
    who.append(b, small);
    const coins = document.createElement('span');
    coins.className = 'coins';
    coins.textContent = `🪙 ${fmt.format(g.coins)}`;
    li.append(rank, img, who, coins);
    list.appendChild(li);
  });
}

function renderRules(rules) {
  state.rules = rules;
  const ta = $('#ta-rules');
  ta.value = JSON.stringify(rules, null, 2);
  ta.classList.remove('invalid');
  setRulesStatus(`${rules.gifts?.length ?? 0} regra(s) · modo "${rules.mode}"`, 'muted');
}

function setRulesStatus(text, cls = 'muted') {
  const el = $('#rules-status');
  el.textContent = text;
  el.className = `status-line ${cls}`;
}

/* ------------------------------------------------------------------------------------------------
 * WebSocket
 * ---------------------------------------------------------------------------------------------- */

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

function connectWs() {
  let ws;
  try {
    ws = new WebSocket(wsUrl());
  } catch (err) {
    scheduleWs();
    return;
  }
  state.ws = ws;
  ws.onopen = () => {
    state.connected = true;
    state.wsRetryMs = 1000;
    renderWs();
    ws.send(JSON.stringify({ type: 'identify', role: 'panel', ts: Date.now() }));
  };
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleMessage(msg);
  };
  ws.onclose = () => {
    state.connected = false;
    state.ws = null;
    renderWs();
    scheduleWs();
  };
  ws.onerror = () => {
    /* onclose follows */
  };
}

function scheduleWs() {
  setTimeout(connectWs, state.wsRetryMs);
  state.wsRetryMs = Math.min(10_000, state.wsRetryMs * 1.6);
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'hello':
      state.tiktok = msg.tiktok;
      state.stats = msg.stats;
      state.leaderboard = msg.leaderboard;
      if (msg.snapshot) state.snapshot = msg.snapshot;
      renderTiktok();
      renderStats();
      renderLeaderboard();
      renderSnapshot();
      if (msg.rules) renderRules(msg.rules);
      logLine('conectado ao servidor', 'sys');
      break;
    case 'tiktok_status':
      state.tiktok = { ...(state.tiktok || {}), ...msg };
      renderTiktok();
      logLine(`TikTok: ${STATUS_LABEL[msg.status] || msg.status}${msg.message ? ` — ${msg.message}` : ''}`, msg.status === 'error' ? 'err' : 'sys');
      break;
    case 'viewers':
      state.tiktok = { ...(state.tiktok || {}), viewers: msg.count };
      renderTiktok();
      break;
    case 'gift': {
      const r = msg.rule || {};
      logLine(
        `${r.team === 'hero' ? '😇' : '😈'} ${msg.user?.nickname}: ${msg.giftName} ×${msg.count} (total ${msg.repeatCount}${msg.streakEnd ? ', fim' : ''}) · 🪙 ${fmt.format(msg.coins)} · ${r.desc || `${r.bombs} bomba(s)`}${r.tier && r.tier !== 'normal' ? ' · ' + r.tier.toUpperCase() : ''}${r.show ? '' : ' · oculto'}`,
        'gift',
      );
      break;
    }
    case 'chat':
      logLine(`💬 ${msg.user?.nickname}: ${msg.text}`, 'chat');
      break;
    case 'like':
      logLine(`❤️ ${msg.user?.nickname} curtiu ×${msg.count}`, 'social');
      break;
    case 'follow':
      logLine(`➕ ${msg.user?.nickname} começou a seguir`, 'social');
      break;
    case 'share':
      logLine(`↗️ ${msg.user?.nickname} compartilhou`, 'social');
      break;
    case 'member':
      logLine(`🚪 ${msg.user?.nickname} entrou`, 'social');
      break;
    case 'stats':
      state.stats = msg;
      renderStats();
      logLine(`placar: ${msg.wins} × ${msg.losses}`, 'sys');
      break;
    case 'leaderboard':
      state.leaderboard = msg;
      renderLeaderboard();
      break;
    case 'rules':
      renderRules(msg);
      logLine('regras dos presentes atualizadas', 'sys');
      break;
    case 'snapshot':
      state.snapshot = { ...msg, at: Date.now() };
      renderSnapshot();
      break;
    case 'round_start':
      logLine(`rodada ${msg.roundId} começou`, 'sys');
      break;
    case 'command':
      logLine(`comando: ${msg.action}`, 'sys');
      break;
    default:
      break;
  }
}

/* ------------------------------------------------------------------------------------------------
 * UI wiring
 * ---------------------------------------------------------------------------------------------- */

function nickname() {
  const v = $('#in-nick').value.trim();
  return v || NICKS[Math.floor(Math.random() * NICKS.length)];
}

function sendGift({ giftName, giftId, diamondCount }) {
  const count = Math.max(1, Math.min(200, Number($('#in-count').value) || 1));
  const streak = $('#in-streak').checked;
  return post('/api/sim/gift', { nickname: nickname(), giftName, giftId: giftId || undefined, diamondCount, count, streak });
}

function wire() {
  // Overlay URL helpers
  const overlayUrl = `${location.origin}/?obs=1`;
  $('#link-overlay').href = overlayUrl;
  $('#btn-copy-url').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(overlayUrl);
      toast('URL do overlay copiada: ' + overlayUrl, 'success');
    } catch {
      window.prompt('Copie a URL do overlay:', overlayUrl);
    }
  });

  // TikTok
  $('#form-tiktok').addEventListener(
    'submit',
    busy($('#btn-connect'), async () => {
      const username = $('#in-username').value.trim().replace(/^@+/, '');
      if (!username) throw new Error('Informe o usuário do TikTok.');
      const keyField = $('#in-signkey');
      const rawKey = keyField ? keyField.value.trim() : '';
      const payload = { username };
      // Empty field = keep the saved key; the literal word "limpar" clears it.
      if (rawKey) payload.signApiKey = rawKey.toLowerCase() === 'limpar' ? '' : rawKey;
      const r = await post('/api/tiktok/connect', payload);
      if (keyField && rawKey) keyField.value = '';
      state.tiktok = r.tiktok;
      renderTiktok();
      toast(`Conectando a @${username}…`, 'info');
    }),
  );
  $('#btn-disconnect').addEventListener(
    'click',
    busy($('#btn-disconnect'), async () => {
      const r = await post('/api/tiktok/disconnect');
      state.tiktok = r.tiktok;
      renderTiktok();
      toast('Desconectado do TikTok.', 'info');
    }),
  );

  // Commands
  $$('[data-cmd]').forEach((btn) => {
    btn.addEventListener(
      'click',
      busy(btn, async () => {
        await post('/api/command', { action: btn.dataset.cmd });
      }),
    );
  });

  // Gifts
  $$('#gift-buttons .gift').forEach((btn) => {
    btn.addEventListener(
      'click',
      busy(btn, async () => {
        const r = await sendGift({ giftName: btn.dataset.gift, giftId: btn.dataset.id, diamondCount: Number(btn.dataset.coins) || 1 });
        if (r.streak) toast(`Sequência de ${r.units} × ${btn.dataset.gift} enviada.`, 'success');
      }),
    );
  });
  $('#btn-gift-custom').addEventListener(
    'click',
    busy($('#btn-gift-custom'), async () => {
      const giftName = $('#in-gift-name').value.trim();
      if (!giftName) throw new Error('Informe o nome do presente.');
      await sendGift({ giftName, giftId: $('#in-gift-id').value.trim(), diamondCount: Math.max(0, Number($('#in-gift-coins').value) || 0) });
    }),
  );

  // Social
  $('#form-chat').addEventListener(
    'submit',
    busy($('#form-chat button'), async () => {
      const text = $('#in-chat').value.trim() || 'Vai cobra! 🐍';
      await post('/api/sim/chat', { nickname: nickname(), text });
      $('#in-chat').value = '';
    }),
  );
  $('#btn-like').addEventListener('click', busy($('#btn-like'), () => post('/api/sim/like', { nickname: nickname(), count: Math.max(1, Number($('#in-likes').value) || 1) })));
  $('#btn-follow').addEventListener('click', busy($('#btn-follow'), () => post('/api/sim/follow', { nickname: nickname() })));
  $('#btn-share').addEventListener('click', busy($('#btn-share'), () => post('/api/sim/share', { nickname: nickname() })));
  $('#btn-member').addEventListener('click', busy($('#btn-member'), () => post('/api/sim/member', { nickname: nickname() })));
  $('#btn-viewers').addEventListener('click', busy($('#btn-viewers'), () => post('/api/sim/viewers', { count: Math.max(0, Number($('#in-viewers').value) || 0) })));

  // Stats / leaderboard
  $('#btn-stats-reset').addEventListener(
    'click',
    busy($('#btn-stats-reset'), async () => {
      if (!window.confirm('Zerar vitórias, derrotas e histórico? Isso não pode ser desfeito.')) return;
      await post('/api/stats/reset');
      toast('Placar zerado.', 'success');
    }),
  );
  $('#btn-lb-reset').addEventListener(
    'click',
    busy($('#btn-lb-reset'), async () => {
      if (!window.confirm('Zerar o ranking de presentes da live atual?')) return;
      await post('/api/leaderboard/reset');
      toast('Ranking zerado.', 'success');
    }),
  );

  // Rules editor
  const ta = $('#ta-rules');
  const parseEditor = () => {
    try {
      const parsed = JSON.parse(ta.value);
      ta.classList.remove('invalid');
      return parsed;
    } catch (err) {
      ta.classList.add('invalid');
      throw new Error(`JSON inválido: ${err.message}`);
    }
  };
  ta.addEventListener('input', () => {
    try {
      JSON.parse(ta.value);
      ta.classList.remove('invalid');
      setRulesStatus('Alterações não salvas.', 'warn');
    } catch (err) {
      ta.classList.add('invalid');
      setRulesStatus(`JSON inválido: ${err.message}`, 'err');
    }
  });
  $('#btn-rules-validate').addEventListener(
    'click',
    busy($('#btn-rules-validate'), async () => {
      const parsed = parseEditor();
      try {
        await post('/api/gifts/validate', parsed);
        setRulesStatus('Regras válidas ✔ (ainda não salvas).', 'ok');
      } catch (err) {
        if (err.errors?.length) {
          setRulesStatus(`Regras inválidas:\n• ${err.errors.join('\n• ')}`, 'err');
          return;
        }
        throw err;
      }
    }),
  );
  $('#btn-rules-save').addEventListener(
    'click',
    busy($('#btn-rules-save'), async () => {
      const parsed = parseEditor();
      try {
        const r = await api('PUT', '/api/gifts', parsed);
        renderRules(r.rules);
        setRulesStatus('Regras salvas e aplicadas ✔', 'ok');
        toast('Regras dos presentes salvas.', 'success');
      } catch (err) {
        if (err.errors?.length) {
          setRulesStatus(`Regras inválidas:\n• ${err.errors.join('\n• ')}`, 'err');
          return;
        }
        throw err;
      }
    }),
  );
  $('#btn-rules-reload').addEventListener(
    'click',
    busy($('#btn-rules-reload'), async () => {
      renderRules(await api('GET', '/api/gifts'));
      toast('Regras recarregadas do servidor.', 'info');
    }),
  );
  $('#btn-rules-default').addEventListener(
    'click',
    busy($('#btn-rules-default'), async () => {
      const def = await api('GET', '/api/gifts/default');
      ta.value = JSON.stringify(def, null, 2);
      ta.classList.remove('invalid');
      setRulesStatus('Padrão carregado no editor — clique em "Salvar e aplicar" para usar.', 'warn');
    }),
  );
  $('#btn-rules-example').addEventListener('click', () => {
    ta.value = $('#rules-example').textContent.trim() + '\n';
    ta.classList.remove('invalid');
    setRulesStatus('Exemplo carregado no editor — ajuste e clique em "Salvar e aplicar".', 'warn');
  });

  // Log
  $('#chk-log-pause').addEventListener('change', (ev) => {
    state.logPaused = ev.target.checked;
  });
  $('#btn-log-clear').addEventListener('click', () => $('#log').replaceChildren());
}

/* ------------------------------------------------------------------------------------------------
 * Boot
 * ---------------------------------------------------------------------------------------------- */

async function boot() {
  wire();
  renderWs();
  renderTiktok();
  connectWs();
  // Initial pull over HTTP (in case the WS takes a moment or is blocked).
  try {
    const st = await api('GET', '/api/status');
    state.tiktok = st.tiktok;
    state.stats = st.stats;
    state.leaderboard = st.leaderboard;
    if (st.snapshot) state.snapshot = st.snapshot;
    if (st.settings?.username && !$('#in-username').value) $('#in-username').value = st.settings.username;
    renderTiktok();
    renderStats();
    renderLeaderboard();
    renderSnapshot();
  } catch (err) {
    toast(err.message, 'error');
  }
  try {
    renderRules(await api('GET', '/api/gifts'));
  } catch (err) {
    setRulesStatus(`Não foi possível carregar as regras: ${err.message}`, 'err');
  }
  setInterval(renderSnapshot, 1000);
}

boot();
