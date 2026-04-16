/**
 * Линия снабжения / изоляция территории — строго через связные компоненты.
 *
 * Правило: связана с **любой** активной базой команды = безопасно. Изолировано = оторвано от **всех** активных баз.
 * Активные корни: главная 6×6 + каждая передовая база (military outpost) из меты команды.
 *
 * Для команды V = множество её клеток на карте. Граф: индуцированный подграф по 8 соседям.
 *
 * 1) Связные компоненты на V.
 * 2) Корни снабжения: клетки из V внутри **любой** зоны активной базы 6×6 (не только центр флага).
 * 3) Компонента с пересечением с корнями — снабжаемая, без таймера изоляции.
 * 4) Остальные компоненты — карманы с 20 s и коллапсом.
 */

export const TERRITORY_ISOLATION_GRACE_MS = 20_000;

/** 8 направлений: как cellTouchesTeamTerritory / размещение пикселя. */
export const GRID8_DELTAS = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

/**
 * @param {string} key "x,y"
 * @returns {{ x: number, y: number } | null}
 */
export function parseGridCellKey(key) {
  const parts = String(key).split(",");
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: x | 0, y: y | 0 };
}

export function makeGridCellKey(x, y) {
  return `${x | 0},${y | 0}`;
}

/**
 * Соседи по 8 направлениям внутри `vertexSet`.
 * @param {string} key
 * @param {Set<string>} vertexSet
 * @param {string[]} [out]
 * @returns {string[]}
 */
export function neighborKeysInSet8(key, vertexSet, out = []) {
  out.length = 0;
  const p = parseGridCellKey(key);
  if (!p) return out;
  for (let i = 0; i < GRID8_DELTAS.length; i++) {
    const nk = makeGridCellKey(p.x + GRID8_DELTAS[i][0], p.y + GRID8_DELTAS[i][1]);
    if (vertexSet.has(nk)) out.push(nk);
  }
  return out;
}

/**
 * Все связные компоненты индуцированного подграфа на `vertices` (8-соседство).
 * @param {Set<string>} vertices
 * @returns {string[][]}
 */
export function connectedComponents8Induced(vertices) {
  /** @type {string[][]} */
  const components = [];
  const seen = new Set();
  const neighBuf = [];
  for (const start of vertices) {
    if (seen.has(start)) continue;
    /** @type {string[]} */
    const comp = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const cur = stack.pop();
      comp.push(cur);
      const neigh = neighborKeysInSet8(cur, vertices, neighBuf);
      for (let ni = 0; ni < neigh.length; ni++) {
        const nk = neigh[ni];
        if (seen.has(nk)) continue;
        seen.add(nk);
        stack.push(nk);
      }
    }
    components.push(comp);
  }
  return components;
}

/**
 * Компоненты V без пересечения с **каким-либо** активным корнем снабжения (см. supplyAnchorKeysInVertices).
 *
 * @param {Set<string>} vertices V — все клетки одной команды
 * @param {Set<string>|string[]} anchorKeys корни: закрашенные клетки внутри любой базы 6×6
 * @returns {string[][]}
 */
export function isolatedConnectedComponentsNotReachingAnyAnchor(vertices, anchorKeys) {
  if (!vertices.size) return [];
  const anchors = anchorKeys instanceof Set ? anchorKeys : new Set(anchorKeys);
  const allComponents = connectedComponents8Induced(vertices);
  /** @type {string[][]} */
  const isolated = [];
  for (let ci = 0; ci < allComponents.length; ci++) {
    const comp = allComponents[ci];
    let hasAnchor = false;
    for (let i = 0; i < comp.length; i++) {
      if (anchors.has(comp[i])) {
        hasAnchor = true;
        break;
      }
    }
    if (!hasAnchor) isolated.push(comp);
  }
  return isolated;
}

/**
 * @param {Set<string>} vertices
 * @param {string} baseKey
 * @returns {string[][]}
 */
export function isolatedConnectedComponentsNotReachingBase(vertices, baseKey) {
  return isolatedConnectedComponentsNotReachingAnyAnchor(vertices, baseKey ? new Set([baseKey]) : new Set());
}

/**
 * @param {Map<string, unknown>} pixels
 * @param {(val: unknown) => number} pixelTeamFn
 * @returns {Map<number, Set<string>>}
 */
export function buildTeamVertexSets(pixels, pixelTeamFn) {
  /** @type {Map<number, Set<string>>} */
  const byTeam = new Map();
  for (const [k, v] of pixels) {
    const tid = pixelTeamFn(v) | 0;
    if (!tid) continue;
    if (!byTeam.has(tid)) byTeam.set(tid, new Set());
    byTeam.get(tid).add(k);
  }
  return byTeam;
}

/**
 * Стабильный groupId изолированного кармана (каноническое множество клеток).
 * @param {string[]} cellKeys
 */
export function canonicalIsolationSig(cellKeys) {
  return [...cellKeys].sort().join("|");
}

/**
 * Активные корни снабжения в V: закрашенные клетки внутри **любой** базы команды (главная + ФОБ).
 * Связность с этим множеством (через компоненту в V) = снабжение; иначе — изоляция от всех баз.
 *
 * @param {Set<string>} vertices
 * @param {number} spawnX0
 * @param {number} spawnY0
 * @param {unknown} militaryOutposts
 * @param {number} [spawnSize=6]
 * @returns {Set<string>}
 */
export function supplyAnchorKeysInVertices(vertices, spawnX0, spawnY0, militaryOutposts, spawnSize = 6) {
  const S = spawnSize | 0;
  if (S < 1 || !vertices?.size) return new Set();
  /** @type {Set<string>} */
  const anchors = new Set();
  const addRect = (x0, y0) => {
    const ox = x0 | 0;
    const oy = y0 | 0;
    for (let y = oy; y < oy + S; y++) {
      for (let x = ox; x < ox + S; x++) {
        const k = makeGridCellKey(x, y);
        if (vertices.has(k)) anchors.add(k);
      }
    }
  };
  if (typeof spawnX0 === "number" && typeof spawnY0 === "number") {
    addRect(spawnX0, spawnY0);
  }
  const mos = Array.isArray(militaryOutposts) ? militaryOutposts : [];
  for (let mi = 0; mi < mos.length; mi++) {
    const o = mos[mi];
    if (!o || typeof o.x0 !== "number" || typeof o.y0 !== "number") continue;
    addRect(o.x0, o.y0);
  }
  return anchors;
}

/**
 * Изолированные группы по всем командам: только компоненты без связи с какой-либо активной базой.
 *
 * @param {number} [spawnSize=6] размер квадрата базы (как TEAM_SPAWN_SIZE на сервере)
 * @returns {{ teamId: number, groupId: string, cells: string[] }[]}
 */
export function computeIsolatedTerritoryGroups(pixels, teams, pixelTeamFn, flagCellFromSpawnFn, spawnSize = 6) {
  void flagCellFromSpawnFn;
  const verticesByTeam = buildTeamVertexSets(pixels, pixelTeamFn);
  /** @type {{ teamId: number, groupId: string, cells: string[] }[]} */
  const out = [];

  for (const t of teams) {
    if (t.solo || t.eliminated) continue;
    if (typeof t.spawnX0 !== "number" || typeof t.spawnY0 !== "number") continue;
    const tid = t.id | 0;
    const vertices = verticesByTeam.get(tid);
    if (!vertices?.size) continue;

    const anchorKeys = supplyAnchorKeysInVertices(vertices, t.spawnX0, t.spawnY0, t.militaryOutposts, spawnSize);

    const pockets = isolatedConnectedComponentsNotReachingAnyAnchor(vertices, anchorKeys);
    for (let pi = 0; pi < pockets.length; pi++) {
      const cells = pockets[pi];
      if (!cells.length) continue;
      out.push({
        teamId: tid,
        groupId: canonicalIsolationSig(cells),
        cells,
      });
    }
  }

  return out;
}

/**
 * @returns {{ teamId: number, cells: string[] }[]}
 */
export function computeIsolatedTerritoryPockets(pixels, teams, pixelTeamFn, flagCellFromSpawnFn, spawnSize = 6) {
  const groups = computeIsolatedTerritoryGroups(pixels, teams, pixelTeamFn, flagCellFromSpawnFn, spawnSize);
  return groups.map((g) => ({ teamId: g.teamId, cells: g.cells }));
}
