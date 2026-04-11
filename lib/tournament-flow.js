/**
 * Длительность разминки перед боем в каждом раунде (мс).
 */
export const WARMUP_MS = 2 * 60 * 1000;

/**
 * Длительность фазы боя после разминки по индексу раунда 0..3 (мс).
 * 0 — массовый, 1 — команды до 10, 2 — пары, 3 — дуэль 1v1.
 */
export const ROUND_BATTLE_DURATION_MS = [
  8 * 60 * 60 * 1000, // 8 h
  5 * 60 * 60 * 1000, // 5 h
  4 * 60 * 60 * 1000, // 4 h
  75 * 60 * 1000, // 75 min
];

/** @deprecated используйте DUEL_INSTANT_WIN_SCORE_SHARE — порог по доле очков, не по карте */
export const DUEL_INSTANT_WIN_PERCENT = 60;

/** В дуэли 1v1 — мгновенная победа при доле суммарно доступных очков ≥ этого значения (0..1) */
export const DUEL_INSTANT_WIN_SCORE_SHARE = 0.6;

export function battleDurationForRound(roundIndex) {
  const i = Math.min(Math.max(roundIndex | 0, 0), 3);
  return ROUND_BATTLE_DURATION_MS[i] ?? ROUND_BATTLE_DURATION_MS[0];
}
