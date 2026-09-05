// Renderer3D — the facade defined in SPEC §7. Owns the WebGL renderer, scene,
// camera framing, post-processing and every visual subsystem:
//   background.js  nebula dome, stars, dust      board.js     tiles, rim, neon, glow
//   snake.js       tapered iridescent tube+head  items.js     apples, bombs, gift sprites
//   effects.js     particle pool + shockwaves    giftPop.js   3D gift billboards
//   leaderOrb.js   avatar orb on a spring        camera.js    portrait-first framing
//
// Renderer-originated UI events (e.g. the red vignette flash on an explosion)
// are delivered through `opts.onEvent({ type, ... })` and also dispatched as a
// DOM CustomEvent 'renderer3d' on the container (detail = same object), so
// main/hud can toggle `body.flash-red` (SPEC §7.1).
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { CELL, ITEM_Y, clamp, disposeObject } from './util.js';
import { Background } from './background.js';
import { Board } from './board.js';
import { Snake } from './snake.js';
import { Items } from './items.js';
import { ParticlePool, ShockwavePool, burstApple, burstGold, burstExplosion, puffExpire, puffClear, confettiRain } from './effects.js';
import { Shield } from './shield.js';
import { GiftPops } from './giftPop.js';
import { LeaderOrb } from './leaderOrb.js';
import { frameCamera, FOV } from './camera.js';

const QUALITY = {
  // [nitidez] 2026-09-04: tetos de pixelRatio elevados. O overlay é capturado pelo OBS e depois
  // reescalado (e o cliente também dá zoom para conferir detalhe): renderizar em 2x numa tela
  // Retina já entregava textura borrada ao ampliar. 3x custa ~2,2x mais pixels que 2x, o que a
  // GPU aguenta neste cenário (uma cena simples, poucos draw calls), e mantém a imagem limpa.
  low: { pixelRatio: 1.5, shadows: false, shadowMap: 1024, bloom: false, particles: 600 },
  medium: { pixelRatio: 2, shadows: true, shadowMap: 2048, bloom: false, particles: 1200 },
  high: { pixelRatio: 3, shadows: true, shadowMap: 4096, bloom: true, particles: 2000 }
};

const PHASE_TINT = { countdown: 0x22d3ee, playing: 0x22d3ee, won: 0xfbbf24, lost: 0xff3355 };

export class Renderer3D {
  /**
   * @param {HTMLElement} container
   * @param {{ gridSize?: number, quality?: 'low'|'medium'|'high', onEvent?: (e: object) => void }} opts
   */
  constructor(container, opts = {}) {
    if (!container) throw new Error('Renderer3D: container is required');
    this.container = container;
    const quality = QUALITY[opts.quality] ? opts.quality : 'high';
    this.quality = quality;
    this.q = QUALITY[quality];
    this.onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;
    this.disposed = false;
    this.w = 0;
    this.h = 0;
    this.phase = 'playing';
    this.shakeAmp = 0;
    this.winTimer = 0;
    this.boardRect = { x: 0, y: 0, w: 0, h: 0 };
    this.lastHeadIdx = -1;
    this.lastExplosion = { x: -1, z: -1, t: -1 };
    this.clock = 0;
    this.width = 0;
    this.height = 0;
    this._tmp = new THREE.Vector3();

    // --- Renderer ---------------------------------------------------------------
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', alpha: false, stencil: false });
    this.renderer = renderer;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, this.q.pixelRatio);
    renderer.setPixelRatio(this.pixelRatio);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = this.q.shadows;
    // r185 deprecates PCFSoftShadowMap (it silently maps to PCFShadowMap and logs a warning).
    renderer.shadowMap.type = THREE.PCFShadowMap;
    // Stats are read after the composer's multiple passes, so reset them ourselves per frame.
    renderer.info.autoReset = false;
    const canvas = renderer.domElement;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.setAttribute('aria-hidden', 'true');
    container.appendChild(canvas);
    this._onContextLost = (e) => { e.preventDefault(); this._emit({ type: 'context_lost' }); };
    this._onContextRestored = () => { this._emit({ type: 'context_restored' }); };
    canvas.addEventListener('webglcontextlost', this._onContextLost, false);
    canvas.addEventListener('webglcontextrestored', this._onContextRestored, false);

    // --- Scene, camera, environment -----------------------------------------------
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.5, 1200);
    this.cameraBase = new THREE.Vector3();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    this.envTex = pmrem.fromScene(room, 0.04).texture;
    this.scene.environment = this.envTex;
    this.scene.environmentIntensity = 0.32;
    disposeObject(room);
    pmrem.dispose();

    // --- Lights --------------------------------------------------------------------
    this.hemi = new THREE.HemisphereLight(0x7dd3fc, 0x08131f, 0.35);
    this.scene.add(this.hemi);
    this.key = new THREE.DirectionalLight(0xfff2dc, 1.5);
    this.key.castShadow = this.q.shadows;
    if (this.q.shadows) {
      this.key.shadow.mapSize.set(this.q.shadowMap, this.q.shadowMap);
      this.key.shadow.bias = -0.0006;
      this.key.shadow.normalBias = 0.025;
      this.key.shadow.radius = 4;
    }
    this.scene.add(this.key, this.key.target);
    this.rimLight = new THREE.DirectionalLight(0x22d3ee, 0.7);
    this.scene.add(this.rimLight, this.rimLight.target);

    // --- Subsystems --------------------------------------------------------------------
    this.background = new Background(this.scene, { quality, pixelRatio: this.pixelRatio });
    this.board = new Board(this.scene, { quality });
    this.pool = new ParticlePool(this.scene, { max: this.q.particles, pixelRatio: this.pixelRatio });
    this.shockwaves = new ShockwavePool(this.scene, 6);
    this.items = new Items(this.scene, { quality, pool: this.pool });
    this.giftPops = new GiftPops(this.scene, { pool: this.pool, shockwaves: this.shockwaves });
    this.orb = new LeaderOrb(this.scene, { quality });
    this.shield = new Shield(this.scene);
    this.snake = null; // created in setBoard (needs the cell count)

    // --- Post-processing --------------------------------------------------------------------
    this.composer = null;
    this.bloom = null;
    if (this.q.bloom) {
      const rt = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, samples: 4 });
      this.composer = new EffectComposer(renderer, rt);
      this.composer.setPixelRatio(this.pixelRatio);
      this.renderPass = new RenderPass(this.scene, this.camera);
      this.bloom = new UnrealBloomPass(new THREE.Vector2(2, 2), 0.45, 0.4, 0.85);
      this.outputPass = new OutputPass();
      this.composer.addPass(this.renderPass);
      this.composer.addPass(this.bloom);
      this.composer.addPass(this.outputPass);
    }

    const size = clamp(Math.round(opts.gridSize || 16), 4, 64);
    this.setBoard(size, size);

    // Keep the framing in sync with the container even if main forgets to call resize().
    this._ro = null;
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => { if (!this.disposed) this.resize(); });
      this._ro.observe(container);
    }
    this._onWindowResize = () => { if (!this.disposed) this.resize(); };
    window.addEventListener('resize', this._onWindowResize);
  }

  // ---------------------------------------------------------------------------
  // Public API (SPEC §7)
  // ---------------------------------------------------------------------------

  resize() {
    if (this.disposed) return;
    const width = this.container.clientWidth || 0;
    const height = this.container.clientHeight || 0;
    if (width < 2 || height < 2) return;
    this.width = width;
    this.height = height;
    this.renderer.setSize(width, height, false);
    if (this.composer) {
      this.composer.setSize(width, height);
    }
    const { rect } = frameCamera(this.camera, this.board.getBounds(), width, height);
    this.cameraBase.copy(this.camera.position);
    this.boardRect = rect;
  }

  /** Board rect in CSS pixels (for the HUD). */
  getBoardScreenRect() {
    return { x: this.boardRect.x, y: this.boardRect.y, w: this.boardRect.w, h: this.boardRect.h };
  }

  setBoard(w, h) {
    w = clamp(w | 0, 2, 64);
    h = clamp(h | 0, 2, 64);
    this.w = w;
    this.h = h;
    this.board.build(w, h);
    if (!this.snake) this.snake = new Snake(this.scene, { quality: this.quality, maxCells: w * h });
    else this.snake.setMaxCells(w * h);
    this.snake.setState({ cells: [], dir: 1, prevDir: 1, progress: 0 });
    this.snake.setApple(null);
    this.items.clear();
    this.background.setBoard(w, h);
    this.orb.snapTo(w / 2, h / 2);
    this.lastHeadIdx = -1;
    // Lights follow the board size.
    const cx = w / 2, cz = h / 2;
    this.key.position.set(cx + w * 0.35, Math.max(w, h) * 1.1 + 6, cz + h * 0.55);
    this.key.target.position.set(cx, 0, cz);
    if (this.q.shadows) {
      const ext = Math.max(w, h) / 2 + 2.5;
      const sc = this.key.shadow.camera;
      sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext;
      sc.near = 1; sc.far = Math.max(w, h) * 3 + 20;
      sc.updateProjectionMatrix();
    }
    this.rimLight.position.set(cx - w * 0.6, 6, cz - h * 0.9);
    this.rimLight.target.position.set(cx, 0, cz);
    this.resize();
  }

  updateSnake({ cells, dir, prevDir, progress, phase }) {
    if (!this.snake) return;
    this.snake.setState({ cells, dir, prevDir, progress, phase });
    if (phase && phase !== this.phase) this.setPhase(phase);
    if (cells && cells.length) {
      const idx = cells[0].z * this.w + cells[0].x;
      if (idx !== this.lastHeadIdx) {
        this.lastHeadIdx = idx;
        this.board.touchTile(cells[0].x, cells[0].z, 1);
      }
    }
  }

  addApple(id, x, z) {
    this.items.addApple(id, x, z);
    this.snake?.setApple({ x, z });
    this.pool.emit({ x: (x + 0.5) * CELL, y: ITEM_Y + 0.2, z: (z + 0.5) * CELL, count: 14, colors: [0xfde68a, 0xffffff, 0xfb7185], speed: 1.2, spread: 1, up: 1.5, life: 0.7, size: 0.25, gravity: -1, drag: 2, fade: 2 });
  }

  /** Golden bonus food (hero gifts). Removed through removeItem(id, reason). */
  addFood(id, x, z, opts = {}) {
    this.items.addFood(id, x, z, opts);
    this.pool.emit({ x: (x + 0.5) * CELL, y: ITEM_Y + 0.2, z: (z + 0.5) * CELL, count: 18, colors: [0xfde68a, 0xfbbf24, 0xffffff], speed: 1.4, spread: 1, up: 1.8, life: 0.8, size: 0.28, gravity: -1, drag: 2, fade: 2 });
  }

  /** Bomb shield on/off: fresnel bubble on the head + emissive pulse on the snake. */
  setShield(active) {
    active = !!active;
    this.shield.setActive(active);
    this.snake?.setShield(active);
  }

  addBomb(id, x, z, meta = {}) {
    this.items.addBomb(id, x, z, meta);
    this.pool.emit({ x: (x + 0.5) * CELL, y: ITEM_Y + 0.2, z: (z + 0.5) * CELL, count: 16, colors: [0x94a3b8, 0xff6a3d, 0xffffff], speed: 1.6, spread: 0.8, up: 1.2, life: 0.6, size: 0.3, gravity: -2, drag: 2, fade: 1 });
  }

  setBombFuse(id, fuseLeftSec) { this.items.setBombFuse(id, fuseLeftSec); }

  // ---------------------------------------------------------------- [itens] itens especiais

  /**
   * Coloca um item especial (⚡🧊🕸️☠️ / 💎⭐🧲⏱️) no tabuleiro, com um jato de partículas
   * na cor dele. Removido por removeItem(id, reason), como qualquer outro item.
   */
  addSpecialItem(id, kind, x, z, meta = {}) {
    this.items.addSpecialItem(id, kind, x, z, meta);
    const colors = this.items.colorsFor(kind);
    const villain = kind === 'bolt' || kind === 'ice' || kind === 'web' || kind === 'skull';
    this.pool.emit({
      x: (x + 0.5) * CELL, y: ITEM_Y + 0.25, z: (z + 0.5) * CELL,
      count: 20, colors, speed: 1.7, spread: 0.85, up: villain ? 0.8 : 1.9,
      life: 0.75, size: 0.3, gravity: villain ? -1 : -2, drag: 2, fade: 1
    });
    this.shockwaves.spawn((x + 0.5) * CELL, ITEM_Y - 0.28, (z + 0.5) * CELL, {
      color: colors[0], radius: 1.5, duration: 0.45
    });
  }

  setItemFuse(id, fuseLeftSec) { this.items.setItemFuse(id, fuseLeftSec); }

  /** 🧲 Ímã: a comida andou uma célula — só reposiciona (sem animação de saída). */
  moveItem(id, x, z) { this.items.moveTo(id, x, z); }

  /** Explosão/coleta com a cara do item: cor própria e tamanho por peso do efeito. */
  itemBurst(kind, x, z) {
    const colors = this.items.colorsFor(kind);
    const wx = (x + 0.5) * CELL;
    const wz = (z + 0.5) * CELL;
    const big = kind === 'skull' || kind === 'star';
    this.pool.emit({
      x: wx, y: ITEM_Y + 0.2, z: wz, count: big ? 150 : 90, colors,
      speed: big ? 7 : 5, speedVar: 0.6, spread: 0.7, up: 2.6, life: 1.0, size: 0.36,
      gravity: -7, drag: 2, fade: 1
    });
    this.shockwaves.spawn(wx, ITEM_Y - 0.28, wz, { color: colors[0], radius: big ? 3.4 : 2.2, duration: 0.6 });
    this.board.touchTile(x, z, 2);
  }

  /** ⭐ Invencibilidade: reaproveita a bolha do escudo, em dourado. */
  setStar(active) {
    this.shield.setActive(!!active);
    this.snake?.setShield(!!active);
  }

  /** 🕸️ Preso na teia: escurece levemente o palco enquanto a cobra não se solta. */
  setWeb(active) {
    this.webbed = !!active;
    this.background.setTint(this.webbed ? 0x94a3b8 : PHASE_TINT[this.phase] ?? 0x22d3ee);
  }

  removeItem(id, reason = 'cleared') {
    const r = this.items.remove(id, reason);
    if (!r) return;
    const wx = (r.x + 0.5) * CELL, wz = (r.z + 0.5) * CELL;
    if (r.type === 'apple') {
      this.snake?.setApple(this.items.getApple());
      if (reason === 'eaten') { burstApple(this.pool, wx, ITEM_Y + 0.2, wz); this.snake?.onEat(); }
      else if (reason === 'expired') puffExpire(this.pool, wx, ITEM_Y + 0.2, wz);
      else puffClear(this.pool, wx, ITEM_Y + 0.2, wz);
      return;
    }
    if (r.type === 'food') {
      if (reason === 'eaten') { burstGold(this.pool, wx, ITEM_Y + 0.2, wz); this.snake?.onEat(); }
      else if (reason === 'expired') puffExpire(this.pool, wx, ITEM_Y + 0.2, wz);
      else puffClear(this.pool, wx, ITEM_Y + 0.2, wz);
      return;
    }
    // [itens] Item especial: a explosão bonita vem de itemBurst() (chamada pelo main com o
    // tipo do item); aqui só tratamos o pavio e a limpeza.
    if (r.type === 'item') {
      if (reason === 'eaten') this.snake?.[r.villain ? 'onHurt' : 'onEat']?.();
      else if (reason === 'expired') puffExpire(this.pool, wx, ITEM_Y + 0.25, wz);
      else puffClear(this.pool, wx, ITEM_Y + 0.25, wz);
      return;
    }
    if (reason === 'eaten') { this._explodeAt(r.x, r.z, 0xff6a3d, 1); this.snake?.onHurt(); }
    else if (reason === 'expired') puffExpire(this.pool, wx, ITEM_Y + 0.25, wz);
    else puffClear(this.pool, wx, ITEM_Y + 0.25, wz);
  }

  explode(x, z, { color = 0xff6a3d, size = 1 } = {}) { this._explodeAt(x, z, color, size); }

  /** Explosion with de-duplication (removeItem('eaten') and explode() may both be called). */
  _explodeAt(x, z, color, size) {
    const le = this.lastExplosion;
    if (le.x === x && le.z === z && this.clock - le.t < 0.15) return;
    le.x = x; le.z = z; le.t = this.clock;
    const wx = (x + 0.5) * CELL, wz = (z + 0.5) * CELL;
    burstExplosion(this.pool, wx, ITEM_Y + 0.2, wz, color, size);
    this.shockwaves.spawn(wx, ITEM_Y - 0.28, wz, { color, radius: 2.6 * size, duration: 0.55 });
    this.shake(size);
    this.board.touchTile(x, z, 2);
    this._emit({ type: 'flash', kind: 'red', x, z });
  }

  giftPop(o) { this.giftPops.pop(o || {}); }

  setLeader(leader) { this.orb.setLeader(leader || null); }

  setPhase(phase) {
    if (!['countdown', 'playing', 'won', 'lost'].includes(phase)) return;
    const prev = this.phase;
    this.phase = phase;
    this.board.setPhase(phase);
    this.snake?.setPhase(phase);
    this.background.setTint(PHASE_TINT[phase]);
    if (phase === 'won' && prev !== 'won') {
      this.winTimer = 6;
      const cx = this.w / 2, cz = this.h / 2;
      this.shockwaves.spawn(cx, ITEM_Y - 0.25, cz, { color: 0xfbbf24, radius: Math.max(this.w, this.h) * 0.8, duration: 1.4 });
      this.pool.emit({ x: cx, y: 2, z: cz, count: 200, colors: [0xfbbf24, 0xfde68a, 0xffffff, 0x34d399], speed: 7, spread: 0.6, up: 4, life: 1.6, size: 0.4, gravity: -5, drag: 1.2, fade: 2 });
      this._emit({ type: 'flash', kind: 'gold' });
    } else if (phase === 'lost' && prev !== 'lost') {
      this.winTimer = 0;
      this.shake(1.6);
      this._emit({ type: 'flash', kind: 'red' });
    } else if (phase === 'countdown' || phase === 'playing') {
      this.winTimer = 0;
    }
  }

  shake(intensity = 1) { this.shakeAmp = Math.max(this.shakeAmp, clamp(intensity, 0, 3)); }

  /**
   * Animate and render one frame.
   * @param {number} dt seconds since the previous frame (clamped to 0.1 s)
   * @param {number} elapsed seconds since start
   */
  frame(dt, elapsed) {
    if (this.disposed) return;
    dt = clamp(Number(dt) || 0, 0, 0.1);
    elapsed = Number(elapsed) || 0;
    this.clock += dt;
    this.renderer.info.reset();
    try {
      // Snake sees the current apple for eye tracking / tongue.
      this.snake?.update(dt, elapsed);
      this.board.update(dt, elapsed);
      this.items.update(dt, elapsed);
      this.giftPops.update(dt);
      this.shockwaves.update(dt);
      if (this.winTimer > 0) {
        this.winTimer -= dt;
        confettiRain(this.pool, this.w, this.h, dt, this.quality === 'low' ? 0.4 : 1);
      }
      this.pool.update(dt);
      this.background.update(dt, elapsed);
      const head = this.snake ? this.snake.getHeadInfo() : null;
      this.orb.update(dt, elapsed, head, { w: this.w, h: this.h });
      this.shield.update(dt, elapsed, head);
      // Screen shake: decaying jitter around the framed camera position.
      if (this.shakeAmp > 0.001) {
        const a = this.shakeAmp * 0.12 * (1 + this.camera.position.distanceTo(this.cameraBase) * 0);
        const s = Math.max(1, this.camera.position.length() / 25);
        this.camera.position.set(
          this.cameraBase.x + (Math.random() - 0.5) * a * s,
          this.cameraBase.y + (Math.random() - 0.5) * a * s,
          this.cameraBase.z + (Math.random() - 0.5) * a * s
        );
        this.shakeAmp *= Math.exp(-6 * dt);
      } else if (this.shakeAmp !== 0) {
        this.shakeAmp = 0;
        this.camera.position.copy(this.cameraBase);
      }
      if (this.composer) this.composer.render(dt);
      else this.renderer.render(this.scene, this.camera);
    } catch (err) {
      // Never let a render error kill the stream loop; report once per second.
      if (!this._lastErr || performance.now() - this._lastErr > 1000) {
        this._lastErr = performance.now();
        console.error('[Renderer3D] frame error', err);
        this._emit({ type: 'error', error: err });
      }
    }
  }

  /** Cheap stats for dev overlays. */
  getStats() {
    const r = this.renderer.info.render;
    return { drawCalls: r.calls, triangles: r.triangles, particles: this.pool.count, quality: this.quality, pixelRatio: this.pixelRatio };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this._ro) this._ro.disconnect();
    window.removeEventListener('resize', this._onWindowResize);
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('webglcontextlost', this._onContextLost);
    canvas.removeEventListener('webglcontextrestored', this._onContextRestored);
    this.snake?.dispose();
    this.shield.dispose();
    this.items.dispose();
    this.giftPops.dispose();
    this.orb.dispose();
    this.pool.dispose();
    this.shockwaves.dispose();
    this.board.dispose();
    this.background.dispose();
    if (this.composer) {
      this.composer.renderTarget1.dispose();
      this.composer.renderTarget2.dispose();
      this.bloom?.dispose();
      this.outputPass?.dispose();
    }
    this.envTex.dispose();
    this.scene.environment = null;
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  }

  _emit(detail) {
    try {
      if (this.onEvent) this.onEvent(detail);
      this.container.dispatchEvent(new CustomEvent('renderer3d', { detail }));
    } catch (err) {
      console.warn('[Renderer3D] event handler failed', err);
    }
  }
}
