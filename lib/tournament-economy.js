/**
 * Упрощённая экономика: базовый интервал 20 с, личные/командные баффы на 2 мин, захват зон 100%.
 */

/** @typedef {'MASS_BATTLE'|'SEMI_FINAL'|'FINAL'|'DUEL'|'GRAND_FINAL'} TournamentStage */

/** Базовое время между постановками пикселя (сек). */
export const BASE_ACTION_COOLDOWN_SEC = 20;

/** Длительность личного и командного баффа восстановления. */
export const RECOVERY_BUFF_DURATION_MS = 2 * 60 * 1000;

/**
 * Цены в квантах. Списание на сервере: кванты / 7 = USDT.
 */
export const PRICES_QUANT = {
  personal: { 10: 14, 5: 28, 2: 56, 1: 65 },
  team: { 15: 200, 10: 300, 5: 400, 2: 500, 1: 800 },
  zone4: 42,
  zone6: 84,
  zone12: 168,
};

/** @deprecated используйте PRICES_QUANT */
export const PRICES_TUGRI = PRICES_QUANT;

export function quantToUsdt(quant) {
  return quant / 7;
}

/** @deprecated используйте quantToUsdt */
export function tugriToUsdt(q) {
  return quantToUsdt(q);
}

/** Интервал между покупками зон (не путать с кулдауном пикселя). */
export const ZONE_CAPTURE_COOLDOWN_MS = 60 * 1000;
export const MASS_CAPTURE_COOLDOWN_MS = 120 * 1000;
/** Пауза между повторным захватом 12×12 (как у 6×6). */
export const ZONE12_CAPTURE_COOLDOWN_MS = 120 * 1000;

/**
 * Покупки и пиксели разрешены во всех стадиях, кроме дуэли и гранд-финала.
 * @param {TournamentStage} stage
 */
export function stageAllows(stage) {
  if (stage === "GRAND_FINAL" || stage === "DUEL") return false;
  return true;
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
  if (!stageAllows(stage)) {
    return BASE_ACTION_COOLDOWN_SEC * 1000;
  }
  const sec = getEffectiveRecoverySec(user, teamFx, now);
  return Math.round(sec * 1000);
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
