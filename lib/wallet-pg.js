/**
 * Кошелёк на PostgreSQL (Neon и др.). Тот же смысл таблиц, что в wallet-db.js (SQLite).
 * Нужен DATABASE_URL. Для нескольких инстансов — общая БД; гонки между процессами см. wallet-backend.js.
 */

import pg from "pg";
import { quantToUsdt } from "./tournament-economy.js";
import { defaultUser, migrateEconomyUser } from "./wallet-store.js";

const { Pool } = pg;

const DDL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    player_key TEXT NOT NULL UNIQUE,
    telegram_user_id BIGINT,
    created_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS balances (
    user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    balance_usdt DOUBLE PRECISION NOT NULL DEFAULT 0,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS economy_state (
    user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ledger_entries (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    entry_type TEXT NOT NULL,
    amount_usdt DOUBLE PRECISION NOT NULL,
    reference_id TEXT UNIQUE,
    meta TEXT,
    created_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS payments (
    id BIGSERIAL PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_payment_id TEXT NOT NULL UNIQUE,
    user_id BIGINT NOT NULL REFERENCES users(id),
    amount_usdt DOUBLE PRECISION NOT NULL,
    status TEXT NOT NULL,
    created_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger_entries(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ledger_ref ON ledger_entries(reference_id)`,
];

function roundMoney(n) {
  return Math.round(Number(n) * 1e6) / 1e6;
}

function sanitizePlayerKey(s) {
  return String(s ?? "").trim().slice(0, 128);
}

function defaultEconomyJson() {
  return JSON.stringify({
    lastActionAt: 0,
    lastZoneCaptureAt: 0,
    lastMassCaptureAt: 0,
    lastZone12CaptureAt: 0,
    personalRecoveryUntil: 0,
    personalRecoverySec: 20,
    invitedByPlayerKey: "",
  });
}

export class WalletPg {
  /**
   * @param {import("pg").Pool} pool
   */
  constructor(pool) {
    this.pool = pool;
    /** @type {Record<string, import("./wallet-store.js").EconomyUser>} */
    this.users = {};
    /** @type {Array<Record<string, unknown>>} */
    this.transactions = [];
    /** @type {Set<string>} */
    this.confirmedCache = new Set();
    /** @type {Array<{ pk: string, amount: number, note: string, now: number }>} */
    this._pendingLedger = [];
  }

  async ensureSchema() {
    for (const sql of DDL_STATEMENTS) {
      try {
        await this.pool.query(sql);
      } catch (e) {
        console.warn("[wallet-pg] schema:", e?.message || e);
      }
    }
  }

  /**
   * @param {import("pg").PoolClient} client
   */
  async _ensureUserRowTx(client, pk) {
    const k = sanitizePlayerKey(pk);
    if (!k) return 0;
    const now = Date.now();
    await client.query(
      `INSERT INTO users (player_key, created_at) VALUES ($1, $2)
       ON CONFLICT (player_key) DO NOTHING`,
      [k, now]
    );
    const r = await client.query(`SELECT id FROM users WHERE player_key = $1`, [k]);
    const uid = r.rows[0]?.id;
    if (!uid) return 0;
    const uidNum = Number(uid);
    await client.query(
      `INSERT INTO balances (user_id, balance_usdt, updated_at) VALUES ($1, 0, $2)
       ON CONFLICT (user_id) DO NOTHING`,
      [uidNum, now]
    );
    await client.query(
      `INSERT INTO economy_state (user_id, json) VALUES ($1, $2)
       ON CONFLICT (user_id) DO NOTHING`,
      [uidNum, defaultEconomyJson()]
    );
    return uidNum;
  }

  async _ensureUserRow(pk) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const id = await this._ensureUserRowTx(client, pk);
      await client.query("COMMIT");
      return id;
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore */
      }
      console.warn("[wallet-pg] _ensureUserRow:", e?.message || e);
      return 0;
    } finally {
      client.release();
    }
  }

  /**
   * @param {import("pg").PoolClient} client
   * @param {string} pk
   */
  async _flushUserTx(client, pk) {
    const k = sanitizePlayerKey(pk);
    if (!k || !this.users[k]) return;
    const u = this.users[k];
    const uid = await this._ensureUserRowTx(client, k);
    if (!uid) return;
    const { balanceUSDT, ...rest } = u;
    const econ = { ...rest };
    delete econ.balanceUSDT;
    const now = Date.now();
    await client.query(
      `UPDATE balances SET balance_usdt = $1, updated_at = $2 WHERE user_id = $3`,
      [roundMoney(balanceUSDT), now, uid]
    );
    await client.query(`UPDATE economy_state SET json = $1 WHERE user_id = $2`, [JSON.stringify(econ), uid]);
  }

  /**
   * Запись balance + economy_state только для перечисленных ключей (горячий путь пикселя).
   * Не трогает _pendingLedger — полный `save()` по-прежнему после покупок.
   * @param {string[]} playerKeys
   */
  async flushUsersEconomy(playerKeys) {
    const keys = [...new Set((playerKeys || []).map((p) => sanitizePlayerKey(String(p || ""))).filter(Boolean))];
    if (!keys.length) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const pk of keys) {
        await this._flushUserTx(client, pk);
      }
      await client.query("COMMIT");
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore */
      }
      console.warn("[wallet-pg] flushUsersEconomy:", e?.message || e);
    } finally {
      client.release();
    }
  }

  async save() {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const p of this._pendingLedger) {
        const uid = await this._ensureUserRowTx(client, p.pk);
        if (!uid) continue;
        await client.query(
          `INSERT INTO ledger_entries (user_id, entry_type, amount_usdt, reference_id, meta, created_at)
           VALUES ($1, 'spend', $2, NULL, $3, $4)`,
          [uid, -Math.abs(Number(p.amount) || 0), String(p.note || ""), p.now]
        );
      }
      this._pendingLedger = [];
      const keys = Object.keys(this.users);
      for (const pk of keys) {
        await this._flushUserTx(client, pk);
      }
      await client.query("COMMIT");
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore */
      }
      console.warn("[wallet-pg] save:", e?.message || e);
    } finally {
      client.release();
    }
  }

  /**
   * Горячий путь покупок: записать только отложенный ledger и balance/economy для указанных игроков.
   * Полный save() обходит всех закэшированных users — на проде это легко секунды при сотнях ключей в памяти.
   * @param {string[]} playerKeys
   */
  async persistPurchaseWrites(playerKeys) {
    const keySet = new Set(
      (playerKeys || []).map((p) => sanitizePlayerKey(String(p || ""))).filter(Boolean)
    );
    const pending = this._pendingLedger;
    this._pendingLedger = [];
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const p of pending) {
        const pk = sanitizePlayerKey(p.pk);
        const uid = await this._ensureUserRowTx(client, pk);
        if (!uid) continue;
        await client.query(
          `INSERT INTO ledger_entries (user_id, entry_type, amount_usdt, reference_id, meta, created_at)
           VALUES ($1, 'spend', $2, NULL, $3, $4)`,
          [uid, -Math.abs(Number(p.amount) || 0), String(p.note || ""), p.now]
        );
        if (pk) keySet.add(pk);
      }
      for (const pk of keySet) {
        await this._flushUserTx(client, pk);
      }
      await client.query("COMMIT");
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore */
      }
      this._pendingLedger = pending.concat(this._pendingLedger);
      console.warn("[wallet-pg] persistPurchaseWrites:", e?.message || e);
      await this.save();
    } finally {
      client.release();
    }
  }

  /**
   * @returns {Promise<import("./wallet-store.js").EconomyUser>}
   */
  async getOrCreateUser(playerKey) {
    const k = sanitizePlayerKey(playerKey);
    if (!k) return defaultUser();
    /* Повторные пиксели в одной сессии: не бить БД SELECT на каждый клик (один процесс — объект в памяти актуален). */
    if (this.users[k]) {
      migrateEconomyUser(this.users[k]);
      return this.users[k];
    }
    const r = await this.pool.query(
      `SELECT b.balance_usdt AS balance_usdt, e.json AS json
       FROM users u
       JOIN balances b ON b.user_id = u.id
       JOIN economy_state e ON e.user_id = u.id
       WHERE u.player_key = $1`,
      [k]
    );
    if (r.rows[0]) {
      const row = r.rows[0];
      let econ = {};
      try {
        econ = JSON.parse(String(row.json || "{}"));
      } catch {
        econ = {};
      }
      const u = { ...defaultUser(), ...econ, balanceUSDT: roundMoney(Number(row.balance_usdt) || 0) };
      migrateEconomyUser(u);
      this.users[k] = u;
      return u;
    }
    await this._ensureUserRow(k);
    const u = { ...defaultUser() };
    migrateEconomyUser(u);
    this.users[k] = u;
    return u;
  }

  async trySpend(playerKey, amount, opts = {}) {
    const u = await this.getOrCreateUser(playerKey);
    if (opts.devUnlimited) {
      return { ok: true, user: u };
    }
    if (u.balanceUSDT + 1e-9 < amount) return { ok: false, reason: "not enough balance" };
    u.balanceUSDT = roundMoney(u.balanceUSDT - amount);
    if (!opts.deferSave) await this.save();
    return { ok: true, user: u };
  }

  async trySpendQuant(playerKey, quantAmount, opts = {}) {
    const usdt = quantToUsdt(quantAmount);
    return this.trySpend(playerKey, usdt, opts);
  }

  async trySpendTugri(playerKey, amount, opts = {}) {
    return this.trySpendQuant(playerKey, amount, opts);
  }

  async recordSpend(playerKey, amount, note, opts = {}) {
    const pk = sanitizePlayerKey(playerKey);
    if (!pk) return;
    const now = Date.now();
    const amt = Math.abs(Number(amount) || 0);
    const id = `tx_${now}_${Math.random().toString(36).slice(2, 9)}`;
    this.transactions.push({
      id,
      userId: pk,
      type: "spend",
      amount: amt,
      currency: "USDT",
      status: "confirmed",
      meta: note || "",
      createdAt: now,
    });
    if (this.transactions.length > 5000) this.transactions = this.transactions.slice(-5000);

    if (opts.deferSave) {
      this._pendingLedger.push({ pk, amount: amt, note: String(note || ""), now });
    } else {
      const uid = await this._ensureUserRow(pk);
      if (!uid) return;
      await this.pool.query(
        `INSERT INTO ledger_entries (user_id, entry_type, amount_usdt, reference_id, meta, created_at)
         VALUES ($1, 'spend', $2, NULL, $3, $4)`,
        [uid, -amt, String(note || ""), now]
      );
      await this.save();
    }
  }

  async hasPaymentId(npId) {
    const id = String(npId || "");
    if (!id) return false;
    if (this.confirmedCache.has(id)) return true;
    const r = await this.pool.query(
      `SELECT 1 AS x FROM ledger_entries WHERE reference_id = $1 LIMIT 1`,
      [id]
    );
    if (r.rowCount > 0) {
      this.confirmedCache.add(id);
      return true;
    }
    return false;
  }

  async isPaymentProcessed(npId) {
    return this.hasPaymentId(npId);
  }

  markPaymentProcessed(npId) {
    this.confirmedCache.add(String(npId));
  }

  async finalizeDeposit(npId, playerKey, amountUsdt, meta = {}) {
    const id = String(npId || "");
    if (!id || !Number.isFinite(amountUsdt) || amountUsdt <= 0) {
      return { ok: false, duplicate: true };
    }

    const pk = sanitizePlayerKey(playerKey);
    if (!pk) return { ok: false, duplicate: true };

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const dup = await client.query(
        `SELECT 1 AS x FROM ledger_entries WHERE reference_id = $1 FOR UPDATE`,
        [id]
      );
      if (dup.rowCount > 0) {
        await client.query("ROLLBACK");
        return { ok: false, duplicate: true };
      }

      const uid = await this._ensureUserRowTx(client, pk);
      if (!uid) {
        await client.query("ROLLBACK");
        return { ok: false, duplicate: true };
      }

      const credited = roundMoney(amountUsdt);
      const ts = Date.now();
      await client.query(
        `INSERT INTO ledger_entries (user_id, entry_type, amount_usdt, reference_id, meta, created_at)
         VALUES ($1, 'deposit', $2, $3, $4, $5)`,
        [uid, credited, id, String(meta.txHash || ""), ts]
      );
      await client.query(
        `UPDATE balances SET balance_usdt = balance_usdt + $1, updated_at = $2 WHERE user_id = $3`,
        [credited, ts, uid]
      );
      await client.query(
        `INSERT INTO payments (provider, provider_payment_id, user_id, amount_usdt, status, created_at)
         VALUES ('nowpayments', $1, $2, $3, 'confirmed', $4)
         ON CONFLICT (provider_payment_id) DO UPDATE SET
           user_id = EXCLUDED.user_id,
           amount_usdt = EXCLUDED.amount_usdt,
           status = EXCLUDED.status`,
        [id, uid, credited, ts]
      );
      await client.query("COMMIT");
      this.confirmedCache.add(id);

      const rowB = await this.pool.query(
        `SELECT balance_usdt FROM balances b JOIN users u ON u.id = b.user_id WHERE u.player_key = $1`,
        [pk]
      );
      if (!this.users[pk]) this.users[pk] = defaultUser();
      this.users[pk].balanceUSDT = roundMoney(
        Number(rowB.rows[0]?.balance_usdt) || this.users[pk].balanceUSDT
      );
      migrateEconomyUser(this.users[pk]);

      this.transactions.push({
        id: `tx_dep_${id}`,
        userId: pk,
        type: "deposit",
        amount: credited,
        currency: "USDT",
        status: "confirmed",
        nowPaymentId: id,
        createdAt: ts,
      });
      if (this.transactions.length > 5000) this.transactions = this.transactions.slice(-5000);

      return { ok: true };
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore */
      }
      console.warn("[wallet-pg] finalizeDeposit:", e?.message || e);
      return { ok: false, duplicate: true };
    } finally {
      client.release();
    }
  }

  async credit(playerKey, amount, meta = {}) {
    const pk = sanitizePlayerKey(playerKey);
    if (!pk) return;
    const u = await this.getOrCreateUser(pk);
    u.balanceUSDT = roundMoney(u.balanceUSDT + amount);
    const uid = await this._ensureUserRow(pk);
    if (!uid) return;
    const now = Date.now();
    const ref = meta.nowPaymentId != null ? String(meta.nowPaymentId) : null;
    await this.pool.query(
      `INSERT INTO ledger_entries (user_id, entry_type, amount_usdt, reference_id, meta, created_at)
       VALUES ($1, 'deposit', $2, $3, $4, $5)`,
      [uid, roundMoney(amount), ref, String(meta.txHash || ""), now]
    );
    await this.save();
  }

  /** Админ: баланс 0 и сброс economy_state (реферал сохраняется). */
  async adminResetAllTrainingEconomy() {
    const res = await this.pool.query(`SELECT u.id, e.json FROM users u JOIN economy_state e ON e.user_id = u.id`);
    const now = Date.now();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const row of res.rows) {
        let invited = "";
        try {
          const j = JSON.parse(String(row.json || "{}"));
          if (typeof j.invitedByPlayerKey === "string") invited = j.invitedByPlayerKey;
        } catch {
          /* ignore */
        }
        const o = JSON.parse(defaultEconomyJson());
        o.invitedByPlayerKey = invited;
        await client.query(`UPDATE balances SET balance_usdt = 0, updated_at = $1 WHERE user_id = $2`, [
          now,
          row.id,
        ]);
        await client.query(`UPDATE economy_state SET json = $1 WHERE user_id = $2`, [JSON.stringify(o), row.id]);
      }
      await client.query("COMMIT");
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore */
      }
      console.warn("[wallet-pg] adminResetAllTrainingEconomy:", e?.message || e);
      throw e;
    } finally {
      client.release();
    }
    this.users = {};
  }
}

/**
 * @param {string} connectionString
 * @returns {Promise<WalletPg>}
 */
export async function createWalletPg(connectionString) {
  const poolMax = Math.min(20, Math.max(2, Number(process.env.WALLET_PG_POOL_MAX) || 8));
  /** Neon serverless после простоя: первое соединение может занимать несколько секунд. */
  const connectMs = Math.min(
    120_000,
    Math.max(5_000, Number(process.env.WALLET_PG_CONNECT_TIMEOUT_MS) || 30_000)
  );
  const pool = new Pool({
    connectionString,
    max: poolMax,
    idleTimeoutMillis: 60_000,
    connectionTimeoutMillis: connectMs,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  });
  pool.on("error", (e) => console.warn("[wallet-pg] pool:", e?.message || e));
  if (/neon\.tech/i.test(connectionString) && !/pooler/i.test(connectionString)) {
    console.warn(
      "[wallet-pg] Neon: для продакшена возьмите pooled connection string (в консоли Neon — «Connection pooling»), иначе чаще cold start и таймауты."
    );
  }
  const w = new WalletPg(pool);
  await w.ensureSchema();
  console.warn("[wallet-pg] PostgreSQL wallet backend active.");
  return w;
}
