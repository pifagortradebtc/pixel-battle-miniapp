import {
  MAX_CELL_SCORE,
  pointInRect,
  roundProgressionMultiplierForCell,
  tournamentCompressionMultiplierForCell,
} from "./battle-events.js";

/**
 * @typedef {import("./battle-events.js").BattleScoringSnapshot} BattleScoringSnapshot
 */

/**
 * @typedef {{
 *   roundIndex: number;
 *   gridW: number;
 *   gridH: number;
 *   landGrid: Uint8Array | null;
 *   baseValueGrid: Float32Array | null;
 *   battle: BattleScoringSnapshot | null;
 *   synergyMultByTeamId?: Map<number, number> | null;
 * }} GameScoreState
 */

/**
 * Центральная функция: очки с клетки (без командной синергии — она в aggregateScoresFromPixels).
 * Порядок: base × compression × gold × economic × фаза раунда, затем cap.
 *
 * @param {number} x
 * @param {number} y
 * @param {GameScoreState} gameState
 * @returns {number}
 */
export function getCellValue(x, y, gameState) {
  if (!gameState.landGrid || x < 0 || x >= gameState.gridW || y < 0 || y >= gameState.gridH) return 0;
  const i = y * gameState.gridW + x;
  if (gameState.landGrid[i] === 0) return 0;

  let base = 1;
  if (gameState.baseValueGrid && i < gameState.baseValueGrid.length) {
    const b = gameState.baseValueGrid[i];
    base = typeof b === "number" && Number.isFinite(b) && b > 0 ? b : 1;
  }

  const battle = gameState.battle;
  let compression = 1;
  if (battle?.mapCompression) {
    compression *= tournamentCompressionMultiplierForCell(
      x,
      y,
      gameState.gridW,
      gameState.gridH,
      battle.mapCompression
    );
  }

  let goldM = 1;
  if (battle?.goldRect && pointInRect(x, y, battle.goldRect)) {
    goldM = 2;
  }

  let econM = 1;
  const rects = battle?.economicRects;
  if (rects && rects.length) {
    for (let k = 0; k < rects.length; k++) {
      const r = rects[k];
      if (pointInRect(x, y, r)) econM *= r.mult;
    }
  }

  const roundM = roundProgressionMultiplierForCell(x, y, gameState.roundIndex, gameState.gridW, gameState.gridH);

  let v = base * compression * goldM * econM * roundM;
  if (!Number.isFinite(v) || v < 0) v = 0;
  return Math.min(MAX_CELL_SCORE, v);
}

/**
 * @param {GameScoreState} ctx
 */
export function computeTotalAvailableScore(ctx) {
  if (!ctx.landGrid) return 0;
  let s = 0;
  for (let y = 0; y < ctx.gridH; y++) {
    for (let x = 0; x < ctx.gridW; x++) {
      s += getCellValue(x, y, ctx);
    }
  }
  return s;
}

/**
 * @param {Map<string, unknown>} pixels
 * @param {(val: unknown) => number} pixelTeamFn
 * @param {GameScoreState} ctx
 */
export function aggregateScoresFromPixels(pixels, pixelTeamFn, ctx) {
  /** @type {Map<number, { score: number; cells: number }>} */
  const byTeam = new Map();
  const syn = ctx.synergyMultByTeamId;
  for (const [key, val] of pixels.entries()) {
    const parts = key.split(",");
    const px = Number(parts[0]);
    const py = Number(parts[1]);
    if (
      !Number.isFinite(px) ||
      !Number.isFinite(py) ||
      px < 0 ||
      px >= ctx.gridW ||
      py < 0 ||
      py >= ctx.gridH
    ) {
      continue;
    }
    const tid = pixelTeamFn(val) | 0;
    if (!tid) continue;
    let v = getCellValue(px, py, ctx);
    if (v <= 0) continue;
    const sm = syn && syn.has(tid) ? syn.get(tid) || 1 : 1;
    if (sm !== 1) {
      v *= sm;
      const cap = MAX_CELL_SCORE * Math.min(sm, 1.15);
      if (v > cap) v = cap;
    }
    const cur = byTeam.get(tid) || { score: 0, cells: 0 };
    cur.score += v;
    cur.cells += 1;
    byTeam.set(tid, cur);
  }
  return byTeam;
}
