/**
 * NOWPayments: создание платежа и проверка IPN (упрощённо).
 * @see https://documenter.getpostman.com/view/7907941/2s93JusNJt
 */

import crypto from "crypto";

const API_BASE_PROD = "https://api.nowpayments.io/v1";
const API_BASE_SANDBOX = "https://api-sandbox.nowpayments.io/v1";

/**
 * Проверка подписи IPN (sort keys + HMAC-SHA512).
 * @param {Record<string, unknown>} body
 * @param {string} signatureHeader x-nowpayments-sig или поле signature
 */
export function verifyNowpaymentsSignature(body, signatureHeader, ipnSecret) {
  if (!ipnSecret || !signatureHeader) return false;
  try {
    const clone = { ...body };
    delete clone.signature;
    const sortedKeys = Object.keys(clone).sort();
    const sorted = {};
    for (const k of sortedKeys) {
      if (clone[k] !== undefined && clone[k] !== null) sorted[k] = clone[k];
    }
    const payload = JSON.stringify(sorted);
    const h = crypto.createHmac("sha512", ipnSecret);
    h.update(payload);
    const digest = h.digest("hex");
    return crypto.timingSafeEqual(Buffer.from(digest, "hex"), Buffer.from(String(signatureHeader).trim(), "hex"));
  } catch {
    return false;
  }
}

/**
 * Альтернатива: некоторые версии API шлют подпись от сырого тела.
 */
export function verifyNowpaymentsSignatureRaw(rawBody, signatureHeader, ipnSecret) {
  if (!ipnSecret || !signatureHeader) return false;
  try {
    const h = crypto.createHmac("sha512", ipnSecret);
    h.update(rawBody);
    const digest = h.digest("hex");
    return crypto.timingSafeEqual(Buffer.from(digest, "hex"), Buffer.from(String(signatureHeader).trim(), "hex"));
  } catch {
    return false;
  }
}

/**
 * Создание счёта на hosted-странице NOWPayments (QR, адрес, сумма в крипте).
 * Используется POST /invoice — не /payment (у /payment другой ответ, часто без нормальной страницы оплаты).
 *
 * `amount` — сумма в единицах `priceCurrency`. Чтобы на странице оплаты было «ровно 50 USDT», а не пересчёт из USD,
 * задавайте `price_currency` той же сети, что и `pay_currency` (например оба `usdtbsc`).
 *
 * @param {{ apiKey: string, amountUsd: number, orderId: string, ipnUrl: string, successUrl?: string, cancelUrl?: string, payCurrency?: string, priceCurrency?: string, apiBase?: string, orderDescription?: string }} p
 */
export async function createNowpaymentInvoice(p) {
  const apiBase = (p.apiBase || API_BASE_PROD).replace(/\/$/, "");
  const payCur = String(p.payCurrency || "usdtbsc").trim().toLowerCase();
  const priceCur = String(p.priceCurrency ?? payCur).trim().toLowerCase();
  const res = await fetch(`${apiBase}/invoice`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": p.apiKey,
    },
    body: JSON.stringify({
      price_amount: p.amountUsd,
      price_currency: priceCur,
      pay_currency: payCur,
      order_id: p.orderId,
      order_description: p.orderDescription || "Pixel Battle — пополнение баланса (USDT)",
      ipn_callback_url: p.ipnUrl,
      success_url: p.successUrl || p.ipnUrl,
      cancel_url: p.cancelUrl || p.successUrl || p.ipnUrl,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const msg = data?.message || data?.error || res.statusText;
    throw new Error(typeof msg === "string" ? msg : "NOWPayments error");
  }
  const invoiceUrl = data.invoice_url || data.invoiceUrl || "";
  if (!invoiceUrl) {
    throw new Error("NOWPayments не вернул invoice_url");
  }
  return {
    id: data.id,
    paymentUrl: invoiceUrl,
    payAddress: data.pay_address,
    payAmount: data.pay_amount,
    payCurrency: data.pay_currency,
    raw: data,
  };
}

export { API_BASE_PROD, API_BASE_SANDBOX };
