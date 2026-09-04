// public/js/ui/hud.js
// HUD / UI controller for the overlay (SPEC §8). All user-facing text in pt-BR.
//
// createHud(root, { obs, formatNumber }) → Hud
//
// The HUD builds its own DOM inside `root` (band containers with fixed ids are reused when the
// host page already provides them, e.g. index.html's skeleton). User-provided strings are always
// inserted with textContent (never innerHTML) to avoid markup injection from chat/gift names.

const GIFT_CARD_MS = 4000;
const GIFT_CARD_MEGA_MS = 5200;
const GIFT_CARD_SUPREME_MS = 6500;
const CHAT_MAX = 5;
const CHAT_FADE_MS = 12000;
const TOAST_MS = 3600;
const TOAST_MAX = 4;
const LIKE_MIN_GAP_MS = 100; // ≤ 10/s
const FLASH_MS = 480;
const HISTORY_CHIPS = 5;

const STATUS_TEXT = {
  connected: 'AO VIVO',
  connecting: 'conectando…',
  waiting_live: 'aguardando live',
  error: 'erro',
  disconnected: 'desconectado'
};

const KIND_ICON = { info: 'ℹ️', warn: '⚠️', error: '⛔', success: '✅' };

const AVATAR_COLORS = ['#22d3ee', '#fbbf24', '#fb7185', '#34d399', '#a78bfa', '#f472b6', '#60a5fa', '#f97316'];

// ---- small DOM helpers ---------------------------------------------------------------------

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

function ensure(parent, id, tag, className) {
  let n = parent.querySelector('#' + id) || document.getElementById(id);
  if (!n) {
    n = document.createElement(tag);
    n.id = id;
    parent.appendChild(n);
  }
  if (className) for (const c of className.split(' ')) n.classList.add(c);
  return n;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function truncate(s, max = 14) {
  const str = String(s ?? '');
  const chars = Array.from(str);
  return chars.length > max ? chars.slice(0, max).join('') + '…' : str;
}

function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  const a = parts[0]?.[0] || '?';
  const b = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (a + b).toUpperCase();
}

function hashColor(key) {
  let h = 0;
  const s = String(key || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

/** Circular avatar: <img> with an initials fallback (also used when the URL is null or fails). */
function avatarNode(user, className = 'avatar') {
  const wrap = el('div', className);
  const nick = user?.nickname || user?.uniqueId || '?';
  const fallback = el('span', 'avatar-initials', initials(nick));
  fallback.style.background = hashColor(user?.userId || nick);
  wrap.appendChild(fallback);
  if (user?.avatarUrl) {
    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.onload = () => { wrap.classList.add('has-img'); };
    img.onerror = () => { img.remove(); wrap.classList.remove('has-img'); };
    img.src = user.avatarUrl;
    wrap.appendChild(img);
  }
  return wrap;
}

function formatTime(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const defaultFormatNumber = (() => {
  let fmt = null;
  try { fmt = new Intl.NumberFormat('pt-BR'); } catch { fmt = null; }
  return (n) => (fmt ? fmt.format(Number(n) || 0) : String(Math.round(Number(n) || 0)));
})();

/** pt-BR compact totals for the battle bar, e.g. 1234 → "1,2 mil". */
const fmtCompact = (() => {
  let fmt = null;
  try { fmt = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 }); } catch { fmt = null; }
  return (n) => {
    const v = Math.max(0, Number(n) || 0);
    return fmt ? fmt.format(v) : String(Math.round(v));
  };
})();

// ---- gift rule helpers (v2: team/tier/effects, tolerant to the old {bombs, effect} shape) ----

const TEAM_BADGE = { villain: 'VILÃO', hero: 'HERÓI' };

function giftTeam(rule) {
  if (rule?.team === 'villain' || rule?.team === 'hero') return rule.team;
  const fx = rule?.effects || {};
  if ((Number(fx.bombs) || Number(rule?.bombs) || 0) > 0 || (Number(fx.attack) || 0) > 0) return 'villain';
  if ((Number(fx.food) || 0) > 0 || (Number(fx.grow) || 0) > 0 || fx.clearBombs || (Number(fx.shieldSec) || 0) > 0) return 'hero';
  return null;
}

function giftTier(rule) {
  if (rule?.tier === 'supreme' || rule?.tier === 'mega' || rule?.tier === 'normal') return rule.tier;
  return rule?.effect === 'mega' ? 'mega' : 'normal';
}

/** pt-BR effect line derived from rule.effects (fallback when rule.desc is missing). */
function effectsDesc(effects) {
  if (!effects || typeof effects !== 'object') return null;
  const n = (v) => Math.max(0, Number(v) || 0);
  const p = [];
  if (n(effects.bombs) > 0) p.push(`💣 ${n(effects.bombs)} bomba${n(effects.bombs) === 1 ? '' : 's'}`);
  if (n(effects.attack) > 0) p.push(`⚔️ morde −${n(effects.attack)}`);
  if (n(effects.food) > 0) p.push(`🍎 +${n(effects.food)} comida${n(effects.food) === 1 ? '' : 's'} dourada${n(effects.food) === 1 ? '' : 's'}`);
  if (n(effects.grow) > 0) p.push(`🐍 cresce +${n(effects.grow)}`);
  if (effects.clearBombs) p.push('🧹 limpa as bombas');
  if (n(effects.shieldSec) > 0) p.push(`🛡️ escudo ${n(effects.shieldSec)} s`);
  return p.length ? p.join(' · ') : null;
}

// ---- HUD -------------------------------------------------------------------------------------

/**
 * @param {HTMLElement} root
 * @param {{obs?: boolean, formatNumber?: (n:number)=>string}} [opts]
 */
export function createHud(root, opts = {}) {
  if (!root) throw new Error('createHud: root element required');
  const obs = !!opts.obs;
  const fmt = typeof opts.formatNumber === 'function' ? opts.formatNumber : defaultFormatNumber;

  document.body.classList.toggle('obs', obs);
  root.classList.add('hud');

  // ---- build skeleton (reuse existing containers when present) ----
  const bandTop = ensure(root, 'hud-top', 'header', 'band band-top');
  const bandScore = ensure(root, 'hud-score', 'section', 'band band-score');
  const bandBoard = ensure(root, 'hud-board', 'section', 'band band-board');
  const bandLeader = ensure(root, 'hud-leader', 'section', 'band band-leader');
  const bandChat = ensure(root, 'hud-chat', 'section', 'band band-chat');
  const confettiLayer = ensure(root, 'hud-confetti', 'div', 'confetti hidden');

  // Top band --------------------------------------------------------------------------------
  clear(bandTop);
  const titleWrap = el('div', 'title-wrap');
  const title = el('div', 'title');
  title.append(el('span', 'title-main', 'COBRA 3D'), el('span', 'title-dot', '·'), el('span', 'title-live', 'AO VIVO'));
  titleWrap.appendChild(title);
  const pills = el('div', 'pills');
  const pillTiktok = el('div', 'pill pill-tiktok');
  pillTiktok.dataset.status = 'disconnected';
  const pillDot = el('span', 'pill-dot');
  const pillText = el('span', 'pill-text', STATUS_TEXT.disconnected);
  pillTiktok.append(pillDot, pillText);
  const pillViewers = el('div', 'pill pill-viewers');
  const viewersNum = el('b', 'num', '0');
  pillViewers.append(el('span', 'pill-ico', '👁'), viewersNum);
  const pillLikes = el('div', 'pill pill-likes');
  const likesNum = el('b', 'num', '0');
  const likeBurst = el('div', 'like-burst');
  pillLikes.append(el('span', 'pill-ico', '❤️'), likesNum, likeBurst);
  const pillWs = el('div', 'pill pill-ws');
  pillWs.title = 'Conexão com o servidor';
  pillWs.append(el('span', 'pill-dot'), el('span', 'pill-text', 'offline'));
  pills.append(pillTiktok, pillViewers, pillLikes, pillWs);
  bandTop.append(titleWrap, pills);

  // Score band ------------------------------------------------------------------------------
  clear(bandScore);
  const scoreboard = el('div', 'glass scoreboard');
  const colWin = el('div', 'score-col win');
  const winsNum = el('span', 'num big', '0');
  colWin.append(el('span', 'lbl', 'VITÓRIAS'), winsNum);
  const colLoss = el('div', 'score-col loss');
  const lossNum = el('span', 'num big', '0');
  colLoss.append(el('span', 'lbl', 'DERROTAS'), lossNum);
  const scoreSide = el('div', 'score-side');
  const streakEl = el('div', 'streak');
  const streakLbl = el('span', 'lbl', 'SEQUÊNCIA');
  const streakNum = el('b', 'num', '0');
  streakEl.append(streakLbl, streakNum);
  const historyEl = el('div', 'history');
  scoreSide.append(streakEl, historyEl);
  scoreboard.append(colWin, el('div', 'score-x', '✕'), colLoss, scoreSide);

  const statusRow = el('div', 'glass status-row');
  const mkStat = (ico, cls, initial, titleTxt) => {
    const w = el('div', 'stat-mini');
    w.title = titleTxt;
    const n = el('b', 'num ' + cls, initial);
    w.append(el('span', 'stat-ico', ico), n);
    return [w, n];
  };
  // The snake's length IS its life: bombs shrink it and it dies when the size runs out,
  // so the length stat doubles as the "life bar" (red + pulsing while in danger).
  const [lenW, lenNum] = mkStat('🐍', 'length', '3', 'Tamanho (vida da cobra)');
  const [applesW, applesNum] = mkStat('🍎', 'apples', '0', 'Maçãs');
  const [bombsW, bombsNum] = mkStat('💣', 'bombs', '0', 'Bombas no tabuleiro');
  const [shieldW, shieldNum] = mkStat('🛡️', 'shield', '0s', 'Escudo ativo');
  shieldW.classList.add('shield', 'hidden');
  const [speedW, speedNum] = mkStat('⚡', 'speed', '0', 'Velocidade (casas/s)');
  const [timerW, timerNum] = mkStat('⏱', 'timer', '0:00', 'Tempo da rodada');
  statusRow.append(lenW, applesW, bombsW, shieldW, speedW, timerW);

  const progress = el('div', 'progress');
  progress.setAttribute('role', 'progressbar');
  const progressFill = el('div', 'progress-fill');
  const progressText = el('div', 'progress-text', 'Rodada 1 · 0 % do tabuleiro');
  progress.append(progressFill, progressText);
  bandScore.append(scoreboard, statusRow, progress);

  // Board band (transient only) -------------------------------------------------------------
  clear(bandBoard);
  const giftSlot = el('div', 'gift-slot');
  const toasts = el('div', 'toasts');
  const countdownOv = el('div', 'overlay countdown hidden');
  const roundEndOv = el('div', 'overlay roundend hidden');
  bandBoard.append(giftSlot, toasts, countdownOv, roundEndOv);

  // Leader band: VILÕES × HERÓIS battle (leaderboard v2) -------------------------------------
  clear(bandLeader);
  const battleBox = el('div', 'glass battle');
  const battleHead = el('div', 'battle-head');
  const headVs = el('div', 'battle-vs', 'VS');
  battleHead.append(
    el('div', 'battle-team villain', '😈 VILÕES'),
    headVs,
    el('div', 'battle-team hero', 'HERÓIS 😇')
  );
  // [persist] Deixa explícito na tela QUAL ranking é este: o duelo é DA RODADA e zera a cada
  // rodada nova; o ranking da LIVE (moedas totais) vive na seção de metas.
  const battleScope = el('div', 'battle-scope', 'DUELO DESTA RODADA · zera a cada rodada');
  const tug = el('div', 'tug');
  const tugVillain = el('div', 'tug-fill villain');
  const tugHero = el('div', 'tug-fill hero');
  const tugSeam = el('div', 'tug-seam');
  const tugTotalV = el('span', 'tug-total villain num', '🪙 0');
  const tugTotalH = el('span', 'tug-total hero num', '0 🪙');
  tug.append(tugVillain, tugHero, tugSeam, tugTotalV, tugTotalH);
  const battleCols = el('div', 'battle-cols');
  const colVillain = el('ul', 'team-col villain');
  const colHero = el('ul', 'team-col hero');
  battleCols.append(colVillain, colHero);
  battleBox.append(battleHead, battleScope, tug, battleCols);

  // Legacy overall top-3 (only shown when the payload has no team data — old servers).
  const legacyBox = el('div', 'glass leaderboard hidden');
  const lbTitle = el('div', 'lb-title');
  lbTitle.append(el('span', 'lb-ico', '🏆'), el('span', null, 'TOP PRESENTES'));
  const lbList = el('ol', 'lb-list');
  legacyBox.append(lbTitle, lbList);

  // Compact gift legend (replaces the old CTA line).
  const legend = el('div', 'legend');
  [['🌹', 'bomba 😈'], ['🎮', 'GG comida 😇'], ['🦢', 'limpa'], ['🌌', 'escudo']].forEach(([ico, txt], i) => {
    if (i) legend.appendChild(el('span', 'legend-dot', '·'));
    const item = el('span', 'legend-item');
    item.append(el('span', 'legend-ico', ico), el('span', null, txt));
    legend.appendChild(item);
  });
  bandLeader.append(battleBox, legacyBox, legend);

  // Chat band -------------------------------------------------------------------------------
  clear(bandChat);
  const chatFeed = el('ul', 'chat-feed');
  bandChat.append(chatFeed);

  // ---- state ------------------------------------------------------------------------------
  const timers = new Set();
  const setT = (fn, ms) => {
    const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
    timers.add(id);
    return id;
  };
  const clearT = (id) => { if (id) { clearTimeout(id); timers.delete(id); } };

  const cache = {}; // last rendered values to avoid useless DOM writes
  let likesTotal = 0;
  let lastLikeAt = 0;
  let flashTimer = null;

  function setText(node, key, value) {
    if (cache[key] === value) return;
    cache[key] = value;
    node.textContent = value;
  }

  // ---- update(snapshot) -----------------------------------------------------------------
  function update(snap) {
    if (!snap) return;
    const danger = snap.danger === true;
    if (cache.danger !== danger) {
      cache.danger = danger;
      lenW.classList.toggle('danger', danger);
    }
    setText(applesNum, 'apples', fmt(snap.apples ?? 0));
    const bombCount = Array.isArray(snap.bombs) ? snap.bombs.length : Number(snap.bombs ?? 0);
    const queued = Number(snap.bombQueue ?? 0);
    setText(bombsNum, 'bombs', queued > 0 ? `${fmt(bombCount)}+${fmt(queued)}` : fmt(bombCount));
    setText(lenNum, 'length', fmt(snap.length ?? (snap.snake ? snap.snake.length : 0)));
    setText(speedNum, 'speed', (Number(snap.speed) || 0).toFixed(1));
    let dur = Number(snap.durationMs);
    if (!Number.isFinite(dur)) {
      const end = snap.endedAt || Date.now();
      dur = snap.startedAt ? end - snap.startedAt : 0;
    }
    setText(timerNum, 'timer', formatTime(dur));
    // Shield pill: '🛡️ Ns' while snapshot.shieldLeft > 0 (integer seconds, hides at 0).
    const shieldSec = Math.max(0, Math.ceil(Number(snap.shieldLeft) || 0));
    if (cache.shieldSec !== shieldSec) {
      cache.shieldSec = shieldSec;
      shieldW.classList.toggle('hidden', shieldSec === 0);
      if (shieldSec > 0) shieldNum.textContent = `${shieldSec}s`;
    }
    const pct = Math.max(0, Math.min(100, Math.round((Number(snap.progress) || 0) * 100)));
    if (cache.pct !== pct) {
      cache.pct = pct;
      progressFill.style.width = pct + '%';
    }
    const round = Number(snap.roundId) || 1;
    setText(progressText, 'ptext', `Rodada ${fmt(round)} · ${pct} % do tabuleiro`);
    const phase = snap.phase || 'playing';
    if (cache.phase !== phase) {
      cache.phase = phase;
      root.dataset.phase = phase;
    }
  }

  // ---- setStats -----------------------------------------------------------------------
  let lastStats = null;
  function setStats(stats) {
    if (!stats) return;
    lastStats = stats;
    setText(winsNum, 'wins', fmt(stats.wins ?? 0));
    setText(lossNum, 'losses', fmt(stats.losses ?? 0));
    const s = Number(stats.currentStreak) || 0;
    const best = Number(stats.bestWinStreak) || 0;
    let txt = s > 0 ? `+${s} 🔥` : s < 0 ? `${s}` : '0';
    if (best > 0) txt += ` · recorde ${best}`;
    setText(streakNum, 'streak', txt);
    streakEl.classList.toggle('pos', s > 0);
    streakEl.classList.toggle('neg', s < 0);
    const hist = Array.isArray(stats.history) ? stats.history.slice(0, HISTORY_CHIPS).reverse() : [];
    const key = hist.map((h) => (h.result === 'win' ? 'W' : 'L')).join('');
    if (cache.hist !== key) {
      cache.hist = key;
      clear(historyEl);
      if (!hist.length) historyEl.appendChild(el('span', 'chip empty', '—'));
      for (const h of hist) {
        const win = h.result === 'win';
        const chip = el('span', 'chip ' + (win ? 'win' : 'loss'), win ? '✓' : '✗');
        chip.title = win ? 'Vitória' : 'Derrota';
        historyEl.appendChild(chip);
      }
    }
    // Keep the round-end panel's scoreboard line fresh if it is visible.
    if (roundEndScoreLine) roundEndScoreLine.textContent = scoreLineText(stats);
  }

  function scoreLineText(stats) {
    if (!stats) return '';
    return `VITÓRIAS ${fmt(stats.wins ?? 0)} ✕ DERROTAS ${fmt(stats.losses ?? 0)}`;
  }

  // ---- setLeaderboard (v2: VILÕES × HERÓIS battle; legacy shape still renders) ---------
  // [persist] Sempre prefere as moedas do TIME; o fallback para `coins` só vale no escopo da
  // live (numa lista da rodada, `coins` já é o total da rodada daquele gifter).
  function teamCoinsOf(g, team) {
    const own = Number(team === 'villain' ? g?.villainCoins : g?.heroCoins);
    return Number.isFinite(own) && own > 0 ? own : Number(g?.coins) || 0;
  }

  function renderTeamCol(listEl, top, team) {
    clear(listEl);
    if (!top.length) {
      listEl.appendChild(el('li', 'team-empty', team === 'villain' ? 'seja o primeiro vilão!' : 'seja o primeiro herói!'));
      return;
    }
    top.forEach((g, i) => {
      const li = el('li', 'team-row rank-' + (i + 1));
      const av = avatarNode(g, 'avatar team-avatar');
      if (i === 0) {
        const wrap = el('span', 'crown-wrap');
        wrap.append(av, el('span', 'crown', '👑'));
        li.appendChild(wrap);
      } else {
        li.appendChild(av);
      }
      li.append(
        el('span', 'team-nick', truncate(g.nickname || g.uniqueId || '?', 11)),
        el('span', 'team-coins num', `🪙 ${fmtCompact(teamCoinsOf(g, team))}`)
      );
      listEl.appendChild(li);
    });
  }

  function setLeaderboard(lb) {
    // Old servers send { top } without teams → keep rendering the overall top-3 gracefully.
    const hasTeams = !!(lb && lb.teams && (lb.teams.villain || lb.teams.hero));
    const legacy = !hasTeams && !!(lb && Array.isArray(lb.top) && lb.top.length);
    battleBox.classList.toggle('hidden', legacy);
    legacyBox.classList.toggle('hidden', !legacy);

    if (legacy) {
      const top = lb.top.slice(0, 3);
      const key = 'legacy|' + top.map((g) => `${g.userId}:${g.coins}:${g.avatarUrl || ''}`).join('|');
      if (cache.lb === key) return;
      cache.lb = key;
      clear(lbList);
      top.forEach((g, i) => {
        const li = el('li', 'lb-item rank-' + (i + 1));
        li.append(
          el('span', 'lb-rank', i === 0 ? '👑' : String(i + 1)),
          avatarNode(g, 'avatar lb-avatar'),
          el('span', 'lb-name', truncate(g.nickname || g.uniqueId || '?', 14)),
          el('span', 'lb-coins num', `🪙 ${fmt(g.coins ?? 0)}`)
        );
        lbList.appendChild(li);
      });
      return;
    }

    // [persist] A barra de cabo de guerra é o duelo DA RODADA (`lb.round`), que zera a cada
    // rodada nova. Servidores antigos não mandam `round` → cai no acumulado da live, como antes.
    const battle = lb?.round && (lb.round.villain || lb.round.hero) ? lb.round : lb?.teams;
    const perRound = battle === lb?.round;
    const vCoins = Math.max(0, Number(battle?.villain?.coins) || 0);
    const hCoins = Math.max(0, Number(battle?.hero?.coins) || 0);
    const vTop = Array.isArray(battle?.villain?.top) ? battle.villain.top.slice(0, 3) : [];
    const hTop = Array.isArray(battle?.hero?.top) ? battle.hero.top.slice(0, 3) : [];
    const scopeTxt = perRound ? 'DUELO DESTA RODADA · zera a cada rodada' : 'DUELO DA LIVE';
    setText(battleScope, 'scope', scopeTxt);
    const sig = (g) => `${g.userId}:${g.villainCoins ?? ''}:${g.heroCoins ?? ''}:${g.coins}:${g.avatarUrl || ''}`;
    const key = `battle|${perRound ? lb?.round?.roundId ?? '' : 'live'}|${vCoins}|${hCoins}|${vTop.map(sig).join(',')}|${hTop.map(sig).join(',')}`;
    if (cache.lb === key) return;
    cache.lb = key;

    // Tug of war: proportional fill, 50/50 when nobody scored; extremes clamped so both
    // colors (and the totals sitting on them) stay visible. Width animates via CSS.
    const total = vCoins + hCoins;
    const pct = total > 0 ? Math.max(8, Math.min(92, (vCoins / total) * 100)) : 50;
    tugVillain.style.width = pct + '%';
    tugHero.style.width = (100 - pct) + '%';
    tugSeam.style.left = pct + '%';
    tugTotalV.textContent = `🪙 ${fmtCompact(vCoins)}`;
    tugTotalH.textContent = `${fmtCompact(hCoins)} 🪙`;
    tug.classList.toggle('lead-villain', vCoins > hCoins);
    tug.classList.toggle('lead-hero', hCoins > vCoins);
    renderTeamCol(colVillain, vTop, 'villain');
    renderTeamCol(colHero, hTop, 'hero');
  }

  // ---- gift cards (queue, ≤1 visible, streak updates in place) ---------------------------
  const giftQueue = [];
  let giftCurrent = null; // { key, node, countNode, timer, ev }
  const giftKey = (ev) => `${ev?.user?.userId ?? ev?.user?.uniqueId ?? '?'}|${ev?.giftId ?? ev?.giftName ?? '?'}`;
  const giftUnits = (ev) => Math.max(1, Number(ev.repeatCount) || Number(ev.count) || 1);

  function buildGiftCard(ev) {
    const rule = ev?.rule || {};
    const team = giftTeam(rule);
    const tier = giftTier(rule);
    let cls = 'gift-card tier-' + tier;
    if (team) cls += ' team-' + team;
    const card = el('div', cls);
    card.appendChild(avatarNode(ev.user, 'avatar gift-avatar'));
    const body = el('div', 'gift-body');
    const who = el('div', 'gift-who');
    who.appendChild(el('span', 'gift-nick', truncate(ev.user?.nickname || ev.user?.uniqueId || 'Alguém', 14)));
    if (team) who.appendChild(el('span', 'team-badge ' + team, TEAM_BADGE[team]));
    const coinsNode = el('span', 'gift-coins num');
    const what = el('div', 'gift-what');
    what.append(el('span', null, 'enviou '), el('b', 'gift-name', ev.giftName || 'um presente'), coinsNode);
    const bombs = Number(rule.bombs) || 0;
    const effectTxt = (typeof rule.desc === 'string' && rule.desc) || effectsDesc(rule.effects)
      || (bombs > 0 ? `💣 ${fmt(bombs)} bomba${bombs === 1 ? '' : 's'}` : '🎁 obrigado!');
    body.append(who, what, el('div', 'gift-effect', effectTxt));
    card.appendChild(body);
    const right = el('div', 'gift-right');
    const imgWrap = el('div', 'gift-img');
    if (ev.giftImageUrl) {
      const img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.onerror = () => { img.remove(); imgWrap.textContent = '🎁'; };
      img.src = ev.giftImageUrl;
      imgWrap.appendChild(img);
    } else {
      imgWrap.textContent = tier === 'supreme' ? '🌌' : tier === 'mega' ? '✨' : '🎁';
    }
    const countNode = el('div', 'gift-count num', `×${fmt(giftUnits(ev))}`);
    right.append(imgWrap, countNode);
    card.appendChild(right);
    if (tier === 'supreme') {
      for (let i = 1; i <= 3; i++) card.appendChild(el('span', 'gift-spark s' + i, '✨'));
    }
    return { card, countNode, coinsNode };
  }

  function updateGiftCoins(entry) {
    if (!entry.coinsNode) return;
    const coins = (Number(entry.ev?.diamondCount) || 0) * giftUnits(entry.ev);
    entry.coinsNode.textContent = coins > 0 ? ` · 🪙 ${fmt(coins)}` : '';
  }

  function updateGiftCard(entry, ev) {
    const units = giftUnits(ev);
    entry.ev = { ...entry.ev, ...ev, repeatCount: Math.max(giftUnits(entry.ev), units) };
    if (entry.countNode) {
      entry.countNode.textContent = `×${fmt(giftUnits(entry.ev))}`;
      entry.countNode.classList.remove('bump');
      void entry.countNode.offsetWidth;
      entry.countNode.classList.add('bump');
    }
    updateGiftCoins(entry);
  }

  function showNextGift() {
    if (giftCurrent || !giftQueue.length) return;
    const entry = giftQueue.shift();
    const { card, countNode, coinsNode } = buildGiftCard(entry.ev);
    entry.node = card;
    entry.countNode = countNode;
    entry.coinsNode = coinsNode;
    updateGiftCoins(entry);
    giftSlot.appendChild(card);
    giftCurrent = entry;
    armGiftTimer(entry);
  }

  function armGiftTimer(entry) {
    clearT(entry.timer);
    const tier = giftTier(entry.ev?.rule);
    const ms = tier === 'supreme' ? GIFT_CARD_SUPREME_MS : tier === 'mega' ? GIFT_CARD_MEGA_MS : GIFT_CARD_MS;
    entry.timer = setT(() => hideGift(entry), ms);
  }

  function hideGift(entry) {
    if (giftCurrent !== entry) return;
    const node = entry.node;
    node.classList.add('out');
    giftCurrent = null;
    setT(() => { node.remove(); }, 450);
    setT(showNextGift, 120);
  }

  function showGift(ev) {
    if (!ev || typeof ev !== 'object') return;
    const key = giftKey(ev);
    if (giftCurrent && giftCurrent.key === key) {
      updateGiftCard(giftCurrent, ev);
      armGiftTimer(giftCurrent);
      return;
    }
    const queued = giftQueue.find((q) => q.key === key);
    if (queued) {
      queued.ev = { ...queued.ev, ...ev, repeatCount: Math.max(giftUnits(queued.ev), giftUnits(ev)) };
      return;
    }
    if (Number(ev.count) === 0 && ev.streakEnd) return; // closes an already shown streak: nothing new to show
    giftQueue.push({ key, ev, node: null, timer: null });
    if (giftQueue.length > 12) giftQueue.splice(0, giftQueue.length - 12);
    showNextGift();
  }

  // ---- chat feed ----------------------------------------------------------------------
  function pushChat(msg) {
    if (!msg) return;
    const li = el('li', 'chat-item');
    li.append(
      avatarNode(msg.user, 'avatar chat-avatar'),
      el('span', 'chat-name', truncate(msg.user?.nickname || msg.user?.uniqueId || '?', 14)),
      el('span', 'chat-text', truncate(msg.text || '', 90))
    );
    chatFeed.appendChild(li);
    while (chatFeed.children.length > CHAT_MAX) chatFeed.removeChild(chatFeed.firstChild);
    setT(() => {
      li.classList.add('fade');
      setT(() => li.remove(), 700);
    }, CHAT_FADE_MS);
  }

  // ---- likes --------------------------------------------------------------------------
  function showLike(like) {
    const count = Math.max(1, Number(like?.count) || 1);
    if (Number.isFinite(Number(like?.total)) && Number(like.total) > 0) likesTotal = Number(like.total);
    else likesTotal += count;
    setText(likesNum, 'likes', fmt(likesTotal));
    const now = performance.now();
    if (now - lastLikeAt < LIKE_MIN_GAP_MS) return;
    lastLikeAt = now;
    const n = Math.min(3, Math.ceil(count / 10));
    for (let i = 0; i < n; i++) {
      const h = el('span', 'like-heart', '❤');
      h.style.left = `${20 + Math.random() * 60}%`;
      h.style.setProperty('--dx', `${(Math.random() * 2 - 1) * 1.5}rem`);
      h.style.animationDelay = `${i * 90}ms`;
      h.style.fontSize = `${0.8 + Math.random() * 0.5}rem`;
      h.addEventListener('animationend', () => h.remove(), { once: true });
      likeBurst.appendChild(h);
    }
    while (likeBurst.children.length > 24) likeBurst.removeChild(likeBurst.firstChild);
  }

  // ---- toasts -------------------------------------------------------------------------
  function showToast(text, kind = 'info') {
    const k = KIND_ICON[kind] ? kind : 'info';
    const t = el('div', 'toast ' + k);
    t.append(el('span', 'toast-ico', KIND_ICON[k]), el('span', 'toast-text', String(text ?? '')));
    toasts.appendChild(t);
    while (toasts.children.length > TOAST_MAX) toasts.removeChild(toasts.firstChild);
    setT(() => {
      t.classList.add('out');
      setT(() => t.remove(), 400);
    }, TOAST_MS);
    return t;
  }

  function showSocial(kind, user) {
    const nick = truncate(user?.nickname || user?.uniqueId || 'Alguém', 16);
    const text = kind === 'follow' ? `${nick} começou a seguir! 💙`
      : kind === 'share' ? `${nick} compartilhou a live! 🔁`
        : `${nick} entrou na live 👋`;
    const t = el('div', 'toast social ' + kind);
    t.append(avatarNode(user, 'avatar toast-avatar'), el('span', 'toast-text', text));
    toasts.appendChild(t);
    while (toasts.children.length > TOAST_MAX) toasts.removeChild(toasts.firstChild);
    setT(() => {
      t.classList.add('out');
      setT(() => t.remove(), 400);
    }, TOAST_MS);
  }

  // ---- countdown ----------------------------------------------------------------------
  let countdownCancel = null;
  /**
   * "RODADA n" + 3-2-1. Resolves after `seconds`. A new call (or hideOverlays) cancels the
   * previous one, resolving its promise immediately.
   * @param {number} roundId
   * @param {number} seconds
   * @param {{onTick?: (n:number)=>void}} [o]  optional per-second callback (main.js plays 'tick')
   */
  function showCountdown(roundId, seconds, o = {}) {
    if (countdownCancel) countdownCancel();
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    clear(countdownOv);
    const box = el('div', 'cd-box');
    const cdTitle = el('div', 'cd-title', `RODADA ${fmt(roundId || 1)}`);
    const cdNum = el('div', 'cd-num num', total > 0 ? String(total) : 'VAI!');
    const cdHint = el('div', 'cd-hint', 'A cobra vai jogar sozinha — mande presentes para soltar bombas! 💣');
    box.append(cdTitle, cdNum, cdHint);
    countdownOv.appendChild(box);
    countdownOv.classList.remove('hidden');
    root.dataset.overlay = 'countdown';

    return new Promise((resolve) => {
      let n = total;
      let timer = null;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearT(timer);
        countdownCancel = null;
        countdownOv.classList.add('hidden');
        clear(countdownOv);
        if (root.dataset.overlay === 'countdown') delete root.dataset.overlay;
        resolve();
      };
      countdownCancel = finish;
      const tick = () => {
        if (done) return;
        if (n > 0) {
          try { o.onTick?.(n); } catch { /* ignore */ }
          cdNum.textContent = String(n);
          cdNum.classList.remove('pop');
          void cdNum.offsetWidth;
          cdNum.classList.add('pop');
          n -= 1;
          timer = setT(tick, 1000);
        } else {
          cdNum.textContent = 'VAI!';
          cdNum.classList.remove('pop');
          void cdNum.offsetWidth;
          cdNum.classList.add('pop', 'go');
          timer = setT(finish, total > 0 ? 450 : 350);
        }
      };
      tick();
    });
  }

  // ---- round end ----------------------------------------------------------------------
  let roundEndCancel = null;
  let roundEndScoreLine = null;

  function spawnConfetti(count = 70) {
    clear(confettiLayer);
    const colors = ['#fbbf24', '#22d3ee', '#fb7185', '#34d399', '#a78bfa', '#ffffff'];
    for (let i = 0; i < count; i++) {
      const p = el('i', 'confetti-piece');
      p.style.left = `${Math.random() * 100}%`;
      p.style.background = colors[i % colors.length];
      p.style.animationDelay = `${Math.random() * 1.8}s`;
      p.style.animationDuration = `${2.6 + Math.random() * 1.8}s`;
      p.style.setProperty('--rot', `${Math.random() * 720 - 360}deg`);
      p.style.setProperty('--sx', `${Math.random() * 2 - 1}`);
      p.style.width = `${0.35 + Math.random() * 0.4}rem`;
      p.style.height = `${0.5 + Math.random() * 0.6}rem`;
      confettiLayer.appendChild(p);
    }
    confettiLayer.classList.remove('hidden');
  }

  function hideConfetti() {
    confettiLayer.classList.add('hidden');
    clear(confettiLayer);
  }

  /**
   * WIN/LOSS panel with confetti (CSS) + next-round timer. Resolves after `nextInSec`.
   * @param {{result:'win'|'loss', apples, bombsEaten, length, durationMs, roundId}} summary
   * @param {number} nextInSec
   * @param {object} [stats]
   */
  function showRoundEnd(summary, nextInSec, stats) {
    if (roundEndCancel) roundEndCancel();
    if (countdownCancel) countdownCancel();
    const win = summary?.result === 'win';
    const secs = Math.max(0, Math.round(Number(nextInSec) || 0));
    if (stats) lastStats = stats;

    clear(roundEndOv);
    roundEndOv.classList.toggle('win', win);
    roundEndOv.classList.toggle('loss', !win);
    const box = el('div', 're-box');
    const big = el('div', 're-title', win ? 'VITÓRIA!' : 'DERROTA');
    const sub = el('div', 're-sub', win
      ? '🏆 A cobra preencheu o tabuleiro inteiro!'
      : '💥 Bombas demais… a cobra perdeu todo o tamanho.');
    const grid = el('div', 're-grid');
    const cell = (ico, label, value) => {
      const c = el('div', 're-cell');
      c.append(el('span', 're-ico', ico), el('b', 're-val num', value), el('span', 're-lbl', label));
      return c;
    };
    grid.append(
      cell('🍎', 'maçãs', fmt(summary?.apples ?? 0)),
      cell('💣', 'bombas', fmt(summary?.bombsEaten ?? 0)),
      cell('🐍', 'tamanho', fmt(summary?.length ?? 0)),
      cell('⏱', 'tempo', formatTime(summary?.durationMs ?? 0))
    );
    roundEndScoreLine = el('div', 're-score num', scoreLineText(lastStats));
    const next = el('div', 're-next');
    const nextNum = el('b', 'num', String(secs));
    next.append(el('span', null, 'Próxima rodada em '), nextNum, el('span', null, 's'));
    box.append(big, sub, grid, roundEndScoreLine, next);
    roundEndOv.appendChild(box);
    roundEndOv.classList.remove('hidden');
    root.dataset.overlay = 'roundend';
    if (win) spawnConfetti();
    else hideConfetti();

    return new Promise((resolve) => {
      let n = secs;
      let timer = null;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearT(timer);
        roundEndCancel = null;
        roundEndScoreLine = null;
        roundEndOv.classList.add('hidden');
        clear(roundEndOv);
        hideConfetti();
        if (root.dataset.overlay === 'roundend') delete root.dataset.overlay;
        resolve();
      };
      roundEndCancel = finish;
      const tick = () => {
        if (done) return;
        if (n <= 0) { finish(); return; }
        nextNum.textContent = String(n);
        n -= 1;
        timer = setT(tick, 1000);
      };
      tick();
    });
  }

  /** Cancel any countdown / round-end overlay (e.g. panel "nova rodada"). */
  function hideOverlays() {
    if (countdownCancel) countdownCancel();
    if (roundEndCancel) roundEndCancel();
  }

  // ---- misc ---------------------------------------------------------------------------
  function setViewers(n) {
    setText(viewersNum, 'viewers', fmt(Math.max(0, Number(n) || 0)));
  }

  function setTiktokStatus(status) {
    const st = STATUS_TEXT[status?.status] ? status.status : 'disconnected';
    pillTiktok.dataset.status = st;
    let txt = STATUS_TEXT[st];
    if (st === 'connected' && status?.username) txt = `AO VIVO @${status.username}`;
    else if (st === 'waiting_live' && status?.username) txt = `aguardando @${status.username}`;
    else if (st === 'error' && status?.message) txt = `erro: ${truncate(status.message, 28)}`;
    setText(pillText, 'tt', txt);
    pillTiktok.title = status?.message || '';
    if (Number.isFinite(Number(status?.viewers))) setViewers(status.viewers);
  }

  function setConnection(online) {
    const on = !!online;
    pillWs.classList.toggle('on', on);
    pillWs.classList.toggle('off', !on);
    pillWs.querySelector('.pill-text').textContent = on ? 'online' : 'offline';
  }

  function flash(kind = 'red') {
    const k = ['red', 'gold', 'green'].includes(kind) ? kind : 'red';
    const cls = 'flash-' + k;
    document.body.classList.remove('flash-red', 'flash-gold', 'flash-green');
    void document.body.offsetWidth;
    document.body.classList.add(cls);
    clearT(flashTimer);
    flashTimer = setT(() => document.body.classList.remove(cls), FLASH_MS);
  }

  function setVisible(v) {
    root.classList.toggle('hud-hidden', !v);
  }

  function toggle() {
    setVisible(root.classList.contains('hud-hidden'));
  }

  function destroy() {
    for (const id of timers) clearTimeout(id);
    timers.clear();
    giftQueue.length = 0;
    giftCurrent = null;
    document.body.classList.remove('flash-red', 'flash-gold', 'flash-green');
  }

  setConnection(false);
  setLeaderboard(null);

  return {
    update, setStats, setLeaderboard, showGift, pushChat, showLike, showSocial, showToast,
    showCountdown, showRoundEnd, setViewers, setTiktokStatus, setConnection, flash,
    hideOverlays, setVisible, toggle, destroy,
    get root() { return root; }
  };
}
