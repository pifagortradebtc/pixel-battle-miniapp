/**
 * Строит regions-{64,160,320,640}.json из data/poster-source.png:
 * — cellsBase64: 0 = прозрачно (не рисуем постер), 2 = «суша» под закраску;
 * — rgbBase64: RGB на клетку (w×h×3) для базового слоя на клиенте.
 * Размеры и даунсэмпл совпадают с downsample-regions.mjs / server.js (центр ячейки).
 *
 * Требуется: npm install (dev: sharp)
 * Запуск: npm run rasterize-poster
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const SRC = path.join(root, "data", "poster-source.png");
const BASE = 320;
const ALPHA_CUTOFF = 24;

function downsampleCellsAndRgb(cellsSrc, rgbSrc, w) {
  const h = w;
  const cells = new Uint8Array(w * h);
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const bx = Math.min(BASE - 1, Math.floor(((x + 0.5) / w) * BASE));
      const by = Math.min(BASE - 1, Math.floor(((y + 0.5) / h) * BASE));
      const si = by * BASE + bx;
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

function upsample640(cellsSrc, rgbSrc) {
  const W = 640;
  const cells = new Uint8Array(W * W);
  const rgb = new Uint8Array(W * W * 3);
  for (let sy = 0; sy < BASE; sy++) {
    for (let sx = 0; sx < BASE; sx++) {
      const si = sy * BASE + sx;
      const v = cellsSrc[si];
      const r = rgbSrc[si * 3];
      const g = rgbSrc[si * 3 + 1];
      const b = rgbSrc[si * 3 + 2];
      const ox = sx * 2;
      const oy = sy * 2;
      for (const dy of [0, 1]) {
        for (const dx of [0, 1]) {
          const i = (oy + dy) * W + (ox + dx);
          cells[i] = v;
          const oi = i * 3;
          rgb[oi] = r;
          rgb[oi + 1] = g;
          rgb[oi + 2] = b;
        }
      }
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
    const a = channels >= 4 ? data[o + 3] : 255;
    if (a < ALPHA_CUTOFF) {
      cells[i] = 0;
      rgb[i * 3] = 10;
      rgb[i * 3 + 1] = 26;
      rgb[i * 3 + 2] = 50;
    } else {
      cells[i] = 2;
      rgb[i * 3] = data[o];
      rgb[i * 3 + 1] = data[o + 1];
      rgb[i * 3 + 2] = data[o + 2];
    }
  }

  const countryNames = ["Океан", "Река", "Страны"];

  const out320 = path.join(root, "data", "regions-320.json");
  writeRegionsJson(out320, BASE, BASE, cells, rgb, countryNames);

  const { cells: c640, rgb: r640 } = upsample640(cells, rgb);
  writeRegionsJson(path.join(root, "data", "regions-640.json"), 640, 640, c640, r640, countryNames);

  for (const w of [160, 64]) {
    const { cells: cw, rgb: rw } = downsampleCellsAndRgb(cells, rgb, w);
    writeRegionsJson(path.join(root, "data", `regions-${w}.json`), w, w, cw, rw, countryNames);
  }

  console.log("Готово. Перезапусти сервер, чтобы подтянулся новый regions-320 на бэкенде.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
