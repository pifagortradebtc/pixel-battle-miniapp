/**
 * Quantum Farms — 8 узлов 2×2 в «квантоцентре» + 8 узлов 2×2 на периферии (углы и рёбра).
 * Центр: BFS от центра карты, кольцо у геометрического центра (как раньше).
 * Периферия: 4 угла + по одной ферме на стороне (порядок сторон перемешан), лёгкий джиттер (детерминированный RNG).
 * Механика у всех ферм одна; отличается только размещение (несколько зон конфликта на карте).
 */

export const QUANTUM_FARM_CENTER_COUNT = 8;
export const QUANTUM_FARM_PERIPHERY_COUNT = 8;
export const QUANTUM_FARM_TOTAL = QUANTUM_FARM_CENTER_COUNT + QUANTUM_FARM_PERIPHERY_COUNT;
/** Всего ферм (совместимость со старым именем). */
export const QUANTUM_FARM_COUNT = QUANTUM_FARM_TOTAL;
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

/** Периферия: «внутренность» острова для углов/краёв — не ниже (как у центра, берег допустим). */
const PERI_MIN_INWARD = 0;
/** Доля minDim — ширина углового поиска. */
const PERI_CORNER_BAND_FRAC = 0.11;
const PERI_CORNER_BAND_MIN = 10;
/** Доля minDim — толщина полосы у ребра для «реберных» ферм. */
const PERI_EDGE_BAND_FRAC = 0.075;
const PERI_EDGE_BAND_MIN = 8;
/** Доля gridW/H — размах по X/Y при поиске реберной фермы от середины стороны. */
const PERI_EDGE_SPAN_FRAC = 0.22;

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
 * 2×2 ферма + зазор не пересекается ни с одним из осевых прямоугольников (базы 6×6 и т.п.).
 */
export function farmAvoidsAxisAlignedRects(
  fx0,
  fy0,
  rects,
  S = QUANTUM_FARM_SIZE,
  g = QUANTUM_FARM_PLACE_GAP
) {
  if (!rects || !rects.length) return true;
  const fx1 = fx0 - g;
  const fy1 = fy0 - g;
  const fx2 = fx0 + S + g - 1;
  const fy2 = fy0 + S + g - 1;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    const rx0 = r.x0 | 0;
    const ry0 = r.y0 | 0;
    const rw = r.w | 0;
    const rh = r.h | 0;
    if (rw < 1 || rh < 1) continue;
    const rx1 = rx0 + rw - 1;
    const ry1 = ry0 + rh - 1;
    if (!(fx2 < rx0 || rx1 < fx1 || fy2 < ry0 || ry1 < fy1)) return false;
  }
  return true;
}

/**
 * @param {unknown} avoidRects
 * @returns {{ x0: number, y0: number, w: number, h: number }[]}
 */
function normalizeAvoidRects(avoidRects) {
  if (!Array.isArray(avoidRects)) return [];
  /** @type {{ x0: number, y0: number, w: number, h: number }[]} */
  const out = [];
  for (let i = 0; i < avoidRects.length; i++) {
    const r = avoidRects[i];
    if (!r || typeof r !== "object") continue;
    const x0 = r.x0;
    const y0 = r.y0;
    if (typeof x0 !== "number" || typeof y0 !== "number") continue;
    const w = typeof r.w === "number" && Number.isFinite(r.w) ? r.w | 0 : 6;
    const h = typeof r.h === "number" && Number.isFinite(r.h) ? r.h | 0 : 6;
    out.push({ x0: x0 | 0, y0: y0 | 0, w, h });
  }
  return out;
}

function hashSeed(gridW, gridH, roundIndex) {
  const a = (gridW | 0) * 73856093;
  const b = (gridH | 0) * 19349663;
  const c = (roundIndex | 0) * 83492791;
  return (a ^ b ^ c) >>> 0;
}

/** @returns {() => number} uniform [0,1) */
function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace(arr, rnd) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
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
 * Разместить до QUANTUM_FARM_CENTER_COUNT ферм в центре и QUANTUM_FARM_PERIPHERY_COUNT на периферии.
 * @param {Uint8Array | null} playableGrid
 * @param {number} gridW
 * @param {number} gridH
 * @param {number} [roundIndex]
 * @param {{ x0: number, y0: number, w?: number, h?: number }[] | null} [avoidRects] базы/плацдармы и т.п.
 * @returns {{ id: number, x0: number, y0: number, w: number, h: number }[]}
 */
export function computeQuantumFarmLayouts(playableGrid, gridW, gridH, roundIndex = 0, avoidRects = null) {
  if (!playableGrid || playableGrid.length !== gridW * gridH) return [];

  const idx = (x, y) => y * gridW + x;
  const avoidNorm = normalizeAvoidRects(avoidRects);

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
        if (!farmAvoidsAxisAlignedRects(x0, y0, avoidNorm)) continue;
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

    while (picked.length < QUANTUM_FARM_CENTER_COUNT && sorted.length) {
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
          if (!farmAvoidsAxisAlignedRects(c.x0, c.y0, avoidNorm)) continue;
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
          if (!farmAvoidsAxisAlignedRects(c.x0, c.y0, avoidNorm)) continue;
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

  for (let pi = 0; pi < maxFracPlan.length && picked.length < QUANTUM_FARM_CENTER_COUNT; pi++) {
    const frac = maxFracPlan[pi];
    const pool = collectCentralCandidates(frac);
    picked = greedyPick(pool, false, frac);
    if (picked.length >= QUANTUM_FARM_CENTER_COUNT) break;
  }

  if (picked.length < QUANTUM_FARM_CENTER_COUNT) {
    const frac = maxFracPlan[maxFracPlan.length - 1];
    const pool = collectCentralCandidates(frac);
    picked = greedyPick(pool, true, frac);
  }

  if (picked.length < QUANTUM_FARM_CENTER_COUNT) {
    const widePool = [];
    const xHi = gridW - QUANTUM_FARM_SIZE;
    const yHi = gridH - QUANTUM_FARM_SIZE;
    const wideMaxR2 = (minDim * 0.34) ** 2;
    for (let y0 = edgeMargin; y0 <= yHi - edgeMargin; y0++) {
      for (let x0 = edgeMargin; x0 <= xHi - edgeMargin; x0++) {
        if (!rectOnIsland(x0, y0, islandMask)) continue;
        if (!farmAvoidsAxisAlignedRects(x0, y0, avoidNorm)) continue;
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

  /** @type {{ x0: number, y0: number }[]} */
  const placed = picked.map((p) => ({ x0: p.x0, y0: p.y0 }));

  const rnd = mulberry32(hashSeed(gridW, gridH, roundIndex | 0));

  const xHi0 = gridW - QUANTUM_FARM_SIZE;
  const yHi0 = gridH - QUANTUM_FARM_SIZE;
  const periInset = Math.max(2, Math.min(12, Math.floor(minDim * 0.018)));
  let cornerBand = Math.max(PERI_CORNER_BAND_MIN, Math.floor(minDim * PERI_CORNER_BAND_FRAC));
  let edgeBand = Math.max(PERI_EDGE_BAND_MIN, Math.floor(minDim * PERI_EDGE_BAND_FRAC));

  /**
   * @param {number} x0
   * @param {number} y0
   */
  function peripheryAnchorOk(x0, y0) {
    if (x0 < periInset || y0 < periInset || x0 > xHi0 - periInset || y0 > yHi0 - periInset) return false;
    if (!rectOnIsland(x0, y0, islandMask)) return false;
    if (rectMinInward(x0, y0) < PERI_MIN_INWARD) return false;
    if (!farmAvoidsAxisAlignedRects(x0, y0, avoidNorm)) return false;
    for (let i = 0; i < placed.length; i++) {
      if (quantumFarmRectsConflict(x0, y0, placed[i].x0, placed[i].y0)) return false;
    }
    return true;
  }

  /**
   * @param {{ x0: number, y0: number, sortKey: number }[]} cands
   */
  function pickFromSortedCandidates(cands) {
    cands.sort((a, b) => a.sortKey - b.sortKey);
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i];
      if (peripheryAnchorOk(c.x0, c.y0)) {
        placed.push({ x0: c.x0, y0: c.y0 });
        return true;
      }
    }
    return false;
  }

  /**
   * @param {'tl'|'tr'|'bl'|'br'} corner
   */
  function collectCornerCandidates(corner) {
    /** @type {{ x0: number, y0: number, sortKey: number }[]} */
    const cands = [];
    const x0Lo = periInset;
    const x0Hi = Math.min(xHi0 - periInset, periInset + cornerBand);
    const y0Lo = periInset;
    const y0Hi = Math.min(yHi0 - periInset, periInset + cornerBand);
    if (corner === "tl") {
      for (let y0 = y0Lo; y0 <= y0Hi; y0++) {
        for (let x0 = x0Lo; x0 <= x0Hi; x0++) {
          const sk = x0 + y0 + rnd() * 3.1;
          cands.push({ x0, y0, sortKey: sk });
        }
      }
    } else if (corner === "tr") {
      const xrLo = Math.max(periInset, xHi0 - periInset - cornerBand);
      const xrHi = xHi0 - periInset;
      for (let y0 = y0Lo; y0 <= y0Hi; y0++) {
        for (let x0 = xrLo; x0 <= xrHi; x0++) {
          const sk = xHi0 - x0 + y0 + rnd() * 3.1;
          cands.push({ x0, y0, sortKey: sk });
        }
      }
    } else if (corner === "bl") {
      const yrLo = Math.max(periInset, yHi0 - periInset - cornerBand);
      const yrHi = yHi0 - periInset;
      for (let y0 = yrLo; y0 <= yrHi; y0++) {
        for (let x0 = x0Lo; x0 <= x0Hi; x0++) {
          const sk = x0 + (yHi0 - y0) + rnd() * 3.1;
          cands.push({ x0, y0, sortKey: sk });
        }
      }
    } else {
      const xrLo = Math.max(periInset, xHi0 - periInset - cornerBand);
      const xrHi = xHi0 - periInset;
      const yrLo = Math.max(periInset, yHi0 - periInset - cornerBand);
      const yrHi = yHi0 - periInset;
      for (let y0 = yrLo; y0 <= yrHi; y0++) {
        for (let x0 = xrLo; x0 <= xrHi; x0++) {
          const sk = xHi0 - x0 + (yHi0 - y0) + rnd() * 3.1;
          cands.push({ x0, y0, sortKey: sk });
        }
      }
    }
    return cands;
  }

  /**
   * @param {'t'|'b'|'l'|'r'} side
   */
  function collectEdgeCandidates(side) {
    /** @type {{ x0: number, y0: number, sortKey: number }[]} */
    const cands = [];
    const span = Math.max(12, Math.floor((side === "t" || side === "b" ? gridW : gridH) * PERI_EDGE_SPAN_FRAC));
    const midX = Math.floor(xHi0 * 0.5);
    const midY = Math.floor(yHi0 * 0.5);
    const jitterX = Math.floor((rnd() - 0.5) * Math.min(36, gridW * 0.08));
    const jitterY = Math.floor((rnd() - 0.5) * Math.min(36, gridH * 0.08));

    if (side === "t") {
      const yLo = periInset;
      const yHi = Math.min(yHi0 - periInset, periInset + edgeBand);
      const xA = Math.max(periInset, midX - span + jitterX);
      const xB = Math.min(xHi0 - periInset, midX + span + jitterX);
      const xa = Math.min(xA, xB);
      const xb = Math.max(xA, xB);
      for (let y0 = yLo; y0 <= yHi; y0++) {
        for (let x0 = xa; x0 <= xb; x0++) {
          const sk = y0 * 1000 + Math.abs(x0 - midX) + rnd() * 4;
          cands.push({ x0, y0, sortKey: sk });
        }
      }
    } else if (side === "b") {
      const yLo = Math.max(periInset, yHi0 - periInset - edgeBand);
      const yHi = yHi0 - periInset;
      const xA = Math.max(periInset, midX - span + jitterX);
      const xB = Math.min(xHi0 - periInset, midX + span + jitterX);
      const xa = Math.min(xA, xB);
      const xb = Math.max(xA, xB);
      for (let y0 = yLo; y0 <= yHi; y0++) {
        for (let x0 = xa; x0 <= xb; x0++) {
          const sk = -y0 * 1000 + Math.abs(x0 - midX) + rnd() * 4;
          cands.push({ x0, y0, sortKey: sk });
        }
      }
    } else if (side === "l") {
      const xLo = periInset;
      const xHi = Math.min(xHi0 - periInset, periInset + edgeBand);
      const yA = Math.max(periInset, midY - span + jitterY);
      const yB = Math.min(yHi0 - periInset, midY + span + jitterY);
      const ya = Math.min(yA, yB);
      const yb = Math.max(yA, yB);
      for (let x0 = xLo; x0 <= xHi; x0++) {
        for (let y0 = ya; y0 <= yb; y0++) {
          const sk = x0 * 1000 + Math.abs(y0 - midY) + rnd() * 4;
          cands.push({ x0, y0, sortKey: sk });
        }
      }
    } else {
      const xLo = Math.max(periInset, xHi0 - periInset - edgeBand);
      const xHi = xHi0 - periInset;
      const yA = Math.max(periInset, midY - span + jitterY);
      const yB = Math.min(yHi0 - periInset, midY + span + jitterY);
      const ya = Math.min(yA, yB);
      const yb = Math.max(yA, yB);
      for (let x0 = xLo; x0 <= xHi; x0++) {
        for (let y0 = ya; y0 <= yb; y0++) {
          const sk = -x0 * 1000 + Math.abs(y0 - midY) + rnd() * 4;
          cands.push({ x0, y0, sortKey: sk });
        }
      }
    }
    return cands;
  }

  function placePeripheryPass() {
    if (placed.length > QUANTUM_FARM_CENTER_COUNT) {
      placed.length = QUANTUM_FARM_CENTER_COUNT;
    }
    const corners = /** @type {const} */ (["tl", "tr", "bl", "br"]);
    for (let ci = 0; ci < 4; ci++) {
      if (!pickFromSortedCandidates(collectCornerCandidates(corners[ci]))) return false;
    }
    /** @type {('t'|'b'|'l'|'r')[]} */
    const sides = ["t", "r", "b", "l"];
    shuffleInPlace(sides, rnd);
    for (let si = 0; si < 4; si++) {
      if (!pickFromSortedCandidates(collectEdgeCandidates(sides[si]))) return false;
    }
    return placed.length >= QUANTUM_FARM_TOTAL;
  }

  if (placed.length >= QUANTUM_FARM_CENTER_COUNT) {
    let pass = 0;
    while (placed.length < QUANTUM_FARM_TOTAL && pass < 4) {
      if (placePeripheryPass()) break;
      cornerBand = Math.floor(cornerBand * 1.22) + 4;
      edgeBand = Math.floor(edgeBand * 1.18) + 3;
      pass++;
    }
  }

  return placed.map((p, i) => ({
    id: i + 1,
    x0: p.x0,
    y0: p.y0,
    w: QUANTUM_FARM_SIZE,
    h: QUANTUM_FARM_SIZE,
  }));
}
