// Apples and bombs living on the board, plus the gift image sprite that hovers
// above a freshly spawned bomb.
import * as THREE from 'three';
import { CELL, ITEM_Y, clamp, rand, TAU, loadImage, imageTexture, disposeObject } from './util.js';
import { PALETTES } from './effects.js';

const SPARK_COLOR = new THREE.Color(0xffa63d).multiplyScalar(3.5);

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
    return { type: rec.type, x: rec.x, z: rec.z };
  }

  clear() {
    for (const id of [...this.items.keys()]) this.remove(id, 'cleared', true);
    for (const rec of this.dying) this._destroy(rec);
    this.dying.length = 0;
  }

  _destroy(rec) {
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
    for (const r of [this.appleGeo, this.appleMat, this.stemGeo, this.stemMat, this.leafGeo, this.leafMat, this.ringGeo, this.ringMat,
      this.goldMat, this.goldRingMat, this.bombGeo, this.capGeo, this.capMat, this.fuseGeo, this.fuseMat, this.sparkGeo, this.sparkMat]) {
      if (r && r.dispose) r.dispose();
    }
  }
}
