/**
 * Турнир: таймлайн событий по раундам (смещения от начала боя, не от разминки).
 * Клиент импортирует только расчёт множителей и геометрию.
 */

/** Максимум очков с одной клетки после всех модификаторов. */
export const MAX_CELL_SCORE = 3;

const H = 60 * 60 * 1000;
const MIN = 60 * 1000;

/**
 * @typedef {{
 *   eventId: string;
 *   eventType: string;
 *   startOffsetMs: number;
 *   durationMs: number | null;
 *   warnLeadMs?: number;
 *   uiTitle: string;
 *   uiSubtitle: string;
 *   payload?: Record<string, unknown>;
 * }} RoundTimelineEventDef
 */

/** Индекс = roundIndex сервера: 0 массовый, 1 полуфинал, 2 финал команд, 3 дуэль. */
export const ROUND_BATTLE_EVENT_TIMELINES = /** @type {RoundTimelineEventDef[][]} */ ([
  // ——— Round 1 (mass): 8h battle ———
  // Timings: Gold 1h30m + 30m | Seismic 3h instant | Economic 4h30m + 30m | Map comp 6h→end | Final comp 7h30m→end
  [
    {
      eventId: "r0_gold_zone",
      eventType: "gold_zone",
      startOffsetMs: 90 * MIN /* 1h30m */,
      durationMs: 30 * MIN,
      uiTitle: "GOLD ZONE ACTIVE",
      uiSubtitle: "Cells in this zone are worth 2× points",
      payload: { zoneScale: 1, layerKind: "gold_zone" },
    },
    {
      eventId: "r0_seismic",
      eventType: "seismic",
      startOffsetMs: 3 * H /* 3h */,
      durationMs: 0,
      warnLeadMs: 4500,
      uiTitle: "SEISMIC ACTIVITY",
      uiSubtitle: "Some territories have collapsed",
      payload: { aftermathMs: 20_000 },
    },
    {
      eventId: "r0_economic_shift",
      eventType: "economic_mixed",
      startOffsetMs: 4 * H + 30 * MIN /* 4h30m */,
      durationMs: 30 * MIN,
      uiTitle: "ECONOMIC SHIFT",
      uiSubtitle: "Some regions are now worth more or less",
      payload: { clientKind: "economic_shift" },
    },
    {
      eventId: "r0_map_compression",
      eventType: "map_compression",
      startOffsetMs: 6 * H /* 6h → round end */,
      durationMs: null,
      uiTitle: "MAP COMPRESSION",
      uiSubtitle: "Center is now more valuable",
      payload: { centerMult: 1.5, nonCenterMult: 0.5 },
    },
    {
      eventId: "r0_final_compression",
      eventType: "final_edge_compression",
      startOffsetMs: 7 * H + 30 * MIN /* 7h30m → round end */,
      durationMs: null,
      uiTitle: "FINAL PHASE",
      uiSubtitle: "Outer territory is nearly worthless",
      payload: { outerRingMult: 0.25 },
    },
  ],
  // ——— Round 2 (teams ≤10): 5h ———
  // Timings: Gold 1h + 25m | Economic 2h30m + 25m | Synergy 3h30m + 20m | Map comp 4h30m→end
  [
    {
      eventId: "r1_gold_zone",
      eventType: "gold_zone",
      startOffsetMs: 1 * H /* 1h */,
      durationMs: 25 * MIN,
      uiTitle: "TARGET ZONE ACTIVE",
      uiSubtitle: "Capture this zone for bonus score",
      payload: { zoneScale: 0.72, layerKind: "target_zone" },
    },
    {
      eventId: "r1_economic_rotation",
      eventType: "economic_mixed",
      startOffsetMs: 2 * H + 30 * MIN /* 2h30m */,
      durationMs: 25 * MIN,
      uiTitle: "ECONOMIC ROTATION",
      uiSubtitle: "Scoring priorities have shifted",
      payload: { clientKind: "economic_rotation", rectSalt: "rot" },
    },
    {
      eventId: "r1_team_synergy",
      eventType: "team_synergy",
      startOffsetMs: 3 * H + 30 * MIN /* 3h30m */,
      durationMs: 20 * MIN,
      uiTitle: "TEAM SYNERGY ACTIVE",
      uiSubtitle: "Coordinated teams gain bonus score (≥2 online: +12%)",
      payload: { mult: 1.12, minOnlineMembers: 2 },
    },
    {
      eventId: "r1_map_compression",
      eventType: "map_compression",
      startOffsetMs: 4 * H + 30 * MIN /* 4h30m → round end */,
      durationMs: null,
      uiTitle: "FINAL PHASE",
      uiSubtitle: "Fight for the center",
      payload: { centerMult: 1.5, nonCenterMult: 0.5 },
    },
  ],
  // ——— Round 3 (duo): 4h ———
  // Timings: Gold 1h + 20m | Economic 2h + 20m | Map comp 2h30m→end | Final hour pressure 3h30m→end
  [
    {
      eventId: "r2_gold_zone",
      eventType: "gold_zone",
      startOffsetMs: 1 * H /* 1h */,
      durationMs: 20 * MIN,
      uiTitle: "DUEL ZONE ACTIVE",
      uiSubtitle: "This area is worth double score",
      payload: { zoneScale: 0.58, layerKind: "duel_zone" },
    },
    {
      eventId: "r2_resource_surge",
      eventType: "economic_boom_only",
      startOffsetMs: 2 * H /* 2h */,
      durationMs: 20 * MIN,
      uiTitle: "RESOURCE SURGE",
      uiSubtitle: "A region became more valuable",
      payload: { clientKind: "resource_surge" },
    },
    {
      eventId: "r2_map_compression",
      eventType: "map_compression",
      startOffsetMs: 2 * H + 30 * MIN /* 2h30m → round end */,
      durationMs: null,
      uiTitle: "MAP COMPRESSION",
      uiSubtitle: "The battlefield is shrinking",
      payload: {
        centerMult: 1.5,
        nonCenterMult: 0.5,
      },
    },
    {
      eventId: "r2_final_hour_pressure",
      eventType: "dramatic_pressure",
      startOffsetMs: 3 * H + 30 * MIN /* 3h30m → round end */,
      durationMs: null,
      uiTitle: "FINAL HOUR",
      uiSubtitle: "Every point matters now",
      payload: { style: "final_hour" },
    },
  ],
  // ——— Final 1v1: 75 min ———
  // Timings: Center bonus 20m→end | Map compression 45m→end | Final 10 min 65m→end
  [
    {
      eventId: "r3_center_bonus",
      eventType: "center_bonus",
      startOffsetMs: 20 * MIN /* → round end */,
      durationMs: null,
      uiTitle: "CENTER BONUS ACTIVE",
      uiSubtitle: "Center is now worth more",
      payload: { centerMult: 1.5, nonCenterMult: 1 },
    },
    {
      eventId: "r3_map_compression",
      eventType: "map_compression",
      startOffsetMs: 45 * MIN /* → round end */,
      durationMs: null,
      uiTitle: "MAP COMPRESSION",
      uiSubtitle: "Outer territory is losing value",
      payload: { centerMult: 1.5, nonCenterMult: 0.5 },
    },
    {
      eventId: "r3_final_ten_pressure",
      eventType: "dramatic_pressure",
      startOffsetMs: 65 * MIN /* → round end */,
      durationMs: null,
      uiTitle: "FINAL 10 MINUTES",
      uiSubtitle: "This decides everything",
      payload: { style: "final_ten" },
    },
  ],
]);

export function getRoundTimeline(roundIndex) {
  const i = Math.min(Math.max(roundIndex | 0, 0), 3);
  return ROUND_BATTLE_EVENT_TIMELINES[i] || ROUND_BATTLE_EVENT_TIMELINES[0];
}

/**
 * @param {RoundTimelineEventDef} ev
 * @param {number} playStartMs
 * @param {number} battleEndMs
 */
export function eventWindowEndMs(ev, playStartMs, battleEndMs) {
  if (ev.durationMs == null) return battleEndMs;
  return playStartMs + ev.startOffsetMs + ev.durationMs;
}

/**
 * @param {number} nowMs
 * @param {number} playStartMs
 * @param {number} battleEndMs
 * @param {RoundTimelineEventDef} ev
 */
export function isEventActiveAt(nowMs, playStartMs, battleEndMs, ev) {
  if (nowMs < playStartMs || nowMs >= battleEndMs) return false;
  const elapsed = nowMs - playStartMs;
  if (elapsed < ev.startOffsetMs) return false;
  const end = eventWindowEndMs(ev, playStartMs, battleEndMs);
  return nowMs < end;
}

function mixSeed(...parts) {
  let h = 2166136261 >>> 0;
  for (const p of parts) {
    const s = String(p);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rectLandFraction(x0, y0, w, h, landGrid, gridW, gridH) {
  let land = 0;
  let tot = 0;
  const x1 = Math.min(gridW, x0 + w);
  const y1 = Math.min(gridH, y0 + h);
  const xa = Math.max(0, x0);
  const ya = Math.max(0, y0);
  for (let y = ya; y < y1; y++) {
    for (let x = xa; x < x1; x++) {
      tot++;
      if (landGrid[y * gridW + x]) land++;
    }
  }
  return tot > 0 ? land / tot : 0;
}

/**
 * @param {string} eventKey
 * @param {number} roundIndex
 * @param {number} playStartMs
 * @param {number} gridW
 * @param {number} gridH
 * @param {Uint8Array} landGrid
 * @param {number} [zoneScale=1]
 */
export function pickLandRectangle(eventKey, roundIndex, playStartMs, gridW, gridH, landGrid, zoneScale = 1) {
  const zs = Math.max(0.35, Math.min(1.35, zoneScale));
  const rng = mulberry32(mixSeed("rect", eventKey, roundIndex, playStartMs));
  const w = Math.max(8, Math.floor(gridW * (0.045 + rng() * 0.05) * zs));
  const h = Math.max(8, Math.floor(gridH * (0.045 + rng() * 0.05) * zs));
  for (let t = 0; t < 100; t++) {
    const x0 = Math.floor(rng() * Math.max(1, gridW - w));
    const y0 = Math.floor(rng() * Math.max(1, gridH - h));
    if (rectLandFraction(x0, y0, w, h, landGrid, gridW, gridH) >= 0.4) {
      return { x0, y0, w, h };
    }
  }
  return { x0: Math.max(0, ((gridW - w) / 2) | 0), y0: Math.max(0, ((gridH - h) / 2) | 0), w, h };
}

/**
 * @param {number} x
 * @param {number} y
 * @param {{ x0: number, y0: number, w: number, h: number }} rect
 */
export function pointInRect(x, y, rect) {
  if (!rect) return false;
  const x0 = rect.x0 | 0;
  const y0 = rect.y0 | 0;
  const w = rect.w | 0;
  const h = rect.h | 0;
  return x >= x0 && x < x0 + w && y >= y0 && y < y0 + h;
}

/**
 * Турнирное сжатие: центр / середина / край / внешнее кольцо.
 * @param {number} x
 * @param {number} y
 * @param {number} gridW
 * @param {number} gridH
 * @param {{
 *   centerMult: number;
 *   nonCenterMult: number;
 *   outerRingMult?: number | null;
 *   outerRingWidthCells?: number;
 * }} comp
 */
export function tournamentCompressionMultiplierForCell(x, y, gridW, gridH, comp) {
  if (!comp) return 1;
  const cx = (gridW - 1) / 2;
  const cy = (gridH - 1) / 2;
  const norm = (Math.abs(x - cx) + Math.abs(y - cy)) / Math.max(1, gridW + gridH);
  const edgeD = Math.min(x, y, gridW - 1 - x, gridH - 1 - y);
  const thC = 0.19;
  const inCenter = norm < thC;
  if (inCenter) return comp.centerMult;
  const ow = Math.max(
    1,
    Math.min(
      gridW,
      gridH,
      typeof comp.outerRingWidthCells === "number" ? comp.outerRingWidthCells | 0 : Math.max(1, Math.floor(Math.min(gridW, gridH) * 0.055))
    )
  );
  if (comp.outerRingMult != null && edgeD <= ow) return comp.outerRingMult;
  return comp.nonCenterMult;
}

/** @deprecated оставлено для совместимости импортов; делегирует tournamentCompressionMultiplierForCell с phaseT→краевые веса. */
export function mapCompressionMultiplierForCell(x, y, gridW, gridH, phaseT) {
  const t = Math.max(0, Math.min(1, phaseT));
  const comp = {
    centerMult: 1.25 + 0.25 * t,
    nonCenterMult: 0.7 - 0.2 * t,
    outerRingMult: null,
  };
  return tournamentCompressionMultiplierForCell(x, y, gridW, gridH, comp);
}

/** Фаза раунда: центр / край (базовые правила турнира). */
export function roundProgressionMultiplierForCell(x, y, roundIndex, gridW, gridH) {
  const ri = roundIndex | 0;
  let m = 1;
  if (ri >= 2) {
    const cx = (gridW - 1) / 2;
    const cy = (gridH - 1) / 2;
    const norm = (Math.abs(x - cx) + Math.abs(y - cy)) / Math.max(1, gridW + gridH);
    if (norm < 0.16) m *= 1.25;
  }
  if (ri >= 1) {
    const edge = Math.min(x, y, gridW - 1 - x, gridH - 1 - y);
    const thresh = Math.max(2, Math.floor(Math.min(gridW, gridH) * 0.045));
    if (edge <= thresh) m *= 0.75;
  }
  return m;
}

/**
 * @typedef {{
 *   mapCompression: {
 *     centerMult: number;
 *     nonCenterMult: number;
 *     outerRingMult: number | null;
 *     outerRingWidthCells: number;
 *   } | null;
 *   goldRect: { x0: number, y0: number, w: number, h: number } | null;
 *   goldUntilMs: number | null;
 *   goldUi: { title: string; subtitle: string; layerKind: string } | null;
 *   economicRects: { x0: number, y0: number, w: number, h: number; mult: number }[];
 *   economicUntilMs: number | null;
 *   economicUi: { title: string; subtitle: string; layerKind: string } | null;
 *   teamSynergy: { active: boolean; mult: number; minOnline: number } | null;
 *   synergyUntilMs: number | null;
 *   dramaticLayers: { eventId: string; title: string; subtitle: string; untilMs: number; style: string }[];
 *   mapCompressionUi: { title: string; subtitle: string } | null;
 * }} BattleScoringSnapshot
 */

/**
 * @param {number} nowMs
 * @param {{
 *   roundIndex: number;
 *   playStartMs: number;
 *   battleEndMs: number;
 *   gridW: number;
 *   gridH: number;
 *   landGrid: Uint8Array;
 * }} ctx
 * @returns {BattleScoringSnapshot}
 */
/**
 * @param {BattleScoringSnapshot} snap
 * @param {*} compState
 * @param {RoundTimelineEventDef} ev
 * @param {*} ctx
 * @param {number} play
 * @param {number} end
 * @param {number} nowMs
 * @param {number | null} untilOverrideMs если задано — дедлайн слоя (ручной режим), иначе из окна таймлайна
 */
function applyTimelineEventToSnapshotAndComp(snap, compState, ev, ctx, play, end, nowMs, untilOverrideMs) {
  const { roundIndex, gridW, gridH, landGrid } = ctx;
  const layerUntil =
    typeof untilOverrideMs === "number" && Number.isFinite(untilOverrideMs)
      ? Math.min(untilOverrideMs, end)
      : eventWindowEndMs(ev, play, end);

  switch (ev.eventType) {
    case "gold_zone": {
      const zs = typeof ev.payload?.zoneScale === "number" ? ev.payload.zoneScale : 1;
      const lk = typeof ev.payload?.layerKind === "string" ? ev.payload.layerKind : "gold_zone";
      const rectKey = `${ev.eventId}`;
      snap.goldRect = pickLandRectangle(rectKey, roundIndex, play, gridW, gridH, landGrid, zs);
      snap.goldUntilMs = layerUntil;
      snap.goldUi = {
        title: ev.uiTitle,
        subtitle: ev.uiSubtitle,
        layerKind: lk,
      };
      break;
    }
    case "economic_mixed": {
      const salt = typeof ev.payload?.rectSalt === "string" ? ev.payload.rectSalt : "";
      snap.economicRects.push(
        {
          ...pickLandRectangle(`${ev.eventId}_b${salt}`, roundIndex, play, gridW, gridH, landGrid),
          mult: 1.5,
        },
        {
          ...pickLandRectangle(`${ev.eventId}_r${salt}`, roundIndex, play, gridW, gridH, landGrid),
          mult: 0.5,
        }
      );
      snap.economicUntilMs = layerUntil;
      snap.economicUi = {
        title: ev.uiTitle,
        subtitle: ev.uiSubtitle,
        layerKind: typeof ev.payload?.clientKind === "string" ? ev.payload.clientKind : "economic_shift",
      };
      break;
    }
    case "economic_boom_only": {
      snap.economicRects.push({
        ...pickLandRectangle(`${ev.eventId}_boom`, roundIndex, play, gridW, gridH, landGrid, 0.85),
        mult: 1.5,
      });
      snap.economicUntilMs = layerUntil;
      snap.economicUi = {
        title: ev.uiTitle,
        subtitle: ev.uiSubtitle,
        layerKind: "resource_surge",
      };
      break;
    }
    case "map_compression":
    case "center_bonus": {
      const p = ev.payload || {};
      const cm = typeof p.centerMult === "number" ? p.centerMult : 1.5;
      const nm = typeof p.nonCenterMult === "number" ? p.nonCenterMult : 0.5;
      compState.centerMult = cm;
      compState.nonCenterMult = nm;
      snap.mapCompressionUi = { title: ev.uiTitle, subtitle: ev.uiSubtitle };
      if (typeof p.finalRingLastMs === "number" && typeof p.finalRingMult === "number") {
        compState.finalRingLastMs = p.finalRingLastMs;
        compState.finalRingMult = p.finalRingMult;
      }
      break;
    }
    case "final_edge_compression": {
      const or = typeof ev.payload?.outerRingMult === "number" ? ev.payload.outerRingMult : 0.25;
      compState.outerRingMult = or;
      snap.mapCompressionUi = { title: ev.uiTitle, subtitle: ev.uiSubtitle };
      break;
    }
    case "team_synergy": {
      const mult = typeof ev.payload?.mult === "number" ? ev.payload.mult : 1.12;
      const minO = typeof ev.payload?.minOnlineMembers === "number" ? ev.payload.minOnlineMembers : 2;
      snap.teamSynergy = { active: true, mult, minOnline: minO };
      snap.synergyUntilMs = layerUntil;
      break;
    }
    case "dramatic_pressure": {
      snap.dramaticLayers.push({
        eventId: ev.eventId,
        title: ev.uiTitle,
        subtitle: ev.uiSubtitle,
        untilMs: layerUntil,
        style: typeof ev.payload?.style === "string" ? ev.payload.style : "pressure",
      });
      break;
    }
    default:
      break;
  }
}

function finalizeCompressionOnSnap(snap, compState, nowMs, end) {
  if (compState.centerMult !== 1 || compState.nonCenterMult !== 1 || compState.outerRingMult != null) {
    let outerRingMult = compState.outerRingMult;
    if (
      typeof compState.finalRingLastMs === "number" &&
      typeof compState.finalRingMult === "number" &&
      nowMs >= end - compState.finalRingLastMs
    ) {
      outerRingMult = compState.finalRingMult;
    }
    snap.mapCompression = {
      centerMult: compState.centerMult,
      nonCenterMult: compState.nonCenterMult,
      outerRingMult,
      outerRingWidthCells: compState.outerRingWidthCells,
    };
  }
}

function compStateFromExistingSnap(snap, gridW, gridH) {
  const mc = snap.mapCompression;
  return {
    centerMult: mc?.centerMult ?? 1,
    nonCenterMult: mc?.nonCenterMult ?? 1,
    outerRingMult: mc?.outerRingMult ?? null,
    outerRingWidthCells:
      mc?.outerRingWidthCells ?? Math.max(1, Math.floor(Math.min(gridW, gridH) * 0.06)),
    finalRingLastMs: undefined,
    finalRingMult: undefined,
  };
}

/**
 * Ручные слоты: { cmd, untilMs } — до какого времени (ms) событие считается включённым.
 * @param {BattleScoringSnapshot} snap
 * @param {{ cmd: string, untilMs: number }[]} slots
 * @param {number} nowMs
 * @param {{ roundIndex: number, playStartMs: number, battleEndMs: number, gridW: number, gridH: number, landGrid: Uint8Array }} ctx
 */
export function mergeManualBattleSlotsIntoSnapshot(snap, slots, nowMs, ctx) {
  if (!slots?.length) return;
  const play = ctx.playStartMs;
  const end = ctx.battleEndMs;
  const { gridW, gridH } = ctx;

  const active = slots.filter((s) => s && typeof s.untilMs === "number" && s.untilMs > nowMs);
  if (!active.length) return;

  let stripEconomicFromTimeline = false;
  let stripDramaticFromTimeline = false;
  for (let i = 0; i < active.length; i++) {
    const def = resolveManualBattleCommandToTimelineDef(active[i].cmd, ctx.roundIndex);
    if (!def) continue;
    if (def.eventType === "economic_mixed" || def.eventType === "economic_boom_only") {
      stripEconomicFromTimeline = true;
    }
    if (def.eventType === "dramatic_pressure") stripDramaticFromTimeline = true;
  }
  if (stripEconomicFromTimeline) {
    snap.economicRects = [];
    snap.economicUntilMs = null;
    snap.economicUi = null;
  }
  if (stripDramaticFromTimeline) {
    snap.dramaticLayers = [];
  }

  let compState = compStateFromExistingSnap(snap, gridW, gridH);

  for (let si = 0; si < active.length; si++) {
    const slot = active[si];
    const def = resolveManualBattleCommandToTimelineDef(slot.cmd, ctx.roundIndex);
    if (!def) continue;
    applyTimelineEventToSnapshotAndComp(snap, compState, def, ctx, play, end, nowMs, slot.untilMs);
  }

  finalizeCompressionOnSnap(snap, compState, nowMs, end);
}

/**
 * Шаблон события из таймлайна текущего (или запасного) раунда по ключу команды бота.
 * @param {string} cmd нормализованный ключ (латиница)
 * @param {number} roundIndex
 * @returns {RoundTimelineEventDef | null}
 */
export function resolveManualBattleCommandToTimelineDef(cmd, roundIndex) {
  const c = String(cmd || "")
    .toLowerCase()
    .trim()
    .replace(/^\/+/, "");
  const ri = Math.min(Math.max(roundIndex | 0, 0), 3);
  const tl = getRoundTimeline(ri);
  const clone = (/** @type {RoundTimelineEventDef} */ ev) =>
    /** @type {RoundTimelineEventDef} */ (JSON.parse(JSON.stringify(ev)));

  const find = (/** @type {string} */ type) => {
    const ev = tl.find((e) => e.eventType === type);
    return ev ? clone(ev) : null;
  };
  const findInRound = (/** @type {number} */ r, /** @type {string} */ type) => {
    const t = getRoundTimeline(r);
    const ev = t.find((e) => e.eventType === type);
    return ev ? clone(ev) : null;
  };

  if (c === "gold" || c === "золото") {
    const ev = find("gold_zone");
    if (ev) ev.eventId = `manual_gold_r${ri}`;
    return ev;
  }
  if (c === "target") {
    const ev = findInRound(1, "gold_zone") || find("gold_zone");
    if (ev) ev.eventId = "manual_target";
    return ev;
  }
  if (c === "duelzone" || c === "duel") {
    const ev = findInRound(2, "gold_zone") || find("gold_zone");
    if (ev) ev.eventId = "manual_duelzone";
    return ev;
  }
  if (c === "economic" || c === "shift") {
    const ev = find("economic_mixed") || findInRound(0, "economic_mixed");
    if (ev) ev.eventId = `manual_economic_r${ri}`;
    return ev;
  }
  if (c === "rotation") {
    const ev = findInRound(1, "economic_mixed") || find("economic_mixed");
    if (ev) ev.eventId = "manual_rotation";
    return ev;
  }
  if (c === "boom" || c === "surge") {
    let ev = find("economic_boom_only");
    if (!ev) ev = findInRound(2, "economic_boom_only");
    if (ev) ev.eventId = `manual_boom_r${ri}`;
    return ev;
  }
  if (c === "mapcomp" || c === "compression") {
    const ev = find("map_compression") || find("center_bonus");
    if (ev) ev.eventId = `manual_mapcomp_r${ri}`;
    return ev;
  }
  if (c === "center" || c === "centerbonus") {
    const ev = find("center_bonus") || find("map_compression");
    if (ev) ev.eventId = "manual_centerbonus";
    return ev;
  }
  if (c === "finaledge" || c === "edge") {
    let ev = find("final_edge_compression");
    if (!ev) ev = findInRound(0, "final_edge_compression");
    if (ev) ev.eventId = "manual_finaledge";
    return ev;
  }
  if (c === "synergy") {
    const ev = find("team_synergy") || findInRound(1, "team_synergy");
    if (ev) ev.eventId = `manual_synergy_r${ri}`;
    return ev;
  }
  if (c === "dramatic" || c === "pressure") {
    const ev = find("dramatic_pressure");
    if (ev) {
      ev.eventId = `manual_dramatic_r${ri}`;
    }
    return ev;
  }
  if (c === "finalhour") {
    const ev =
      tl.find((e) => e.eventType === "dramatic_pressure" && e.payload?.style === "final_hour") ||
      find("dramatic_pressure");
    if (ev) ev.eventId = "manual_finalhour";
    return ev;
  }
  if (c === "finalten") {
    const ev =
      tl.find((e) => e.eventType === "dramatic_pressure" && e.payload?.style === "final_ten") ||
      findInRound(3, "dramatic_pressure") ||
      find("dramatic_pressure");
    if (ev) ev.eventId = "manual_finalten";
    return ev;
  }
  return null;
}

/** Текст справки по командам (для бота). */
export const MANUAL_BATTLE_EVENT_HELP_RU = `Команды (админ, во время боя). Префикс evt необязателен.

ЗОЛОТО / ЗОНЫ
  gold — золотая зона (как в таймлайне текущего раунда)
  target — целевая зона (шаблон полуфинала)
  duelzone — зона дуэли (шаблон финала команд)

ЭКОНОМИКА
  economic или shift — две зоны ±множитель (массовый раунд)
  rotation — экономическое вращение (полуфинал)
  boom или surge — только «бум»-регион

КАРТА
  mapcomp — сжатие карты (центр сильнее)
  center / centerbonus — бонус центра (дуэль)
  finaledge / edge — внешнее кольцо обесценено (массовый)

КОМАНДА / АТМОСФЕРА
  synergy — синергия команд
  dramatic / pressure — драматический баннер
  finalhour — фаза «финальный час»
  finalten — «финальные 10 минут»

Отключить одно: gold off, mapcomp off, …
Снять всё: evt off
Список: evt help`;

/** Первые слова ручных команд в чате бота (как в server.js → handleTelegramManualBattleCommand). */
export const MANUAL_TELEGRAM_CMD_FIRST_WORDS = new Set([
  "gold",
  "target",
  "duelzone",
  "duel",
  "economic",
  "shift",
  "rotation",
  "boom",
  "surge",
  "mapcomp",
  "compression",
  "center",
  "centerbonus",
  "finaledge",
  "edge",
  "synergy",
  "dramatic",
  "pressure",
  "finalhour",
  "finalten",
  "seismic",
  "help",
  "list",
  "золото",
  "evt",
  "event",
]);

export function computeBattleScoringSnapshot(nowMs, ctx) {
  const play = ctx.playStartMs;
  const end = ctx.battleEndMs;
  const span = end - play;
  /** @type {BattleScoringSnapshot} */
  const snap = {
    mapCompression: null,
    goldRect: null,
    goldUntilMs: null,
    goldUi: null,
    economicRects: [],
    economicUntilMs: null,
    economicUi: null,
    teamSynergy: null,
    synergyUntilMs: null,
    dramaticLayers: [],
    mapCompressionUi: null,
  };
  if (span <= 0 || nowMs < play || nowMs >= end) return snap;

  const { roundIndex, gridW, gridH } = ctx;
  const timeline = getRoundTimeline(roundIndex);

  /** @type {{ centerMult: number; nonCenterMult: number; outerRingMult: number | null; outerRingWidthCells: number; finalRingLastMs?: number; finalRingMult?: number }} */
  let compState = {
    centerMult: 1,
    nonCenterMult: 1,
    outerRingMult: null,
    outerRingWidthCells: Math.max(1, Math.floor(Math.min(gridW, gridH) * 0.06)),
  };

  for (let i = 0; i < timeline.length; i++) {
    const ev = timeline[i];
    if (!isEventActiveAt(nowMs, play, end, ev)) continue;
    applyTimelineEventToSnapshotAndComp(snap, compState, ev, ctx, play, end, nowMs, null);
  }

  finalizeCompressionOnSnap(snap, compState, nowMs, end);

  return snap;
}

/**
 * @param {BattleScoringSnapshot} snap
 * @param {number} nowMs
 * @param {number} battleEndMs
 */
export function buildBattleEventsClientPayload(snap, nowMs, battleEndMs) {
  /** @type {object[]} */
  const layers = [];

  if (snap.goldRect && snap.goldUntilMs != null && snap.goldUi) {
    layers.push({
      kind: snap.goldUi.layerKind,
      title: snap.goldUi.title,
      subtitle: snap.goldUi.subtitle,
      untilMs: snap.goldUntilMs,
      rect: snap.goldRect,
      style: "gold",
    });
  }

  if (snap.mapCompression && battleEndMs > nowMs) {
    const ui = snap.mapCompressionUi;
    layers.push({
      kind: "map_compression",
      title: ui?.title || "MAP COMPRESSION",
      subtitle: ui?.subtitle || "Center is worth more · edges are weaker",
      untilMs: battleEndMs,
      compression: snap.mapCompression,
      style: "compression",
    });
  }

  if (snap.economicRects.length && snap.economicUntilMs != null && snap.economicUi) {
    const ui = snap.economicUi;
    const isDual = snap.economicRects.length > 1;
    layers.push({
      kind: ui.layerKind,
      title: ui.title,
      subtitle: ui.subtitle,
      untilMs: snap.economicUntilMs,
      rects: snap.economicRects.map((r) => ({
        x0: r.x0,
        y0: r.y0,
        w: r.w,
        h: r.h,
        mult: r.mult,
      })),
      rect: !isDual ? snap.economicRects[0] : undefined,
      style: isDual ? "economic_dual" : snap.economicRects[0].mult > 1 ? "boom" : "recession",
    });
  }

  if (snap.teamSynergy?.active && snap.synergyUntilMs != null) {
    layers.push({
      kind: "team_synergy",
      title: "TEAM SYNERGY ACTIVE",
      subtitle: `≥${snap.teamSynergy.minOnline} members online: +${Math.round((snap.teamSynergy.mult - 1) * 100)}% territory score`,
      untilMs: snap.synergyUntilMs,
      style: "synergy",
      synergyMult: snap.teamSynergy.mult,
    });
  }

  for (let d = 0; d < snap.dramaticLayers.length; d++) {
    const dl = snap.dramaticLayers[d];
    layers.push({
      kind: "dramatic_pressure",
      title: dl.title,
      subtitle: dl.subtitle,
      untilMs: dl.untilMs,
      style: dl.style,
      dramatic: true,
    });
  }

  const primary = pickPrimaryBannerLayer(layers);
  return {
    serverNow: nowMs,
    active: layers.length > 0,
    layers,
    primary,
    battleEndsAt: battleEndMs,
  };
}

/**
 * @param {object[]} layers
 */
function pickPrimaryBannerLayer(layers) {
  const order = [
    "gold_zone",
    "target_zone",
    "duel_zone",
    "economic_shift",
    "economic_rotation",
    "resource_surge",
    "team_synergy",
    "dramatic_pressure",
    "map_compression",
  ];
  for (const k of order) {
    const f = layers.find((l) => l.kind === k);
    if (f) return f;
  }
  return layers[0] || null;
}

/**
 * Следующее событие после nowMs (для отладки).
 */
export function getNextTimelineEvent(nowMs, roundIndex, playStartMs, battleEndMs) {
  const timeline = getRoundTimeline(roundIndex);
  const elapsed = nowMs - playStartMs;
  if (nowMs < playStartMs) {
    return { label: "waiting_play", next: timeline[0] || null, startsInMs: playStartMs - nowMs };
  }
  for (let i = 0; i < timeline.length; i++) {
    const ev = timeline[i];
    if (elapsed < ev.startOffsetMs) {
      return { label: "upcoming", next: ev, startsInMs: playStartMs + ev.startOffsetMs - nowMs };
    }
    const wEnd = eventWindowEndMs(ev, playStartMs, battleEndMs);
    if (nowMs < wEnd && ev.eventType !== "seismic") {
      return { label: "active_window", next: ev, endsInMs: wEnd - nowMs };
    }
  }
  return { label: "none", next: null };
}

/**
 * @param {number} roundIndex
 * @param {number} playStartMs
 * @param {string} eventId
 * @param {number} gridW
 * @param {number} gridH
 * @param {Uint8Array} landGrid
 * @param {Uint8Array} protectedMask
 */
export function computeSeismicManhattanBalls(roundIndex, playStartMs, eventId, gridW, gridH, landGrid, protectedMask) {
  const rng = mulberry32(mixSeed("seismic", eventId, roundIndex, playStartMs));
  const balls = [];
  const R1 = 14 + Math.floor(rng() * 10);
  const R2 = 12 + Math.floor(rng() * 10);
  const minDist = Math.floor(Math.min(gridW, gridH) * 0.28);

  function pickCenter() {
    for (let t = 0; t < 200; t++) {
      const x = Math.floor(rng() * gridW);
      const y = Math.floor(rng() * gridH);
      const i = y * gridW + x;
      if (!landGrid[i] || protectedMask[i]) continue;
      return { x, y };
    }
    return null;
  }

  const c1 = pickCenter();
  if (!c1) return [];
  balls.push({ cx: c1.x, cy: c1.y, r: R1 });
  for (let t = 0; t < 300; t++) {
    const c2 = pickCenter();
    if (!c2) break;
    const dist = Math.abs(c2.x - c1.x) + Math.abs(c2.y - c1.y);
    if (dist >= minDist) {
      balls.push({ cx: c2.x, cy: c2.y, r: R2 });
      break;
    }
  }
  return balls;
}

/**
 * @param {{ cx: number, cy: number, r: number }} ball
 * @param {Uint8Array} landGrid
 * @param {Uint8Array} protectedMask
 * @param {number} gridW
 * @param {number} gridH
 * @returns {[number, number][]}
 */
export function cellsInManhattanBall(ball, landGrid, protectedMask, gridW, gridH) {
  const out = [];
  const { cx, cy, r } = ball;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (Math.abs(dx) + Math.abs(dy) > r) continue;
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= gridW || y >= gridH) continue;
      const i = y * gridW + x;
      if (!landGrid[i] || protectedMask[i]) continue;
      out.push([x, y]);
    }
  }
  return out;
}

/** Экспорт для обратной совместимости имён. */
export const DEFAULT_BATTLE_EVENT_SCHEDULE = [];
