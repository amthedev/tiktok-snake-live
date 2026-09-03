# TikTok Snake LIVE — Architecture Contract (SPEC)

> Resumo (PT-BR): jogo da cobra 3D autônomo para lives no TikTok. A cobra joga sozinha (IA com ciclo
> hamiltoniano, nunca bate no corpo nem na parede, sempre acha a melhor rota até vencer). Presentes da live
> viram bombas no tabuleiro; a cobra NÃO desvia de bomba — bate, encolhe, e morre quando perde todo o
> tamanho (única derrota). Placar de vitórias × derrotas, bolinha com o rosto de quem mais mandou presente
> seguindo a cobra, e o presente aparece na tela. Formato único: vertical 9:16 (live TikTok).
>
> ⚠️ 2026-09-03 (pedido do cliente): sem sistema de corações; IA cega para bombas; só formato retrato.

This document is the binding contract between the modules. Every implementer MUST follow the names, shapes
and semantics below exactly. When something is unspecified, choose the simplest robust option and document it
in a code comment. Language of all USER-FACING text: **Brazilian Portuguese (pt-BR)**. Code identifiers and
comments: English.

Reference visual base (junior dev prototype, to be surpassed, not copied): `docs/base-junior.html`.

---

## 0. Tech stack & repo layout

* Node.js 22, ESM (`"type": "module"` in package.json). No build step, no bundler, no TypeScript.
* Dependencies already installed: `three@0.185.1`, `tiktok-live-connector@2.4.4`, `ws@8`, `express@5`.
  Do NOT add other runtime dependencies. Tests use `node:test` + `node:assert` (`npm test` → `node --test test/`).
* Three.js is served from `node_modules/three` at URL prefix `/vendor/three/`. Browser import map (in `index.html`):
  ```html
  <script type="importmap">{"imports":{"three":"/vendor/three/build/three.module.js","three/addons/":"/vendor/three/examples/jsm/"}}</script>
  ```

```
package.json            scripts: start (node server/index.js), dev (node --watch server/index.js), test (node --test test/)
.env.example            TIKTOK_USERNAME, PORT, SIGN_API_KEY, TIKTOK_SESSION_ID, TIKTOK_TT_TARGET_IDC, AUTO_CONNECT
README.md               pt-BR: setup, OBS, TikTok, gifts config, tests, troubleshooting
config/gifts.json       gift rules (see §5)
data/stats.json         persisted stats (created on first run; may be missing)
docs/SPEC.md            this file
docs/base-junior.html   original prototype (reference only)
server/index.js         express + ws wiring, API routes
server/tiktok.js        TikTokBridge (EventEmitter) — connection lifecycle, normalization, streak deltas
server/normalize.js     pure functions: raw TikTok v3 proto objects → normalized events (unit-tested)
server/gifts.js         pure gift rules engine (unit-tested)
server/stats.js         StatsStore: wins/losses/history + gifter leaderboard, JSON persistence
server/proxy.js         image proxy handler `/img?u=` (SSRF-safe, cached)
public/index.html       the game overlay (portrait-first, OBS browser source)
public/painel.html      control panel (pt-BR): TikTok connect, simulate events, commands, stats, gift rules editor
public/css/overlay.css  overlay styles
public/css/painel.css   panel styles
public/js/config.js     CONFIG defaults + URL param overrides (§3)
public/js/net.js        WS client with auto-reconnect + tiny event emitter (§6)
public/js/audio.js      WebAudio synth SFX (no external files)
public/js/ai/hamiltonian.js   pure AI module (§4) — importable from Node tests (no DOM, no three)
public/js/game/state.js       pure GameState (§4.4) — importable from Node tests
public/js/render/renderer.js  Renderer3D facade (§7) — may split helpers into public/js/render/*.js
public/js/ui/hud.js           HUD/UI controller (§8)
public/js/main.js             bootstrap + game loop + glue (§9)
public/js/painel.js           control panel logic
test/ai.test.js  test/state.test.js  test/gifts.test.js  test/normalize.test.js
```

Ownership for the parallel build (each agent writes ONLY its files):
* **backend**: package.json scripts, .env.example, README.md, config/gifts.json, server/*, public/painel.html, public/css/painel.css, public/js/painel.js, test/gifts.test.js, test/normalize.test.js
* **ai**: public/js/ai/hamiltonian.js, public/js/game/state.js, test/ai.test.js, test/state.test.js
* **render**: public/js/render/*.js, public/dev/render-demo.html (standalone visual harness)
* **ui**: public/index.html, public/css/overlay.css, public/js/config.js, public/js/net.js, public/js/audio.js, public/js/ui/hud.js, public/js/main.js

---

## 1. Grid conventions (shared by ai, state, render, main)

* Board is `w × h` cells, `w = h = CONFIG.gridSize`, **even**, 8 ≤ size ≤ 24. No internal obstacles (required for
  the Hamiltonian guarantee). Decorative rocks may exist OUTSIDE the board only.
* Cell index: `idx = z * w + x`, `x` = column (0..w-1, +x right), `z` = row (0..h-1, +z toward the camera/bottom).
* Directions (same as the prototype): `DIRS = [{x:0,z:-1} /*0 up*/, {x:1,z:0} /*1 right*/, {x:0,z:1} /*2 down*/, {x:-1,z:0} /*3 left*/]`.
* World space (three.js): `CELL = 1.0`; cell center = `((x + 0.5) * CELL, y, (z + 0.5) * CELL)`; y up. Board centre is
  `(w/2, 0, h/2)`.
* Snake array is head-first: `snake[0]` is the head, `snake[snake.length-1]` the tail. Minimum length 3.

---

## 2. Game rules (the product requirements)

1. The snake plays by itself. It **never** collides with its body or walls. It always picks the best route to the
   apple and eventually **wins** (fills the whole board).
2. Exactly one apple at a time. Eating it grows the snake by 1 and spawns a new apple on a random free cell
   (not snake, not bomb). If no free non-bomb cell exists, the apple is spawned as soon as one frees up.
3. Every TikTok **gift** belongs to a TEAM (client request 2026-09-03): **VILÕES** hurt the snake
   (spawn bombs, direct attack shrink) and **HERÓIS** help it (golden bonus food, instant growth,
   clear bombs, bomb shield). Effects per gift live in §5; the more expensive, the stronger.
   The AI is **blind to bombs by design**: it routes to the nearest food only, and any bomb on its
   route gets hit (that is the show — villain gifts hurt the snake).
4. Eating a bomb: `bombsEaten++` and the snake shrinks by `CONFIG.bombShrink` segments. If the shrink would
   push the length below 3, the snake dies → **DERROTA**. Losing all its size is the ONLY way to lose.
   There is no heart/life system.
5. Bombs have a fuse (`CONFIG.bombFuseSec`, 0 = never expire). When it expires the bomb disappears harmlessly
   (visual puff). At most `CONFIG.maxBombsOnBoard` bombs on the board; extra bombs wait in a FIFO queue and are
   placed as space frees.
6. Win: `snake.length === w*h` → **VITÓRIA**. After win or loss, the round summary is shown and a new round starts
   automatically after `CONFIG.roundRestartDelaySec` (infinite automatic play).
7. Scoreboard: wins × losses (persisted server-side across restarts), current/best streak, last rounds history.
8. Top gifter (most coins in the current live, `leaderScope`): an orb with their avatar + coin total follows the
   snake. Leaderboard top 3 on the HUD.
9. Gifts appear on screen (2D animated card + 3D pop at the bomb cell) — only gifts allowed by `config/gifts.json`
    (`mode: "all"` by default; the streamer will later restrict to a specific list).
10. Chat, likes, follows, shares, viewer count are shown lightly (feed / counters / heart particles) — flavor only.

---

## 3. CONFIG (public/js/config.js)

```js
export const DEFAULTS = {
  gridSize: 16,             // even, 8..24
  baseSpeed: 6,             // cells per second at length 3
  speedPerSegment: 0.03,    // added per extra segment
  maxSpeed: 13,
  bombShrink: 3,            // segments lost per bomb; length - bombShrink < 3 → death
  bombFuseSec: 90,          // 0 = never
  foodFuseSec: 45,          // hero golden food lifetime; 0 = never
  maxFoodOnBoard: 30,
  shieldMaxSec: 120,
  maxBombsOnBoard: 60,
  roundRestartDelaySec: 8,
  countdownSec: 3,          // "3-2-1" before the snake moves
  shortcutMaxFill: 0.5,     // AI: allow apple shortcuts while length < shortcutMaxFill * cells
  quality: 'high',          // 'low' | 'medium' | 'high'  (shadows/bloom/particles)
  obs: false,               // hide dev panel & cursor, OBS-friendly
  audio: true,
  wsUrl: null,              // default: same host, path /ws
  leaderScope: 'live'       // informational; server decides
};
export function loadConfig() → merges DEFAULTS with URL search params (numbers/booleans parsed) and localStorage
  key 'snake.config' (JSON); validates gridSize even & in range; returns frozen object.
```
The server also sends `hello.config` overrides (from env/panel); `main.js` applies them **before** creating the state
(precedence: URL params > server hello > localStorage > DEFAULTS).

---

## 4. AI & game state (pure ESM, no DOM)

### 4.1 `public/js/ai/hamiltonian.js` exports

```js
export const DIRS;                                   // as §1
export function buildCycle(w, h) → Cycle             // throws if w*h odd or (w<2||h<2)
// Cycle = { w, h, n: w*h, pos: Int32Array(n) /* cellIdx → cycle position */, cells: Int32Array(n) /* position → cellIdx */ }
export function distFwd(cycle, aCell, bCell) → number   // (pos[b] - pos[a] + n) % n
export function nextMove(cycle, snake, apple, opts) → Move
// snake: number[] (cell indices, head first, length ≥ 1)
// apple: cell index or -1  — the AI knows NOTHING about bombs (rule §2.3)
// opts: { shortcutMaxFill = 0.5, allowShortcuts = true }
// Move = { cell: number, dir: 0|1|2|3, shortcut: boolean, eatsApple: boolean }
export function safeMoves(cycle, snake, apple) → Array<{cell, dir, dist}>   // exported for tests
export function isHamiltonianCycle(cycle) → boolean  // validation helper
```

Construction of the cycle (w even, h even): row 0 left→right (`(0,0)…(w-1,0)`), then rows 1..h-1 zig-zag over
columns 1..w-1 (row 1 right→left, row 2 left→right, …, row h-1 right→left ending at `(1,h-1)`), then column 0
from `(0,h-1)` up to `(0,1)`, closing at `(0,0)`. Any other valid Hamiltonian cycle is acceptable as long as
`isHamiltonianCycle` passes.

**Safety rule (the invariant that guarantees "never hits the body")**: body cells always have strictly
increasing cycle position from tail to head (cyclically) with total span < n. A neighbour `c` of the head is
*safe* iff `0 < distFwd(head, c) < distFwd(head, anchor)` where `anchor = (c === apple) ? tail : snake[len-2]`
(when growing the tail stays; otherwise the second-to-last segment becomes the tail). For `len === 1`, every
free neighbour is safe. The cycle successor of the head is always safe. `nextMove` MUST only return safe cells.

Move policy:
1. `cands = safeMoves(...)` (never empty).
2. Apple reachable via free arc: `appleAhead = apple >= 0 && 0 < distFwd(head, apple) < distFwd(head, anchorNoGrow)`.
3. If `allowShortcuts && snake.length < shortcutMaxFill * n && appleAhead`: preferred set = candidates with
   `dist <= distFwd(head, apple)`, choose max `dist` (largest safe jump not overshooting the apple).
   Else preferred = the cycle successor (`dist === 1`).
4. Pick from the preferred set: larger `dist` (when shortcuts allowed) or smaller `dist` (when following the
   cycle). Bombs never influence the choice.

### 4.2 Guarantees to test (test/ai.test.js)
* `buildCycle` valid for all even sizes 4..24 (each cell once, consecutive cells 4-adjacent, closed).
* 300 simulated games (mixed sizes 8, 10, 12, 16; seeded PRNG; random bombs on the board that the AI ignores):
  **zero** collisions (body/wall), every game wins within `4*n*n` steps.
* With `bombs` empty: wins on every seed; average steps per apple sanity (< n).
* Perf: 10 000 calls of `nextMove` on 24×24 mid-game < 3 s total.

### 4.3 Deterministic PRNG
`state.js` and tests use an injectable `rng()` (→ [0,1)). Provide `export function mulberry32(seed)` in
`state.js` for tests.

### 4.4 `public/js/game/state.js`

```js
export class GameState {
  constructor(config /* §3 object */, { rng = Math.random, now = () => Date.now() } = {})
  reset(): void               // new round: roundId++, snake length 3 at centre row heading right,
                              // apples=0, bombsEaten=0, bombs cleared, queue cleared, phase='countdown', startedAt=now()
  start(): void               // phase 'countdown' → 'playing'
  step(): GameEvent[]         // one grid step (only when phase==='playing'); applies AI move; returns events
  tick(dtSec): GameEvent[]    // advances bomb fuses (any phase except won/lost), expires bombs, drains queue
  spawnBombs(count, meta = {}): GameEvent[]   // places up to `count` bombs now (respecting maxBombsOnBoard), queues the rest
  spawnFood(count, meta = {}): GameEvent[]    // hero: golden bonus food (grows +1 when eaten; foodFuseSec; overflow dropped)
  growSnake(amount): GameEvent[]              // hero: growth credit realised over the next invariant-safe steps
  applyShield(seconds): GameEvent[]           // hero: bomb immunity, stacking, capped at shieldMaxSec
  attackShrink(amount): GameEvent[]           // villain: immediate shrink (credit first), NEVER fatal
  // All effect methods (and spawnBombs/spawnApple) return [] once the round is won/lost.
  spawnApple(): GameEvent[]   // ensures exactly one apple if a free non-bomb cell exists
  clearBombs(): GameEvent[]   // removes all bombs + queue (panel command)
  get snapshot(): Snapshot
}
// Snapshot (plain data, safe to JSON): {
//   roundId, phase: 'countdown'|'playing'|'won'|'lost', w, h, cells: w*h,
//   snake: [{x,z}], snakeIdx: number[], dir, prevDir,
//   apple: {x,z}|null, bombs: [{id, x, z, fuseLeft /*sec, Infinity if never*/, meta}], bombQueue: number,
//   foods: [{id, x, z, fuseLeft, meta}] /* hero golden food, ids 'f1'… */,
//   shieldLeft /* sec */, growthPending, foodEaten,
//   danger /* true when shieldLeft<=0 && length + growthPending - bombShrink < 3 */,
//   apples, bombsEaten, length, progress /* length/cells 0..1 */, speed /* cells/s */,
//   startedAt, endedAt|null, durationMs, lastMove: Move|null
// }
// GameEvent = { type, ... } with types:
//   'move' {cell, dir, shortcut}                  every step
//   'eat_apple' {x,z, apples, length}
//   'apple_spawn' {x,z}
//   'eat_bomb' {id, x, z, length, shrink, fatal, shielded /* true: shield absorbed it */}
//   'food_spawn' {id, x, z, fuseSec, meta} / 'eat_food' {id, x, z, foodEaten, length, meta} / 'food_expire' {id, x, z}
//   'grow' {amount, pending, length} / 'grow_step' {length, pending}  (credit realised on a safe step)
//   'attack' {shrink, fromCredit, length}  (villain direct damage — NEVER fatal)
//   'shield_start' {seconds} / 'shield_end' {}
//   'bomb_spawn' {id, x, z, fuseSec, meta}
//   'bomb_expire' {id, x, z}
//   'bomb_clear' {ids}
//   'win' {summary} / 'lose' {summary}          summary = { result, apples, bombsEaten, length, durationMs, roundId }
//   'start' {roundId}
```
`speed = clamp(baseSpeed + (length-3)*speedPerSegment, baseSpeed, maxSpeed)`.
Bomb `id` = incrementing integer string `'b12'`; apple id always `'apple'`. `meta` for bombs carries gift info
`{ giftName, giftImageUrl, nickname, avatarUrl }` when spawned by a gift (used by the renderer for the 3D pop).
`step()` when `phase !== 'playing'` returns `[]`. Losing/winning sets `endedAt` and `phase`.

---

## 5. Gift rules v2 — VILÕES × HERÓIS (`config/gifts.json`, `server/gifts.js`)

Every gift has `team` (`villain` | `hero`), `tier` (`normal` | `mega` | `supreme`), per-UNIT
`effects` and a pt-BR `desc` line for the overlay card. 16 REAL TikTok gifts ship as defaults
(well-known coin prices; ids vary by region so matching is by name, case/diacritic-insensitive,
en + pt aliases — plus optional `ids`):

| # | Presente (moedas) | Time | Efeito por unidade |
|---|---|---|---|
| 1 | 🌹 Rosa (1) | 😈 | 1 bomba |
| 2 | 🍦 Casquinha (1) | 😈 | 1 bomba |
| 3 | 🍩 Rosquinha (30) | 😈 | 3 bombas |
| 4 | 🧢 Boné (99) | 😈 | 6 bombas |
| 5 | 🎊 Confete (100) | 😈 | 8 bombas |
| 6 | 💸 Arma de Dinheiro (500) | 😈 mega | 12 bombas + ataque −2 |
| 7 | 🏍️ Moto (2988) | 😈 mega | 20 bombas + ataque −4 |
| 8 | 🦁 Leão (29999) | 😈 supremo | 40 bombas + ataque −6 |
| 9 | 🎮 GG (1) | 😇 | +1 comida dourada |
| 10 | 🫰 Coraçãozinho (5) | 😇 | +2 comidas |
| 11 | 🕊️ Tsuru de Papel (99) | 😇 | cresce +3 |
| 12 | 🫶 Coração nas Mãos (100) | 😇 | +4 comidas, cresce +1 |
| 13 | 🦢 Cisne (699) | 😇 mega | limpa TODAS as bombas |
| 14 | 🌌 Galáxia (1000) | 😇 mega | limpa + escudo 30 s |
| 15 | 🚀 Foguete (20000) | 😇 mega | cresce +10, +6 comidas, escudo 30 s |
| 16 | 🌠 Universo TikTok (44999) | 😇 supremo | cresce +15, +10 comidas, limpa, escudo 60 s |

* Effects scale with `count` (streak deltas) and are capped per event: `EVENT_CAPS = { bombs: 60,
  food: 30, grow: 40, attack: 20, shieldSec: 120 }`; bombs additionally by `rule.maxPerEvent ??
  fallback.maxBombsPerEvent` (30).
* `mode: "all"` → unmatched gifts use the villain `fallback` formula
  (`bombsPerUnit + floor(coins / bombsPerCoins)` bombs per unit). `mode: "allowlist"` → unmatched
  gifts have NO effects; `unlisted.show` / `unlisted.countCoins` control card and leaderboard.
* `resolveGift(rules, {giftId, giftName, diamondCount, count})` → `{ show, matched, ruleName,
  countCoins, team, tier, effects: {bombs, food, grow, attack, shieldSec, clearBombs}, desc,
  bombs, effect /* legacy mirrors */ }`.
* v1 files (a `default` section) are auto-migrated to the v2 defaults on load. `validateRules`
  gives pt-BR errors; rules hot-reload via `PUT /api/gifts`.
* Attack order applied by the overlay: clearBombs → attack → grow → food → bombs → shield.

## 6. Network protocol (WebSocket at `/ws`, JSON text frames)

Every message: `{ "type": string, "ts": epochMs, ...payload }`.

### 6.1 Server → overlay/panel
| type | payload |
|---|---|
| `hello` | `{ config: Partial<CONFIG>, stats: Stats, leaderboard: Leaderboard, tiktok: TikTokStatus, rules: GiftRules }` sent right after connect |
| `tiktok_status` | `TikTokStatus = { status: 'disconnected'|'connecting'|'connected'|'waiting_live'|'error', username: string|null, roomId: string|null, message: string|null, viewers: number }` |
| `gift` | `GiftEvent` (below) |
| `chat` | `{ user: UserRef, text }` |
| `like` | `{ user: UserRef, count, total }` |
| `follow` / `share` | `{ user: UserRef }` |
| `member` | `{ user: UserRef }` (rate-limited to ≤ 2/s server-side) |
| `viewers` | `{ count }` |
| `stats` | `Stats` (after every round end / reset) |
| `leaderboard` | `Leaderboard` (after every counted gift / reset) |
| `command` | `{ action: 'new_round'|'pause'|'resume'|'spawn_bomb'|'spawn_apple'|'clear_bombs'|'set_config'|'reload', payload?: any }` |
| `rules` | `GiftRules` (after save) |

```ts
UserRef = { userId: string, uniqueId: string, nickname: string, avatarUrl: string|null }  // avatarUrl already proxied: "/img?u=<encoded>"
GiftEvent = {
  id: string,                 // unique per event
  user: UserRef,
  giftId: string, giftName: string, giftImageUrl: string|null /* proxied */,
  diamondCount: number,       // coins per unit
  count: number,              // NEW units in this event (delta), 0 only when streakEnd closes an already-counted streak
  repeatCount: number,        // running total of the streak
  coins: number,              // diamondCount * count
  streakEnd: boolean,
  rule: { show, matched, ruleName, team: 'villain'|'hero', tier: 'normal'|'mega'|'supreme',
          effects: { bombs, food, grow, attack, shieldSec: number, clearBombs: boolean },
          desc: string|null, bombs, effect /* legacy mirrors */ }
}
Stats = { wins, losses, rounds, currentStreak /* +n wins or -n losses */, bestWinStreak,
          history: Array<{ roundId, result: 'win'|'loss', apples, bombsEaten, length, durationMs, endedAt, topGifter: UserRef&{coins}|null }> /* newest first, max 50 */ }
Leaderboard = { scope: 'live', roomId: string|null, leader: Gifter|null, top: Gifter[] /* max 10, desc coins */,
                teams: { villain: { coins: number, top: Gifter[] /* ≤3 by villainCoins */ },
                         hero:    { coins: number, top: Gifter[] /* ≤3 by heroCoins */ } } }
Gifter = UserRef & { coins: number, gifts: number, villainCoins: number, heroCoins: number, lastAt: epochMs }
```

### 6.2 Overlay → server
| type | payload |
|---|---|
| `round_start` | `{ roundId }` |
| `round_end` | `{ roundId, result: 'win'|'loss', apples, bombsEaten, length, durationMs }` → server records, broadcasts `stats` |
| `snapshot` | `Snapshot` subset `{ roundId, phase, length, danger, apples, bombs: bombs.length, progress }` every 1 s (panel display) |

### 6.3 HTTP API (JSON)
```
GET  /                      overlay        GET /painel      control panel
GET  /img?u=<url>           image proxy    (§ proxy rules)
GET  /api/status            { tiktok: TikTokStatus, stats, leaderboard, clients: n }
POST /api/tiktok/connect    { username }   → starts connection (also persisted as current username in data/stats.json:settings)
POST /api/tiktok/disconnect
GET  /api/stats             Stats          POST /api/stats/reset
GET  /api/leaderboard       Leaderboard    POST /api/leaderboard/reset
GET  /api/gifts             GiftRules      PUT  /api/gifts  GiftRules (validated, saved to config/gifts.json, broadcast `rules`)
POST /api/command           { action, payload } → broadcast `command`
POST /api/sim/gift          { nickname, uniqueId?, giftName, giftId?, count=1, diamondCount=1, avatarUrl?, giftImageUrl?, streak?: boolean }
                            → goes through the SAME pipeline as a real gift (normalize → streak → rules → leaderboard → broadcast)
POST /api/sim/chat          { nickname, text }        POST /api/sim/like { nickname, count }
POST /api/sim/follow        { nickname }              POST /api/sim/share { nickname }
```
Simulated users get deterministic ids `sim:<uniqueId>`; if `avatarUrl` is missing the server provides a generated
SVG data-URI avatar (initials on a colored circle) — no external services.

### 6.4 Image proxy (`server/proxy.js`)
`GET /img?u=<absolute http(s) URL>`: only `https:` (and `http:` for non-private hosts); reject private/loopback
IPs and non-image content types; 5 s timeout; max 3 MB; in-memory LRU cache (200 entries, 10 min) ;
responds with `Cache-Control: public, max-age=600` and `Access-Control-Allow-Origin: *`. `data:` URIs are NOT
proxied — `UserRef.avatarUrl` may be a `data:image/svg+xml;...` URI directly (sim users).

### 6.5 TikTok bridge (`server/tiktok.js`)
* `new TikTokBridge({ rules, stats, log })`, `.connect(username)`, `.disconnect()`, `.status` (TikTokStatus),
  events: `'status'`, `'gift'`, `'chat'`, `'like'`, `'follow'`, `'share'`, `'member'`, `'viewers'`.
* Uses `import { TikTokLiveConnection, WebcastEvent, ControlEvent, UserOfflineError, SignatureRateLimitError } from 'tiktok-live-connector'`
  with options `{ enableExtendedGiftInfo: true, processInitialData: false, signApiKey: process.env.SIGN_API_KEY || undefined, session?: cookie bundle from env }`.
* Raw v3 payload shapes (verified in `node_modules/tiktok-live-proto/dist/web/v3.d.ts`):
  * gift: `{ giftId: string, repeatCount: number, repeatEnd: number, groupId: string, user: User, gift?: { id, name, type, diamondCount, image?: { urlList: string[] } }, extendedGiftInfo?: { id, name, diamond_count, image?: { url_list: string[] } } }`
  * user: `{ id: string, nickname, displayId /* = uniqueId */, avatarThumb?: { urlList }, avatarMedium?: { urlList }, avatarLarge?: { urlList } }`
  * chat: `{ user, content }` ; like: `{ user, count, total }` ; roomUser: `{ total: string /* viewers */, ranks: [{ user, score }] }`
  * follow / share are emitted by the connector as `WebcastEvent.FOLLOW` / `WebcastEvent.SHARE` with `{ user }`.
  * `normalize.js` MUST be defensive: also accept legacy/v1 names (`uniqueId`, `profilePicture.urls`, `profilePictureUrl`, `giftDetails.{giftName,diamondCount,giftType,giftImage.giftPictureUrl}`, `comment`, `likeCount/totalLikeCount`, `viewerCount`).
* Streaks: `giftType === 1` gifts arrive repeatedly with increasing `repeatCount` and a final `repeatEnd`. Track
  `key = userId:giftId:groupId → lastCount`; `count = max(0, repeatCount - lastCount)`; on `repeatEnd` delete the key.
  Non-streakable gifts: `count = max(1, repeatCount)`, `streakEnd = true`. Keys expire after 60 s of inactivity.
* Reconnect: on `disconnected`/`error` retry with backoff 5 s → 60 s (cap); on `UserOfflineError` go to
  `waiting_live` and poll `fetchIsLive()` every 60 s (`waitUntilLive`); on `SignatureRateLimitError` wait 90 s.
  `streamEnd` → `waiting_live`. Env `AUTO_CONNECT=true` + `TIKTOK_USERNAME` connects at boot.
* Leaderboard scope `live`: when connected roomId changes, `stats.resetLeaderboard(roomId)` (persisted).

---

## 7. Renderer — `public/js/render/renderer.js`

```js
import * as THREE from 'three';
export class Renderer3D {
  constructor(container: HTMLElement, opts: { gridSize: number, quality: 'low'|'medium'|'high' })
  resize(): void                                       // also re-frames the camera (§7.2)
  setBoard(w, h): void                                  // (re)build board; called on reset if size changed
  updateSnake({ cells: {x,z}[], dir, prevDir, progress: 0..1, phase }): void   // every frame; interpolate like the prototype
  addApple(id, x, z): void
  addBomb(id, x, z, meta: { fuseSec: number|Infinity, giftImageUrl?: string|null, nickname?: string }): void
  setBombFuse(id, fuseLeftSec): void                    // optional per-frame update for blink rate (may be called each frame)
  removeItem(id, reason: 'eaten'|'expired'|'cleared'): void
  explode(x, z, { color?: number, size?: number }): void
  giftPop({ imageUrl, nickname, count, x, z, effect }): void   // 3D billboard rising from the cell, ~2.5 s; 'mega' = bigger + sparkles
  setLeader(leader: { nickname, avatarUrl, coins } | null): void  // follower orb (§7.3)
  setPhase(phase: 'countdown'|'playing'|'won'|'lost'): void
  shake(intensity = 1): void
  frame(dt: number, elapsed: number): void             // animate + render (called by main.js rAF)
  dispose(): void
}
```

### 7.1 Visual bar (must clearly surpass the prototype)
* Three r185 ESM; `WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })`, `outputColorSpace = SRGBColorSpace`,
  ACES tone mapping, `PCFSoftShadowMap`. Environment lighting via `RoomEnvironment` + `PMREMGenerator`.
* Post-processing (quality 'high'): `EffectComposer` + `RenderPass` + `UnrealBloomPass` (subtle, strength ≈ 0.45,
  threshold ≈ 0.85) + `OutputPass`. 'medium': no bloom; 'low': no shadows, fewer particles, pixelRatio 1.
* Board: glossy tiles with subtle checker (two emerald tones), bevelled rim with an emissive neon edge (cyan/blue),
  soft glow ring under the board, animated nebula/starfield background (shader or layered points), floating dust motes.
* Snake: continuous tube (`CatmullRomCurve3` + `TubeGeometry`, radius tapering toward the tail), iridescent
  physical material (clearcoat), animated scale-stripe pattern (procedural texture via canvas), a proper head
  (eyes with pupils that look toward the apple, blinking, forked tongue flicker near apples, small crown).
  Reuse geometry buffers wisely: dispose old TubeGeometry each rebuild (like the prototype) or use a fixed max
  segment count — no leaks (heap must be flat over a 10-minute run).
* Apple: shiny red sphere with stem+leaf, gentle bob + spin, soft red point light, sparkle ring.
* Bomb: black metallic sphere, lit fuse with spark particle, red blinking emissive that accelerates as fuse runs
  out; gift image sprite (if any) hovering above it for the first 3 s.
* Effects: eat apple = green/gold sparkle burst; eat bomb = explosion (particles + shockwave ring + screen shake +
  red vignette flash via a DOM overlay class `body.flash-red` toggled by main/hud, renderer may just emit an event);
  bomb expiry = grey puff; win = golden confetti rain + snake glow pulse; loss = desaturate snake, red flash.
* Particles use a single `THREE.Points` pool (max 2000) — no per-particle meshes.
* Target 60 fps at 1080×1920 on a mid-range GPU; ≤ 300 draw calls.

### 7.2 Camera framing (portrait ONLY — single format by client request 2026-09-03)
The overlay targets exactly 1080×1920 (9:16), the TikTok LIVE format. `PerspectiveCamera` (fov ≈ 36°), looking at
the board from the front-top (elevation ≈ 55°). `resize()` must solve the camera distance/offset so that the board
(with rim) fits inside the horizontal 92 % of the viewport width AND inside the vertical **band**
`[0.20, 0.74]` of the viewport height (the same band whatever the window aspect — a mis-sized OBS source shows
the board smaller, never re-laid-out); the board centre projects to the centre of that band. Use `camera.setViewOffset` or shift the look-at target along the screen-up vector; verify by
projecting the four board corners each resize. Expose `getBoardScreenRect()` → `{x,y,w,h}` in CSS pixels for the HUD.

### 7.3 Leader orb
A glowing sphere (radius 0.42 cells) hovering 1.3 cells above the ground, trailing ~2 cells behind the head with a
critically-damped spring (never teleports), gentle bob and a slow orbiting particle ring. The avatar is drawn on a
circular canvas texture (proxied image; fallback = initials) mapped on a `Sprite` inside a golden ring; a second
label sprite beneath shows `🪙 <coins formatted pt-BR>` and the nickname (max 14 chars + …). `setLeader(null)` shows
a dimmer placeholder orb with `?` and the label `Mande um presente!`. Texture reloads only when `avatarUrl` changes;
the label re-renders when `coins` changes.

### 7.4 `public/dev/render-demo.html`
Standalone page that imports `Renderer3D`, builds a fake snake walking the perimeter, spawns apples/bombs on keys
(`1`,`2`,`3` gift pop, `L` leader toggle, `W`/`X` win/loss) so the renderer can be checked without the game.

---

## 8. HUD / UI — `public/js/ui/hud.js`

```js
export function createHud(root: HTMLElement, opts: { obs: boolean, formatNumber }) → Hud
Hud = {
  update(snapshot): void                 // length first (the snake's life — red pulse when snapshot.danger),
                                         // apples, progress %, bomb count, round no, timer, speed
  setStats(stats): void                  // VITÓRIAS × DERROTAS table + streak + last 5 results (✓/✗ chips)
  setLeaderboard(lb): void               // top 3 with avatars + coins; highlight #1
  showGift(giftEvent): void              // queued animated card (≤ 1 visible at a time, ~4 s each, streak cards update in place by user+gift)
  pushChat({ user, text }): void         // feed of last 5 (auto-fade after 12 s)
  showLike({ user, count }): void        // floating hearts near the like counter (throttle ≤ 10/s)
  showSocial(kind: 'follow'|'share'|'member', user): void   // small toast
  showToast(text, kind: 'info'|'warn'|'error'|'success'): void
  showCountdown(roundId, seconds): Promise<void>   // "RODADA n" + 3-2-1
  showRoundEnd(summary, nextInSec, stats): Promise<void>  // WIN/LOSS panel with confetti (CSS) + next-round timer
  setViewers(n): void
  setTiktokStatus(status): void          // pill: AO VIVO @user / conectando… / aguardando live / erro
  setConnection(online: boolean): void   // WS connection pill
  flash(kind: 'red'|'gold'|'green'): void
}
```
Layout (portrait 1080×1920; use `clamp()`/`vw`/`vh`, no fixed px widths):
* 0–10 %: title "COBRA 3D · AO VIVO" + TikTok status pill + viewers.
* 10–20 %: scoreboard (VITÓRIAS n ✕ DERROTAS n, streak), status row (length = life), progress bar "Rodada n · 43 %".
* 20–74 %: board (canvas behind everything; keep DOM elements out of this band except transient gift cards/toasts).
* 74–86 %: leaderboard top 3 + CTA "🌹 Mande um presente para soltar bombas!" (subtle pulse).
* 86–100 %: keep nearly empty (TikTok's own chat overlay covers it on phones) — only the faint chat feed.
* Typography: Google Fonts are NOT allowed (offline OBS); use system stack with strong weights; big numbers in
  tabular monospace (`font-variant-numeric: tabular-nums`). Glassmorphism panels (blur, 1px light border), neon accents
  (cyan `#22d3ee`, gold `#fbbf24`, rose `#fb7185`, emerald `#34d399`). Everything must remain legible when the video is
  compressed by TikTok (min font ≈ 22 px at 1080 width; high contrast; no thin fonts).
* `obs: true` → `body.obs` hides the dev panel, cursor and any debug text.
* Dev panel (non-OBS): mini panel with buttons (Rosa, Galáxia, Leão, chat, like, nova rodada, pausar) that call
  the sim API — the same as `painel.html` but tiny; hotkeys `1` apple, `2` bomb, `3` sim gift Rosa, `4` sim gift Leão,
  `N` new round, `P` pause/resume, `H` toggle HUD.

Audio (`public/js/audio.js`): `createAudio(enabled)` → `{ play(name: 'eat'|'bomb'|'expire'|'gift'|'mega'|'win'|'lose'|'tick'|'start'), setEnabled(b) }`
WebAudio synth only; resumes AudioContext on first user gesture or immediately in OBS.

---

## 9. `public/js/main.js` — orchestration

1. `config = loadConfig()`; create `net`, `hud`, `audio`; wait for `hello` (max 2 s, else proceed offline with defaults);
   merge `hello.config`; create `GameState` + `Renderer3D`.
2. Round lifecycle: `state.reset()` → renderer.setPhase('countdown') → `hud.showCountdown()` → `state.start()` →
   send `round_start`. On `win`/`lose` event: renderer.setPhase, audio, `hud.showRoundEnd(summary, delay, stats)`,
   send `round_end`, wait `roundRestartDelaySec`, loop.
3. Loop: rAF; `dt` clamped ≤ 0.1 s; `progress += state.snapshot.speed * dt`; while `progress ≥ 1` → `progress -= 1`,
   `events = state.step()`, dispatch events to renderer/hud/audio; `state.tick(dt)` events likewise;
   `renderer.updateSnake({... progress})`; `renderer.frame(dt, elapsed)`; `hud.update(snapshot)` throttled to 10 Hz;
   send `snapshot` to server at 1 Hz.
4. Net events: `gift` → `hud.showGift` (if `rule.show`), `audio.play(rule.effect==='mega'?'mega':'gift')`,
   `state.spawnBombs(rule.bombs, meta)` → for each `bomb_spawn` event `renderer.addBomb`, and one `renderer.giftPop`
   at the first bomb cell (or at a random free cell if `bombs === 0` but `show`); `leaderboard` → `hud.setLeaderboard`,
   `renderer.setLeader(lb.leader)`; `stats` → `hud.setStats`; `command` → act; `chat/like/follow/share/member/viewers` → hud.
5. Pause: `paused` flag stops `step()`/`tick()` but keeps rendering.
6. Errors: wrap loop in try/catch; on exception show a red toast and keep rendering (never freeze the stream).
   Auto-reload the page after 60 s of repeated exceptions in OBS mode.

---

## 10. Definition of done (verification the integrator will run)
* `npm test` passes (ai, state, gifts, normalize).
* `npm start` serves `/`, `/painel`, `/vendor/three/build/three.module.js`, `/ws` connects, `hello` arrives.
* Overlay at 1080×1920 and 1920×1080 has no console errors, 60 fps in Chrome, board framed inside the band.
* `POST /api/sim/gift` shows the card, spawns bombs, updates the leaderboard and the orb; a streak of 10 roses
  produces exactly 10 bombs and one card updating "×10".
* The snake never dies except from bombs; a 12×12 round with no bombs wins; a round with many bombs loses when
  the shrink would push the length below 3; stats persist across a server restart.
