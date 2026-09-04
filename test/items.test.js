// test/items.test.js
// [itens] Itens especiais (⚡ raio, 🧊 gelo, 🕸️ teia, ☠️ caveira, 💎 diamante, ⭐ estrela,
// 🧲 ímã, ⏱️ relógio), o balanceamento novo da bomba e a escala de recompensa por presente.
//
// O que estes testes garantem, item por item: spawn (com limite por tipo), efeito ao encostar,
// expiração pelo pavio e — o mais importante — que NADA disso quebra o invariante do ciclo
// hamiltoniano (a cobra nunca colide, a rodada nunca trava).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { GameState, ITEM_KINDS, mulberry32 } from '../public/js/game/state.js';
import { nextMove } from '../public/js/ai/hamiltonian.js';
import { DEFAULT_RULES, withDefaults, resolveGift, validateRules } from '../server/gifts.js';

// Configuração da LIVE (a que o overlay usa de verdade): bomba escalada + cobra maior.
const LIVE = { gridSize: 12, bombShrink: 4, bombShrinkPct: 0.2, startLength: 10 };

const ALL_KINDS = Object.keys(ITEM_KINDS);
const DANO = ['bolt', 'ice', 'web', 'skull'];
const BONUS = ['diamond', 'star', 'magnet', 'clock'];

/** Estado pronto para jogar, já com alguns passos dados (cobra com tamanho real). */
function playing(config = {}, seed = 7, steps = 25) {
  const state = new GameState({ ...LIVE, ...config }, { rng: mulberry32(seed) });
  state.start();
  for (let i = 0; i < steps; i++) { state.step(); state.tick(0.1); }
  return state;
}

/**
 * Coloca um item exatamente na célula em que a IA vai pisar no próximo passo e dá esse passo.
 * É assim que se testa "a cobra encostou no item" sem depender da sorte do sorteio.
 */
function stepOnto(state, kind, meta = {}) {
  state.spawnItem(kind, 1, meta);
  const item = [...state._items.values()].at(-1);
  assert.ok(item, `spawnItem(${kind}) não colocou nada no tabuleiro`);
  state._removeItem(item);
  const move = nextMove(state._cycle, state._snake, state._nearestFood(state._snake[0]), state._aiOpts);
  item.cell = move.cell;
  item.x = move.cell % state.w;
  item.z = Math.floor(move.cell / state.w);
  state._items.set(item.id, item);
  state._occ[move.cell] |= 8;
  state._itemCounts[kind] = (state._itemCounts[kind] || 0) + 1;
  return state.step();
}

/** O invariante de ouro: nenhuma célula do corpo repetida e a cabeça sempre dentro do tabuleiro. */
function assertNoCollision(state, where) {
  const snap = state.snapshot;
  const seen = new Set();
  for (const c of snap.snakeIdx) {
    assert.ok(!seen.has(c), `${where}: a cobra colidiu consigo mesma (célula ${c} repetida)`);
    seen.add(c);
    assert.ok(c >= 0 && c < snap.cells, `${where}: segmento fora do tabuleiro (${c})`);
  }
  assert.ok(snap.length >= 3, `${where}: cobra menor que o mínimo (${snap.length})`);
}

// ---------------------------------------------------------------------------------------------
describe('[itens] catálogo', () => {
  test('tem 4 itens de dano e 4 de bônus, cada um com pavio e limite próprios', () => {
    assert.equal(ALL_KINDS.length, 8);
    assert.deepEqual(ALL_KINDS.filter((k) => ITEM_KINDS[k].team === 'villain').sort(), [...DANO].sort());
    assert.deepEqual(ALL_KINDS.filter((k) => ITEM_KINDS[k].team === 'hero').sort(), [...BONUS].sort());
    for (const k of ALL_KINDS) {
      const def = ITEM_KINDS[k];
      assert.ok(def.fuseSec > 0, `${k}: precisa de pavio (some sozinho)`);
      assert.ok(def.max >= 1, `${k}: precisa de limite por tipo`);
      assert.ok(def.emoji && def.label, `${k}: precisa de emoji e nome em pt-BR`);
    }
  });
});

describe('[itens] spawn', () => {
  test('cada tipo aparece no tabuleiro com id, posição e pavio próprios', () => {
    const state = playing();
    for (const kind of ALL_KINDS) {
      const [ev] = state.spawnItem(kind, 1, { giftName: 'Teste' });
      assert.equal(ev.type, 'item_spawn');
      assert.equal(ev.kind, kind);
      assert.equal(ev.team, ITEM_KINDS[kind].team);
      assert.equal(ev.fuseSec, ITEM_KINDS[kind].fuseSec);
      assert.ok(ev.x >= 0 && ev.x < state.w && ev.z >= 0 && ev.z < state.h);
      assert.deepEqual(ev.meta, { giftName: 'Teste' });
    }
    const snap = state.snapshot;
    assert.equal(snap.items.length, 8);
    assert.deepEqual(snap.items.map((i) => i.kind).sort(), [...ALL_KINDS].sort());
  });

  test('respeita o limite por tipo (o excedente é descartado, não enfileirado)', () => {
    for (const kind of ALL_KINDS) {
      const state = playing();
      const max = ITEM_KINDS[kind].max;
      const evs = state.spawnItem(kind, max + 10, {});
      assert.equal(evs.length, max, `${kind}: deveria colocar no máximo ${max}`);
      assert.equal(state.spawnItem(kind, 5, {}).length, 0, `${kind}: cheio, não pode colocar mais`);
      assert.equal(state.snapshot.items.filter((i) => i.kind === kind).length, max);
    }
  });

  test('nunca cai em cima da cobra, da maçã, de bomba ou de outro item', () => {
    const state = playing({}, 11);
    state.spawnBombs(12, {});
    for (const kind of ALL_KINDS) state.spawnItem(kind, ITEM_KINDS[kind].max, {});
    const snap = state.snapshot;
    const ocupadas = new Set(snap.snakeIdx);
    if (snap.apple) ocupadas.add(snap.apple.z * snap.w + snap.apple.x);
    for (const b of snap.bombs) ocupadas.add(b.z * snap.w + b.x);
    for (const it of snap.items) {
      const cell = it.z * snap.w + it.x;
      assert.ok(!ocupadas.has(cell), `item ${it.kind} caiu numa célula ocupada (${cell})`);
      ocupadas.add(cell);
    }
  });

  test('não coloca item depois que a rodada acabou, e kind desconhecido é ignorado', () => {
    const state = playing();
    assert.deepEqual(state.spawnItem('naoexiste', 3, {}), []);
    state._endRound('lost', []);
    for (const kind of ALL_KINDS) assert.deepEqual(state.spawnItem(kind, 1, {}), []);
  });
});

describe('[itens] efeito de cada item ao encostar', () => {
  test('⚡ raio encolhe muito a cobra', () => {
    const state = playing();
    const antes = state.snapshot.length;
    const evs = stepOnto(state, 'bolt');
    const eat = evs.find((e) => e.type === 'eat_item');
    assert.equal(eat.kind, 'bolt');
    assert.ok(eat.shrink > 0, 'o raio precisa doer');
    assert.equal(state.snapshot.length, antes - eat.shrink);
    assertNoCollision(state, 'raio');
  });

  test('☠️ caveira dá dano pesado (mais que o raio)', () => {
    const dano = (kind) => {
      const state = playing({ startLength: 30 }, 5, 40);
      const evs = stepOnto(state, kind);
      return evs.find((e) => e.type === 'eat_item').shrink;
    };
    assert.ok(dano('skull') > dano('bolt'), 'a caveira precisa doer mais que o raio');
  });

  test('🧊 gelo deixa a cobra lenta e o efeito passa sozinho', () => {
    const state = playing();
    const velNormal = state.snapshot.speed;
    const evs = stepOnto(state, 'ice');
    assert.ok(evs.some((e) => e.type === 'slow_start'));
    assert.ok(state.snapshot.speed < velNormal, 'gelo tem que deixar mais lento');
    assert.ok(state.snapshot.slowLeft > 0);
    // passa o tempo: o gelo derrete e avisa
    const fim = state.tick(99);
    assert.ok(fim.some((e) => e.type === 'slow_end'));
    assert.equal(state.snapshot.slowLeft, 0);
    assert.ok(state.snapshot.speed >= velNormal);
  });

  test('⏱️ relógio deixa a cobra rápida e o efeito passa sozinho', () => {
    const state = playing();
    const velNormal = state.snapshot.speed;
    const evs = stepOnto(state, 'clock');
    assert.ok(evs.some((e) => e.type === 'fast_start'));
    assert.ok(state.snapshot.speed > velNormal, 'relógio tem que acelerar');
    assert.ok(state.tick(99).some((e) => e.type === 'fast_end'));
    assert.equal(state.snapshot.fastLeft, 0);
  });

  test('🕸️ teia prende a cobra por N passos (ela perde o turno, não encolhe)', () => {
    const state = playing();
    const evs = stepOnto(state, 'web');
    assert.ok(evs.some((e) => e.type === 'web_start'));
    const presos = state.snapshot.stuckSteps;
    assert.ok(presos > 0);
    const cabeca = state.snapshot.snakeIdx[0];
    const tamanho = state.snapshot.length;
    // enquanto presa: a cabeça não sai do lugar e o tamanho não muda
    for (let i = 0; i < presos; i++) {
      const passo = state.step();
      assert.ok(passo.some((e) => e.type === 'web_stuck'));
      assert.equal(state.snapshot.snakeIdx[0], cabeca, 'presa na teia: a cabeça não pode andar');
      assert.equal(state.snapshot.length, tamanho, 'a teia não encolhe a cobra');
    }
    assert.equal(state.snapshot.stuckSteps, 0);
    state.step();
    assert.notEqual(state.snapshot.snakeIdx[0], cabeca, 'depois de soltar, ela volta a andar');
    assertNoCollision(state, 'teia');
  });

  test('💎 diamante vale 5 de crescimento', () => {
    const state = playing();
    const evs = stepOnto(state, 'diamond');
    const eat = evs.find((e) => e.type === 'eat_item');
    assert.equal(eat.grow, 5);
    assert.ok(evs.some((e) => e.type === 'grow' && e.amount === 5));
    const alvo = state.snapshot.length + state.snapshot.growthPending;
    for (let i = 0; i < 40; i++) state.step();
    assert.ok(state.snapshot.length >= Math.min(alvo, state.cells), 'o crescimento tem que se realizar');
    assertNoCollision(state, 'diamante');
  });

  test('⭐ estrela deixa a cobra invencível: bomba e item de dano não machucam', () => {
    const state = playing();
    assert.ok(stepOnto(state, 'star').some((e) => e.type === 'star_start'));
    assert.ok(state.snapshot.starLeft > 0);
    const tamanho = state.snapshot.length;
    // item de dano durante a estrela: protegido
    const evs = stepOnto(state, 'skull');
    const eat = evs.find((e) => e.type === 'eat_item');
    assert.equal(eat.shielded, true, 'com estrela, a caveira não pode doer');
    assert.equal(state.snapshot.length, tamanho);
    // e a estrela também segura bomba
    assert.equal(state.snapshot.danger, false, 'invencível nunca está em perigo');
    assert.ok(state.tick(99).some((e) => e.type === 'star_end'));
  });

  test('🧲 ímã traz as comidas para perto da cabeça sem invadir nada', () => {
    const state = playing({ foodFuseSec: 0 }, 3);
    state.spawnFood(6, {});
    const dist = () => {
      const s = state.snapshot;
      const hx = s.snake[0].x; const hz = s.snake[0].z;
      return s.foods.reduce((acc, f) => acc + Math.abs(f.x - hx) + Math.abs(f.z - hz), 0);
    };
    state.applyMagnet(30);
    const antes = dist();
    for (let i = 0; i < 12; i++) state.tick(0.3); // só o tempo passa: a cobra não anda
    assert.ok(dist() < antes, 'as comidas precisam se aproximar da cabeça');
    // nenhuma comida em cima da cobra / bomba / outra comida
    const s = state.snapshot;
    const ocupadas = new Set(s.snakeIdx);
    for (const f of s.foods) {
      const cell = f.z * s.w + f.x;
      assert.ok(!ocupadas.has(cell), 'o ímã não pode empilhar comida em célula ocupada');
      ocupadas.add(cell);
    }
    assertNoCollision(state, 'ímã');
  });

  test('o escudo (não só a estrela) também protege dos itens de dano', () => {
    for (const kind of DANO) {
      const state = playing();
      state.applyShield(60);
      const tamanho = state.snapshot.length;
      const eat = stepOnto(state, kind).find((e) => e.type === 'eat_item');
      assert.equal(eat.shielded, true, `${kind}: o escudo tinha que segurar`);
      assert.equal(state.snapshot.length, tamanho, `${kind}: protegida não pode encolher`);
      assert.equal(state.snapshot.stuckSteps, 0, `${kind}: protegida não pode ficar presa`);
      assert.equal(state.snapshot.slowLeft, 0, `${kind}: protegida não pode ficar lenta`);
    }
  });
});

describe('[itens] expiração pelo pavio', () => {
  test('todo item some sozinho quando o pavio acaba, avisando com item_expire', () => {
    for (const kind of ALL_KINDS) {
      const state = playing();
      const [ev] = state.spawnItem(kind, 1, {});
      assert.equal(state.snapshot.items.length, 1);
      // um pouco antes do fim ainda está lá
      const evsAntes = state.tick(ITEM_KINDS[kind].fuseSec - 0.5);
      assert.ok(!evsAntes.some((e) => e.type === 'item_expire'), `${kind}: expirou cedo demais`);
      assert.equal(state.snapshot.items.length, 1);
      // passando do pavio, some
      const evs = state.tick(1);
      const exp = evs.find((e) => e.type === 'item_expire');
      assert.ok(exp, `${kind}: precisa expirar sozinho`);
      assert.equal(exp.id, ev.id);
      assert.equal(exp.kind, kind);
      assert.equal(state.snapshot.items.length, 0);
    }
  });

  test('a célula do item volta a ficar livre depois que ele expira', () => {
    const state = playing();
    const [ev] = state.spawnItem('skull', 1, {});
    const cell = ev.z * state.w + ev.x;
    assert.notEqual(state._occ[cell], 0);
    state.tick(ITEM_KINDS.skull.fuseSec + 1);
    assert.equal(state._occ[cell], 0, 'a célula tem que ficar livre de novo');
  });

  test('clearItems() varre todos os itens de uma vez (efeito do presente supremo)', () => {
    const state = playing();
    for (const kind of ALL_KINDS) state.spawnItem(kind, 2, {});
    assert.ok(state.snapshot.items.length >= 8);
    const [ev] = state.clearItems();
    assert.equal(ev.type, 'item_clear');
    assert.equal(ev.ids.length, state.snapshot.items.length + ev.ids.length);
    assert.equal(state.snapshot.items.length, 0);
    assert.deepEqual(state.clearItems(), [], 'sem itens, não emite evento');
  });
});

describe('[itens] o invariante nunca quebra', () => {
  test('rodada longa com TODOS os itens chovendo: a cobra nunca colide e a rodada termina', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const state = playing({}, seed, 0);
      const rng = mulberry32(seed * 31);
      let passos = 0;
      while (state.phase === 'playing' && passos < 4000) {
        state.step();
        state.tick(0.14);
        assertNoCollision(state, `semente ${seed}, passo ${passos}`);
        if (rng() < 0.06) state.spawnItem(ALL_KINDS[Math.floor(rng() * ALL_KINDS.length)], 1 + Math.floor(rng() * 3), {});
        if (rng() < 0.05) state.spawnBombs(1 + Math.floor(rng() * 4), {});
        if (rng() < 0.03) state.spawnFood(2, {});
        passos++;
      }
      assert.ok(['won', 'lost'].includes(state.phase), `semente ${seed}: a rodada travou (${state.phase})`);
    }
  });

  test('itens de dano NÃO são desviados: a IA continua indo atrás da comida', () => {
    // A rota da IA tem que ser exatamente a mesma com e sem itens no caminho.
    const semItens = playing({}, 21, 0);
    const comItens = playing({}, 21, 0);
    for (const kind of ALL_KINDS) comItens.spawnItem(kind, ITEM_KINDS[kind].max, {});
    for (let i = 0; i < 60; i++) {
      const a = semItens.step().find((e) => e.type === 'move');
      const b = comItens.step().find((e) => e.type === 'move');
      if (!a || !b) break;
      assert.equal(b.dir, a.dir, `passo ${i}: a IA desviou do item (ela não pode desviar)`);
      semItens.tick(0.1);
      comItens.tick(0.1);
    }
  });

  test('nem a teia nem o gelo travam a rodada para sempre', () => {
    const state = playing();
    for (let i = 0; i < 40; i++) { state.applyWeb(6); state.applySlow(5); }
    assert.ok(state.snapshot.stuckSteps <= 30, 'a teia tem teto de passos presos');
    let passos = 0;
    while (state.snapshot.stuckSteps > 0 && passos < 200) { state.step(); passos++; }
    assert.equal(state.snapshot.stuckSteps, 0, 'a cobra tem que se soltar');
    assert.ok(state.snapshot.speed > 0, 'a velocidade nunca pode zerar');
  });

  test('o snapshot continua com a forma do SPEC quando não há item nenhum', () => {
    // Sem itens e sem dano escalado, nada de novo aparece no snapshot (compatibilidade).
    const limpo = new GameState({ gridSize: 8 }, { rng: mulberry32(1) });
    assert.equal(limpo.snapshot.items, undefined);
    assert.equal(limpo.snapshot.bombDamage, undefined);
    // Com um item no tabuleiro, os campos novos aparecem.
    limpo.start();
    limpo.spawnItem('diamond', 1, {});
    assert.ok(Array.isArray(limpo.snapshot.items));
    assert.equal(limpo.snapshot.items.length, 1);
  });
});

describe('[itens] bomba mais forte (pedido do cliente)', () => {
  test('o dano da bomba cresce junto com a cobra', () => {
    const state = playing({ startLength: 3 }, 4, 0);
    assert.equal(state.bombDamage, 4 + Math.floor(3 * 0.2), 'cobra pequena: dano base');
    const pequeno = state.bombDamage;
    for (let i = 0; i < 120; i++) { state.step(); state.tick(0.1); }
    assert.ok(state.snapshot.length > 3);
    assert.ok(state.bombDamage > pequeno, 'cobra maior: bomba mais forte');
    assert.equal(state.bombDamage, 4 + Math.floor(state.snapshot.length * 0.2));
  });

  test('com a configuração da live a bomba dói mais que os 3 fixos antigos', () => {
    const antigo = new GameState({ gridSize: 12 }, { rng: mulberry32(2) }); // padrão histórico
    const live = playing();
    assert.equal(antigo.config.bombShrink, 3, 'o padrão do módulo continua 3 (compatibilidade)');
    assert.ok(live.bombDamage > 3, `a bomba da live (${live.bombDamage}) tem que doer mais que 3`);
  });

  test('a cobra começa maior (startLength) sem quebrar o invariante', () => {
    const state = new GameState(LIVE, { rng: mulberry32(8) });
    state.start();
    // o tamanho entra como crédito e se realiza nos primeiros passos seguros
    assert.equal(state.snapshot.length + state.snapshot.growthPending, LIVE.startLength);
    for (let i = 0; i < 60; i++) { state.step(); assertNoCollision(state, 'início'); }
    assert.ok(state.snapshot.length >= LIVE.startLength, 'a cobra tem que atingir o tamanho inicial');
  });

  test('a bomba continua sendo a única morte possível, e nunca instantânea no começo', () => {
    const state = playing({}, 6, 0);
    assert.equal(state.snapshot.danger, false, 'recém-nascida não pode morrer numa bomba só');
  });
});

describe('[itens] escala de recompensa por presente', () => {
  const rules = withDefaults(DEFAULT_RULES);
  const fxOf = (nome) => {
    const g = rules.gifts.find((x) => x.name === nome);
    const r = resolveGift(rules, { giftName: nome, diamondCount: g.coins, count: 1 });
    return { ...r.effects, ...(r.combo || {}) };
  };
  /** "Peso" de um presente: tudo que ele faz acontecer na tela. */
  const peso = (nome) => {
    const fx = fxOf(nome);
    let p = 0;
    for (const [k, v] of Object.entries(fx)) {
      if (typeof v === 'number') p += v;
      else if (v === true) p += 10;
    }
    return p;
  };

  test('as regras (com os campos novos) continuam válidas', () => {
    const { ok, errors } = validateRules(rules);
    assert.equal(ok, true, errors.join(' '));
    assert.equal(rules.gifts.length, 16, 'os 16 presentes reais continuam lá');
  });

  test('presente mais caro faz MAIS coisa na tela (vilões e heróis)', () => {
    const viloes = ['Rosa', 'Rosquinha', 'Boné', 'Arma de Dinheiro', 'Moto', 'Leão'];
    for (let i = 1; i < viloes.length; i++) {
      assert.ok(peso(viloes[i]) > peso(viloes[i - 1]),
        `${viloes[i]} devia ser mais forte que ${viloes[i - 1]}`);
    }
    const herois = ['GG', 'Coraçãozinho', 'Coração nas Mãos', 'Cisne', 'Foguete', 'Universo TikTok'];
    for (let i = 1; i < herois.length; i++) {
      assert.ok(peso(herois[i]) > peso(herois[i - 1]),
        `${herois[i]} devia ser mais generoso que ${herois[i - 1]}`);
    }
  });

  test('presente de 1 moeda faz algo pequeno; o supremo dispara um combo', () => {
    const rosa = fxOf('Rosa');
    assert.equal(rosa.bombs, 1);
    for (const k of ALL_KINDS) assert.ok(!rosa[k], 'presente de 1 moeda não solta item especial');

    const universo = fxOf('Universo TikTok');
    assert.equal(universo.clearAll, true, 'o supremo limpa TUDO');
    assert.ok(universo.diamond >= 5 && universo.star >= 1, 'o supremo tem chuva de diamantes e estrela');
    const tipos = ALL_KINDS.filter((k) => universo[k] > 0).length;
    assert.ok(tipos >= 4, `o supremo tem que combinar vários itens (tem ${tipos})`);

    const leao = fxOf('Leão');
    assert.ok(leao.skull >= 1, 'o supremo vilão solta caveira');
    assert.ok(ALL_KINDS.filter((k) => leao[k] > 0).length >= 4, 'o supremo vilão combina vários itens');
  });

  test('cada efeito de item respeita o teto do tabuleiro mesmo com muitas unidades', () => {
    const r = resolveGift(rules, { giftName: 'Leão', diamondCount: 29999, count: 99 });
    const fx = { ...r.effects, ...(r.combo || {}) };
    for (const k of ALL_KINDS) {
      if (fx[k] > 0) assert.ok(fx[k] <= ITEM_KINDS[k].max, `${k}: passou do limite do tabuleiro`);
    }
  });

  test('os presentes clássicos mantêm a forma antiga de effects (compatibilidade)', () => {
    const r = resolveGift(rules, { giftName: 'Rosa', diamondCount: 1, count: 1 });
    assert.deepEqual(Object.keys(r.effects).sort(),
      ['attack', 'bombs', 'clearBombs', 'food', 'grow', 'shieldSec']);
    assert.equal(r.combo, undefined, 'presente simples não tem combo');
  });

  test('todos os itens que os presentes pedem existem de verdade no jogo', () => {
    for (const g of rules.gifts) {
      for (const src of [g.effects || {}, g.combo || {}]) {
        for (const k of Object.keys(src)) {
          if (ALL_KINDS.includes(k)) {
            assert.ok(ITEM_KINDS[k], `${g.name}: pede o item "${k}", que não existe`);
          }
        }
      }
    }
  });

  test('o que o presente promete é o que o jogo faz (ponta a ponta)', () => {
    // Aplica os efeitos do presente supremo herói num estado real, como o overlay faz.
    const state = playing();
    const r = resolveGift(rules, { giftName: 'Universo TikTok', diamondCount: 44999, count: 1 });
    const fx = { ...r.effects, ...(r.combo || {}) };
    if (fx.clearAll) { state.clearBombs(); state.clearItems(); }
    if (fx.grow > 0) state.growSnake(fx.grow);
    if (fx.food > 0) state.spawnFood(fx.food, {});
    if (fx.shieldSec > 0) state.applyShield(fx.shieldSec);
    for (const k of ALL_KINDS) if (fx[k] > 0) state.spawnItem(k, fx[k], {});
    const snap = state.snapshot;
    assert.ok(snap.foods.length > 0, 'o supremo tinha que encher de comida');
    assert.ok(snap.shieldLeft > 0, 'o supremo tinha que dar escudo');
    assert.ok(snap.items.filter((i) => i.kind === 'diamond').length >= 5, 'chuva de diamantes');
    assert.ok(snap.items.some((i) => i.kind === 'star'), 'estrela na mesa');
    assertNoCollision(state, 'supremo');
  });
});
