/**
 * Центральная модель очков: победа по сумме getCellValue по занятым клеткам, не по «% карты».
 * @typedef {{ active?: boolean, kind?: string | null, until?: number, [k: string]: unknown }} GlobalEventState
 */

/**
 * @param {number} x
 * @param {number} y
 * @param {{
 *   roundIndex: number;
 *   gridW: number;
 *   gridH: number;
 *   landGrid: Uint8Array | null;
 *   baseValueGrid: Float32Array | null;
 *   globalEvent?: GlobalEventState | null;
 * }} ctx
 * @returns {number}
 */
export function getCellValue(x, y, ctx) {
  if (!ctx.landGrid || x < 0 || x >= ctx.gridW || y < 0 || y >= ctx.gridH) return 0;
  const i = y * ctx.gridW + x;
  if (ctx.landGrid[i] === 0) return 0;
  let base = 1;
  if (ctx.baseValueGrid && i < ctx.baseValueGrid.length) {
    const b = ctx.baseValueGrid[i];
    base = typeof b === "number" && Number.isFinite(b) && b > 0 ? b : 1;
  }
  let mult = 1;
  const ge = ctx.globalEvent;
  if (ge && ge.active && ge.kind === "golden_zone") {
    const gx0 = Number(ge.x0);
    const gy0 = Number(ge.y0);
    const gw = Number(ge.w);
    const gh = Number(ge.h);
    if (
      Number.isFinite(gx0) &&
      Number.isFinite(gy0) &&
      Number.isFinite(gw) &&
      Number.isFinite(gh) &&
      gw > 0 &&
      gh > 0 &&
      x >= gx0 &&
      x < gx0 + gw &&
      y >= gy0 &&
      y < gy0 + gh
    ) {
      mult *= 2;
    }
  }
  const ri = ctx.roundIndex | 0;
  if (ri >= 2) {
    const cx = (ctx.gridW - 1) / 2;
    const cy = (ctx.gridH - 1) / 2;
    const norm = (Math.abs(x - cx) + Math.abs(y - cy)) / Math.max(1, ctx.gridW + ctx.gridH);
    if (norm < 0.16) mult *= 1.25;
  }
  if (ri >= 1) {
    const edge = Math.min(x, y, ctx.gridW - 1 - x, ctx.gridH - 1 - y);
    const thresh = Math.max(2, Math.floor(Math.min(ctx.gridW, ctx.gridH) * 0.045));
    if (edge <= thresh) mult *= 0.75;
  }
  return base * mult;
}

/**
 * Сумма очков по всем играбельным клеткам при текущих правилах (знаменатель для «доли очков»).
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
 * Полный пересчёт: Map teamId -> { score, cells } только по текущему pixels.
 * @param {Map<string, unknown>} pixels
 * @param {(val: unknown) => number} pixelTeamFn
 * @param {Parameters<typeof getCellValue>[2]} ctx
 */
export function aggregateScoresFromPixels(pixels, pixelTeamFn, ctx) {
  /** @type {Map<number, { score: number; cells: number }>} */
  const byTeam = new Map();
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
    const v = getCellValue(px, py, ctx);
    if (v <= 0) continue;
    const cur = byTeam.get(tid) || { score: 0, cells: 0 };
    cur.score += v;
    cur.cells += 1;
    byTeam.set(tid, cur);
  }
  return byTeam;
}
