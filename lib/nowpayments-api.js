/**
 * NOWPayments: создание платежа и проверка IPN (упрощённо).
 * @see https://documenter.getpostman.com/view/7907941/2s93JusNJt
 */

import crypto from "crypto";

const API_BASE = "https://api.nowpayments.io/v1";

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
 * @param {{ apiKey: string, amountUsd: number, orderId: string, ipnUrl: string, successUrl?: string, cancelUrl?: string }} p
 */
export async function createNowpaymentInvoice(p) {
  const res = await fetch(`${API_BASE}/payment`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": p.apiKey,
    },
    body: JSON.stringify({
      price_amount: p.amountUsd,
      price_currency: "usd",
      pay_currency: p.payCurrency || "usdttrc20",
      order_id: p.orderId,
      order_description: "Pixel Battle deposit",
      ipn_callback_url: p.ipnUrl,
      success_url: p.successUrl || p.ipnUrl,
      cancel_url: p.cancelUrl || p.successUrl || p.ipnUrl,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data || data.error) {
    const msg = data?.message || data?.error || res.statusText;
    throw new Error(msg || "NOWPayments error");
  }
  return {
    id: data.id,
    paymentUrl: data.invoice_url || data.pay_address ? `https://nowpayments.io/payment/?iid=${data.id}` : "",
    payAddress: data.pay_address,
    payAmount: data.pay_amount,
    payCurrency: data.pay_currency,
    raw: data,
  };
}
