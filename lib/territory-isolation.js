/**
 * Линия снабжения / изоляция территории — через связные компоненты (8-соседство).
 *
 * **Изоляция и коллапс через ~20 с** (`computeIsolatedTerritoryGroups`): «снабжение» только от **главной** базы 6×6.
 * Участок, отрезанный от главной (даже если связан только с передовой базой), снова попадает в карман: мигание, таймер,
 * нейтрализация по истечении `TERRITORY_ISOLATION_GRACE_MS`.
 *
 * **Размещение пикселей** на сервере — отдельно: там BFS от главной **и** всех плацдармов (`computeBaseConnectedPixelKeysForTeam`).
 *
 * Внутри любой базы 6×6 (главная или FOB) клетки не попадают в список кармана — см. `cellKeyInsideAnyTeamBaseRect`.
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
 * Связные компоненты V, не пересекающиеся с заданным множеством «снабжаемых» клеток.
 * @param {Set<string>} vertices
 * @param {Set<string>} reachable
 * @returns {string[][]}
 */
function isolatedVertexComponentsDisjointFromReachable(vertices, reachable) {
  /** @type {string[][]} */
  const isolated = [];
  const seen = new Set();
  const neighBuf = [];
  for (const start of vertices) {
    if (reachable.has(start) || seen.has(start)) continue;
    const comp = [];
    const st = [start];
    seen.add(start);
    while (st.length) {
      const cur = st.pop();
      comp.push(cur);
      const neigh = neighborKeysInSet8(cur, vertices, neighBuf);
      for (let i = 0; i < neigh.length; i++) {
        const nk = neigh[i];
        if (reachable.has(nk) || seen.has(nk)) continue;
        seen.add(nk);
        st.push(nk);
      }
    }
    isolated.push(comp);
  }
  return isolated;
}

/**
 * Компоненты V без пересечения с **каким-либо** переданным якорем (BFS от `anchorKeys` по V).
 *
 * @param {Set<string>} vertices V — все клетки одной команды
 * @param {Set<string>|string[]} anchorKeys стартовые клетки для BFS
 * @returns {string[][]}
 */
export function isolatedConnectedComponentsNotReachingAnyAnchor(vertices, anchorKeys) {
  if (!vertices.size) return [];
  const seeds = anchorKeys instanceof Set ? anchorKeys : new Set(anchorKeys);
  const neighBuf = [];
  const reachable = new Set();
  const stack = [];
  for (const k of seeds) {
    if (!vertices.has(k)) continue;
    reachable.add(k);
    stack.push(k);
  }
  while (stack.length) {
    const cur = stack.pop();
    const neigh = neighborKeysInSet8(cur, vertices, neighBuf);
    for (let i = 0; i < neigh.length; i++) {
      const nk = neigh[i];
      if (reachable.has(nk)) continue;
      reachable.add(nk);
      stack.push(nk);
    }
  }
  return isolatedVertexComponentsDisjointFromReachable(vertices, reachable);
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
 * Все клетки V, 8-достижимые от переданных баз: главная (spawn) + элементы `militaryOutposts`.
 * Для **изоляции** передавайте `militaryOutposts: []` — тогда только путь к главной 6×6 считается «снабжаемым».
 *
 * @param {Set<string>} vertices
 * @param {number} spawnX0
 * @param {number} spawnY0
 * @param {unknown} militaryOutposts
 * @param {number} [spawnSize=6]
 * @returns {Set<string>}
 */
export function computeSupplyReachableFromTeamBases(vertices, spawnX0, spawnY0, militaryOutposts, spawnSize = 6) {
  const S = spawnSize | 0;
  if (S < 1 || !vertices?.size) return new Set();
  const reachable = new Set();
  const stack = [];
  const neighBuf = [];
  const addRectInteriorSeeds = (x0, y0) => {
    const ox = x0 | 0;
    const oy = y0 | 0;
    for (let y = oy; y < oy + S; y++) {
      for (let x = ox; x < ox + S; x++) {
        const k = makeGridCellKey(x, y);
        if (vertices.has(k) && !reachable.has(k)) {
          reachable.add(k);
          stack.push(k);
        }
      }
    }
  };
  if (typeof spawnX0 === "number" && typeof spawnY0 === "number") {
    addRectInteriorSeeds(spawnX0, spawnY0);
  }
  const mos = Array.isArray(militaryOutposts) ? militaryOutposts : [];
  for (let mi = 0; mi < mos.length; mi++) {
    const o = mos[mi];
    if (!o || typeof o.x0 !== "number" || typeof o.y0 !== "number") continue;
    addRectInteriorSeeds(o.x0, o.y0);
  }
  /** Клетки V, 8-соседние с периметром каждой базы — всегда, иначе при непустом stack от главной плацдарм не получал touch-seeds и весь «хвост» от FOB считался карманом с таймером. */
  const addTouchSeedsFromRect = (x0, y0) => {
    const ox = x0 | 0;
    const oy = y0 | 0;
    for (let y = oy; y < oy + S; y++) {
      for (let x = ox; x < ox + S; x++) {
        for (let i = 0; i < GRID8_DELTAS.length; i++) {
          const nk = makeGridCellKey(x + GRID8_DELTAS[i][0], y + GRID8_DELTAS[i][1]);
          if (vertices.has(nk) && !reachable.has(nk)) {
            reachable.add(nk);
            stack.push(nk);
          }
        }
      }
    }
  };
  if (typeof spawnX0 === "number" && typeof spawnY0 === "number") {
    addTouchSeedsFromRect(spawnX0, spawnY0);
  }
  for (let mi = 0; mi < mos.length; mi++) {
    const o = mos[mi];
    if (!o || typeof o.x0 !== "number" || typeof o.y0 !== "number") continue;
    addTouchSeedsFromRect(o.x0, o.y0);
  }
  while (stack.length) {
    const cur = stack.pop();
    const neigh = neighborKeysInSet8(cur, vertices, neighBuf);
    for (let i = 0; i < neigh.length; i++) {
      const nk = neigh[i];
      if (reachable.has(nk)) continue;
      reachable.add(nk);
      stack.push(nk);
    }
  }
  return reachable;
}

/**
 * Клетка «x,y» попадает в 6×6 главной базы или любого плацдарма команды — не карман изоляции, а часть базы.
 */
function cellKeyInsideAnyTeamBaseRect(key, t, spawnSize) {
  const p = parseGridCellKey(key);
  if (!p) return false;
  const S = spawnSize | 0;
  const inRect = (x0, y0) => {
    const ox = x0 | 0;
    const oy = y0 | 0;
    return p.x >= ox && p.x < ox + S && p.y >= oy && p.y < oy + S;
  };
  if (typeof t.spawnX0 === "number" && typeof t.spawnY0 === "number" && inRect(t.spawnX0, t.spawnY0)) return true;
  const mos = Array.isArray(t.militaryOutposts) ? t.militaryOutposts : [];
  for (let i = 0; i < mos.length; i++) {
    const o = mos[i];
    if (!o || typeof o.x0 !== "number" || typeof o.y0 !== "number") continue;
    if (inRect(o.x0, o.y0)) return true;
  }
  return false;
}

/**
 * Изолированные группы по всем командам: компоненты без 8-связного пути **к главной** базе 6×6.
 * Передовые базы в расчёт «снабжения для изоляции» не входят — иначе отрезанный от штаба карман никогда не таймился.
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

    /* Только главная база — как изначальный геймплей: отрезали от штаба → 20 с → нейтраль. */
    const reachable = computeSupplyReachableFromTeamBases(vertices, t.spawnX0, t.spawnY0, [], spawnSize);

    const pockets = isolatedVertexComponentsDisjointFromReachable(vertices, reachable);
    for (let pi = 0; pi < pockets.length; pi++) {
      const cells = pockets[pi].filter((k) => !cellKeyInsideAnyTeamBaseRect(k, t, spawnSize));
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
