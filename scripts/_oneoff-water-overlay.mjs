/**
 * Одноразово: подсветка «воды» на пользовательском скрине по эвристике RGB.
 * Не часть постоянного пайплайна.
 */
import sharp from "sharp";
import fs from "fs";
import path from "path";

const src =
  process.argv[2] ||
  "C:/Users/pifag/.cursor/projects/c-Users-pifag-OneDrive/assets/c__Users_pifag_AppData_Roaming_Cursor_User_workspaceStorage_d6bab8ecddb7ca06e60df691eb3f755b_images_ChatGPT_Image_11____._2026__.__20_08_46-9a740c93-56d8-4234-aa8f-68029d10707e.png";
const out =
  process.argv[3] ||
  "C:/Users/pifag/.cursor/projects/c-Users-pifag-OneDrive/assets/game-map-user-screenshot-water-marked.png";

const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const w = info.width;
const h = info.height;
const outBuf = Buffer.from(data);

function classifyWater(r, g, b) {
  if (r > 210 && g > 210 && b > 210) return false;
  if (g > r + 35 && g > b + 25 && r < 140) return false;
  if (r > g + 40 && r > b + 15 && g < 200) return false;
  if (r > 100 && g > 60 && g < 160 && b < 110 && r > b) return false;
  if (b > 75 && b >= r - 5 && b > g + 5) {
    if (r > 140 && g > 100 && b > 140 && r + g + b > 400) return false;
    return true;
  }
  return false;
}

for (let i = 0; i < data.length; i += 4) {
  const r = data[i];
  const g = data[i + 1];
  const b = data[i + 2];
  if (!classifyWater(r, g, b)) continue;
  const a = 0.42;
  outBuf[i] = Math.min(255, Math.round(r * (1 - a) + 255 * a));
  outBuf[i + 1] = Math.round(g * (1 - a));
  outBuf[i + 2] = Math.round(b * (1 - a));
  outBuf[i + 3] = 255;
}

const mapPng = await sharp(outBuf, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();

const legendH = 72;
const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${w}" height="${h + legendH}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="#1a1a1e"/>
  <image href="data:image/png;base64,${mapPng.toString("base64")}" x="0" y="0" width="${w}" height="${h}"/>
  <rect x="0" y="${h}" width="${w}" height="${legendH}" fill="rgb(26,26,30)"/>
  <text x="14" y="${h + 28}" fill="#e8e8e8" font-family="Segoe UI,Arial,sans-serif" font-size="16">
    Красная подсветка — пиксели, распознанные как вода (синий доминирует в RGB). Границы приблизительные.
  </text>
  <text x="14" y="${h + 52}" fill="#aaa" font-family="Segoe UI,Arial,sans-serif" font-size="14">
    Исходник: ваш скриншот игры. Это не файл regions-360 cells=0.
  </text>
</svg>`;

await fs.promises.mkdir(path.dirname(out), { recursive: true });
await sharp(Buffer.from(svg)).png().toFile(out);
console.log(out);
