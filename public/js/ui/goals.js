// public/js/ui/goals.js
// Seção de MONETIZAÇÃO do overlay: carrossel automático (o streamer não clica em nada) entre
// META DA RODADA, RANKING DO DIA, CHAMADA À AÇÃO e DUELO VILÕES × HERÓIS.
//
// createGoals(container, opts) → Goals
//
// A meta acumula moedas do time HERÓI (a partir do 'leaderboard' do servidor, ou somando os
// 'gift' quando o servidor está offline) e, ao encher, chama opts.onGoal({ reward, ... }) —
// o main.js liga esse callback nos efeitos reais do jogo (escudo / comida dourada).
// Cada meta batida deixa a próxima maior, então o público sempre tem um alvo novo.

const SLIDE_MS = 8000;            // troca de cartão do carrossel
const RECORD_BADGE_MS = 12000;    // quanto tempo o selo "maior presente da live" fica visível
const CTA_ROTATE_EVERY = 1;       // troca a dica a cada exibição do cartão de CTA

// Escada de metas: alvo em moedas de HERÓIS e o bônus que dispara no jogo.
const GOAL_STEPS = [
  { coins: 50,   reward: 'shield', sec: 20, label: '🛡️ ESCUDO',        toast: '🛡️ META BATIDA! Escudo ligado pelo público!' },
  { coins: 120,  reward: 'food',   food: 3, label: '🍎 3 COMIDAS',      toast: '🍎 META BATIDA! Chuva de comida dourada!' },
  { coins: 300,  reward: 'shield', sec: 40, label: '🛡️ SUPER ESCUDO',   toast: '🛡️ META BATIDA! Super escudo de 40 s!' },
  { coins: 700,  reward: 'food',   food: 6, label: '🍎 6 COMIDAS',      toast: '🍎 META BATIDA! Banquete dourado!' },
  { coins: 1500, reward: 'shield', sec: 60, label: '🛡️ ESCUDO LENDÁRIO', toast: '🛡️ META BATIDA! Escudo lendário de 60 s!' }
];
// Depois da última etapa a meta continua crescendo sozinha (×2 a cada vez).
const GOAL_GROWTH = 2;

// Dicas rotativas: mostram o EFEITO, que é o que converte em presente.
const CTA_TIPS = [
  { ico: '🌹', name: 'Rosa',        fx: '1 bomba na cobra',        team: 'villain' },
  { ico: '🎮', name: 'GG',          fx: 'comida dourada',          team: 'hero' },
  { ico: '🍩', name: 'Rosquinha',   fx: '3 bombas',                team: 'villain' },
  { ico: '🕊️', name: 'Tsuru',       fx: 'a cobra cresce +3',       team: 'hero' },
  { ico: '🎉', name: 'Confete',     fx: 'chuva de 8 bombas',       team: 'villain' },
  { ico: '🦢', name: 'Cisne',       fx: 'limpa TODAS as bombas',   team: 'hero' },
  { ico: '🔫', name: 'Arma',        fx: '12 bombas + mordida',     team: 'villain' },
  { ico: '🌌', name: 'Galáxia',     fx: 'escudo de 30 s',          team: 'hero' },
  { ico: '🏍️', name: 'Moto',        fx: '20 bombas + atropelo',    team: 'villain' },
  { ico: '🚀', name: 'Foguete',     fx: 'cresce +10 e escudo',     team: 'hero' },
  { ico: '🦁', name: 'Leão',        fx: '40 BOMBAS DE UMA VEZ!',   team: 'villain' },
  { ico: '🌠', name: 'Universo',    fx: 'o pacote SUPREMO',        team: 'hero' }
];

const AVATAR_COLORS = ['#22d3ee', '#fbbf24', '#fb7185', '#34d399', '#a78bfa', '#f472b6', '#60a5fa', '#f97316'];

// ---- helpers ---------------------------------------------------------------------------------

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function truncate(s, max = 12) {
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

function avatarNode(user, className = 'gl-avatar') {
  const wrap = el('div', className);
  const nick = user?.nickname || user?.uniqueId || '?';
  const fallback = el('span', 'gl-initials', initials(nick));
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

const defaultFormatNumber = (() => {
  let fmt = null;
  try { fmt = new Intl.NumberFormat('pt-BR'); } catch { fmt = null; }
  return (n) => (fmt ? fmt.format(Number(n) || 0) : String(Math.round(Number(n) || 0)));
})();

const fmtCompact = (() => {
  let fmt = null;
  try { fmt = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 }); } catch { fmt = null; }
  return (n) => {
    const v = Math.max(0, Number(n) || 0);
    return fmt ? fmt.format(v) : String(Math.round(v));
  };
})();

const num = (v) => Math.max(0, Number(v) || 0);

// ---- Goals -----------------------------------------------------------------------------------

/**
 * @param {HTMLElement} container  seção de monetização (#hud-money)
 * @param {{
 *   formatNumber?: (n:number)=>string,
 *   onGoal?: (goal:{reward:string, sec?:number, food?:number, label:string, toast:string, index:number, target:number})=>void,
 *   slideMs?: number
 * }} [opts]
 */
export function createGoals(container, opts = {}) {
  if (!container) throw new Error('createGoals: container element required');
  const fmt = typeof opts.formatNumber === 'function' ? opts.formatNumber : defaultFormatNumber;
  const onGoal = typeof opts.onGoal === 'function' ? opts.onGoal : null;
  const slideMs = Math.max(2000, Number(opts.slideMs) || SLIDE_MS);

  const box = el('div', 'money glass');
  const stage = el('div', 'money-stage');
  const badge = el('div', 'money-badge hidden');   // selo "🔥 MAIOR PRESENTE DA LIVE"
  const dots = el('div', 'money-dots');
  box.append(badge, stage, dots);
  container.appendChild(box);

  const timers = new Set();
  const setT = (fn, ms) => {
    const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
    timers.add(id);
    return id;
  };
  const clearT = (id) => { if (id) { clearTimeout(id); timers.delete(id); } };

  // ---- estado -----------------------------------------------------------------------------
  const state = {
    heroCoins: 0,          // total de moedas de heróis DA LIVE (base da meta)
    villainCoins: 0,
    roundHero: null,       // [persist] moedas de heróis DA RODADA (null = servidor sem o bloco)
    roundVillain: null,
    heroTop: [],
    villainTop: [],
    overallTop: [],
    goalIndex: 0,          // etapa atual da escada
    goalBase: 0,           // moedas de herói já consumidas pelas metas anteriores
    record: null,          // { nickname, giftName, coins, avatarUrl, userId }
    localHero: 0,          // acumulado local (usado quando o servidor está offline)
    localVillain: 0,
    usingLocal: false,
    ctaIndex: 0
  };

  let slideIndex = 0;
  let slideTimer = 0;
  let badgeTimer = 0;
  let destroyed = false;

  const SLIDES = ['goal', 'rank', 'cta', 'duel'];

  function goalTarget(index = state.goalIndex) {
    if (index < GOAL_STEPS.length) return GOAL_STEPS[index].coins;
    const last = GOAL_STEPS[GOAL_STEPS.length - 1].coins;
    return Math.round(last * Math.pow(GOAL_GROWTH, index - GOAL_STEPS.length + 1));
  }

  function goalStep(index = state.goalIndex) {
    const base = GOAL_STEPS[Math.min(index, GOAL_STEPS.length - 1)];
    return { ...base, coins: goalTarget(index), index, target: goalTarget(index) };
  }

  /** Moedas de heróis já contadas para a meta ATUAL. */
  function goalProgress() {
    return Math.max(0, heroTotal() - state.goalBase);
  }

  const heroTotal = () => (state.usingLocal ? state.localHero : state.heroCoins);
  const villainTotal = () => (state.usingLocal ? state.localVillain : state.villainCoins);

  /** Verifica (e dispara, possivelmente várias vezes) as metas atingidas. */
  function checkGoal() {
    let guard = 0;
    while (goalProgress() >= goalTarget() && guard++ < 8) {
      const step = goalStep();
      state.goalBase += step.target;
      state.goalIndex += 1;
      if (onGoal) {
        try { onGoal(step); } catch (err) { console.warn('[goals] callback de meta falhou', err); }
      }
      flashGoal();
    }
  }

  function flashGoal() {
    box.classList.remove('goal-hit');
    void box.offsetWidth;
    box.classList.add('goal-hit');
    setT(() => box.classList.remove('goal-hit'), 1400);
    // Puxa o cartão da meta para a tela: é o momento em que a prova social é mais forte.
    showSlide(0, true);
  }

  // ---- cartões ----------------------------------------------------------------------------

  function cardGoal() {
    const step = goalStep();
    const done = goalProgress();
    const target = step.target;
    const pct = target > 0 ? Math.min(100, Math.round((done / target) * 100)) : 0;
    const left = Math.max(0, target - done);

    // [compacto] O título carregava o alvo em moedas ("META: 300 moedas para 🛡️ SUPER ESCUDO"),
    // repetindo o número que a barra logo abaixo já mostra em "120 / 300". Fica só o PRÊMIO, que
    // é o que o público quer — o quanto falta está na barra e na linha de baixo.
    const card = el('div', 'money-card card-goal');
    const head = el('div', 'money-head');
    head.append(
      el('span', 'money-ico', '🎯'),
      el('span', 'money-title', `META: ${step.label}`)
    );
    card.appendChild(head);

    const bar = el('div', 'goal-bar');
    const fill = el('div', 'goal-fill');
    fill.style.width = pct + '%';
    const txt = el('div', 'goal-bar-text num', `${fmt(done)} / ${fmt(target)}`);
    bar.append(fill, txt);
    card.appendChild(bar);

    // [compacto] A chamada tinha 58 caracteres e listava três presentes que o carrossel já ensina
    // um a um no cartão de dica. Curta, ela cabe grande e diz a única coisa acionável: falta X.
    card.appendChild(el('div', 'money-sub',
      left > 0
        ? `Faltam ${fmt(left)} 🪙 dos HERÓIS 😇`
        : 'META CHEIA! 🎉'));
    return card;
  }

  function cardRank() {
    const card = el('div', 'money-card card-rank');
    const head = el('div', 'money-head');
    // [persist] Este é o RANKING DA LIVE: moedas totais desde o começo da transmissão. Nunca
    // zera de rodada em rodada (quem zera é a barra de duelo do HUD).
    // [compacto] O subtítulo "moedas de toda a live 🪙" (12px, o menor texto do cartão) era pura
    // redundância: o título já diz "DA LIVE" e cada linha já mostra o 🪙. Cortado.
    head.append(el('span', 'money-ico', '🏆'), el('span', 'money-title', 'RANKING DA LIVE'));
    card.appendChild(head);

    const top = (state.overallTop.length ? state.overallTop : [...state.heroTop, ...state.villainTop]
      .sort((a, b) => num(b.coins) - num(a.coins))).slice(0, 3);

    // [compacto] O ranking mantém o TOP 3 (o 2º e o 3º são o que fazem o 1º ser disputado), mas
    // deixa de ser três linhas iguais e miúdas: o líder ganha a classe `rank-lead` para o CSS
    // poder dar a ele foto e número BEM maiores, e o 2º/3º ficam como coadjuvantes. Assim cabe
    // um nome grande de verdade na faixa sem perder a disputa.
    const list = el('ol', 'rank-list');
    if (!top.length) {
      list.appendChild(el('li', 'rank-empty', 'Seja o primeiro! 🎁'));
    } else {
      const medals = ['🥇', '🥈', '🥉'];
      top.forEach((g, i) => {
        const li = el('li', 'rank-row r' + (i + 1) + (i === 0 ? ' rank-lead' : ''));
        li.append(
          el('span', 'rank-medal', medals[i] || String(i + 1)),
          avatarNode(g, 'gl-avatar rank-avatar'),
          el('span', 'rank-nick', truncate(g.nickname || g.uniqueId || '?', 12)),
          el('span', 'rank-coins num', `🪙 ${fmtCompact(g.coins)}`)
        );
        list.appendChild(li);
      });
    }
    card.appendChild(list);
    return card;
  }

  function cardCta() {
    const tip = CTA_TIPS[state.ctaIndex % CTA_TIPS.length];
    state.ctaIndex += CTA_ROTATE_EVERY;
    // [compacto] Este cartão herdou o trabalho da legenda de presentes que saiu do HUD (aquela
    // de 13px com 4 itens espremidos). Aqui a MESMA informação aparece uma dica por vez e pode
    // ocupar a largura toda — que é o único jeito de ela ser legível no celular.
    // O título "COMO JOGAR COM A GENTE" saiu: a linha "🌹 Rosa = 1 bomba na cobra" já se explica
    // sozinha, e o cabeçalho só empurrava a dica para uma fonte menor.
    const card = el('div', 'money-card card-cta team-' + tip.team);

    const line = el('div', 'cta-line');
    line.append(
      el('span', 'cta-ico', tip.ico),
      el('b', 'cta-name', tip.name),
      el('span', 'cta-eq', '='),
      el('span', 'cta-fx', tip.fx)
    );
    card.appendChild(line);
    card.appendChild(el('div', 'money-sub',
      tip.team === 'villain'
        ? '😈 atrapalhe a cobra!'
        : '😇 salve a cobra!'));
    return card;
  }

  function cardDuel() {
    // [persist] Duelo DA RODADA quando o servidor manda o bloco `round`; senão, o da live.
    const perRound = state.roundVillain !== null && state.roundHero !== null;
    const v = perRound ? state.roundVillain : villainTotal();
    const h = perRound ? state.roundHero : heroTotal();
    const total = v + h;
    const pct = total > 0 ? Math.max(8, Math.min(92, (v / total) * 100)) : 50;

    const card = el('div', 'money-card card-duel');
    const head = el('div', 'money-head');
    head.append(el('span', 'money-ico', '⚔️'), el('span', 'money-title', 'DUELO: QUEM VENCE?'));
    card.appendChild(head);
    // [compacto] O subtítulo de escopo ("só desta rodada ⏱") saiu: em 12px ninguém lia, e a
    // regra de quando o duelo zera não muda o que o espectador faz — ele manda presente para o
    // time dele de qualquer jeito. A barra com os dois números já conta a história.

    const bar = el('div', 'duel-bar');
    const fv = el('div', 'duel-fill villain');
    fv.style.width = pct + '%';
    const fh = el('div', 'duel-fill hero');
    fh.style.width = (100 - pct) + '%';
    const lv = el('span', 'duel-side villain num', `😈 ${fmtCompact(v)}`);
    const lh = el('span', 'duel-side hero num', `${fmtCompact(h)} 😇`);
    bar.append(fv, fh, lv, lh);
    card.appendChild(bar);

    let sub;
    if (total === 0) {
      sub = 'Ninguém pontuou ainda — comece a batalha! 🎁';
    } else if (v > h) {
      sub = `Faltam ${fmt(v - h)} para os HERÓIS 😇 virarem o jogo!`;
    } else if (h > v) {
      sub = `Faltam ${fmt(h - v)} para os VILÕES 😈 virarem o jogo!`;
    } else {
      sub = 'EMPATE TÉCNICO! O próximo presente decide 🔥';
    }
    card.appendChild(el('div', 'money-sub', sub));
    return card;
  }

  const BUILDERS = { goal: cardGoal, rank: cardRank, cta: cardCta, duel: cardDuel };

  // ---- carrossel --------------------------------------------------------------------------

  function renderDots() {
    clear(dots);
    for (let i = 0; i < SLIDES.length; i++) {
      const d = el('span', 'money-dot' + (i === slideIndex ? ' on' : ''));
      dots.appendChild(d);
    }
  }

  function showSlide(index, immediate = false) {
    if (destroyed) return;
    slideIndex = ((index % SLIDES.length) + SLIDES.length) % SLIDES.length;
    const build = BUILDERS[SLIDES[slideIndex]];
    let node = null;
    try {
      node = build();
    } catch (err) {
      console.warn('[goals] falha ao montar cartão', err);
      return;
    }
    clear(stage);
    stage.appendChild(node);
    renderDots();
    clearT(slideTimer);
    slideTimer = setT(() => showSlide(slideIndex + 1), immediate ? slideMs : slideMs);
  }

  /**
   * Redesenha o cartão visível (sem reiniciar o carrossel) quando os dados mudam.
   * O cartão novo entra SEM a animação de entrada: presentes chegam mais rápido que os 0,4 s do
   * `money-in`, e reanimar a cada atualização deixava o cartão preso em opacity 0 (invisível).
   */
  function refresh() {
    if (destroyed) return;
    const build = BUILDERS[SLIDES[slideIndex]];
    if (!build || SLIDES[slideIndex] === 'cta') return; // o CTA não depende de dados
    try {
      const node = build();
      node.classList.add('no-anim');
      clear(stage);
      stage.appendChild(node);
    } catch (err) {
      console.warn('[goals] falha ao atualizar cartão', err);
    }
  }

  // ---- entrada de dados --------------------------------------------------------------------

  /** Placar oficial do servidor: vira a fonte da verdade e desliga o acúmulo local. */
  function setLeaderboard(lb) {
    if (destroyed || !lb || typeof lb !== 'object') return;
    const hasTeams = !!(lb.teams && (lb.teams.villain || lb.teams.hero));
    if (hasTeams) {
      state.usingLocal = false;
      // A META usa as moedas de herói da LIVE inteira: é progresso acumulado, não da rodada
      // (uma meta que zerasse a cada rodada nunca seria batida).
      state.heroCoins = num(lb.teams?.hero?.coins);
      state.villainCoins = num(lb.teams?.villain?.coins);
      state.heroTop = Array.isArray(lb.teams?.hero?.top) ? lb.teams.hero.top : [];
      state.villainTop = Array.isArray(lb.teams?.villain?.top) ? lb.teams.villain.top : [];
    }
    // [persist] O cartão DUELO acompanha a barra do HUD: mostra a disputa DA RODADA.
    const rd = lb.round && (lb.round.villain || lb.round.hero) ? lb.round : null;
    state.roundHero = rd ? num(rd.hero?.coins) : null;
    state.roundVillain = rd ? num(rd.villain?.coins) : null;
    state.overallTop = Array.isArray(lb.top) ? lb.top.slice(0, 3) : [];
    checkGoal();
    refresh();
  }

  /**
   * Presente. Alimenta o acúmulo LOCAL (usado quando não há 'leaderboard' do servidor) e
   * guarda o recorde da sessão para o selo "maior presente da live".
   */
  function addGift(ev) {
    if (destroyed || !ev || typeof ev !== 'object') return;
    const rule = ev.rule || {};
    const units = Math.max(1, Number(ev.repeatCount) || Number(ev.count) || 1);
    const coins = num(ev.coins) || num(ev.diamondCount) * units;

    if (Number(ev.count) > 0 || !ev.streakEnd) {
      const counted = num(ev.coins) || num(ev.diamondCount) * Math.max(1, Number(ev.count) || 1);
      if (rule.team === 'hero') state.localHero += counted;
      else if (rule.team === 'villain') state.localVillain += counted;
      // Enquanto nenhum 'leaderboard' com times chegou, a meta anda pelo acúmulo local.
      if (state.heroCoins === 0 && state.villainCoins === 0) state.usingLocal = true;
    }

    if (coins > 0 && (!state.record || coins > state.record.coins)) {
      state.record = {
        coins,
        nickname: ev.user?.nickname || ev.user?.uniqueId || 'Alguém',
        giftName: ev.giftName || 'presente',
        avatarUrl: ev.user?.avatarUrl || null,
        userId: ev.user?.userId || null
      };
      const tier = rule.tier === 'supreme' || rule.tier === 'mega' || rule.effect === 'mega';
      if (tier) showRecordBadge();
    }
    checkGoal();
    refresh();
  }

  function showRecordBadge() {
    if (!state.record) return;
    // [compacto] Eram 6 textos numa tira só ("🔥 MAIOR PRESENTE DA LIVE: · foto · Fulano · — ·
    // Rosa · 🪙 30 mil"). O nome do presente e o traço saíram: quem manda presente quer ver o
    // PRÓPRIO NOME grande na tela, e o valor é a prova social. O rótulo encurtou para caber.
    clear(badge);
    badge.append(
      el('span', 'badge-ico', '🔥'),
      el('span', 'badge-txt', 'MAIOR DA LIVE'),
      avatarNode(state.record, 'gl-avatar badge-avatar'),
      el('b', 'badge-nick', truncate(state.record.nickname, 14)),
      el('span', 'badge-coins num', `🪙 ${fmtCompact(state.record.coins)}`)
    );
    badge.classList.remove('hidden');
    clearT(badgeTimer);
    badgeTimer = setT(() => badge.classList.add('hidden'), RECORD_BADGE_MS);
  }

  /** Nova rodada: as metas continuam (é progresso da LIVE, não da rodada), só reanima o carrossel. */
  function newRound() {
    if (destroyed) return;
    showSlide(0);
  }

  // ---- [persist] retomada após F5 -----------------------------------------------------------

  /**
   * [persist] Estado das metas para o servidor guardar (vai junto do 'snapshot', 1 Hz).
   * Só o que não dá para recalcular a partir do ranking: em que etapa da escada estamos e
   * quantas moedas de herói já foram consumidas pelas metas anteriores.
   */
  function snapshot() {
    return {
      goalIndex: state.goalIndex,
      goalBase: state.goalBase,
      ctaIndex: state.ctaIndex,
      record: state.record ? { ...state.record } : null
    };
  }

  /**
   * [persist] Retoma as metas no ponto em que estavam (chamado no boot com o que veio do 'hello').
   * Sem isto, um F5 zeraria a escada de metas e o público veria a barra voltar ao começo.
   */
  function restore(saved) {
    if (destroyed || !saved || typeof saved !== 'object') return;
    const idx = Number(saved.goalIndex);
    const base = Number(saved.goalBase);
    if (Number.isFinite(idx) && idx >= 0) state.goalIndex = Math.min(64, Math.floor(idx));
    if (Number.isFinite(base) && base >= 0) state.goalBase = base;
    const cta = Number(saved.ctaIndex);
    if (Number.isFinite(cta) && cta >= 0) state.ctaIndex = Math.floor(cta);
    if (saved.record && typeof saved.record === 'object' && num(saved.record.coins) > 0) {
      state.record = { ...saved.record, coins: num(saved.record.coins) };
    }
    refresh();
  }

  function setVisible(v) {
    box.classList.toggle('money-hidden', !v);
  }

  function destroy() {
    destroyed = true;
    for (const id of timers) clearTimeout(id);
    timers.clear();
    box.remove();
  }

  showSlide(0);

  return {
    setLeaderboard, addGift, newRound, setVisible, destroy,
    snapshot, restore, // [persist] metas sobrevivem ao F5
    get record() { return state.record ? { ...state.record } : null; },
    get goal() { return { index: state.goalIndex, target: goalTarget(), progress: goalProgress() }; },
    get totals() { return { hero: heroTotal(), villain: villainTotal() }; },
    get root() { return box; }
  };
}
