/**
 * Строит regions-{w}.json из regions-320.json тем же правилом, что и server.js (центр ячейки).
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

function main() {
  const raw = fs.readFileSync(SRC, "utf8");
  const j = JSON.parse(raw);
  const src = Uint8Array.from(Buffer.from(j.cellsBase64, "base64"));
  if (src.length !== BASE * BASE) {
    console.error("regions-320.json: ожидается", BASE * BASE, "клеток");
    process.exit(1);
  }
  for (const w of [64, 21]) {
    const cells = downsample(src, w);
    const cellsBase64 = Buffer.from(cells).toString("base64");
    const outPath = path.join(root, "data", `regions-${w}.json`);
    fs.writeFileSync(outPath, JSON.stringify({ w, h: w, cellsBase64 }), "utf8");
    console.log("written", outPath, cells.length);
  }
}

main();
