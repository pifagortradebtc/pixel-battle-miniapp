/**
 * Клиентский wall-clock «окно» «Мстим за Альт Сезон».
 * Пакеты stats/globalEvent могут перезаписать walletState.globalEvent без altSeasonRevengeUntilMs;
 * WS mstimAltSeasonSync — надёжный сигнал. Держим until здесь, пока не придёт sync(0) или не истечёт время.
 */

let burstUntilMs = 0;

/**
 * @param {number} u until (мс) или 0 для сброса
 */
export function setMstimAltSeasonClientBurstUntilMs(u) {
  const n = Number(u) || 0;
  burstUntilMs = n > 0 ? n | 0 : 0;
}

/**
 * @returns {number} положительный until, если окно ещё активно; иначе 0
 */
export function getMstimAltSeasonClientBurstUntilMs() {
  const u = burstUntilMs | 0;
  if (u <= 0) return 0;
  if (u <= Date.now()) {
    burstUntilMs = 0;
    return 0;
  }
  return u;
}
