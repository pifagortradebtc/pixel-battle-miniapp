/**
 * Локальная симуляция нагрузки: много WS-сообщений подряд.
 * Запуск: node scripts/stress-concurrency-sim.mjs
 * Переменные: STRESS_URL (ws://127.0.0.1:3847/ws), STRESS_N (число сообщений)
 *
 * Без валидного Telegram initData сервер не примет игровые действия в проде —
 * сценарий для проверки лимитов и стабильности парсера, не для обхода auth.
 */

import WebSocket from "ws";

const url = process.env.STRESS_URL || "ws://127.0.0.1:3847/ws";
const n = Math.min(500, Math.max(1, Number(process.env.STRESS_N) || 40));

const ws = new WebSocket(url);
let sent = 0;
let errors = 0;

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "clientProfile", playerKey: "stress_test_key", initData: "" }));
  const t = setInterval(() => {
    if (sent >= n) {
      clearInterval(t);
      ws.close();
      return;
    }
    sent++;
    ws.send(
      JSON.stringify({
        type: "purchasePersonalRecovery",
        playerKey: "stress_test_key",
        tierSec: 10,
      })
    );
  }, 5);
});

ws.on("message", (data) => {
  try {
    const msg = JSON.parse(String(data));
    if (msg.type === "purchaseError" && msg.reason === "rate_limited") errors++;
  } catch {
    /* ignore */
  }
});

ws.on("close", () => {
  console.log(JSON.stringify({ url, messagesSent: sent, rateLimitedResponses: errors, note: "expect rate_limited if auth passed" }));
  process.exit(0);
});

ws.on("error", (e) => {
  console.error("ws error:", e.message);
  process.exit(1);
});

setTimeout(() => {
  console.error("timeout");
  process.exit(1);
}, 12000);
