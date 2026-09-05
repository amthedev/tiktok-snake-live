// public/js/ui/giftguide.js — [guia] TABELA VISUAL DE PRESENTES
//
// createGiftGuide(container, opts) → GiftGuide
//
// POR QUE ISTO EXISTE (pedido literal do cliente, depois de rodar o overlay numa live real):
//   "ali embaixo dá pra colar uma imagem falando que uma rosa é igual uma maçã, um GG é igual uma
//    bomba: 🌹 = 💣, GG = 🍎 … mas tu faz na IA, pô. Coloca já no site isso."
// Ou seja: um guia DENTRO do overlay, no formato de equivalência que ele desenhou com a mão —
// presente à esquerda, sinal de igual, efeito à direita. É a informação que mais converte presente
// numa live: quem entende o efeito, manda.
//
// (Na fala o cliente inverteu os lados — pelo catálogo real é 🌹 Rosa → 💣 bomba, do time VILÃO, e
// 🎮 GG → 🍎 comida, do time HERÓI. O guia mostra o catálogo, não a transcrição.)
//
// TRÊS DECISÕES DE DESENHO, todas ditadas pela mesma restrição do celular:
//
// 1. PAREADO POR PREÇO, UM NÍVEL POR VEZ. O catálogo tem 6 presentes em 3 faixas de preço
//    (1 / 30 / 100 moedas), e o pareamento por preço É o duelo: pela mesma moeda você atrapalha
//    ou salva a cobra. Mostrar os 6 de uma vez em ~7 % da altura do palco daria 6 linhas
//    microscópicas — exatamente o erro que o cliente reclamou ("embaixo não dá pra ver direito").
//    Então o guia é um CARROSSEL: mostra UM nível de preço por vez (o par vilão × herói daquele
//    preço), grande, e troca sozinho a cada 7 s. Regra do cliente: menos elementos, cada um maior.
//
// 2. EMOJI GRANDE, TEXTO MÍNIMO. O que se lê num celular a um metro de distância é o pictograma,
//    não a letra — e o emoji sobrevive muito melhor à compressão de vídeo do TikTok. O emoji do
//    presente e o do efeito ficam em ~2,4 rem (≈46 px equivalentes a 1080); o nome do presente e o
//    efeito em texto ficam no piso de legibilidade ou acima. Nada abaixo de --fs-mini.
//
// 3. O CATÁLOGO É A FONTE. Os presentes vêm de `rules` (hello e evento 'rules' do servidor), então
//    editar config/gifts.json ou dar um PUT /api/gifts muda o guia sozinho, sem tocar em código.
//    O FALLBACK embutido é só a rede de segurança para o overlay offline — e mesmo ele é uma cópia
//    do catálogo atual, nunca um presente inventado.
//
// O emoji de cada presente NÃO está no gifts.json (o schema do servidor não tem esse campo e ele é
// do outro agente). O guia deriva o emoji do NOME do presente por uma tabela de apelidos que cobre
// o catálogo do cliente + os presentes clássicos do TikTok, e cai num emoji genérico por time
// (😈 / 😇) quando não reconhece — um presente novo aparece com efeito correto e ícone neutro, que
// é muito melhor que sumir da tabela.

const SLIDE_MS = 7000;          // troca de faixa de preço (o cliente pediu 6–8 s)
const MAX_EXTRAS = 2;           // selos de efeito secundário por presente (ver sideNode)

// ---- catálogo de fallback (espelha config/gifts.json) -----------------------------------------
// Usado só quando o servidor não mandou `rules` (overlay aberto sem servidor, hello perdido).
const FALLBACK_GIFTS = [
  { name: 'Rosa',             coins: 1,   team: 'villain', effects: { bombs: 1 } },
  { name: 'Rosquinha',        coins: 30,  team: 'villain', effects: { bombs: 3, bolt: 1 } },
  { name: 'Confete',          coins: 100, team: 'villain', effects: { bombs: 8, ice: 1, web: 1 } },
  { name: 'GG',               coins: 1,   team: 'hero',    effects: { food: 1 } },
  { name: 'Coraçãozinho',     coins: 30,  team: 'hero',    effects: { grow: 3, diamond: 1 } },
  { name: 'Coração nas Mãos', coins: 100, team: 'hero',    effects: { clearBombs: true, shieldSec: 30, food: 3, star: 1 } }
];

// ---- emoji do PRESENTE, por nome --------------------------------------------------------------
// Chave normalizada (minúscula, sem acento). Cobre o catálogo do cliente e os presentes do TikTok
// que já apareceram nos padrões do servidor, para o guia continuar bonito se o catálogo mudar.
const GIFT_EMOJI = {
  'rosa': '🌹', 'rose': '🌹',
  'gg': '🎮',
  'rosquinha': '🍩', 'doughnut': '🍩', 'donut': '🍩',
  'confete': '🎊', 'confetti': '🎊',
  'coracaozinho': '🫰', 'coracao': '🫰', 'finger heart': '🫰',
  'coracao nas maos': '🫶', 'hand hearts': '🫶', 'hands heart': '🫶', 'maozinha': '🫶',
  'casquinha': '🍦', 'sorvete': '🍦', 'ice cream cone': '🍦',
  'bone': '🧢', 'cap': '🧢',
  'arma de dinheiro': '💸', 'money gun': '💸',
  'moto': '🏍️', 'motorcycle': '🏍️',
  'leao': '🦁', 'lion': '🦁',
  'tsuru de papel': '🕊️', 'tsuru': '🕊️', 'paper crane': '🕊️',
  'cisne': '🦢', 'swan': '🦢',
  'galaxia': '🌌', 'galaxy': '🌌',
  'foguete': '🚀', 'rocket': '🚀',
  'universo tiktok': '🌠', 'tiktok universe': '🌠', 'universe': '🌠'
};

// ---- emoji do EFEITO --------------------------------------------------------------------------
// Cada chave de `effects` vira um pictograma. A ORDEM aqui é a ordem de importância: o guia mostra
// o efeito PRINCIPAL grande (o primeiro que o presente tiver) e os demais como selos pequenos.
// É isso que faz "🌹 = 💣" e "🎮 = 🍎" caírem exatamente no formato que o cliente desenhou.
const EFFECT_ICONS = [
  { key: 'bombs',      ico: '💣', label: 'bomba',    plural: 'bombas' },
  { key: 'clearBombs', ico: '✨', label: 'limpa tudo' },   // curto de propósito: ver MAX_EXTRAS
  { key: 'food',       ico: '🍎', label: 'comida',   plural: 'comidas' },
  { key: 'shieldSec',  ico: '🛡️', label: 'escudo' },
  { key: 'grow',       ico: '📈', label: 'cresce' },
  { key: 'skull',      ico: '☠️', label: 'caveira',  plural: 'caveiras' },
  { key: 'bolt',       ico: '⚡', label: 'raio',     plural: 'raios' },
  { key: 'ice',        ico: '🧊', label: 'gelo' },
  { key: 'web',        ico: '🕸️', label: 'teia',     plural: 'teias' },
  { key: 'star',       ico: '⭐', label: 'estrela',  plural: 'estrelas' },
  { key: 'diamond',    ico: '💎', label: 'diamante', plural: 'diamantes' },
  { key: 'magnet',     ico: '🧲', label: 'ímã' },
  { key: 'clock',      ico: '⏱️', label: 'turbo' },
  { key: 'bite',       ico: '🦷', label: 'morde' }
];

// Presente novo, fora da tabela de emoji acima: entra com a carinha do time em vez de sumir.
const TEAM_FALLBACK_ICON = { villain: '😈', hero: '😇' };

// ---- helpers ----------------------------------------------------------------------------------

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
}

/** minúscula, sem acento, sem pontuação — a mesma ideia do normalizeName() do servidor. */
function normalizeName(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Emoji do presente: tabela por nome (inclusive os apelidos de `match`), senão o do time. */
function giftEmoji(gift) {
  const candidates = [gift?.name, ...(Array.isArray(gift?.match) ? gift.match : [])];
  for (const c of candidates) {
    const hit = GIFT_EMOJI[normalizeName(c)];
    if (hit) return hit;
  }
  return TEAM_FALLBACK_ICON[gift?.team === 'hero' ? 'hero' : 'villain'];
}

/**
 * Efeitos de um presente, em ordem de importância.
 * @returns {{ico:string, text:string}[]} o [0] é o efeito PRINCIPAL (o que vai grande no "=").
 */
function giftEffects(gift) {
  const fx = gift?.effects && typeof gift.effects === 'object' ? gift.effects : {};
  const out = [];
  for (const def of EFFECT_ICONS) {
    const raw = fx[def.key];
    if (raw === true) {                       // clearBombs
      out.push({ ico: def.ico, text: def.label });
      continue;
    }
    const n = num(raw);
    if (!n) continue;
    if (def.key === 'shieldSec') { out.push({ ico: def.ico, text: `escudo ${n}s` }); continue; }
    if (def.key === 'grow')      { out.push({ ico: def.ico, text: `+${n}` }); continue; }
    const label = n > 1 && def.plural ? def.plural : def.label;
    out.push({ ico: def.ico, text: n > 1 ? `${n} ${label}` : label });
  }
  // Presente sem efeito reconhecido (ou fora da lista): pelo menos diz de que lado ele está.
  if (!out.length) {
    out.push(gift?.team === 'hero'
      ? { ico: '🍎', text: 'ajuda a cobra' }
      : { ico: '💣', text: 'bomba' });
  }
  return out;
}

// [medido] APELIDOS CURTOS. "Coração nas Mãos" tem 16 caracteres e, ao lado do emoji, do "=" e do
// efeito, não cabia na metade da largura do palco a 375 px: virava "Coraçã…", que não ensina nada —
// o espectador não acha "Coraçã…" na barra de presentes do TikTok. Como o piso de legibilidade é
// intocável, quem encurta é o NOME, não a fonte: o apelido é o mesmo que o cliente usa falando
// ("mãozinha") e que o painel dev já mostra. Presente sem apelido usa o nome inteiro.
const SHORT_NAMES = {
  'coracao nas maos': 'Mãozinha',
  'hand hearts': 'Mãozinha',
  'hands heart': 'Mãozinha',
  'coracaozinho': 'Coração',
  'finger heart': 'Coração',
  'arma de dinheiro': 'Arma',
  'money gun': 'Arma',
  'universo tiktok': 'Universo',
  'tiktok universe': 'Universo',
  'tsuru de papel': 'Tsuru',
  'paper crane': 'Tsuru'
};

/** Nome curto o bastante para caber inteiro ao lado do emoji. */
function shortName(name) {
  const raw = String(name || '').trim();
  return SHORT_NAMES[normalizeName(raw)] || raw;
}

/** Normaliza um presente do `rules` do servidor para o que o guia precisa. */
function toEntry(gift) {
  const team = gift?.team === 'hero' ? 'hero' : 'villain';
  const effects = giftEffects(gift);
  return {
    name: shortName(gift?.name) || 'Presente',
    coins: Math.max(0, Math.round(Number(gift?.coins) || 0)),
    team,
    ico: giftEmoji(gift),
    main: effects[0],
    extras: effects.slice(1)
  };
}

/**
 * Monta as FAIXAS DE PREÇO do carrossel: cada faixa é um preço em moedas com o vilão e o herói
 * daquele preço, lado a lado. É o pareamento que o cliente quis ("1 🪙 Rosa 💣 × GG 🍎").
 *
 * Presentes sem par (catálogo desbalanceado, ou um preço que só tem vilão) NÃO são descartados:
 * viram uma faixa com um lado só. Sumir com um presente do guia seria pior que mostrá-lo sozinho.
 */
function buildTiers(gifts) {
  const list = (Array.isArray(gifts) ? gifts : []).map(toEntry);
  const byCoins = new Map();
  for (const g of list) {
    if (!byCoins.has(g.coins)) byCoins.set(g.coins, { coins: g.coins, villain: null, hero: null, extra: [] });
    const tier = byCoins.get(g.coins);
    if (!tier[g.team]) tier[g.team] = g;
    else tier.extra.push(g);          // mesmo preço, mesmo time: entra numa faixa própria depois
  }
  const tiers = [...byCoins.values()].sort((a, b) => a.coins - b.coins);
  // Os "extra" (2º vilão de 1 moeda, por exemplo) viram faixas adicionais do mesmo preço, para
  // nenhum presente do catálogo ficar de fora do guia.
  const out = [];
  for (const t of tiers) {
    out.push({ coins: t.coins, villain: t.villain, hero: t.hero });
    let rest = t.extra;
    while (rest.length) {
      const v = rest.find((g) => g.team === 'villain') || null;
      const h = rest.find((g) => g.team === 'hero') || null;
      out.push({ coins: t.coins, villain: v, hero: h });
      rest = rest.filter((g) => g !== v && g !== h);
    }
  }
  return out;
}

// ---- GiftGuide --------------------------------------------------------------------------------

/**
 * Painel-guia "presente = efeito", em carrossel por faixa de preço.
 *
 * @param {HTMLElement} container  faixa reservada no HUD (#hud-guide)
 * @param {{ rules?: object, slideMs?: number, formatNumber?: (n:number)=>string }} [opts]
 * @returns {{
 *   setRules: (rules:object|null) => void,
 *   setVisible: (v:boolean) => void,
 *   next: () => void,
 *   tiers: () => Array,
 *   destroy: () => void,
 *   root: HTMLElement
 * }}
 */
export function createGiftGuide(container, opts = {}) {
  if (!container) throw new Error('createGiftGuide: container element required');
  const slideMs = Math.max(2000, Number(opts.slideMs) || SLIDE_MS);

  const box = el('div', 'guide glass');
  const head = el('div', 'guide-head');
  head.append(
    el('span', 'guide-title', 'O QUE CADA PRESENTE FAZ'),
    el('span', 'guide-price num', '')          // preenchido por render(): "1 🪙"
  );
  const stage = el('div', 'guide-stage');
  const dots = el('div', 'guide-dots');
  box.append(head, stage, dots);
  container.appendChild(box);

  let tiers = buildTiers(FALLBACK_GIFTS);
  let index = 0;
  let timer = 0;
  let destroyed = false;

  // O catálogo do servidor, quando chega, substitui o fallback.
  if (opts.rules) applyRules(opts.rules);

  function applyRules(rules) {
    const gifts = Array.isArray(rules?.gifts) ? rules.gifts : null;
    // Catálogo vazio ou inválido: mantém o que já está na tela em vez de apagar o guia.
    if (!gifts || !gifts.length) return false;
    const next = buildTiers(gifts);
    if (!next.length) return false;
    tiers = next;
    if (index >= tiers.length) index = 0;
    return true;
  }

  /** Um lado do par: 🌹 Rosa = 💣 1 bomba. */
  function sideNode(entry, team) {
    const side = el('div', 'guide-side team-' + team);
    if (!entry) {
      // Faixa sem par (catálogo desbalanceado): um traço discreto, sem inventar presente.
      side.classList.add('is-empty');
      side.appendChild(el('span', 'guide-dash', '—'));
      return side;
    }
    const gift = el('span', 'guide-gift');
    gift.append(
      el('span', 'guide-emoji', entry.ico),
      el('span', 'guide-name', entry.name)
    );
    const eq = el('span', 'guide-eq', '=');
    const fx = el('span', 'guide-fx');
    fx.append(
      el('span', 'guide-emoji guide-emoji-fx', entry.main.ico),
      el('span', 'guide-fx-text', entry.main.text)
    );
    side.append(gift, eq, fx);
    if (entry.extras.length) {
      // Efeitos secundários: só os pictogramas, sem texto — cabem e não roubam a leitura.
      // [medido] TETO DE 2. O presente de 100 moedas do herói tem 4 efeitos, e com os 4 selos a
      // linha estourava: "Mãozinha" virava "Mãoz…" e "limpa tudo" sumia no meio. Os selos são o
      // que há de MENOS importante na linha (o principal já está grande, ao lado do "="), então
      // são eles que cedem espaço — não o nome do presente nem o efeito principal.
      const more = el('span', 'guide-extras');
      for (const e of entry.extras.slice(0, MAX_EXTRAS)) {
        const s = el('span', 'guide-extra', e.ico);
        s.title = e.text;
        more.appendChild(s);
      }
      side.appendChild(more);
    }
    return side;
  }

  function render(animate = true) {
    if (destroyed) return;
    if (!tiers.length) { clear(stage); return; }
    const tier = tiers[index % tiers.length];

    const price = head.querySelector('.guide-price');
    if (price) price.textContent = `${tier.coins} 🪙`;

    const card = el('div', 'guide-card');
    if (!animate) card.classList.add('no-anim');
    card.append(
      sideNode(tier.villain, 'villain'),
      el('span', 'guide-vs', '×'),
      sideNode(tier.hero, 'hero')
    );

    clear(stage);
    stage.appendChild(card);

    clear(dots);
    if (tiers.length > 1) {
      for (let i = 0; i < tiers.length; i++) {
        dots.appendChild(el('span', 'guide-dot' + (i === index % tiers.length ? ' on' : '')));
      }
    }
  }

  function schedule() {
    if (destroyed) return;
    clearTimeout(timer);
    if (tiers.length < 2) return;   // um nível só: nada para alternar
    timer = setTimeout(() => {
      index = (index + 1) % tiers.length;
      render(true);
      schedule();
    }, slideMs);
  }

  render(false);
  schedule();

  return {
    root: box,

    /** Catálogo novo (hello ou evento 'rules'): redesenha na hora. */
    setRules(rules) {
      if (destroyed) return;
      if (!applyRules(rules)) return;
      render(false);
      schedule();
    },

    /** Acompanha o atalho H do HUD. */
    setVisible(v) {
      box.classList.toggle('guide-hidden', !v);
    },

    /** Avança o carrossel manualmente (dev / teste). */
    next() {
      if (destroyed || tiers.length < 2) return;
      index = (index + 1) % tiers.length;
      render(true);
      schedule();
    },

    /** As faixas de preço montadas — usado pela verificação e por testes. */
    tiers() {
      return tiers.map((t) => ({ coins: t.coins, villain: t.villain, hero: t.hero }));
    },

    destroy() {
      destroyed = true;
      clearTimeout(timer);
      box.remove();
    }
  };
}

export default createGiftGuide;
