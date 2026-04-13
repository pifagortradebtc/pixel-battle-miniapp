/**
 * Премиальная игровая аудиосистема: шины громкости, приоритеты SFX, процедурные стинги,
 * динамическая музыка (CALM → TENSION → BATTLE → CRITICAL) с кроссфейдом.
 * Звук работает как в стратегии: эскалация = тактический сигнал, не просто фон.
 * Без внешних файлов — Web Audio API; при желании позже можно подменить стемы на буферы.
 */

const STORAGE_KEY = "pixelBattleAudioSettings";

/** @typedef {{ master: number; music: number; effects: number; muted: boolean }} AudioSettings */

const DEFAULT_SETTINGS = /** @type {const} */ ({
  master: 0.85,
  music: 0.55,
  effects: 0.9,
  muted: false,
});

/** @type {AudioSettings} */
let settings = { ...DEFAULT_SETTINGS };

/** @type {AudioContext | null} */
let ctx = null;

/** @type {GainNode | null} */
let masterGain = null;
/** @type {GainNode | null} */
let musicBus = null;
/** @type {GainNode | null} */
let musicDuck = null;
/** @type {GainNode | null} */
let sfxBus = null;
/** @type {GainNode | null} */
let uiBus = null;
/** @type {GainNode | null} */
let alertBus = null;
/** @type {GainNode | null} */
let ambientBus = null;

/** Четыре слоя музыки (кроссфейд). */
/** @type {GainNode[]} */
let musicLayerGains = [];
/** @type {OscillatorNode[]} */
let musicOscs = [];
/** @type {BiquadFilterNode | null} */
let musicFilter = null;

let musicEngineStarted = false;
/** @type {number | null} */
let battlePulseTimer = null;
let lastBattlePulseWallMs = 0;
/** Следующий тактический пульс (ритм угрозы по слоям). */
let nextStrategicPulseWallMs = 0;

/** Узлы ambient для подстройки «давления» под слой угрозы. */
/** @type {GainNode | null} */
let ambientNoiseGainNode = null;
/** @type {GainNode | null} */
let ambientHumGainNode = null;

let lastThreatEscalationCueWallMs = 0;

let lastAlertWallMs = 0;
let lastExplosionWallMs = 0;
let lastBaseHitWallMs = 0;
let lowPrioritySfxCount = 0;

const MUSIC_STATE = /** @type {const} */ ({
  CALM: 0,
  TENSION: 1,
  BATTLE: 2,
  CRITICAL: 3,
});

let currentMusicState = MUSIC_STATE.CALM;

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const o = JSON.parse(raw);
    if (typeof o.master === "number") settings.master = Math.min(1, Math.max(0, o.master));
    if (typeof o.music === "number") settings.music = Math.min(1, Math.max(0, o.music));
    if (typeof o.effects === "number") settings.effects = Math.min(1, Math.max(0, o.effects));
    if (typeof o.muted === "boolean") settings.muted = o.muted;
  } catch {
    /* ignore */
  }
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}

function applyBusGains() {
  if (!masterGain || !musicBus || !sfxBus || !uiBus || !alertBus || !ambientBus) return;
  const m = settings.muted ? 0 : settings.master;
  masterGain.gain.value = m;
  const mv = m * settings.music;
  musicBus.gain.value = mv;
  const ev = m * settings.effects;
  sfxBus.gain.value = ev;
  uiBus.gain.value = ev * 0.55;
  alertBus.gain.value = ev * 1.12;
  ambientBus.gain.value = ev * 0.35;
}

/**
 * @returns {AudioContext | null}
 */
export function getAudioContext() {
  return ctx;
}

export function resumeAudioContext() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return Promise.resolve();
    if (!ctx) {
      ctx = new Ctx();
      buildGraph();
      loadSettings();
      applyBusGains();
      applyMusicLayerTargets(true);
    }
    if (ctx.state === "suspended") return ctx.resume();
  } catch {
    /* ignore */
  }
  return Promise.resolve();
}

function buildGraph() {
  if (!ctx) return;
  masterGain = ctx.createGain();
  masterGain.connect(ctx.destination);

  musicBus = ctx.createGain();
  musicDuck = ctx.createGain();
  musicDuck.gain.value = 1;
  musicBus.connect(musicDuck);
  musicDuck.connect(masterGain);

  sfxBus = ctx.createGain();
  sfxBus.connect(masterGain);
  uiBus = ctx.createGain();
  uiBus.connect(masterGain);
  alertBus = ctx.createGain();
  alertBus.connect(masterGain);
  ambientBus = ctx.createGain();
  ambientBus.connect(masterGain);

  musicFilter = ctx.createBiquadFilter();
  musicFilter.type = "lowpass";
  musicFilter.frequency.value = 2400;
  musicFilter.Q.value = 0.7;
  musicFilter.connect(musicBus);

  musicLayerGains = [];
  musicOscs = [];
}

function ensureMusicOscs() {
  if (!ctx || !musicFilter || musicLayerGains.length) return;

  const layers = [
    { f0: 55, f1: 82.5, t0: "sine", t1: "sine", det: 4 },
    { f0: 65, f1: 98, t0: "triangle", t1: "sine", det: 6 },
    { f0: 73, f1: 110, t0: "sawtooth", t1: "triangle", det: 8 },
    { f0: 82, f1: 123, t0: "sawtooth", t1: "square", det: 10 },
  ];

  for (let li = 0; li < layers.length; li++) {
    const g = ctx.createGain();
    g.gain.value = 0;
    g.connect(musicFilter);
    musicLayerGains.push(g);
    const spec = layers[li];
    for (let k = 0; k < 2; k++) {
      const osc = ctx.createOscillator();
      osc.type = /** @type {OscillatorType} */ (k === 0 ? spec.t0 : spec.t1);
      const f = k === 0 ? spec.f0 : spec.f1;
      osc.frequency.value = f * (1 + ((k === 0 ? 1 : -1) * spec.det) / 1200);
      const og = ctx.createGain();
      og.gain.value = k === 0 ? 0.055 : 0.04;
      osc.connect(og);
      og.connect(g);
      osc.start();
      musicOscs.push(osc);
    }
  }
}

function startMusicEngine() {
  if (!ctx || musicEngineStarted) return;
  ensureMusicOscs();
  musicEngineStarted = true;
  applyMusicLayerTargets(true);
  scheduleBattlePulseLoop();
  startAmbientHum();
}

function scheduleBattlePulseLoop() {
  if (battlePulseTimer != null) {
    clearInterval(battlePulseTimer);
    battlePulseTimer = null;
  }
  nextStrategicPulseWallMs = 0;
  battlePulseTimer = window.setInterval(() => {
    try {
      if (!ctx || settings.muted || !musicBus) return;
      const st = currentMusicState;
      if (st < MUSIC_STATE.TENSION) return;
      const wall = performance.now();
      if (wall < nextStrategicPulseWallMs) return;
      const volBase = settings.effects * (settings.muted ? 0 : settings.master);
      const t = ctx.currentTime;
      if (st === MUSIC_STATE.TENSION) {
        nextStrategicPulseWallMs = wall + 820;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.038 * volBase, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
        const o = ctx.createOscillator();
        o.type = "triangle";
        o.frequency.setValueAtTime(198, t);
        o.frequency.exponentialRampToValueAtTime(118, t + 0.08);
        o.connect(g);
        g.connect(musicBus);
        o.start(t);
        o.stop(t + 0.1);
        return;
      }
      if (st === MUSIC_STATE.BATTLE) {
        nextStrategicPulseWallMs = wall + 400;
        lastBattlePulseWallMs = wall;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.092 * volBase, t + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
        const o = ctx.createOscillator();
        o.type = "sine";
        o.frequency.setValueAtTime(58, t);
        o.frequency.exponentialRampToValueAtTime(38, t + 0.12);
        o.connect(g);
        g.connect(musicBus);
        o.start(t);
        o.stop(t + 0.16);
        return;
      }
      /* CRITICAL: плотный такт + лёгкий «тревожный» обертон */
      nextStrategicPulseWallMs = wall + 268;
      lastBattlePulseWallMs = wall;
      const g1 = ctx.createGain();
      g1.gain.setValueAtTime(0.0001, t);
      g1.gain.exponentialRampToValueAtTime(0.1 * volBase, t + 0.01);
      g1.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
      const k = ctx.createOscillator();
      k.type = "sine";
      k.frequency.setValueAtTime(52, t);
      k.frequency.exponentialRampToValueAtTime(34, t + 0.1);
      k.connect(g1);
      g1.connect(musicBus);
      k.start(t);
      k.stop(t + 0.13);
      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(0.0001, t + 0.02);
      g2.gain.exponentialRampToValueAtTime(0.042 * volBase, t + 0.025);
      g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
      const h = ctx.createOscillator();
      h.type = "square";
      h.frequency.setValueAtTime(310, t + 0.02);
      h.frequency.exponentialRampToValueAtTime(220, t + 0.09);
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 620;
      h.connect(lp);
      lp.connect(g2);
      g2.connect(musicBus);
      h.start(t + 0.02);
      h.stop(t + 0.12);
    } catch {
      /* ignore */
    }
  }, 72);
}

function startAmbientHum() {
  if (!ctx || !ambientBus || ambientNoiseGainNode) return;
  const t = ctx.currentTime;
  const bufferSize = 2 * ctx.sampleRate;
  const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = "lowpass";
  f.frequency.value = 420;
  const g = ctx.createGain();
  g.gain.value = 0.028;
  ambientNoiseGainNode = g;
  src.connect(f);
  f.connect(g);
  g.connect(ambientBus);
  src.start(t);

  const hum = ctx.createOscillator();
  hum.type = "sine";
  hum.frequency.value = 62;
  const hg = ctx.createGain();
  hg.gain.value = 0.018;
  ambientHumGainNode = hg;
  hum.connect(hg);
  hg.connect(ambientBus);
  hum.start(t);
  syncAmbientToThreat(currentMusicState, true);
}

/**
 * Ambient как «обстановка штаба»: слышнее при напряжении, приглушается в критике, чтобы алерты читались.
 * @param {number} state
 * @param {boolean} [instant]
 */
function syncAmbientToThreat(state, instant = false) {
  if (!ctx || !ambientNoiseGainNode || !ambientHumGainNode) return;
  const now = ctx.currentTime;
  const dur = instant ? 0.04 : 0.55;
  let n = 0.024;
  let h = 0.016;
  if (state === MUSIC_STATE.CALM) {
    n = 0.02;
    h = 0.014;
  } else if (state === MUSIC_STATE.TENSION) {
    n = 0.034;
    h = 0.022;
  } else if (state === MUSIC_STATE.BATTLE) {
    n = 0.03;
    h = 0.019;
  } else {
    n = 0.017;
    h = 0.011;
  }
  ambientNoiseGainNode.gain.cancelScheduledValues(now);
  ambientHumGainNode.gain.cancelScheduledValues(now);
  if (instant) {
    ambientNoiseGainNode.gain.setValueAtTime(n, now);
    ambientHumGainNode.gain.setValueAtTime(h, now);
  } else {
    ambientNoiseGainNode.gain.linearRampToValueAtTime(n, now + dur);
    ambientHumGainNode.gain.linearRampToValueAtTime(h, now + dur);
  }
}

/**
 * Короткий «интел-стинг» при повышении уровня угрозы — игрок слышит, что ситуация стала серьёзнее.
 * @param {number} fromState
 * @param {number} toState
 */
function playThreatEscalationMarker(fromState, toState) {
  if (!ctx || !sfxBus || settings.muted) return;
  const w = performance.now();
  if (w - lastThreatEscalationCueWallMs < 1200) return;
  if (toState <= fromState) return;
  lastThreatEscalationCueWallMs = w;
  const now = ctx.currentTime;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.linearRampToValueAtTime(0.048, now + 0.018);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);
  const o = ctx.createOscillator();
  o.type = "sine";
  const f0 = 360 + fromState * 45;
  const f1 = 500 + toState * 70;
  o.frequency.setValueAtTime(f0, now);
  o.frequency.exponentialRampToValueAtTime(f1, now + 0.1);
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 880;
  bp.Q.value = 1.1;
  o.connect(bp);
  bp.connect(g);
  g.connect(sfxBus);
  o.start(now);
  o.stop(now + 0.17);
}

/**
 * @param {boolean} instant
 * @param {boolean} [escalating] true — быстрый нарост угрозы; false — медленное «выдыхание».
 */
function applyMusicLayerTargets(instant, escalating = false) {
  if (!ctx || musicLayerGains.length < 4) return;
  const now = ctx.currentTime;
  const dur = instant ? 0.05 : escalating ? 1.05 : 2.75;
  const s = currentMusicState;
  const weights = [0.02, 0.02, 0.02, 0.02];
  weights[s] = 1;
  if (s > 0) weights[s - 1] = Math.max(weights[s - 1], 0.22);
  if (s < 3) weights[s + 1] = Math.max(weights[s + 1], 0.14);

  const layerMul = [0.85, 0.95, 1.05, 1.22];
  for (let i = 0; i < 4; i++) {
    const g = musicLayerGains[i];
    const target = weights[i] * layerMul[i] * 0.55;
    g.gain.cancelScheduledValues(now);
    if (instant) g.gain.setValueAtTime(target, now);
    else g.gain.linearRampToValueAtTime(target, now + dur);
  }

  if (musicFilter) {
    const fq = s === MUSIC_STATE.CALM ? 1750 : s === MUSIC_STATE.TENSION ? 2150 : s === MUSIC_STATE.BATTLE ? 2750 : 3350;
    const qVal = s === MUSIC_STATE.CRITICAL ? 2.05 : s === MUSIC_STATE.BATTLE ? 1.15 : 0.78;
    musicFilter.frequency.cancelScheduledValues(now);
    musicFilter.Q.cancelScheduledValues(now);
    if (instant) {
      musicFilter.frequency.setValueAtTime(fq, now);
      musicFilter.Q.setValueAtTime(qVal, now);
    } else {
      musicFilter.frequency.exponentialRampToValueAtTime(Math.max(200, fq), now + dur);
      musicFilter.Q.linearRampToValueAtTime(qVal, now + dur);
    }
  }
}

/**
 * @param {number} state 0..3
 */
export function setMusicState(state) {
  const s = Math.min(3, Math.max(0, state | 0));
  const prev = currentMusicState;
  if (s === prev) return;
  const escalating = s > prev;
  currentMusicState = s;
  startMusicEngine();
  applyMusicLayerTargets(false, escalating);
  syncAmbientToThreat(s, false);
  if (escalating && s >= MUSIC_STATE.TENSION) {
    playThreatEscalationMarker(prev, s);
  }
}

/**
 * @param {number} ms
 * @param {boolean} [deep] сильнее прижать музыку под голос «штаба» / критический алерт
 */
function duckMusicForAlert(ms, deep = false) {
  if (!ctx || !musicDuck) return;
  const now = ctx.currentTime;
  const dur = (ms / 1000) * 0.5;
  const end = now + ms / 1000;
  const floor = deep ? 0.26 : 0.44;
  musicDuck.gain.cancelScheduledValues(now);
  musicDuck.gain.setValueAtTime(musicDuck.gain.value, now);
  musicDuck.gain.linearRampToValueAtTime(floor, now + dur);
  musicDuck.gain.linearRampToValueAtTime(1, end);
}

/** Краткий «шум рации» — тактический канал, не декоративный шум. */
function playTacticalRadioCrackle(bus, audioNow, peak = 0.035) {
  if (!ctx || !bus) return;
  const len = Math.max(64, Math.floor(0.045 * ctx.sampleRate));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    d[i] = (Math.random() * 2 - 1) * (1 - i / len) * (0.55 + 0.45 * Math.sin(i * 0.31));
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = "bandpass";
  f.frequency.value = 1550;
  f.Q.value = 0.85;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, audioNow);
  g.gain.linearRampToValueAtTime(peak, audioNow + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, audioNow + 0.042);
  src.connect(f);
  f.connect(g);
  g.connect(bus);
  src.start(audioNow);
}

/**
 * @param {"sine"|"triangle"|"square"|"sawtooth"} type
 * @param {number} f0
 * @param {number} f1
 * @param {number} peakGain
 * @param {number} durSec
 * @param {GainNode} bus
 * @param {number} now
 */
function playOscThrough(type, f0, f1, peakGain, durSec, bus, now) {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  osc.type = type;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peakGain), now + 0.018);
  g.gain.exponentialRampToValueAtTime(0.0001, now + durSec);
  osc.frequency.setValueAtTime(f0, now);
  if (f1 !== f0) {
    if (type === "triangle" || type === "sine")
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), now + durSec * 0.92);
    else osc.frequency.linearRampToValueAtTime(f1, now + durSec * 0.85);
  }
  osc.connect(g);
  g.connect(bus);
  osc.start(now);
  osc.stop(now + durSec + 0.04);
}

/**
 * Кинематографические стинги (раньше в event-presentation).
 * @param {string} kind
 */
export function playPresentationSting(kind) {
  resumeAudioContext().then(() => {
    if (!ctx || !sfxBus) return;
    startMusicEngine();
    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(0.92, now + 0.02);
    master.gain.exponentialRampToValueAtTime(0.0001, now + 0.85);
    master.connect(sfxBus);

    if (kind === "nuke-bomb") {
      master.gain.cancelScheduledValues(now);
      master.gain.setValueAtTime(0.0001, now);
      master.gain.exponentialRampToValueAtTime(0.34, now + 0.032);
      master.gain.exponentialRampToValueAtTime(0.0001, now + 0.78);
      playOscThrough("triangle", 44, 15, 0.21, 0.64, master, now);
      playOscThrough("sine", 102, 38, 0.11, 0.52, master, now + 0.035);
      playOscThrough("square", 228, 88, 0.052, 0.3, master, now + 0.1);
      return;
    }
    const epic = kind === "base_captured" || kind === "final-ten";
    const tail = epic ? 0.58 : 0.44;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(epic ? 0.28 : 0.22, now + 0.024);
    master.gain.exponentialRampToValueAtTime(0.0001, now + tail);

    if (kind === "base_captured") {
      playOscThrough("triangle", 95, 42, 0.14, 0.52, master, now);
      playOscThrough("sine", 190, 95, 0.07, 0.38, master, now + 0.04);
      playOscThrough("square", 380, 190, 0.04, 0.12, master, now + 0.12);
      return;
    }
    if (kind === "final-ten") {
      playOscThrough("sine", 196, 392, 0.11, 0.42, master, now);
      playOscThrough("sine", 293.66, 440, 0.06, 0.36, master, now + 0.05);
      return;
    }

    if (kind === "gold" || kind === "center") {
      playOscThrough("sine", 880, 1320, 0.12, 0.32, master, now);
    } else if (kind === "seismic" || kind === "seismic-incoming") {
      playOscThrough("triangle", 58, 26, 0.14, 0.4, master, now);
    } else if (kind === "compression" || kind === "final-phase") {
      playOscThrough("sawtooth", 110, 168, 0.1, 0.34, master, now);
    } else if (kind === "economic" || kind === "boom" || kind === "recession") {
      playOscThrough("square", 330, 440, 0.1, 0.28, master, now);
    } else if (kind === "dramatic") {
      playOscThrough("sine", 220, 660, 0.1, 0.36, master, now);
    } else {
      playOscThrough("sine", 523, 784, 0.1, 0.3, master, now);
    }
  });
}

function canPlayLowPrioritySfx() {
  const now = performance.now();
  if (now - lastAlertWallMs < 120) return false;
  if (lowPrioritySfxCount >= 5) return false;
  return true;
}

function registerLowPrioritySfx() {
  lowPrioritySfxCount++;
  window.setTimeout(() => {
    lowPrioritySfxCount = Math.max(0, lowPrioritySfxCount - 1);
  }, 180);
}

export function playUiClick() {
  resumeAudioContext().then(() => {
    if (!ctx || !uiBus || settings.muted || !canPlayLowPrioritySfx()) return;
    registerLowPrioritySfx();
    const now = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.07, now + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.045);
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(1760, now);
    o.frequency.exponentialRampToValueAtTime(990, now + 0.038);
    o.connect(g);
    g.connect(uiBus);
    o.start(now);
    o.stop(now + 0.055);
  });
}

export function playUiHover() {
  resumeAudioContext().then(() => {
    if (!ctx || !uiBus || settings.muted || !canPlayLowPrioritySfx()) return;
    registerLowPrioritySfx();
    const now = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.035, now + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.value = 1320;
    o.connect(g);
    g.connect(uiBus);
    o.start(now);
    o.stop(now + 0.06);
  });
}

let lastUiErrorWallMs = 0;

export function playUiError() {
  resumeAudioContext().then(() => {
    if (!ctx || !uiBus || settings.muted) return;
    const w = performance.now();
    if (w - lastUiErrorWallMs < 220) return;
    lastUiErrorWallMs = w;
    const now = ctx.currentTime;
    playOscThrough("triangle", 220, 92, 0.09, 0.14, uiBus, now);
    playOscThrough("sine", 166, 80, 0.05, 0.12, uiBus, now + 0.02);
  });
}

export function playPurchaseSuccess() {
  resumeAudioContext().then(() => {
    if (!ctx || !sfxBus || settings.muted) return;
    const now = ctx.currentTime;
    playOscThrough("sine", 523.25, 659.25, 0.1, 0.09, sfxBus, now);
    playOscThrough("sine", 659.25, 783.99, 0.08, 0.1, sfxBus, now + 0.07);
    playOscThrough("triangle", 392, 523.25, 0.06, 0.14, sfxBus, now + 0.04);
  });
}

export function playPixelPlace() {
  resumeAudioContext().then(() => {
    if (!ctx || !sfxBus || settings.muted || !canPlayLowPrioritySfx()) return;
    registerLowPrioritySfx();
    const now = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.11, now + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.035);
    const o = ctx.createOscillator();
    o.type = "triangle";
    o.frequency.setValueAtTime(420, now);
    o.frequency.exponentialRampToValueAtTime(280, now + 0.028);
    o.connect(g);
    g.connect(sfxBus);
    o.start(now);
    o.stop(now + 0.045);
  });
}

export function playTerritoryExpand() {
  resumeAudioContext().then(() => {
    if (!ctx || !sfxBus || settings.muted) return;
    const now = ctx.currentTime;
    playOscThrough("sine", 130, 210, 0.08, 0.22, sfxBus, now);
    playOscThrough("triangle", 98, 164, 0.06, 0.28, sfxBus, now + 0.04);
  });
}

export function playFlagBaseHit() {
  resumeAudioContext().then(() => {
    if (!ctx || !sfxBus || settings.muted) return;
    const nowW = performance.now();
    if (nowW - lastBaseHitWallMs < 320) return;
    lastBaseHitWallMs = nowW;
    const now = ctx.currentTime;
    duckMusicForAlert(260, false);
    playOscThrough("triangle", 48, 28, 0.18, 0.35, sfxBus, now);
    playOscThrough("square", 140, 70, 0.08, 0.22, sfxBus, now + 0.02);
  });
}

export function playBombExplosion() {
  resumeAudioContext().then(() => {
    if (!ctx || !sfxBus || settings.muted) return;
    const nowW = performance.now();
    if (nowW - lastExplosionWallMs < 380) return;
    lastExplosionWallMs = nowW;
    duckMusicForAlert(520, true);
    playPresentationSting("nuke-bomb");
  });
}

export function playQuantumConnect() {
  resumeAudioContext().then(() => {
    if (!ctx || !sfxBus || settings.muted) return;
    const now = ctx.currentTime;
    playOscThrough("sine", 220, 880, 0.1, 0.4, sfxBus, now);
    playOscThrough("triangle", 330, 990, 0.06, 0.35, sfxBus, now + 0.05);
  });
}

export function playQuantumDisconnect() {
  resumeAudioContext().then(() => {
    if (!ctx || !sfxBus || settings.muted) return;
    const now = ctx.currentTime;
    playOscThrough("sine", 720, 120, 0.09, 0.38, sfxBus, now);
    playOscThrough("triangle", 360, 90, 0.06, 0.32, sfxBus, now + 0.03);
  });
}

export function playQuantumIncomeTick() {
  resumeAudioContext().then(() => {
    if (!ctx || !sfxBus || settings.muted || !canPlayLowPrioritySfx()) return;
    registerLowPrioritySfx();
    const now = ctx.currentTime;
    playOscThrough("sine", 990, 1320, 0.06, 0.08, sfxBus, now);
  });
}

export function playAlertBaseUnderAttack() {
  resumeAudioContext().then(() => {
    if (!ctx || !alertBus || settings.muted) return;
    lastAlertWallMs = performance.now();
    duckMusicForAlert(720, true);
    const now = ctx.currentTime;
    playTacticalRadioCrackle(alertBus, now, 0.042);
    for (let i = 0; i < 3; i++) {
      const t = now + 0.04 + i * 0.11;
      playOscThrough("square", 520, 520, 0.12, 0.06, alertBus, t);
      playOscThrough("square", 390, 390, 0.1, 0.055, alertBus, t + 0.055);
    }
  });
}

export function playAlertLastCells() {
  resumeAudioContext().then(() => {
    if (!ctx || !alertBus || settings.muted) return;
    lastAlertWallMs = performance.now();
    duckMusicForAlert(560, true);
    const now = ctx.currentTime;
    /* Два удара квинты — «сектор сжимается», читается отдельно от атаки на базу. */
    playOscThrough("triangle", 220, 220, 0.1, 0.08, alertBus, now);
    playOscThrough("triangle", 330, 330, 0.09, 0.08, alertBus, now + 0.09);
    playOscThrough("triangle", 310, 175, 0.12, 0.16, alertBus, now + 0.2);
    playOscThrough("triangle", 265, 165, 0.09, 0.14, alertBus, now + 0.28);
  });
}

export function playAlertLastCell() {
  resumeAudioContext().then(() => {
    if (!ctx || !alertBus || settings.muted) return;
    lastAlertWallMs = performance.now();
    duckMusicForAlert(920, true);
    const now = ctx.currentTime;
    playTacticalRadioCrackle(alertBus, now, 0.038);
    for (let i = 0; i < 4; i++) {
      playOscThrough("square", 720 - i * 55, 240, 0.14, 0.065, alertBus, now + 0.05 + i * 0.075);
    }
  });
}

export function playAlertTerritoryCutOff() {
  resumeAudioContext().then(() => {
    if (!ctx || !alertBus || settings.muted) return;
    lastAlertWallMs = performance.now();
    duckMusicForAlert(520, true);
    const now = ctx.currentTime;
    /* «Разрыв линии снабжения» — нисходящий скан + удар. */
    playOscThrough("sawtooth", 240, 48, 0.11, 0.28, alertBus, now);
    playOscThrough("triangle", 420, 90, 0.08, 0.12, alertBus, now + 0.08);
    playOscThrough("square", 95, 55, 0.1, 0.22, alertBus, now + 0.14);
  });
}

/**
 * Реактивная музыка: вызывать из игрового цикла (~300–1000 мс).
 * @param {{
 *   now: number;
 *   hasTeam: boolean;
 *   spectator: boolean;
 *   lastCellUntil: number;
 *   territoryDangerUntil: number;
 *   territoryCellsRemaining: number;
 *   flagCriticalUntil: number;
 *   flagUnderAttackUntil: number;
 *   mainBaseHpRatio: number;
 *   isolationMyTeam: boolean;
 *   combatBumpUntil: number;
 *   nukeAfterglowUntil: number;
 * }} snap
 */
export function syncReactiveMusic(snap) {
  resumeAudioContext().then(() => {
    if (!ctx || settings.muted) return;
    startMusicEngine();
    const t = snap.now;
    if (!snap.hasTeam || snap.spectator) {
      setMusicState(MUSIC_STATE.CALM);
      return;
    }

    let next = MUSIC_STATE.CALM;

    const lastCell = t < snap.lastCellUntil;
    const hpCrit = snap.mainBaseHpRatio < 0.15 && snap.mainBaseHpRatio >= 0;
    const basePanic = t < snap.flagCriticalUntil || lastCell || hpCrit;
    const underAttack = t < snap.flagUnderAttackUntil;

    if (basePanic || (underAttack && snap.mainBaseHpRatio < 0.35)) {
      next = MUSIC_STATE.CRITICAL;
    } else if (t < snap.territoryDangerUntil && snap.territoryCellsRemaining <= 8) {
      /* Раньше поднимаем BATTLE: игрок слышит, что территория критична, ещё до алерта «6 клеток». */
      next = MUSIC_STATE.BATTLE;
    } else if (t < snap.combatBumpUntil || t < snap.nukeAfterglowUntil) {
      next = MUSIC_STATE.BATTLE;
    } else if (
      underAttack ||
      snap.isolationMyTeam ||
      (t < snap.territoryDangerUntil && snap.territoryCellsRemaining <= 22)
    ) {
      next = MUSIC_STATE.TENSION;
    } else {
      next = MUSIC_STATE.CALM;
    }

    setMusicState(next);
  });
}

/** До какого времени (Date.now()) держать повышенный боевой слой музыки. */
let combatBumpUntilDate = 0;

/**
 * Короткий всплеск «интенсивности» боя (свой пиксель, удар по базе и т.д.).
 * @param {number} ms
 */
export function bumpCombat(ms = 2800) {
  combatBumpUntilDate = Math.max(combatBumpUntilDate, Date.now() + ms);
}

export function getCombatBumpUntil() {
  return combatBumpUntilDate;
}

/**
 * @param {Partial<AudioSettings>} patch
 */
export function applyAudioSettings(patch) {
  if (typeof patch.master === "number") settings.master = Math.min(1, Math.max(0, patch.master));
  if (typeof patch.music === "number") settings.music = Math.min(1, Math.max(0, patch.music));
  if (typeof patch.effects === "number") settings.effects = Math.min(1, Math.max(0, patch.effects));
  if (typeof patch.muted === "boolean") settings.muted = patch.muted;
  saveSettings();
  applyBusGains();
}

export function getAudioSettings() {
  return { ...settings };
}

/**
 * Инициализация: настройки из storage, UI, жест для AudioContext.
 */
export function initGameAudio() {
  loadSettings();

  const panel = document.getElementById("game-audio-panel");
  const btn = document.getElementById("btn-game-audio");
  const masterEl = document.getElementById("game-audio-master");
  const musicEl = document.getElementById("game-audio-music");
  const sfxEl = document.getElementById("game-audio-sfx");
  const muteEl = document.getElementById("game-audio-mute");

  const syncUi = () => {
    if (masterEl) {
      masterEl.value = String(Math.round(settings.master * 100));
    }
    if (musicEl) musicEl.value = String(Math.round(settings.music * 100));
    if (sfxEl) sfxEl.value = String(Math.round(settings.effects * 100));
    if (muteEl) muteEl.checked = settings.muted;
  };
  syncUi();

  const togglePanel = () => {
    if (!panel) return;
    const open = !panel.hidden;
    panel.hidden = open;
    if (btn) btn.setAttribute("aria-expanded", open ? "false" : "true");
  };

  if (btn && panel) {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      void resumeAudioContext();
      togglePanel();
    });
  }

  document.addEventListener("click", (e) => {
    if (!panel || panel.hidden) return;
    const t = /** @type {Node} */ (e.target);
    if (panel.contains(t) || btn?.contains(t)) return;
    panel.hidden = true;
    if (btn) btn.setAttribute("aria-expanded", "false");
  });

  const bindRange = (el, key) => {
    if (!el) return;
    el.addEventListener("input", () => {
      const v = Number(el.value);
      if (!Number.isFinite(v)) return;
      applyAudioSettings({ [key]: v / 100 });
    });
  };
  bindRange(masterEl, "master");
  bindRange(musicEl, "music");
  bindRange(sfxEl, "effects");

  if (muteEl) {
    muteEl.addEventListener("change", () => {
      applyAudioSettings({ muted: muteEl.checked });
    });
  }

  const resumeOnGesture = () => {
    void resumeAudioContext();
  };
  document.body.addEventListener("pointerdown", resumeOnGesture, { passive: true });
  document.body.addEventListener("keydown", resumeOnGesture, { passive: true });

  const app = document.getElementById("app");
  if (app) {
    app.addEventListener(
      "pointerdown",
      (e) => {
        const el = /** @type {HTMLElement} */ (e.target);
        if (el.closest?.(".toolbar__btn, .shop-btn, .welcome-team-btn, .quick-buy-rail__btn")) {
          playUiClick();
        }
      },
      true
    );
  }

  applyBusGains();
}
