/**
 * Процедурная «карта»: ~80% суши, ~15–20% океана (не география Земли).
 * Шум → порог по квантилю → Вороной по сушевым центрам для регионов.
 * Запуск: npm run build-map
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const W = 320;
const H = 320;

/** Доля клеток-океана (низкие значения шума) — середина диапазона 15–20% */
const OCEAN_FRACTION = 0.17;

/** Число «стран» (регионов Вороного на суше), ≤ 255 */
const NUM_REGIONS = 100;

function hash2(ix, iy) {
  let n = ix * 374761393 + iy * 668265263;
  n = (n ^ (n >>> 13)) * 1274126177;
  return (n >>> 0) / 4294967296;
}

function noise2(x, y) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const a = hash2(x0, y0);
  const b = hash2(x0 + 1, y0);
  const c = hash2(x0, y0 + 1);
  const d = hash2(x0 + 1, y0 + 1);
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function fbm(x, y) {
  let sum = 0;
  let amp = 1;
  let freq = 0.014;
  let norm = 0;
  for (let o = 0; o < 5; o++) {
    sum += amp * noise2(x * freq, y * freq);
    norm += amp;
    amp *= 0.52;
    freq *= 2.08;
  }
  return sum / norm;
}

const height = new Float32Array(W * H);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    height[y * W + x] = fbm(x, y);
  }
}

/** Ровно floor(OCEAN_FRACTION * N) клеток с наименьшей «высотой» — океан (остальное — суша). */
const cellIdx = Array.from({ length: W * H }, (_, i) => i);
cellIdx.sort((a, b) => height[a] - height[b]);
const oceanCount = Math.floor(OCEAN_FRACTION * W * H);
const oceanSet = new Set(cellIdx.slice(0, oceanCount));

const landMask = new Uint8Array(W * H);
const landCoords = [];
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const isLand = !oceanSet.has(i);
    landMask[i] = isLand ? 1 : 0;
    if (isLand) landCoords.push({ x, y });
  }
}

let oceanPct = 0;
for (let i = 0; i < landMask.length; i++) {
  if (!landMask[i]) oceanPct++;
}
oceanPct = (100 * oceanPct) / (W * H);
console.log(`Океан: ~${oceanPct.toFixed(1)}% (цель ~${(OCEAN_FRACTION * 100).toFixed(0)}%), суша: ~${(100 - oceanPct).toFixed(1)}%`);

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(0x9e3779b9);

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

const nSeeds = Math.min(NUM_REGIONS, landCoords.length);
shuffle(landCoords);
const seeds = landCoords.slice(0, nSeeds);

const cells = new Uint8Array(W * H);

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (!landMask[i]) {
      cells[i] = 0;
      continue;
    }
    let best = 0;
    let bestD = Infinity;
    for (let s = 0; s < seeds.length; s++) {
      const dx = x - seeds[s].x;
      const dy = y - seeds[s].y;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = s + 1;
      }
    }
    cells[i] = best > 255 ? 0 : best;
  }
}

const countryNames = new Array(seeds.length + 1).fill("");
countryNames[0] = "";
for (let i = 1; i <= seeds.length; i++) {
  countryNames[i] = `Территория ${i}`;
}

const out = {
  w: W,
  h: H,
  countryNames,
  cellsBase64: Buffer.from(cells).toString("base64"),
};

const outPath = path.join(root, "data", "regions-320.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out), "utf8");
console.log("Written:", outPath, `(${(fs.statSync(outPath).size / 1024).toFixed(1)} KB)`);
