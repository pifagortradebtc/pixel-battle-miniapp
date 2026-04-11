/**
 * Генерирует data/poster-source.png (320×320): стилизованная «карта Земли» в квадрате.
 * Океан — полностью прозрачный (cells=0 после rasterize), суша — разноцветные «страны».
 * Затем запускает rasterize-poster для обновления regions-*.json.
 *
 * Запуск: npm run generate-earth-poster
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const OUT_PNG = path.join(root, "data", "poster-source.png");
const W = 320;

/** Долгота −180…180, широта ~82…−82 (север сверху, квадратная проекция). */
function lonLat(px, py) {
  const lon = (px / (W - 1)) * 360 - 180;
  const t = py / (W - 1);
  const lat = 82 - t * 164;
  return { lon, lat };
}

function inEllipse(lon, lat, cx, cy, rx, ry) {
  const dx = (lon - cx) / rx;
  const dy = (lat - cy) / ry;
  return dx * dx + dy * dy <= 1;
}

/** Крупные массы суши (упрощённо, но узнаваемо в квадрате). */
const CONTINENTS = [
  [-102, 48, 40, 26],
  [-68, -14, 20, 36],
  [12, 54, 24, 15],
  [22, 8, 22, 36],
  [92, 42, 50, 26],
  [78, 22, 10, 14],
  [118, 4, 24, 20],
  [134, -26, 18, 12],
  [-42, 74, 14, 9],
  [138, 38, 10, 7],
  [-6, 54, 8, 7],
  [48, -20, 6, 11],
  [168, -44, 10, 6],
  [-156, 22, 5, 4],
];

/** «Моря» внутри масс (вырезаем сушу). */
const CARVES = [
  [-90, 24, 16, 11],
  [-100, 58, 12, 8],
  [4, 50, 10, 5],
  [32, 35, 8, 6],
  [52, 0, 6, 14],
  [110, 12, 14, 8],
  [125, -5, 8, 6],
];

function continentHit(lon, lat) {
  for (let i = 0; i < CONTINENTS.length; i++) {
    const [cx, cy, rx, ry] = CONTINENTS[i];
    if (inEllipse(lon, lat, cx, cy, rx, ry)) return i + 1;
  }
  return 0;
}

function isLand(lon, lat) {
  if (continentHit(lon, lat) === 0) return false;
  for (const [cx, cy, rx, ry] of CARVES) {
    if (inEllipse(lon, lat, cx, cy, rx, ry)) return false;
  }
  return true;
}

/** Палитра «политической карты» — насыщенные, различимые оттенки. */
const PALETTE = [
  [210, 92, 74],
  [98, 168, 86],
  [232, 196, 62],
  [118, 112, 198],
  [196, 118, 188],
  [86, 168, 196],
  [198, 134, 72],
  [72, 118, 198],
  [168, 198, 86],
  [198, 86, 118],
  [120, 86, 168],
  [168, 120, 72],
  [72, 168, 120],
  [188, 100, 100],
  [100, 140, 188],
  [140, 188, 100],
  [200, 150, 80],
  [80, 130, 200],
  [160, 90, 160],
  [90, 160, 130],
  [220, 120, 60],
  [60, 160, 200],
  [190, 170, 70],
  [130, 70, 190],
];

function landRgb(lon, lat, contId) {
  const stepLon = 4.2;
  const stepLat = 3.6;
  const gx = Math.floor(lon / stepLon);
  const gy = Math.floor(lat / stepLat);
  let h =
    Math.imul(gx, 374761393) ^
    Math.imul(gy, 668265263) ^
    Math.imul(contId, 0x9e3779b9);
  h >>>= 0;
  const base = PALETTE[h % PALETTE.length];
  const v = ((h >>> 8) & 7) - 3;
  return [
    Math.max(0, Math.min(255, base[0] + v)),
    Math.max(0, Math.min(255, base[1] + v)),
    Math.max(0, Math.min(255, base[2] + v)),
  ];
}

function buildRgba() {
  const buf = Buffer.alloc(W * W * 4);
  let o = 0;
  for (let py = 0; py < W; py++) {
    for (let px = 0; px < W; px++) {
      const { lon, lat } = lonLat(px, py);
      const cont = continentHit(lon, lat);
      if (!isLand(lon, lat)) {
        buf[o++] = 0;
        buf[o++] = 0;
        buf[o++] = 0;
        buf[o++] = 0;
        continue;
      }
      const [r, g, b] = landRgb(lon, lat, cont);
      buf[o++] = r;
      buf[o++] = g;
      buf[o++] = b;
      buf[o++] = 255;
    }
  }
  return buf;
}

async function main() {
  const rgba = buildRgba();
  await sharp(rgba, { raw: { width: W, height: W, channels: 4 } })
    .png()
    .toFile(OUT_PNG);
  console.log("written", OUT_PNG);

  execSync("node scripts/rasterize-poster.mjs", {
    cwd: root,
    stdio: "inherit",
    shell: true,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
