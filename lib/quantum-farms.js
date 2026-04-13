/**
 * Quantum Farms — контрольные точки 2×2 у центра карты, доход командой при доминировании по смежным клеткам.
 */

export const QUANTUM_FARM_COUNT = 8;
export const QUANTUM_FARM_SIZE = 2;
export const QUANTUM_FARM_TICK_MS = 5000;
/** Зазор между фермами (клетки), чтобы не слипались. */
export const QUANTUM_FARM_PLACE_GAP = 1;

/**
 * Пересечение расширенных прямоугольников 2×2 с зазором (как spawnRectsConflict, но размер S).
 * @param {number} g
 */
export function quantumFarmRectsConflict(x0, y0, ox0, oy0, S = QUANTUM_FARM_SIZE, g = QUANTUM_FARM_PLACE_GAP) {
  const ax0 = x0 - g;
  const ay0 = y0 - g;
  const ax1 = x0 + S + g - 1;
  const ay1 = y0 + S + g - 1;
  const bx0 = ox0 - g;
  const by0 = oy0 - g;
  const bx1 = ox0 + S + g - 1;
  const by1 = oy0 + S + g - 1;
  return !(ax1 < bx0 || bx1 < ax0 || ay1 < by0 || by1 < ay0);
}

/**
 * Все клетки влияния: 2×2 ферма + внешнее 8-соседство (до 4×4 в границах сетки).
 * @returns {string[]} ключи "x,y"
 */
export function getQuantumFarmInfluenceKeys(x0, y0, gridW, gridH) {
  const keys = [];
  const xMin = Math.max(0, x0 - 1);
  const yMin = Math.max(0, y0 - 1);
  const xMax = Math.min(gridW - 1, x0 + QUANTUM_FARM_SIZE);
  const yMax = Math.min(gridH - 1, y0 + QUANTUM_FARM_SIZE);
  for (let y = yMin; y <= yMax; y++) {
    for (let x = xMin; x <= xMax; x++) {
      keys.push(`${x},${y}`);
    }
  }
  return keys;
}

/**
 * Подсчёт очков команд: число закрашенных клеток команды в зоне влияния (включая клетки 2×2 фермы).
 * @param {(key: string) => number} pixelTeamFn teamId или 0
 * @returns {Map<number, number>}
 */
export function scoreTeamsAroundFarm(x0, y0, gridW, gridH, pixelTeamFn) {
  const keys = getQuantumFarmInfluenceKeys(x0, y0, gridW, gridH);
  /** @type {Map<number, number>} */
  const scores = new Map();
  for (let i = 0; i < keys.length; i++) {
    const tid = pixelTeamFn(keys[i]) | 0;
    if (!tid) continue;
    scores.set(tid, (scores.get(tid) | 0) + 1);
  }
  return scores;
}

/**
 * Владелец: команда с максимальным числом клеток в зоне; при ничьей на максимуме — спор (owner 0).
 * @returns {{ owner: number, contested: boolean, topScore: number }}
 */
export function resolveFarmControl(scores) {
  if (!scores.size) return { owner: 0, contested: false, topScore: 0 };
  let maxN = 0;
  for (const n of scores.values()) maxN = Math.max(maxN, n | 0);
  if (maxN < 1) return { owner: 0, contested: false, topScore: 0 };
  /** @type {number[]} */
  const leaders = [];
  for (const [tid, n] of scores) {
    if ((n | 0) === maxN) leaders.push(tid | 0);
  }
  if (leaders.length > 1) return { owner: 0, contested: true, topScore: maxN };
  return { owner: leaders[0] | 0, contested: false, topScore: maxN };
}

/** @returns {number} teamId или 0 */
export function pickFarmOwnerFromScores(scores) {
  return resolveFarmControl(scores).owner;
}

/**
 * Разместить до QUANTUM_FARM_COUNT ферм 2×2 на playable суши, ближе к центру первыми.
 * @param {Uint8Array | null} playableGrid
 * @param {number} gridW
 * @param {number} gridH
 * @returns {{ id: number, x0: number, y0: number, w: number, h: number }[]}
 */
export function computeQuantumFarmLayouts(playableGrid, gridW, gridH) {
  if (!playableGrid || playableGrid.length !== gridW * gridH) return [];

  function rectPlayable(px0, py0) {
    for (let dy = 0; dy < QUANTUM_FARM_SIZE; dy++) {
      for (let dx = 0; dx < QUANTUM_FARM_SIZE; dx++) {
        const x = px0 + dx;
        const y = py0 + dy;
        if (x < 0 || x >= gridW || y < 0 || y >= gridH) return false;
        if (playableGrid[y * gridW + x] === 0) return false;
      }
    }
    return true;
  }

  const cx = gridW * 0.5;
  const cy = gridH * 0.5;
  /** @type {{ x0: number, y0: number, d: number }[]} */
  const cands = [];
  for (let y0 = 0; y0 <= gridH - QUANTUM_FARM_SIZE; y0++) {
    for (let x0 = 0; x0 <= gridW - QUANTUM_FARM_SIZE; x0++) {
      if (!rectPlayable(x0, y0)) continue;
      const mx = x0 + (QUANTUM_FARM_SIZE - 1) * 0.5;
      const my = y0 + (QUANTUM_FARM_SIZE - 1) * 0.5;
      const d = (mx - cx) * (mx - cx) + (my - cy) * (my - cy);
      cands.push({ x0, y0, d });
    }
  }
  cands.sort((a, b) => a.d - b.d);

  /** @type {{ x0: number, y0: number }[]} */
  const picked = [];
  for (let i = 0; i < cands.length && picked.length < QUANTUM_FARM_COUNT; i++) {
    const { x0, y0 } = cands[i];
    let clash = false;
    for (let p = 0; p < picked.length; p++) {
      const o = picked[p];
      if (quantumFarmRectsConflict(x0, y0, o.x0, o.y0)) {
        clash = true;
        break;
      }
    }
    if (!clash) picked.push({ x0, y0 });
  }

  return picked.map((p, idx) => ({
    id: idx + 1,
    x0: p.x0,
    y0: p.y0,
    w: QUANTUM_FARM_SIZE,
    h: QUANTUM_FARM_SIZE,
  }));
}
