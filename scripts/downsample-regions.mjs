/**
 * Строит regions-{w}.json из regions-320.json тем же правилом, что и server.js (центр ячейки).
 * 640 — надсэмпл (каждая клетка 320 → блок 2×2); остальное — даунсэмпл.
 * Запуск: node scripts/downsample-regions.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const SRC = path.join(root, "data", "regions-320.json");

const BASE = 320;

function downsample(src, w) {
  const h = w;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const bx = Math.min(BASE - 1, Math.floor(((x + 0.5) / w) * BASE));
      const by = Math.min(BASE - 1, Math.floor(((y + 0.5) / h) * BASE));
      out[y * w + x] = src[by * BASE + bx];
    }
  }
  return out;
}

/** Массовый бой 640×640: каждая клетка 320 дублируется в квадрат 2×2 */
function upsampleTo640(src) {
  const W = 640;
  const out = new Uint8Array(W * W);
  for (let sy = 0; sy < BASE; sy++) {
    for (let sx = 0; sx < BASE; sx++) {
      const v = src[sy * BASE + sx];
      const ox = sx * 2;
      const oy = sy * 2;
      out[oy * W + ox] = v;
      out[oy * W + ox + 1] = v;
      out[(oy + 1) * W + ox] = v;
      out[(oy + 1) * W + ox + 1] = v;
    }
  }
  return out;
}

function main() {
  const raw = fs.readFileSync(SRC, "utf8");
  const j = JSON.parse(raw);
  const src = Uint8Array.from(Buffer.from(j.cellsBase64, "base64"));
  if (src.length !== BASE * BASE) {
    console.error("regions-320.json: ожидается", BASE * BASE, "клеток");
    process.exit(1);
  }

  const w640 = 640;
  const cells640 = upsampleTo640(src);
  const p640 = path.join(root, "data", `regions-${w640}.json`);
  fs.writeFileSync(
    p640,
    JSON.stringify({
      w: w640,
      h: w640,
      countryNames: j.countryNames,
      cellsBase64: Buffer.from(cells640).toString("base64"),
    }),
    "utf8"
  );
  console.log("written", p640, cells640.length);

  for (const w of [21, 15]) {
    const cells = downsample(src, w);
    const outPath = path.join(root, "data", `regions-${w}.json`);
    fs.writeFileSync(
      outPath,
      JSON.stringify({ w, h: w, countryNames: j.countryNames, cellsBase64: Buffer.from(cells).toString("base64") }),
      "utf8"
    );
    console.log("written", outPath, cells.length);
  }
}

main();
