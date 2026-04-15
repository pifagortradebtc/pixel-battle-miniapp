/**
 * Redis Pub/Sub: один канал — сырые JSON-сообщения как в broadcast() на WS.
 * Подключение опционально (см. REDIS_URL в server.js).
 * Upstash / облако: держим reconnectStrategy и таймаут, чтобы кратковременные сетевые сбои не «убивали» кластер навсегда.
 */
import { createClient } from "redis";

/** @returns {import("redis").RedisSocketOptions} */
function redisSocketOptions() {
  return {
    connectTimeout: 15_000,
    reconnectStrategy: (retries) => {
      if (retries > 80) return new Error("[redis] reconnect limit");
      return Math.min(250 + retries * 150, 10_000);
    },
  };
}

/**
 * @param {{ url: string, channel: string, onMessage: (raw: string) => void }} opts
 */
export async function connectGameRedisBus(opts) {
  const { url, channel, onMessage } = opts;
  const pub = createClient({ url, socket: redisSocketOptions() });
  const sub = pub.duplicate();
  pub.on("error", (e) => console.warn("[redis pub]", e?.message || e));
  sub.on("error", (e) => console.warn("[redis sub]", e?.message || e));
  await pub.connect();
  await sub.connect();
  await sub.subscribe(channel, (message) => {
    if (typeof message === "string") onMessage(message);
  });
  return {
    /** @param {string} raw */
    publish: (raw) => pub.publish(channel, raw),
    close: async () => {
      try {
        await sub.quit();
      } catch {
        /* ignore */
      }
      try {
        await pub.quit();
      } catch {
        /* ignore */
      }
    },
  };
}
