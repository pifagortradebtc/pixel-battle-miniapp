/**
 * Клиентский wall-clock «окно» «Мстим за Альт Сезон».
 * Пакеты stats/globalEvent могут перезаписать walletState.globalEvent без altSeasonRevengeUntilMs;
 * WS mstimAltSeasonSync — надёжный сигнал. Держим until здесь, пока не придёт sync(0) или не истечёт время.
 */

let burstUntilMs = 0;

/** Подмена «сейчас» для UI (пауза — заморозка на pauseWallStartedAt). По умолчанию Date.now. */
let clientNowMsFn = () => Date.now();

/**
 * @param {() => number} fn
 */
export function setMstimClientNowProvider(fn) {
  clientNowMsFn = typeof fn === "function" ? fn : () => Date.now();
}

function clientNowMs() {
  return clientNowMsFn();
}

function clampEpochMs(n) {
  const t = Math.trunc(Number(n));
  if (!Number.isFinite(t) || t < 1) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, t);
}

/**
 * @param {number} u until (мс) или 0 для сброса
 */
export function setMstimAltSeasonClientBurstUntilMs(u) {
  burstUntilMs = clampEpochMs(u);
}

/**
 * @returns {number} положительный until, если окно ещё активно; иначе 0
 */
export function getMstimAltSeasonClientBurstUntilMs() {
  const u = clampEpochMs(burstUntilMs);
  if (u <= 0) return 0;
  if (u <= clientNowMs()) {
    burstUntilMs = 0;
    return 0;
  }
  return u;
}

/** Сырое until в памяти (без авто-сброса по истечении) — для слияния со stats, чтобы старый пакет не обнулял mstim. */
export function getMstimAltSeasonClientBurstUntilStored() {
  return clampEpochMs(burstUntilMs);
}
