/**
 * Пересчитывает cells в regions-*.json по уже сохранённому rgbBase64 и актуальному lib/world-map-water.js.
 * Нужен, когда нет world-map-source.png или правила «вода/суша» обновились.
 *
 * Запуск: npm run reclassify-regions-land
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  isWorldMapWaterPixel,
  fillEnclosedWaterAsLand,
  softenPastelOceanLandRgb,
} from "../lib/world-map-water.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const BASE = 360;

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
  console.log("written", outPath, cells.length, "cells");
}

function main() {
  const p360 = path.join(root, "data", "regions-360.json");
  const raw = fs.readFileSync(p360, "utf8");
  const j = JSON.parse(raw);
  const rgb = Uint8Array.from(Buffer.from(j.rgbBase64, "base64"));
  if (rgb.length !== BASE * BASE * 3) {
    console.error("Ожидалось rgb", BASE * BASE * 3, "получено", rgb.length);
    process.exit(1);
  }

  const cells = new Uint8Array(BASE * BASE);
  let land = 0;
  let changed = 0;
  const oldCells = Uint8Array.from(Buffer.from(j.cellsBase64, "base64"));
  for (let i = 0; i < BASE * BASE; i++) {
    const o = i * 3;
    const r = rgb[o];
    const g = rgb[o + 1];
    const b = rgb[o + 2];
    const water = isWorldMapWaterPixel(r, g, b, 255);
    const v = water ? 0 : 2;
    cells[i] = v;
    if (v !== 0) land++;
    if (oldCells[i] !== v) changed++;
  }

  const enclosedFilled = fillEnclosedWaterAsLand(cells, BASE, BASE);
  if (enclosedFilled > 0) {
    land += enclosedFilled;
    console.log("запертая вода → суша:", enclosedFilled, "клеток");
  }

  const rgbSoft = softenPastelOceanLandRgb(cells, rgb, BASE, BASE, 3);
  if (rgbSoft > 0) {
    console.log("пастельная «вода» на суше → смягчение RGB:", rgbSoft, "записей");
  }

  const countryNames = Array.isArray(j.countryNames) ? j.countryNames : ["Вода", "Река", "Суша"];

  writeRegionsJson(p360, BASE, BASE, cells, rgb, countryNames);
  for (const w of [320, 160, 64]) {
    const { cells: cw, rgb: rw } = downsampleCellsAndRgb(cells, rgb, w, BASE);
    writeRegionsJson(path.join(root, "data", `regions-${w}.json`), w, w, cw, rw, countryNames);
  }

  console.log("суша 360:", land, "/", BASE * BASE, "; клеток сменили класс:", changed);
  console.log("Готово. Перезапусти сервер.");
}

main();
