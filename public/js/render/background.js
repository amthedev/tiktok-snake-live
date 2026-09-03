// Animated nebula sky-dome, twinkling starfield and floating dust motes.
import * as THREE from 'three';
import { rand, TAU, disposeObject } from './util.js';

const NEBULA_VERT = /* glsl */`
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
  }
`;

// Cheap value-noise FBM nebula. Colours: deep navy base, cyan / violet / emerald wisps.
const NEBULA_FRAG = /* glsl */`
  precision highp float;
  varying vec3 vDir;
  uniform float uTime;
  uniform vec3 uTint;
  float hash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float noise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash(i + vec3(0,0,0)), hash(i + vec3(1,0,0)), f.x),
          mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
      mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
          mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) {
    float a = 0.5, s = 0.0;
    for (int i = 0; i < 5; i++) { s += a * noise(p); p = p * 2.03 + 11.7; a *= 0.5; }
    return s;
  }
  void main() {
    vec3 d = normalize(vDir);
    float t = uTime * 0.02;
    vec3 p = d * 3.0 + vec3(t, t * 0.6, -t * 0.4);
    float n1 = fbm(p);
    float n2 = fbm(p * 2.1 + vec3(5.2, 1.3, 7.7) + n1 * 1.5);
    float wisp = smoothstep(0.35, 0.85, n2);
    // Linear-space colours (OutputPass converts to sRGB): keep them low.
    vec3 base = vec3(0.0015, 0.0025, 0.007);
    vec3 cyan = vec3(0.01, 0.10, 0.14);
    vec3 violet = vec3(0.07, 0.025, 0.14);
    vec3 emerald = vec3(0.01, 0.09, 0.07);
    float band = 0.5 + 0.5 * sin(d.x * 2.0 + n1 * 4.0 + t * 3.0);
    vec3 wispCol = mix(mix(violet, cyan, band), emerald, smoothstep(0.55, 0.9, n1));
    wispCol = mix(wispCol, uTint * 0.2, 0.35);
    // Fade wisps toward the horizon so the board area stays dark and readable.
    float horizon = smoothstep(-0.1, 0.6, d.y);
    vec3 col = base + wispCol * wisp * (0.15 + 0.85 * horizon) * (0.5 + 0.7 * n1);
    // Lower hemisphere stays almost black so the board pops.
    col *= 0.35 + 0.65 * horizon;
    gl_FragColor = vec4(col, 1.0);
  }
`;

const STAR_VERT = /* glsl */`
  attribute float aPhase;
  attribute float aSize;
  attribute vec3 aColor;
  uniform float uTime;
  uniform float uPixelRatio;
  varying float vTwinkle;
  varying vec3 vColor;
  void main() {
    vColor = aColor;
    float tw = 0.55 + 0.45 * sin(uTime * (1.2 + aPhase * 2.0) + aPhase * 40.0);
    vTwinkle = tw;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * uPixelRatio * (0.6 + 0.6 * tw);
  }
`;

const STAR_FRAG = /* glsl */`
  varying float vTwinkle;
  varying vec3 vColor;
  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float d = length(p) * 2.0;
    if (d > 1.0) discard;
    float a = smoothstep(1.0, 0.1, d);
    gl_FragColor = vec4(vColor, a * vTwinkle);
  }
`;

export class Background {
  /**
   * @param {THREE.Scene} scene
   * @param {{ quality: string, pixelRatio: number }} opts
   */
  constructor(scene, { quality = 'high', pixelRatio = 1 } = {}) {
    this.group = new THREE.Group();
    this.group.name = 'background';
    scene.add(this.group);
    this.tint = new THREE.Color(0x22d3ee);
    this.targetTint = new THREE.Color(0x22d3ee);

    // --- Nebula dome ---------------------------------------------------------
    this.nebulaMat = new THREE.ShaderMaterial({
      vertexShader: NEBULA_VERT,
      fragmentShader: NEBULA_FRAG,
      uniforms: { uTime: { value: 0 }, uTint: { value: new THREE.Color(0x22d3ee) } },
      side: THREE.BackSide,
      depthWrite: false,
      fog: false
    });
    const dome = new THREE.Mesh(new THREE.SphereGeometry(400, 48, 32), this.nebulaMat);
    dome.frustumCulled = false;
    dome.renderOrder = -100;
    this.dome = dome;
    this.group.add(dome);

    // --- Starfield -------------------------------------------------------------
    const starCount = quality === 'low' ? 900 : quality === 'medium' ? 1600 : 2600;
    const sPos = new Float32Array(starCount * 3);
    const sPhase = new Float32Array(starCount);
    const sSize = new Float32Array(starCount);
    const sCol = new Float32Array(starCount * 3);
    const palette = [0xffffff, 0xbfe9ff, 0x7dd3fc, 0xfef3c7, 0xe9d5ff];
    const c = new THREE.Color();
    for (let i = 0; i < starCount; i++) {
      // Everywhere around, but weighted to the upper hemisphere.
      const theta = rand(0, TAU);
      const y = rand(-0.15, 1);
      const r = Math.sqrt(1 - y * y);
      const dist = rand(250, 360);
      sPos[i * 3] = Math.cos(theta) * r * dist;
      sPos[i * 3 + 1] = y * dist;
      sPos[i * 3 + 2] = Math.sin(theta) * r * dist;
      sPhase[i] = Math.random();
      sSize[i] = rand(1.2, 3.4) * (Math.random() < 0.06 ? 2.2 : 1);
      c.setHex(palette[(Math.random() * palette.length) | 0]);
      sCol[i * 3] = c.r; sCol[i * 3 + 1] = c.g; sCol[i * 3 + 2] = c.b;
    }
    const sGeo = new THREE.BufferGeometry();
    sGeo.setAttribute('position', new THREE.BufferAttribute(sPos, 3));
    sGeo.setAttribute('aPhase', new THREE.BufferAttribute(sPhase, 1));
    sGeo.setAttribute('aSize', new THREE.BufferAttribute(sSize, 1));
    sGeo.setAttribute('aColor', new THREE.BufferAttribute(sCol, 3));
    this.starMat = new THREE.ShaderMaterial({
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      uniforms: { uTime: { value: 0 }, uPixelRatio: { value: pixelRatio } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    this.stars = new THREE.Points(sGeo, this.starMat);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -90;
    this.group.add(this.stars);

    // --- Dust motes near the board ---------------------------------------------
    this.dustCount = quality === 'low' ? 60 : 160;
    const dPos = new Float32Array(this.dustCount * 3);
    const dPhase = new Float32Array(this.dustCount);
    const dSize = new Float32Array(this.dustCount);
    const dCol = new Float32Array(this.dustCount * 3);
    for (let i = 0; i < this.dustCount; i++) {
      dPhase[i] = Math.random();
      dSize[i] = rand(1.5, 3.2);
      c.setHex(Math.random() < 0.5 ? 0x9be7ff : 0xfff1c2);
      dCol[i * 3] = c.r; dCol[i * 3 + 1] = c.g; dCol[i * 3 + 2] = c.b;
    }
    const dGeo = new THREE.BufferGeometry();
    this.dustPosAttr = new THREE.BufferAttribute(dPos, 3).setUsage(THREE.DynamicDrawUsage);
    dGeo.setAttribute('position', this.dustPosAttr);
    dGeo.setAttribute('aPhase', new THREE.BufferAttribute(dPhase, 1));
    dGeo.setAttribute('aSize', new THREE.BufferAttribute(dSize, 1));
    dGeo.setAttribute('aColor', new THREE.BufferAttribute(dCol, 3));
    dGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    this.dustMat = new THREE.ShaderMaterial({
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      uniforms: { uTime: { value: 0 }, uPixelRatio: { value: pixelRatio } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0.6
    });
    this.dust = new THREE.Points(dGeo, this.dustMat);
    this.dust.frustumCulled = false;
    this.group.add(this.dust);
    this.dustVel = new Float32Array(this.dustCount * 3);
    this.bounds = { w: 16, h: 16 };
    this.setBoard(16, 16);
  }

  setPixelRatio(pr) {
    this.starMat.uniforms.uPixelRatio.value = pr;
    this.dustMat.uniforms.uPixelRatio.value = pr;
  }

  /** Re-centre the dome and re-seed dust for a new board size. */
  setBoard(w, h) {
    this.bounds = { w, h };
    this.group.position.set(w / 2, 0, h / 2);
    const p = this.dustPosAttr.array;
    for (let i = 0; i < this.dustCount; i++) {
      p[i * 3] = rand(-w * 0.7, w * 0.7);
      p[i * 3 + 1] = rand(0.3, 7);
      p[i * 3 + 2] = rand(-h * 0.7, h * 0.7);
      this.dustVel[i * 3] = rand(-0.25, 0.25);
      this.dustVel[i * 3 + 1] = rand(0.05, 0.25);
      this.dustVel[i * 3 + 2] = rand(-0.25, 0.25);
    }
    this.dustPosAttr.needsUpdate = true;
  }

  /** Tint the nebula for a phase (cyan playing, gold win, red loss). */
  setTint(hex) { this.targetTint.setHex(hex); }

  update(dt, elapsed) {
    this.nebulaMat.uniforms.uTime.value = elapsed;
    this.starMat.uniforms.uTime.value = elapsed;
    this.dustMat.uniforms.uTime.value = elapsed;
    this.tint.lerp(this.targetTint, 1 - Math.exp(-1.5 * dt));
    this.nebulaMat.uniforms.uTint.value.copy(this.tint);
    this.stars.rotation.y += dt * 0.004;
    // Drift the dust and wrap inside the box.
    const { w, h } = this.bounds;
    const p = this.dustPosAttr.array;
    const v = this.dustVel;
    for (let i = 0; i < this.dustCount; i++) {
      const i3 = i * 3;
      p[i3] += (v[i3] + Math.sin(elapsed * 0.6 + i) * 0.08) * dt;
      p[i3 + 1] += v[i3 + 1] * dt;
      p[i3 + 2] += (v[i3 + 2] + Math.cos(elapsed * 0.5 + i * 1.7) * 0.08) * dt;
      if (p[i3 + 1] > 7.5) p[i3 + 1] = 0.3;
      if (p[i3] > w * 0.7) p[i3] = -w * 0.7; else if (p[i3] < -w * 0.7) p[i3] = w * 0.7;
      if (p[i3 + 2] > h * 0.7) p[i3 + 2] = -h * 0.7; else if (p[i3 + 2] < -h * 0.7) p[i3 + 2] = h * 0.7;
    }
    this.dustPosAttr.needsUpdate = true;
  }

  dispose() { disposeObject(this.group); }
}
