/**
 * Одноразовые tg_bridge-токены в Redis: при нескольких инстансах Render in-memory Map на каждом воркере
 * даёт 400 «invalid or expired» на consume (mint и page на разных процессах).
 */
import { createClient } from "redis";
import { redisSocketOptions } from "./redis-game-bus.mjs";

const KEY_PREFIX = "pixel:tgbridge:";

/** @param {string} token */
export function telegramBridgeRedisKey(token) {
  return `${KEY_PREFIX}${token}`;
}

/** @param {string} url */
export async function connectTelegramBridgeRedis(url) {
  const c = createClient({ url, socket: redisSocketOptions() });
  c.on("error", (e) => console.warn("[tg-bridge redis]", e?.message || e));
  await c.connect();
  return c;
}
