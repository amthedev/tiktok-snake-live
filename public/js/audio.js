// public/js/audio.js
// WebAudio synthesised sound effects (SPEC §8 "Audio"). No external files.
//
// createAudio(enabled) → { play(name), setEnabled(b), enabled, resume(), dispose() }
// Names: 'eat' | 'bomb' | 'expire' | 'gift' | 'mega' | 'win' | 'lose' | 'tick' | 'start'
//
// Design goals: short, pleasant, low volume, never fatiguing when the snake eats 60+ apples in a
// row. The 'eat' blip walks up a pentatonic scale and is rate-limited; everything goes through a
// master gain + a soft compressor so overlapping effects never clip.

const PENTATONIC = [0, 2, 4, 7, 9, 12, 14, 16]; // semitone offsets used for the rising eat blip
const BASE_MIDI = 76; // E5

const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

/** Per-effect minimum spacing (ms) so spam never becomes noise. */
const MIN_GAP_MS = {
  eat: 70,
  bomb: 120,
  expire: 150,
  gift: 120,
  mega: 400,
  win: 1000,
  lose: 1000,
  tick: 80,
  start: 300,
  // [itens] sons dos itens especiais
  boltSpawn: 90, bolt: 120,
  iceSpawn: 90, ice: 200,
  webSpawn: 90, web: 200,
  skullSpawn: 150, skull: 300,
  gemSpawn: 90, diamond: 120,
  starSpawn: 150, star: 300,
  magnet: 200, clock: 200,
  shieldPop: 120
};

/**
 * @param {boolean} enabled   initial enabled flag
 * @param {object} [opts]
 * @param {boolean} [opts.autoResume=true]  try to resume immediately (OBS) and on first user gesture
 * @param {number}  [opts.volume=0.5]       master volume 0..1
 */
export function createAudio(enabled = true, opts = {}) {
  const { autoResume = true, volume = 0.5 } = opts;
  const AC = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;

  let ctx = null;
  let master = null;
  let noiseBuffer = null;
  let isEnabled = !!enabled;
  let eatStep = 0;
  let disposed = false;
  const lastPlayed = Object.create(null);
  const gestureEvents = ['pointerdown', 'keydown', 'touchstart'];
  let gestureBound = false;

  function ensureContext() {
    if (ctx || !AC || disposed) return ctx;
    try {
      ctx = new AC({ latencyHint: 'interactive' });
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.knee.value = 12;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.15;
      master = ctx.createGain();
      master.gain.value = Math.max(0, Math.min(1, volume));
      master.connect(comp);
      comp.connect(ctx.destination);
    } catch (err) {
      ctx = null;
      master = null;
    }
    return ctx;
  }

  function getNoise() {
    if (noiseBuffer || !ctx) return noiseBuffer;
    const len = Math.floor(ctx.sampleRate * 0.6);
    noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return noiseBuffer;
  }

  /** Resume the AudioContext (browsers require a user gesture outside OBS). Safe to call anytime. */
  async function resume() {
    const c = ensureContext();
    if (!c) return false;
    if (c.state === 'suspended') {
      try { await c.resume(); } catch { /* not allowed yet */ }
    }
    return c.state === 'running';
  }

  function bindGesture() {
    if (gestureBound || typeof window === 'undefined') return;
    gestureBound = true;
    const handler = () => {
      resume().then((ok) => { if (ok) unbindGesture(); });
    };
    bindGesture._handler = handler;
    for (const ev of gestureEvents) window.addEventListener(ev, handler, { passive: true });
  }

  function unbindGesture() {
    if (!gestureBound || typeof window === 'undefined') return;
    gestureBound = false;
    for (const ev of gestureEvents) window.removeEventListener(ev, bindGesture._handler);
  }

  // ---- primitive voices -------------------------------------------------------------------

  /** Simple enveloped oscillator. freqs: [start, end] for a glide; times in seconds. */
  function tone({ type = 'sine', freq = 440, freqEnd = null, at = 0, dur = 0.12, gain = 0.2, attack = 0.005, release = null, detune = 0, lowpass = null }) {
    const t0 = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (freqEnd) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t0 + dur);
    if (detune) osc.detune.value = detune;
    const rel = release ?? Math.min(0.08, dur * 0.5);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + attack);
    g.gain.setValueAtTime(gain, t0 + Math.max(attack, dur - rel));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    let node = osc;
    if (lowpass) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = lowpass;
      osc.connect(f);
      node = f;
    }
    node.connect(g);
    g.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
    osc.onended = () => { try { osc.disconnect(); g.disconnect(); } catch { /* ignore */ } };
  }

  /** Filtered noise burst. */
  function noise({ at = 0, dur = 0.25, gain = 0.15, filter = 'lowpass', freq = 800, freqEnd = null, q = 0.8 }) {
    const t0 = ctx.currentTime + at;
    const src = ctx.createBufferSource();
    src.buffer = getNoise();
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.Q.value = q;
    f.frequency.setValueAtTime(freq, t0);
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
    src.onended = () => { try { src.disconnect(); f.disconnect(); g.disconnect(); } catch { /* ignore */ } };
  }

  // ---- effects ----------------------------------------------------------------------------

  const FX = {
    eat() {
      // Rising pentatonic blip: pleasant even when repeated many times.
      const semis = PENTATONIC[eatStep % PENTATONIC.length];
      eatStep = (eatStep + 1) % (PENTATONIC.length * 2);
      const f = midiToHz(BASE_MIDI + semis);
      tone({ type: 'sine', freq: f, freqEnd: f * 1.5, dur: 0.09, gain: 0.16, attack: 0.004 });
      tone({ type: 'triangle', freq: f * 2, dur: 0.06, gain: 0.05, at: 0.02 });
    },
    bomb() {
      // Explosion: noise thump + sub drop.
      noise({ dur: 0.35, gain: 0.32, filter: 'lowpass', freq: 1800, freqEnd: 120 });
      tone({ type: 'sine', freq: 160, freqEnd: 38, dur: 0.42, gain: 0.35, attack: 0.002 });
      tone({ type: 'square', freq: 90, freqEnd: 30, dur: 0.18, gain: 0.08, lowpass: 400 });
    },
    expire() {
      // Soft grey puff.
      noise({ dur: 0.22, gain: 0.08, filter: 'bandpass', freq: 900, freqEnd: 300, q: 0.6 });
    },
    gift() {
      // Two-note bell chime.
      tone({ type: 'triangle', freq: midiToHz(84), dur: 0.22, gain: 0.16 });
      tone({ type: 'triangle', freq: midiToHz(88), dur: 0.30, gain: 0.16, at: 0.09 });
      tone({ type: 'sine', freq: midiToHz(96), dur: 0.35, gain: 0.05, at: 0.09 });
    },
    mega() {
      // Ascending arpeggio + shimmer.
      const notes = [72, 76, 79, 84, 88];
      notes.forEach((m, i) => {
        tone({ type: 'triangle', freq: midiToHz(m), dur: 0.35, gain: 0.15, at: i * 0.07 });
        tone({ type: 'sine', freq: midiToHz(m + 12), dur: 0.25, gain: 0.05, at: i * 0.07 + 0.02 });
      });
      noise({ at: 0.25, dur: 0.6, gain: 0.05, filter: 'highpass', freq: 5000 });
      tone({ type: 'sine', freq: midiToHz(96), dur: 0.9, gain: 0.08, at: 0.35, attack: 0.1 });
    },
    win() {
      // Short fanfare.
      const seq = [[72, 0, 0.14], [76, 0.14, 0.14], [79, 0.28, 0.14], [84, 0.42, 0.55]];
      for (const [m, at, dur] of seq) {
        tone({ type: 'square', freq: midiToHz(m), dur, gain: 0.09, at, lowpass: 2200 });
        tone({ type: 'triangle', freq: midiToHz(m), dur, gain: 0.14, at });
        tone({ type: 'sine', freq: midiToHz(m - 12), dur, gain: 0.08, at });
      }
      noise({ at: 0.42, dur: 0.8, gain: 0.05, filter: 'highpass', freq: 6000 });
    },
    lose() {
      // Descending minor phrase, muffled.
      const seq = [[67, 0, 0.25], [63, 0.25, 0.25], [60, 0.5, 0.7]];
      for (const [m, at, dur] of seq) {
        tone({ type: 'sawtooth', freq: midiToHz(m), dur, gain: 0.10, at, lowpass: 900 });
        tone({ type: 'sine', freq: midiToHz(m - 12), dur, gain: 0.12, at });
      }
      tone({ type: 'sine', freq: 70, freqEnd: 35, dur: 0.9, gain: 0.12, at: 0.5 });
    },
    tick() {
      tone({ type: 'sine', freq: 880, dur: 0.07, gain: 0.14, attack: 0.002 });
      tone({ type: 'triangle', freq: 1760, dur: 0.04, gain: 0.04, attack: 0.002 });
    },
    start() {
      tone({ type: 'sine', freq: 1320, dur: 0.28, gain: 0.16, attack: 0.003 });
      tone({ type: 'triangle', freq: 1760, dur: 0.22, gain: 0.06, at: 0.02 });
      tone({ type: 'sine', freq: 660, dur: 0.28, gain: 0.06 });
    },

    // ---- [itens] itens especiais ---------------------------------------------------------
    // Cada um tem uma assinatura sonora distinta, para dar de ouvir o que aconteceu mesmo
    // sem olhar a tela. Tudo sintetizado: nenhum arquivo externo.

    /** ⚡ Raio aparecendo: estalo elétrico curto e agudo. */
    boltSpawn() {
      noise({ dur: 0.08, gain: 0.10, filter: 'highpass', freq: 3000 });
      tone({ type: 'square', freq: 2400, freqEnd: 1200, dur: 0.07, gain: 0.05, lowpass: 4000 });
    },
    /** ⚡ Raio na cobra: trovão rápido e seco. */
    bolt() {
      noise({ dur: 0.28, gain: 0.30, filter: 'highpass', freq: 2200, freqEnd: 400 });
      tone({ type: 'sawtooth', freq: 900, freqEnd: 60, dur: 0.3, gain: 0.22, lowpass: 2600 });
      tone({ type: 'sine', freq: 120, freqEnd: 40, dur: 0.35, gain: 0.25, attack: 0.002 });
    },
    /** 🧊 Gelo aparecendo: tilintar cristalino. */
    iceSpawn() {
      tone({ type: 'sine', freq: midiToHz(96), dur: 0.16, gain: 0.09 });
      tone({ type: 'sine', freq: midiToHz(103), dur: 0.20, gain: 0.06, at: 0.05 });
    },
    /** 🧊 Gelo na cobra: congelamento — brilho agudo que escorrega para grave. */
    ice() {
      tone({ type: 'sine', freq: 2600, freqEnd: 320, dur: 0.55, gain: 0.16, attack: 0.004 });
      noise({ dur: 0.5, gain: 0.10, filter: 'bandpass', freq: 4200, freqEnd: 700, q: 3 });
      tone({ type: 'triangle', freq: 300, freqEnd: 150, dur: 0.4, gain: 0.08, at: 0.1 });
    },
    /** 🕸️ Teia aparecendo: "pluft" abafado. */
    webSpawn() {
      noise({ dur: 0.14, gain: 0.08, filter: 'lowpass', freq: 1200, freqEnd: 500 });
    },
    /** 🕸️ Teia prendendo: elástico esticando e travando. */
    web() {
      tone({ type: 'sawtooth', freq: 220, freqEnd: 90, dur: 0.35, gain: 0.12, lowpass: 800 });
      noise({ dur: 0.3, gain: 0.10, filter: 'bandpass', freq: 700, freqEnd: 250, q: 2 });
      tone({ type: 'sine', freq: 70, dur: 0.25, gain: 0.10, at: 0.12 });
    },
    /** ☠️ Caveira aparecendo: aviso grave e sinistro. */
    skullSpawn() {
      tone({ type: 'sine', freq: 180, freqEnd: 120, dur: 0.3, gain: 0.10, attack: 0.02 });
      tone({ type: 'sawtooth', freq: 90, dur: 0.3, gain: 0.05, lowpass: 500 });
    },
    /** ☠️ Caveira na cobra: pancada pesada com cauda dissonante. */
    skull() {
      noise({ dur: 0.5, gain: 0.34, filter: 'lowpass', freq: 2400, freqEnd: 90 });
      tone({ type: 'sine', freq: 140, freqEnd: 28, dur: 0.7, gain: 0.34, attack: 0.002 });
      tone({ type: 'sawtooth', freq: 200, freqEnd: 50, dur: 0.5, gain: 0.10, lowpass: 700, at: 0.02 });
      // trítono grave = "morte"
      tone({ type: 'triangle', freq: midiToHz(43), dur: 0.8, gain: 0.09, at: 0.1 });
      tone({ type: 'triangle', freq: midiToHz(49), dur: 0.8, gain: 0.09, at: 0.1 });
    },
    /** 💎 Item de bônus aparecendo: sino curto e cristalino. */
    gemSpawn() {
      tone({ type: 'triangle', freq: midiToHz(93), dur: 0.14, gain: 0.10 });
      tone({ type: 'sine', freq: midiToHz(105), dur: 0.18, gain: 0.04, at: 0.03 });
    },
    /** 💎 Diamante coletado: arpejo cristalino ascendente. */
    diamond() {
      [88, 92, 95, 100].forEach((m, i) => {
        tone({ type: 'triangle', freq: midiToHz(m), dur: 0.2, gain: 0.12, at: i * 0.045 });
      });
      noise({ at: 0.1, dur: 0.35, gain: 0.04, filter: 'highpass', freq: 7000 });
    },
    /** ⭐ Estrela aparecendo: brilho que sobe. */
    starSpawn() {
      tone({ type: 'sine', freq: 900, freqEnd: 1800, dur: 0.22, gain: 0.10, attack: 0.01 });
    },
    /** ⭐ Estrela coletada: fanfarra curta e triunfal (invencibilidade). */
    star() {
      const notes = [72, 79, 84, 88, 91];
      notes.forEach((m, i) => {
        tone({ type: 'square', freq: midiToHz(m), dur: 0.3, gain: 0.07, at: i * 0.06, lowpass: 3000 });
        tone({ type: 'triangle', freq: midiToHz(m), dur: 0.3, gain: 0.13, at: i * 0.06 });
      });
      noise({ at: 0.28, dur: 0.7, gain: 0.05, filter: 'highpass', freq: 6000 });
      tone({ type: 'sine', freq: midiToHz(96), dur: 0.8, gain: 0.07, at: 0.34, attack: 0.08 });
    },
    /** 🧲 Ímã: zumbido magnético que sobe. */
    magnet() {
      tone({ type: 'sawtooth', freq: 160, freqEnd: 520, dur: 0.45, gain: 0.10, lowpass: 1400 });
      tone({ type: 'sine', freq: 480, freqEnd: 960, dur: 0.4, gain: 0.07, at: 0.05 });
    },
    /** ⏱️ Relógio/turbo: tique-taque rápido virando arranque. */
    clock() {
      for (let i = 0; i < 3; i++) tone({ type: 'square', freq: 1600, dur: 0.03, gain: 0.07, at: i * 0.07, lowpass: 3000 });
      tone({ type: 'sawtooth', freq: 300, freqEnd: 1400, dur: 0.35, gain: 0.11, at: 0.2, lowpass: 2600 });
    },
    /** 🛡️ Escudo/estrela absorvendo um golpe: "poc" cristalino. */
    shieldPop() {
      tone({ type: 'sine', freq: 1400, freqEnd: 2600, dur: 0.14, gain: 0.12, attack: 0.003 });
      noise({ dur: 0.16, gain: 0.06, filter: 'highpass', freq: 4000 });
    }
  };

  function play(name) {
    if (!isEnabled || disposed) return false;
    const fx = FX[name];
    if (!fx) return false;
    const c = ensureContext();
    if (!c) return false;
    if (c.state !== 'running') {
      // Try (again) to resume; sound will work from the next effect once allowed.
      resume();
      return false;
    }
    const now = performance.now();
    const gap = MIN_GAP_MS[name] ?? 50;
    if (lastPlayed[name] && now - lastPlayed[name] < gap) return false;
    lastPlayed[name] = now;
    try {
      fx();
      return true;
    } catch (err) {
      return false;
    }
  }

  function setEnabled(b) {
    isEnabled = !!b;
    if (isEnabled) { ensureContext(); resume(); }
    else if (ctx && ctx.state === 'running') { ctx.suspend().catch(() => {}); }
  }

  function dispose() {
    disposed = true;
    unbindGesture();
    if (ctx) { ctx.close().catch(() => {}); ctx = null; master = null; noiseBuffer = null; }
  }

  if (isEnabled && AC && autoResume) {
    ensureContext();
    resume().then((ok) => { if (!ok) bindGesture(); });
  }

  return {
    play,
    setEnabled,
    resume,
    dispose,
    get enabled() { return isEnabled; },
    get available() { return !!AC; },
    get running() { return !!ctx && ctx.state === 'running'; }
  };
}
