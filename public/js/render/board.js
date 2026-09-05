// Board: instanced glossy checker tiles, bevelled rim with an emissive neon
// edge, soft glow ring underneath and a few decorative crystals outside.
import * as THREE from 'three';
import { CELL, makeCanvas, canvasTexture, disposeObject, damp } from './util.js';

export const RIM_WIDTH = 0.62;   // how far the rim extends beyond the tiles
export const RIM_HEIGHT = 0.28;  // rim top above the tile tops
export const TILE_TOP_Y = 0;

const PHASE_COLORS = {
  countdown: 0x22d3ee,
  playing: 0x22d3ee,
  won: 0xfbbf24,
  lost: 0xff3355
};

/** Radial-gradient texture used for the ground glow. */
function makeGlowTexture() {
  const c = makeCanvas(512, 512);  // [nitidez] textura do tabuleiro ao ampliar
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(128, 128, 20, 128, 128, 128);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  const t = canvasTexture(c);
  t.generateMipmaps = false;
  t.minFilter = THREE.LinearFilter;
  return t;
}

export class Board {
  constructor(scene, { quality = 'high' } = {}) {
    this.scene = scene;
    this.quality = quality;
    this.group = null;
    this.w = 0;
    this.h = 0;
    this.neonColor = new THREE.Color(PHASE_COLORS.playing);
    this.neonTarget = new THREE.Color(PHASE_COLORS.playing);
    this.phase = 'playing';
    this.glowTex = makeGlowTexture();
    this.tileMat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff, // multiplied by per-instance colours
      roughness: 0.32,
      metalness: 0.05,
      clearcoat: 1,
      clearcoatRoughness: 0.18,
      envMapIntensity: 0.9
    });
    this.rimMat = new THREE.MeshStandardMaterial({ color: 0x1b2437, roughness: 0.35, metalness: 0.85 });
    this.neonMat = new THREE.MeshBasicMaterial({ color: 0x22d3ee, toneMapped: false });
    this.glowMat = new THREE.MeshBasicMaterial({
      map: this.glowTex, color: 0x22d3ee, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
    });
    this.crystalMat = new THREE.MeshPhysicalMaterial({
      color: 0x67e8f9, roughness: 0.15, metalness: 0.1, transmission: 0.0, clearcoat: 1,
      emissive: 0x0e7490, emissiveIntensity: 0.6, transparent: true, opacity: 0.92
    });
    this.tileHighlight = new Map(); // instance index -> intensity (trail under the snake)
    this.tmpColor = new THREE.Color();
    this.baseColors = null; // Float32Array of per-tile base colours
  }

  /** (Re)build the board for a w×h grid. Safe to call repeatedly. */
  build(w, h) {
    if (this.group) disposeObject(this.group);
    this.w = w;
    this.h = h;
    this.tileHighlight.clear();
    const g = new THREE.Group();
    g.name = 'board';
    this.group = g;

    // --- Tiles (one InstancedMesh, per-instance colour) ----------------------
    const gap = 0.06;
    const tileGeo = new THREE.BoxGeometry(CELL - gap, 0.22, CELL - gap, 1, 1, 1);
    const tiles = new THREE.InstancedMesh(tileGeo, this.tileMat, w * h);
    tiles.receiveShadow = true;
    tiles.castShadow = false;
    const m = new THREE.Matrix4();
    const dark = new THREE.Color(0x0b5f4b);
    const light = new THREE.Color(0x0f7a5f);
    this.baseColors = new Float32Array(w * h * 3);
    for (let z = 0; z < h; z++) {
      for (let x = 0; x < w; x++) {
        const i = z * w + x;
        m.makeTranslation((x + 0.5) * CELL, TILE_TOP_Y - 0.11, (z + 0.5) * CELL);
        tiles.setMatrixAt(i, m);
        const c = (x + z) % 2 === 0 ? dark : light;
        tiles.setColorAt(i, c);
        this.baseColors[i * 3] = c.r;
        this.baseColors[i * 3 + 1] = c.g;
        this.baseColors[i * 3 + 2] = c.b;
      }
    }
    tiles.instanceMatrix.needsUpdate = true;
    if (tiles.instanceColor) {
      tiles.instanceColor.needsUpdate = true;
      tiles.instanceColor.setUsage(THREE.DynamicDrawUsage);
    }
    this.tiles = tiles;
    g.add(tiles);

    // --- Base slab under the tiles (hides gaps, gives thickness) ------------
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(w * CELL + 0.1, 0.5, h * CELL + 0.1),
      new THREE.MeshStandardMaterial({ color: 0x06281f, roughness: 0.6, metalness: 0.2 })
    );
    slab.position.set(w / 2, -0.38, h / 2);
    slab.receiveShadow = true;
    g.add(slab);

    // --- Bevelled rim (extruded rectangular ring) -----------------------------
    const outer = new THREE.Shape();
    const ow = w * CELL + RIM_WIDTH * 2;
    const oh = h * CELL + RIM_WIDTH * 2;
    const r = 0.5;
    outer.moveTo(-ow / 2 + r, -oh / 2);
    outer.lineTo(ow / 2 - r, -oh / 2);
    outer.quadraticCurveTo(ow / 2, -oh / 2, ow / 2, -oh / 2 + r);
    outer.lineTo(ow / 2, oh / 2 - r);
    outer.quadraticCurveTo(ow / 2, oh / 2, ow / 2 - r, oh / 2);
    outer.lineTo(-ow / 2 + r, oh / 2);
    outer.quadraticCurveTo(-ow / 2, oh / 2, -ow / 2, oh / 2 - r);
    outer.lineTo(-ow / 2, -oh / 2 + r);
    outer.quadraticCurveTo(-ow / 2, -oh / 2, -ow / 2 + r, -oh / 2);
    const hole = new THREE.Path();
    const iw = w * CELL + 0.08;
    const ih = h * CELL + 0.08;
    hole.moveTo(-iw / 2, -ih / 2);
    hole.lineTo(iw / 2, -ih / 2);
    hole.lineTo(iw / 2, ih / 2);
    hole.lineTo(-iw / 2, ih / 2);
    hole.closePath();
    outer.holes.push(hole);
    const rimGeo = new THREE.ExtrudeGeometry(outer, {
      depth: RIM_HEIGHT + 0.4, bevelEnabled: true, bevelThickness: 0.12, bevelSize: 0.1, bevelSegments: 3, curveSegments: 6
    });
    rimGeo.rotateX(-Math.PI / 2); // extrude along +y
    const rim = new THREE.Mesh(rimGeo, this.rimMat);
    rim.position.set(w / 2, -0.4 - 0.12, h / 2);
    rim.castShadow = true;
    rim.receiveShadow = true;
    g.add(rim);

    // --- Neon edge: a thin emissive loop on the rim's inner top edge ---------
    const neonGeo = this._makeNeonLoop(w * CELL + 0.28, h * CELL + 0.28, 0.07);
    const neon = new THREE.Mesh(neonGeo, this.neonMat);
    neon.position.set(w / 2, RIM_HEIGHT - 0.02, h / 2);
    this.neon = neon;
    g.add(neon);
    // Second, dimmer outer loop for depth.
    const neon2 = new THREE.Mesh(this._makeNeonLoop(ow - 0.12, oh - 0.12, 0.05), this.neonMat);
    neon2.position.set(w / 2, RIM_HEIGHT - 0.3, h / 2);
    g.add(neon2);

    // --- Ground glow ----------------------------------------------------------
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(ow * 2.2, oh * 2.2), this.glowMat);
    glow.rotation.x = -Math.PI / 2;
    glow.position.set(w / 2, -0.9, h / 2);
    glow.renderOrder = -10;
    this.glow = glow;
    g.add(glow);

    // --- Decorative crystals at the corners (outside the board) -------------
    if (this.quality !== 'low') {
      const crystalGeo = new THREE.ConeGeometry(0.28, 1.4, 6);
      const corners = [[-1.1, -1.1], [w + 1.1, -1.1], [-1.1, h + 1.1], [w + 1.1, h + 1.1]];
      let k = 0;
      for (const [cx, cz] of corners) {
        for (let i = 0; i < 3; i++) {
          const c = new THREE.Mesh(crystalGeo, this.crystalMat);
          const a = (k * 2.399) % Math.PI; // golden-angle spread
          const s = 0.55 + ((k * 7) % 5) * 0.14;
          c.scale.set(s, s * (0.9 + ((k * 3) % 4) * 0.25), s);
          c.position.set(cx + Math.cos(a) * 0.45, -0.25 + s * 0.6, cz + Math.sin(a) * 0.45);
          c.rotation.set(((k % 3) - 1) * 0.25, a, ((k % 2) - 0.5) * 0.3);
          c.castShadow = true;
          g.add(c);
          k++;
        }
      }
    }

    this.scene.add(g);
  }

  /** Rectangular loop made of 4 thin boxes merged into one geometry (1 draw call). */
  _makeNeonLoop(w, h, t) {
    const parts = [];
    const mk = (sx, sy, sz, x, y, z) => {
      const b = new THREE.BoxGeometry(sx, sy, sz);
      b.translate(x, y, z);
      parts.push(b);
    };
    mk(w + t, t, t, 0, 0, -h / 2);
    mk(w + t, t, t, 0, 0, h / 2);
    mk(t, t, h + t, -w / 2, 0, 0);
    mk(t, t, h + t, w / 2, 0, 0);
    // Manual merge (avoids importing BufferGeometryUtils for 4 boxes).
    let vCount = 0, iCount = 0;
    for (const p of parts) { vCount += p.attributes.position.count; iCount += p.index.count; }
    const pos = new Float32Array(vCount * 3);
    const nor = new Float32Array(vCount * 3);
    const idx = new Uint16Array(iCount);
    let vo = 0, io = 0;
    for (const p of parts) {
      pos.set(p.attributes.position.array, vo * 3);
      nor.set(p.attributes.normal.array, vo * 3);
      const pi = p.index.array;
      for (let i = 0; i < pi.length; i++) idx[io + i] = pi[i] + vo;
      vo += p.attributes.position.count;
      io += pi.length;
      p.dispose();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    return geo;
  }

  setPhase(phase) {
    this.phase = phase;
    this.neonTarget.setHex(PHASE_COLORS[phase] ?? PHASE_COLORS.playing);
  }

  /** Brighten the tile under a cell (fades back automatically). */
  touchTile(x, z, amount = 1) {
    if (x < 0 || z < 0 || x >= this.w || z >= this.h) return;
    this.tileHighlight.set(z * this.w + x, amount);
  }

  update(dt, elapsed) {
    if (!this.group) return;
    this.neonColor.lerp(this.neonTarget, 1 - Math.exp(-3 * dt));
    // Breathing intensity; faster pulse while counting down, strong on win.
    const rate = this.phase === 'countdown' ? 4 : this.phase === 'won' ? 6 : 1.6;
    const pulse = 0.5 + 0.5 * Math.sin(elapsed * rate);
    const intensity = this.phase === 'lost' ? 1.4 + pulse * 0.5 : 1.8 + pulse * 1.2;
    this.neonMat.color.copy(this.neonColor).multiplyScalar(intensity);
    this.glowMat.color.copy(this.neonColor);
    this.glowMat.opacity = 0.35 + pulse * 0.2;
    this.crystalMat.emissive.copy(this.neonColor).multiplyScalar(0.35);

    // Fade tile highlights back to their base colour.
    if (this.tileHighlight.size && this.tiles.instanceColor) {
      const ic = this.tiles.instanceColor;
      for (const [i, v] of this.tileHighlight) {
        const nv = v - dt * 1.8;
        const k = Math.max(0, nv);
        const i3 = i * 3;
        ic.array[i3] = this.baseColors[i3] + (this.neonColor.r * 0.9 - this.baseColors[i3]) * k * 0.6;
        ic.array[i3 + 1] = this.baseColors[i3 + 1] + (this.neonColor.g * 0.9 - this.baseColors[i3 + 1]) * k * 0.6;
        ic.array[i3 + 2] = this.baseColors[i3 + 2] + (this.neonColor.b * 0.9 - this.baseColors[i3 + 2]) * k * 0.6;
        if (nv <= 0) this.tileHighlight.delete(i); else this.tileHighlight.set(i, nv);
      }
      ic.needsUpdate = true;
    }
  }

  /** World-space AABB of the board including the rim (used for camera framing). */
  getBounds() {
    return {
      minX: -RIM_WIDTH, maxX: this.w * CELL + RIM_WIDTH,
      minZ: -RIM_WIDTH, maxZ: this.h * CELL + RIM_WIDTH,
      minY: -0.55, maxY: RIM_HEIGHT
    };
  }

  dispose() {
    if (this.group) disposeObject(this.group);
    this.group = null;
    this.glowTex.dispose();
    this.tileMat.dispose();
    this.rimMat.dispose();
    this.neonMat.dispose();
    this.glowMat.dispose();
    this.crystalMat.dispose();
  }
}
