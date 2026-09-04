# Decisões de produto — layout de live e monetização (04/09/2026)

Decisões tomadas com o cliente (Allan) para a reformulação do overlay. Servem de referência
para qualquer ajuste futuro: mudar isso muda a receita da live, não é só estética.

## 1. Palco 9:16 travado
O overlay tem proporção fixa 9:16, centralizado, com letterbox. Motivo: o que o streamer vê
no navegador precisa ser exatamente o que vai ao ar no TikTok, em qualquer tamanho de janela.

## 2. Zona segura (medidas oficiais do TikTok, 1080×1920)
O app do TikTok cobre ~10% do topo (barra de perfil) e ~21% da base (comentários, botões,
barra de presentes). Portanto:
- 0–11%   : zona morta, nada essencial
- 11–20%  : placar VITÓRIAS × DERROTAS, rodada, status
- 20–72%  : TABULEIRO (a estrela; só elementos transitórios por cima, nunca no centro)
- 72–79%  : faixa de monetização (metas, ranking, chamadas)
- 79–100% : zona morta (chat nativo do TikTok)

## 3. Metas coletivas → ALTERNAR vilão/herói
A cada meta batida, o prêmio alterna: uma dá bônus aos heróis (escudo/comida), a próxima dá
caos dos vilões (chuva de bombas).
**Por quê:** a maioria dos presentes reais é barata e vilã (Rosa domina as lives medidas). Se a
meta só premiasse heróis, metade do público ficaria sem objetivo. Alternando, os dois lados
sempre têm uma meta próxima, e a tensão "vai vir bomba ou escudo?" segura o espectador —
tempo de tela é o que converte em presente.

## 4. Chat → só mensagens especiais
Não replicamos o chat inteiro (o TikTok já o desenha por cima; duplicar é desperdício de tela).
Aparecem apenas mensagens de quem mandou presente / destaques.
**Por quê:** cria a recompensa mais eficiente de todas — *presente = seu nome aparece na tela* —
e os outros espectadores veem isso acontecendo.

## 5. Princípios de alerta
- Fila única, um alerta por vez, nunca no centro do tabuleiro.
- Prioridade: presente > seguidor > compartilhamento > entrada.
- Entradas em rajada são agrupadas ("👋 +12 pessoas chegaram").
- Presente caro (mega/supremo) ganha alerta campeão em destaque: é o que faz outros imitarem.
- Ensinar o EFEITO, não o nome: "🌹 Rosa = 1 bomba", "🦁 Leão = 40 bombas!".

## 6. DOIS rankings: o da RODADA e o da LIVE
São coisas diferentes e a tela diz qual é qual:
- **Duelo da RODADA** (barra de cabo de guerra, no HUD): zera a cada rodada nova. É a disputa
  do momento — quem entrar agora vê um placar que ainda dá para virar.
- **RANKING DA LIVE** (cartão no carrossel de metas): moedas totais desde o começo da
  transmissão. Só zera quando muda de sala (roomId) ou no botão do painel.

**Por quê:** um ranking único resolve mal os dois papéis. Se ele zerasse, quem gastou muito
perderia o troféu; se nunca zerasse, o duelo ficaria decidido cedo e ninguém mais tentaria
virar. Com os dois, o vilão que chegou na rodada 40 ainda pode ganhar A RODADA, e quem gastou
a live inteira continua no pódio.

A meta coletiva usa as moedas de herói da LIVE (progresso acumulado): uma meta que zerasse a
cada rodada praticamente nunca seria batida.

## 7. Estado da partida mora no SERVIDOR (F5 não perde nada)
O jogo era só do navegador: recarregar a página reiniciava a rodada. Agora o overlay manda
`snapshot` (1 Hz) e o servidor guarda a rodada corrente em `data/stats.json` (escrita com
debounce). No `hello`, o servidor devolve esse estado e o overlay RETOMA: mesma rodada, mesmo
cronômetro, metas e rankings no ponto em que estavam. Estado sem snapshot há mais de 5 min —
ou de uma rodada já terminada — é descartado e começa rodada nova.

O tabuleiro em si (posição de cada célula da cobra) NÃO é replicado: a cobra é autônoma, e
o que o público percebe é o número da rodada, o cronômetro, as metas e os rankings. Replicar
célula a célula custaria muito mais banda e código para um ganho que ninguém vê.

## 8. Um DONO da partida, os outros são espelhos
O **primeiro overlay conectado é o DONO**; qualquer outro entra em **modo espelho** e só exibe.
Só o dono tem `round_start` / `round_end` / `snapshot` aceitos pelo servidor.

**Por quê:** `round_end` incrementa vitórias/derrotas e as metas acumulam moedas. Com o overlay
do OBS e uma aba de teste abertas ao mesmo tempo, os dois mandariam o mesmo fim de rodada e o
placar contaria **em dobro**. A eleição acontece no servidor (não dá para confiar em quem
chegou primeiro do lado do navegador), e o papel vai no `hello` e numa mensagem `role`.

Se o dono cai (F5, OBS fechado, queda de rede), o servidor promove o overlay mais antigo ainda
conectado e avisa com `role: {promoted: true}` — a partida continua de onde parou, porque o
estado mora no servidor.

## 9. Itens especiais e a bomba mais forte (04/09/2026)

Pedidos do cliente, transcritos do áudio: *"a bomba é muito fraquinha ainda"*, *"em vez de só
ter bombas, maçãs especiais e maçã normal, deveria ter outras coisas também"* e *"quando a
pessoa mandar um presente maior ela se sentir mais recompensada"*.

### 9.1 Quanto a bomba passou a doer — e por que não é só "o dobro"

O pedido literal era dobrar a força da bomba. **Medimos antes de decidir** (simulação de
rodadas completas com presentes chegando no ritmo de uma live real) e o resultado foi claro:

| Modelo | Live calma | Live média | Live agitada | p10 (rodadas mais curtas) |
|---|---|---|---|---|
| Atual (dano 3 fixo, cobra nasce com 3) | 59 s | 18 s | 13 s | **3,9 s** |
| "Só dobrar" (dano 5 fixo, cobra nasce com 3) | 18 s | 12 s | 8 s | **2,4 s** ❌ |
| **Escolhido: 4 + 20 % do tamanho, cobra nasce com 10** | **45 s** | **19 s** | **14 s** | **6,7 s** ✅ |

Só aumentar o número fixo é a **pior** opção: a cobra nasce com tamanho 3, então uma bomba já
a matava de cara — as rodadas passavam a durar 2 a 3 segundos e o público não via jogo nenhum.

**A decisão:** o dano acompanha o tamanho da cobra — `bombShrink + ⌊tamanho × bombShrinkPct⌋`,
com `bombShrink: 4` e `bombShrinkPct: 0.2` — e a cobra **nasce com `startLength: 10`**.

Assim: numa cobra grande a bomba arranca 8, 10, 12 segmentos (dói de verdade, que era a
reclamação); numa cobra pequena ela nunca mata sozinha logo no começo. As rodadas duram de
14 a 45 segundos numa live ativa (nem instantâneas nem eternas), a cobra chega a 14–18 de
tamanho — bem mais do que os 9 de antes — e o público vê 3 a 5 bombas explodirem por rodada,
cada uma como um acontecimento, não como um arranhão.

Esses valores moram em `public/js/config.js` (a configuração da live). O `state.js` mantém os
padrões históricos do SPEC (dano 3, cobra 3) para não quebrar nada que o crie "pelado".

### 9.2 Os 8 itens novos

4 de dano e 4 de bônus, cada um com visual, som e texto pt-BR próprios:

| | Item | O que faz | Pavio | Máx. |
|---|---|---|---|---|
| 😈 | ⚡ Raio | encolhe 8 de uma vez | 7 s | 6 |
| 😈 | 🧊 Gelo | deixa a cobra lenta (45 % da velocidade) por 5 s | 14 s | 4 |
| 😈 | 🕸️ Teia | prende a cobra por 6 passos | 16 s | 4 |
| 😈 | ☠️ Caveira | dano pesado: 14 | 10 s | 3 |
| 😇 | 💎 Diamante | cresce +5 | 20 s | 8 |
| 😇 | ⭐ Estrela | invencível por 8 s (bomba e item de dano não machucam) | 12 s | 3 |
| 😇 | 🧲 Ímã | puxa as comidas até a cobra por 8 s | 12 s | 2 |
| 😇 | ⏱️ Relógio | deixa a cobra rápida (1,8×) por 8 s | 14 s | 3 |

**Regras que não se negociam:** todo item tem pavio (some sozinho), tem limite por tipo no
tabuleiro, e **a IA não desvia dos itens de dano** — ela continua indo atrás da comida e bate
neles de propósito, que é o que dá graça. Nada disso pode quebrar o invariante do ciclo
hamiltoniano: a cobra nunca colide (coberto em `test/items.test.js`).

### 9.3 Escala de recompensa: presente caro tem que SENTIR diferente

A régua por faixa de preço:

- **1–30 moedas** → 1 efeito simples (1 bomba, 1 comida)
- **~100 moedas** → efeito maior + o primeiro item especial (⚡ raio, 💎 diamante)
- **500–3.000** → bombas + itens fortes (🧊 gelo, 🕸️ teia) ou bônus (⭐ estrela, 🧲 ímã)
- **20.000+** → combo: vários itens ao mesmo tempo
- **supremo** → tudo junto (o Universo TikTok limpa o tabuleiro, cresce +15, 10 comidas,
  chuva de 💎, ⭐ invencibilidade, 🧲 e ⏱️)

Os dois presentes supremos guardam esse extra no campo **`combo`** (mesmas chaves de
`effects`), aplicado logo depois: assim `effects` continua com a forma antiga — nada quebra
para quem já lia esse formato — e o espetáculo novo entra por cima.

### 9.4 Seguidor com foto
O alerta de quem começou a seguir é um card próprio, bem maior que o de entrada: foto grande
com anel roxo pulsando, "💜 Fulano" e "COMEÇOU A SEGUIR!". Sem foto, cai nas iniciais
coloridas. Fica 4,2 s na tela (mais que os outros alertas).
