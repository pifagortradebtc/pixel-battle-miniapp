/**
 * Фоновый плейлист: shuffle без подряд повторов, кроссфейд, пауза в фоне / админ-паузе.
 * Два HTMLAudioElement + MediaElementSource (без создания новых Audio() на каждый трек).
 */

import { resolvePublicAssetUrl } from "./asset-url.js";

const MANIFEST = "music/manifest.json";
const FADE_OUT_SEC = 1.15;
const FADE_IN_SEC = 1.15;
/** Доля от master×music: музыка заметно тише сигналов с шины sfx. */
const MUSIC_PROGRAM_PEAK_CAP = 0.34;

/** @type {AudioContext | null} */
let audioCtx = null;
/** @type {GainNode | null} */
let programBus = null;

/** @type {HTMLAudioElement | null} */
let elA = null;
/** @type {HTMLAudioElement | null} */
let elB = null;
/** @type {GainNode | null} */
let gA = null;
/** @type {GainNode | null} */
let gB = null;
/** @type {MediaElementAudioSourceNode | null} */
let srcA = null;
/** @type {MediaElementAudioSourceNode | null} */
let srcB = null;

/** @type {string[]} */
let tracks = [];
let manifestPromise = null;
/** 0 = A ведущий, 1 = B ведущий */
let leadSlot = 0;
let lastPick = -1;
let started = false;
/** Игра «в бою» (не наблюдатель, не финал) — можно вести плейлист */
let gameplayAllowed = false;
/** Админ-пауза или вкладка в фоне — только пауза элементов */
let suspendedBySystem = false;

let wiredToProgram = false;

function ensureElements(ctx) {
  if (elA && elB && gA && gB && srcA && srcB) return;
  elA = new Audio();
  elB = new Audio();
  elA.crossOrigin = "anonymous";
  elB.crossOrigin = "anonymous";
  elA.preload = "auto";
  elB.preload = "auto";

  gA = ctx.createGain();
  gB = ctx.createGain();
  gA.gain.value = 0;
  gB.gain.value = 0;

  srcA = ctx.createMediaElementSource(elA);
  srcB = ctx.createMediaElementSource(elB);
  srcA.connect(gA);
  srcB.connect(gB);
  wiredToProgram = false;

  elA.addEventListener("ended", () => onTrackEnded(0));
  elB.addEventListener("ended", () => onTrackEnded(1));
}

/**
 * @param {AudioContext} ctx
 * @param {GainNode} programGain — уровень пользователя (master×music), уже подключён к duck → master
 */
export function wireBgmPlaylist(ctx, programGain) {
  audioCtx = ctx;
  programBus = programGain;
  ensureElements(ctx);
  if (programBus && gA && gB && !wiredToProgram) {
    gA.connect(programBus);
    gB.connect(programBus);
    wiredToProgram = true;
  }
}

function loadManifest() {
  if (manifestPromise) return manifestPromise;
  manifestPromise = fetch(resolvePublicAssetUrl(MANIFEST), { cache: "force-cache" })
    .then((r) => (r.ok ? r.json() : { tracks: [] }))
    .then((j) => {
      const list = Array.isArray(j.tracks) ? j.tracks.map((x) => String(x).trim()).filter(Boolean) : [];
      tracks = list.length ? list : [];
      return tracks;
    })
    .catch(() => {
      tracks = [];
      return tracks;
    });
  return manifestPromise;
}

/**
 * Случайный индекс, не совпадающий с предыдущим (если треков ≥ 2).
 */
function pickNextIndex() {
  const n = tracks.length;
  if (n <= 0) return -1;
  if (n === 1) return 0;
  let i = (Math.random() * n) | 0;
  if (i === lastPick) i = (i + 1) % n;
  lastPick = i;
  return i;
}

function urlForTrackIndex(i) {
  if (i < 0 || i >= tracks.length) return "";
  return resolvePublicAssetUrl(tracks[i]);
}

function slotElements(slot) {
  return slot === 0
    ? { el: elA, gain: gA, otherEl: elB, otherGain: gB }
    : { el: elB, gain: gB, otherEl: elA, otherGain: gA };
}

function onTrackEnded(slot) {
  if (!gameplayAllowed || suspendedBySystem) return;
  /* ended пришёл с неактивного слота (кроссфейд) — игнор */
  if (slot !== leadSlot) return;
  void crossfadeToNext();
}

/**
 * Кроссфейд: затухание текущего ведущего и нарастание другого слота с новым URL.
 */
async function crossfadeToNext() {
  const ctx = audioCtx;
  if (!ctx || !elA || !elB || !gA || !gB || tracks.length < 1) return;

  const nextI = pickNextIndex();
  if (nextI < 0) return;
  const url = urlForTrackIndex(nextI);
  if (!url) return;

  const outSlot = leadSlot;
  const inSlot = leadSlot === 0 ? 1 : 0;
  const out = slotElements(outSlot);
  const inn = slotElements(inSlot);

  const t0 = ctx.currentTime;
  const fade = Math.min(FADE_OUT_SEC, FADE_IN_SEC);

  try {
    inn.el.pause();
    inn.el.src = url;
    inn.el.load();
  } catch {
    /* ignore */
  }

  out.gain.gain.cancelScheduledValues(t0);
  const outCur = out.gain.gain.value;
  out.gain.gain.setValueAtTime(outCur, t0);
  out.gain.gain.linearRampToValueAtTime(0, t0 + fade);

  inn.gain.gain.cancelScheduledValues(t0);
  inn.gain.gain.setValueAtTime(0, t0);
  inn.gain.gain.linearRampToValueAtTime(1, t0 + fade);

  leadSlot = inSlot;

  try {
    await inn.el.play();
  } catch {
    /* автовоспроизведение / фон */
  }

  window.setTimeout(() => {
    try {
      out.el.pause();
    } catch {
      /* ignore */
    }
  }, Math.ceil(fade * 1000) + 80);
}

async function startFirstTrackIfNeeded() {
  const ctx = audioCtx;
  if (!ctx || !gameplayAllowed || suspendedBySystem || started) return;
  await loadManifest();
  if (tracks.length < 1) return;
  ensureElements(ctx);
  started = true;
  lastPick = -1;
  const i = pickNextIndex();
  const url = urlForTrackIndex(i);
  if (!url) return;

  leadSlot = 0;
  try {
    elB?.pause();
    if (gB) {
      const t = ctx.currentTime;
      gB.gain.cancelScheduledValues(t);
      gB.gain.setValueAtTime(0, t);
    }
    if (elA && gA) {
      elA.src = url;
      elA.load();
      const t = ctx.currentTime;
      gA.gain.cancelScheduledValues(t);
      gA.gain.setValueAtTime(0, t);
      gA.gain.linearRampToValueAtTime(1, t + FADE_IN_SEC);
      await elA.play();
    }
  } catch {
    started = false;
  }
}

/**
 * Подгружает первый трек в HTMLAudioElement до старта воспроизведения — меньше задержки,
 * когда музыка включается в бою или после duck под супероружием.
 */
export function prefetchBgmMedia() {
  void (async () => {
    const ctx = audioCtx;
    if (!ctx || started) return;
    await loadManifest();
    if (tracks.length < 1) return;
    ensureElements(ctx);
    const n = tracks.length;
    const i = (Math.random() * n) | 0;
    const url = urlForTrackIndex(i);
    if (!url || !elA) return;
    try {
      elA.src = url;
      elA.load();
    } catch {
      /* ignore */
    }
  })();
}

/**
 * Вызывать после user gesture + audioCtx.running (из game-audio).
 */
export function tryStartBgmAfterContextReady() {
  void startFirstTrackIfNeeded();
}

/**
 * Разрешить фоновую музыку во время активного раунда (не spectator / не game over).
 */
export function setBgmGameplayAllowed(allowed) {
  gameplayAllowed = !!allowed;
  if (!gameplayAllowed) {
    pauseBgmTracksOnly();
    started = false;
    lastPick = -1;
  } else if (!suspendedBySystem && audioCtx?.state === "running") {
    void startFirstTrackIfNeeded();
  }
}

export function pauseBgmForBackgroundOrOverlay() {
  suspendedBySystem = true;
  pauseBgmTracksOnly();
}

export function resumeBgmAfterForeground() {
  suspendedBySystem = false;
  if (!gameplayAllowed) return;
  void resumeBgmTracksOnly();
}

function pauseBgmTracksOnly() {
  try {
    elA?.pause();
    elB?.pause();
  } catch {
    /* ignore */
  }
}

async function resumeBgmTracksOnly() {
  const ctx = audioCtx;
  if (!ctx || ctx.state !== "running") return;
  const lead = slotElements(leadSlot);
  try {
    if (lead.el?.src) await lead.el.play();
  } catch {
    /* ignore */
  }
}

/** Пиковая доля программного гейна музыки относительно master (до duck). */
export function getBgmProgramPeakCap() {
  return MUSIC_PROGRAM_PEAK_CAP;
}

/** Пауза/возобновление при «Без музыки» (элементы не крутят декодер впустую). */
export function syncBgmUserMute(musicMuted) {
  if (musicMuted) pauseBgmTracksOnly();
  else if (gameplayAllowed && !suspendedBySystem) void resumeBgmTracksOnly();
}
