// Apples and bombs living on the board, plus the gift image sprite that hovers
// above a freshly spawned bomb.
import * as THREE from 'three';
import { CELL, ITEM_Y, clamp, rand, TAU, loadImage, imageTexture, disposeObject } from './util.js';
import { PALETTES } from './effects.js';

const SPARK_COLOR = new THREE.Color(0xffa63d).multiplyScalar(3.5);

// ---------------------------------------------------------------------------
// [itens] Silhuetas próprias dos itens especiais. Cada uma é extrudada de um
// contorno 2D, então o item é reconhecível de relance (nunca "mais uma bola").
// ---------------------------------------------------------------------------

function extrude(points, depth = 0.12, bevel = 0.02) {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1]);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 4
  });
  geo.center();
  return geo;
}

/** ⚡ Raio: o zigue-zague clássico. */
function makeBoltGeometry() {
  return extrude([
    [0.06, 0.42], [-0.18, 0.02], [-0.02, 0.02], [-0.08, -0.42],
    [0.18, -0.04], [0.02, -0.04]
  ], 0.1, 0.015);
}

/** 💎 Diamante: pedra lapidada (topo chanfrado + ponta embaixo). */
function makeDiamondGeometry() {
  const geo = new THREE.CylinderGeometry(0.3, 0.0, 0.34, 8, 1);
  const top = new THREE.CylinderGeometry(0.19, 0.3, 0.13, 8, 1);
  top.translate(0, 0.235, 0);
  return mergeGeometries([geo, top]);
}

/** ⭐ Estrela de 5 pontas. */
function makeStarGeometry() {
  const pts = [];
  const outer = 0.42;
  const inner = 0.17;
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (i / 10) * TAU - Math.PI / 2;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return extrude(pts, 0.1, 0.02);
}

/** Junta geometrias simples sem depender do addon BufferGeometryUtils. */
function mergeGeometries(list) {
  const merged = new THREE.BufferGeometry();
  const pos = [];
  const norm = [];
  for (const g of list) {
    const gg = g.index ? g.toNonIndexed() : g;
    pos.push(...gg.attributes.position.array);
    norm.push(...gg.attributes.normal.array);
    if (gg !== g) gg.dispose();
    g.dispose();
  }
  merged.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
  return merged;
}

export class Items {
  /**
   * @param {THREE.Scene} scene
   * @param {{ quality: string, pool: import('./effects.js').ParticlePool }} opts
   */
  constructor(scene, { quality = 'high', pool }) {
    this.scene = scene;
    this.quality = quality;
    this.pool = pool;
    this.group = new THREE.Group();
    this.group.name = 'items';
    scene.add(this.group);
    this.items = new Map(); // id -> record
    this.dying = [];        // records animating out
    this.tmp = new THREE.Vector3();

    // --- Shared apple assets ----------------------------------------------------
    this.appleGeo = new THREE.SphereGeometry(0.33, 36, 26);
    this.appleMat = new THREE.MeshPhysicalMaterial({
      color: 0xe11d48, roughness: 0.18, metalness: 0.0, clearcoat: 1, clearcoatRoughness: 0.08,
      emissive: 0x7f1d1d, emissiveIntensity: 0.35, envMapIntensity: 1.2
    });
    this.stemGeo = new THREE.CylinderGeometry(0.022, 0.035, 0.22, 8);
    this.stemMat = new THREE.MeshStandardMaterial({ color: 0x6b4423, roughness: 0.8 });
    this.leafGeo = new THREE.SphereGeometry(0.12, 12, 8);
    this.leafGeo.scale(1.6, 0.22, 0.8);
    this.leafMat = new THREE.MeshPhysicalMaterial({ color: 0x34d399, roughness: 0.4, clearcoat: 0.6, emissive: 0x064e3b, emissiveIntensity: 0.3, side: THREE.DoubleSide });
    this.ringGeo = new THREE.TorusGeometry(0.52, 0.012, 6, 64);
    this.ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xfbbf24).multiplyScalar(2.2), transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    // One shared point light that follows the (single) apple.
    this.appleLight = quality === 'low' ? null : new THREE.PointLight(0xff3b5c, 1.6, 4.5, 2);
    if (this.appleLight) { this.appleLight.visible = false; this.group.add(this.appleLight); }

    // --- Shared golden-food assets (hero gifts) -----------------------------------
    // Reuses appleGeo/stemGeo/leafGeo; only the materials differ.
    this.goldMat = new THREE.MeshPhysicalMaterial({
      color: 0xfbbf24, roughness: 0.16, metalness: 0.85, clearcoat: 1, clearcoatRoughness: 0.12,
      emissive: 0xb45309, emissiveIntensity: 0.55, envMapIntensity: 1.6
    });
    this.goldRingMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xfde68a).multiplyScalar(2.6), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    // One shared warm light that follows the newest golden food.
    this.foodLight = quality === 'low' ? null : new THREE.PointLight(0xffc36b, 1.3, 4.5, 2);
    if (this.foodLight) { this.foodLight.visible = false; this.group.add(this.foodLight); }

    // --- Shared bomb assets ---------------------------------------------------------
    this.bombGeo = new THREE.SphereGeometry(0.34, 32, 24);
    this.capGeo = new THREE.CylinderGeometry(0.1, 0.12, 0.1, 12);
    this.capMat = new THREE.MeshStandardMaterial({ color: 0x9ca3af, metalness: 0.9, roughness: 0.3 });
    const fuseCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.04, 0.14, 0.02), new THREE.Vector3(0.14, 0.26, 0.06), new THREE.Vector3(0.2, 0.36, 0.1)
    ]);
    this.fuseGeo = new THREE.TubeGeometry(fuseCurve, 10, 0.022, 6, false);
    this.fuseTip = fuseCurve.getPoint(1);
    this.fuseMat = new THREE.MeshStandardMaterial({ color: 0xd6b47a, roughness: 0.9 });
    this.sparkGeo = new THREE.SphereGeometry(0.05, 10, 8);
    this.sparkMat = new THREE.MeshBasicMaterial({ color: SPARK_COLOR, toneMapped: false });
    this.sparkRate = quality === 'low' ? 0.22 : quality === 'medium' ? 0.12 : 0.08;

    // --- [itens] Itens especiais ------------------------------------------------------
    // Cada tipo tem SILHUETA própria (nunca a esfera da bomba): o público precisa
    // reconhecer o item de relance num vídeo de celular.
    this.itemGeo = {
      bolt: makeBoltGeometry(),
      ice: new THREE.OctahedronGeometry(0.34, 0),
      web: new THREE.TorusGeometry(0.3, 0.055, 6, 12),
      skull: new THREE.SphereGeometry(0.3, 20, 16),
      diamond: makeDiamondGeometry(),
      star: makeStarGeometry(),
      magnet: new THREE.TorusGeometry(0.26, 0.1, 10, 20, Math.PI * 1.25),
      clock: new THREE.CylinderGeometry(0.3, 0.3, 0.1, 24),
    };
    this.itemMat = {
      bolt: new THREE.MeshStandardMaterial({ color: 0xfde047, emissive: 0xfacc15, emissiveIntensity: 1.5, metalness: 0.3, roughness: 0.2, toneMapped: false }),
      ice: new THREE.MeshPhysicalMaterial({ color: 0x7dd3fc, emissive: 0x0ea5e9, emissiveIntensity: 0.5, metalness: 0, roughness: 0.05, transmission: 0.7, thickness: 0.6, transparent: true, opacity: 0.85 }),
      web: new THREE.MeshStandardMaterial({ color: 0xe2e8f0, emissive: 0x94a3b8, emissiveIntensity: 0.35, roughness: 0.85, metalness: 0 }),
      skull: new THREE.MeshStandardMaterial({ color: 0xf1f5f9, emissive: 0x7f1d1d, emissiveIntensity: 0.6, roughness: 0.5, metalness: 0.1 }),
      diamond: new THREE.MeshPhysicalMaterial({ color: 0x67e8f9, emissive: 0x22d3ee, emissiveIntensity: 0.8, metalness: 0.1, roughness: 0.02, transmission: 0.6, thickness: 0.5, clearcoat: 1, transparent: true, opacity: 0.92 }),
      star: new THREE.MeshStandardMaterial({ color: 0xfde68a, emissive: 0xfbbf24, emissiveIntensity: 1.8, metalness: 0.5, roughness: 0.15, toneMapped: false }),
      magnet: new THREE.MeshStandardMaterial({ color: 0xef4444, emissive: 0xb91c1c, emissiveIntensity: 0.5, metalness: 0.7, roughness: 0.3 }),
      clock: new THREE.MeshStandardMaterial({ color: 0xe0f2fe, emissive: 0x38bdf8, emissiveIntensity: 0.6, metalness: 0.6, roughness: 0.25 }),
    };
    // Cores das partículas de cada item (spawn, coleta e pavio).
    this.itemColors = {
      bolt: [0xfde047, 0xfacc15, 0xffffff],
      ice: [0x7dd3fc, 0xbae6fd, 0xffffff],
      web: [0xe2e8f0, 0x94a3b8, 0xcbd5e1],
      skull: [0xf1f5f9, 0xef4444, 0x7f1d1d],
      diamond: [0x67e8f9, 0x22d3ee, 0xffffff],
      star: [0xfde68a, 0xfbbf24, 0xffffff],
      magnet: [0xef4444, 0xfca5a5, 0xffffff],
      clock: [0xe0f2fe, 0x38bdf8, 0xffffff],
    };
  }

  /** [itens] Cores de partícula de um tipo de item (usado também pelo facade). */
  colorsFor(kind) { return this.itemColors[kind] || this.itemColors.diamond; }

  /**
   * [itens] Coloca um item especial no tabuleiro. Visual próprio por tipo + anel de base na
   * cor do time (vermelho = dano, ciano/dourado = bônus), para nunca ser confundido com bomba.
   */
  addSpecialItem(id, kind, x, z, meta = {}) {
    this.remove(id, 'cleared', true);
    const geo = this.itemGeo[kind] || this.itemGeo.diamond;
    const mat = this.itemMat[kind] || this.itemMat.diamond;
    const villain = kind === 'bolt' || kind === 'ice' || kind === 'web' || kind === 'skull';
    const g = new THREE.Group();
    const body = new THREE.Mesh(geo, mat);
    body.castShadow = true;
    if (kind === 'clock') body.rotation.x = Math.PI / 2; // relógio de frente
    g.add(body);

    // Detalhes que reforçam a leitura de cada item.
    if (kind === 'skull') {
      // duas órbitas escuras = cara de caveira
      const eyeGeo = new THREE.SphereGeometry(0.075, 10, 8);
      const eyeMat = new THREE.MeshBasicMaterial({ color: 0x0b1020 });
      for (const sx of [-0.11, 0.11]) {
        const eye = new THREE.Mesh(eyeGeo, eyeMat);
        eye.position.set(sx, 0.06, 0.25);
        g.add(eye);
      }
    } else if (kind === 'clock') {
      // ponteiros
      const handMat = new THREE.MeshBasicMaterial({ color: 0x0b1020 });
      const h1 = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.2, 0.02), handMat);
      h1.position.set(0, 0.09, 0.06);
      const h2 = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.02, 0.02), handMat);
      h2.position.set(0.06, 0, 0.06);
      g.add(h1, h2);
      g.userData.hand = h1;
    }

    // Anel de base: dá o "time" do item de longe.
    const ringColor = villain ? 0xff3b3b : 0x22d3ee;
    const ring = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({
      color: new THREE.Color(ringColor).multiplyScalar(2.2), transparent: true, opacity: 0.8,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
    }));
    ring.rotation.x = Math.PI / 2;
    ring.scale.setScalar(1.15);
    g.add(ring);

    g.position.set((x + 0.5) * CELL, ITEM_Y, (z + 0.5) * CELL);
    g.scale.setScalar(0.001);
    this.group.add(g);
    const total = Number.isFinite(meta.fuseSec) && meta.fuseSec > 0 ? meta.fuseSec : Infinity;
    const rec = {
      id, type: 'item', kind, villain, x, z, group: g, body, ring, ringMat: ring.material,
      age: 0, sparkT: rand(0, 0.2), phase: rand(0, TAU), spin: villain ? 2.4 : 1.5,
      fuseTotal: total, fuseLeft: total, meta: meta ?? null,
    };
    this.items.set(id, rec);
    return rec;
  }

  /** [itens] Atualiza o pavio de um item especial (mesma ideia do setBombFuse). */
  setItemFuse(id, left) {
    const rec = this.items.get(id);
    if (!rec || rec.type !== 'item') return;
    rec.fuseLeft = Number.isFinite(left) ? Math.max(0, left) : Infinity;
  }

  /** [itens] 🧲 Ímã: reposiciona uma comida que andou uma célula. */
  moveTo(id, x, z) {
    const rec = this.items.get(id);
    if (!rec) return;
    rec.x = x;
    rec.z = z;
    rec.group.position.x = (x + 0.5) * CELL;
    rec.group.position.z = (z + 0.5) * CELL;
  }

  // ---------------------------------------------------------------------------
  addApple(id, x, z) {
    this.remove(id, 'cleared', true);
    const g = new THREE.Group();
    const body = new THREE.Mesh(this.appleGeo, this.appleMat);
    body.scale.set(1, 0.92, 1);
    body.castShadow = true;
    g.add(body);
    const stem = new THREE.Mesh(this.stemGeo, this.stemMat);
    stem.position.set(0.02, 0.36, 0);
    stem.rotation.z = -0.25;
    g.add(stem);
    const leaf = new THREE.Mesh(this.leafGeo, this.leafMat);
    leaf.position.set(0.14, 0.38, 0.02);
    leaf.rotation.set(0.2, 0.3, 0.35);
    g.add(leaf);
    const ring = new THREE.Mesh(this.ringGeo, this.ringMat);
    ring.rotation.x = Math.PI / 2 - 0.35;
    g.add(ring);
    g.position.set((x + 0.5) * CELL, ITEM_Y, (z + 0.5) * CELL);
    g.scale.setScalar(0.001);
    this.group.add(g);
    this.items.set(id, { id, type: 'apple', x, z, group: g, ring, age: 0, sparkT: 0, phase: rand(0, TAU) });
  }

  /** Golden bonus food from hero gifts: gold apple + spinning halo ring. */
  addFood(id, x, z, opts = {}) {
    this.remove(id, 'cleared', true);
    const g = new THREE.Group();
    const body = new THREE.Mesh(this.appleGeo, this.goldMat);
    body.scale.set(1, 0.92, 1);
    body.castShadow = true;
    g.add(body);
    const stem = new THREE.Mesh(this.stemGeo, this.stemMat);
    stem.position.set(0.02, 0.36, 0);
    stem.rotation.z = -0.25;
    g.add(stem);
    const leaf = new THREE.Mesh(this.leafGeo, this.leafMat);
    leaf.position.set(0.14, 0.38, 0.02);
    leaf.rotation.set(0.2, 0.3, 0.35);
    g.add(leaf);
    const ring = new THREE.Mesh(this.ringGeo, this.goldRingMat);
    ring.rotation.x = Math.PI / 2 - 0.35;
    g.add(ring);
    // Flat halo below the bob so it reads as "special" even in a tiny phone view.
    const halo = new THREE.Mesh(this.ringGeo, this.goldRingMat);
    halo.rotation.x = Math.PI / 2;
    halo.scale.setScalar(1.35);
    g.add(halo);
    g.position.set((x + 0.5) * CELL, ITEM_Y, (z + 0.5) * CELL);
    g.scale.setScalar(0.001);
    this.group.add(g);
    this.items.set(id, { id, type: 'food', x, z, group: g, ring, halo, age: 0, sparkT: rand(0, 0.16), phase: rand(0, TAU), meta: opts.meta ?? null });
  }

  addBomb(id, x, z, meta = {}) {
    this.remove(id, 'cleared', true);
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x0b1020, metalness: 0.92, roughness: 0.22, emissive: 0xff1a1a, emissiveIntensity: 0, envMapIntensity: 1.3 });
    const body = new THREE.Mesh(this.bombGeo, mat);
    body.castShadow = true;
    g.add(body);
    const cap = new THREE.Mesh(this.capGeo, this.capMat);
    cap.position.y = 0.34;
    g.add(cap);
    const fuseGroup = new THREE.Group();
    fuseGroup.position.y = 0.38;
    const fuse = new THREE.Mesh(this.fuseGeo, this.fuseMat);
    fuseGroup.add(fuse);
    const spark = new THREE.Mesh(this.sparkGeo, this.sparkMat);
    spark.position.copy(this.fuseTip);
    fuseGroup.add(spark);
    g.add(fuseGroup);
    g.position.set((x + 0.5) * CELL, ITEM_Y, (z + 0.5) * CELL);
    g.rotation.y = rand(0, TAU);
    g.scale.setScalar(0.001);
    this.group.add(g);
    const total = Number.isFinite(meta.fuseSec) && meta.fuseSec > 0 ? meta.fuseSec : Infinity;
    const rec = {
      id, type: 'bomb', x, z, group: g, body, mat, fuseGroup, spark, age: 0, sparkT: rand(0, this.sparkRate),
      fuseTotal: total, fuseLeft: total, blinkPhase: rand(0, TAU), sprite: null, spriteTex: null, spriteUntil: 0
    };
    this.items.set(id, rec);
    if (meta.giftImageUrl) this._attachGiftSprite(rec, meta.giftImageUrl);
  }

  /** Gift image hovering above the bomb for the first 3 seconds. */
  _attachGiftSprite(rec, url) {
    loadImage(url).then((img) => {
      if (!this.items.get(rec.id) || rec.removed) return;
      let tex;
      try { tex = imageTexture(img, 256); } catch (_) { return; }
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(0.75, 0.75, 1);
      sprite.position.y = 1.15;
      sprite.renderOrder = 30;
      rec.group.add(sprite);
      rec.sprite = sprite;
      rec.spriteTex = tex;
      rec.spriteUntil = rec.age + 3;
    }).catch(() => { /* no image: nothing to show */ });
  }

  setBombFuse(id, left) {
    const rec = this.items.get(id);
    if (!rec || rec.type !== 'bomb') return;
    rec.fuseLeft = Number.isFinite(left) ? Math.max(0, left) : Infinity;
  }

  has(id) { return this.items.has(id); }

  /** Position of the current apple ({x,z}) or null. */
  getApple() {
    for (const r of this.items.values()) if (r.type === 'apple') return { x: r.x, z: r.z };
    return null;
  }

  /**
   * Remove an item. Returns { type, x, z } for the facade to trigger effects,
   * or null if unknown. `silent` skips the out-animation (internal reuse).
   */
  remove(id, reason = 'cleared', silent = false) {
    const rec = this.items.get(id);
    if (!rec) return null;
    this.items.delete(id);
    rec.removed = true;
    if (silent || reason === 'eaten') {
      this._destroy(rec);
    } else {
      rec.dyingT = 0;
      rec.dyingDur = reason === 'expired' ? 0.3 : 0.22;
      this.dying.push(rec);
    }
    // [itens] `kind`/`villain` deixam o facade saber qual item especial saiu.
    return { type: rec.type, x: rec.x, z: rec.z, kind: rec.kind ?? null, villain: rec.villain === true };
  }

  clear() {
    for (const id of [...this.items.keys()]) this.remove(id, 'cleared', true);
    for (const rec of this.dying) this._destroy(rec);
    this.dying.length = 0;
  }

  _destroy(rec) {
    // [itens] o anel de base é criado por item (cor do time), então some junto com ele.
    if (rec.ringMat) { rec.ringMat.dispose(); rec.ringMat = null; }
    if (rec.spriteTex) { rec.spriteTex.dispose(); rec.spriteTex = null; }
    if (rec.sprite) { rec.sprite.material.dispose(); rec.sprite = null; }
    if (rec.mat) rec.mat.dispose();
    // Shared geometries/materials are owned by this class; only detach the group.
    rec.group.traverse((n) => { if (n.isSprite && n.material) n.material.dispose(); });
    this.group.remove(rec.group);
  }

  update(dt, elapsed) {
    let appleRec = null;
    let foodRec = null;
    this.goldRingMat.opacity = 0.6 + 0.3 * Math.sin(elapsed * 4.6);
    for (const rec of this.items.values()) {
      rec.age += dt;
      const pop = rec.age < 0.4 ? this._popIn(rec.age / 0.4) : 1;
      const g = rec.group;
      if (rec.type === 'apple') {
        appleRec = rec;
        const bob = Math.sin(elapsed * 2.6 + rec.phase) * 0.06;
        g.position.y = ITEM_Y + 0.05 + bob;
        g.rotation.y += dt * 0.9;
        g.scale.setScalar(pop);
        rec.ring.rotation.z += dt * 1.8;
        rec.ring.rotation.x = Math.PI / 2 - 0.35 + Math.sin(elapsed * 1.7) * 0.25;
        this.ringMat.opacity = 0.6 + 0.3 * Math.sin(elapsed * 4);
        rec.sparkT -= dt;
        if (rec.sparkT <= 0) {
          rec.sparkT = 0.12;
          const a = rand(0, TAU);
          this.pool.emit({
            x: g.position.x + Math.cos(a) * 0.5, y: g.position.y + rand(-0.1, 0.25), z: g.position.z + Math.sin(a) * 0.5,
            count: 1, colors: [0xfde68a, 0xffffff, 0xfbbf24], speed: 0.3, spread: 1, up: 0.6,
            life: 0.7, size: 0.22, gravity: 0.2, drag: 1, fade: 2
          });
        }
      } else if (rec.type === 'food') {
        foodRec = rec;
        const bob = Math.sin(elapsed * 2.9 + rec.phase) * 0.07;
        g.position.y = ITEM_Y + 0.07 + bob;
        g.rotation.y += dt * 1.4;
        g.scale.setScalar(pop);
        rec.ring.rotation.z += dt * 2.2;
        rec.ring.rotation.x = Math.PI / 2 - 0.35 + Math.sin(elapsed * 2.1 + rec.phase) * 0.3;
        rec.halo.rotation.z -= dt * 1.1;
        rec.halo.scale.setScalar(1.3 + 0.12 * Math.sin(elapsed * 3.4 + rec.phase));
        rec.sparkT -= dt;
        if (rec.sparkT <= 0) {
          rec.sparkT = 0.16;
          const a = rand(0, TAU);
          this.pool.emit({
            x: g.position.x + Math.cos(a) * 0.5, y: g.position.y + rand(-0.05, 0.35), z: g.position.z + Math.sin(a) * 0.5,
            count: 1, colors: PALETTES.goldFood, speed: 0.35, spread: 1, up: 0.8,
            life: 0.8, size: 0.24, gravity: 0.3, drag: 1, fade: 2
          });
        }
      } else if (rec.type === 'item') {
        // [itens] Cada item tem um movimento próprio; quando o pavio está acabando todos
        // começam a piscar e a encolher, avisando que vão sumir.
        const ratio = Number.isFinite(rec.fuseTotal) ? clamp(rec.fuseLeft / rec.fuseTotal, 0, 1) : 1;
        const dying = ratio < 0.35;
        const blink = dying ? 0.55 + 0.45 * Math.sin(elapsed * (rec.fuseLeft < 2 ? 26 : 13)) : 1;
        const bob = Math.sin(elapsed * 3.1 + rec.phase) * 0.07;
        g.position.y = ITEM_Y + 0.12 + bob;
        g.scale.setScalar(pop * (0.85 + 0.15 * blink));
        switch (rec.kind) {
          case 'bolt':
            // gira rápido e vibra: "energia instável", pavio curtíssimo
            g.rotation.y += dt * 5;
            g.position.x = (rec.x + 0.5) * CELL + Math.sin(elapsed * 40) * 0.012;
            break;
          case 'ice':
            g.rotation.y += dt * 0.8;
            g.rotation.x += dt * 0.4;
            break;
          case 'web':
            // fica deitada no chão, girando devagar
            rec.body.rotation.x = Math.PI / 2;
            g.rotation.y += dt * 0.5;
            g.position.y = ITEM_Y - 0.12;
            break;
          case 'skull':
            // encara a frente, balançando de leve — mais ameaçadora que uma bomba
            g.rotation.y = Math.sin(elapsed * 1.3 + rec.phase) * 0.5;
            g.position.y = ITEM_Y + 0.14 + Math.sin(elapsed * 1.9 + rec.phase) * 0.05;
            break;
          case 'star':
            g.rotation.y += dt * 3.2;
            g.rotation.z = Math.sin(elapsed * 2 + rec.phase) * 0.25;
            break;
          case 'clock':
            g.rotation.y += dt * 1.2;
            if (g.userData.hand) g.userData.hand.rotation.z -= dt * 7; // ponteiro correndo
            break;
          case 'magnet':
            g.rotation.y += dt * 2.2;
            g.rotation.z = Math.PI; // abertura do ímã virada para baixo
            break;
          default: // diamond
            g.rotation.y += dt * 2.4;
            break;
        }
        rec.ring.rotation.z += dt * (rec.villain ? -2 : 2);
        rec.ringMat.opacity = (0.55 + 0.35 * Math.sin(elapsed * 5 + rec.phase)) * blink;
        // Faíscas na cor do item.
        rec.sparkT -= dt;
        if (rec.sparkT <= 0) {
          rec.sparkT = this.quality === 'low' ? 0.34 : 0.18;
          const a = rand(0, TAU);
          this.pool.emit({
            x: g.position.x + Math.cos(a) * 0.42, y: g.position.y + rand(-0.1, 0.3), z: g.position.z + Math.sin(a) * 0.42,
            count: 1, colors: this.colorsFor(rec.kind), speed: 0.35, spread: 1,
            up: rec.villain ? -0.3 : 0.9, life: 0.75, size: 0.24, gravity: rec.villain ? 0.5 : -0.4, drag: 1, fade: 2
          });
        }
      } else {
        g.scale.setScalar(pop);
        // Blink accelerating as the fuse runs out.
        let f;
        const ratio = Number.isFinite(rec.fuseTotal) ? clamp(rec.fuseLeft / rec.fuseTotal, 0, 1) : 1;
        if (!Number.isFinite(rec.fuseTotal)) f = 1;
        else if (rec.fuseLeft < 5) f = 9;
        else f = 1 + 7 * (1 - ratio) * (1 - ratio);
        rec.blinkPhase += dt * f * TAU;
        const pulse = 0.5 + 0.5 * Math.sin(rec.blinkPhase);
        // Full red only in the last seconds; otherwise a dark-red pulse so bombs never read as apples.
        rec.mat.emissiveIntensity = pulse * pulse * pulse * (rec.fuseLeft < 5 ? 2.6 : 0.55);
        // Fuse burns down.
        const fs = Number.isFinite(rec.fuseTotal) ? 0.25 + 0.75 * ratio : 1;
        rec.fuseGroup.scale.setScalar(fs);
        const flick = 0.7 + 0.6 * Math.abs(Math.sin(elapsed * 31 + rec.blinkPhase));
        rec.spark.scale.setScalar(flick);
        rec.sparkT -= dt;
        if (rec.sparkT <= 0) {
          rec.sparkT = this.sparkRate;
          this.tmp.copy(this.fuseTip).multiplyScalar(fs).add(rec.fuseGroup.position);
          g.localToWorld(this.tmp);
          this.pool.emit({
            x: this.tmp.x, y: this.tmp.y, z: this.tmp.z, count: 2, colors: PALETTES.spark, speed: 1.4, spread: 0.5, up: 1.2,
            life: 0.45, lifeVar: 0.5, size: 0.16, sizeVar: 0.5, gravity: -4, drag: 2, fade: 1, jitter: 0.02
          });
        }
        if (rec.sprite) {
          const remain = rec.spriteUntil - rec.age;
          if (remain <= 0) {
            rec.spriteTex.dispose(); rec.sprite.material.dispose();
            g.remove(rec.sprite); rec.sprite = null; rec.spriteTex = null;
          } else {
            rec.sprite.position.y = 1.15 + Math.sin(elapsed * 3) * 0.06;
            rec.sprite.material.opacity = clamp(remain / 0.5, 0, 1);
          }
        }
      }
    }
    // Apple light follows the apple.
    if (this.appleLight) {
      if (appleRec) {
        this.appleLight.visible = true;
        this.appleLight.position.copy(appleRec.group.position).add(this.tmp.set(0, 0.5, 0));
        this.appleLight.intensity = 1.4 + 0.5 * Math.sin(elapsed * 5);
      } else {
        this.appleLight.visible = false;
      }
    }
    // Warm light over the newest golden food.
    if (this.foodLight) {
      if (foodRec) {
        this.foodLight.visible = true;
        this.foodLight.position.copy(foodRec.group.position).add(this.tmp.set(0, 0.55, 0));
        this.foodLight.intensity = 1.15 + 0.4 * Math.sin(elapsed * 4.2);
      } else {
        this.foodLight.visible = false;
      }
    }
    // Out-animations.
    for (let i = this.dying.length - 1; i >= 0; i--) {
      const rec = this.dying[i];
      rec.dyingT += dt;
      const k = clamp(rec.dyingT / rec.dyingDur, 0, 1);
      const s = (1 - k) * (1 - k);
      rec.group.scale.setScalar(Math.max(0.001, s));
      rec.group.position.y += dt * 1.5;
      if (k >= 1) { this._destroy(rec); this.dying.splice(i, 1); }
    }
  }

  /** Overshooting pop-in curve (0..1 → scale). */
  _popIn(t) {
    const e = 1 - Math.pow(1 - t, 3);
    return e * (1 + 0.35 * Math.sin(t * Math.PI));
  }

  dispose() {
    this.clear();
    disposeObject(this.group);
    // [itens] geometrias e materiais próprios dos itens especiais
    for (const map of [this.itemGeo, this.itemMat]) {
      for (const r of Object.values(map || {})) if (r && r.dispose) r.dispose();
    }
    for (const r of [this.appleGeo, this.appleMat, this.stemGeo, this.stemMat, this.leafGeo, this.leafMat, this.ringGeo, this.ringMat,
      this.goldMat, this.goldRingMat, this.bombGeo, this.capGeo, this.capMat, this.fuseGeo, this.fuseMat, this.sparkGeo, this.sparkMat]) {
      if (r && r.dispose) r.dispose();
    }
  }
}
