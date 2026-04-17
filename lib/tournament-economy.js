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
  zone4: 60,
  zone6: 110,
  zone12: 200,
  /** Бомба: хаотичная очистка ~12×12, без привязки к своей территории */
  nukeBomb: 340,
  /** Передовая база 2×2: новая точка расширения; изоляция по-прежнему от главной базы */
  militaryBase: 2000,
  /**
   * Ремонт базы: таргетируемая способность (не мгновенная покупка).
   * Списание на сервере только после валидного тапа по своей базе; эффект +BASE_REPAIR_HP_DELTA, не выше max HP.
   */
  baseRepair: 400,
  /** Великая стена: усиление своей клетки до 3 HP (без регенерации) */
  greatWall: 40,
  /** Квантовая ферма: апгрейд 1 → 2 */
  quantumFarmTo2: 400,
  /** Квантовая ферма: апгрейд 2 → 3 */
  quantumFarmTo3: 800,
  /** Квантовая ферма: апгрейд 3 → 4 (макс. уровень) */
  quantumFarmTo4: 1000,
};

/**
 * Цена в квантах за следующий уровень фермы при текущем `curLevel` (1…MAX−1).
 * @param {number} curLevel
 */
export function quantumFarmUpgradePriceQuant(curLevel) {
  const lv = curLevel | 0;
  if (lv === 1) return PRICES_QUANT.quantumFarmTo2;
  if (lv === 2) return PRICES_QUANT.quantumFarmTo3;
  if (lv === 3) return PRICES_QUANT.quantumFarmTo4;
  return 0;
}

/** @deprecated используйте PRICES_QUANT */
export const PRICES_TUGRI = PRICES_QUANT;

/** Кванты пригласившему, когда новичок первый раз зашёл по реферальной ссылке (из Telegram, с initData). */
export const REFERRAL_JOIN_INVITER_QUANT = 10;

/**
 * Префикс идемпотентного id начисления пригласившему: `${REFERRAL_JOIN_PAYMENT_ID_PREFIX}${playerKeyПриглашённого}`.
 * Должен совпадать с server.js / сбросом в wallet-*.
 */
export const REFERRAL_JOIN_PAYMENT_ID_PREFIX = "referral_join_";

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
 * Апгрейд квантовых ферм в дуэли: см. `stageAllowsQuantumFarmUpgrade`.
 * @param {TournamentStage} stage
 */
export function stageAllows(stage) {
  if (stage === "GRAND_FINAL" || stage === "DUEL") return false;
  return true;
}

/**
 * Улучшение квантовой фермы (кванты) — в дуэли разрешено; в гранд-финале (наблюдение) нет.
 * @param {TournamentStage} stage
 */
export function stageAllowsQuantumFarmUpgrade(stage) {
  return stage !== "GRAND_FINAL";
}

/**
 * Личное и командное ускорение постановки пикселей — в дуэли разрешено; в гранд-финале (наблюдение) нет.
 * @param {TournamentStage} stage
 */
export function stageAllowsRecoveryPurchases(stage) {
  return stage !== "GRAND_FINAL";
}

/** Секунды интервала из сырого поля БД/JSON: только целые ≥1 (магазин 10/5/2/1 и база 15). */
function normalizedRecoveryIntervalSec(raw) {
  const t = Math.trunc(Number(raw));
  if (!Number.isFinite(t) || t < 1) return null;
  return t;
}

/**
 * Эффективный интервал между пикселями (сек): самый короткий из базы 15 с и активных личного/командного баффа
 * (меньше секунд = чаще ход). `until` задаётся в wall epoch — `now` тоже должен быть wall (Date.now), не игровые часы.
 * Возвращает целое число секунд → на сервере кулдаун всегда ровно `value * 1000` мс.
 * @param {{ personalRecoveryUntil: number, personalRecoverySec: number }} user
 * @param {{ teamRecoveryUntil: number, teamRecoverySec: number }} teamFx
 * @param {number} [now] wall epoch ms
 */
export function getEffectiveRecoverySec(user, teamFx, now = Date.now()) {
  const base = BASE_ACTION_COOLDOWN_SEC;
  const untilP = Number(user.personalRecoveryUntil);
  let p = base;
  if (Number.isFinite(untilP) && untilP > now) {
    const sp = normalizedRecoveryIntervalSec(user.personalRecoverySec);
    if (sp != null) p = sp;
  }
  const untilT = Number(teamFx.teamRecoveryUntil);
  let t = base;
  if (Number.isFinite(untilT) && untilT > now) {
    const st = normalizedRecoveryIntervalSec(teamFx.teamRecoverySec);
    if (st != null) t = st;
  }
  return Math.min(base, p, t);
}

/**
 * @param {{ personalRecoveryUntil: number, personalRecoverySec: number }} user
 * @param {{ teamRecoveryUntil: number, teamRecoverySec: number }} teamFx
 * @param {TournamentStage} stage
 * @param {number} [now] wall epoch ms
 */
export function getCurrentCooldownMs(user, teamFx, stage, now = Date.now()) {
  if (stage === "GRAND_FINAL") {
    return BASE_ACTION_COOLDOWN_SEC * 1000;
  }
  const sec = getEffectiveRecoverySec(user, teamFx, now);
  return sec * 1000;
}

/** Глобальное ускорение «Мстим за Альт Сезон» (бот speed): 1 с между пикселями для всех. */
export const GLOBAL_ALT_SEASON_PIXEL_COOLDOWN_SEC = 1;
export const GLOBAL_ALT_SEASON_PIXEL_COOLDOWN_MS = GLOBAL_ALT_SEASON_PIXEL_COOLDOWN_SEC * 1000;

/**
 * Активно ли окно «Мстим за Альт Сезон» по wall-epoch `mstimBurstUntilWallMs`.
 * На глобальной паузе: окно живо, если until > момента старта паузы (игровые часы заморожены).
 *
 * @param {{
 *   mstimBurstUntilWallMs: number;
 *   gamePaused: boolean;
 *   pauseWallStartedAtMs: number;
 *   wallNowMs: number;
 * }} p
 */
export function isAltSeasonMstimBurstWallActive(p) {
  const until = Math.trunc(Number(p.mstimBurstUntilWallMs));
  if (!Number.isFinite(until) || until < 1) return false;
  const pauseAt = Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(Number(p.pauseWallStartedAtMs)));
  if (p.gamePaused && Number.isFinite(pauseAt) && pauseAt > 0) {
    return until > pauseAt;
  }
  const wall = Number.isFinite(p.wallNowMs) ? p.wallNowMs : Date.now();
  return until > wall;
}

/**
 * Единственный авторитетный интервал между пикселями на сервере (мс).
 * Личные и командные баффы: `personalRecoveryUntil` / `teamRecoveryUntil` — всегда wall-epoch;
 * сравнение активности только с `wallNowMs` (реальный `Date.now()`), не с игровыми часами на паузе.
 * Глобальный «Мстим»: тот же `wallNowMs` + флаги паузы (см. isAltSeasonMstimBurstWallActive).
 *
 * @param {{
 *   user: { personalRecoveryUntil: number; personalRecoverySec: number };
 *   teamFx: { teamRecoveryUntil: number; teamRecoverySec: number };
 *   stage: TournamentStage;
 *   economyNowMs?: number;
 *   wallNowMs: number;
 *   mstimBurstUntilWallMs: number;
 *   gamePaused: boolean;
 *   pauseWallStartedAtMs: number;
 * }} p
 */
export function computeAuthoritativePixelPlacementCooldownMs(p) {
  const wallNowMs = Number.isFinite(p.wallNowMs) ? p.wallNowMs : Date.now();
  const mstim = isAltSeasonMstimBurstWallActive({
    mstimBurstUntilWallMs: p.mstimBurstUntilWallMs,
    gamePaused: !!p.gamePaused,
    pauseWallStartedAtMs: p.pauseWallStartedAtMs | 0,
    wallNowMs,
  });
  let ms = resolveAuthoritativePixelCooldownMs(mstim, p.user, p.teamFx, p.stage, wallNowMs);
  if (mstim && ms > GLOBAL_ALT_SEASON_PIXEL_COOLDOWN_MS + 50) {
    ms = GLOBAL_ALT_SEASON_PIXEL_COOLDOWN_MS;
  }
  return ms;
}

/**
 * Авторитетный интервал между пикселями в секундах (целые секунды, как в магазине 10/5/2/1).
 * Обёртка над {@link computeAuthoritativePixelPlacementCooldownMs}.
 */
export function getEffectivePixelPlacementCooldownSec(p) {
  return Math.trunc(computeAuthoritativePixelPlacementCooldownMs(p) / 1000);
}

/**
 * Единый авторитетный интервал между обычными пикселями (мс).
 * Правило модификаторов: глобальный speed (Мстим) → ровно 1 с; иначе min(15 с, личный бафф, командный бафф).
 *
 * @param {boolean} globalAltSeasonActive — из server: until mstim > Date.now()
 * @param {{ personalRecoveryUntil: number, personalRecoverySec: number }} user
 * @param {{ teamRecoveryUntil: number, teamRecoverySec: number }} teamFx
 * @param {TournamentStage} stage
 * @param {number} [now] wall epoch ms (Date.now() на сервере и клиенте)
 */
export function resolveAuthoritativePixelCooldownMs(globalAltSeasonActive, user, teamFx, stage, now = Date.now()) {
  if (globalAltSeasonActive) return GLOBAL_ALT_SEASON_PIXEL_COOLDOWN_MS;
  return getCurrentCooldownMs(user, teamFx, stage, now);
}

/**
 * Тот же расчёт, что и {@link resolveAuthoritativePixelCooldownMs} — единая точка входа по имени.
 * @param {{ globalSpeedActive: boolean, user: object, teamFx: object, stage: TournamentStage, nowMs: number }} p
 */
export function getAuthoritativePixelCooldownMs(p) {
  const { globalSpeedActive, user, teamFx, stage, nowMs } = p;
  return resolveAuthoritativePixelCooldownMs(globalSpeedActive, user, teamFx, stage, nowMs);
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
