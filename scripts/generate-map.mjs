/**
 * Растеризация Natural Earth (world-atlas) в сетку 320×320: id страны на клетку (0 = океан).
 * Запуск: npm run build-map
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { feature } from "topojson-client";
import { geoContains, geoBounds } from "d3-geo";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const W = 320;
const H = 320;

const topo = JSON.parse(fs.readFileSync(path.join(root, "node_modules/world-atlas/countries-110m.json"), "utf8"));
const fc = feature(topo, topo.objects.countries);

/** @type {{ id: number, name: string, geometry: object, bounds: [[number,number],[number,number]] }[]} */
const items = [];
let id = 1;
for (const f of fc.features) {
  const name = (f.properties && f.properties.name) || `Land ${id}`;
  const g = f.geometry;
  if (!g) continue;
  const b = geoBounds(g);
  items.push({ id, name, geometry: g, bounds: b });
  id += 1;
}

const cells = new Uint8Array(W * H);

function lonLat(x, y) {
  const lon = (x / (W - 1)) * 360 - 180;
  const lat = 90 - (y / (H - 1)) * 180;
  return [lon, lat];
}

function inBounds(pt, bounds) {
  let [[lon0, lat0], [lon1, lat1]] = bounds;
  if (lon0 > lon1) [lon0, lon1] = [lon1, lon0];
  if (lat0 > lat1) [lat0, lat1] = [lat1, lat0];
  const [lon, lat] = pt;
  return lon >= lon0 && lon <= lon1 && lat >= lat0 && lat <= lat1;
}

let done = 0;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const pt = lonLat(x, y);
    let cid = 0;
    for (const it of items) {
      if (!inBounds(pt, it.bounds)) continue;
      if (geoContains(it.geometry, pt)) {
        cid = it.id;
        break;
      }
    }
    cells[y * W + x] = cid > 255 ? 0 : cid;
    done++;
    if (done % 20000 === 0) process.stdout.write(`\r${done} / ${W * H}`);
  }
}
console.log(`\r${W * H} cells OK`);

const maxId = items.reduce((m, it) => Math.max(m, it.id), 0);
const countryNames = new Array(maxId + 1).fill("");
countryNames[0] = "";
for (const it of items) {
  countryNames[it.id] = it.name;
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
