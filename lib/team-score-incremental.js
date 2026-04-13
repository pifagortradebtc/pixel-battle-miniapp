import { aggregateScoresFromPixels, pixelScoreContributionForAggregate } from "./scoring.js";

/**
 * Заполнить M (число учитываемых клеток) и S (сумма v по ним) из полного агрегата.
 * score в табло = M * S, как в aggregateScoresFromPixels.
 *
 * @param {Map<number, { score: number, cells: number }>} agg
 * @param {Map<number, number>} mass
 * @param {Map<number, number>} sumV
 */
export function fillMassSumFromAggregate(agg, mass, sumV) {
  mass.clear();
  sumV.clear();
  for (const [tid, a] of agg) {
    const cells = a.cells | 0;
    if (cells <= 0) continue;
    const S = a.score / cells;
    mass.set(tid, cells);
    sumV.set(tid, S);
  }
}

/**
 * Полный пересчёт M/S из карты пикселей (без доступа к server state).
 *
 * @param {Map<string, unknown>} pixels
 * @param {(val: unknown) => number} pixelTeamFn
 * @param {import("./scoring.js").GameScoreState} ctx
 * @param {Map<number, number>} mass
 * @param {Map<number, number>} sumV
 */
export function rebuildMassSumFromPixels(pixels, pixelTeamFn, ctx, mass, sumV) {
  const agg = aggregateScoresFromPixels(pixels, pixelTeamFn, ctx);
  fillMassSumFromAggregate(agg, mass, sumV);
}

/**
 * Один шаг инкрементального обновления (один pixels.set на клетку).
 * Мутирует mass / sumV. При рассинхроне возвращает invalidate — вызывающий должен сбросить кэш.
 *
 * @param {number} x
 * @param {number} y
 * @param {unknown} prevVal
 * @param {unknown} nextVal
 * @param {import("./scoring.js").GameScoreState} ctx
 * @param {(val: unknown) => number} pixelTeamFn
 * @param {Map<number, number>} mass
 * @param {Map<number, number>} sumV
 * @returns {'applied' | 'invalidate'}
 */
export function applyIncrementalTeamScorePixelStep(x, y, prevVal, nextVal, ctx, pixelTeamFn, mass, sumV) {
  const xi = x | 0;
  const yi = y | 0;
  if (!ctx?.landGrid) return "applied";
  if (xi < 0 || xi >= ctx.gridW || yi < 0 || yi >= ctx.gridH) return "applied";

  const rem =
    prevVal != null && pixelTeamFn(prevVal)
      ? pixelScoreContributionForAggregate(xi, yi, prevVal, ctx, pixelTeamFn)
      : null;
  const add =
    nextVal != null && pixelTeamFn(nextVal)
      ? pixelScoreContributionForAggregate(xi, yi, nextVal, ctx, pixelTeamFn)
      : null;

  const subTeam = (tid, v) => {
    let M = mass.get(tid) | 0;
    if (M < 1) return false;
    let S = sumV.get(tid) || 0;
    M -= 1;
    S -= v;
    if (M <= 0) {
      mass.delete(tid);
      sumV.delete(tid);
    } else {
      mass.set(tid, M);
      sumV.set(tid, S);
    }
    return true;
  };
  const addTeam = (tid, v) => {
    let M = mass.get(tid) | 0;
    let S = sumV.get(tid) || 0;
    M += 1;
    S += v;
    mass.set(tid, M);
    sumV.set(tid, S);
    return true;
  };

  if (rem && !subTeam(rem.tid, rem.v)) return "invalidate";
  if (add && !addTeam(add.tid, add.v)) return "invalidate";
  return "applied";
}

/**
 * Собрать агрегат очков из кэша M/S (как в buildStatsPayload на сервере).
 *
 * @param {Map<number, number>} mass
 * @param {Map<number, number>} sumV
 * @returns {Map<number, { score: number, cells: number }>}
 */
export function aggregateFromMassSumCache(mass, sumV) {
  /** @type {Map<number, { score: number, cells: number }>} */
  const agg = new Map();
  for (const tid of mass.keys()) {
    const M = mass.get(tid) | 0;
    const S = sumV.get(tid) || 0;
    if (M <= 0) continue;
    agg.set(tid, { score: M * S, cells: M });
  }
  return agg;
}

/**
 * Сравнить два агрегата (score, cells) с допуском на float.
 *
 * @param {Map<number, { score: number, cells: number }>} a
 * @param {Map<number, { score: number, cells: number }>} b
 * @param {number} [eps]
 * @returns {boolean}
 */
export function aggregatesEqual(a, b, eps = 1e-6) {
  if (a.size !== b.size) return false;
  for (const [tid, av] of a) {
    const bv = b.get(tid);
    if (!bv) return false;
    if ((av.cells | 0) !== (bv.cells | 0)) return false;
    if (Math.abs(av.score - bv.score) > eps) return false;
  }
  return true;
}
