/**
 * Quantum Farms — 8 узлов 2×2 на главном острове (BFS от центра карты).
 * Цель дизайна: все фермы в плотном «квантоцентре» у геометрического центра карты, чтобы игроки
 * обязаны спорить за них в середине поля (не на периферии). Жадный выбор разносит якоря,
 * но штраф за r² тянет кластер к центру.
 */

export const QUANTUM_FARM_COUNT = 8;
export const QUANTUM_FARM_SIZE = 2;
export const QUANTUM_FARM_TICK_MS = 5000;
/** Зазор между фермами (клетки), чтобы не слипались. */
export const QUANTUM_FARM_PLACE_GAP = 1;

/** Доля minDim: микро-дыра у самого центра (избегаем одной точки). */
const CENTRAL_RING_MIN_FRAC = 0.02;
/** Внешний радиус «квантоцентра» — узкий диск, чтобы все 8 целей тянули игроков в середину. */
const CENTRAL_RING_MAX_FRAC_INITIAL = 0.15;
/** Пошаговое расширение только если не хватает валидных клеток суши. */
const CENTRAL_RING_MAX_FRAC_STEPS = [0.2, 0.26, 0.32];
/** Отступ от края сетки — фермы не у края мира. */
const CENTRAL_EDGE_MARGIN_FRAC = 0.035;
const CENTRAL_EDGE_MARGIN_MIN = 5;
/** Мин. расстояние между центрами 2×2 (клетки² в проверке), чуть мягче при малом диске. */
const CENTRAL_MIN_CENTER_SEP_FRAC = 0.025;
const CENTRAL_MIN_CENTER_SEP_MIN = 8;
/**
 * Вес штрафа за r² при выборе следующей фермы (жадно: разнести, но сильнее тянуть к центру карты).
 * Чем больше λ, тем плотнее кластер к середине при равном разнесении.
 */
const CENTRAL_INWARD_BIAS_LAMBDA = 0.028;

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
 * Разместить до QUANTUM_FARM_COUNT ферм 2×2 на главном острове (BFS от центра карты).
 * Фокус — геометрический центр карты: кольцо [minR, maxR], равномерное разрежение (max-min дистанция),
 * без периметрального «ближе к воде» приоритета. При нехватке точек maxR поэтапно расширяется.
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
  let nIsland = 0;
  while (stack.length) {
    const y = stack.pop();
    const x = stack.pop();
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

  const minDim = Math.min(gridW, gridH);
  /** Геометрический центр карты (объектив «центра поля боя»). */
  const mapCx = (gridW - 1) * 0.5;
  const mapCy = (gridH - 1) * 0.5;

  const edgeMargin = Math.max(CENTRAL_EDGE_MARGIN_MIN, Math.floor(minDim * CENTRAL_EDGE_MARGIN_FRAC));
  const minCenterSep = Math.max(
    CENTRAL_MIN_CENTER_SEP_MIN,
    Math.floor(minDim * CENTRAL_MIN_CENTER_SEP_FRAC)
  );
  const minCenterSepSq = minCenterSep * minCenterSep;

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

  function rectCenter(x0, y0) {
    return { mx: x0 + (QUANTUM_FARM_SIZE - 1) * 0.5, my: y0 + (QUANTUM_FARM_SIZE - 1) * 0.5 };
  }

  function dist2(ax, ay, bx, by) {
    const dx = ax - bx;
    const dy = ay - by;
    return dx * dx + dy * dy;
  }

  /**
   * @param {number} maxRFrac
   * @returns {{ x0: number, y0: number, mx: number, my: number, r2: number, minIn: number }[]}
   */
  function collectCentralCandidates(maxRFrac) {
    const minR = minDim * CENTRAL_RING_MIN_FRAC;
    const maxR = minDim * maxRFrac;
    const minR2 = minR * minR;
    const maxR2 = maxR * maxR;
    const xHi = gridW - QUANTUM_FARM_SIZE;
    const yHi = gridH - QUANTUM_FARM_SIZE;
    /** @type {{ x0: number, y0: number, mx: number, my: number, r2: number, minIn: number }[]} */
    const out = [];
    for (let y0 = edgeMargin; y0 <= yHi - edgeMargin; y0++) {
      for (let x0 = edgeMargin; x0 <= xHi - edgeMargin; x0++) {
        if (!rectOnIsland(x0, y0, islandMask)) continue;
        const { mx, my } = rectCenter(x0, y0);
        const r2 = dist2(mx, my, mapCx, mapCy);
        if (r2 < minR2 || r2 > maxR2) continue;
        const minIn = rectMinInward(x0, y0);
        if (minIn < 1) continue;
        out.push({ x0, y0, mx, my, r2, minIn });
      }
    }
    return out;
  }

  /**
   * @param {{ x0: number, y0: number, mx: number, my: number, r2: number, minIn: number }[]} pool
   * @param {boolean} relaxSep
   * @param {number} ringMaxFrac внешний радиус кольца (доля minDim) для «идеальной» дистанции от центра карты
   */
  function greedyPick(pool, relaxSep, ringMaxFrac) {
    const lo = minDim * CENTRAL_RING_MIN_FRAC;
    const hi = minDim * ringMaxFrac;
    const idealR2 = ((lo + hi) * 0.5) ** 2;

    const sorted = pool.slice().sort((a, b) => {
      const ar = Math.abs(a.r2 - idealR2);
      const br = Math.abs(b.r2 - idealR2);
      if (ar !== br) return ar - br;
      if (b.minIn !== a.minIn) return b.minIn - a.minIn;
      return a.r2 - b.r2;
    });

    /** @type {{ x0: number, y0: number, mx: number, my: number }[]} */
    const picked = [];
    const used = new Set();

    function conflictsRect(x0, y0) {
      for (let p = 0; p < picked.length; p++) {
        if (quantumFarmRectsConflict(x0, y0, picked[p].x0, picked[p].y0)) return true;
      }
      return false;
    }

    function minDistToPicked(mx, my) {
      if (!picked.length) return Infinity;
      let m = Infinity;
      for (let p = 0; p < picked.length; p++) {
        const d = dist2(mx, my, picked[p].mx, picked[p].my);
        if (d < m) m = d;
      }
      return m;
    }

    while (picked.length < QUANTUM_FARM_COUNT && sorted.length) {
      let bestIdx = -1;
      /** @type {{ x0: number, y0: number, mx: number, my: number, r2: number } | null} */
      let bestCand = null;

      if (picked.length === 0) {
        /* Якорь конфликта — ближайшая к центру карты валидная 2×2 на суши в кольце. */
        let bestR2 = Infinity;
        for (let i = 0; i < sorted.length; i++) {
          const c = sorted[i];
          const k = `${c.x0},${c.y0}`;
          if (used.has(k)) continue;
          if (c.r2 < bestR2) {
            bestR2 = c.r2;
            bestIdx = i;
            bestCand = c;
          }
        }
      } else {
        let bestScore = -Infinity;
        let bestR2AtScore = Infinity;
        for (let i = 0; i < sorted.length; i++) {
          const c = sorted[i];
          const k = `${c.x0},${c.y0}`;
          if (used.has(k)) continue;
          if (conflictsRect(c.x0, c.y0)) continue;
          const md = minDistToPicked(c.mx, c.my);
          if (!relaxSep && md < minCenterSepSq) continue;
          const score = md - CENTRAL_INWARD_BIAS_LAMBDA * c.r2;
          if (score > bestScore + 1e-9 || (Math.abs(score - bestScore) <= 1e-9 && c.r2 < bestR2AtScore)) {
            bestScore = score;
            bestR2AtScore = c.r2;
            bestIdx = i;
            bestCand = c;
          }
        }
      }

      if (bestIdx < 0 || !bestCand) break;

      used.add(`${bestCand.x0},${bestCand.y0}`);
      picked.push({ x0: bestCand.x0, y0: bestCand.y0, mx: bestCand.mx, my: bestCand.my });
    }

    return picked;
  }

  const maxFracPlan = [CENTRAL_RING_MAX_FRAC_INITIAL, ...CENTRAL_RING_MAX_FRAC_STEPS];
  /** @type {{ x0: number, y0: number, mx: number, my: number }[]} */
  let picked = [];

  for (let pi = 0; pi < maxFracPlan.length && picked.length < QUANTUM_FARM_COUNT; pi++) {
    const frac = maxFracPlan[pi];
    const pool = collectCentralCandidates(frac);
    picked = greedyPick(pool, false, frac);
    if (picked.length >= QUANTUM_FARM_COUNT) break;
  }

  if (picked.length < QUANTUM_FARM_COUNT) {
    const frac = maxFracPlan[maxFracPlan.length - 1];
    const pool = collectCentralCandidates(frac);
    picked = greedyPick(pool, true, frac);
  }

  if (picked.length < QUANTUM_FARM_COUNT) {
    const widePool = [];
    const xHi = gridW - QUANTUM_FARM_SIZE;
    const yHi = gridH - QUANTUM_FARM_SIZE;
    const wideMaxR2 = (minDim * 0.34) ** 2;
    for (let y0 = edgeMargin; y0 <= yHi - edgeMargin; y0++) {
      for (let x0 = edgeMargin; x0 <= xHi - edgeMargin; x0++) {
        if (!rectOnIsland(x0, y0, islandMask)) continue;
        const { mx, my } = rectCenter(x0, y0);
        const r2 = dist2(mx, my, mapCx, mapCy);
        if (r2 > wideMaxR2) continue;
        const minIn = rectMinInward(x0, y0);
        if (minIn < 1) continue;
        widePool.push({ x0, y0, mx, my, r2, minIn });
      }
    }
    widePool.sort((a, b) => a.r2 - b.r2 || b.minIn - a.minIn);
    picked = greedyPick(widePool, true, 0.34);
  }

  return picked.map((p, i) => ({
    id: i + 1,
    x0: p.x0,
    y0: p.y0,
    w: QUANTUM_FARM_SIZE,
    h: QUANTUM_FARM_SIZE,
  }));
}
