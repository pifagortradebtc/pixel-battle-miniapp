/**
 * Линия снабжения / изоляция территории — строго через связные компоненты.
 *
 * Для команды V = множество её клеток на карте. Граф: индуцированный подграф
 * решётки, рёбра между парами клеток из V по 8 соседям (как правила размещения).
 *
 * 1) Находим все связные компоненты графа на V (один проход DFS/стек).
 * 2) Компонента, содержащая любой якорь снабжения (клетка флага главной базы 6×6 или
 *    клетка флага передовой базы / плацдарма), если этот якорь ∈ V — «base-connected»:
 *    таймера изоляции 20 с нет (как у основной базы).
 * 3) Каждая остальная компонента — отдельная изолированная группа со своим groupId
 *    и своим 20s таймером на сервере (никакого общего таймера на команду).
 *
 * Если ни один якорь не занят командой (ни один anchorKey ∉ V), все компоненты изолированы.
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
 * Компоненты без связи с каким-либо якорем снабжения (главная или передовая база).
 *
 * @param {Set<string>} vertices V — все клетки одной команды
 * @param {Set<string>|string[]} anchorKeys клетки флагов (главная + плацдармы)
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
 * Изолированные группы по всем командам: только компоненты без связи с базой.
 *
 * @returns {{ teamId: number, groupId: string, cells: string[] }[]}
 */
export function computeIsolatedTerritoryGroups(pixels, teams, pixelTeamFn, flagCellFromSpawnFn) {
  const verticesByTeam = buildTeamVertexSets(pixels, pixelTeamFn);
  /** @type {{ teamId: number, groupId: string, cells: string[] }[]} */
  const out = [];

  for (const t of teams) {
    if (t.solo || t.eliminated) continue;
    if (typeof t.spawnX0 !== "number" || typeof t.spawnY0 !== "number") continue;
    const tid = t.id | 0;
    const vertices = verticesByTeam.get(tid);
    if (!vertices?.size) continue;

    /** @type {Set<string>} */
    const anchorKeys = new Set();
    const mainFlag = flagCellFromSpawnFn(t.spawnX0, t.spawnY0);
    anchorKeys.add(makeGridCellKey(mainFlag.x, mainFlag.y));
    const mos = Array.isArray(t.militaryOutposts) ? t.militaryOutposts : [];
    for (let mi = 0; mi < mos.length; mi++) {
      const o = mos[mi];
      if (!o || typeof o.x0 !== "number" || typeof o.y0 !== "number") continue;
      const f = flagCellFromSpawnFn(o.x0, o.y0);
      anchorKeys.add(makeGridCellKey(f.x, f.y));
    }

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
export function computeIsolatedTerritoryPockets(pixels, teams, pixelTeamFn, flagCellFromSpawnFn) {
  const groups = computeIsolatedTerritoryGroups(pixels, teams, pixelTeamFn, flagCellFromSpawnFn);
  return groups.map((g) => ({ teamId: g.teamId, cells: g.cells }));
}
