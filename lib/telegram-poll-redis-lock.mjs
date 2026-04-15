/**
 * Один процесс на кластере опрашивает Telegram getUpdates. Без этого при rolling deploy
 * на Render два инстанса с REDIS_URL оба считаются «лидерами» → HTTP 409 Conflict.
 */
import { createClient } from "redis";

function socketOptions() {
  return {
    connectTimeout: 15_000,
    reconnectStrategy: (retries) => {
      if (retries > 80) return new Error("[redis] telegram-lock reconnect limit");
      return Math.min(250 + retries * 150, 10_000);
    },
  };
}

const LOCK_TTL_SEC = 55;
const REFRESH_MS = 20_000;
const ACQUIRE_RETRY_MS = 5_000;

/**
 * @param {{ redisUrl: string, lockKey: string, instanceId: string, onLockHeld: () => void }} opts
 */
export async function startTelegramPollWhenRedisLockHeld(opts) {
  const { redisUrl, lockKey, instanceId, onLockHeld } = opts;
  let client;
  let refreshTimer = null;
  let retryTimer = null;
  let started = false;

  const cleanupTimers = () => {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    if (retryTimer) {
      clearInterval(retryTimer);
      retryTimer = null;
    }
  };

  const tryAcquireAndStart = async () => {
    if (started) return true;
    try {
      if (!client) {
        client = createClient({ url: redisUrl, socket: socketOptions() });
        client.on("error", (e) => console.warn("[redis telegram-lock]", e?.message || e));
        await client.connect();
      }
      const ok = await client.set(lockKey, instanceId, { NX: true, EX: LOCK_TTL_SEC });
      if (ok !== "OK") return false;
      started = true;
      if (retryTimer) {
        clearInterval(retryTimer);
        retryTimer = null;
      }
      refreshTimer = setInterval(() => {
        void (async () => {
          try {
            const v = await client.get(lockKey);
            if (v === instanceId) await client.expire(lockKey, LOCK_TTL_SEC);
          } catch (e) {
            console.warn("[redis telegram-lock] refresh:", e?.message || e);
          }
        })();
      }, REFRESH_MS);
      onLockHeld();
      return true;
    } catch (e) {
      console.warn("[redis telegram-lock] acquire:", e?.message || e);
      return false;
    }
  };

  if (await tryAcquireAndStart()) return;

  retryTimer = setInterval(() => {
    void tryAcquireAndStart();
  }, ACQUIRE_RETRY_MS);
}
