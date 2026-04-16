/**
 * Турнир: таймлайн событий по раундам (смещения от начала боя, не от разминки).
 * Клиент импортирует только расчёт множителей и геометрию.
 */

/** Максимум очков с одной клетки после всех модификаторов. */
export const MAX_CELL_SCORE = 3;

/** Длительность ручного события из бота по умолчанию (если не указаны минуты в команде). */
export const MANUAL_BATTLE_EVENT_DEFAULT_DURATION_MS = 20 * 60 * 1000;

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
  // ——— Round 0 (mass): бой 5 h после разминки; слои по 20 мин; пять сейсмик по таймлайну (порядок по startOffsetMs).
  [
    {
      eventId: "r0_gold_zone",
      eventType: "gold_zone",
      startOffsetMs: 15 * MIN,
      durationMs: 20 * MIN,
      uiTitle: "Золотая зона",
      uiSubtitle: "Клетки в зоне дают вдвое больше очков",
      payload: { zoneScale: 1, layerKind: "gold_zone" },
    },
    {
      eventId: "r0_seismic_1",
      eventType: "seismic",
      startOffsetMs: 40 * MIN,
      durationMs: 0,
      warnLeadMs: 4500,
      uiTitle: "Сейсмика",
      uiSubtitle: "Удар по карте — часть захваченных клеток исчезнет",
      payload: { aftermathMs: 20_000 },
    },
    {
      eventId: "r0_economic_shift",
      eventType: "economic_mixed",
      startOffsetMs: 45 * MIN,
      durationMs: 20 * MIN,
      uiTitle: "Экономический сдвиг",
      uiSubtitle: "В разных регионах очки стоят по-разному",
      payload: { clientKind: "economic_shift" },
    },
    {
      eventId: "r0_seismic_2",
      eventType: "seismic",
      startOffsetMs: 70 * MIN,
      durationMs: 0,
      warnLeadMs: 4500,
      uiTitle: "Сейсмика",
      uiSubtitle: "Удар по карте — часть захваченных клеток исчезнет",
      payload: { aftermathMs: 20_000 },
    },
    {
      eventId: "r0_team_synergy",
      eventType: "team_synergy",
      startOffsetMs: 75 * MIN,
      durationMs: 20 * MIN,
      uiTitle: "Командная синергия",
      uiSubtitle: "Согласованным командам — бонус к очкам территории (≥2 онлайн: +12%)",
      payload: { mult: 1.12, minOnlineMembers: 2 },
    },
    {
      eventId: "r0_seismic_3",
      eventType: "seismic",
      startOffsetMs: 100 * MIN,
      durationMs: 0,
      warnLeadMs: 4500,
      uiTitle: "Сейсмика",
      uiSubtitle: "Удар по карте — часть захваченных клеток исчезнет",
      payload: { aftermathMs: 20_000 },
    },
    {
      eventId: "r0_resource_surge",
      eventType: "economic_boom_only",
      startOffsetMs: 110 * MIN,
      durationMs: 20 * MIN,
      uiTitle: "Всплеск ресурсов",
      uiSubtitle: "Один регион стал ценнее",
      payload: { clientKind: "resource_surge" },
    },
    {
      eventId: "r0_seismic_4",
      eventType: "seismic",
      startOffsetMs: 135 * MIN,
      durationMs: 0,
      warnLeadMs: 4500,
      uiTitle: "Сейсмика",
      uiSubtitle: "Удар по карте — часть захваченных клеток исчезнет",
      payload: { aftermathMs: 20_000 },
    },
    {
      eventId: "r0_map_compression",
      eventType: "map_compression",
      startOffsetMs: 160 * MIN,
      durationMs: 20 * MIN,
      uiTitle: "Сжатие карты",
      uiSubtitle: "Центр ценнее, края слабее",
      payload: { centerMult: 1.5, nonCenterMult: 0.5 },
    },
    {
      eventId: "r0_seismic_5",
      eventType: "seismic",
      startOffsetMs: 182 * MIN,
      durationMs: 0,
      warnLeadMs: 4500,
      uiTitle: "Сейсмика",
      uiSubtitle: "Удар по карте — часть захваченных клеток исчезнет",
      payload: { aftermathMs: 20_000 },
    },
    {
      eventId: "r0_center_bonus_soft",
      eventType: "center_bonus",
      startOffsetMs: 190 * MIN,
      durationMs: 20 * MIN,
      uiTitle: "Бонус центра",
      uiSubtitle: "Центр карты временно ценнее",
      payload: { centerMult: 1.5, nonCenterMult: 1 },
    },
    {
      eventId: "r0_final_compression",
      eventType: "final_edge_compression",
      startOffsetMs: 225 * MIN,
      durationMs: 20 * MIN,
      uiTitle: "Финальная фаза",
      uiSubtitle: "Периферия почти не даёт очков",
      payload: { outerRingMult: 0.25 },
    },
    {
      eventId: "r0_dramatic_late",
      eventType: "dramatic_pressure",
      startOffsetMs: 280 * MIN,
      durationMs: 20 * MIN,
      uiTitle: "Финальные 20 минут",
      uiSubtitle: "Решается всё",
      payload: { style: "final_ten" },
    },
  ],
  // ——— Round 1 (teams ≤10): 4h ——— (смещения ×4/5 от схемы 5h)
  [
    {
      eventId: "r1_gold_zone",
      eventType: "gold_zone",
      startOffsetMs: Math.round(1 * H * (4 / 5)),
      durationMs: Math.round(25 * MIN * (4 / 5)),
      uiTitle: "Целевая зона",
      uiSubtitle: "Захват зоны даёт бонус к очкам",
      payload: { zoneScale: 0.72, layerKind: "target_zone" },
    },
    {
      eventId: "r1_economic_rotation",
      eventType: "economic_mixed",
      startOffsetMs: Math.round((2 * H + 30 * MIN) * (4 / 5)),
      durationMs: Math.round(25 * MIN * (4 / 5)),
      uiTitle: "Экономическое вращение",
      uiSubtitle: "Приоритеты начисления очков сместились",
      payload: { clientKind: "economic_rotation", rectSalt: "rot" },
    },
    {
      eventId: "r1_team_synergy",
      eventType: "team_synergy",
      startOffsetMs: Math.round((3 * H + 30 * MIN) * (4 / 5)),
      durationMs: Math.round(20 * MIN * (4 / 5)),
      uiTitle: "Командная синергия",
      uiSubtitle: "Согласованным командам — бонус к очкам территории (≥2 онлайн: +12%)",
      payload: { mult: 1.12, minOnlineMembers: 2 },
    },
    {
      eventId: "r1_map_compression",
      eventType: "map_compression",
      startOffsetMs: Math.round((4 * H + 30 * MIN) * (4 / 5)),
      durationMs: null,
      uiTitle: "Финальная фаза",
      uiSubtitle: "Битва за центр",
      payload: { centerMult: 1.5, nonCenterMult: 0.5 },
    },
  ],
  // ——— Round 2 (duo): 3h ——— (смещения ×3/4 от схемы 4h)
  [
    {
      eventId: "r2_gold_zone",
      eventType: "gold_zone",
      startOffsetMs: Math.round(1 * H * (3 / 4)),
      durationMs: Math.round(20 * MIN * (3 / 4)),
      uiTitle: "Зона дуэли",
      uiSubtitle: "Клетки в зоне дают двойные очки",
      payload: { zoneScale: 0.58, layerKind: "duel_zone" },
    },
    {
      eventId: "r2_resource_surge",
      eventType: "economic_boom_only",
      startOffsetMs: Math.round(2 * H * (3 / 4)),
      durationMs: Math.round(20 * MIN * (3 / 4)),
      uiTitle: "Всплеск ресурсов",
      uiSubtitle: "Один регион стал ценнее",
      payload: { clientKind: "resource_surge" },
    },
    {
      eventId: "r2_map_compression",
      eventType: "map_compression",
      startOffsetMs: Math.round((2 * H + 30 * MIN) * (3 / 4)),
      durationMs: null,
      uiTitle: "Сжатие карты",
      uiSubtitle: "Поле боя сжимается",
      payload: {
        centerMult: 1.5,
        nonCenterMult: 0.5,
      },
    },
    {
      eventId: "r2_final_hour_pressure",
      eventType: "dramatic_pressure",
      startOffsetMs: Math.round((3 * H + 30 * MIN) * (3 / 4)),
      durationMs: null,
      uiTitle: "Финальный час",
      uiSubtitle: "Каждое очко на счету",
      payload: { style: "final_hour" },
    },
  ],
  // ——— Final 1v1: 2 h ———
  // Timings: Center bonus 20m→end | Map compression 45m→end | Final 10 min 65m→end
  [
    {
      eventId: "r3_center_bonus",
      eventType: "center_bonus",
      startOffsetMs: 20 * MIN /* → round end */,
      durationMs: null,
      uiTitle: "Бонус центра",
      uiSubtitle: "Центр карты ценнее",
      payload: { centerMult: 1.5, nonCenterMult: 1 },
    },
    {
      eventId: "r3_map_compression",
      eventType: "map_compression",
      startOffsetMs: 45 * MIN /* → round end */,
      durationMs: null,
      uiTitle: "Сжатие карты",
      uiSubtitle: "Край карты дешевеет",
      payload: { centerMult: 1.5, nonCenterMult: 0.5 },
    },
    {
      eventId: "r3_final_ten_pressure",
      eventType: "dramatic_pressure",
      startOffsetMs: 65 * MIN /* → round end */,
      durationMs: null,
      uiTitle: "Финальные 10 минут",
      uiSubtitle: "Решается всё",
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

/** Префиксные суммы по суше (1 = клетка суши) для O(1) подсчёта клеток в прямоугольнике. */
function buildLandPrefixSums(landGrid, gridW, gridH) {
  const P = new Int32Array((gridW + 1) * (gridH + 1));
  for (let y = 1; y <= gridH; y++) {
    for (let x = 1; x <= gridW; x++) {
      const v = landGrid[(y - 1) * gridW + (x - 1)] ? 1 : 0;
      const up = P[(y - 1) * (gridW + 1) + x];
      const left = P[y * (gridW + 1) + (x - 1)];
      const diag = P[(y - 1) * (gridW + 1) + (x - 1)];
      P[y * (gridW + 1) + x] = v + up + left - diag;
    }
  }
  return P;
}

function rectLandCellCountPrefix(P, gridW, x0, y0, w, h) {
  const x1 = x0 + w;
  const y1 = y0 + h;
  return (
    P[y1 * (gridW + 1) + x1] -
    P[y0 * (gridW + 1) + x1] -
    P[y1 * (gridW + 1) + x0] +
    P[y0 * (gridW + 1) + x0]
  );
}

/**
 * Детерминированный поиск первого полностью сухопутного прямоугольника (fallback).
 * @returns {{ x0: number, y0: number, w: number, h: number } | null}
 */
function findFirstAllLandRectangle(P, gridW, gridH, wTarget, hTarget) {
  const wMax = Math.min(Math.max(4, wTarget | 0), gridW);
  const hMax = Math.min(Math.max(4, hTarget | 0), gridH);
  for (let w = wMax; w >= 4; w--) {
    for (let h = hMax; h >= 4; h--) {
      if (w > gridW || h > gridH) continue;
      const need = w * h;
      for (let y0 = 0; y0 <= gridH - h; y0++) {
        for (let x0 = 0; x0 <= gridW - w; x0++) {
          if (rectLandCellCountPrefix(P, gridW, x0, y0, w, h) === need) {
            return { x0, y0, w, h };
          }
        }
      }
    }
  }
  return null;
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
  const w0 = Math.max(8, Math.floor(gridW * (0.045 + rng() * 0.05) * zs));
  const h0 = Math.max(8, Math.floor(gridH * (0.045 + rng() * 0.05) * zs));

  for (let shrink = 0; shrink < 14; shrink++) {
    const w = Math.max(4, Math.floor(w0 * Math.pow(0.88, shrink)));
    const h = Math.max(4, Math.floor(h0 * Math.pow(0.88, shrink)));
    if (w > gridW || h > gridH) continue;
    const tries = shrink === 0 ? 320 : 160;
    for (let t = 0; t < tries; t++) {
      const x0 = Math.floor(rng() * Math.max(1, gridW - w));
      const y0 = Math.floor(rng() * Math.max(1, gridH - h));
      if (rectLandFraction(x0, y0, w, h, landGrid, gridW, gridH) >= 1) {
        return { x0, y0, w, h };
      }
    }
  }

  const P = buildLandPrefixSums(landGrid, gridW, gridH);
  const found = findFirstAllLandRectangle(P, gridW, gridH, w0, h0);
  if (found) return found;

  const tiny = findFirstAllLandRectangle(P, gridW, gridH, 6, 6);
  if (tiny) return tiny;

  return { x0: 0, y0: 0, w: Math.min(4, gridW), h: Math.min(4, gridH) };
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
 *   mapCompressionUntilMs: number | null;
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
function mergeMapCompressionUntilMs(snap, layerUntil) {
  if (typeof layerUntil !== "number" || !Number.isFinite(layerUntil)) return;
  snap.mapCompressionUntilMs =
    snap.mapCompressionUntilMs == null
      ? layerUntil
      : Math.min(snap.mapCompressionUntilMs, layerUntil);
}

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
      mergeMapCompressionUntilMs(snap, layerUntil);
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
      mergeMapCompressionUntilMs(snap, layerUntil);
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

  snap.mapCompressionUntilMs = null;

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
 * Ручной слот того же класса, что и событие таймлайна, отключает автослой (золото, экономика, …).
 * @param {RoundTimelineEventDef} ev
 * @param {{ cmd: string, untilMs: number }[]} manualSlots
 */
export function isTimelineEventSuppressedByManual(ev, manualSlots) {
  if (!manualSlots?.length) return false;
  const cmds = new Set(manualSlots.map((s) => String(s.cmd || "").toLowerCase()));
  const has = (...names) => names.some((n) => cmds.has(n));
  switch (ev.eventType) {
    case "gold_zone":
      return has("gold", "target", "duelzone", "duel", "золото", "голд");
    case "economic_mixed":
    case "economic_boom_only":
      return has("economic", "shift", "rotation", "boom", "surge");
    case "map_compression":
    case "center_bonus":
    case "final_edge_compression":
      return has("mapcomp", "compression", "center", "centerbonus", "finaledge", "edge");
    case "team_synergy":
      return has("synergy");
    case "dramatic_pressure":
      return has("dramatic", "pressure", "finalhour", "finalten");
    default:
      return false;
  }
}

/**
 * Окна таймлайна текущего раунда (после mergeManual). Сейсмика только через battleEventsApplied / бот.
 * @param {BattleScoringSnapshot} snap
 * @param {number} nowMs
 * @param {{ roundIndex: number, playStartMs: number, battleEndMs: number, gridW: number, gridH: number, landGrid: Uint8Array }} ctx
 * @param {Record<string, unknown>} cancelledEventIds eventId → истина = снято админом (evt … off)
 * @param {{ cmd: string, untilMs: number }[]} manualSlots
 */
export function mergeAutoTimelineEventsIntoSnapshot(snap, nowMs, ctx, cancelledEventIds, manualSlots) {
  const play = ctx.playStartMs;
  const end = ctx.battleEndMs;
  if (nowMs < play || nowMs >= end) return;

  const tl = getRoundTimeline(ctx.roundIndex);
  /** @type {RoundTimelineEventDef[]} */
  const active = [];
  for (let i = 0; i < tl.length; i++) {
    const ev = tl[i];
    if (!ev || ev.eventType === "seismic") continue;
    if (cancelledEventIds && cancelledEventIds[ev.eventId]) continue;
    if (isTimelineEventSuppressedByManual(ev, manualSlots)) continue;
    const startAt = play + (ev.startOffsetMs | 0);
    const wEnd = eventWindowEndMs(ev, play, end);
    if (nowMs >= startAt && nowMs < wEnd) active.push(ev);
  }
  if (!active.length) return;
  active.sort((a, b) => (a.startOffsetMs | 0) - (b.startOffsetMs | 0));

  let compState = compStateFromExistingSnap(snap, ctx.gridW, ctx.gridH);
  for (let j = 0; j < active.length; j++) {
    const ev = active[j];
    const layerUntil = eventWindowEndMs(ev, play, end);
    applyTimelineEventToSnapshotAndComp(snap, compState, ev, ctx, play, end, nowMs, layerUntil);
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

  if (c === "gold" || c === "золото" || c === "голд") {
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

/**
 * Какие eventId в таймлайне текущего раунда отключаются командой «evt CMD off» (по типу события).
 * @param {string} cmd нормализованный ключ как у resolveManualBattleCommandToTimelineDef
 * @param {number} roundIndex
 * @returns {string[]}
 */
export function listTimelineEventIdsForManualCmd(cmd, roundIndex) {
  const def = resolveManualBattleCommandToTimelineDef(cmd, roundIndex);
  if (!def) return [];
  const tl = getRoundTimeline(roundIndex);
  const out = [];
  for (let i = 0; i < tl.length; i++) {
    if (tl[i].eventType === def.eventType) out.push(tl[i].eventId);
  }
  return out;
}

/** Текст справки по командам (для бота). */
export const MANUAL_BATTLE_EVENT_HELP_RU = `Команды (админ, во время боя). Префикс evt / event / события необязателен; gold можно писать как золото или голд.
Автотаймлайн раунда включён: золото, экономика, сжатие и др. сами по расписанию. Ручная команда EVT включает то же событие поверх таймлайна (и подавляет автослой этого типа, пока слот активен).
Отменить автособытие на этот бой: так же, как раньше — «gold off», «economic off», «mapcomp off» и т.д. (снимается и ручной слот, и пункт таймлайна с тем же типом).
По умолчанию ручной слот длится 20 минут (или до конца боя). Своя длительность: gold 45 (минут).

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
  "голд",
  "evt",
  "event",
  "события",
  "событие",
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
    mapCompressionUntilMs: null,
  };
  if (span <= 0 || nowMs < play || nowMs >= end) return snap;

  const { gridW, gridH } = ctx;

  /** @type {{ centerMult: number; nonCenterMult: number; outerRingMult: number | null; outerRingWidthCells: number; finalRingLastMs?: number; finalRingMult?: number }} */
  const compState = {
    centerMult: 1,
    nonCenterMult: 1,
    outerRingMult: null,
    outerRingWidthCells: Math.max(1, Math.floor(Math.min(gridW, gridH) * 0.06)),
  };

  /* Слои карты по таймлайну: mergeAutoTimelineEventsIntoSnapshot (после ручных слотов) в server.js. */

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

  if (snap.goldRect && snap.goldUntilMs != null && snap.goldUi && snap.goldUntilMs > nowMs) {
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
    const mcUntil =
      typeof snap.mapCompressionUntilMs === "number" && Number.isFinite(snap.mapCompressionUntilMs)
        ? snap.mapCompressionUntilMs
        : battleEndMs;
    layers.push({
      kind: "map_compression",
      title: ui?.title || "Сжатие карты",
      subtitle: ui?.subtitle || "Центр ценнее, края слабее",
      untilMs: Math.min(mcUntil, battleEndMs),
      compression: snap.mapCompression,
      style: "compression",
    });
  }

  if (snap.economicRects.length && snap.economicUntilMs != null && snap.economicUi && snap.economicUntilMs > nowMs) {
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

  if (snap.teamSynergy?.active && snap.synergyUntilMs != null && snap.synergyUntilMs > nowMs) {
    layers.push({
      kind: "team_synergy",
      title: "Командная синергия",
      subtitle: `≥${snap.teamSynergy.minOnline} игроков онлайн: +${Math.round((snap.teamSynergy.mult - 1) * 100)}% к очкам территории`,
      untilMs: snap.synergyUntilMs,
      style: "synergy",
      synergyMult: snap.teamSynergy.mult,
    });
  }

  for (let d = 0; d < snap.dramaticLayers.length; d++) {
    const dl = snap.dramaticLayers[d];
    if (typeof dl.untilMs !== "number" || !Number.isFinite(dl.untilMs) || dl.untilMs <= nowMs) continue;
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
/** Целевой множитель очищаемой площади сейсмики; радиусы шаров × √factor (площадь шара ~ r²). */
const SEISMIC_CLEAR_AREA_FACTOR = 5;

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
  const rScale = Math.sqrt(SEISMIC_CLEAR_AREA_FACTOR);
  const R1 = Math.max(1, Math.round((14 + Math.floor(rng() * 10)) * rScale));
  const R2 = Math.max(1, Math.round((12 + Math.floor(rng() * 10)) * rScale));
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
