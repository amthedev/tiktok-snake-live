# 🐍 Cobra 3D · TikTok LIVE

Jogo da cobra 3D **autônomo** para transmitir ao vivo no TikTok. A cobra joga sozinha e **nunca bate
no corpo nem na parede** (IA com ciclo hamiltoniano — matematicamente garantido). Quem assiste
escolhe um lado mandando **presentes**:

- 😈 **VILÕES** atrapalham: soltam **bombas** e mordem a cobra. Ela não desvia — **bate, encolhe**,
  e se perder todo o tamanho, **morre** (única forma de derrota).
- 😇 **HERÓIS** ajudam: **comida dourada**, crescimento na hora, **limpar bombas** e **escudo**.

O placar de **VITÓRIAS × DERROTAS** fica na tela, o ranking mostra a guerra **Vilões × Heróis**
(barra de cabo de guerra + top 3 de cada lado), e quem mais mandou presentes ganha uma **bolinha
com o seu rosto** seguindo a cobra.

Formato único: **vertical 1080×1920 (9:16)** — o formato da live do TikTok.

## Como rodar

Precisa do [Node.js](https://nodejs.org) 22 ou mais novo.

```bash
npm install
npm start
```

- **Jogo (overlay):** http://localhost:3000/ — é essa página que vai para a live.
- **Painel de controle:** http://localhost:3000/painel — conectar no TikTok, simular presentes,
  ver placar, editar regras de presentes.

## Como conectar na live do TikTok

1. Comece a live no TikTok (pelo celular, ou via TikTok LIVE Studio).
2. Abra o painel (http://localhost:3000/painel), digite o **@usuario** da conta que está ao vivo e
   clique em **Conectar**.
3. Pronto: presentes, chat, curtidas e novos seguidores da live chegam no jogo em tempo real.

Também dá para deixar automático criando um arquivo `.env` (copie de `.env.example`):

```
TIKTOK_USERNAME=seuusuario
AUTO_CONNECT=true
```

> A conexão usa a biblioteca não-oficial `tiktok-live-connector`, que lê os mesmos dados que
> qualquer espectador da live recebe. Sem login e sem senha. O plano gratuito do serviço de
> assinatura (Euler Stream) tem limite de conexões por dia; se aparecer erro de limite, espere
> alguns minutos ou crie uma chave em eulerstream.com e coloque `SIGN_API_KEY=...` no `.env`.

## Como colocar na live (OBS / TikTok LIVE Studio)

1. Adicione uma fonte **Navegador** (Browser Source).
2. URL: `http://localhost:3000/?obs=1` · Largura **1080** · Altura **1920**.
3. O `?obs=1` esconde o painel de testes e o cursor.

## Regras do jogo

| Situação | O que acontece |
|---|---|
| Presente vilão 😈 | Solta bombas (e os grandes ainda mordem a cobra) |
| Presente herói 😇 | Comida dourada, crescimento, limpa bombas ou escudo |
| Cobra come maçã/comida | Cresce +1 e continua |
| Bomba no caminho | A cobra **bate** e encolhe (−3 segmentos) |
| Tamanho acabou | 💀 **DERROTA** — placar atualiza e nova rodada começa sozinha |
| Tabuleiro cheio | 🏆 **VITÓRIA** — placar atualiza e nova rodada começa sozinha |

As bombas têm pavio: somem sozinhas depois de um tempo se a cobra não passar por elas.

## Os 16 presentes (config/gifts.json)

Presentes REAIS do TikTok — quanto mais caro, mais forte o efeito:

| 😈 VILÕES | Efeito | 😇 HERÓIS | Efeito |
|---|---|---|---|
| 🌹 Rosa (1) | 1 bomba | 🎮 GG (1) | +1 comida dourada |
| 🍦 Casquinha (1) | 1 bomba | 🫰 Coraçãozinho (5) | +2 comidas |
| 🍩 Rosquinha (30) | 3 bombas | 🕊️ Tsuru de Papel (99) | cresce +3 |
| 🧢 Boné (99) | 6 bombas | 🫶 Coração nas Mãos (100) | +4 comidas +1 |
| 🎊 Confete (100) | 8 bombas | 🦢 Cisne (699) | limpa TODAS as bombas |
| 💸 Arma de Dinheiro (500) | 12 bombas, morde −2 | 🌌 Galáxia (1000) | escudo 30 s + limpa |
| 🏍️ Moto (2988) | 20 bombas, morde −4 | 🚀 Foguete (20000) | +10, 6 comidas, escudo |
| 🦁 Leão (29999) | 👑 40 bombas, morde −6 | 🌠 Universo TikTok (44999) | 🌌 +15, 10 comidas, limpa, escudo 60 s |

Presente que não está na lista vira bomba pelo valor (1 bomba + 1 a cada 10 moedas). Para
restringir só aos da lista, troque `mode` para `"allowlist"` no painel. Tudo editável em
`config/gifts.json` (times, efeitos, quantidades) sem mexer em código.

## Testes

```bash
npm test
```

107 testes cobrem a IA (300 jogos simulados sem nenhuma colisão), as regras de encolher/morrer,
os efeitos de herói (comida, crescimento, escudo) e vilão (bombas, ataque), o placar por times,
as regras de presente e a normalização dos eventos do TikTok.

## Estrutura

```
server/          servidor (express + ws + ponte TikTok + placar persistente em data/stats.json)
public/          jogo (overlay), painel, renderização 3D (three.js), IA, HUD
config/gifts.json  regras dos presentes
docs/SPEC.md     contrato técnico completo (em inglês)
```
