/**
 * Турнирные стадии и экономика: один базовый интервал между действиями + временные баффы.
 */

/** @typedef {'MASS_BATTLE'|'SEMI_FINAL'|'FINAL'|'DUEL'|'GRAND_FINAL'} TournamentStage */

/** Единственная база: время между ручными постановками пикселя (сек). */
export const BASE_ACTION_COOLDOWN_SEC = 20;

export const MIN_COOLDOWN_SEC = 5;

/** Личный бафф «быстрее восстановление»: −50% к интервалу (20 с → 10 с). */
export const RECOVERY_BOOST_COOLDOWN_MULT = 0.5;

/** Командный бафф: −30% к интервалу (20 с → 14 с). */
export const TEAM_RECOVERY_COOLDOWN_MULT = 0.7;

/**
 * Цены в USDT; в UI: ×7 = Тугры.
 */
export const PRICES = {
  recoveryBoost: 5,
  shieldPixel: 2,
  lineCapture: 10,
  /** Мгновенный захват сетки 4×4 */
  zoneCapture: 20,
  /** Мгновенный захват области 5×5 */
  massCapture: 30,
  /** Командный интервал короче для всех */
  teamRecoveryBoost: 25,
  /** Командная защитная зона 4×4 */
  teamShieldZone: 20,
};

export const DURATIONS_MS = {
  recoveryBoost: 10 * 60 * 1000,
  shieldPixel: 60 * 1000,
  teamRecoveryBoost: 2 * 60 * 1000,
  teamShieldZone: 30 * 1000,
};

/** Интервал между использованиями «линия» (отдельно от базового хода). */
export const LINE_CAPTURE_COOLDOWN_MS = 15 * 1000;

/** Интервал между зонами 4×4. */
export const ZONE_CAPTURE_COOLDOWN_MS = 60 * 1000;

/** Интервал между масс-захватами 6×6. */
export const MASS_CAPTURE_COOLDOWN_MS = 120 * 1000;

/**
 * «Окно битвы»: базовый интервал × множитель → при базе 20 с получается 12 с.
 * (см. GLOBAL_BATTLE_WINDOW_COOLDOWN_SEC)
 */
export const GLOBAL_EVENT_COOLDOWN_MULT = 12 / 20;

/** Целевая длительность интервала во время глобального события (сек), для подсказок. */
export const GLOBAL_BATTLE_WINDOW_COOLDOWN_SEC = 12;

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

/**
 * @param {TournamentStage} stage
 * @param {string} feature
 */
export function stageAllows(stage, feature) {
  if (stage === "GRAND_FINAL" || stage === "DUEL") return false;
  if (stage === "FINAL") {
    return feature === "recovery_boost" || feature === "shield_pixel" || feature === "team_recovery_boost";
  }
  if (stage === "SEMI_FINAL") {
    if (
      feature === "line_capture" ||
      feature === "mass_capture" ||
      feature === "zone_capture" ||
      feature === "team_shield_zone"
    ) {
      return false;
    }
    return true;
  }
  return true;
}

/**
 * @param {{
 *   recoveryBoostUntil: number,
 * }} user
 * @param {{
 *   teamRecoveryUntil: number,
 * }} teamFx
 * @param {TournamentStage} stage
 * @param {number} now
 * @param {{ eventCooldownMult?: number }} [modifiers]
 */
export function getCurrentCooldownMs(user, teamFx, stage, now = Date.now(), modifiers = {}) {
  let sec = BASE_ACTION_COOLDOWN_SEC;

  if (stageAllows(stage, "recovery_boost") && user.recoveryBoostUntil > now) {
    sec *= RECOVERY_BOOST_COOLDOWN_MULT;
  }
  if (stageAllows(stage, "team_recovery_boost") && teamFx.teamRecoveryUntil > now) {
    sec *= TEAM_RECOVERY_COOLDOWN_MULT;
  }

  sec = Math.max(MIN_COOLDOWN_SEC, sec);
  let ms = Math.round(sec * 1000);
  const ev = modifiers.eventCooldownMult;
  if (typeof ev === "number" && ev > 0 && ev <= 2) {
    ms = Math.round(ms * ev);
  }
  return ms;
}
