/**
 * Валидация initData из Telegram Mini App (HMAC-SHA256).
 * @see https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */

import crypto from "crypto";

/**
 * Сравнение hex-строк без утечки по длине и без throw при неверной длине.
 * @param {string} a
 * @param {string} b
 */
function timingSafeEqualHex(a, b) {
  try {
    const ba = Buffer.from(String(a).trim(), "hex");
    const bb = Buffer.from(String(b).trim(), "hex");
    if (ba.length !== bb.length || ba.length === 0) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

/**
 * @param {string} initData — строка из Telegram.WebApp.initData
 * @param {string} botToken — токен бота
 * @param {{ maxAgeSec?: number }} [opts] — maxAgeSec: отклонять подпись старше N секунд (по auth_date)
 * @returns {{ id: number, username: string } | null}
 */
export function verifyTelegramWebAppInitData(initData, botToken, opts = {}) {
  if (!initData || !botToken) return null;
  const maxAgeSec = typeof opts.maxAgeSec === "number" && opts.maxAgeSec > 0 ? opts.maxAgeSec : 86400;
  let params;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return null;
  }
  const hash = params.get("hash");
  if (!hash) return null;
  const authDateRaw = params.get("auth_date");
  if (authDateRaw == null || authDateRaw === "") return null;
  const authTs = Number(authDateRaw);
  if (!Number.isFinite(authTs) || authTs <= 0) return null;
  const ageSec = Date.now() / 1000 - authTs;
  if (ageSec < -120 || ageSec > maxAgeSec) return null;
  params.delete("hash");
  const pairs = [];
  for (const [k, v] of params.entries()) {
    pairs.push([k, v]);
  }
  pairs.sort((a, b) => a[0].localeCompare(b[0]));
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join("\n");
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const computed = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  if (!timingSafeEqualHex(computed, hash)) {
    return null;
  }
  const userStr = params.get("user");
  if (!userStr) return null;
  let user;
  try {
    user = JSON.parse(userStr);
  } catch {
    return null;
  }
  if (!user || typeof user.id !== "number") return null;
  return { id: user.id | 0, username: typeof user.username === "string" ? user.username : "" };
}
