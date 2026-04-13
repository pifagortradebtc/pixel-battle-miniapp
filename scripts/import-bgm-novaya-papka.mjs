/**
 * Копирует фоновые треки из «Загрузки/Новая папка (2)» в music/bgm-01.mp3 …
 * Порядок ниже задаёт нумерацию файлов; в игре порядок воспроизведения — случайный
 * (music/manifest.json → playlistOrder: "random").
 *
 * Запуск: npm run import-bgm
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DEST_DIR = path.join(ROOT, "music");
const SRC_DIR = path.join(process.env.USERPROFILE || "", "Downloads", "Новая папка (2)");

/** Имена файлов в папке — в том виде, как в проводнике (как вы прислали). */
const FILES = [
  "Steel Weather Maps.mp3",
  "Iron Banners (1).mp3",
  "Iron Banners.mp3",
  "Fused Bayonets.mp3",
  "__Steelheart Fuses__ (1).mp3",
  "__Steelheart Fuses__.mp3",
  "Basalt Heartbeat (1).mp3",
  "Basalt Heartbeat.mp3",
  "Gavel Thunder (1).mp3",
  "Gavel Thunder.mp3",
  "Steel Doctrine (2).mp3",
  "Пифагор трейд (1).mp3",
  "Steel Doctrine (1).mp3",
  "Steel Doctrine.mp3",
  "Пифагор трейд.mp3",
  "Steel Tide Rising (1).mp3",
  "Steel Tide Rising.mp3",
  "Event Horizon Countdown.mp3",
  "Iron Tide Rising.mp3",
  "Shadow Lines Advance (1).mp3",
  "Shadow Lines Advance.mp3",
  "Midnight War Room (1).mp3",
  "Midnight War Room.mp3",
  "Iron Lines Advance (1).mp3",
  "Iron Lines Advance.mp3",
  "Iron Lines on the Map (1).mp3",
  "Iron Lines on the Map.mp3",
  "Steel Weather Maps (1).mp3",
  "Steel Lullaby (1).mp3",
  "Steel Lullaby.mp3",
  "Chrome Tactics (1).mp3",
  "Chrome Tactics.mp3",
];

function main() {
  if (!fs.existsSync(SRC_DIR)) {
    console.error("Нет папки:", SRC_DIR);
    process.exit(1);
  }
  fs.mkdirSync(DEST_DIR, { recursive: true });
  let ok = 0;
  for (let i = 0; i < FILES.length; i++) {
    const from = path.join(SRC_DIR, FILES[i]);
    const destName = `bgm-${String(i + 1).padStart(2, "0")}.mp3`;
    const to = path.join(DEST_DIR, destName);
    if (!fs.existsSync(from)) {
      console.warn("Пропуск (нет файла):", FILES[i]);
      continue;
    }
    fs.copyFileSync(from, to);
    console.log("OK", destName, "<-", FILES[i]);
    ok++;
  }
  console.log(`Готово: ${ok}/${FILES.length} → ${DEST_DIR}`);
  if (ok < FILES.length) process.exitCode = 1;
}

main();
