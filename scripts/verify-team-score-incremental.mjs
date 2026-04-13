/**
 * Проверка: инкрементальное M/S-табло совпадает с aggregateScoresFromPixels после случайных мутаций.
 * Запуск: node scripts/verify-team-score-incremental.mjs
 */
import { aggregateScoresFromPixels } from "../lib/scoring.js";
import {
  aggregateFromMassSumCache,
  aggregatesEqual,
  applyIncrementalTeamScorePixelStep,
  rebuildMassSumFromPixels,
} from "../lib/team-score-incremental.js";

/** @param {unknown} val */
function pixelTeamFn(val) {
  if (val == null) return 0;
  if (typeof val === "object" && val !== null) return Number(/** @type {{ teamId?: number }} */ (val).teamId) | 0;
  return Number(val) | 0;
}

/** @param {number} gridW @param {number} gridH */
function makeCtxBasic(gridW, gridH) {
  const landGrid = new Uint8Array(gridW * gridH).fill(1);
  const baseValueGrid = new Float32Array(gridW * gridH).fill(1);
  return {
    roundIndex: 2,
    gridW,
    gridH,
    landGrid,
    baseValueGrid,
    battle: null,
    synergyMultByTeamId: new Map([
      [1, 1.05],
      [2, 1.08],
      [3, 1.12],
    ]),
  };
}

/** Контекст ближе к бою: веса клеток, золото, экономика, сжатие карты (как в BattleScoringSnapshot). */
function makeCtxRichBattle(gridW, gridH) {
  const landGrid = new Uint8Array(gridW * gridH).fill(1);
  const baseValueGrid = new Float32Array(gridW * gridH);
  for (let i = 0; i < baseValueGrid.length; i++) {
    baseValueGrid[i] = 0.82 + ((i * 19) % 37) / 100;
  }
  const far = 9_000_000_000;
  return {
    roundIndex: 1,
    gridW,
    gridH,
    landGrid,
    baseValueGrid,
    battle: {
      mapCompression: {
        centerMult: 1.45,
        nonCenterMult: 0.55,
        outerRingMult: 0.28,
        outerRingWidthCells: 3,
      },
      goldRect: { x0: 2, y0: 2, w: 10, h: 9 },
      goldUntilMs: far,
      goldUi: { title: "z", subtitle: "z", layerKind: "gold_zone" },
      economicRects: [
        { x0: 12, y0: 4, w: 8, h: 8, mult: 1.42 },
        { x0: 3, y0: 15, w: 10, h: 6, mult: 0.58 },
      ],
      economicUntilMs: far,
      economicUi: { title: "e", subtitle: "e", layerKind: "economic_shift" },
      teamSynergy: null,
      synergyUntilMs: null,
      dramaticLayers: [],
      mapCompressionUi: { title: "c", subtitle: "c" },
      mapCompressionUntilMs: far,
    },
    synergyMultByTeamId: new Map([
      [1, 1.11],
      [2, 1.0],
      [3, 1.07],
    ]),
  };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {string} label
 * @param {import("../lib/scoring.js").GameScoreState} ctx
 * @param {() => number} rand
 * @param {number} steps
 * @param {number} resyncEvery
 */
function runSuite(label, ctx, rand, steps, resyncEvery) {
  const W = ctx.gridW;
  const H = ctx.gridH;
  /** @type {Map<string, { teamId: number, ownerPlayerKey: string, shieldedUntil: number }>} */
  const pixels = new Map();
  const mass = new Map();
  const sumV = new Map();

  for (let i = 0; i < 120; i++) {
    const x = ((i * 13 + 2) % W) | 0;
    const y = ((i * 17 + 5) % H) | 0;
    const tid = (i % 3) + 1;
    pixels.set(`${x},${y}`, { teamId: tid, ownerPlayerKey: "", shieldedUntil: 0 });
  }

  rebuildMassSumFromPixels(pixels, pixelTeamFn, ctx, mass, sumV);

  for (let step = 0; step < steps; step++) {
    const x = (rand() * W) | 0;
    const y = (rand() * H) | 0;
    const key = `${x},${y}`;
    const prev = pixels.has(key) ? pixels.get(key) : null;
    const roll = rand();
    /** @type {{ teamId: number, ownerPlayerKey: string, shieldedUntil: number } | null} */
    let next = null;
    if (roll >= 0.12) {
      const tid = ((rand() * 3) | 0) + 1;
      next = { teamId: tid, ownerPlayerKey: "", shieldedUntil: 0 };
    }

    const stepRes = applyIncrementalTeamScorePixelStep(x, y, prev, next, ctx, pixelTeamFn, mass, sumV);
    if (stepRes === "invalidate") {
      console.error(`[${label}] Unexpected cache invalidate at step`, step, { key, prev, next });
      process.exit(1);
    }

    if (next == null) pixels.delete(key);
    else pixels.set(key, next);

    const full = aggregateScoresFromPixels(pixels, pixelTeamFn, ctx);
    const fromCache = aggregateFromMassSumCache(mass, sumV);
    if (!aggregatesEqual(full, fromCache, 1e-5)) {
      console.error(`[${label}] Mismatch at step`, step, { x, y, prev, next });
      console.error("full", Object.fromEntries(full));
      console.error("cache", Object.fromEntries(fromCache));
      process.exit(1);
    }

    if (resyncEvery > 0 && step > 0 && step % resyncEvery === 0) {
      rebuildMassSumFromPixels(pixels, pixelTeamFn, ctx, mass, sumV);
    }
  }

  console.log(`OK: [${label}] ${steps} steps`);
}

const W = 28;
const H = 28;
runSuite("basic", makeCtxBasic(W, H), mulberry32(0xcafe1234), 3000, 400);
runSuite("rich_battle", makeCtxRichBattle(W, H), mulberry32(0xbeef99aa), 2500, 350);
console.log("All incremental score checks passed.");
