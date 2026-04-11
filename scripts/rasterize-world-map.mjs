/**
 * Строит regions-360.json и даунсэмплы regions-{320,160,64}.json из data/world-map-source.png.
 * — cellsBase64: 0 = вода (не игровая), 2 = суша;
 * — rgbBase64: цвет фона карты на клетку.
 *
 * Классификация: вода = выраженный «океанский» синий (B доминирует над R/G с порогами),
 * суша = всё остальное (в т.ч. бледный лёд, белые границы провинций).
 *
 * Запуск: npm run rasterize-world-map
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const SRC = path.join(root, "data", "world-map-source.png");
const BASE = 360;
const ALPHA_CUTOFF = 24;

/** @returns {boolean} true = вода */
function isWaterPixel(r, g, b, a) {
  if (a < ALPHA_CUTOFF) return true;
  const maxc = Math.max(r, g, b);
  const mr = Math.max(r, g);
  /* Тёмный/почти чёрный океан: раньше maxc < 22 сразу давал «сушу» — захват 12×12 заливал «воду». */
  if (maxc < 56) {
    if (b >= r && b >= g && b - mr >= 2) return true;
    return false;
  }
  if (b > 135 && b > r + 14 && b > g + 10) return true;
  if (b > 100 && b > r + 28 && b > g + 20) return true;
  if (b === maxc && b > 88 && b > r + 6 && b > g + 4 && r + g < b + 75) return true;
  return false;
}

function downsampleCellsAndRgb(cellsSrc, rgbSrc, w, srcBase) {
  const h = w;
  const cells = new Uint8Array(w * h);
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const bx = Math.min(srcBase - 1, Math.floor(((x + 0.5) / w) * srcBase));
      const by = Math.min(srcBase - 1, Math.floor(((y + 0.5) / h) * srcBase));
      const si = by * srcBase + bx;
      cells[y * w + x] = cellsSrc[si];
      const ri = si * 3;
      const oi = (y * w + x) * 3;
      rgb[oi] = rgbSrc[ri];
      rgb[oi + 1] = rgbSrc[ri + 1];
      rgb[oi + 2] = rgbSrc[ri + 2];
    }
  }
  return { cells, rgb };
}

function writeRegionsJson(outPath, w, h, cells, rgb, countryNames) {
  const payload = {
    w,
    h,
    countryNames,
    cellsBase64: Buffer.from(cells).toString("base64"),
    rgbBase64: Buffer.from(rgb).toString("base64"),
  };
  fs.writeFileSync(outPath, JSON.stringify(payload), "utf8");
  console.log("written", outPath, cells.length, "cells,", rgb.length, "rgb bytes");
}

async function main() {
  if (!fs.existsSync(SRC)) {
    console.error("Нет файла:", SRC);
    process.exit(1);
  }

  const { data, info } = await sharp(SRC)
    .resize(BASE, BASE, {
      fit: "cover",
      position: "centre",
      kernel: sharp.kernel.nearest,
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.width !== BASE || info.height !== BASE) {
    console.error("Ожидалось", BASE, "получено", info.width, info.height);
    process.exit(1);
  }

  const channels = info.channels;
  const cells = new Uint8Array(BASE * BASE);
  const rgb = new Uint8Array(BASE * BASE * 3);

  for (let i = 0; i < BASE * BASE; i++) {
    const o = i * channels;
    const r = data[o];
    const g = data[o + 1];
    const b = data[o + 2];
    const a = channels >= 4 ? data[o + 3] : 255;
    const water = isWaterPixel(r, g, b, a);
    if (water) {
      cells[i] = 0;
      rgb[i * 3] = r;
      rgb[i * 3 + 1] = g;
      rgb[i * 3 + 2] = b;
    } else {
      cells[i] = 2;
      rgb[i * 3] = r;
      rgb[i * 3 + 1] = g;
      rgb[i * 3 + 2] = b;
    }
  }

  const countryNames = ["Вода", "Река", "Суша"];

  writeRegionsJson(path.join(root, "data", "regions-360.json"), BASE, BASE, cells, rgb, countryNames);

  for (const w of [320, 160, 64]) {
    const { cells: cw, rgb: rw } = downsampleCellsAndRgb(cells, rgb, w, BASE);
    writeRegionsJson(path.join(root, "data", `regions-${w}.json`), w, w, cw, rw, countryNames);
  }

  console.log("Готово. Перезапусти сервер.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
