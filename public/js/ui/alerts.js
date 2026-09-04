// public/js/ui/alerts.js
// Fila ÚNICA de alertas de engajamento do overlay (entradas, seguidores, compartilhamentos e
// presentes campeões). Todo texto é pt-BR e todo conteúdo vindo do TikTok entra por textContent.
//
// createAlerts(container, opts) → Alerts
//
// Regras de ouro:
//  * NUNCA mais de um alerta visível por vez (fila com prioridade), então nada empilha.
//  * Alertas comuns vivem num canto (fora do centro do tabuleiro).
//  * Só o alerta CAMPEÃO (presente mega/supremo) ocupa a faixa inteira, e ainda assim evita o
//    miolo vertical do tabuleiro (ele é ancorado no topo da faixa).
//  * Entradas de público têm limite de taxa e agrupamento ("👋 +12 pessoas chegaram").

const PRIORITY = { champion: 4, follow: 3, share: 2, member: 1 };

const MEMBER_RATE_MS = 2000;      // no máximo 1 alerta de entrada a cada 2 s
const MEMBER_BATCH_MS = 2600;     // janela de agrupamento das entradas
const QUEUE_MAX = 8;              // acima disso, os de menor prioridade são descartados

const DURATION = {
  member: 2500,
  share: 2800,
  follow: 3200,
  champion: 4000
};

const OUT_MS = 420;               // deve casar com a animação .out do CSS

const AVATAR_COLORS = ['#22d3ee', '#fbbf24', '#fb7185', '#34d399', '#a78bfa', '#f472b6', '#60a5fa', '#f97316'];

// ---- helpers de DOM -------------------------------------------------------------------------

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

function truncate(s, max = 16) {
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

/** Avatar circular com fallback de iniciais (mesma convenção do hud.js). */
function avatarNode(user, className = 'al-avatar') {
  const wrap = el('div', className);
  const nick = user?.nickname || user?.uniqueId || '?';
  const fallback = el('span', 'al-initials', initials(nick));
  fallback.style.background = hashColor(user?.userId || nick);
  wrap.appendChild(fallback);
  if (user?.avatarUrl) {
    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.onload = () => wrap.classList.add('has-img');
    img.onerror = () => { img.remove(); wrap.classList.remove('has-img'); };
    img.src = user.avatarUrl;
    wrap.appendChild(img);
  }
  return wrap;
}

const nickOf = (user, max = 16) => truncate(user?.nickname || user?.uniqueId || 'Alguém', max);

const defaultFormatNumber = (() => {
  let fmt = null;
  try { fmt = new Intl.NumberFormat('pt-BR'); } catch { fmt = null; }
  return (n) => (fmt ? fmt.format(Number(n) || 0) : String(Math.round(Number(n) || 0)));
})();

/** Linha curta de efeito em pt-BR, a partir de rule.desc ou rule.effects. */
function effectLine(rule) {
  if (typeof rule?.desc === 'string' && rule.desc) return rule.desc;
  const fx = rule?.effects;
  if (!fx || typeof fx !== 'object') return '';
  const n = (v) => Math.max(0, Number(v) || 0);
  const p = [];
  if (n(fx.bombs) > 0) p.push(`💣 ${n(fx.bombs)} bomba${n(fx.bombs) === 1 ? '' : 's'}`);
  if (n(fx.attack) > 0) p.push(`⚔️ morde −${n(fx.attack)}`);
  if (n(fx.food) > 0) p.push(`🍎 +${n(fx.food)} comida${n(fx.food) === 1 ? '' : 's'}`);
  if (n(fx.grow) > 0) p.push(`🐍 cresce +${n(fx.grow)}`);
  if (fx.clearBombs) p.push('🧹 limpa as bombas');
  if (n(fx.shieldSec) > 0) p.push(`🛡️ escudo ${n(fx.shieldSec)} s`);
  return p.join(' · ');
}

// ---- Alerts ----------------------------------------------------------------------------------

/**
 * @param {HTMLElement} container  faixa onde os alertas vivem (ex.: #hud-board)
 * @param {{formatNumber?: (n:number)=>string, obs?: boolean, onChampion?: (ev:object)=>void}} [opts]
 */
export function createAlerts(container, opts = {}) {
  if (!container) throw new Error('createAlerts: container element required');
  const fmt = typeof opts.formatNumber === 'function' ? opts.formatNumber : defaultFormatNumber;
  const onChampion = typeof opts.onChampion === 'function' ? opts.onChampion : null;

  const layer = el('div', 'alerts-layer');
  const slot = el('div', 'alert-slot');          // alertas discretos (canto)
  const champSlot = el('div', 'champ-slot');     // alerta campeão (faixa larga, ancorado no topo)
  layer.append(champSlot, slot);
  container.appendChild(layer);

  const timers = new Set();
  const setT = (fn, ms) => {
    const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
    timers.add(id);
    return id;
  };
  const clearT = (id) => { if (id) { clearTimeout(id); timers.delete(id); } };

  /** @type {Array<{kind:string, priority:number, build:()=>HTMLElement, champion?:boolean}>} */
  const queue = [];
  let current = null;      // { node, timer, champion }
  let destroyed = false;

  // agrupamento de entradas
  let memberBatch = { count: 0, first: null, timer: 0 };
  let lastMemberAlertAt = 0;

  // ---- fila -------------------------------------------------------------------------------

  function enqueue(item) {
    if (destroyed) return;
    queue.push(item);
    // Estoura o limite: descarta os de MENOR prioridade (os mais antigos primeiro),
    // para que um presente campeão nunca perca a vez por causa de entradas de público.
    while (queue.length > QUEUE_MAX) {
      let worst = 0;
      for (let i = 1; i < queue.length; i++) {
        if (queue[i].priority < queue[worst].priority) worst = i;
      }
      queue.splice(worst, 1);
    }
    pump();
  }

  function pump() {
    if (destroyed || current || !queue.length) return;
    // Maior prioridade primeiro; empate resolve por ordem de chegada (índice).
    let best = 0;
    for (let i = 1; i < queue.length; i++) {
      if (queue[i].priority > queue[best].priority) best = i;
    }
    const item = queue.splice(best, 1)[0];
    let node = null;
    try {
      node = item.build();
    } catch (err) {
      console.warn('[alerts] falha ao montar alerta', err);
      pump();
      return;
    }
    if (!node) { pump(); return; }
    (item.champion ? champSlot : slot).appendChild(node);
    current = { node, timer: 0, champion: !!item.champion };
    const entry = current;
    entry.timer = setT(() => dismiss(entry), DURATION[item.kind] ?? 2600);
  }

  function dismiss(entry) {
    if (current !== entry) return;
    clearT(entry.timer);
    const node = entry.node;
    node.classList.add('out');
    // `current` só é liberado DEPOIS que o nó sai do DOM: enquanto a animação de saída roda,
    // o próximo alerta continua na fila. Sem isso, o card que sai e o que entra aparecem
    // juntos por ~0,4 s — que é exatamente o empilhamento que não pode acontecer.
    setT(() => {
      node.remove();
      if (current === entry) {
        current = null;
        pump();
      }
    }, OUT_MS);
  }

  // ---- construtores de alerta -------------------------------------------------------------

  function buildSimple(kind, user, text) {
    const card = el('div', `alert alert-${kind}`);
    card.appendChild(avatarNode(user));
    const body = el('div', 'alert-body');
    body.appendChild(el('span', 'alert-text', text));
    card.appendChild(body);
    return card;
  }

  function buildMemberBatch(count, user) {
    const card = el('div', 'alert alert-member');
    if (count <= 1) {
      card.appendChild(avatarNode(user));
      const body = el('div', 'alert-body');
      body.appendChild(el('span', 'alert-text', `👋 ${nickOf(user)} chegou!`));
      card.appendChild(body);
      return card;
    }
    const ico = el('div', 'al-avatar al-avatar-group');
    ico.appendChild(el('span', 'al-initials', '👋'));
    card.appendChild(ico);
    const body = el('div', 'alert-body');
    body.appendChild(el('span', 'alert-text', `👋 +${fmt(count)} pessoas chegaram`));
    card.appendChild(body);
    return card;
  }

  function buildChampion(ev, tier) {
    const card = el('div', `alert champ tier-${tier}`);
    const glow = el('div', 'champ-glow');
    card.appendChild(glow);
    const head = el('div', 'champ-head', tier === 'supreme' ? '👑 PRESENTE SUPREMO!' : '🔥 PRESENTÃO!');
    card.appendChild(head);

    const row = el('div', 'champ-row');
    row.appendChild(avatarNode(ev.user, 'al-avatar champ-avatar'));

    const mid = el('div', 'champ-mid');
    mid.appendChild(el('div', 'champ-nick', nickOf(ev.user, 18)));
    const what = el('div', 'champ-what');
    what.append(el('span', null, 'mandou '), el('b', 'champ-gift', truncate(ev.giftName || 'um presentão', 20)));
    const units = Math.max(1, Number(ev.repeatCount) || Number(ev.count) || 1);
    if (units > 1) what.appendChild(el('span', 'champ-units num', ` ×${fmt(units)}`));
    mid.appendChild(what);
    const desc = effectLine(ev.rule);
    if (desc) mid.appendChild(el('div', 'champ-effect', desc));
    row.appendChild(mid);

    const right = el('div', 'champ-img');
    if (ev.giftImageUrl) {
      const img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.onerror = () => { img.remove(); right.textContent = tier === 'supreme' ? '🌌' : '✨'; };
      img.src = ev.giftImageUrl;
      right.appendChild(img);
    } else {
      right.textContent = tier === 'supreme' ? '🌌' : '✨';
    }
    row.appendChild(right);
    card.appendChild(row);

    const coins = Math.max(0, Number(ev.coins) || (Number(ev.diamondCount) || 0) * units);
    if (coins > 0) card.appendChild(el('div', 'champ-coins num', `🪙 ${fmt(coins)} moedas`));
    return card;
  }

  // ---- API pública ------------------------------------------------------------------------

  /** Esvazia o lote acumulado de entradas num único alerta ("Fulano chegou" ou "+N pessoas"). */
  function flushMembers() {
    clearT(memberBatch.timer);
    const { count, first } = memberBatch;
    memberBatch = { count: 0, first: null, timer: 0 };
    if (count <= 0) return;
    lastMemberAlertAt = performance.now();
    enqueue({
      kind: 'member',
      priority: PRIORITY.member,
      build: () => buildMemberBatch(count, first)
    });
  }

  /**
   * Entrada de público: limitada e agrupada para nunca virar spam.
   * Primeira pessoa depois de um intervalo de calmaria aparece na hora ("👋 Fulano chegou!");
   * a partir daí abre-se uma janela de coleta e TODO mundo que chegar nela vira um alerta só
   * ("👋 +12 pessoas chegaram"), respeitando o limite de 1 alerta a cada MEMBER_RATE_MS.
   */
  function member(user) {
    if (destroyed) return;
    memberBatch.count += 1;
    if (!memberBatch.first) memberBatch.first = user || null;

    if (memberBatch.timer) return; // janela de coleta já aberta: esta pessoa entra no lote

    const since = performance.now() - lastMemberAlertAt;
    if (since >= MEMBER_RATE_MS) {
      // Calmaria: mostra esta pessoa imediatamente e abre a janela para as próximas.
      flushMembers();
      memberBatch.timer = setT(flushMembers, MEMBER_BATCH_MS);
      return;
    }
    // Alerta recente demais: segura o lote até completar o intervalo mínimo.
    memberBatch.timer = setT(flushMembers, Math.max(MEMBER_RATE_MS - since, MEMBER_BATCH_MS));
  }

  function follow(user) {
    if (destroyed) return;
    enqueue({
      kind: 'follow',
      priority: PRIORITY.follow,
      build: () => buildSimple('follow', user, `💜 ${nickOf(user)} seguiu!`)
    });
  }

  function share(user) {
    if (destroyed) return;
    enqueue({
      kind: 'share',
      priority: PRIORITY.share,
      build: () => buildSimple('share', user, `🔁 ${nickOf(user)} compartilhou!`)
    });
  }

  /**
   * Presente. Só dispara alerta para tier mega/supremo (o card normal já é feito pelo HUD),
   * porque é o presentão que faz o resto do público querer imitar.
   * @returns {boolean} true quando um alerta campeão foi enfileirado
   */
  function gift(ev) {
    if (destroyed || !ev || typeof ev !== 'object') return false;
    const rule = ev.rule || {};
    const tier = rule.tier === 'supreme' ? 'supreme'
      : (rule.tier === 'mega' || rule.effect === 'mega') ? 'mega' : 'normal';
    if (tier === 'normal') return false;
    if (Number(ev.count) === 0 && ev.streakEnd) return false; // fecha um streak já mostrado
    enqueue({
      kind: 'champion',
      priority: PRIORITY.champion,
      champion: true,
      build: () => buildChampion(ev, tier)
    });
    if (onChampion) { try { onChampion(ev); } catch { /* callback do host nunca derruba o alerta */ } }
    return true;
  }

  function setVisible(v) {
    layer.classList.toggle('alerts-hidden', !v);
  }

  function clearAll() {
    queue.length = 0;
    if (current) {
      clearT(current.timer);
      current.node.remove();
      current = null;
    }
    clearT(memberBatch.timer);
    memberBatch = { count: 0, first: null, timer: 0 };
  }

  function destroy() {
    destroyed = true;
    clearAll();
    for (const id of timers) clearTimeout(id);
    timers.clear();
    layer.remove();
  }

  return {
    member, follow, share, gift,
    setVisible, clearAll, destroy,
    get pending() { return queue.length + (current ? 1 : 0); },
    get root() { return layer; }
  };
}
