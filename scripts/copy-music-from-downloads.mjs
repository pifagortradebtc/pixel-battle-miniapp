/**
 * Копирует фоновый .mp3 из Загрузок в music/bgm-loop.mp3 (для music/manifest.json).
 * Поддерживает несколько возможных имён исходника — оставьте в MAP свой вариант.
 * Запуск: npm run copy-music
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DEST_DIR = path.join(ROOT, "music");
const DEST = path.join(DEST_DIR, "bgm-loop.mp3");
const DL = path.join(process.env.USERPROFILE || "", "Downloads");

/** Первое найденное имя из списка копируется в bgm-loop.mp3 */
const CANDIDATE_NAMES = [
  "bgm-loop.mp3",
  "ФОН ИГРЫ.mp3",
  "Фон игры.mp3",
  "фон игры.mp3",
  "BACKGROUND.mp3",
  "background.mp3",
  "BGM.mp3",
  "bgm.mp3",
];

function main() {
  fs.mkdirSync(DEST_DIR, { recursive: true });
  for (const name of CANDIDATE_NAMES) {
    const from = path.join(DL, name);
    if (fs.existsSync(from)) {
      fs.copyFileSync(from, DEST);
      console.log("OK", DEST, "<-", name);
      return;
    }
  }
  console.warn(
    "Не найден mp3 в Загрузках. Ожидалось одно из имён:",
    CANDIDATE_NAMES.join(", "),
    "\nПоложите файл вручную как music/bgm-loop.mp3 или добавьте имя в CANDIDATE_NAMES в этом скрипте."
  );
}

main();
