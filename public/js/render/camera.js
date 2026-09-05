// Portrait-first camera framing (SPEC §7.2). Solves the camera distance so the
// board (incl. rim) fits inside 92 % of the viewport width and the vertical
// band, then uses setViewOffset to move the board centre to the band centre.
//
// [layout] `width`/`height` here are the STAGE's size (#safe), not the window's — the renderer
// measures its container, and the container is the locked 9:16 stage. So the band fractions below
// are fractions of the stage and line up exactly with overlay.css's --zone-* map.
import * as THREE from 'three';

export const FOV = 36;
export const ELEVATION_DEG = 55;
// Single format by design (client request 2026-09-03): TikTok LIVE portrait 9:16.
// [layout] The board's SAFE STRIP is 30–71 % of the stage (--zone-head → --zone-board in
// overlay.css), and the camera uses ALL of it. Keep in sync with overlay.css's --zone-* map and
// with ZONES in ui/stage.js.
//
// [live-real] 2026-09-05: a faixa passou de 24–72 % para 30–71 %. O motivo não é enquadramento, é
// o chat do TikTok: numa live real ele cobre tudo abaixo de ~70 %, então o painel do duelo (que
// vivia em 72–76 %) subiu para o bloco principal, logo abaixo da barra do app. O tabuleiro pagou
// 3 % no topo e 1 % embaixo para abrir esse espaço.
//
// Custo real, MEDIDO: nenhum. A projeção é limitada pela LARGURA (WIDTH_FRACTION = 0.98), não pela
// altura da faixa — com 48 % de faixa sobravam ~41 px de folga vertical, e com 41 % ainda sobra
// folga. O board é desenhado exatamente do mesmo tamanho; só o centro dele desceu ~1,5 % da
// altura do palco, o que também é bom: afasta o tabuleiro da zona de chat.
export const BAND_PORTRAIT = [0.30, 0.79];  // [live real] alinhado às zonas do CSS: a tabela de presentes subiu e o tabuleiro herdou o espaço até 79 %
export const BAND_LANDSCAPE = BAND_PORTRAIT;
export const WIDTH_FRACTION = 0.98;
// [enquadramento] 2026-09-04: com 0.92 a câmera resolvia a distância pela LARGURA e o tabuleiro
// terminava em ~58,8 % da altura, deixando um vão de 13 % até o painel do duelo (72 %) — e as
// decorações laterais do cenário passavam por baixo dele, dando a impressão de que o painel
// tapava o jogo. Com 0.98 o limite volta a ser a ALTURA da faixa: o tabuleiro cresce e encosta
// no painel sem invadi-lo.

const _v = new THREE.Vector3();
const _corners = new Array(8).fill(null).map(() => new THREE.Vector3());

function fillCorners(b) {
  let i = 0;
  for (const x of [b.minX, b.maxX]) for (const y of [b.minY, b.maxY]) for (const z of [b.minZ, b.maxZ]) _corners[i++].set(x, y, z);
}

/** Project the bounds' corners; returns a CSS-pixel rect {x,y,w,h}. */
export function projectBounds(camera, bounds, width, height) {
  fillCorners(bounds);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of _corners) {
    _v.copy(c).project(camera);
    const px = (_v.x + 1) * 0.5 * width;
    const py = (1 - _v.y) * 0.5 * height;
    if (px < minX) minX = px; if (px > maxX) maxX = px;
    if (py < minY) minY = py; if (py > maxY) maxY = py;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Frame `bounds` for the given viewport. Mutates the camera (position,
 * orientation, aspect, view offset). Returns { rect, distance, band }.
 */
export function frameCamera(camera, bounds, width, height, { elevationDeg = ELEVATION_DEG } = {}) {
  const portrait = height >= width;
  const band = portrait ? BAND_PORTRAIT : BAND_LANDSCAPE;
  const bandH = (band[1] - band[0]) * height;
  const bandCy = (band[0] + band[1]) * 0.5 * height;
  const centre = new THREE.Vector3((bounds.minX + bounds.maxX) / 2, 0, (bounds.minZ + bounds.maxZ) / 2);
  const el = THREE.MathUtils.degToRad(elevationDeg);
  const dir = new THREE.Vector3(0, Math.sin(el), Math.cos(el));

  camera.fov = FOV;
  camera.aspect = width / height;
  camera.near = 0.5;
  camera.far = 1200;
  camera.clearViewOffset();
  camera.updateProjectionMatrix();

  const extent = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
  let dist = extent * 2.2;
  fillCorners(bounds);
  for (let iter = 0; iter < 16; iter++) {
    camera.position.copy(centre).addScaledVector(dir, dist);
    camera.lookAt(centre);
    camera.updateMatrixWorld(true);
    let halfW = 0, halfH = 0;
    for (const c of _corners) {
      _v.copy(c).project(camera);
      halfW = Math.max(halfW, Math.abs(_v.x) * 0.5 * width);
      halfH = Math.max(halfH, Math.abs(_v.y) * 0.5 * height);
    }
    const ratio = Math.max((halfW * 2) / (WIDTH_FRACTION * width), (halfH * 2) / bandH);
    dist *= ratio;
    if (Math.abs(ratio - 1) < 0.001) break;
  }
  dist *= 1.005; // hair of margin against rounding
  camera.position.copy(centre).addScaledVector(dir, dist);
  camera.lookAt(centre);
  camera.updateMatrixWorld(true);
  // Shift the image so the board centre lands on the band centre.
  const offsetY = height / 2 - bandCy;
  camera.setViewOffset(width, height, 0, offsetY, width, height);
  camera.updateMatrixWorld(true);
  const rect = projectBounds(camera, bounds, width, height);
  return { rect, distance: dist, band, centre, dir };
}
