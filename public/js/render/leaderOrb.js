// Leader orb (SPEC §7.3): a glowing sphere with the top gifter's avatar that
// trails ~2 cells behind the snake's head on a critically damped spring.
import * as THREE from 'three';
import { clamp, damp, rand, TAU, loadImage, makeCanvas, roundRect, drawAvatar, canvasTexture, truncate, formatCoins, disposeObject } from './util.js';

const HOVER_Y = 1.3;
const TRAIL = 2.0;
const OMEGA = 5.5; // spring angular frequency (critically damped)

export class LeaderOrb {
  constructor(scene, { quality = 'high' } = {}) {
    this.group = new THREE.Group();
    this.group.name = 'leaderOrb';
    scene.add(this.group);
    this.leader = null;
    this.avatarUrl = undefined;
    this.labelKey = '';
    this.pos = new THREE.Vector3(8, HOVER_Y, 8);
    this.vel = new THREE.Vector3();
    this.target = new THREE.Vector3(8, HOVER_Y, 8);
    this.initialized = false;
    this.dim = 1; // 1 = placeholder (dim), 0 = active leader
    this.bobPhase = rand(0, TAU);
    this.avatarImg = null;

    // Glass sphere.
    this.sphereMat = new THREE.MeshPhysicalMaterial({
      color: 0xfff1c2, roughness: 0.12, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.1,
      transparent: true, opacity: 0.32, emissive: 0xfbbf24, emissiveIntensity: 0.35, depthWrite: false, envMapIntensity: 1.4
    });
    this.sphere = new THREE.Mesh(new THREE.SphereGeometry(0.42, 32, 24), this.sphereMat);
    this.sphere.renderOrder = 22;
    this.group.add(this.sphere);

    // Golden rings.
    this.ringMat = new THREE.MeshStandardMaterial({ color: 0xfbbf24, metalness: 1, roughness: 0.2, emissive: 0xf59e0b, emissiveIntensity: 0.9 });
    const ringGeo = new THREE.TorusGeometry(0.55, 0.03, 8, 64);
    this.ring1 = new THREE.Mesh(ringGeo, this.ringMat);
    this.ring1.rotation.x = Math.PI / 2 + 0.35;
    this.ring2 = new THREE.Mesh(ringGeo, this.ringMat);
    this.ring2.rotation.x = Math.PI / 2 - 0.5;
    this.ring2.rotation.y = 1.1;
    this.ring2.scale.setScalar(0.86);
    this.group.add(this.ring1, this.ring2);

    // Orbiting particle ring (small dedicated Points; the effects pool is for bursts).
    const n = quality === 'low' ? 18 : 40;
    const pts = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      pts[i * 3] = Math.cos(a) * 0.7; pts[i * 3 + 1] = Math.sin(a * 3) * 0.08; pts[i * 3 + 2] = Math.sin(a) * 0.7;
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    this.orbitMat = new THREE.PointsMaterial({ color: 0xfde68a, size: 0.07, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true });
    this.orbit = new THREE.Points(pg, this.orbitMat);
    this.orbit.rotation.x = 0.4;
    this.group.add(this.orbit);

    // Avatar sprite inside the sphere.
    this.avatarCanvas = makeCanvas(256, 256);
    this.avatarTex = canvasTexture(this.avatarCanvas);
    this.avatarMat = new THREE.SpriteMaterial({ map: this.avatarTex, transparent: true, depthWrite: false, depthTest: false });
    this.avatarSprite = new THREE.Sprite(this.avatarMat);
    // [celular] 0.7 → 1.0: o orbe perdeu a legenda (abaixo) e passou a ser um PICTOGRAMA — o rosto
    // do líder marcando a cobra. Um pictograma sobrevive à compressão do TikTok; uma letra de 8 px
    // não. Maior para continuar reconhecível no celular.
    this.avatarSprite.scale.set(1.0, 1.0, 1);
    this.avatarSprite.renderOrder = 24;
    this.group.add(this.avatarSprite);

    // [celular] LEGENDA REMOVIDA DA CENA. Medido no palco e normalizado para 1080 de largura (o
    // formato da live), este sprite desenhava as moedas a 11,3 px e o apelido a 7,9 px — de longe o
    // menor texto do overlay, menos da metade do piso de 22 px. Ele escapou da auditoria dos outros
    // dois agentes porque é WebGL, não DOM: nenhuma varredura de CSS o enxerga.
    // Aumentá-lo até 22 px exigiria ~2,8× de escala, criando um cartão gigante perseguindo a cobra
    // pelo meio do tabuleiro — exatamente o oposto de "o tabuleiro é a estrela".
    // A informação NÃO se perdeu: o painel RANKING DA LIVE mostra o mesmo líder (apelido + moedas)
    // a 30 px, na faixa de monetização, onde ele pertence. Aqui fica só o rosto.
    // O canvas e a textura continuam existindo (setLeader/_drawLabel seguem funcionando e são
    // baratos) — apenas nada é adicionado ao grupo, então nada é desenhado sobre o tabuleiro.
    this.labelCanvas = makeCanvas(512, 176);
    this.labelTex = canvasTexture(this.labelCanvas);
    this.labelMat = new THREE.SpriteMaterial({ map: this.labelTex, transparent: true, depthWrite: false, depthTest: false });
    this.labelSprite = new THREE.Sprite(this.labelMat);
    this.labelSprite.scale.set(2.9, 2.9 * (176 / 512), 1);
    this.labelSprite.position.y = -0.98;
    this.labelSprite.renderOrder = 24;
    this.labelSprite.visible = false;

    // Soft light so the orb tints the board a little.
    this.light = quality === 'low' ? null : new THREE.PointLight(0xfbbf24, 0.9, 4, 2);
    if (this.light) this.group.add(this.light);

    this.setLeader(null);
  }

  /** leader: { nickname, avatarUrl, coins } | null */
  setLeader(leader) {
    const prevUrl = this.avatarUrl;
    this.leader = leader ? { nickname: leader.nickname || '', avatarUrl: leader.avatarUrl || null, coins: leader.coins || 0 } : null;
    const url = this.leader ? this.leader.avatarUrl : null;
    if (url !== prevUrl) {
      this.avatarUrl = url;
      this.avatarImg = null;
      this._drawAvatar();
      if (url) {
        loadImage(url).then((img) => {
          if (this.avatarUrl !== url) return; // changed meanwhile
          this.avatarImg = img;
          this._drawAvatar();
        }).catch(() => { /* keep initials */ });
      }
    } else if (!this.leader || !this.avatarImg) {
      this._drawAvatar(); // nickname may have changed (initials)
    }
    const key = this.leader ? `${this.leader.coins}|${this.leader.nickname}` : '';
    if (key !== this.labelKey) {
      this.labelKey = key;
      this._drawLabel();
    }
  }

  _drawAvatar() {
    const c = this.avatarCanvas, ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    const cx = 128, cy = 128, r = 112;
    if (this.leader) {
      drawAvatar(ctx, cx, cy, r, this.avatarImg, this.leader.nickname);
    } else {
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fillStyle = 'rgba(30,41,59,0.9)'; ctx.fill();
      ctx.fillStyle = '#cbd5e1';
      ctx.font = '900 150px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('?', cx, cy + 8);
    }
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU);
    ctx.lineWidth = 10; ctx.strokeStyle = this.leader ? '#fbbf24' : '#64748b'; ctx.stroke();
    this.avatarTex.needsUpdate = true;
  }

  _drawLabel() {
    const c = this.labelCanvas, ctx = c.getContext('2d');
    const W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);
    roundRect(ctx, 8, 8, W - 16, H - 16, 40);
    ctx.fillStyle = 'rgba(8,14,30,0.78)';
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = this.leader ? 'rgba(251,191,36,0.9)' : 'rgba(148,163,184,0.7)';
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (this.leader) {
      ctx.fillStyle = '#fbbf24';
      ctx.font = '900 66px system-ui, -apple-system, "Segoe UI", Roboto, "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
      ctx.fillText(`🪙 ${formatCoins(this.leader.coins)}`, W / 2, H * 0.36);
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 46px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
      ctx.fillText(truncate(this.leader.nickname, 14), W / 2, H * 0.74);
    } else {
      ctx.fillStyle = '#e2e8f0';
      ctx.font = '800 54px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
      ctx.fillText('Mande um presente!', W / 2, H * 0.5);
    }
    this.labelTex.needsUpdate = true;
  }

  /** Reset the spring to a position (new board) without an animated flight. */
  snapTo(x, z) {
    this.pos.set(x, HOVER_Y, z);
    this.vel.set(0, 0, 0);
    this.initialized = true;
  }

  /**
   * @param {number} dt
   * @param {number} elapsed
   * @param {{position: THREE.Vector3, forward: THREE.Vector3, visible: boolean}} head
   * @param {{w:number,h:number}} board
   */
  update(dt, elapsed, head, board) {
    if (head && head.visible) {
      this.target.copy(head.position).addScaledVector(head.forward, -TRAIL);
      // Keep the orb inside the rim so it never floats off-board on the edges.
      this.target.x = clamp(this.target.x, -0.3, board.w + 0.3);
      this.target.z = clamp(this.target.z, -0.3, board.h + 0.3);
    } else {
      this.target.set(board.w / 2, 0, board.h / 2);
    }
    this.target.y = HOVER_Y;
    if (!this.initialized) { this.snapTo(this.target.x, this.target.z); }
    // Critically damped spring, semi-implicit Euler with a bounded step.
    const step = Math.min(dt, 1 / 30);
    const ax = OMEGA * OMEGA * (this.target.x - this.pos.x) - 2 * OMEGA * this.vel.x;
    const ay = OMEGA * OMEGA * (this.target.y - this.pos.y) - 2 * OMEGA * this.vel.y;
    const az = OMEGA * OMEGA * (this.target.z - this.pos.z) - 2 * OMEGA * this.vel.z;
    this.vel.x += ax * step; this.vel.y += ay * step; this.vel.z += az * step;
    this.pos.x += this.vel.x * step; this.pos.y += this.vel.y * step; this.pos.z += this.vel.z * step;
    const bob = Math.sin(elapsed * 2.2 + this.bobPhase) * 0.09;
    this.group.position.set(this.pos.x, this.pos.y + bob, this.pos.z);
    // Lean slightly into the motion.
    this.group.rotation.z = clamp(-this.vel.x * 0.06, -0.25, 0.25);
    this.group.rotation.x = clamp(this.vel.z * 0.06, -0.25, 0.25);
    this.ring1.rotation.z += dt * 0.9;
    this.ring2.rotation.z -= dt * 0.6;
    this.orbit.rotation.y += dt * 1.4;
    // Placeholder is dimmer.
    this.dim = damp(this.dim, this.leader ? 0 : 1, 4, dt);
    const glow = 0.35 + (1 - this.dim) * 0.55 + 0.15 * Math.sin(elapsed * 3);
    this.sphereMat.emissiveIntensity = glow;
    this.sphereMat.opacity = 0.32 - this.dim * 0.1;
    this.ringMat.emissiveIntensity = 0.9 - this.dim * 0.6;
    this.orbitMat.opacity = 0.9 - this.dim * 0.6;
    if (this.light) this.light.intensity = 0.9 - this.dim * 0.6;
  }

  dispose() {
    disposeObject(this.group);
    this.avatarTex.dispose();
    // [celular] labelSprite não está mais no grupo (ver construtor), então disposeObject() não
    // alcança o material dele — descarta-se aqui à mão para não vazar.
    this.labelMat.dispose();
    this.labelTex.dispose();
  }
}
