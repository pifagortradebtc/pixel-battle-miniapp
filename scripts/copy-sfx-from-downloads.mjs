/**
 * Копирует mp3 из Загрузок в sfx/ с латинскими именами (один раз после замены треков).
 * Запуск: node scripts/copy-sfx-from-downloads.mjs
 *
 * Соответствие (имя в Загрузках → файл → событие в игре):
 *   ЗАХВАТ БАЗЫ → base-capture → захват флага (presentation base_captured)
 *   ВОЕННАЯ БАЗА → military-base → постройка военной базы
 *   БАФФЫ личный → buff-personal → личное восстановление (playBuffPersonalSfx)
 *   БАФФЫ команда → buff-team → бафф команды (playBuffTeamSfx)
 *   Предупреждение СЕЙСМИКА → seismic-warning → превью / «предупреждение» сейсмики
 *   СЕЙСМИКА Удар → seismic-hit → удар сейсмики
 *   После СЕЙСМИКА → seismic-after → затухание после удара
 *   КВАНТОВЫЕ ФЕРМЫ подключение / отключение / тик хода → quantum-*
 *   СОКРОВИЩЕ → treasure → клад
 *   КОНЕЦ РАУНДА → round-end, ФИНАЛ ПОБЕДА → final-victory
 *   База атакуется / Последние клетки / Отрезание территории → alert-*
 *   4×4 / 6×6 / 12×12 → territory-* → звуки кубов зон
 *   УДАР ПО БАЗЕ / Бомб.. / pixel step → base-hit, bomb, pixel-place
 *   выбор в меню → menu-select → стартовое меню (создать / вступить / выбор команды)
 *
 * Баффы: ориентир — имя файла (личный = личный, команда = команда), см. sfx/samples.json.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DEST = path.join(ROOT, "sfx");
const DL = path.join(process.env.USERPROFILE || "", "Downloads");

const MAP = [
  ["Бомб..mp3", "bomb.mp3"],
  ["УДАР ПО БАЗЕ.mp3", "base-hit.mp3"],
  ["ЗАХВАТ БАЗЫ.mp3", "base-capture.mp3"],
  ["4×4.mp3", "territory-4.mp3"],
  ["4x4.mp3", "territory-4.mp3"],
  ["6×6.mp3", "territory-6.mp3"],
  ["6x6.mp3", "territory-6.mp3"],
  ["12×12.mp3", "territory-12.mp3"],
  ["12x12.mp3", "territory-12.mp3"],
  ["ВОЕННАЯ БАЗА.mp3", "military-base.mp3"],
  ["БАФФЫ личный.mp3", "buff-personal.mp3"],
  ["БАФФЫ команда.mp3", "buff-team.mp3"],
  ["Предупреждение СЕЙСМИКА.mp3", "seismic-warning.mp3"],
  ["СЕЙСМИКА Удар.mp3", "seismic-hit.mp3"],
  ["После СЕЙСМИКА.mp3", "seismic-after.mp3"],
  ["КВАНТОВЫЕ ФЕРМЫ подключение.mp3", "quantum-connect.mp3"],
  ["КВАНТОВЫЕ ФЕРМЫ отключение.mp3", "quantum-disconnect.mp3"],
  ["КВАНТОВЫЕ ФЕРМЫ тик хода.mp3", "quantum-tick.mp3"],
  ["СОКРОВИЩЕ.mp3", "treasure.mp3"],
  ["КОНЕЦ РАУНДА.mp3", "round-end.mp3"],
  ["ФИНАЛ  ПОБЕДА.mp3", "final-victory.mp3"],
  ["ФИНАЛ ПОБЕДА.mp3", "final-victory.mp3"],
  ["База атакуется.mp3", "alert-base-attack.mp3"],
  ["Последние клетки.mp3", "alert-last-cells.mp3"],
  ["Отрезание территории.mp3", "alert-territory-cut.mp3"],
  ["pixel step.mp3", "pixel-place.mp3"],
  ["выбор в меню.mp3", "menu-select.mp3"],
];

function tryCopy(fromName, toName) {
  const from = path.join(DL, fromName);
  const to = path.join(DEST, toName);
  if (!fs.existsSync(from)) return false;
  fs.copyFileSync(from, to);
  console.log("OK", toName, "<-", fromName);
  return true;
}

fs.mkdirSync(DEST, { recursive: true });
const doneDst = new Set();
for (const [src, dst] of MAP) {
  if (doneDst.has(dst)) continue;
  if (tryCopy(src, dst)) doneDst.add(dst);
}

const missing = MAP.filter(([src, dst]) => !fs.existsSync(path.join(DEST, dst))).map(([, d]) => d);
if (missing.length) console.warn("Не скопированы (нет исходника в Загрузках):", [...new Set(missing)].join(", "));
console.log("Готово.");
