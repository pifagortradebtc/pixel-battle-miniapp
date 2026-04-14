/**
 * Аудио: эффекты, UI, алерты (Web Audio API). Фоновой музыки нет.
 */

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

/** @typedef {{ master: number; effects: number; muted: boolean }} AudioSettings */

const DEFAULT_SETTINGS = /** @type {const} */ ({
  master: 0.85,
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
let sfxBus = null;
/** @type {GainNode | null} */
let uiBus = null;
/** @type {GainNode | null} */
let alertBus = null;

let lastAlertWallMs = 0;
let lastExplosionWallMs = 0;
let lastBaseHitWallMs = 0;
/** Длинные кинематографические стинги — не засыпать UI мелочью сразу после. */
let lastEpicStingWallMs = 0;
let lowPrioritySfxCount = 0;

/** Сэмплы событий из sfx/samples.json (при отсутствии файла — процедурный fallback). */
/** @type {Map<string, AudioBuffer>} */
const eventSfxBuffers = new Map();
/** @type {Promise<void> | null} */
let eventSfxPreloadPromise = null;

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const o = JSON.parse(raw);
    if (typeof o.master === "number") settings.master = Math.min(1, Math.max(0, o.master));
    if (typeof o.effects === "number") settings.effects = Math.min(1, Math.max(0, o.effects));
    if (typeof o.muted === "boolean") settings.muted = o.muted;
    /* Сломанное состояние из UI: не mute, но все ползунки на 0 — полная тишина. */
    if (!settings.muted && settings.master === 0 && settings.effects === 0) {
      settings = { ...DEFAULT_SETTINGS };
      saveSettings();
    }
  } catch {
    /* ignore */
  }
}

function saveSettings() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        master: settings.master,
        effects: settings.effects,
        muted: settings.muted,
      })
    );
  } catch {
    /* ignore */
  }
}

function applyBusGains() {
  if (!masterGain || !sfxBus || !uiBus || !alertBus) return;
  const m = settings.muted ? 0 : settings.master;
  const ev = m * settings.effects;
  if (ctx) {
    const t = ctx.currentTime;
    masterGain.gain.cancelScheduledValues(t);
    masterGain.gain.setValueAtTime(m, t);
    sfxBus.gain.cancelScheduledValues(t);
    sfxBus.gain.setValueAtTime(ev * 0.9, t);
    uiBus.gain.cancelScheduledValues(t);
    uiBus.gain.setValueAtTime(ev * 0.34, t);
    alertBus.gain.cancelScheduledValues(t);
    alertBus.gain.setValueAtTime(ev * 1.06, t);
  } else {
    masterGain.gain.value = m;
    sfxBus.gain.value = ev * 0.9;
    uiBus.gain.value = ev * 0.34;
    alertBus.gain.value = ev * 1.06;
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

function kickPostResumePreload() {
  void preloadEventSfxBuffers()
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
  sfxBus = ctx.createGain();
  sfxBus.connect(masterGain);
  uiBus = ctx.createGain();
  uiBus.connect(masterGain);
  alertBus = ctx.createGain();
  alertBus.connect(masterGain);
}

/** Раньше прижимала музыку под алерты; фона нет — заглушка. */
function duckMusicForAlert() {}

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
 * @param {Partial<AudioSettings>} patch
 */
export function applyAudioSettings(patch) {
  if (typeof patch.master === "number") settings.master = Math.min(1, Math.max(0, patch.master));
  if (typeof patch.effects === "number") settings.effects = Math.min(1, Math.max(0, patch.effects));
  if (typeof patch.muted === "boolean") settings.muted = patch.muted;
  saveSettings();
  applyBusGains();
  refreshGameAudioToolbarUi?.();
}

export function getAudioSettings() {
  return { master: settings.master, effects: settings.effects, muted: settings.muted };
}

/**
 * Инициализация: настройки из storage, UI, жест для AudioContext.
 */
export function initGameAudio() {
  loadSettings();

  const panel = document.getElementById("game-audio-panel");
  const btn = document.getElementById("btn-game-audio");
  const masterEl = document.getElementById("game-audio-master");
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
        if (
          el.closest?.(
            ".toolbar__btn, .shop-btn, .welcome-team-btn, .welcome-open-browser__btn, .quick-buy-rail__btn"
          )
        ) {
          playUiClick();
        }
      },
      true
    );
  }

  applyBusGains();
}
