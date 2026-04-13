/**
 * Production-grade кошелёк: SQLite (sql.js, WASM) + ledger + атомарные транзакции.
 * Совместим по API с WalletStore — server.js меняется минимально.
 *
 * WALLET_BACKEND=json — прежний JSON (lib/wallet-store.js).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import initSqlJs from "sql.js";
import { quantToUsdt } from "./tournament-economy.js";
import { defaultUser, migrateEconomyUser } from "./wallet-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_key TEXT NOT NULL UNIQUE,
  telegram_user_id INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS balances (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance_usdt REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS economy_state (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  entry_type TEXT NOT NULL,
  amount_usdt REAL NOT NULL,
  reference_id TEXT UNIQUE,
  meta TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  provider_payment_id TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount_usdt REAL NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger_entries(user_id);
CREATE INDEX IF NOT EXISTS idx_ledger_ref ON ledger_entries(reference_id);
`;

function roundMoney(n) {
  return Math.round(Number(n) * 1e6) / 1e6;
}

function sanitizePlayerKey(s) {
  return String(s ?? "").trim().slice(0, 128);
}

function persistDatabase(db, dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const data = db.export();
  const buf = Buffer.from(data);
  const tmp = `${dbPath}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dbPath);
}

function execLastInsertId(db) {
  const r = db.exec("SELECT last_insert_rowid() AS id");
  if (!r.length || !r[0].values?.length) return 0;
  return r[0].values[0][0] | 0;
}

/**
 * @param {import("sql.js").Database} db
 */
function getOne(db, sql, params) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (!stmt.step()) {
    stmt.free();
    return null;
  }
  const row = stmt.getAsObject();
  stmt.free();
  return row;
}

/**
 * @param {import("sql.js").Database} db
 */
function getAll(db, sql, params) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

export class WalletDb {
  /**
   * @param {import("sql.js").Database} db
   * @param {string} dataDir
   * @param {string} dbPath
   */
  constructor(db, dataDir, dbPath) {
    this.db = db;
    this.dataDir = dataDir;
    this.dbPath = dbPath;
    /** @type {Record<string, import("./wallet-store.js").EconomyUser>} */
    this.users = {};
    /** @type {Array<Record<string, unknown>>} */
    this.transactions = [];
    /** @type {Set<string>} */
    this.confirmedPaymentIds = new Set();

    try {
      db.exec("PRAGMA foreign_keys = ON;");
      db.exec(SCHEMA);
    } catch (e) {
      console.warn("[wallet-db] schema exec:", e.message);
    }

    this._loadFromDb();
    this._migrateFromLegacyJsonIfNeeded();
  }

  _loadFromDb() {
    const rows = getAll(
      this.db,
      `SELECT u.player_key AS player_key, u.id AS user_id, b.balance_usdt AS balance_usdt, e.json AS json
       FROM users u
       JOIN balances b ON b.user_id = u.id
       JOIN economy_state e ON e.user_id = u.id`,
      []
    );
    for (const row of rows) {
      const pk = row.player_key;
      let econ = {};
      try {
        econ = JSON.parse(String(row.json || "{}"));
      } catch {
        econ = {};
      }
      const u = { ...defaultUser(), ...econ, balanceUSDT: roundMoney(Number(row.balance_usdt) || 0) };
      migrateEconomyUser(u);
      this.users[pk] = u;
    }

    const ledger = getAll(
      this.db,
      `SELECT user_id, entry_type, amount_usdt, reference_id, meta, created_at FROM ledger_entries ORDER BY id DESC LIMIT 5000`,
      []
    );
    this.transactions = ledger.map((r) => ({
      id: `tx_${r.created_at}_${r.reference_id || ""}`,
      userId: String(r.user_id),
      type: r.entry_type === "deposit" ? "deposit" : "spend",
      amount: Math.abs(Number(r.amount_usdt)),
      currency: "USDT",
      status: "confirmed",
      nowPaymentId: r.reference_id || "",
      meta: r.meta || "",
      createdAt: r.created_at,
    }));

    const refs = getAll(this.db, `SELECT reference_id FROM ledger_entries WHERE reference_id IS NOT NULL AND reference_id != ''`, []);
    for (const r of refs) {
      if (r.reference_id) this.confirmedPaymentIds.add(String(r.reference_id));
    }
  }

  _migrateFromLegacyJsonIfNeeded() {
    const usersPath = path.join(this.dataDir, "economy-users.json");
    const txsPath = path.join(this.dataDir, "economy-transactions.json");
    if (!fs.existsSync(usersPath)) return;

    const count = getOne(this.db, "SELECT COUNT(*) AS c FROM users", []);
    if (count && Number(count.c) > 0) {
      console.warn("[wallet-db] SQLite already has users; skip JSON migration (remove economy-users.json manually if needed).");
      return;
    }

    try {
      const j = JSON.parse(fs.readFileSync(usersPath, "utf8"));
      const rawUsers = typeof j.users === "object" && j.users ? j.users : {};
      for (const [pk, u] of Object.entries(rawUsers)) {
        const k = sanitizePlayerKey(pk);
        if (!k) continue;
        const merged = { ...defaultUser(), ...u };
        migrateEconomyUser(merged);
        this.users[k] = merged;
      }

      if (fs.existsSync(txsPath)) {
        const tj = JSON.parse(fs.readFileSync(txsPath, "utf8"));
        const txs = Array.isArray(tj.transactions) ? tj.transactions : [];
        for (const t of txs.slice(-5000)) {
          if (t.nowPaymentId) this.confirmedPaymentIds.add(String(t.nowPaymentId));
        }
      }

      this.save();
      fs.renameSync(usersPath, `${usersPath}.migrated`);
      if (fs.existsSync(txsPath)) fs.renameSync(txsPath, `${txsPath}.migrated`);
      console.warn("[wallet-db] Migrated legacy economy JSON → SQLite.");
    } catch (e) {
      console.warn("[wallet-db] JSON migration failed:", e.message);
    }
  }

  _ensureUserRow(playerKey) {
    const pk = sanitizePlayerKey(playerKey);
    if (!pk) return null;
    let row = getOne(this.db, "SELECT u.id AS id FROM users u WHERE u.player_key = ?", [pk]);
    if (row) return row.id | 0;

    const now = Date.now();
    this.db.run("INSERT INTO users (player_key, created_at) VALUES (?, ?)", [pk, now]);
    const uid = execLastInsertId(this.db);
    this.db.run("INSERT INTO balances (user_id, balance_usdt, updated_at) VALUES (?, 0, ?)", [uid, now]);
    const econ = JSON.stringify({
      lastActionAt: 0,
      lastZoneCaptureAt: 0,
      lastMassCaptureAt: 0,
      lastZone12CaptureAt: 0,
      personalRecoveryUntil: 0,
      personalRecoverySec: 20,
      invitedByPlayerKey: "",
    });
    this.db.run("INSERT INTO economy_state (user_id, json) VALUES (?, ?)", [uid, econ]);
    return uid;
  }

  _persist() {
    persistDatabase(this.db, this.dbPath);
  }

  _flushUserToDb(playerKey) {
    const pk = sanitizePlayerKey(playerKey);
    if (!pk || !this.users[pk]) return;
    const u = this.users[pk];
    const uid = this._ensureUserRow(pk);
    if (!uid) return;

    const { balanceUSDT, ...rest } = u;
    const econ = { ...rest };
    delete econ.balanceUSDT;
    const now = Date.now();
    this.db.run("UPDATE balances SET balance_usdt = ?, updated_at = ? WHERE user_id = ?", [
      roundMoney(balanceUSDT),
      now,
      uid,
    ]);
    this.db.run("UPDATE economy_state SET json = ? WHERE user_id = ?", [JSON.stringify(econ), uid]);
  }

  save() {
    try {
      this.db.run("BEGIN IMMEDIATE");
      for (const pk of Object.keys(this.users)) {
        this._flushUserToDb(pk);
      }
      this.db.run("COMMIT");
      this._persist();
    } catch (e) {
      try {
        this.db.run("ROLLBACK");
      } catch {
        /* ignore */
      }
      console.warn("wallet-db save:", e.message);
    }
  }

  /**
   * Только перечисленные игроки (пиксель без полного прохода по кэшу).
   * @param {string[]} playerKeys
   */
  flushUsersEconomy(playerKeys) {
    const keys = [...new Set((playerKeys || []).map((p) => sanitizePlayerKey(String(p || ""))).filter(Boolean))];
    if (!keys.length) return;
    try {
      this.db.run("BEGIN IMMEDIATE");
      for (const pk of keys) {
        this._flushUserToDb(pk);
      }
      this.db.run("COMMIT");
      this._persist();
    } catch (e) {
      try {
        this.db.run("ROLLBACK");
      } catch {
        /* ignore */
      }
      console.warn("wallet-db flushUsersEconomy:", e.message);
    }
  }

  /**
   * @returns {EconomyUser}
   */
  getOrCreateUser(playerKey) {
    const k = sanitizePlayerKey(playerKey);
    if (!k) return defaultUser();
    if (!this.users[k]) {
      const row = getOne(
        this.db,
        `SELECT b.balance_usdt AS balance_usdt, e.json AS json
         FROM users u
         JOIN balances b ON b.user_id = u.id
         JOIN economy_state e ON e.user_id = u.id
         WHERE u.player_key = ?`,
        [k]
      );
      if (row) {
        let econ = {};
        try {
          econ = JSON.parse(String(row.json || "{}"));
        } catch {
          econ = {};
        }
        this.users[k] = { ...defaultUser(), ...econ, balanceUSDT: roundMoney(Number(row.balance_usdt) || 0) };
      } else {
        this.users[k] = defaultUser();
      }
    }
    migrateEconomyUser(this.users[k]);
    return this.users[k];
  }

  trySpend(playerKey, amount, opts = {}) {
    const u = this.getOrCreateUser(playerKey);
    if (opts.devUnlimited) {
      return { ok: true, user: u };
    }
    if (u.balanceUSDT + 1e-9 < amount) return { ok: false, reason: "not enough balance" };
    u.balanceUSDT = roundMoney(u.balanceUSDT - amount);
    if (!opts.deferSave) this.save();
    return { ok: true, user: u };
  }

  trySpendQuant(playerKey, quantAmount, opts = {}) {
    const usdt = quantToUsdt(quantAmount);
    return this.trySpend(playerKey, usdt, opts);
  }

  trySpendTugri(playerKey, amount, opts = {}) {
    return this.trySpendQuant(playerKey, amount, opts);
  }

  recordSpend(playerKey, amount, note, opts = {}) {
    const pk = sanitizePlayerKey(playerKey);
    if (!pk) return;
    const uid = this._ensureUserRow(pk);
    const now = Date.now();
    const id = `tx_${now}_${Math.random().toString(36).slice(2, 9)}`;
    const amt = Math.abs(Number(amount) || 0);
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

    this.db.run(
      `INSERT INTO ledger_entries (user_id, entry_type, amount_usdt, reference_id, meta, created_at) VALUES (?, 'spend', ?, NULL, ?, ?)`,
      [uid, -amt, String(note || ""), now]
    );
    if (!opts.deferSave) this.save();
    else this._persist();
  }

  hasPaymentId(npId) {
    const id = String(npId || "");
    if (!id) return false;
    if (this.confirmedPaymentIds.has(id)) return true;
    const row = getOne(this.db, "SELECT 1 AS x FROM ledger_entries WHERE reference_id = ?", [id]);
    return !!row;
  }

  isPaymentProcessed(npId) {
    return this.hasPaymentId(npId);
  }

  markPaymentProcessed(npId) {
    this.confirmedPaymentIds.add(String(npId));
  }

  finalizeDeposit(npId, playerKey, amountUsdt, meta = {}) {
    const id = String(npId || "");
    if (!id || !Number.isFinite(amountUsdt) || amountUsdt <= 0) {
      return { ok: false, duplicate: true };
    }
    if (this.hasPaymentId(id)) {
      return { ok: false, duplicate: true };
    }

    const pk = sanitizePlayerKey(playerKey);
    if (!pk) return { ok: false, duplicate: true };

    try {
      this.db.run("BEGIN IMMEDIATE");
      const uid = this._ensureUserRow(pk);
      this.db.run(
        `INSERT INTO ledger_entries (user_id, entry_type, amount_usdt, reference_id, meta, created_at) VALUES (?, 'deposit', ?, ?, ?, ?)`,
        [uid, roundMoney(amountUsdt), id, String(meta.txHash || ""), Date.now()]
      );
      this.db.run("UPDATE balances SET balance_usdt = balance_usdt + ?, updated_at = ? WHERE user_id = ?", [
        roundMoney(amountUsdt),
        Date.now(),
        uid,
      ]);
      this.db.run(
        `INSERT OR REPLACE INTO payments (provider, provider_payment_id, user_id, amount_usdt, status, created_at) VALUES ('nowpayments', ?, ?, ?, 'confirmed', ?)`,
        [id, uid, roundMoney(amountUsdt), Date.now()]
      );
      this.db.run("COMMIT");
      this.confirmedPaymentIds.add(id);

      if (!this.users[pk]) this.users[pk] = defaultUser();
      const rowB = getOne(this.db, "SELECT balance_usdt FROM balances b JOIN users u ON u.id = b.user_id WHERE u.player_key = ?", [pk]);
      this.users[pk].balanceUSDT = roundMoney(Number(rowB?.balance_usdt) || this.users[pk].balanceUSDT);
      this.transactions.push({
        id: `tx_dep_${id}`,
        userId: pk,
        type: "deposit",
        amount: roundMoney(amountUsdt),
        currency: "USDT",
        status: "confirmed",
        nowPaymentId: id,
        createdAt: Date.now(),
      });
      if (this.transactions.length > 5000) this.transactions = this.transactions.slice(-5000);

      this._persist();
      return { ok: true };
    } catch (e) {
      try {
        this.db.run("ROLLBACK");
      } catch {
        /* ignore */
      }
      console.warn("finalizeDeposit:", e.message);
      return { ok: false, duplicate: true };
    }
  }

  credit(playerKey, amount, meta = {}) {
    const pk = sanitizePlayerKey(playerKey);
    if (!pk) return;
    const u = this.getOrCreateUser(pk);
    u.balanceUSDT = roundMoney(u.balanceUSDT + amount);
    const uid = this._ensureUserRow(pk);
    const now = Date.now();
    this.db.run(
      `INSERT INTO ledger_entries (user_id, entry_type, amount_usdt, reference_id, meta, created_at) VALUES (?, 'deposit', ?, ?, ?, ?)`,
      [uid, roundMoney(amount), meta.nowPaymentId || null, String(meta.txHash || ""), now]
    );
    this.save();
  }
}

/**
 * @param {string} dataDir
 * @returns {Promise<WalletDb>}
 */
export async function createWalletDb(dataDir) {
  const locateFile = (file) => path.join(__dirname, "..", "node_modules", "sql.js", "dist", file);
  const SQL = await initSqlJs({ locateFile });
  const dbPath = path.join(dataDir, "economy.sqlite");
  let db;
  if (fs.existsSync(dbPath)) {
    const filebuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(filebuffer);
  } else {
    db = new SQL.Database();
  }
  return new WalletDb(db, dataDir, dbPath);
}
