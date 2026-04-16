/**
 * Пополнение баланса за USDT (NOWPayments).
 * Жёстко выключено: и на клиенте, и на сервере нельзя включить через env —
 * только правкой этого модуля (осознанный деплой).
 */
export function isUsdtDepositsEnabled() {
  return false;
}
