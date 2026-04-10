/**
 * Турнирные стадии, кулдауны и цены (сервер — источник истины).
 */

/** @typedef {'MASS_BATTLE'|'SEMI_FINAL'|'FINAL'|'DUEL'|'GRAND_FINAL'} TournamentStage */

/** Цены уровней — в USDT. */
export const COOLDOWN_LEVELS = [
  { level: 0, sec: 30, price: 0 },
  { level: 1, sec: 28, price: 5 },
  { level: 2, sec: 25, price: 12 },
  { level: 3, sec: 22, price: 25 },
  { level: 4, sec: 18, price: 50 },
  { level: 5, sec: 15, price: 90 },
  { level: 6, sec: 12, price: 150 },
  { level: 7, sec: 10, price: 250 },
  { level: 8, sec: 8, price: 400 },
  { level: 9, sec: 6, price: 700 },
  { level: 10, sec: 5, price: 1000 },
];

export const MAX_COOLDOWN_LEVEL = 10;
export const MIN_COOLDOWN_SEC = 5;

/** Все значения — в USDT (внутриигровой баланс = USDT). */
export const PRICES = {
  speedBoost: 10,
  shieldPixel: 3,
  lineCapture: 20,
  teamBoost: 50,
  raidBoost: 80,
  teamShieldZone: 70,
};

export const DURATIONS_MS = {
  speedBoost: 10 * 60 * 1000,
  shieldPixel: 20 * 1000,
  teamBoost: 5 * 60 * 1000,
  raidBoost: 2 * 60 * 1000,
  teamShieldZone: 30 * 1000,
};

export const LINE_CAPTURE_COOLDOWN_MS = 5 * 60 * 1000;

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
    return feature === "cooldown_upgrade" || feature === "shield_pixel";
  }
  if (stage === "SEMI_FINAL") {
    if (feature === "line_capture" || feature === "raid_boost" || feature === "team_shield_zone") return false;
    return true;
  }
  /* MASS_BATTLE: всё платное по таблице */
  return true;
}

/**
 * @param {{ cooldownUpgradeLevel: number, speedBoostUntil: number }} user
 * @param {{ teamBoostUntil: number, raidBoostUntil: number }} teamFx
 * @param {TournamentStage} stage
 * @param {number} now
 */
export function getCurrentCooldownMs(user, teamFx, stage, now = Date.now()) {
  const lvl = Math.min(
    MAX_COOLDOWN_LEVEL,
    Math.max(0, user.cooldownUpgradeLevel | 0)
  );
  const row = COOLDOWN_LEVELS[lvl] || COOLDOWN_LEVELS[0];
  let sec = row.sec;

  if (stageAllows(stage, "personal_speed") && user.speedBoostUntil > now) {
    sec *= 0.8;
  }
  if (stageAllows(stage, "team_boost") && teamFx.teamBoostUntil > now) {
    sec *= 0.9;
  }
  if (stageAllows(stage, "raid_boost") && teamFx.raidBoostUntil > now) {
    sec *= 0.75;
  }

  sec = Math.max(MIN_COOLDOWN_SEC, sec);
  return Math.round(sec * 1000);
}

export function baseCooldownSecFromLevel(level) {
  const row = COOLDOWN_LEVELS[Math.min(MAX_COOLDOWN_LEVEL, Math.max(0, level | 0))];
  return row ? row.sec : 30;
}

export function upgradePriceForNextLevel(currentLevel) {
  const next = (currentLevel | 0) + 1;
  if (next > MAX_COOLDOWN_LEVEL) return null;
  const row = COOLDOWN_LEVELS[next];
  return row ? row.price : null;
}
