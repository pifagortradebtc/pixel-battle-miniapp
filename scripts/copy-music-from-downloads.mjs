/**
 * Копирует длинные фоновые .mp3 из «Загрузок» в music/bgm-01.mp3 … по порядку плейлиста.
 * Подставьте в PLAYLIST_SLOTS свои имена файлов (первый = bgm-01, второй = bgm-02, …).
 * Запуск: npm run copy-music
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DEST_DIR = path.join(ROOT, "music");
const DL = path.join(process.env.USERPROFILE || "", "Downloads");

/**
 * Каждый элемент — варианты имён для одного слота (ищется первое существующее).
 * Порядок слотов = порядок в music/manifest.json → playlist.
 */
const PLAYLIST_SLOTS = [
  ["bgm-01.mp3", "ФОН 1.mp3", "фон 1.mp3", "BGM-01.mp3", "ФОН ДЛИННЫЙ 1.mp3"],
  ["bgm-02.mp3", "ФОН 2.mp3", "фон 2.mp3", "BGM-02.mp3", "ФОН ДЛИННЫЙ 2.mp3"],
  ["bgm-03.mp3", "ФОН 3.mp3", "фон 3.mp3", "BGM-03.mp3"],
  ["bgm-04.mp3", "ФОН 4.mp3", "фон 4.mp3", "BGM-04.mp3"],
  ["bgm-05.mp3", "ФОН 5.mp3", "фон 5.mp3", "BGM-05.mp3"],
  ["bgm-06.mp3", "ФОН 6.mp3", "фон 6.mp3", "BGM-06.mp3"],
  ["bgm-07.mp3", "ФОН 7.mp3", "фон 7.mp3", "BGM-07.mp3"],
  ["bgm-08.mp3", "ФОН 8.mp3", "фон 8.mp3", "BGM-08.mp3"],
];

function tryCopySlot(slotIndex, candidateNames) {
  const destName = `bgm-${String(slotIndex + 1).padStart(2, "0")}.mp3`;
  const to = path.join(DEST_DIR, destName);
  for (const name of candidateNames) {
    const from = path.join(DL, name);
    if (fs.existsSync(from)) {
      fs.copyFileSync(from, to);
      console.log("OK", destName, "<-", name);
      return true;
    }
  }
  return false;
}

fs.mkdirSync(DEST_DIR, { recursive: true });
let ok = 0;
for (let i = 0; i < PLAYLIST_SLOTS.length; i++) {
  if (tryCopySlot(i, PLAYLIST_SLOTS[i])) ok++;
}

const missing = [];
for (let i = 0; i < PLAYLIST_SLOTS.length; i++) {
  const destName = `bgm-${String(i + 1).padStart(2, "0")}.mp3`;
  if (!fs.existsSync(path.join(DEST_DIR, destName))) missing.push(destName);
}
if (missing.length) {
  console.warn("Нет файлов (добавьте имена в PLAYLIST_SLOTS или скопируйте вручную в music/):", missing.join(", "));
}
console.log(`Готово: скопировано ${ok}/${PLAYLIST_SLOTS.length}.`);
