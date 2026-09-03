// Bomb-shield bubble: one iridescent fresnel sphere that follows the snake
// head while the shield is active. Everything is allocated once in the
// constructor; activation/deactivation only fades a uniform (deactivate fades
// out over ~0.5 s), so nothing is created or destroyed per frame.
import * as THREE from 'three';
import { damp } from './util.js';

const SHIELD_VERT = /* glsl */`
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const SHIELD_FRAG = /* glsl */`
  uniform float uTime;
  uniform float uOpacity;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vec3 n = normalize(vNormal);
    vec3 v = normalize(vView);
    // Fresnel rim: strong at grazing angles, nearly clear in the middle.
    float fres = pow(1.0 - abs(dot(n, v)), 2.2);
    // Iridescent drift between emerald, cyan and a hint of violet.
    float h = 0.5 + 0.5 * sin(uTime * 1.4 + n.y * 3.0 + n.x * 2.0);
    vec3 emerald = vec3(0.20, 0.83, 0.60);   // #34d399
    vec3 cyan    = vec3(0.13, 0.83, 0.93);   // #22d3ee
    vec3 violet  = vec3(0.65, 0.55, 0.98);   // #a78bfa
    vec3 col = mix(mix(emerald, cyan, h), violet, 0.25 * (0.5 + 0.5 * sin(uTime * 0.9 + n.z * 4.0)));
    float rim = fres * (0.85 + 0.15 * sin(uTime * 5.0));
    float fill = 0.05; // faint film so the bubble reads even face-on
    gl_FragColor = vec4(col * (rim + fill) * 1.7, (rim * 0.9 + fill) * uOpacity);
  }
`;

export class Shield {
  /** @param {THREE.Scene} scene */
  constructor(scene) {
    this.active = false;
    this.opacity = 0;
    this.geo = new THREE.SphereGeometry(0.68, 32, 24);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: SHIELD_VERT,
      fragmentShader: SHIELD_FRAG,
      uniforms: { uTime: { value: 0 }, uOpacity: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.name = 'shieldBubble';
    this.mesh.visible = false;
    this.mesh.renderOrder = 45;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  setActive(on) { this.active = !!on; }

  /**
   * @param {number} dt seconds
   * @param {number} elapsed seconds since start
   * @param {{ position: THREE.Vector3, visible: boolean } | null} head snake head info
   */
  update(dt, elapsed, head) {
    // Fade in fast, fade out over ~0.5 s (exp decay, ~3% left after 0.5 s).
    this.opacity = damp(this.opacity, this.active ? 1 : 0, this.active ? 12 : 7, dt);
    const show = this.opacity > 0.01 && !!(head && head.visible);
    this.mesh.visible = show;
    if (!show) return;
    this.mesh.position.copy(head.position);
    const s = 1 + 0.05 * Math.sin(elapsed * 3.2);
    this.mesh.scale.setScalar(s);
    this.mesh.rotation.y = elapsed * 0.6;
    this.mat.uniforms.uTime.value = elapsed;
    this.mat.uniforms.uOpacity.value = this.opacity;
  }

  dispose() {
    if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
    this.geo.dispose();
    this.mat.dispose();
  }
}
