/**
 * Масштаб турнирного времени (только тест, бот `speed`):
 * сжимает на **реальной** оси только турнирный таймлайн — разминка, фаза боя, конец раунда, мета/UI.
 *
 * Не ускоряет и не привязывает к scale: кулдауны пикселей/покупок, реген HP базы,
 * лимиты ударов по флагу, `lastActionAt`, tiebreak по `Date.now()`, WebSocket, VFX.
 *
 * Включение захвата базы после доли раунда считается по **реальным** миллисекундам внутри
 * уже сжатого окна боя (то же окно, что и `getRoundBattleEndRealMs`), без дополнительного ×scale.
 */

export const TOURNAMENT_TIME_SCALE_DEFAULT = 1;
/** Защита от опечаток (×86400 ≈ 1 реальная сек = 1 игровой сутки). */
export const TOURNAMENT_TIME_SCALE_MAX = 86400;

/**
 * @param {unknown} s
 * @returns {number}
 */
export function clampTournamentTimeScale(s) {
  const n = Number(s);
  if (!Number.isFinite(n) || n < 1) return TOURNAMENT_TIME_SCALE_DEFAULT;
  return Math.min(TOURNAMENT_TIME_SCALE_MAX, Math.floor(n));
}

/**
 * Сохранить позицию на игровой шкале при смене scale: пересчёт roundStartMs.
 * @param {number} nowReal
 * @param {number} roundStartMs
 * @param {number} oldScale
 * @param {number} newScale
 */
export function reanchorRoundStartForScaleChange(nowReal, roundStartMs, oldScale, newScale) {
  const o = oldScale >= 1 ? oldScale : TOURNAMENT_TIME_SCALE_DEFAULT;
  const n = newScale >= 1 ? newScale : TOURNAMENT_TIME_SCALE_DEFAULT;
  const gameElapsed = (nowReal - roundStartMs) * o;
  return nowReal - gameElapsed / n;
}
