/**
 * Аудио как у серьёзной военно-стратегической симуляции: суббас, сдержанные удары, тишина между событиями.
 * Без «игровых» писков, мелодичных стингов и яркого верха. Музыка CALM → TENSION → BATTLE → CRITICAL
 * с плавным кроссфейдом. Web Audio API (процедурно).
 * Опционально: стриминговые треки из music/manifest.json (см. streaming-bgm.js).
 */

import { streamingBgm } from "./streaming-bgm.js";
import { resolvePublicAssetUrl } from "./asset-url.js";
import {
  registerSpatialAudioListener,
  registerSpatialAmbientAnchor,
  resolveSpatialMul,
  resolvePresentationSpatial,
  SPATIAL_MIN_AUDIBLE,
} from "./audio-spatial.js";

export { registerSpatialAudioListener, registerSpatialAmbientAnchor };

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

/** Синхронизация иконки кнопки в шапке после applyAudioSettings (назначается в initGameAudio). */
/** @type {(() => void) | undefined} */
let refreshGameAudioToolbarUi;

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
/** Длинные кинематографические стинги — не засыпать UI мелочью сразу после. */
let lastEpicStingWallMs = 0;
let lowPrioritySfxCount = 0;

/**
 * Непрерывный процедурный фон: слои-синусы на musicBus + ambient (шум + гудение 48 Hz).
 * Выкл. — без стриминговых треков музыкальная шина тихая; остаются только явные SFX/стинги.
 */
const ENABLE_PROCEDURAL_MUSIC_DRONE = false;

/** Сэмплы событий из sfx/samples.json (при отсутствии файла — процедурный fallback). */
/** @type {Map<string, AudioBuffer>} */
const eventSfxBuffers = new Map();
/** @type {Promise<void> | null} */
let eventSfxPreloadPromise = null;

const MUSIC_STATE = /** @type {const} */ ({
  CALM: 0,
  TENSION: 1,
  BATTLE: 2,
  CRITICAL: 3,
});

let currentMusicState = MUSIC_STATE.CALM;

/** Процедурные слои приглушены из‑за активного streaming-bgm; при снятии — восстановить. */
let streamingHadProceduralSilenced = false;

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const o = JSON.parse(raw);
    if (typeof o.master === "number") settings.master = Math.min(1, Math.max(0, o.master));
    if (typeof o.music === "number") settings.music = Math.min(1, Math.max(0, o.music));
    if (typeof o.effects === "number") settings.effects = Math.min(1, Math.max(0, o.effects));
    if (typeof o.muted === "boolean") settings.muted = o.muted;
    /* Сломанное состояние из UI: не mute, но все ползунки на0 — полная тишина. */
    if (!settings.muted && settings.master === 0 && settings.music === 0 && settings.effects === 0) {
      settings = { ...DEFAULT_SETTINGS };
      saveSettings();
    }
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
  const mv = m * settings.music;
  const ev = m * settings.effects;
  if (ctx) {
    const t = ctx.currentTime;
    masterGain.gain.cancelScheduledValues(t);
    masterGain.gain.setValueAtTime(m, t);
    musicBus.gain.cancelScheduledValues(t);
    musicBus.gain.setValueAtTime(mv, t);
    streamingBgm.setOutputLevel(settings.muted, settings.muted ? 0 : settings.master * settings.music);
    sfxBus.gain.cancelScheduledValues(t);
    sfxBus.gain.setValueAtTime(ev * 0.9, t);
    uiBus.gain.cancelScheduledValues(t);
    /* Баланс: UI тихо, геймплей средне, алерты выше, музыка и ambient сдержанно */
    uiBus.gain.setValueAtTime(ev * 0.34, t);
    alertBus.gain.cancelScheduledValues(t);
    alertBus.gain.setValueAtTime(ev * 1.06, t);
    ambientBus.gain.cancelScheduledValues(t);
    ambientBus.gain.setValueAtTime(ev * 0.28, t);
  } else {
    masterGain.gain.value = m;
    musicBus.gain.value = mv;
    sfxBus.gain.value = ev * 0.9;
    uiBus.gain.value = ev * 0.34;
    alertBus.gain.value = ev * 1.06;
    ambientBus.gain.value = ev * 0.28;
  }
  /* Тишина при mute только через gain (master → 0). Не вызываем ctx.suspend():
 * после снятия mute в Telegram/WebView resume() часто не срабатывает без жеста — «все звуки пропали». */
}

/**
 * @returns {AudioContext | null}
 */
export function getAudioContext() {
  return ctx;
}

/**
 * Фоновый прелоад sfx + музыки. Нельзя ждать его в цепочке resumeAudioContext():
 * loadManifestAndBuffers последовательно тянет все треки — на слабом канале это
 * минуты, и все play* в .then(() => …) так и не срабатывают (полная тишина).
 */
function kickPostResumePreload() {
  void Promise.all([preloadEventSfxBuffers(), streamingBgm.loadManifestAndBuffers()])
    .catch(() => {})
    .then(() => {
      applyBusGains();
    });
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
      /* Сразу в том же стеке вызова (жест пользователя) — иначе iOS/Telegram часто оставляют тишину. */
      try {
        if (ctx.state !== "running") void ctx.resume();
      } catch {
        /* ignore */
      }
    }
    if (ctx.state !== "running") {
      const p = ctx.resume();
      if (p && typeof p.then === "function") {
        return p.then(
          () => {
            kickPostResumePreload();
          },
          () => {
            kickPostResumePreload();
          }
        );
      }
    }
    kickPostResumePreload();
    return Promise.resolve();
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
  musicFilter.frequency.value = 880;
  musicFilter.Q.value = 0.65;
  musicFilter.connect(musicBus);

    musicLayerGains = [];
    musicOscs = [];

    streamingBgm.attach(ctx, musicDuck);
    /* sfx/music — фоновый прелоад после resume, см. kickPostResumePreload */
}

function ensureMusicOscs() {
  if (!ctx || !musicFilter || musicLayerGains.length) return;

  /* Только sine/triangle, низкие «дроны» — без saw/square (не аркада). */
  const layers = [
    { f0: 32, f1: 48, t0: "sine", t1: "sine", det: 2 },
    { f0: 40, f1: 60, t0: "sine", t1: "triangle", det: 3 },
    { f0: 48, f1: 72, t0: "triangle", t1: "sine", det: 4 },
    { f0: 55, f1: 82, t0: "sine", t1: "sine", det: 5 },
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
      og.gain.value = k === 0 ? 0.026 : 0.018;
      osc.connect(og);
      og.connect(g);
      osc.start();
      musicOscs.push(osc);
    }
  }
}

function startMusicEngine() {
  if (!ctx || musicEngineStarted) return;
  musicEngineStarted = true;
  if (ENABLE_PROCEDURAL_MUSIC_DRONE) {
    ensureMusicOscs();
    applyMusicLayerTargets(true);
    scheduleBattlePulseLoop();
    startAmbientHum();
  } else {
    silenceMusicLayers(true);
  }
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
      if (streamingBgm.shouldSuppressProcedural()) return;
      const st = currentMusicState;
      if (st < MUSIC_STATE.TENSION) return;
      const wall = performance.now();
      if (wall < nextStrategicPulseWallMs) return;
      const volBase = settings.effects * (settings.muted ? 0 : settings.master);
      const t = ctx.currentTime;
      if (st === MUSIC_STATE.TENSION) {
        /* Build-up: редкий низкий такт, почти тишина между ударами */
        nextStrategicPulseWallMs = wall + 1180;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.022 * volBase, t + 0.014);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
        const o = ctx.createOscillator();
        o.type = "sine";
        o.frequency.setValueAtTime(62, t);
        o.frequency.exponentialRampToValueAtTime(38, t + 0.16);
        o.connect(g);
        g.connect(musicBus);
        o.start(t);
        o.stop(t + 0.22);
        return;
      }
      if (st === MUSIC_STATE.BATTLE) {
        nextStrategicPulseWallMs = wall + 520;
        lastBattlePulseWallMs = wall;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.048 * volBase, t + 0.016);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
        const o = ctx.createOscillator();
        o.type = "sine";
        o.frequency.setValueAtTime(52, t);
        o.frequency.exponentialRampToValueAtTime(36, t + 0.18);
        o.connect(g);
        g.connect(musicBus);
        o.start(t);
        o.stop(t + 0.24);
        return;
      }
      /* CRITICAL: плотный суб + короткий шёлк (LP), без square */
      nextStrategicPulseWallMs = wall + 340;
      lastBattlePulseWallMs = wall;
      const g1 = ctx.createGain();
      g1.gain.setValueAtTime(0.0001, t);
      g1.gain.exponentialRampToValueAtTime(0.065 * volBase, t + 0.012);
      g1.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      const k = ctx.createOscillator();
      k.type = "sine";
      k.frequency.setValueAtTime(48, t);
      k.frequency.exponentialRampToValueAtTime(28, t + 0.14);
      k.connect(g1);
      g1.connect(musicBus);
      k.start(t);
      k.stop(t + 0.18);
      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(0.0001, t + 0.03);
      g2.gain.exponentialRampToValueAtTime(0.024 * volBase, t + 0.04);
      g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
      const h = ctx.createOscillator();
      h.type = "triangle";
      h.frequency.setValueAtTime(88, t + 0.03);
      h.frequency.exponentialRampToValueAtTime(58, t + 0.1);
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 260;
      h.connect(lp);
      lp.connect(g2);
      g2.connect(musicBus);
      h.start(t + 0.03);
      h.stop(t + 0.14);
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
  f.frequency.value = 220;
  const g = ctx.createGain();
  g.gain.value = 0.02;
  ambientNoiseGainNode = g;
  src.connect(f);
  f.connect(g);
  g.connect(ambientBus);
  src.start(t);

  const hum = ctx.createOscillator();
  hum.type = "sine";
  hum.frequency.value = 48;
  const hg = ctx.createGain();
  hg.gain.value = 0.012;
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
  let n = 0.016;
  let h = 0.01;
  if (state === MUSIC_STATE.CALM) {
    n = 0.014;
    h = 0.009;
  } else if (state === MUSIC_STATE.TENSION) {
    n = 0.022;
    h = 0.014;
  } else if (state === MUSIC_STATE.BATTLE) {
    n = 0.024;
    h = 0.015;
  } else {
    n = 0.012;
    h = 0.008;
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
  if (w - lastThreatEscalationCueWallMs < 1400) return;
  if (toState <= fromState) return;
  lastThreatEscalationCueWallMs = w;
  const now = ctx.currentTime;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(0.042, now + 0.05);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);
  const o = ctx.createOscillator();
  o.type = "sine";
  const f0 = 72 + fromState * 10;
  const f1 = 34 + toState * 5;
  o.frequency.setValueAtTime(f0, now);
  o.frequency.exponentialRampToValueAtTime(Math.max(28, f1), now + 0.32);
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 320;
  lp.Q.value = 0.6;
  o.connect(lp);
  lp.connect(g);
  g.connect(sfxBus);
  o.start(now);
  o.stop(now + 0.45);
}

/**
 * @param {boolean} instant
 * @param {boolean} [escalating] true — быстрый нарост угрозы; false — медленное «выдыхание».
 */
function silenceMusicLayers(instant) {
  if (!ctx || musicLayerGains.length < 4) return;
  const now = ctx.currentTime;
  const dur = instant ? 0.05 : 0.55;
  for (let i = 0; i < musicLayerGains.length; i++) {
    const g = musicLayerGains[i];
    g.gain.cancelScheduledValues(now);
    if (instant) g.gain.setValueAtTime(0.0001, now);
    else g.gain.linearRampToValueAtTime(0.0001, now + dur);
  }
}

function applyMusicLayerTargets(instant, escalating = false) {
  if (!ctx || musicLayerGains.length < 4) return;
  const now = ctx.currentTime;
  const dur = instant ? 0.07 : escalating ? 1.45 : 3.15;
  const s = currentMusicState;
  const weights = [0.02, 0.02, 0.02, 0.02];
  weights[s] = 1;
  if (s > 0) weights[s - 1] = Math.max(weights[s - 1], 0.26);
  if (s < 3) weights[s + 1] = Math.max(weights[s + 1], 0.16);

  const layerMul = [0.82, 0.92, 1.02, 1.14];
  for (let i = 0; i < 4; i++) {
    const g = musicLayerGains[i];
    const target = weights[i] * layerMul[i] * 0.36;
    g.gain.cancelScheduledValues(now);
    if (instant) g.gain.setValueAtTime(target, now);
    else g.gain.linearRampToValueAtTime(target, now + dur);
  }

  if (musicFilter) {
    const fq =
      s === MUSIC_STATE.CALM ? 560 : s === MUSIC_STATE.TENSION ? 720 : s === MUSIC_STATE.BATTLE ? 980 : 1320;
    const qVal = s === MUSIC_STATE.CRITICAL ? 1.35 : s === MUSIC_STATE.BATTLE ? 0.95 : 0.62;
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

function syncProceduralStreamingOverlay() {
  const sup = streamingBgm.shouldSuppressProcedural();
  if (sup) {
    silenceMusicLayers(true);
    streamingHadProceduralSilenced = true;
  } else if (streamingHadProceduralSilenced) {
    streamingHadProceduralSilenced = false;
    applyMusicLayerTargets(true, false);
  }
}

/** Процедурная музыка: лёгкое «открытие» по импульсу боя, пока не играет стрим. */
function applyProceduralBattleBrightness(snap) {
  if (!ctx || !musicFilter || streamingBgm.shouldSuppressProcedural()) return;
  if (!snap.hasTeam || snap.spectator) return;
  const { battlePulse01, sustainDread01 } = computeBattleReactive01(snap);
  const s = currentMusicState;
  const baseFq =
    s === MUSIC_STATE.CALM ? 560 : s === MUSIC_STATE.TENSION ? 720 : s === MUSIC_STATE.BATTLE ? 980 : 1320;
  const target = Math.min(2280, baseFq * (1 + battlePulse01 * 0.95 + sustainDread01 * 0.5));
  const now = ctx.currentTime;
  musicFilter.frequency.cancelScheduledValues(now);
  musicFilter.frequency.setValueAtTime(musicFilter.frequency.value, now);
  musicFilter.frequency.exponentialRampToValueAtTime(Math.max(240, target), now + 0.12);
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
  const floor = deep ? 0.18 : 0.32;
  musicDuck.gain.cancelScheduledValues(now);
  musicDuck.gain.setValueAtTime(musicDuck.gain.value, now);
  musicDuck.gain.linearRampToValueAtTime(floor, now + dur);
  musicDuck.gain.linearRampToValueAtTime(1, end);
}

async function preloadEventSfxBuffers() {
  if (!ctx) return Promise.resolve();
  if (eventSfxPreloadPromise) return eventSfxPreloadPromise;
  eventSfxPreloadPromise = (async () => {
    try {
      const res = await fetch(resolvePublicAssetUrl("sfx/samples.json"), { cache: "no-store" });
      if (!res.ok) return;
      const j = await res.json();
      const files = j.files && typeof j.files === "object" ? j.files : {};
      for (const [key, rel] of Object.entries(files)) {
        if (eventSfxBuffers.has(key)) continue;
        try {
          const r = await fetch(resolvePublicAssetUrl(String(rel)));
          if (!r.ok) continue;
          const ab = await r.arrayBuffer();
          const buf = await ctx.decodeAudioData(ab.slice(0));
          eventSfxBuffers.set(key, buf);
        } catch {
          /* файл отсутствует или битый */
        }
      }
    } catch {
      /* нет манифеста / сеть */
    }
  })().finally(() => {
    eventSfxPreloadPromise = null;
  });
  return eventSfxPreloadPromise;
}

/**
 * @param {string} key ключ из samples.json
 * @param {{ bus?: "sfx" | "alert" | "ui"; duckMs?: number; deepDuck?: boolean; gainMul?: number; spatial?: import("./audio-spatial.js").SpatialSpec }} [opt]
 * @returns {boolean}
 */
function playEventSample(key, opt = {}) {
  if (!ctx || settings.muted) return false;
  const buf = eventSfxBuffers.get(key);
  if (!buf) return false;
  const sm = resolveSpatialMul(opt.spatial);
  if (sm < SPATIAL_MIN_AUDIBLE) return false;
  const busName = opt.bus || "sfx";
  const bus = busName === "alert" ? alertBus : busName === "ui" ? uiBus : sfxBus;
  if (!bus) return false;
  const dm = opt.duckMs ?? 0;
  if (dm > 0) duckMusicForAlert(dm, !!opt.deepDuck);
  const now = ctx.currentTime;
  const ev = settings.master * settings.effects;
  const mul = opt.gainMul ?? 1;
  let peak = ev * mul * sm;
  if (busName === "sfx") peak *= 0.9;
  else if (busName === "ui") peak *= 0.4;
  else peak *= 1.05;
  peak = Math.min(0.96, peak);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.linearRampToValueAtTime(peak, now + 0.028);
  src.connect(g);
  g.connect(bus);
  src.start(now);
  return true;
}

/**
 * @param {string} kind аргумент playPresentationSting / spec.sound
 * @returns {string | null}
 */
function presentationStingKindToSampleKey(kind) {
  const k = String(kind || "");
  /** @type {Record<string, string>} */
  const m = {
    "nuke-bomb": "bomb",
    base_captured: "base_capture",
    "seismic-incoming": "seismic_warning",
    seismic: "seismic_hit",
    gold: "treasure",
    center: "treasure",
    territory_4: "territory_4",
    territory_6: "territory_6",
    territory_12: "territory_12",
    military_base: "military_base",
  };
  return m[k] || null;
}

/** Краткий «шум рации» — низкий тактический канал (штаб), без «песка» в верхах. */
function playTacticalRadioCrackle(bus, audioNow, peak = 0.016) {
  if (!ctx || !bus) return;
  const len = Math.max(64, Math.floor(0.038 * ctx.sampleRate));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    d[i] = (Math.random() * 2 - 1) * (1 - i / len) * (0.55 + 0.45 * Math.sin(i * 0.18));
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = "bandpass";
  f.frequency.value = 380;
  f.Q.value = 0.48;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, audioNow);
  g.gain.linearRampToValueAtTime(peak, audioNow + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, audioNow + 0.036);
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
 * @param {number | null} [lowpassHz] срез верха (triangle/saw), «штаб» без блеска
 */
function playOscThrough(type, f0, f1, peakGain, durSec, bus, now, lowpassHz = null) {
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
  if (typeof lowpassHz === "number" && lowpassHz > 0) {
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = lowpassHz;
    lp.Q.value = 0.62;
    osc.connect(lp);
    lp.connect(g);
  } else {
    osc.connect(g);
  }
  g.connect(bus);
  osc.start(now);
  osc.stop(now + durSec + 0.04);
}

/**
 * Низкий «телесный» удар (взрыв, захват, удар по базе).
 * @param {GainNode} bus
 * @param {number} now
 * @param {number} durSec
 * @param {number} fStart
 * @param {number} fEnd
 * @param {number} peak
 */
function playSubThump(bus, now, durSec, fStart, fEnd, peak) {
  if (!ctx) return;
  const o = ctx.createOscillator();
  o.type = "sine";
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 380;
  lp.Q.value = 0.55;
  const g = ctx.createGain();
  o.frequency.setValueAtTime(fStart, now);
  o.frequency.exponentialRampToValueAtTime(Math.max(18, fEnd), now + durSec * 0.9);
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), now + 0.045);
  g.gain.exponentialRampToValueAtTime(0.0001, now + durSec);
  o.connect(lp);
  lp.connect(g);
  g.connect(bus);
  o.start(now);
  o.stop(now + durSec + 0.06);
}

/**
 * Короткий отфильтрованный шум (шокволна, обломки, «металл»).
 * @param {GainNode} bus
 * @param {number} now
 * @param {number} durSec
 * @param {number} peak
 * @param {number} lowpassHz
 */
function playFilteredNoiseBurst(bus, now, durSec, peak, lowpassHz) {
  if (!ctx) return;
  const len = Math.max(48, Math.floor(ctx.sampleRate * durSec));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let leak = 0;
  for (let i = 0; i < len; i++) {
    leak = leak * 0.93 + (Math.random() * 2 - 1) * 0.16;
    d[i] = Math.max(-1, Math.min(1, leak));
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = lowpassHz;
  lp.Q.value = 0.62;
  const g = ctx.createGain();
  const att = Math.min(0.055, durSec * 0.22);
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), now + att);
  g.gain.exponentialRampToValueAtTime(0.0001, now + durSec);
  src.connect(lp);
  lp.connect(g);
  g.connect(bus);
  src.start(now);
  src.stop(now + durSec + 0.04);
}

/**
 * Кинематографические стинги (event-presentation): только низы / сдержанные слои, без square/saw «аркады».
 * @param {string} kind
 * @param {import("./audio-spatial.js").SpatialSpec | null | undefined} [spatialSpec]
 */
export function playPresentationSting(kind, spatialSpec) {
  resumeAudioContext().then(() => {
    if (!ctx || !sfxBus || settings.muted) return;
    startMusicEngine();
    const k = String(kind || "default");
    const spatialResolved = resolvePresentationSpatial(k, spatialSpec);
    const sm = resolveSpatialMul(spatialResolved);
    if (sm < SPATIAL_MIN_AUDIBLE) return;

    const sampleKey = presentationStingKindToSampleKey(k);
    if (sampleKey) {
      const epic = k === "nuke-bomb" || k === "base_captured" || k === "final-ten";
      let duckMs = 0;
      let deepDuck = false;
      if (k === "nuke-bomb") {
        duckMs = 880;
        deepDuck = true;
      } else if (k === "base_captured") {
        duckMs = 720;
        deepDuck = true;
      } else if (k === "seismic-incoming") {
        duckMs = 560;
        deepDuck = true;
      } else if (k === "seismic") {
        duckMs = 640;
        deepDuck = true;
      }
      if (playEventSample(sampleKey, { bus: "sfx", duckMs, deepDuck, gainMul: 1, spatial: spatialResolved })) {
        if (epic) lastEpicStingWallMs = performance.now();
        return;
      }
    }

    const epic = k === "nuke-bomb" || k === "base_captured" || k === "final-ten";
    if (epic) lastEpicStingWallMs = performance.now();

    const now = ctx.currentTime;
    const master = ctx.createGain();
    const spatialOut = ctx.createGain();
    spatialOut.gain.value = sm;
    master.connect(spatialOut);
    spatialOut.connect(sfxBus);

    if (k === "nuke-bomb") {
      master.gain.setValueAtTime(0.0001, now);
      master.gain.exponentialRampToValueAtTime(1, now + 0.018);
      master.gain.exponentialRampToValueAtTime(0.0001, now + 1.05);
      playSubThump(master, now, 0.58, 36, 17, 0.48);
      playFilteredNoiseBurst(master, now + 0.015, 0.48, 0.2, 420);
      playFilteredNoiseBurst(master, now + 0.09, 0.2, 0.042, 950);
      playOscThrough("sine", 78, 32, 0.07, 0.45, master, now + 0.04);
      return;
    }

    if (k === "base_captured") {
      master.gain.setValueAtTime(0.0001, now);
      master.gain.exponentialRampToValueAtTime(0.92, now + 0.022);
      master.gain.exponentialRampToValueAtTime(0.0001, now + 0.72);
      playSubThump(master, now, 0.42, 48, 22, 0.38);
      playOscThrough("triangle", 78, 42, 0.065, 0.35, master, now + 0.05, 340);
      playOscThrough("sine", 108, 52, 0.04, 0.32, master, now + 0.08);
      playFilteredNoiseBurst(master, now + 0.12, 0.16, 0.045, 900);
      return;
    }

    if (k === "final-ten") {
      master.gain.setValueAtTime(0.0001, now);
      master.gain.exponentialRampToValueAtTime(0.88, now + 0.028);
      master.gain.exponentialRampToValueAtTime(0.0001, now + 0.62);
      playSubThump(master, now, 0.32, 55, 38, 0.22);
      playOscThrough("sine", 118, 92, 0.048, 0.38, master, now + 0.06);
      playOscThrough("sine", 102, 62, 0.035, 0.42, master, now + 0.14);
      return;
    }

    const tail = 0.38;
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(0.78, now + 0.02);
    master.gain.exponentialRampToValueAtTime(0.0001, now + tail);

    if (k === "seismic-incoming") {
      playFilteredNoiseBurst(master, now, 0.28, 0.08, 320);
      playOscThrough("sine", 52, 28, 0.1, 0.42, master, now + 0.04);
      playOscThrough("triangle", 62, 36, 0.038, 0.28, master, now + 0.1, 320);
      return;
    }
    if (k === "seismic") {
      playSubThump(master, now, 0.36, 42, 20, 0.32);
      playFilteredNoiseBurst(master, now + 0.02, 0.25, 0.09, 480);
      return;
    }
    if (k === "gold" || k === "center") {
      playOscThrough("sine", 118, 92, 0.042, 0.28, master, now);
      playOscThrough("triangle", 88, 68, 0.028, 0.3, master, now + 0.05, 380);
      return;
    }
    if (k === "compression" || k === "final-phase") {
      playOscThrough("sine", 88, 52, 0.07, 0.34, master, now);
      playFilteredNoiseBurst(master, now + 0.06, 0.18, 0.04, 550);
      return;
    }
    if (k === "economic" || k === "economic-dual") {
      playOscThrough("sine", 72, 98, 0.06, 0.26, master, now);
      playOscThrough("sine", 98, 62, 0.045, 0.24, master, now + 0.08);
      return;
    }
    if (k === "boom") {
      playSubThump(master, now, 0.22, 62, 40, 0.2);
      playOscThrough("sine", 120, 92, 0.05, 0.2, master, now + 0.04);
      return;
    }
    if (k === "recession") {
      playOscThrough("sine", 98, 55, 0.065, 0.32, master, now);
      playFilteredNoiseBurst(master, now + 0.08, 0.14, 0.03, 400);
      return;
    }
    if (k === "dramatic") {
      playSubThump(master, now, 0.22, 58, 38, 0.14);
      playOscThrough("sine", 92, 58, 0.055, 0.34, master, now + 0.04);
      return;
    }
    /* default, synergy — сухой низкий маркер, без «мелодии» */
    playOscThrough("sine", 108, 82, 0.038, 0.2, master, now);
  });
}

function canPlayLowPrioritySfx() {
  const now = performance.now();
  if (now - lastAlertWallMs < 280) return false;
  if (now - lastExplosionWallMs < 820) return false;
  if (now - lastBaseHitWallMs < 480) return false;
  if (now - lastEpicStingWallMs < 650) return false;
  if (lowPrioritySfxCount >= 4) return false;
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
    playFilteredNoiseBurst(uiBus, now, 0.018, 0.022, 520);
    playOscThrough("sine", 198, 165, 0.018, 0.032, uiBus, now + 0.002);
  });
}

/** Выбор в стартовом меню: создать / вступить / команда из списка (без лимита low-priority кликов). */
export function playMenuChoiceSfx() {
  resumeAudioContext().then(() => {
    if (!ctx || !uiBus || settings.muted) return;
    if (playEventSample("menu_select", { bus: "ui", gainMul: 0.92 })) return;
    const now = ctx.currentTime;
    playFilteredNoiseBurst(uiBus, now, 0.02, 0.028, 560);
    playOscThrough("sine", 220, 175, 0.022, 0.04, uiBus, now + 0.002);
  });
}

/** Открытие меню: магазин, панель громкости, настройки команды. */
export function playMenuOpenSfx() {
  resumeAudioContext().then(() => {
    if (!ctx || !uiBus || settings.muted) return;
    if (playEventSample("menu_open", { bus: "ui", gainMul: 0.88 })) return;
    const now = ctx.currentTime;
    playFilteredNoiseBurst(uiBus, now, 0.024, 0.032, 480);
    playOscThrough("sine", 165, 205, 0.026, 0.055, uiBus, now + 0.004);
  });
}

export function playUiHover() {
  resumeAudioContext().then(() => {
    if (!ctx || !uiBus || settings.muted || !canPlayLowPrioritySfx()) return;
    registerLowPrioritySfx();
    const now = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.009, now + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.042);
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.value = 155;
    o.connect(g);
    g.connect(uiBus);
    o.start(now);
    o.stop(now + 0.048);
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
    playSubThump(uiBus, now, 0.14, 108, 58, 0.07);
    playOscThrough("sine", 92, 48, 0.04, 0.12, uiBus, now + 0.015);
  });
}

export function playPurchaseSuccess() {
  resumeAudioContext().then(() => {
    if (!ctx || !sfxBus || settings.muted) return;
    const now = ctx.currentTime;
    playOscThrough("sine", 98, 118, 0.038, 0.14, sfxBus, now);
    playOscThrough("sine", 118, 88, 0.028, 0.12, sfxBus, now + 0.07);
  });
}

/** @param {import("./audio-spatial.js").SpatialSpec | null} [spatial] */
export function playBuffPersonalSfx(spatial) {
  resumeAudioContext().then(() => {
    if (!ctx || !sfxBus || settings.muted) return;
    if (playEventSample("buff_personal", { bus: "sfx", gainMul: 0.95, spatial })) return;
    const sm = resolveSpatialMul(spatial);
    if (sm < SPATIAL_MIN_AUDIBLE) return;
    const now = ctx.currentTime;
    playOscThrough("sine", 108, 132, 0.036 * sm, 0.11, sfxBus, now);
    playOscThrough("sine", 132, 98, 0.028 * sm, 0.1, sfxBus, now + 0.06);
  });
}

/** @param {import("./audio-spatial.js").SpatialSpec | null} [spatial] */
export function playBuffTeamSfx(spatial) {
  resumeAudioContext().then(() => {
    if (!ctx || !sfxBus || settings.muted) return;
    if (playEventSample("buff_team", { bus: "sfx", gainMul: 0.95, spatial })) return;
    const sm = resolveSpatialMul(spatial);
    if (sm < SPATIAL_MIN_AUDIBLE) return;
    const now = ctx.currentTime;
    playOscThrough("sine", 92, 118, 0.038 * sm, 0.12, sfxBus, now);
    playOscThrough("triangle", 88, 108, 0.032 * sm, 0.14, sfxBus, now + 0.05, 420);
  });
}

/** @param {import("./audio-spatial.js").SpatialSpec | null} [spatial] по умолчанию личный пиксель (полная громкость). */
export function playPixelPlace(spatial) {
  resumeAudioContext().then(() => {
    if (!ctx || !sfxBus || settings.muted || !canPlayLowPrioritySfx()) return;
    const spec = spatial ?? { scope: "personal", weight: 1 };
    registerLowPrioritySfx();
    if (playEventSample("pixel_place", { bus: "sfx", gainMul: 0.72, spatial: spec })) return;
    const sm = resolveSpatialMul(spec);
    if (sm < SPATIAL_MIN_AUDIBLE) return;
    const now = ctx.currentTime;
    playFilteredNoiseBurst(sfxBus, now, 0.012, 0.035 * sm, 680);
    playOscThrough("sine", 265, 198, 0.045 * sm, 0.028, sfxBus, now + 0.001);
  });
}

/**
 * @param {4 | 6 | 12 | void} [zoneSide] сторона зоны захвата; без аргумента — только процедурный звук.
 * @param {import("./audio-spatial.js").SpatialSpec | null} [spatial]
 */
export function playTerritoryExpand(zoneSide, spatial) {
  resumeAudioContext().then(() => {
    if (!ctx || !sfxBus || settings.muted) return;
    if (zoneSide === 4 || zoneSide === 6 || zoneSide === 12) {
      const key = zoneSide === 12 ? "territory_12" : zoneSide === 6 ? "territory_6" : "territory_4";
      if (playEventSample(key, { bus: "sfx", gainMul: 1, spatial })) return;
    }
    const sm = resolveSpatialMul(spatial);
    if (sm < SPATIAL_MIN_AUDIBLE) return;
    const now = ctx.currentTime;
    playOscThrough("sine", 55, 95, 0.048 * sm, 0.28, sfxBus, now);
    playFilteredNoiseBurst(sfxBus, now + 0.04, 0.14, 0.022 * sm, 380);
  });
}

/** Глобально слышимый стинг плацдарма (по ТЗ). */
export function playMilitaryBaseDeploySound() {
  resumeAudioContext().then(() => {
    if (!ctx || !sfxBus || settings.muted) return;
    const spatial = /** @type {const} */ ({ scope: "global", weight: 1 });
    if (playEventSample("military_base", { bus: "sfx", gainMul: 1, spatial })) return;
    const now = ctx.currentTime;
    playOscThrough("sine", 55, 95, 0.048, 0.28, sfxBus, now);
    playFilteredNoiseBurst(sfxBus, now + 0.04, 0.14, 0.022, 380);
  });
}

/** @param {import("./audio-spatial.js").SpatialSpec | null} [spatial] */
export function playFlagBaseHit(spatial) {
  resumeAudioContext().then(() => {
    if (!ctx || !sfxBus || settings.muted) return;
    const nowW = performance.now();
    if (nowW - lastBaseHitWallMs < 320) return;
    lastBaseHitWallMs = nowW;
    const now = ctx.currentTime;
    duckMusicForAlert(260, false);
    if (playEventSample("base_hit", { bus: "sfx", gainMul: 1.02, spatial })) return;
    const sm = resolveSpatialMul(spatial);
    if (sm < SPATIAL_MIN_AUDIBLE) return;
    playSubThump(sfxBus, now, 0.26, 68, 42, 0.26 * sm);
    playFilteredNoiseBurst(sfxBus, now + 0.01, 0.07, 0.065 * sm, 1100);
    playOscThrough("triangle", 78, 48, 0.028 * sm, 0.15, sfxBus, now + 0.018, 420);
  });
}

export function playBombExplosion() {
  resumeAudioContext().then(() => {
    if (!ctx || !sfxBus || settings.muted) return;
    const nowW = performance.now();
    if (nowW - lastExplosionWallMs < 380) return;
    lastExplosionWallMs = nowW;
    duckMusicForAlert(520, true);
    const nuke = /** @type {const} */ ({ scope: "global", weight: 1 });
    if (playEventSample("bomb", { bus: "sfx", gainMul: 1.05, spatial: nuke })) {
      lastEpicStingWallMs = performance.now();
      return;
    }
    playPresentationSting("nuke-bomb", nuke);
  });
}

export function playQuantumConnect() {
  resumeAudioContext().then(() => {
    if (!ctx || !sfxBus || settings.muted) return;
    if (playEventSample("quantum_connect", { bus: "sfx", gainMul: 0.98 })) return;
    const now = ctx.currentTime;
    playOscThrough("sine", 48, 118, 0.075, 0.38, sfxBus, now);
    playOscThrough("triangle", 55, 92, 0.032, 0.32, sfxBus, now + 0.06, 340);
    playFilteredNoiseBurst(sfxBus, now + 0.12, 0.12, 0.028, 600);
  });
}

export function playQuantumDisconnect() {
  resumeAudioContext().then(() => {
    if (!ctx || !sfxBus || settings.muted) return;
    if (playEventSample("quantum_disconnect", { bus: "sfx", gainMul: 0.98 })) return;
    const now = ctx.currentTime;
    playOscThrough("sine", 125, 38, 0.08, 0.35, sfxBus, now);
    playOscThrough("triangle", 78, 38, 0.03, 0.28, sfxBus, now + 0.04, 300);
    playFilteredNoiseBurst(sfxBus, now + 0.08, 0.16, 0.04, 380);
  });
}

export function playQuantumIncomeTick() {
  resumeAudioContext().then(() => {
    if (!ctx || !sfxBus || settings.muted || !canPlayLowPrioritySfx()) return;
    registerLowPrioritySfx();
    if (playEventSample("quantum_tick", { bus: "sfx", gainMul: 0.72 })) return;
    const now = ctx.currentTime;
    playOscThrough("sine", 88, 102, 0.022, 0.055, sfxBus, now);
  });
}

export function playAlertBaseUnderAttack() {
  resumeAudioContext().then(() => {
    if (!ctx || !alertBus || settings.muted) return;
    lastAlertWallMs = performance.now();
    duckMusicForAlert(720, true);
    if (playEventSample("alert_base_attack", { bus: "alert", gainMul: 0.92 })) return;
    const now = ctx.currentTime;
    playTacticalRadioCrackle(alertBus, now, 0.018);
    for (let i = 0; i < 3; i++) {
      const t = now + 0.045 + i * 0.12;
      playOscThrough("sine", 142, 142, 0.095, 0.052, alertBus, t);
      playOscThrough("sine", 108, 108, 0.072, 0.045, alertBus, t + 0.058);
    }
  });
}

export function playAlertLastCells() {
  resumeAudioContext().then(() => {
    if (!ctx || !alertBus || settings.muted) return;
    lastAlertWallMs = performance.now();
    duckMusicForAlert(560, true);
    if (playEventSample("alert_last_cells", { bus: "alert", gainMul: 0.9 })) return;
    const now = ctx.currentTime;
    playOscThrough("sine", 122, 122, 0.068, 0.072, alertBus, now);
    playOscThrough("sine", 98, 98, 0.06, 0.068, alertBus, now + 0.095);
    playOscThrough("sine", 108, 72, 0.078, 0.14, alertBus, now + 0.2);
    playOscThrough("sine", 88, 58, 0.058, 0.12, alertBus, now + 0.29);
  });
}

export function playAlertLastCell() {
  resumeAudioContext().then(() => {
    if (!ctx || !alertBus || settings.muted) return;
    lastAlertWallMs = performance.now();
    duckMusicForAlert(920, true);
    if (playEventSample("alert_last_cells", { bus: "alert", gainMul: 0.95 })) return;
    const now = ctx.currentTime;
    playTacticalRadioCrackle(alertBus, now, 0.014);
    const steps = [132, 118, 102, 88];
    for (let i = 0; i < steps.length; i++) {
      const f = steps[i];
      playOscThrough("sine", f, f, 0.095, 0.068, alertBus, now + 0.055 + i * 0.085);
    }
    playSubThump(alertBus, now + 0.38, 0.2, 48, 32, 0.14);
  });
}

export function playAlertTerritoryCutOff() {
  resumeAudioContext().then(() => {
    if (!ctx || !alertBus || settings.muted) return;
    lastAlertWallMs = performance.now();
    duckMusicForAlert(520, true);
    if (playEventSample("alert_territory_cut", { bus: "alert", gainMul: 0.92 })) return;
    const now = ctx.currentTime;
    playFilteredNoiseBurst(alertBus, now, 0.22, 0.07, 420);
    playOscThrough("sine", 95, 38, 0.09, 0.26, alertBus, now + 0.04);
    playOscThrough("triangle", 92, 48, 0.04, 0.16, alertBus, now + 0.1, 360);
    playSubThump(alertBus, now + 0.14, 0.18, 62, 38, 0.16);
  });
}

/** @type {ReturnType<typeof setTimeout> | null} */
let seismicAfterSfxTimer = null;

/** @param {import("./audio-spatial.js").SpatialSpec | null} [spatial] локальный удар по эпицентру / fallback global */
export function playSeismicImpactSfx(spatial) {
  resumeAudioContext().then(() => {
    if (!ctx || settings.muted) return;
    const spatialUse = spatial ?? { scope: "global", weight: 1 };
    duckMusicForAlert(600, true);
    if (playEventSample("seismic_hit", { bus: "sfx", gainMul: 1.02, spatial: spatialUse })) return;
    if (resolveSpatialMul(spatialUse) < SPATIAL_MIN_AUDIBLE) return;
    playPresentationSting("seismic", spatialUse);
  });
}

/** @param {import("./audio-spatial.js").SpatialSpec | null} [spatial] */
export function scheduleSeismicAftermathSfx(spatial) {
  if (typeof window === "undefined") return;
  if (seismicAfterSfxTimer != null) clearTimeout(seismicAfterSfxTimer);
  const spatialUse = spatial ?? { scope: "global", weight: 0.85 };
  seismicAfterSfxTimer = window.setTimeout(() => {
    seismicAfterSfxTimer = null;
    resumeAudioContext().then(() => {
      if (!ctx || settings.muted) return;
      playEventSample("seismic_after", { bus: "sfx", gainMul: 0.78, spatial: spatialUse });
    });
  }, 1100);
}

export function playRoundEndSfx() {
  resumeAudioContext().then(() => {
    if (!ctx || settings.muted) return;
    duckMusicForAlert(900, true);
    const g = /** @type {const} */ ({ scope: "global", weight: 1 });
    if (playEventSample("round_end", { bus: "sfx", gainMul: 1, spatial: g })) return;
    if (!sfxBus) return;
    const now = ctx.currentTime;
    playSubThump(sfxBus, now, 0.38, 40, 22, 0.26);
    playOscThrough("sine", 88, 52, 0.05, 0.36, sfxBus, now + 0.04);
  });
}

export function playFinalVictorySfx() {
  resumeAudioContext().then(() => {
    if (!ctx || settings.muted) return;
    duckMusicForAlert(1400, true);
    const g = /** @type {const} */ ({ scope: "global", weight: 1 });
    if (playEventSample("final_victory", { bus: "sfx", gainMul: 1.02, spatial: g })) return;
    if (!sfxBus) return;
    const now = ctx.currentTime;
    playSubThump(sfxBus, now, 0.45, 36, 20, 0.32);
    playOscThrough("triangle", 78, 118, 0.055, 0.52, sfxBus, now + 0.06, 380);
    playFilteredNoiseBurst(sfxBus, now + 0.14, 0.2, 0.05, 720);
  });
}

export function playTreasureFoundSfx() {
  resumeAudioContext().then(() => {
    if (!ctx || settings.muted) return;
    const p = /** @type {const} */ ({ scope: "personal", weight: 1 });
    if (playEventSample("treasure", { bus: "sfx", gainMul: 0.95, spatial: p })) return;
    if (!sfxBus) return;
    const now = ctx.currentTime;
    playOscThrough("sine", 118, 92, 0.042, 0.28, sfxBus, now);
    playOscThrough("triangle", 88, 68, 0.028, 0.3, sfxBus, now + 0.05, 380);
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
 *   roundLeftMs?: number | null;
 * }} snap
 */
export function computeGameplayMusicIntensity(snap) {
  if (!snap.hasTeam || snap.spectator) return MUSIC_STATE.CALM;
  const t = snap.now;
  let next = MUSIC_STATE.CALM;

  const lastCell = t < snap.lastCellUntil;
  const hpCrit = snap.mainBaseHpRatio < 0.15 && snap.mainBaseHpRatio >= 0;
  const basePanic = t < snap.flagCriticalUntil || lastCell || hpCrit;
  const underAttack = t < snap.flagUnderAttackUntil;

  if (basePanic || (underAttack && snap.mainBaseHpRatio < 0.35)) {
    next = MUSIC_STATE.CRITICAL;
  } else if (t < snap.territoryDangerUntil && snap.territoryCellsRemaining <= 8) {
    next = MUSIC_STATE.BATTLE;
  } else if (t < snap.combatBumpUntil || t < snap.nukeAfterglowUntil) {
    next = MUSIC_STATE.BATTLE;
  } else if (
    underAttack ||
    snap.isolationMyTeam ||
    (t < snap.territoryDangerUntil && snap.territoryCellsRemaining <= 22)
  ) {
    next = MUSIC_STATE.TENSION;
  }

  const rlm = snap.roundLeftMs;
  if (rlm != null && Number.isFinite(rlm) && rlm > 0) {
    if (rlm <= 60_000) next = Math.max(next, MUSIC_STATE.CRITICAL);
    else if (rlm <= 120_000) next = Math.max(next, MUSIC_STATE.BATTLE);
    else if (rlm <= 180_000) next = Math.max(next, MUSIC_STATE.TENSION);
  }

  return next;
}

/**
 * Импульс боя (быстро гаснет) и фоновое давление (медленнее) — для реактивного микса стрима и процедуры.
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
 *   roundLeftMs?: number | null;
 *   lastOwnPlaceMs?: number;
 * }} snap
 */
export function computeBattleReactive01(snap) {
  if (!snap.hasTeam || snap.spectator) return { battlePulse01: 0, sustainDread01: 0 };
  const t = snap.now;
  let pulse = 0;
  if (t < snap.combatBumpUntil) {
    pulse = Math.max(pulse, Math.min(1, (snap.combatBumpUntil - t) / 2400));
  }
  if (t < snap.nukeAfterglowUntil) {
    pulse = Math.max(pulse, Math.min(1, (snap.nukeAfterglowUntil - t) / 4500));
  }
  if (t < snap.flagCriticalUntil) pulse = Math.max(pulse, 0.74);
  if (t < snap.lastCellUntil) pulse = Math.max(pulse, 0.9);
  if (t < snap.flagUnderAttackUntil) pulse = Math.max(pulse, 0.44);

  const lastPl = snap.lastOwnPlaceMs;
  if (typeof lastPl === "number" && lastPl > 0 && t >= lastPl) {
    pulse = Math.max(pulse, Math.min(1, (1 - (t - lastPl) / 720) * 0.64));
  }

  let sustain = 0;
  if (t < snap.flagUnderAttackUntil) sustain += 0.44;
  const hp = snap.mainBaseHpRatio;
  if (hp < 0.52 && hp >= 0) sustain += ((0.52 - hp) / 0.52) * 0.58;
  if (snap.isolationMyTeam) sustain += 0.34;
  if (t < snap.territoryDangerUntil) {
    const c = Math.min(48, Math.max(0, snap.territoryCellsRemaining));
    sustain += Math.min(0.48, ((28 - Math.min(28, c)) / 28) * 0.48);
  }
  const rlm = snap.roundLeftMs;
  if (rlm != null && Number.isFinite(rlm) && rlm > 0 && rlm < 240_000) {
    sustain += (1 - rlm / 240_000) * 0.4;
  }

  return { battlePulse01: Math.min(1, pulse), sustainDread01: Math.min(1, sustain) };
}

/**
 * @param {{
 *   uiPhase: "menu" | "preRound" | "gameplay" | "postRound" | "final";
 *   gameplayIntensity?: number;
 *   preRoundSecondsLeft?: number;
 *   gamePaused?: boolean;
 *   battlePulse01?: number;
 *   sustainDread01?: number;
 * }} payload
 */
export function syncDynamicBgmMusic(payload) {
  resumeAudioContext().then(() => {
    if (!ctx) return;
    const mm = settings.muted ? 0 : settings.master * settings.music;
    streamingBgm.setOutputLevel(settings.muted, mm);
    streamingBgm.setGameplayPaused(!!payload.gamePaused);
    const flatReactive = {
      uiPhase: payload.uiPhase,
      gameplayIntensity: 0,
      battlePulse01: 0,
      sustainDread01: 0,
      preRoundSecondsLeft: payload.preRoundSecondsLeft,
    };
    if (settings.muted) {
      streamingBgm.applyReactiveBattleMix(flatReactive);
      return;
    }
    streamingBgm.syncFromMain({
      uiPhase: payload.uiPhase,
      gameplayIntensity: payload.gameplayIntensity ?? 0,
      preRoundSecondsLeft: payload.preRoundSecondsLeft,
    });
    streamingBgm.applyReactiveBattleMix({
      uiPhase: payload.uiPhase,
      gameplayIntensity: payload.gameplayIntensity ?? 0,
      battlePulse01: payload.battlePulse01 ?? 0,
      sustainDread01: payload.sustainDread01 ?? 0,
      preRoundSecondsLeft: payload.preRoundSecondsLeft,
    });
  });
}

export function syncReactiveMusic(snap) {
  resumeAudioContext().then(() => {
    if (!ctx || settings.muted) return;
    startMusicEngine();
    if (!snap.hasTeam || snap.spectator) {
      setMusicState(MUSIC_STATE.CALM);
    } else {
      setMusicState(computeGameplayMusicIntensity(snap));
    }
    syncProceduralStreamingOverlay();
    applyProceduralBattleBrightness(snap);
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
  refreshGameAudioToolbarUi?.();
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

  const positionAudioPanel = () => {
    if (!panel || panel.hidden || !btn) return;
    const r = btn.getBoundingClientRect();
    const margin = 6;
    panel.style.position = "fixed";
    panel.style.left = "auto";
    panel.style.bottom = "auto";
    panel.style.top = `${Math.round(r.bottom + margin)}px`;
    panel.style.right = `${Math.round(window.innerWidth - r.right)}px`;
    panel.style.zIndex = "20050";
  };

  const syncUi = () => {
    if (masterEl) {
      masterEl.value = String(Math.round(settings.master * 100));
    }
    if (musicEl) musicEl.value = String(Math.round(settings.music * 100));
    if (sfxEl) sfxEl.value = String(Math.round(settings.effects * 100));
    if (muteEl) muteEl.checked = settings.muted;
  };

  const syncToolbarBtn = () => {
    if (!btn) return;
    if (settings.muted) {
      btn.textContent = "🔇";
      btn.classList.add("toolbar__btn--audio-muted");
      btn.setAttribute("aria-pressed", "true");
      btn.title = "Звук выключен — нажмите, чтобы настроить или включить";
    } else {
      btn.textContent = "🔊";
      btn.classList.remove("toolbar__btn--audio-muted");
      btn.setAttribute("aria-pressed", "false");
      btn.title = "Звук включён — нажмите для настроек громкости";
    }
  };

  refreshGameAudioToolbarUi = () => {
    syncUi();
    syncToolbarBtn();
  };

  syncUi();
  syncToolbarBtn();

  const togglePanel = () => {
    if (!panel) return;
    const wasHidden = panel.hidden;
    panel.hidden = !wasHidden;
    if (btn) btn.setAttribute("aria-expanded", wasHidden ? "true" : "false");
    if (!panel.hidden) {
      playMenuOpenSfx();
      positionAudioPanel();
      syncUi();
    }
  };

  if (btn && panel) {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      void resumeAudioContext();
      togglePanel();
    });
  }

  window.addEventListener("resize", () => {
    if (panel && !panel.hidden) positionAudioPanel();
  });

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

  const applyMuteFromCheckbox = () => {
    if (!muteEl) return;
    applyAudioSettings({ muted: muteEl.checked });
  };
  if (muteEl) {
    muteEl.addEventListener("change", applyMuteFromCheckbox);
    muteEl.addEventListener("input", applyMuteFromCheckbox);
  }

  const resumeOnGesture = () => {
    try {
      if (ctx && ctx.state !== "running") void ctx.resume();
    } catch {
      /* ignore */
    }
    void resumeAudioContext();
  };
  document.body.addEventListener("pointerdown", resumeOnGesture, { passive: true });
  document.body.addEventListener("touchstart", resumeOnGesture, { passive: true });
  document.body.addEventListener("keydown", resumeOnGesture, { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void resumeAudioContext();
  });
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) void resumeAudioContext();
  });
  try {
    window.Telegram?.WebApp?.onEvent?.("viewportChanged", () => {
      void resumeAudioContext();
    });
  } catch {
    /* ignore */
  }

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
