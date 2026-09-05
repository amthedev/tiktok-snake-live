// public/js/ui/stage.js — [layout] PALCO 9:16 TRAVADO + guias de zona segura (?safezone=1)
//
// Why this module exists
// ----------------------
// The overlay must look IDENTICAL whatever the browser/OBS window shape: a 9:16 stage, centred,
// as large as fits, with black bars around it (letterbox/pillarbox), exactly like a video player.
// CSS alone gets 95 % of the way there (`#safe { aspect-ratio: 9/16 }` + container queries), but
// two things need real numbers:
//
//   1. `html { font-size }` cannot be driven by container-query units — `rem` always resolves
//      against the root element, which is outside the container. Since the whole stylesheet is
//      written in `rem`, the root font-size *is* the scale factor of the composition. We therefore
//      compute it here: 1rem === 1 % of the stage height.
//   2. Sub-pixel rounding. Letting the browser round `aspect-ratio` independently from our own
//      arithmetic makes the stage a fraction of a pixel off 9:16, which the 3D camera then bakes
//      into the framing. We round the stage to whole pixels once and publish the exact numbers.
//
// Everything is published as CSS custom properties on :root, so the stylesheet keeps ownership of
// the actual layout:
//   --stage-w / --stage-h : the stage box in px
//   --u                   : 1 % of the stage height (the unit every band offset is written in)
//
// The renderer needs no special casing: it already measures `container.clientWidth/clientHeight`
// and observes it with a ResizeObserver, and its container (#stage) now fills #safe.

export const STAGE_ASPECT = 9 / 16;

/** Safe-area map, in % of the stage height. Mirrors --zone-* in overlay.css and BAND_PORTRAIT
 *  in render/camera.js — keep the three in sync.
 *
 *  [live-real] 2026-09-05: a prioridade vertical foi INVERTIDA depois do print de uma live real.
 *  O chat do TikTok sobe muito mais do que se supunha e cobre tudo abaixo de ~79 %, então TUDO
 *  que precisa ser lido (placar, duelo, carrossel de metas E a tabela de presentes) vive agora
 *  em 11–36 %, logo abaixo da barra do app. Nada essencial fica abaixo do tabuleiro: a faixa
 *  79–100 % carrega só o trilho de chat local, que é descartável. */
// [live real] Mapa alinhado ao que o print da live mostrou: o chat do TikTok invade tudo abaixo
// de ~79 %, então a tabela de presentes subiu para o bloco principal e o tabuleiro herdou o resto.
export const ZONES = [
  { from: 0,  to: 11,  kind: 'dead',  label: 'ZONA MORTA · barra do TikTok' },
  { from: 11, to: 36,  kind: 'head',  label: 'PRINCIPAL · placar, duelo, ranking e presentes' },
  { from: 36, to: 79,  kind: 'board', label: 'TABULEIRO · área segura' },
  { from: 79, to: 100, kind: 'dead',  label: 'ZONA MORTA · chat e presentes do TikTok' }
];

/**
 * Measure the window and write the stage geometry to :root.
 * @param {{win?: Window, doc?: Document}} [deps]
 * @returns {{width: number, height: number, unit: number}} the stage box, in CSS px.
 */
export function sizeStage({ win = window, doc = document } = {}) {
  // visualViewport is the honest size on mobile/in-app browsers (the URL bar lies about innerHeight).
  const vw = Math.max(1, Math.round(win.visualViewport?.width ?? win.innerWidth ?? 1));
  const vh = Math.max(1, Math.round(win.visualViewport?.height ?? win.innerHeight ?? 1));

  // Largest 9:16 box that fits: limited by width in a tall window, by height in a wide one.
  let height = vh;
  let width = height * STAGE_ASPECT;
  if (width > vw) { width = vw; height = width / STAGE_ASPECT; }
  width = Math.max(2, Math.floor(width));
  height = Math.max(2, Math.floor(height));

  const unit = height / 100;
  const root = doc.documentElement;
  root.style.setProperty('--stage-w', width + 'px');
  root.style.setProperty('--stage-h', height + 'px');
  root.style.setProperty('--u', unit + 'px');
  // 1rem === 1 % of the stage height. Floored at 6px: below that the browser's minimum font-size
  // would start distorting the composition anyway, and the overlay is unusable that small.
  root.style.fontSize = Math.max(6, unit) + 'px';
  return { width, height, unit };
}

/**
 * Install the stage: size it now and keep it sized. Returns a disposer.
 * @param {{win?: Window, doc?: Document, onResize?: (box: {width:number,height:number,unit:number}) => void}} [opts]
 */
export function installStage({ win = window, doc = document, onResize = null } = {}) {
  let frame = 0;
  const apply = () => {
    frame = 0;
    const box = sizeStage({ win, doc });
    try { onResize?.(box); } catch (err) { console.warn('[stage] onResize falhou', err); }
  };
  // Coalesce bursts of resize events into one write per frame.
  const schedule = () => { if (!frame) frame = win.requestAnimationFrame(apply); };

  apply();
  win.addEventListener('resize', schedule);
  win.addEventListener('orientationchange', schedule);
  win.visualViewport?.addEventListener('resize', schedule);

  return () => {
    if (frame) win.cancelAnimationFrame(frame);
    win.removeEventListener('resize', schedule);
    win.removeEventListener('orientationchange', schedule);
    win.visualViewport?.removeEventListener('resize', schedule);
  };
}

/**
 * Draw the ?safezone=1 guides into `host` (#safezone). Idempotent.
 * @param {HTMLElement|null} host
 * @param {boolean} on
 */
export function renderSafezone(host, on) {
  if (!host) return;
  host.classList.toggle('hidden', !on);
  if (!on) { host.replaceChildren(); return; }
  const nodes = [];
  for (const z of ZONES) {
    const div = document.createElement('div');
    div.className = 'sz-zone ' + z.kind;
    div.style.top = `calc(${z.from} * var(--u))`;
    div.style.height = `calc(${z.to - z.from} * var(--u))`;
    const label = document.createElement('span');
    label.className = 'sz-label';
    label.textContent = `${z.from}–${z.to}% · ${z.label}`;
    div.appendChild(label);
    nodes.push(div);
  }
  for (const side of ['left', 'right']) {
    const s = document.createElement('div');
    s.className = 'sz-side ' + side;
    nodes.push(s);
  }
  host.replaceChildren(...nodes);
}

/** True when the URL asks for the safe-area guides (`?safezone=1`). */
export function safezoneRequested(search = (typeof location !== 'undefined' ? location.search : '')) {
  let params;
  try { params = new URLSearchParams(search); } catch { return false; }
  if (!params.has('safezone')) return false;
  const v = String(params.get('safezone')).trim().toLowerCase();
  return v === '' || v === '1' || v === 'true' || v === 'on' || v === 'sim' || v === 'yes';
}
