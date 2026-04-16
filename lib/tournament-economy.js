/**
 * Упрощённая экономика: базовый интервал 15 с, личные/командные баффы на 2 мин, захват зон 100%.
 */

/** @typedef {'MASS_BATTLE'|'SEMI_FINAL'|'FINAL'|'DUEL'|'GRAND_FINAL'} TournamentStage */

/** Базовое время между постановками пикселя (сек). */
export const BASE_ACTION_COOLDOWN_SEC = 15;

/** Длительность личного и командного баффа восстановления. */
export const RECOVERY_BUFF_DURATION_MS = 2 * 60 * 1000;

/**
 * Цены в квантах. Списание на сервере: кванты / 7 = USDT.
 */
export const PRICES_QUANT = {
  personal: { 10: 14, 5: 28, 2: 56, 1: 70 },
  team: { 10: 300, 5: 500, 2: 700, 1: 900 },
  zone4: 42,
  zone6: 84,
  zone12: 168,
  /** Бомба: хаотичная очистка ~12×12, без привязки к своей территории */
  nukeBomb: 340,
  /** Передовая база 6×6: новая точка расширения; изоляция по-прежнему от главной базы */
  militaryBase: 420,
  /** Великая стена: усиление своей клетки до 3 HP (без регенерации) */
  greatWall: 40,
  /** Квантовая ферма: апгрейд 1→2 */
  quantumFarmTo2: 200,
  /** Квантовая ферма: апгрейд 2→3 */
  quantumFarmTo3: 500,
};

/** @deprecated используйте PRICES_QUANT */
export const PRICES_TUGRI = PRICES_QUANT;

/** Кванты пригласившему, когда новичок первый раз зашёл по реферальной ссылке (из Telegram, с initData). */
export const REFERRAL_JOIN_INVITER_QUANT = 10;

export function quantToUsdt(quant) {
  return quant / 7;
}

/** @deprecated используйте quantToUsdt */
export function tugriToUsdt(q) {
  return quantToUsdt(q);
}

/**
 * Раньше — пауза между повторными захватами на сервере. Сейчас платные зоны/масс-захват
 * не ограничиваются таймером (лимит — баланс и rate limit WS); поля оставлены для совместимости/текста.
 */
export const ZONE_CAPTURE_COOLDOWN_MS = 60 * 1000;
export const MASS_CAPTURE_COOLDOWN_MS = 120 * 1000;
export const ZONE12_CAPTURE_COOLDOWN_MS = 120 * 1000;

/**
 * Тактические покупки (зоны, бомба, плацдарм) и экономика — во всех стадиях, кроме дуэли и гранд-финала.
 * Ускорение пикселя в дуэли: см. `stageAllowsRecoveryPurchases` и `getCurrentCooldownMs`.
 * @param {TournamentStage} stage
 */
export function stageAllows(stage) {
  if (stage === "GRAND_FINAL" || stage === "DUEL") return false;
  return true;
}

/**
 * Личное и командное ускорение постановки пикселей — в дуэли разрешено; в гранд-финале (наблюдение) нет.
 * @param {TournamentStage} stage
 */
export function stageAllowsRecoveryPurchases(stage) {
  return stage !== "GRAND_FINAL";
}

/**
 * Эффективный интервал между пикселями (сек): минимум из базы, личного и командного (меньше секунд = чаще ход).
 * @param {{ personalRecoveryUntil: number, personalRecoverySec: number }} user
 * @param {{ teamRecoveryUntil: number, teamRecoverySec: number }} teamFx
 */
export function getEffectiveRecoverySec(user, teamFx, now = Date.now()) {
  const base = BASE_ACTION_COOLDOWN_SEC;
  const untilP = Number(user.personalRecoveryUntil);
  const secP = Number(user.personalRecoverySec);
  let p = base;
  if (
    Number.isFinite(untilP) &&
    untilP > now &&
    Number.isFinite(secP) &&
    secP >= 1
  ) {
    p = secP;
  }
  const untilT = Number(teamFx.teamRecoveryUntil);
  const secT = Number(teamFx.teamRecoverySec);
  let t = base;
  if (
    Number.isFinite(untilT) &&
    untilT > now &&
    Number.isFinite(secT) &&
    secT >= 1
  ) {
    t = secT;
  }
  return Math.min(base, p, t);
}

/**
 * @param {{ personalRecoveryUntil: number, personalRecoverySec: number }} user
 * @param {{ teamRecoveryUntil: number, teamRecoverySec: number }} teamFx
 * @param {TournamentStage} stage
 */
export function getCurrentCooldownMs(user, teamFx, stage, now = Date.now()) {
  if (stage === "GRAND_FINAL") {
    return BASE_ACTION_COOLDOWN_SEC * 1000;
  }
  const sec = getEffectiveRecoverySec(user, teamFx, now);
  return Math.round(sec * 1000);
}

/** Глобальное ускорение «Мстим за Альт Сезон» (бот speed): 1 с между пикселями для всех. */
export const GLOBAL_ALT_SEASON_PIXEL_COOLDOWN_SEC = 1;
export const GLOBAL_ALT_SEASON_PIXEL_COOLDOWN_MS = GLOBAL_ALT_SEASON_PIXEL_COOLDOWN_SEC * 1000;

/**
 * Единый авторитетный интервал между обычными пикселями (мс).
 * При активном глобальном speed — всегда 1 с, иначе база 15 с + личные/командные баффы (как getCurrentCooldownMs).
 *
 * @param {boolean} globalAltSeasonActive
 * @param {{ personalRecoveryUntil: number, personalRecoverySec: number }} user
 * @param {{ teamRecoveryUntil: number, teamRecoverySec: number }} teamFx
 * @param {TournamentStage} stage
 */
export function resolveAuthoritativePixelCooldownMs(globalAltSeasonActive, user, teamFx, stage, now = Date.now()) {
  if (globalAltSeasonActive) return GLOBAL_ALT_SEASON_PIXEL_COOLDOWN_MS;
  return getCurrentCooldownMs(user, teamFx, stage, now);
}

/**
 * Секунды для подписи в wallet / UI (минимум из базы и баффов, либо 1 с при глобальном speed).
 */
export function resolveAuthoritativeRecoverySec(globalAltSeasonActive, user, teamFx, now = Date.now()) {
  if (globalAltSeasonActive) return GLOBAL_ALT_SEASON_PIXEL_COOLDOWN_SEC;
  return getEffectiveRecoverySec(user, teamFx, now);
}

/**
 * @param {number} roundIndex
 * @param {boolean} gameFinished
 * @returns {TournamentStage}
 */
export function tournamentStage(roundIndex, gameFinished) {
  if (gameFinished) return "GRAND_FINAL";
  if (roundIndex === 0) return "MASS_BATTLE";
  if (roundIndex === 1) return "SEMI_FINAL";
  if (roundIndex === 2) return "FINAL";
  if (roundIndex === 3) return "DUEL";
  return "GRAND_FINAL";
}
