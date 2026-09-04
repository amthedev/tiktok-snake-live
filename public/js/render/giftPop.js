// 3D gift "pop": a billboard card (gift image + nickname + ×count) rising from
// a board cell for ~2.5 s. 'mega' pops are bigger with a sparkle trail and a
// golden shockwave.
import * as THREE from 'three';
import { CELL, ITEM_Y, clamp, TAU, loadImage, makeCanvas, roundRect, drawAvatar, canvasTexture, truncate, disposeObject } from './util.js';
import { giftSparkle, PALETTES } from './effects.js';

const DURATION = 2.5;
const MAX_ACTIVE = 8;

/** Card border/accent per team ('hero' emerald/gold, 'villain' rose/ember, default cyan/gold). */
function accentFor(team, mega) {
  if (team === 'hero') return mega ? '#fbbf24' : '#34d399';
  if (team === 'villain') return mega ? '#ff6a3d' : '#fb7185';
  return mega ? '#fbbf24' : '#22d3ee';
}

function drawCard(ctx, W, H, { img, nickname, count, effect, team }) {
  ctx.clearRect(0, 0, W, H);
  const mega = effect === 'mega';
  const accent = accentFor(team, mega);
  // Glass card.
  roundRect(ctx, 16, 16, W - 32, H - 32, 44);
  ctx.fillStyle = 'rgba(8, 14, 30, 0.82)';
  ctx.fill();
  ctx.lineWidth = mega ? 10 : 6;
  ctx.strokeStyle = accent;
  ctx.stroke();
  // Gift image (or a gift glyph fallback) in a circle.
  const cx = W / 2, cy = H * 0.36, r = W * 0.3;
  if (img) {
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.closePath(); ctx.clip();
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    const s = Math.min((2 * r) / iw, (2 * r) / ih) * 0.9;
    ctx.drawImage(img, cx - (iw * s) / 2, cy - (ih * s) / 2, iw * s, ih * s);
    ctx.restore();
  } else {
    drawAvatar(ctx, cx, cy, r, null, nickname);
    ctx.font = `${Math.round(r * 1.1)}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🎁', cx, cy + r * 0.05);
  }
  ctx.beginPath(); ctx.arc(cx, cy, r + 4, 0, TAU); ctx.lineWidth = 6; ctx.strokeStyle = accent; ctx.stroke();
  // Count.
  ctx.fillStyle = accent;
  ctx.font = `900 ${Math.round(W * 0.2)}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`×${Math.max(1, count | 0)}`, cx, H * 0.67);
  // Nickname.
  // [celular] 0.11 → 0.20 da largura do cartão (mesmo tamanho do contador ×N). Medido no palco e
  // normalizado para 1080 (o formato da live), 0.11 dava 12,8 px — abaixo do piso de 22 px, ilegível
  // no celular. Com 0.20 e o cartão em 2.8 (ver spawn), o pior caso — cartão no fundo do tabuleiro,
  // mais distante da câmera — fica em 22,3 px. Como a letra quase dobrou, o truncamento cai de 14
  // para 10 caracteres, senão um apelido longo vazaria da borda do cartão.
  ctx.fillStyle = '#ffffff';
  ctx.font = `800 ${Math.round(W * 0.2)}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  ctx.fillText(truncate(nickname || 'Fã', 10), cx, H * 0.85);
}

export class GiftPops {
  constructor(scene, { pool, shockwaves }) {
    this.pool = pool;
    this.shockwaves = shockwaves;
    this.group = new THREE.Group();
    this.group.name = 'giftPops';
    scene.add(this.group);
    this.active = [];
  }

  pop({ imageUrl = null, nickname = '', count = 1, x = 0, z = 0, effect = 'normal', team = null } = {}) {
    if (this.active.length >= MAX_ACTIVE) this._end(this.active.shift());
    if (team !== 'hero' && team !== 'villain') team = null;
    const mega = effect === 'mega';
    const W = 512, H = 640;
    const canvas = makeCanvas(W, H);
    const ctx = canvas.getContext('2d');
    const data = { img: null, nickname, count, effect, team };
    drawCard(ctx, W, H, data);
    const tex = canvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    // [celular] cartão normal 2.4 → 2.8. O cartão é desenhado num canvas quadrado e projetado em 3D,
    // então o tamanho do texto na tela depende da LARGURA projetada do sprite (largura útil =
    // base × 0.8, ver update()). Medido e normalizado para 1080 (o formato da live), com base 2.4 o
    // apelido caía para 18,2–20,8 px conforme a distância da câmera — abaixo do piso de 22 px na
    // maior parte do tabuleiro. Com 2.8 o pior caso (cartão no fundo, mais longe) fica ≥22 px.
    // O cartão 'mega' já passava com folga (27–32 px) e não muda.
    const base = mega ? 3.6 : 2.8;
    sprite.scale.set(base * (W / H), base, 1);
    sprite.renderOrder = 60;
    const wx = (x + 0.5) * CELL, wz = (z + 0.5) * CELL;
    sprite.position.set(wx, ITEM_Y + 0.6, wz);
    this.group.add(sprite);
    const sparkColors = team === 'hero' ? PALETTES.heroGift : team === 'villain' ? PALETTES.villainGift : PALETTES.gift;
    const rec = { sprite, mat, tex, t: 0, base, mega, wx, wz, sparkT: 0, alive: true, sparkColors };
    this.active.push(rec);
    if (imageUrl) {
      loadImage(imageUrl).then((img) => {
        if (!rec.alive) return;
        data.img = img;
        drawCard(ctx, W, H, data);
        tex.needsUpdate = true;
      }).catch(() => { /* keep the fallback card */ });
    }
    if (mega) {
      const waveColor = team === 'villain' ? 0xff6a3d : 0xfbbf24;
      this.shockwaves.spawn(wx, ITEM_Y - 0.25, wz, { color: waveColor, radius: 4, duration: 0.9 });
      giftSparkle(this.pool, wx, ITEM_Y + 0.5, wz, 60, sparkColors);
    } else {
      giftSparkle(this.pool, wx, ITEM_Y + 0.5, wz, 18, sparkColors);
    }
  }

  update(dt) {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const r = this.active[i];
      r.t += dt;
      const k = r.t / DURATION;
      if (k >= 1) { this._end(r); this.active.splice(i, 1); continue; }
      // Rise with ease-out; elastic pop-in; fade at the end.
      const rise = 1 - Math.pow(1 - k, 2.2);
      r.sprite.position.y = ITEM_Y + 0.8 + rise * (r.mega ? 3.4 : 2.6);
      const pin = clamp(r.t / 0.4, 0, 1);
      const elastic = 1 - Math.pow(2, -8 * pin) * Math.cos(pin * 10);
      const s = r.base * (0.2 + 0.8 * elastic);
      r.sprite.scale.set(s * 0.8, s, 1);
      r.mat.opacity = k > 0.8 ? clamp((1 - k) / 0.2, 0, 1) : 1;
      if (r.mega) {
        r.sparkT -= dt;
        if (r.sparkT <= 0) {
          r.sparkT = 0.06;
          giftSparkle(this.pool, r.wx, r.sprite.position.y - 0.6, r.wz, 3, r.sparkColors);
        }
      }
    }
  }

  _end(r) {
    r.alive = false;
    this.group.remove(r.sprite);
    r.tex.dispose();
    r.mat.dispose();
  }

  dispose() {
    for (const r of this.active) this._end(r);
    this.active.length = 0;
    disposeObject(this.group);
  }
}
