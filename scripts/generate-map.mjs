/**
 * Базовая суша — шум + Вороной (как раньше), но внешний силуэт не «планета», а плакат в духе промо:
 * верх — «небо» (не закрашивается), центр — широкое табло, низ расширяется — «куча / сцена».
 * Реки — узкие русла на суше, непроходимы.
 * Запуск: npm run build-map && npm run downsample-regions
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const W = 320;
const H = 320;

/** Доля клеток «моря» (0 = океан) — середина ~15–20% */
const OCEAN_FRACTION = 0.17;

/** Доля клеток «реки» от всей карты (узкие русла) */
const RIVER_FRACTION_TARGET = 0.045;

/** Число русел (из углов и с рёбер к центру / внутрь) */
const NUM_RIVERS = 11;

/** Радиус «кисти» реки (1 = узко, 2 = чуть шире) */
const RIVER_RADIUS = 2;

/** Число регионов Вороного на сушe (без воды), ≤ 254 */
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

/** Высота «континента»: центр выше, углы ниже + искажение для естественных заливов */
function continentHeight(x, y) {
  const nx = (x + 0.5) / W - 0.5;
  const ny = (y + 0.5) / H - 0.5;
  const r = Math.sqrt(nx * nx + ny * ny);
  const radial = Math.max(0, 1 - r * r * 1.55);

  const wx = x + 42 * fbm(x * 0.018, y * 0.018);
  const wy = y + 42 * fbm(x * 0.018 + 71, y * 0.018 + 33);

  let h = 0.58 * fbm(wx * 0.0105, wy * 0.0105);
  h += 0.26 * fbm(wx * 0.024, wy * 0.024);
  h += 0.11 * fbm(wx * 0.048, wy * 0.048);
  h += 0.05 * fbm(wx * 0.09, wy * 0.09);
  h += radial * 0.44;
  h -= 0.1;
  return h;
}

const height = new Float32Array(W * H);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    height[y * W + x] = continentHeight(x, y);
  }
}

const cellIdx = Array.from({ length: W * H }, (_, i) => i);
cellIdx.sort((a, b) => height[a] - height[b]);
const oceanCount = Math.floor(OCEAN_FRACTION * W * H);
const oceanSet = new Set(cellIdx.slice(0, oceanCount));

const initialLand = new Uint8Array(W * H);
let oceanPct = 0;
for (let i = 0; i < W * H; i++) {
  const isOcean = oceanSet.has(i);
  initialLand[i] = isOcean ? 0 : 1;
  if (isOcean) oceanPct++;
}
oceanPct = (100 * oceanPct) / (W * H);
console.log(`Океан: ~${oceanPct.toFixed(1)}% (цель ~${(OCEAN_FRACTION * 100).toFixed(0)}%)`);

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(0x4b1d4e77);

/** Стартовые точки: углы + середины сторон + несколько случайных на границе */
function borderStarts() {
  const s = [];
  const m = 8;
  s.push({ x: m, y: m });
  s.push({ x: W - 1 - m, y: m });
  s.push({ x: m, y: H - 1 - m });
  s.push({ x: W - 1 - m, y: H - 1 - m });
  s.push({ x: Math.floor(W / 2), y: m });
  s.push({ x: Math.floor(W / 2), y: H - 1 - m });
  s.push({ x: m, y: Math.floor(H / 2) });
  s.push({ x: W - 1 - m, y: Math.floor(H / 2) });
  for (let k = 0; k < 12; k++) {
    const edge = (rng() * 4) | 0;
    if (edge === 0) s.push({ x: (rng() * (W - 1)) | 0, y: 0 });
    else if (edge === 1) s.push({ x: W - 1, y: (rng() * (H - 1)) | 0 });
    else if (edge === 2) s.push({ x: (rng() * (W - 1)) | 0, y: H - 1 });
    else s.push({ x: 0, y: (rng() * (H - 1)) | 0 });
  }
  return s;
}

const starts = borderStarts();
shuffle(starts);

/** Цель для русла: центр с разбросом или «противоположный» квадрант */
function pickEnd(rng) {
  const cx = W * (0.35 + rng() * 0.3);
  const cy = H * (0.35 + rng() * 0.3);
  return { x: cx, y: cy };
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/** Меандрирующий путь по суше к цели */
function traceRiver(sx, sy, ex, ey, landMask) {
  let x = sx;
  let y = sy;
  const path = [];
  const maxSteps = 900;
  for (let step = 0; step < maxSteps; step++) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    if (xi >= 0 && xi < W && yi >= 0 && yi < H && landMask[yi * W + xi]) {
      path.push({ x: xi, y: yi });
    }
    const dx = ex - x;
    const dy = ey - y;
    const dist = Math.hypot(dx, dy);
    if (dist < 6) break;
    const base = Math.atan2(dy, dx);
    const wander = Math.sin(step * 0.11 + rng() * 8) * 0.55 + (rng() - 0.5) * 0.65;
    const ang = base + wander;
    const stepLen = 1.15 + rng() * 0.55;
    x += Math.cos(ang) * stepLen;
    y += Math.sin(ang) * stepLen;
    if (x < 0 || x >= W || y < 0 || y >= H) break;
  }
  return path;
}

/** Сдвиг старта на ближайшую сушу от угла */
function snapToLand(px, py, landMask) {
  let bx = Math.max(0, Math.min(W - 1, px | 0));
  let by = Math.max(0, Math.min(H - 1, py | 0));
  if (landMask[by * W + bx]) return { x: bx, y: by };
  let best = null;
  let bestD = Infinity;
  for (let r = 1; r < 80; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const nx = bx + dx;
        const ny = by + dy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const i = ny * W + nx;
        if (!landMask[i]) continue;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = { x: nx, y: ny };
        }
      }
    }
    if (best) return best;
  }
  return { x: W >> 1, y: H >> 1 };
}

const riverMask = new Uint8Array(W * H);

for (let r = 0; r < NUM_RIVERS; r++) {
  const st = starts[r % starts.length];
  const end = pickEnd(rng);
  const s0 = snapToLand(st.x, st.y, initialLand);
  const path = traceRiver(s0.x, s0.y, end.x, end.y, initialLand);
  for (const p of path) {
    for (let dy = -RIVER_RADIUS; dy <= RIVER_RADIUS; dy++) {
      for (let dx = -RIVER_RADIUS; dx <= RIVER_RADIUS; dx++) {
        if (dx * dx + dy * dy > RIVER_RADIUS * RIVER_RADIUS + 0.5) continue;
        const nx = p.x + dx;
        const ny = p.y + dy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const i = ny * W + nx;
        if (initialLand[i]) riverMask[i] = 1;
      }
    }
  }
}

/** Ограничить долю рек: снять лишние с самых «коротких» участков — упрощённо: случайно убрать часть точек если перебор */
let riverCells = 0;
for (let i = 0; i < W * H; i++) {
  if (riverMask[i]) riverCells++;
}
const maxRiver = Math.floor(RIVER_FRACTION_TARGET * W * H);
if (riverCells > maxRiver) {
  const indices = [];
  for (let i = 0; i < W * H; i++) {
    if (riverMask[i]) indices.push(i);
  }
  shuffle(indices);
  for (let k = maxRiver; k < indices.length; k++) {
    riverMask[indices[k]] = 0;
  }
  riverCells = maxRiver;
}
console.log(`Реки: ~${((100 * riverCells) / (W * H)).toFixed(2)}% клеток`);

/** Суша для игры: была суша и не река. Код клетки: 0 океан, 1 река, 2.. — регион */
const paintableLand = new Uint8Array(W * H);
const landCoords = [];
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const ok = initialLand[i] && !riverMask[i];
    paintableLand[i] = ok ? 1 : 0;
    if (ok) landCoords.push({ x, y });
  }
}

const nSeeds = Math.min(NUM_REGIONS, landCoords.length);
shuffle(landCoords);
const seeds = landCoords.slice(0, nSeeds);

const cells = new Uint8Array(W * H);

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (!initialLand[i]) {
      cells[i] = 0;
      continue;
    }
    if (riverMask[i]) {
      cells[i] = 1;
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
        best = s;
      }
    }
    const rid = best + 2;
    cells[i] = rid > 255 ? 2 : rid;
  }
}

/**
 * Силуэт «плаката»: верхняя полоса — небо; основной блок с лёгким скруглением сверху;
 * нижняя треть расширяется к низу (как горизонт кучи монет/купюр на референсе).
 */
function inTradePosterShape(x, y) {
  const nx = (x + 0.5) / W;
  const ny = (y + 0.5) / H;
  if (ny < 0.1) return false;
  const halfWCard = 0.405;
  if (ny < 0.52) {
    if (Math.abs(nx - 0.5) > halfWCard) return false;
    const roundH = 0.055;
    if (ny < 0.1 + roundH) {
      const u = (ny - 0.1) / roundH;
      const capW = halfWCard * (0.42 + 0.58 * u);
      if (Math.abs(nx - 0.5) > capW) return false;
    }
    return true;
  }
  const t = (ny - 0.52) / 0.48;
  const halfWPile = halfWCard + t * 0.155;
  if (Math.abs(nx - 0.5) > halfWPile) return false;
  return true;
}

/** «Салют» — маленькие круги без закраски у верхней кромки плаката (как на референсе). */
function inSkyFireworkHole(x, y) {
  const nx = (x + 0.5) / W;
  const ny = (y + 0.5) / H;
  if (ny < 0.08 || ny > 0.2) return false;
  const bursts = [
    { cx: 0.2, cy: 0.125, r: 0.034 },
    { cx: 0.38, cy: 0.11, r: 0.028 },
    { cx: 0.52, cy: 0.118, r: 0.032 },
    { cx: 0.68, cy: 0.108, r: 0.03 },
    { cx: 0.84, cy: 0.122, r: 0.034 },
  ];
  for (const b of bursts) {
    const dx = nx - b.cx;
    const dy = ny - b.cy;
    if (dx * dx + dy * dy <= b.r * b.r) return true;
  }
  return false;
}

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const poster = inTradePosterShape(x, y);
    if (!poster || inSkyFireworkHole(x, y)) {
      cells[i] = 0;
    }
  }
}

const countryNames = new Array(Math.min(256, seeds.length + 2)).fill("");
countryNames[0] = "Небо";
countryNames[1] = "Река";
for (let i = 2; i <= seeds.length + 1; i++) {
  countryNames[i] = `Территория ${i - 1}`;
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
