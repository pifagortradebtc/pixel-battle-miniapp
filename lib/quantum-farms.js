/**
 * Quantum Farms — 8 узлов 2×2 на центральном острове (связная суша от центра карты).
 * В каждом из 8 секторов от центра масс острова — позиция ближе к «берегу» (к воде),
 * среди таких — как можно дальше от центра, чтобы узлы легли по периметру, а не кучей в середине.
 * Доход: доминирование в зоне влияния вокруг 2×2.
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
 * Разместить до QUANTUM_FARM_COUNT ферм 2×2 на связном «центральном острове» (BFS от центра карты):
 * глубина от берега (шаги к воде) + 8 секторов от центра масс; в секторе сортировка: меньше глубина,
 * больше расстояние от центра. Недостающие — та же сортировка с учётом конфликтов.
 * @param {Uint8Array | null} playableGrid
 * @param {number} gridW
 * @param {number} gridH
 * @returns {{ id: number, x0: number, y0: number, w: number, h: number }[]}
 */
export function computeQuantumFarmLayouts(playableGrid, gridW, gridH) {
  if (!playableGrid || playableGrid.length !== gridW * gridH) return [];

  const idx = (x, y) => y * gridW + x;

  function rectOnIsland(px0, py0, islandMask) {
    for (let dy = 0; dy < QUANTUM_FARM_SIZE; dy++) {
      for (let dx = 0; dx < QUANTUM_FARM_SIZE; dx++) {
        const x = px0 + dx;
        const y = py0 + dy;
        if (x < 0 || x >= gridW || y < 0 || y >= gridH) return false;
        const i = idx(x, y);
        if (playableGrid[i] === 0 || islandMask[i] === 0) return false;
      }
    }
    return true;
  }

  let sx = Math.floor(gridW * 0.5);
  let sy = Math.floor(gridH * 0.5);
  let foundStart = playableGrid[idx(sx, sy)] !== 0;
  if (!foundStart) {
    const maxR = Math.max(gridW, gridH);
    outer: for (let r = 1; r < maxR; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const x = sx + dx;
          const y = sy + dy;
          if (x < 0 || x >= gridW || y < 0 || y >= gridH) continue;
          if (playableGrid[idx(x, y)] !== 0) {
            sx = x;
            sy = y;
            foundStart = true;
            break outer;
          }
        }
      }
    }
  }
  if (!foundStart) return [];

  const islandMask = new Uint8Array(gridW * gridH);
  /** @type {number[]} */
  const stack = [sx, sy];
  islandMask[idx(sx, sy)] = 1;
  let sumX = 0;
  let sumY = 0;
  let nIsland = 0;
  while (stack.length) {
    const y = stack.pop();
    const x = stack.pop();
    sumX += x;
    sumY += y;
    nIsland++;
    const neigh = [
      x + 1,
      y,
      x - 1,
      y,
      x,
      y + 1,
      x,
      y - 1,
    ];
    for (let ni = 0; ni < neigh.length; ni += 2) {
      const nx = neigh[ni];
      const ny = neigh[ni + 1];
      if (nx < 0 || nx >= gridW || ny < 0 || ny >= gridH) continue;
      const ii = idx(nx, ny);
      if (islandMask[ii] || playableGrid[ii] === 0) continue;
      islandMask[ii] = 1;
      stack.push(nx, ny);
    }
  }
  if (nIsland < QUANTUM_FARM_SIZE * QUANTUM_FARM_SIZE) return [];

  /** Глубина внутрь острова: 0 у клетки на «берегу» (сосед с водой/вне острова), дальше больше. */
  const INF = 1_000_000;
  const inward = new Int32Array(gridW * gridH);
  /** @type {number[]} */
  const shoreQ = [];
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      const i = idx(x, y);
      if (!islandMask[i]) {
        inward[i] = -1;
        continue;
      }
      inward[i] = INF;
      let coast = false;
      if (x === 0 || x === gridW - 1 || y === 0 || y === gridH - 1) coast = true;
      else {
        if (!islandMask[idx(x + 1, y)] || !islandMask[idx(x - 1, y)] || !islandMask[idx(x, y + 1)] || !islandMask[idx(x, y - 1)])
          coast = true;
      }
      if (coast) {
        inward[i] = 0;
        shoreQ.push(x, y);
      }
    }
  }
  for (let qi = 0; qi < shoreQ.length; qi += 2) {
    const x = shoreQ[qi];
    const y = shoreQ[qi + 1];
    const base = inward[idx(x, y)];
    const neigh = [x + 1, y, x - 1, y, x, y + 1, x, y - 1];
    for (let ni = 0; ni < neigh.length; ni += 2) {
      const nx = neigh[ni];
      const ny = neigh[ni + 1];
      if (nx < 0 || nx >= gridW || ny < 0 || ny >= gridH) continue;
      const ii = idx(nx, ny);
      if (!islandMask[ii]) continue;
      const nd = base + 1;
      if (nd < inward[ii]) {
        inward[ii] = nd;
        shoreQ.push(nx, ny);
      }
    }
  }

  const cx = sumX / nIsland;
  const cy = sumY / nIsland;

  function rectMinInward(px0, py0) {
    let m = INF;
    for (let dy = 0; dy < QUANTUM_FARM_SIZE; dy++) {
      for (let dx = 0; dx < QUANTUM_FARM_SIZE; dx++) {
        const v = inward[idx(px0 + dx, py0 + dy)];
        if (v < m) m = v;
      }
    }
    return m;
  }

  /** @type {{ x0: number, y0: number, d: number, sector: number, minIn: number }[]} */
  const cands = [];
  for (let y0 = 0; y0 <= gridH - QUANTUM_FARM_SIZE; y0++) {
    for (let x0 = 0; x0 <= gridW - QUANTUM_FARM_SIZE; x0++) {
      if (!rectOnIsland(x0, y0, islandMask)) continue;
      const mx = x0 + (QUANTUM_FARM_SIZE - 1) * 0.5;
      const my = y0 + (QUANTUM_FARM_SIZE - 1) * 0.5;
      const dx = mx - cx;
      const dy = my - cy;
      const d = dx * dx + dy * dy;
      let angle = Math.atan2(dy, dx);
      if (angle < 0) angle += 2 * Math.PI;
      let sector = Math.floor((angle + Math.PI / 8) / (Math.PI / 4));
      if (sector >= QUANTUM_FARM_COUNT) sector = QUANTUM_FARM_COUNT - 1;
      const minIn = rectMinInward(x0, y0);
      cands.push({ x0, y0, d, sector, minIn });
    }
  }
  if (!cands.length) return [];

  /** @type {Map<number, { x0: number, y0: number, d: number, minIn: number }[]>} */
  const bySector = new Map();
  for (let s = 0; s < QUANTUM_FARM_COUNT; s++) bySector.set(s, []);
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    const arr = bySector.get(c.sector);
    if (arr) arr.push({ x0: c.x0, y0: c.y0, d: c.d, minIn: c.minIn });
  }

  /** @type {{ x0: number, y0: number }[]} */
  const picked = [];

  function tryPickFromSector(s) {
    const arr = bySector.get(s);
    if (!arr || !arr.length) return;
    arr.sort((a, b) => a.minIn - b.minIn || b.d - a.d);
    for (let i = 0; i < arr.length; i++) {
      const { x0, y0 } = arr[i];
      let clash = false;
      for (let p = 0; p < picked.length; p++) {
        const o = picked[p];
        if (quantumFarmRectsConflict(x0, y0, o.x0, o.y0)) {
          clash = true;
          break;
        }
      }
      if (!clash) {
        picked.push({ x0, y0 });
        return;
      }
    }
  }

  for (let s = 0; s < QUANTUM_FARM_COUNT; s++) tryPickFromSector(s);

  if (picked.length < QUANTUM_FARM_COUNT) {
    const byDist = cands.slice().sort((a, b) => a.minIn - b.minIn || b.d - a.d);
    for (let i = 0; i < byDist.length && picked.length < QUANTUM_FARM_COUNT; i++) {
      const { x0, y0 } = byDist[i];
      let dup = false;
      for (let p = 0; p < picked.length; p++) {
        if (picked[p].x0 === x0 && picked[p].y0 === y0) {
          dup = true;
          break;
        }
      }
      if (dup) continue;
      let clash = false;
      for (let p = 0; p < picked.length; p++) {
        if (quantumFarmRectsConflict(x0, y0, picked[p].x0, picked[p].y0)) {
          clash = true;
          break;
        }
      }
      if (!clash) picked.push({ x0, y0 });
    }
  }

  return picked.map((p, i) => ({
    id: i + 1,
    x0: p.x0,
    y0: p.y0,
    w: QUANTUM_FARM_SIZE,
    h: QUANTUM_FARM_SIZE,
  }));
}
