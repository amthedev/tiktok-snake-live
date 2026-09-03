// The snake: a tapered, iridescent tube rebuilt every frame into preallocated
// buffers (no per-frame allocations, no leaks) plus an expressive head with
// tracking eyes, blinking, a forked tongue and a small crown.
//
// Motion model (same as the prototype, SPEC §7): the head advances from its
// cell by `progress` along `dir`; every other segment lerps toward the segment
// in front of it by `progress`. The resulting points are smoothed with a
// cardinal (Catmull-Rom with tension) spline.
import * as THREE from 'three';
import { DIRS, CELL, ITEM_Y, clamp, lerp, smoothstep, damp, rand, TAU, makeCanvas, canvasTexture, disposeObject } from './util.js';

// Body gradient stops (converted to linear by THREE.Color): mint → cyan → indigo.
const GRAD = [new THREE.Color(0x84cc16), new THREE.Color(0x22d3ee), new THREE.Color(0x8b5cf6)];
const BASE_RADIUS = 0.29;
const TENSION = 0.45;

/** Procedural scale pattern: lighter belly band + rows of overlapping scales. */
function makeScaleTexture() {
  const S = 256;
  const c = makeCanvas(S, S);
  const ctx = c.getContext('2d');
  // Base: mid grey-white so the vertex colour dominates; lighter belly in the centre (u = 0.5).
  const g = ctx.createLinearGradient(0, 0, S, 0);
  g.addColorStop(0, '#7f8f8a');
  g.addColorStop(0.32, '#9aaba5');
  g.addColorStop(0.5, '#c9d6d1');
  g.addColorStop(0.68, '#9aaba5');
  g.addColorStop(1, '#7f8f8a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  // Dorsal stripe (u = 0 / u = 1 is the back).
  ctx.fillStyle = 'rgba(40,70,90,0.18)';
  ctx.fillRect(0, 0, S * 0.12, S);
  ctx.fillRect(S * 0.88, 0, S * 0.12, S);
  // Scales: 3 rows per cell along v (y), 12 around (x), staggered.
  const rows = 3, cols = 12;
  const sw = S / cols, sh = S / rows;
  for (let r = -1; r <= rows; r++) {
    for (let k = -1; k <= cols; k++) {
      const x = k * sw + (r % 2 ? sw / 2 : 0);
      const y = r * sh;
      ctx.beginPath();
      ctx.arc(x + sw / 2, y + sh * 0.35, sw * 0.62, 0, TAU);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = 'rgba(15,35,45,0.28)';
      ctx.stroke();
    }
  }
  const tex = canvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

export class Snake {
  constructor(scene, { quality = 'high', maxCells = 256 } = {}) {
    this.scene = scene;
    this.quality = quality;
    this.radial = quality === 'low' ? 8 : 14;
    this.ringBudget = quality === 'low' ? 1400 : 2600;
    this.maxCells = 0;
    this.group = new THREE.Group();
    this.group.name = 'snake';
    scene.add(this.group);

    // Game-side state (set by updateSnake).
    this.cells = [];
    this.dir = 1;
    this.prevDir = 1;
    this.progress = 0;
    this.phase = 'playing';
    this.appleCell = null;   // {x,z} | null
    this.appleWorld = new THREE.Vector3();
    this.hasApple = false;
    this.sat = 1;            // 1 = colourful, 0 = grey (loss)
    this.bulges = [];        // swallowed-apple bulges travelling down the body {s, amp}
    this.headScalePulse = 0;
    this.headAngle = 0;
    this.headAngleInit = false;
    this.roll = 0;
    this.blinkT = -1;        // <0 idle; otherwise 0..blinkDur
    this.blinkDur = 0.16;
    this.nextBlink = 2 + rand(0, 3);
    this.tongueTimer = rand(2, 5);
    this.tongueBurst = 0;
    this.headPos = new THREE.Vector3();
    this.headFwd = new THREE.Vector3(1, 0, 0);
    this.visible = false;
    this.totalLen = 0;
    this.shielded = false;   // bomb shield active → emerald/cyan emissive pulse
    this.shieldMix = 0;      // smoothed 0..1
    this._shieldColA = new THREE.Color(0x059669); // deep emerald
    this._shieldColB = new THREE.Color(0x0e7490); // deep cyan
    this._shieldScratch = new THREE.Color();

    // --- Materials ------------------------------------------------------------
    this.scaleTex = makeScaleTexture();
    this.bodyMat = new THREE.MeshPhysicalMaterial({
      vertexColors: true,
      map: this.scaleTex,
      bumpMap: this.scaleTex,
      bumpScale: 0.3,
      roughness: 0.42,
      metalness: 0.04,
      clearcoat: 0.3,
      clearcoatRoughness: 0.4,
      iridescence: quality === 'low' ? 0 : 0.12,
      iridescenceIOR: 1.3,
      iridescenceThicknessRange: [200, 500],
      emissive: 0x0f3d2e,
      emissiveIntensity: 0.18,
      envMapIntensity: 0.3
    });
    this.headColor = new THREE.Color(0x84cc16);
    this.headMat = new THREE.MeshPhysicalMaterial({
      color: this.headColor.clone(),
      roughness: 0.42,
      metalness: 0.04,
      clearcoat: 0.3,
      clearcoatRoughness: 0.4,
      iridescence: quality === 'low' ? 0 : 0.12,
      iridescenceIOR: 1.3,
      iridescenceThicknessRange: [200, 500],
      emissive: 0x0f3d2e,
      emissiveIntensity: 0.18,
      envMapIntensity: 0.3
    });

    this._buildHead();
    this.setMaxCells(maxCells);
  }

  // ---------------------------------------------------------------------------
  // Buffers
  // ---------------------------------------------------------------------------

  /** Allocate tube buffers for up to `n` cells (called on board resize). */
  setMaxCells(n) {
    n = Math.max(4, n | 0);
    if (n === this.maxCells) return;
    this.maxCells = n;
    if (this.tube) {
      this.group.remove(this.tube);
      this.tube.geometry.dispose();
      this.tube = null;
    }
    // Ring budget bounds the vertex count regardless of snake length.
    this.maxRings = this.ringBudget + 8;
    const R = this.radial + 1; // seam duplicated for UVs
    const vCount = this.maxRings * R;
    this.pos = new Float32Array(vCount * 3);
    this.nor = new Float32Array(vCount * 3);
    this.uv = new Float32Array(vCount * 2);
    this.col = new Float32Array(vCount * 3);
    const iCount = (this.maxRings - 1) * this.radial * 6;
    const idx = new Uint32Array(iCount);
    let o = 0;
    for (let r = 0; r < this.maxRings - 1; r++) {
      for (let k = 0; k < this.radial; k++) {
        const a = r * R + k, b = a + 1, c = a + R, d = c + 1;
        // Counter-clockwise seen from outside: (c-a) = along the tube, (b-a) = around the ring.
        idx[o++] = a; idx[o++] = b; idx[o++] = c;
        idx[o++] = b; idx[o++] = d; idx[o++] = c;
      }
    }
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.norAttr = new THREE.BufferAttribute(this.nor, 3).setUsage(THREE.DynamicDrawUsage);
    this.uvAttr = new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('normal', this.norAttr);
    geo.setAttribute('uv', this.uvAttr);
    geo.setAttribute('color', this.colAttr);
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.setDrawRange(0, 0);
    // Fixed bounding sphere covering any board (no per-frame recomputation).
    const side = Math.sqrt(n) + 4;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(side / 2, 0, side / 2), side);
    this.tube = new THREE.Mesh(geo, this.bodyMat);
    this.tube.castShadow = true;
    this.tube.receiveShadow = true;
    this.tube.frustumCulled = false;
    this.group.add(this.tube);
    // Control point scratch: max cells + 2 virtual end points.
    this.ctrl = new Float32Array((n + 2) * 3);
    // Per-ring scratch (centre, tangent, arc length).
    this.ringC = new Float32Array(this.maxRings * 3);
    this.ringS = new Float32Array(this.maxRings);
  }

  // ---------------------------------------------------------------------------
  // Head
  // ---------------------------------------------------------------------------
  _buildHead() {
    const head = new THREE.Group();
    head.name = 'snakeHead';
    this.head = head;
    this.group.add(head);
    this.headInner = new THREE.Group(); // scaled for the "gulp" pulse
    head.add(this.headInner);
    const inner = this.headInner;

    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.36, 32, 24), this.headMat);
    skull.scale.set(1.0, 0.82, 1.18);
    skull.castShadow = true;
    inner.add(skull);
    const snout = new THREE.Mesh(new THREE.SphereGeometry(0.27, 24, 18), this.headMat);
    snout.scale.set(0.92, 0.62, 0.9);
    snout.position.set(0, -0.06, -0.3);
    snout.castShadow = true;
    inner.add(snout);
    // Nostrils.
    const nostrilGeo = new THREE.SphereGeometry(0.03, 8, 8);
    const nostrilMat = new THREE.MeshStandardMaterial({ color: 0x062a24, roughness: 0.6 });
    for (const sx of [-1, 1]) {
      const n = new THREE.Mesh(nostrilGeo, nostrilMat);
      n.position.set(sx * 0.08, 0.02, -0.52);
      inner.add(n);
    }

    // Eyes: white ball + iris/pupil/shine inside a pivot that rotates to "look".
    const eyeGeo = new THREE.SphereGeometry(0.115, 24, 18);
    const eyeMat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.08, clearcoat: 1 });
    const irisGeo = new THREE.SphereGeometry(0.072, 16, 12);
    const irisMat = new THREE.MeshStandardMaterial({ color: 0xf59e0b, roughness: 0.3, emissive: 0x7c2d12, emissiveIntensity: 0.4 });
    const pupilGeo = new THREE.SphereGeometry(0.045, 12, 10);
    const pupilMat = new THREE.MeshBasicMaterial({ color: 0x050505 });
    const shineGeo = new THREE.SphereGeometry(0.02, 8, 8);
    const shineMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    this.eyes = [];
    for (const sx of [-1, 1]) {
      const eye = new THREE.Group();
      eye.position.set(sx * 0.2, 0.16, -0.13);
      const ball = new THREE.Mesh(eyeGeo, eyeMat);
      eye.add(ball);
      const pivot = new THREE.Group();
      const iris = new THREE.Mesh(irisGeo, irisMat);
      iris.position.z = -0.075;
      const pupil = new THREE.Mesh(pupilGeo, pupilMat);
      pupil.position.z = -0.098;
      const shine = new THREE.Mesh(shineGeo, shineMat);
      shine.position.set(0.028, 0.03, -0.115);
      pivot.add(iris, pupil, shine);
      eye.add(pivot);
      inner.add(eye);
      this.eyes.push({ eye, pivot, yaw: 0, pitch: 0 });
    }

    // Forked tongue.
    const tongue = new THREE.Group();
    const tongueMat = new THREE.MeshStandardMaterial({ color: 0xe11d48, roughness: 0.35, emissive: 0x7f1d1d, emissiveIntensity: 0.4 });
    const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.024, 0.34, 8), tongueMat);
    stalk.rotation.x = Math.PI / 2;
    stalk.position.z = -0.17;
    tongue.add(stalk);
    for (const sx of [-1, 1]) {
      const fork = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.018, 0.16, 8), tongueMat);
      fork.rotation.x = Math.PI / 2;
      fork.rotation.y = sx * -0.45;
      fork.position.set(sx * 0.04, 0, -0.4);
      tongue.add(fork);
    }
    tongue.position.set(0, -0.08, -0.5);
    tongue.scale.set(1, 1, 0.001);
    this.tongue = tongue;
    inner.add(tongue);

    // Crown.
    const crown = new THREE.Group();
    const gold = new THREE.MeshStandardMaterial({ color: 0xfbbf24, metalness: 0.95, roughness: 0.18, emissive: 0x7c5a05, emissiveIntensity: 0.25 });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.17, 0.1, 10), gold);
    crown.add(base);
    const gemMats = [
      new THREE.MeshStandardMaterial({ color: 0xff2d55, emissive: 0xff2d55, emissiveIntensity: 1.6, roughness: 0.2 }),
      new THREE.MeshStandardMaterial({ color: 0x22d3ee, emissive: 0x22d3ee, emissiveIntensity: 1.6, roughness: 0.2 })
    ];
    const spikeGeo = new THREE.ConeGeometry(0.05, 0.16, 5);
    const gemGeo = new THREE.SphereGeometry(0.03, 10, 8);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU;
      const spike = new THREE.Mesh(spikeGeo, gold);
      spike.position.set(Math.cos(a) * 0.16, 0.12, Math.sin(a) * 0.16);
      crown.add(spike);
      const gem = new THREE.Mesh(gemGeo, gemMats[i % 2]);
      gem.position.set(Math.cos(a) * 0.17, 0.06, Math.sin(a) * 0.17);
      crown.add(gem);
    }
    const topGem = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 10), gemMats[0]);
    topGem.position.y = 0.1;
    crown.add(topGem);
    crown.position.set(0, 0.34, 0.02);
    crown.rotation.z = 0.14;
    crown.castShadow = true;
    inner.add(crown);
    this.crown = crown;
  }

  // ---------------------------------------------------------------------------
  // Public state setters
  // ---------------------------------------------------------------------------
  setState({ cells, dir, prevDir, progress, phase }) {
    this.cells = cells || [];
    this.dir = dir ?? this.dir;
    this.prevDir = prevDir ?? this.prevDir;
    this.progress = clamp(progress ?? 0, 0, 1);
    if (phase) this.setPhase(phase);
  }

  setApple(cell) {
    this.appleCell = cell ? { x: cell.x, z: cell.z } : null;
    this.hasApple = !!cell;
    if (cell) this.appleWorld.set((cell.x + 0.5) * CELL, ITEM_Y + 0.2, (cell.z + 0.5) * CELL);
  }

  setPhase(phase) {
    if (phase === this.phase) return;
    this.phase = phase;
  }

  /** Called when an apple is eaten: gulp pulse + a bulge travelling down the body. */
  onEat() {
    this.headScalePulse = 1;
    this.bulges.push({ s: 0, amp: 0.14 });
    if (this.bulges.length > 12) this.bulges.shift();
  }

  /** Called when a bomb is eaten: wince (blink + recoil). */
  onHurt() {
    this.blinkT = 0;
    this.blinkDur = 0.5;
    this.headScalePulse = -0.6;
  }

  /** Bomb shield on/off: adds a subtle emerald/cyan emissive pulse while active. */
  setShield(active) { this.shielded = !!active; }

  getHeadInfo() {
    return { position: this.headPos, forward: this.headFwd, visible: this.visible };
  }

  // ---------------------------------------------------------------------------
  // Per-frame update
  // ---------------------------------------------------------------------------
  update(dt, elapsed) {
    const n = this.cells.length;
    if (n < 2 || n > this.maxCells) {
      this.visible = false;
      this.group.visible = false;
      return;
    }
    this.visible = true;
    this.group.visible = true;

    // 1. Interpolated control points (head first), y = ITEM_Y.
    const ctrl = this.ctrl;
    const p = this.progress;
    const d = DIRS[this.dir] || DIRS[1];
    for (let i = 0; i < n; i++) {
      const c = this.cells[i];
      let x = (c.x + 0.5) * CELL, z = (c.z + 0.5) * CELL;
      if (i === 0) {
        x += d.x * CELL * p;
        z += d.z * CELL * p;
      } else {
        const q = this.cells[i - 1];
        x = lerp(x, (q.x + 0.5) * CELL, p);
        z = lerp(z, (q.z + 0.5) * CELL, p);
      }
      const o = (i + 1) * 3;
      ctrl[o] = x;
      ctrl[o + 1] = ITEM_Y;
      ctrl[o + 2] = z;
    }
    // Smoothed heading (prototype approach: smoothstep from prevDir to dir over progress).
    const pd = DIRS[this.prevDir] || d;
    const a0 = Math.atan2(pd.x, pd.z);
    const a1 = Math.atan2(d.x, d.z);
    let diff = a1 - a0;
    while (diff < -Math.PI) diff += TAU;
    while (diff > Math.PI) diff -= TAU;
    const heading = a0 + diff * smoothstep(p);
    const fx = Math.sin(heading), fz = Math.cos(heading);
    this.headFwd.set(fx, 0, fz);
    // Virtual point ahead of the head (leans the spline into the heading) and beyond the tail.
    ctrl[0] = ctrl[3] + fx * 0.6; ctrl[1] = ITEM_Y; ctrl[2] = ctrl[5] + fz * 0.6;
    const t0 = n * 3, t1 = (n + 1) * 3;
    ctrl[t1] = ctrl[t0] * 2 - ctrl[t0 - 3];
    ctrl[t1 + 1] = ITEM_Y;
    ctrl[t1 + 2] = ctrl[t0 + 2] * 2 - ctrl[t0 - 1];

    // 2. Sample the cardinal spline into ring centres.
    const segs = n - 1;
    const spp = clamp(Math.floor(this.ringBudget / segs), 2, 8);
    const rings = segs * spp + 1;
    const rc = this.ringC;
    let ri = 0;
    for (let i = 0; i < segs; i++) {
      const o0 = i * 3, o1 = o0 + 3, o2 = o0 + 6, o3 = o0 + 9;
      const last = i === segs - 1 ? spp : spp - 1;
      for (let j = 0; j <= last; j++) {
        const t = j / spp;
        const t2 = t * t, t3 = t2 * t;
        const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
        for (let k = 0; k < 3; k++) {
          const p0 = ctrl[o0 + k], p1 = ctrl[o1 + k], p2 = ctrl[o2 + k], p3 = ctrl[o3 + k];
          const m1 = TENSION * (p2 - p0), m2 = TENSION * (p3 - p1);
          rc[ri * 3 + k] = h00 * p1 + h10 * m1 + h01 * p2 + h11 * m2;
        }
        ri++;
      }
    }
    // Arc length per ring.
    const rs = this.ringS;
    rs[0] = 0;
    for (let i = 1; i < rings; i++) {
      const dx = rc[i * 3] - rc[i * 3 - 3], dy = rc[i * 3 + 1] - rc[i * 3 - 2], dz = rc[i * 3 + 2] - rc[i * 3 - 1];
      rs[i] = rs[i - 1] + Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    const total = rs[rings - 1] || 1;
    this.totalLen = total;

    // 3. Advance bulges (they travel toward the tail at ~6 cells/s).
    for (let i = this.bulges.length - 1; i >= 0; i--) {
      const b = this.bulges[i];
      b.s += dt * 6;
      if (b.s > total + 1) this.bulges.splice(i, 1);
    }
    this.sat = damp(this.sat, this.phase === 'lost' ? 0 : 1, this.phase === 'lost' ? 1.5 : 4, dt);

    // 4. Build ring vertices.
    const R = this.radial + 1;
    const pos = this.pos, nor = this.nor, uv = this.uv, col = this.col;
    const breathe = this.phase === 'lost' ? 0 : 0.035;
    for (let i = 0; i < rings; i++) {
      const i3 = i * 3;
      const cx = rc[i3], cy = rc[i3 + 1], cz = rc[i3 + 2];
      // Tangent by central differences.
      const ia = Math.max(0, i - 1) * 3, ib = Math.min(rings - 1, i + 1) * 3;
      let tx = rc[ib] - rc[ia], ty = rc[ib + 1] - rc[ia + 1], tz = rc[ib + 2] - rc[ia + 2];
      let tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl; ty /= tl; tz /= tl;
      // Frame: N = up projected, B = T × N (flat snake → stable, no twist).
      let nx = -tx * ty, ny = 1 - ty * ty, nz = -tz * ty;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      const bx = ty * nz - tz * ny, by = tz * nx - tx * nz, bz = tx * ny - ty * nx;
      // Radius profile: neck, body, tapered tail, breathing, bulges.
      const s = rs[i];
      const fromTail = total - s;
      let r = BASE_RADIUS;
      if (s < 0.5) r *= 0.82 + 0.18 * smoothstep(s / 0.5);            // neck behind the head
      if (fromTail < 3.5) r *= 0.06 + 0.94 * smoothstep(fromTail / 3.5); // tail taper
      if (i === rings - 1) r = 0.015;
      r *= 1 + breathe * Math.sin(elapsed * 5 - s * 1.4);
      for (const b of this.bulges) {
        const dd = s - b.s;
        r += b.amp * Math.exp(-(dd * dd) / 0.22);
      }
      // Colour gradient head → tail: mint → cyan → deep blue, desaturated on loss.
      const f = s / total;
      let cr, cg, cb;
      if (f < 0.5) {
        const k = f / 0.5;
        cr = lerp(GRAD[0].r, GRAD[1].r, k); cg = lerp(GRAD[0].g, GRAD[1].g, k); cb = lerp(GRAD[0].b, GRAD[1].b, k);
      } else {
        const k = (f - 0.5) / 0.5;
        cr = lerp(GRAD[1].r, GRAD[2].r, k); cg = lerp(GRAD[1].g, GRAD[2].g, k); cb = lerp(GRAD[1].b, GRAD[2].b, k);
      }
      if (this.sat < 1) {
        const lum = 0.3 * cr + 0.59 * cg + 0.11 * cb;
        cr = lerp(lum * 0.75, cr, this.sat);
        cg = lerp(lum * 0.75, cg, this.sat);
        cb = lerp(lum * 0.75, cb, this.sat);
      }
      const vv = s * 1.0;
      for (let k = 0; k < R; k++) {
        const a = (k / this.radial) * TAU;
        const ca = Math.cos(a), sa = Math.sin(a);
        const ox = nx * ca + bx * sa, oy = ny * ca + by * sa, oz = nz * ca + bz * sa;
        const v = (i * R + k);
        const v3 = v * 3;
        pos[v3] = cx + ox * r; pos[v3 + 1] = cy + oy * r; pos[v3 + 2] = cz + oz * r;
        nor[v3] = ox; nor[v3 + 1] = oy; nor[v3 + 2] = oz;
        uv[v * 2] = k / this.radial; uv[v * 2 + 1] = vv;
        col[v3] = cr; col[v3 + 1] = cg; col[v3 + 2] = cb;
      }
    }
    const vUsed = rings * R;
    this.posAttr.addUpdateRange(0, vUsed * 3); this.posAttr.needsUpdate = true;
    this.norAttr.addUpdateRange(0, vUsed * 3); this.norAttr.needsUpdate = true;
    this.uvAttr.addUpdateRange(0, vUsed * 2); this.uvAttr.needsUpdate = true;
    this.colAttr.addUpdateRange(0, vUsed * 3); this.colAttr.needsUpdate = true;
    this.tube.geometry.setDrawRange(0, (rings - 1) * this.radial * 6);

    // 5. Head placement & animation.
    this._updateHead(dt, elapsed, rc, heading);

    // 6. Phase-driven material glow.
    this._updateMaterials(dt, elapsed);
  }

  _updateHead(dt, elapsed, rc, heading) {
    const head = this.head;
    const bob = Math.sin(elapsed * 4.2) * 0.012;
    head.position.set(rc[0], rc[1] + 0.02 + bob, rc[2]);
    this.headPos.copy(head.position);
    const targetAngle = heading + Math.PI;
    if (!this.headAngleInit) { this.headAngle = targetAngle; this.headAngleInit = true; }
    let diff = targetAngle - this.headAngle;
    while (diff < -Math.PI) diff += TAU;
    while (diff > Math.PI) diff -= TAU;
    const prev = this.headAngle;
    this.headAngle += diff * (1 - Math.exp(-22 * dt));
    let dAng = this.headAngle - prev;
    while (dAng < -Math.PI) dAng += TAU;
    while (dAng > Math.PI) dAng -= TAU;
    const angVel = dt > 0 ? dAng / dt : 0;
    // Bank into turns.
    this.roll = damp(this.roll, clamp(-angVel * 0.05, -0.3, 0.3), 8, dt);
    head.rotation.set(0, this.headAngle, this.roll);

    // Gulp / wince pulse (spring back to 1).
    this.headScalePulse = damp(this.headScalePulse, 0, 7, dt);
    const sc = 1 + this.headScalePulse * 0.28;
    this.headInner.scale.set(sc, sc, this.headScalePulse < 0 ? 1 - this.headScalePulse * 0.3 : sc);

    // Eyes: look toward the apple (head-local yaw/pitch, clamped), else drift forward.
    let yaw = 0, pitch = 0;
    if (this.hasApple) {
      head.updateMatrixWorld(true);
      const local = head.worldToLocal(this.appleWorld.clone());
      const dist = Math.hypot(local.x, local.z);
      if (dist > 0.05) {
        yaw = clamp(Math.atan2(local.x, -local.z), -0.9, 0.9);
        pitch = clamp(Math.atan2(local.y - 0.2, dist), -0.4, 0.3);
      }
    } else {
      yaw = Math.sin(elapsed * 0.7) * 0.25;
    }
    // Blink timing.
    if (this.blinkT < 0) {
      this.nextBlink -= dt;
      if (this.nextBlink <= 0) { this.blinkT = 0; this.blinkDur = 0.16; this.nextBlink = 2.2 + rand(0, 3.6) + (Math.random() < 0.2 ? -1.9 : 0); }
    } else {
      this.blinkT += dt;
      if (this.blinkT >= this.blinkDur) this.blinkT = -1;
    }
    const blinkAmt = this.blinkT < 0 ? 0 : Math.sin(Math.PI * clamp(this.blinkT / this.blinkDur, 0, 1));
    for (const e of this.eyes) {
      e.yaw = damp(e.yaw, yaw, 12, dt);
      e.pitch = damp(e.pitch, pitch, 12, dt);
      e.pivot.rotation.set(-e.pitch, e.yaw, 0);
      e.eye.scale.y = 1 - blinkAmt * 0.92;
    }

    // Tongue: flicks near the apple, or a random flick now and then.
    let near = false;
    if (this.appleCell && this.cells.length) {
      const h = this.cells[0];
      near = Math.abs(h.x - this.appleCell.x) + Math.abs(h.z - this.appleCell.z) <= 4;
    }
    this.tongueTimer -= dt;
    if (this.tongueTimer <= 0) { this.tongueBurst = 0.9; this.tongueTimer = 3 + rand(0, 5); }
    this.tongueBurst = Math.max(0, this.tongueBurst - dt);
    const active = near || this.tongueBurst > 0;
    const targetExt = active ? Math.max(0, Math.sin(elapsed * 16)) * 1.15 + 0.15 : 0.001;
    const cur = this.tongue.scale.z;
    this.tongue.scale.z = damp(cur, targetExt, active ? 30 : 12, dt);
    this.tongue.rotation.y = active ? Math.sin(elapsed * 23) * 0.15 : 0;

    // Crown sparkle wobble.
    this.crown.rotation.y = Math.sin(elapsed * 1.3) * 0.08;
  }

  _updateMaterials(dt, elapsed) {
    const bm = this.bodyMat, hm = this.headMat;
    let em, intensity;
    if (this.phase === 'won') {
      em = 0xf5b301; intensity = 0.5 + 0.9 * (0.5 + 0.5 * Math.sin(elapsed * 6));
    } else if (this.phase === 'lost') {
      em = 0x3a0a0a; intensity = 0.25;
    } else if (this.phase === 'countdown') {
      em = 0x22d3ee; intensity = 0.15 + 0.45 * (0.5 + 0.5 * Math.sin(elapsed * 5));
    } else {
      em = 0x0f3d2e; intensity = 0.18;
    }
    bm.emissive.setHex(em);
    // Shield pulse (only over the calm phases; won/lost keep their own glow).
    this.shieldMix = damp(this.shieldMix, this.shielded ? 1 : 0, 6, dt);
    if (this.shieldMix > 0.01 && (this.phase === 'playing' || this.phase === 'countdown')) {
      const w = 0.5 + 0.5 * Math.sin(elapsed * 4.2);
      this._shieldScratch.copy(this._shieldColA).lerp(this._shieldColB, w);
      bm.emissive.lerp(this._shieldScratch, this.shieldMix * 0.85);
      intensity += this.shieldMix * (0.22 + 0.18 * w);
    }
    hm.emissive.copy(bm.emissive);
    bm.emissiveIntensity = damp(bm.emissiveIntensity, intensity, 6, dt);
    hm.emissiveIntensity = bm.emissiveIntensity;
    // Head colour follows the saturation (grey on loss).
    const lum = 0.3 * this.headColor.r + 0.59 * this.headColor.g + 0.11 * this.headColor.b;
    hm.color.setRGB(
      lerp(lum * 0.75, this.headColor.r, this.sat),
      lerp(lum * 0.75, this.headColor.g, this.sat),
      lerp(lum * 0.75, this.headColor.b, this.sat)
    );
  }

  dispose() {
    disposeObject(this.group);
    this.scaleTex.dispose();
    this.bodyMat.dispose();
    this.headMat.dispose();
  }
}
