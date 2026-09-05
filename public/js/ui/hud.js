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
// [compacto] Mínimo de vitórias seguidas para o selo 🔥 aparecer. Abaixo disso não é notícia.
const STREAK_BADGE_MIN = 2;

// [live-real] STATUS_TEXT (AO VIVO / conectando… / aguardando live / erro / desconectado) foi
// removido junto com a pill que o exibia. O texto do estado da conexão continua existindo onde
// serve para alguma coisa: no /painel do streamer (public/js/painel.js).

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
  // [live-real] O placar ganhou banda própria (topo do bloco principal, 11 % da altura); a barra de
  // status e o progresso continuam em #hud-score, logo abaixo do duelo e do carrossel.
  const bandScoreboard = ensure(root, 'hud-scoreboard', 'section', 'band band-scoreboard');
  const bandScore = ensure(root, 'hud-score', 'section', 'band band-score');
  const bandBoard = ensure(root, 'hud-board', 'section', 'band band-board');
  const bandLeader = ensure(root, 'hud-leader', 'section', 'band band-leader');
  const bandChat = ensure(root, 'hud-chat', 'section', 'band band-chat');
  const confettiLayer = ensure(root, 'hud-confetti', 'div', 'confetti hidden');

  // Top band --------------------------------------------------------------------------------
  // [live-real] AS PILLS FORAM REMOVIDAS NA ORIGEM (2026-09-05). Elas já não entravam no DOM sem
  // ?debug=1, mas o cliente foi literal ao ver a live: "esses coração, isso de ao vivo, online,
  // desconectado, olhinho, 8.0 — tira, pô. Só coisa inútil". Um modo de depuração que ressuscita
  // exatamente o que o dono do produto mandou tirar é uma armadilha: basta alguém abrir o overlay
  // com ?debug=1 na OBS e o lixo volta ao ar na live. Então some o construtor inteiro —
  // pill do status do TikTok (AO VIVO / desconectado), 👁 espectadores, ❤️ curtidas e o pill
  // online/offline do WebSocket.
  //
  // O que sobrevive: o BURST de coraçõezinhos (`likeBurst`), que é animação, não número — ele
  // mostra que a live está quente sem pedir para ninguém ler nada. E os métodos públicos
  // setViewers / setTiktokStatus / setConnection continuam existindo como no-ops documentados
  // (main.js os chama a cada mensagem do socket); quem precisa desses números é o /painel do
  // streamer, que lê os mesmos dados direto do servidor.
  clear(bandTop);
  const likeBurst = el('div', 'like-burst like-burst-free');

  // Score band ------------------------------------------------------------------------------
  // [compacto] VITÓRIAS × DERROTAS é a narrativa da live e continua sendo o maior número da tela.
  // O bloco SEQUÊNCIA (−2 · recorde 1) e os chips ✓✗✗ saíram: é estatística de nicho, que só o
  // streamer acompanha, e ocupava a metade direita da faixa mais nobre. O que sobra da ideia
  // vira um selo único e só quando é comemorável — uma sequência de vitórias (🔥 N seguidas).
  clear(bandScoreboard);
  clear(bandScore);
  const scoreboard = el('div', 'glass scoreboard');
  const colWin = el('div', 'score-col win');
  const winsNum = el('span', 'num big', '0');
  colWin.append(el('span', 'lbl', 'VITÓRIAS'), winsNum);
  const colLoss = el('div', 'score-col loss');
  const lossNum = el('span', 'num big', '0');
  colLoss.append(el('span', 'lbl', 'DERROTAS'), lossNum);
  const streakEl = el('div', 'streak-badge hidden');
  scoreboard.append(colWin, el('div', 'score-x', '✕'), colLoss, streakEl);
  bandScoreboard.append(scoreboard);

  const statusRow = el('div', 'glass status-row');
  const mkStat = (ico, cls, initial, titleTxt) => {
    const w = el('div', 'stat-mini');
    w.title = titleTxt;
    const n = el('b', 'num ' + cls, initial);
    w.append(el('span', 'stat-ico', ico), n);
    return [w, n];
  };
  // [compacto] De cinco números miúdos para DOIS grandes. Sobrevivem os que contam a história do
  // jogo em 2 s e que os presentes mexem: o TAMANHO da cobra (é a vida dela — bombas encolhem e
  // ela morre no zero) e as BOMBAS no tabuleiro (é o efeito visível do presente de vilão).
  // Saíram: ⚡ velocidade e ⏱ tempo (não mudam nada para quem assiste, ninguém manda presente por
  // causa deles) e 🍎 maçãs, que vira a barra de progresso logo abaixo — era o mesmo dado contado
  // duas vezes. Os nós continuam existindo para update() escrever sem checagem extra.
  const [lenW, lenNum] = mkStat('🐍', 'length', '3', 'Tamanho (vida da cobra)');
  const [bombsW, bombsNum] = mkStat('💣', 'bombs', '0', 'Bombas no tabuleiro');
  // O escudo é TRANSITÓRIO: só aparece enquanto está ativo. É o recibo visível de um presente de
  // herói ("mandei Galáxia → a cobra ficou protegida"), então ganha destaque enquanto dura.
  const [shieldW, shieldNum] = mkStat('🛡️', 'shield', '0s', 'Escudo ativo');
  shieldW.classList.add('shield', 'hidden');
  // [live-real] ⚡ VELOCIDADE REMOVIDA NA ORIGEM. O cliente citou "8.0" pelo nome na lista do que
  // é "coisa inútil". Ele tem razão pelo critério que vale aqui: ninguém manda presente por causa
  // da velocidade, e nenhum presente do catálogo a mostra como efeito (o gelo e o relógio já se
  // anunciam por toast e pela animação da cobra). O nó saiu de vez — não há mais `speedNum`, e
  // update() deixou de escrever nele.
  // 🍎 maçãs e ⏱ tempo continuam existindo fora da tela: são a MESMA informação que a barra de
  // progresso e o painel de fim de rodada já contam, mas os nós ainda recebem update() sem
  // custo perceptível e servem de ponto de reenxerto se algum dia voltarem.
  const [, applesNum] = mkStat('🍎', 'apples', '0', 'Maçãs');
  const [, timerNum] = mkStat('⏱', 'timer', '0:00', 'Tempo da rodada');
  // [live real 2026-09-04] 🐍 tamanho e 💣 bombas SAÍRAM da tela a pedido do cliente: a barra
  // ocupava uma faixa inteira acima do tabuleiro para mostrar dois números que o próprio jogo
  // já conta melhor — o tamanho se vê na cobra, as bombas se veem no tabuleiro.
  // O 🛡️ escudo FICA, porque é o único que não dá para ver olhando o jogo e é o recibo visível
  // de um presente de herói; ele já nasce escondido e só aparece enquanto dura.
  statusRow.append(shieldW);

  // [compacto] A barra fica; o texto "Rodada 1 · 5 % do tabuleiro" era abstrato ("5 % de quê?").
  // Vira uma frase concreta e emocional: quantas maçãs ainda faltam para a VITÓRIA.
  const progress = el('div', 'progress');
  progress.setAttribute('role', 'progressbar');
  const progressFill = el('div', 'progress-fill');
  // [live real] O cliente pediu para tirar a porcentagem E a frase "Faltam N para a VITÓRIA":
  // numa live ninguém lê número em movimento, o avanço se percebe pela barra enchendo. Menos
  // uma linha de texto = mais espaço para o duelo e a tabela de presentes, que é o que converte.
  // O nó continua existindo (oculto por CSS) porque setText() abaixo ainda o alimenta e ele
  // serve de leitura acessível do progresso.
  const progressText = el('div', 'progress-text', 'Encha o tabuleiro para vencer!');
  progress.append(progressFill, progressText);
  // [live-real] O placar mudou de banda (subiu para #hud-scoreboard, no topo do bloco principal);
  // #hud-score fica com a linha de status e o progresso, que ocupam a parte de baixo do bloco.
  // [live real] A BARRA DE PROGRESSO também saiu: sem o texto dentro dela (removido antes), virou
  // um risco fino atravessando a frente do tabuleiro. O progresso já se lê na própria cobra
  // crescendo — que é a leitura mais direta possível. Os nós continuam existindo (update() ainda
  // os alimenta), só não são anexados à tela.
  bandScore.append(statusRow);

  // Board band (transient only) -------------------------------------------------------------
  clear(bandBoard);
  const giftSlot = el('div', 'gift-slot');
  const toasts = el('div', 'toasts');
  const countdownOv = el('div', 'overlay countdown hidden');
  const roundEndOv = el('div', 'overlay roundend hidden');
  bandBoard.append(giftSlot, toasts, countdownOv, roundEndOv);
  // [compacto] O contador ❤️ saiu com as pills, mas a chuva de coraçõezinhos continua: é
  // decoração viva (mostra que a live está quente), não informação para ler. É anexada DEPOIS do
  // clear(bandBoard) acima, senão nasceria e morreria no mesmo tick.
  bandBoard.appendChild(likeBurst);

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
  // [compacto] "DUELO DESTA RODADA · zera a cada rodada" tinha 39 caracteres em 11px — a menor
  // e mais ilegível linha da tela, explicando uma regra que ninguém precisa saber para jogar
  // junto. Fica só o rótulo curto, que agora cabe num tamanho legível.
  // [compacto] Rótulo removido da tela: 'VILÕES x HERÓIS' logo acima já identifica o painel.
  // O nó permanece (oculto por CSS) porque setText() abaixo ainda o alimenta e ele serve de
  // documentação viva do escopo (rodada x live) para quem for depurar.
  const battleScope = el('div', 'battle-scope', 'DUELO DA RODADA');
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
  // [celular] battleCols FICA FORA DA TELA. Ele mostrava o maior doador de cada time — a MESMA
  // informação que o cartão RANKING DA LIVE já mostra logo abaixo, com o nome maior (30 px).
  // Medido: a faixa de monetização tem 7 % da altura (72–79 %, limite do TikTok — ver --zone-money),
  // o duelo pedia 6,85 % e o cartão de metas 5,26 %: 12 % em 7 %, e os dois se sobrepunham na tela.
  // Como manda a regra do cliente ("menos elementos, cada um maior"), quem sai é a duplicata:
  // battleCols custava 2,6 % de altura para repetir dois nomes. Sem ele o duelo cabe em ~4,25 %.
  // As listas continuam existindo e sendo preenchidas (setLeaderboard escreve nelas sem `if`
  // extra); apenas não são anexadas ao cartão, então nada é desenhado.
  battleBox.append(battleHead, battleScope, tug);

  // Legacy overall top-3 (only shown when the payload has no team data — old servers).
  const legacyBox = el('div', 'glass leaderboard hidden');
  const lbTitle = el('div', 'lb-title');
  lbTitle.append(el('span', 'lb-ico', '🏆'), el('span', null, 'TOP PRESENTES'));
  const lbList = el('ol', 'lb-list');
  legacyBox.append(lbTitle, lbList);

  // [compacto] A legenda "🌹 bomba · 🎮 GG comida · 🦢 limpa · 🌌 escudo" era a informação MAIS
  // valiosa da tela (é ela que ensina o público a converter presente em efeito) e estava em
  // 13px, ilegível — quatro itens espremidos numa linha só. A ideia não morre: ela migrou para
  // o carrossel de metas (goals.js, cartão "COMO JOGAR"), onde vira UMA dica por vez, com ícone
  // grande e a frase "🌹 Rosa = 1 bomba na cobra". Mesma informação, uma de cada vez, legível.
  bandLeader.append(battleBox, legacyBox);

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
    // [compacto] "Rodada 1 · 5 % do tabuleiro" virou um alvo concreto. A cobra vence quando o
    // corpo dela enche o tabuleiro (progress = length / cells), então o que falta é exatamente
    // quanto ela ainda precisa CRESCER — o mesmo dado, dito de um jeito que dá vontade de
    // ajudar ("faltam 227 para a vitória" pede comida; "5 % do tabuleiro" não pede nada).
    const cells = Number(snap.cells) || 0;
    const grown = Number(snap.length ?? (snap.snake ? snap.snake.length : 0)) || 0;
    const left = cells > 0 ? Math.max(0, cells - grown) : 0;
    setText(progressText, 'ptext', left > 0
      ? `Faltam ${fmt(left)} para a VITÓRIA!`
      : 'Encha o tabuleiro para vencer!');
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
    // [compacto] Sequência: de bloco permanente ("SEQUÊNCIA −2 · recorde 1" + 5 chips ✓✗) para
    // um selo único que só existe quando há algo a comemorar — 2 ou mais vitórias seguidas.
    // Sequência negativa não vira selo: dizer ao público que a cobra está perdendo há 2 rodadas
    // não faz ninguém mandar presente, só reforça derrota. O recorde e o histórico saíram de vez
    // (é dado de streamer; o /painel continua com os números completos).
    const s = Number(stats.currentStreak) || 0;
    const streakTxt = s >= STREAK_BADGE_MIN ? `🔥 ${fmt(s)} seguidas` : '';
    if (cache.streak !== streakTxt) {
      cache.streak = streakTxt;
      streakEl.textContent = streakTxt;
      streakEl.classList.toggle('hidden', !streakTxt);
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
      // [compacto] "seja o primeiro vilão!" gastava uma linha inteira para dizer "vazio", nos
      // dois lados. Um traço marca o lugar sem competir com o que tem conteúdo de verdade.
      listEl.appendChild(el('li', 'team-empty', '—'));
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
    // [compacto] Só o líder de cada time: 6 nomes miúdos viraram 1 grande e legível por lado.
    // Montar mais linhas custaria carregar avatares que nunca seriam pintados.
    const vTop = Array.isArray(battle?.villain?.top) ? battle.villain.top.slice(0, 1) : [];
    const hTop = Array.isArray(battle?.hero?.top) ? battle.hero.top.slice(0, 1) : [];
    // [compacto] Rótulo curto: cabe legível e não gasta a linha explicando uma regra interna.
    const scopeTxt = perRound ? 'DUELO DA RODADA' : 'DUELO DA LIVE';
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
    // [live-real] O TOTAL de curtidas (❤️ 8.4 mil) saiu da tela com as pills — é vaidade de
    // streamer, não informação de jogo. O que fica é a chuva de coraçõezinhos: pura animação,
    // ninguém precisa ler, e ela é a prova visual de que a live está viva.
    const count = Math.max(1, Number(like?.count) || 1);
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
  // [celular] O texto é truncado AQUI, no único ponto por onde todos os toasts passam, e não em
  // cada chamador. Medido na rajada: "✨ <apelido> limpou as bombas!" com um apelido longo (o
  // TikTok permite nomes bem compridos) esticava o toast até 110 % da largura do palco e o texto
  // era cortado pelo #safe { overflow: hidden }. Havia chamadores em main.js interpolando
  // `ev.user.nickname` cru; cortar na origem protege também qualquer chamador futuro.
  const TOAST_MAX_CHARS = 64;
  function showToast(text, kind = 'info') {
    const k = KIND_ICON[kind] ? kind : 'info';
    const t = el('div', 'toast ' + k);
    t.append(el('span', 'toast-ico', KIND_ICON[k]), el('span', 'toast-text', truncate(String(text ?? ''), TOAST_MAX_CHARS)));
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
    // [compacto] Era uma frase de 62 caracteres numa tela que dura 3 s. Encurtada para caber
    // grande e ser lida de relance — é a deixa de "manda presente" para quem acabou de chegar.
    const cdHint = el('div', 'cd-hint', '🎁 Mande presentes e mude o jogo!');
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
    // [compacto] O painel de fim de rodada é uma tela cheia por poucos segundos, então ele pode
    // ser mais generoso — mas 4 células viravam 8 textos miúdos. Ficam as duas que resumem a
    // rodada: o tamanho que a cobra alcançou e quantas bombas ela comeu. Maçãs (= tamanho) e
    // tempo saíram pelo mesmo motivo de sempre: não mudam nada para quem assiste.
    grid.append(
      cell('🐍', 'tamanho', fmt(summary?.length ?? 0)),
      cell('💣', 'bombas', fmt(summary?.bombsEaten ?? 0))
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
  // [live-real] TELEMETRIA DO STREAMER — os três setters abaixo são NO-OPS deliberados.
  // 👁 espectadores, o status do TikTok (AO VIVO / conectando / desconectado) e o online/offline do
  // WebSocket saíram da tela por pedido literal do cliente: nada disso ajuda o público a entender
  // o jogo nem a mandar presente, e "desconectado" numa live só assusta quem está assistindo.
  // Os métodos ficam porque main.js os chama a cada mensagem do socket (bindNet) e apagar as
  // chamadas seria mexer num arquivo que não é meu — e porque um dia a informação pode voltar num
  // lugar melhor. Quem realmente precisa desses números é o /painel do streamer, que os lê do
  // servidor sem passar por aqui.
  /** No-op: espectadores não aparecem no overlay do público. Ver /painel. */
  function setViewers() { /* intencionalmente vazio */ }

  /** No-op: o status da conexão com o TikTok é telemetria do streamer. Ver /painel. */
  function setTiktokStatus() { /* intencionalmente vazio */ }

  /** No-op: a saúde do WebSocket é telemetria do streamer. Ver /painel. */
  function setConnection() { /* intencionalmente vazio */ }

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
