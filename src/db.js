'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const SCHEMA = `
CREATE TABLE admins(
  id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN('owner','manager','support')), pass_hash TEXT NOT NULL,
  totp_secret TEXT, totp_enabled INTEGER NOT NULL DEFAULT 0, totp_last INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0, must_change INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, last_login INTEGER);
CREATE TABLE sessions(
  id TEXT PRIMARY KEY, admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE, csrf TEXT NOT NULL,
  created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, expires_at INTEGER NOT NULL, ip TEXT, ua TEXT);
CREATE TABLE audit(
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, admin_id INTEGER, username TEXT, action TEXT NOT NULL,
  entity TEXT, entity_id TEXT, detail TEXT, ip TEXT);
CREATE INDEX idx_audit_ts ON audit(ts DESC);
CREATE TABLE categories(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, sort INTEGER NOT NULL DEFAULT 0,
  published INTEGER NOT NULL DEFAULT 1, icon TEXT NOT NULL DEFAULT 'Bags', tint TEXT NOT NULL DEFAULT '#E8E5E0');
CREATE TABLE suppliers(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, contact TEXT, phone TEXT, email TEXT, website TEXT,
  lead_days INTEGER, notes TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE media(id TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE products(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, brand TEXT, category_id INTEGER REFERENCES categories(id),
  supplier_id INTEGER REFERENCES suppliers(id), caption TEXT, description TEXT,
  price REAL NOT NULL, compare_price REAL, cost_price REAL, sku TEXT,
  stock INTEGER NOT NULL DEFAULT 0, low_stock INTEGER NOT NULL DEFAULT 3,
  icon TEXT NOT NULL DEFAULT 'Bags', tint TEXT NOT NULL DEFAULT '#E8E5E0',
  published INTEGER NOT NULL DEFAULT 0, internal_notes TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE product_images(
  id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media(id), sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE variants(
  id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL, sku TEXT, stock INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE stock_moves(
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, product_id INTEGER NOT NULL, variant_id INTEGER,
  delta INTEGER NOT NULL, reason TEXT NOT NULL, order_id INTEGER, admin_id INTEGER);
CREATE TABLE customers(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT, address TEXT, pincode TEXT,
  notes TEXT, anonymized INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE UNIQUE INDEX idx_cust_phone ON customers(phone) WHERE anonymized=0;
CREATE TABLE orders(
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, customer_id INTEGER REFERENCES customers(id),
  name TEXT NOT NULL, phone TEXT NOT NULL, address TEXT NOT NULL, pincode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new_request', source TEXT NOT NULL DEFAULT 'whatsapp',
  subtotal REAL NOT NULL, discount REAL NOT NULL DEFAULT 0, shipping REAL NOT NULL DEFAULT 0, total REAL NOT NULL,
  promo_code TEXT, internal_notes TEXT, stock_committed INTEGER NOT NULL DEFAULT 0,
  confirmed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX idx_orders_status ON orders(status, created_at DESC);
CREATE TABLE order_items(
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER, variant_id INTEGER, name TEXT NOT NULL, variant_name TEXT, qty INTEGER NOT NULL,
  unit_price REAL NOT NULL, unit_cost REAL, supplier_id INTEGER);
CREATE TABLE order_events(
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE, ts INTEGER NOT NULL,
  status TEXT NOT NULL, note TEXT, public_note TEXT, country TEXT, state TEXT, district TEXT, place TEXT, admin_id INTEGER);
CREATE TABLE expenses(
  id INTEGER PRIMARY KEY, order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL, kind TEXT NOT NULL,
  amount REAL NOT NULL, note TEXT, ts INTEGER NOT NULL, admin_id INTEGER);
CREATE TABLE refunds(
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  amount REAL NOT NULL, note TEXT, ts INTEGER NOT NULL, admin_id INTEGER);
CREATE TABLE promotions(
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE COLLATE NOCASE, kind TEXT NOT NULL CHECK(kind IN('percent','fixed')),
  value REAL NOT NULL, min_subtotal REAL NOT NULL DEFAULT 0, starts_at INTEGER, ends_at INTEGER,
  usage_limit INTEGER, used INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;
const RECOVERY = `CREATE TABLE IF NOT EXISTS recovery_codes(
  id INTEGER PRIMARY KEY, admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE, hash TEXT NOT NULL, used_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_recovery ON recovery_codes(admin_id, hash);`;

const norm = (p) => p.map((x) => (x === undefined ? null : typeof x === 'boolean' ? +x : x));

function open(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, 'cartitaz.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;');
  const v = db.prepare('PRAGMA user_version').get().user_version;
  if (v === 0) { db.exec(SCHEMA); db.exec(RECOVERY); db.exec('PRAGMA user_version=2'); }
  else if (v === 1) { db.exec(RECOVERY); db.exec('PRAGMA user_version=2'); }
  try { fs.chmodSync(file, 0o600); } catch {}
  const cache = new Map();
  const prep = (sql) => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };
  return {
    all: (sql, ...p) => prep(sql).all(...norm(p)),
    get: (sql, ...p) => prep(sql).get(...norm(p)),
    run: (sql, ...p) => prep(sql).run(...norm(p)),
    tx(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const r = fn(); db.exec('COMMIT'); return r; }
      catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
    },
    close: () => db.close(),
  };
}
module.exports = { open };
