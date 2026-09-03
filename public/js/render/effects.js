// Particle effects: ONE THREE.Points pool (max 2000 particles, SPEC §7.1) driven
// on the CPU, plus a tiny pool of reusable shockwave rings.
import * as THREE from 'three';
import { clamp, rand, TAU, disposeObject } from './util.js';

const PARTICLE_VERT = /* glsl */`
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aAlpha;
  uniform float uPixelRatio;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    // Perspective size attenuation; aSize is in world units-ish.
    gl_PointSize = aSize * uPixelRatio * (220.0 / max(1.0, -mv.z));
    gl_PointSize = clamp(gl_PointSize, 0.0, 96.0);
  }
`;

const PARTICLE_FRAG = /* glsl */`
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float d = length(p) * 2.0;
    if (d > 1.0) discard;
    // Soft disc with a hot centre.
    float a = smoothstep(1.0, 0.25, d);
    float core = smoothstep(0.55, 0.0, d) * 0.6;
    gl_FragColor = vec4(vColor * (1.0 + core), a * vAlpha);
  }
`;

/**
 * Pooled particle system. Particles have position, velocity, colour, size,
 * life, gravity and drag. Dead particles are hidden by alpha 0 and compacted
 * lazily: the draw range covers [0, high-water mark].
 */
export class ParticlePool {
  constructor(scene, { max = 2000, pixelRatio = 1 } = {}) {
    this.max = max;
    this.count = 0; // number of live particles (compacted)
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.size0 = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.life = new Float32Array(max);
    this.life0 = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.fade = new Uint8Array(max); // 0 = fade at end only, 1 = shrink+fade, 2 = twinkle

    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    this.alphaAttr = new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('aColor', this.colAttr);
    geo.setAttribute('aSize', this.sizeAttr);
    geo.setAttribute('aAlpha', this.alphaAttr);
    geo.setDrawRange(0, 0);
    // Particles live around the board; a generous fixed sphere avoids per-frame
    // bounding computations and never culls.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e4);

    this.material = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      uniforms: { uPixelRatio: { value: pixelRatio } },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 50;
    scene.add(this.points);
    this._tmpColor = new THREE.Color();
  }

  setPixelRatio(pr) { this.material.uniforms.uPixelRatio.value = pr; }

  /**
   * Emit `count` particles.
   * opts: { x,y,z, count, colors: number[]|number, speed, speedVar, spread (0..1 sphere vs. up-cone),
   *         up (extra upward velocity), life, lifeVar, size, sizeVar, gravity, drag, fade, jitter }
   */
  emit(o) {
    const count = Math.max(0, o.count | 0);
    const colors = Array.isArray(o.colors) ? o.colors : [o.colors ?? 0xffffff];
    const speed = o.speed ?? 3;
    const speedVar = o.speedVar ?? 0.5;
    const spread = o.spread ?? 1;
    const up = o.up ?? 0;
    const life = o.life ?? 0.8;
    const lifeVar = o.lifeVar ?? 0.4;
    const size = o.size ?? 0.35;
    const sizeVar = o.sizeVar ?? 0.4;
    const gravity = o.gravity ?? -6;
    const drag = o.drag ?? 1.5;
    const fade = o.fade ?? 1;
    const jitter = o.jitter ?? 0.05;
    const c = this._tmpColor;
    for (let n = 0; n < count; n++) {
      if (this.count >= this.max) return; // pool full: drop extras
      const i = this.count++;
      const i3 = i * 3;
      // Random direction: blend between full sphere and upward cone.
      const theta = rand(0, TAU);
      const phi = Math.acos(rand(-1, 1));
      let dx = Math.sin(phi) * Math.cos(theta);
      let dy = Math.cos(phi);
      let dz = Math.sin(phi) * Math.sin(theta);
      dy = dy * spread + (1 - spread) * Math.abs(dy);
      const s = speed * (1 + rand(-speedVar, speedVar));
      this.pos[i3] = o.x + rand(-jitter, jitter);
      this.pos[i3 + 1] = o.y + rand(-jitter, jitter);
      this.pos[i3 + 2] = o.z + rand(-jitter, jitter);
      this.vel[i3] = dx * s;
      this.vel[i3 + 1] = dy * s + up;
      this.vel[i3 + 2] = dz * s;
      c.setHex(colors[(Math.random() * colors.length) | 0]);
      this.col[i3] = c.r;
      this.col[i3 + 1] = c.g;
      this.col[i3 + 2] = c.b;
      const sz = size * (1 + rand(-sizeVar, sizeVar));
      this.size[i] = sz;
      this.size0[i] = sz;
      this.alpha[i] = 1;
      const l = Math.max(0.05, life * (1 + rand(-lifeVar, lifeVar)));
      this.life[i] = l;
      this.life0[i] = l;
      this.grav[i] = gravity;
      this.drag[i] = drag;
      this.fade[i] = fade;
    }
  }

  update(dt) {
    let i = 0;
    while (i < this.count) {
      const l = (this.life[i] -= dt);
      if (l <= 0) {
        // Swap-remove with the last live particle.
        const last = --this.count;
        if (i !== last) this._copy(last, i);
        continue;
      }
      const i3 = i * 3;
      const k = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i3] *= k;
      this.vel[i3 + 1] = this.vel[i3 + 1] * k + this.grav[i] * dt;
      this.vel[i3 + 2] *= k;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      const t = l / this.life0[i]; // 1 → 0
      const mode = this.fade[i];
      if (mode === 1) {
        this.alpha[i] = clamp(t * 1.6, 0, 1);
        this.size[i] = this.size0[i] * (0.35 + 0.65 * t);
      } else if (mode === 2) {
        this.alpha[i] = clamp(t * 1.4, 0, 1) * (0.6 + 0.4 * Math.sin(l * 40 + i));
      } else {
        this.alpha[i] = clamp(t * 2.5, 0, 1);
      }
      i++;
    }
    this.points.geometry.setDrawRange(0, this.count);
    // Upload only the live prefix.
    const n3 = Math.max(1, this.count * 3);
    this.posAttr.addUpdateRange(0, n3); this.posAttr.needsUpdate = true;
    this.colAttr.addUpdateRange(0, n3); this.colAttr.needsUpdate = true;
    this.sizeAttr.addUpdateRange(0, Math.max(1, this.count)); this.sizeAttr.needsUpdate = true;
    this.alphaAttr.addUpdateRange(0, Math.max(1, this.count)); this.alphaAttr.needsUpdate = true;
  }

  _copy(from, to) {
    const f3 = from * 3, t3 = to * 3;
    for (let k = 0; k < 3; k++) {
      this.pos[t3 + k] = this.pos[f3 + k];
      this.vel[t3 + k] = this.vel[f3 + k];
      this.col[t3 + k] = this.col[f3 + k];
    }
    this.size[to] = this.size[from];
    this.size0[to] = this.size0[from];
    this.alpha[to] = this.alpha[from];
    this.life[to] = this.life[from];
    this.life0[to] = this.life0[from];
    this.grav[to] = this.grav[from];
    this.drag[to] = this.drag[from];
    this.fade[to] = this.fade[from];
  }

  clear() { this.count = 0; this.points.geometry.setDrawRange(0, 0); }

  dispose() { disposeObject(this.points); }
}

/** Expanding additive rings on the ground (explosions, mega gifts). */
export class ShockwavePool {
  constructor(scene, size = 6) {
    this.group = new THREE.Group();
    this.group.name = 'shockwaves';
    scene.add(this.group);
    this.geo = new THREE.RingGeometry(0.72, 1.0, 64);
    this.rings = [];
    for (let i = 0; i < size; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.DoubleSide, toneMapped: false
      });
      const mesh = new THREE.Mesh(this.geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      mesh.renderOrder = 40;
      this.group.add(mesh);
      this.rings.push({ mesh, mat, t: 0, dur: 0.6, maxR: 3, active: false });
    }
  }

  spawn(x, y, z, { color = 0xff6a3d, radius = 3, duration = 0.6 } = {}) {
    let r = this.rings.find((q) => !q.active) || this.rings[0];
    r.active = true;
    r.t = 0;
    r.dur = duration;
    r.maxR = radius;
    r.mat.color.setHex(color).multiplyScalar(2.2); // > 1 so bloom catches it
    r.mesh.position.set(x, y, z);
    r.mesh.visible = true;
  }

  update(dt) {
    for (const r of this.rings) {
      if (!r.active) continue;
      r.t += dt;
      const k = r.t / r.dur;
      if (k >= 1) { r.active = false; r.mesh.visible = false; continue; }
      const e = 1 - Math.pow(1 - k, 3); // ease-out cubic
      const s = 0.2 + e * r.maxR;
      r.mesh.scale.set(s, s, 1);
      r.mat.opacity = (1 - k) * 0.9;
    }
  }

  dispose() { disposeObject(this.group); }
}

// ---------------------------------------------------------------------------
// Ready-made bursts used by the renderer facade.
// ---------------------------------------------------------------------------
export const PALETTES = {
  apple: [0x86efac, 0x34d399, 0xfde68a, 0xfbbf24, 0xffffff],
  bomb: [0xff5a1f, 0xffb020, 0xff2d2d, 0xfff1b8, 0x7c2d12],
  expire: [0x94a3b8, 0x64748b, 0xcbd5e1],
  clear: [0x22d3ee, 0x67e8f9, 0xffffff],
  confetti: [0xfbbf24, 0xfb7185, 0x22d3ee, 0x34d399, 0xa78bfa, 0xffffff, 0xf97316],
  gift: [0xfbbf24, 0xfde68a, 0xffffff, 0xfb7185],
  heroGift: [0x34d399, 0x6ee7b7, 0xfde68a, 0xfbbf24, 0xffffff],
  villainGift: [0xff2d2d, 0xff6a3d, 0xffb020, 0xfb7185],
  goldFood: [0xfde68a, 0xfbbf24, 0xf59e0b, 0xffffff],
  spark: [0xffb020, 0xff6a00, 0xfff3c4]
};

export function burstApple(pool, x, y, z, scale = 1) {
  pool.emit({ x, y, z, count: Math.round(70 * scale), colors: PALETTES.apple, speed: 4.5, spread: 0.6, up: 2.5, life: 0.9, size: 0.34, gravity: -7, drag: 2.2, fade: 1 });
  pool.emit({ x, y, z, count: Math.round(20 * scale), colors: [0xffffff, 0xfde68a], speed: 1.2, spread: 1, up: 3, life: 1.2, size: 0.18, gravity: -1.5, drag: 1, fade: 2 });
}

export function burstExplosion(pool, x, y, z, color = 0xff6a3d, size = 1) {
  pool.emit({ x, y, z, count: Math.round(140 * size), colors: PALETTES.bomb, speed: 7 * size, speedVar: 0.6, spread: 0.7, up: 3, life: 1.0, size: 0.42, gravity: -9, drag: 2.0, fade: 1 });
  pool.emit({ x, y, z, count: Math.round(50 * size), colors: [color, 0xffffff], speed: 2.5, spread: 1, up: 1, life: 0.35, size: 0.9, gravity: 0, drag: 4, fade: 1 });
  pool.emit({ x, y, z, count: Math.round(40 * size), colors: [0x3f3f46, 0x52525b, 0x27272a], speed: 1.5, spread: 1, up: 2.2, life: 1.6, size: 0.7, gravity: 0.6, drag: 1.2, fade: 1 });
}

export function puffExpire(pool, x, y, z) {
  pool.emit({ x, y, z, count: 36, colors: PALETTES.expire, speed: 1.2, spread: 1, up: 1.4, life: 1.1, size: 0.55, gravity: 0.4, drag: 1.5, fade: 1 });
}

export function puffClear(pool, x, y, z) {
  pool.emit({ x, y, z, count: 26, colors: PALETTES.clear, speed: 2.5, spread: 0.8, up: 2, life: 0.7, size: 0.3, gravity: -2, drag: 2, fade: 1 });
}

export function giftSparkle(pool, x, y, z, count = 24, colors = PALETTES.gift) {
  pool.emit({ x, y, z, count, colors, speed: 2.2, spread: 0.7, up: 2.5, life: 1.0, size: 0.3, gravity: -3, drag: 1.5, fade: 2, jitter: 0.25 });
}

/** Golden burst for an eaten bonus food (hero gifts). */
export function burstGold(pool, x, y, z, scale = 1) {
  pool.emit({ x, y, z, count: Math.round(80 * scale), colors: PALETTES.goldFood, speed: 5, spread: 0.6, up: 2.8, life: 1.0, size: 0.36, gravity: -7, drag: 2.2, fade: 1 });
  pool.emit({ x, y, z, count: Math.round(26 * scale), colors: [0xffffff, 0xfde68a], speed: 1.4, spread: 1, up: 3.2, life: 1.4, size: 0.2, gravity: -1.2, drag: 1, fade: 2 });
}

/** Golden confetti rain across the board area (call every frame while winning). */
export function confettiRain(pool, w, h, dt, intensity = 1) {
  const n = Math.round(220 * intensity * dt);
  for (let i = 0; i < n; i++) {
    pool.emit({
      x: rand(-1, w + 1), y: rand(6, 9), z: rand(-1, h + 1), count: 1, colors: PALETTES.confetti,
      speed: 0.8, spread: 1, up: 0, life: 3.2, lifeVar: 0.3, size: 0.42, sizeVar: 0.3,
      gravity: -2.2, drag: 1.4, fade: 2, jitter: 0.1
    });
  }
}
