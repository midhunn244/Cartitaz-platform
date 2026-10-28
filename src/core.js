'use strict';
const crypto = require('crypto');
const { httpErr, money } = require('./http');

const STATUSES = ['new_request', 'contacted', 'awaiting_payment', 'confirmed', 'ordered_from_supplier', 'shipped', 'out_for_delivery', 'delivered', 'cancelled', 'refunded'];
const NEXT = {
  new_request: ['contacted', 'awaiting_payment', 'confirmed', 'cancelled'],
  contacted: ['awaiting_payment', 'confirmed', 'cancelled'],
  awaiting_payment: ['confirmed', 'cancelled'],
  confirmed: ['ordered_from_supplier', 'shipped', 'cancelled'],
  ordered_from_supplier: ['shipped', 'cancelled'],
  shipped: ['out_for_delivery', 'delivered', 'cancelled'],
  out_for_delivery: ['delivered', 'cancelled'],
  delivered: [], cancelled: [], refunded: [],
};
const REQUEST_STATUSES = ['new_request', 'contacted', 'awaiting_payment'];
// Orders that count as real sales once a human has confirmed them
const SALE_STATUSES = ['confirmed', 'ordered_from_supplier', 'shipped', 'out_for_delivery', 'delivered', 'refunded'];
const STAGE = { new_request: 0, contacted: 0, awaiting_payment: 0, confirmed: 1, ordered_from_supplier: 2, shipped: 3, out_for_delivery: 4, delivered: 5 };
const LABEL = { new_request: 'Request received', contacted: 'We have contacted you', awaiting_payment: 'Awaiting payment', confirmed: 'Confirmed',
  ordered_from_supplier: 'Processing', shipped: 'Shipped', out_for_delivery: 'Out for delivery', delivered: 'Delivered', cancelled: 'Cancelled', refunded: 'Refunded' };

const DEFAULT_SECTIONS = [
  { type: 'categories', title: 'Shop by category', category: '', enabled: true },
  { type: 'deals', title: 'Deals of the day', category: '', enabled: true },
  { type: 'bestsellers', title: 'Best sellers', category: '', enabled: true },
  { type: 'each_category', title: 'Best of', category: '', enabled: true },
];
const DEFAULTS = {
  store_name: 'Cartitaz', whatsapp_number: '', currency: '$', free_over: 100, shipping: 4,
  announcement: ['Order in minutes on WhatsApp', '7-day easy returns'],
  contact: { email: '', phone: '', address: '', hours: '' },
  policies: { returns: '', shipping: '', privacy: '', terms: '' },
  banners: [], home_sections: DEFAULT_SECTIONS, logo_icon: '', logo_wordmark: '',
};

function makeCore(db) {
  const now = () => Date.now();

  function getSetting(key) {
    const r = db.get('SELECT value FROM settings WHERE key=?', key);
    if (!r) return DEFAULTS[key];
    try { return JSON.parse(r.value); } catch { return DEFAULTS[key]; }
  }
  function setSetting(key, val) {
    db.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(val));
  }
  const allSettings = () => Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, getSetting(k)]));

  function genCode() {
    const A = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
    for (let t = 0; t < 8; t++) {
      const b = crypto.randomBytes(7); let s = 'CT-';
      for (const x of b) s += A[x % A.length];
      if (!db.get('SELECT 1 x FROM orders WHERE code=?', s)) return s;
    }
    throw httpErr(500, 'Could not allocate an order code');
  }

  function calcPromo(code, subtotal) {
    if (!code) return { ok: true, discount: 0, code: null };
    const p = db.get('SELECT * FROM promotions WHERE code=?', code);
    const t = now();
    if (!p || !p.active) return { ok: false, message: 'This promo code is not valid' };
    if ((p.starts_at && t < p.starts_at) || (p.ends_at && t > p.ends_at)) return { ok: false, message: 'This promo code is not active right now' };
    if (p.usage_limit != null && p.used >= p.usage_limit) return { ok: false, message: 'This promo code has been fully used' };
    if (subtotal < p.min_subtotal) return { ok: false, message: `Minimum order for this code is ${p.min_subtotal}` };
    let d = p.kind === 'percent' ? subtotal * p.value / 100 : p.value;
    d = money(Math.min(d, subtotal));
    return { ok: true, discount: d, code: p.code, id: p.id };
  }

  // stock rows for a product (variant-aware)
  function stockOf(productId, variantId) {
    if (variantId) {
      const v = db.get('SELECT stock FROM variants WHERE id=? AND product_id=?', variantId, productId);
      return v ? v.stock : null;
    }
    const hasVariants = db.get('SELECT 1 x FROM variants WHERE product_id=?', productId);
    if (hasVariants) return null; // must choose a variant
    const p = db.get('SELECT stock FROM products WHERE id=?', productId);
    return p ? p.stock : null;
  }
  function moveStock(productId, variantId, delta, reason, orderId, adminId) {
    if (variantId) db.run('UPDATE variants SET stock=stock+? WHERE id=?', delta, variantId);
    else db.run('UPDATE products SET stock=stock+?, updated_at=? WHERE id=?', delta, now(), productId);
    db.run('INSERT INTO stock_moves(ts,product_id,variant_id,delta,reason,order_id,admin_id) VALUES(?,?,?,?,?,?,?)',
      now(), productId, variantId, delta, reason, orderId, adminId);
  }

  // Manual status change. Stock is only committed when a human moves an order to "confirmed".
  function changeStatus(orderId, to, body, adminId) {
    return db.tx(() => {
      const o = db.get('SELECT * FROM orders WHERE id=?', orderId);
      if (!o) throw httpErr(404, 'Order not found');
      if (!(NEXT[o.status] || []).includes(to)) throw httpErr(409, `Cannot change an order from "${o.status}" to "${to}"`);
      const t = now();
      const items = db.all('SELECT * FROM order_items WHERE order_id=?', orderId);
      if (to === 'confirmed' && !o.stock_committed) {
        const short = [];
        for (const it of items) {
          if (!it.product_id) continue;
          if (!db.get('SELECT 1 x FROM products WHERE id=?', it.product_id)) continue; // product deleted later: nothing to track
          const have = stockOf(it.product_id, it.variant_id);
          if (have !== null && have < it.qty) short.push(`${it.name}${it.variant_name ? ' (' + it.variant_name + ')' : ''}: need ${it.qty}, have ${have}`);
        }
        if (short.length) throw httpErr(409, 'Not enough stock: ' + short.join('; ') + '. Adjust inventory first.');
        for (const it of items) {
          if (!it.product_id || !db.get('SELECT 1 x FROM products WHERE id=?', it.product_id)) continue;
          if (stockOf(it.product_id, it.variant_id) !== null) moveStock(it.product_id, it.variant_id, -it.qty, 'Order confirmed ' + o.code, o.id, adminId);
        }
        db.run('UPDATE orders SET stock_committed=1, confirmed_at=COALESCE(confirmed_at,?) WHERE id=?', t, o.id);
        if (o.promo_code) db.run('UPDATE promotions SET used=used+1 WHERE code=?', o.promo_code);
      }
      if (to === 'cancelled' && o.stock_committed) {
        for (const it of items) {
          if (!it.product_id || !db.get('SELECT 1 x FROM products WHERE id=?', it.product_id)) continue;
          if (stockOf(it.product_id, it.variant_id) !== null) moveStock(it.product_id, it.variant_id, it.qty, 'Order cancelled ' + o.code, o.id, adminId);
        }
        db.run('UPDATE orders SET stock_committed=0 WHERE id=?', o.id);
        if (o.promo_code) db.run('UPDATE promotions SET used=MAX(0,used-1) WHERE code=?', o.promo_code);
      }
      db.run('UPDATE orders SET status=?, updated_at=? WHERE id=?', to, t, o.id);
      db.run('INSERT INTO order_events(order_id,ts,status,note,public_note,country,state,district,place,admin_id) VALUES(?,?,?,?,?,?,?,?,?,?)',
        o.id, t, to, body.note, body.public_note, body.country, body.state, body.district, body.place, adminId);
      return { from: o.status, to, code: o.code };
    });
  }

  function recalcTotal(orderId) {
    const items = db.all('SELECT qty,unit_price FROM order_items WHERE order_id=?', orderId);
    const o = db.get('SELECT discount,shipping FROM orders WHERE id=?', orderId);
    const subtotal = money(items.reduce((s, i) => s + i.qty * i.unit_price, 0));
    const total = money(Math.max(0, subtotal - o.discount + o.shipping));
    db.run('UPDATE orders SET subtotal=?, total=?, updated_at=? WHERE id=?', subtotal, total, now(), orderId);
  }

  // ---------- Finance: only from recorded data ----------
  function finance(from, to) {
    const ph = SALE_STATUSES.map(() => '?').join(',');
    const rows = db.all(
      `SELECT o.id,o.subtotal,o.discount,o.shipping,o.total,o.confirmed_at,
        (SELECT COALESCE(SUM(unit_cost*qty),0) FROM order_items WHERE order_id=o.id) cogs,
        (SELECT COUNT(*) FROM order_items WHERE order_id=o.id AND unit_cost IS NULL) missing,
        (SELECT COALESCE(SUM(amount),0) FROM expenses WHERE order_id=o.id) oexp
       FROM orders o WHERE o.status IN (${ph}) AND o.confirmed_at>=? AND o.confirmed_at<?`, ...SALE_STATUSES, from, to);
    const refunds = db.all(
      `SELECT r.amount, (SELECT COUNT(*) FROM order_items WHERE order_id=r.order_id AND unit_cost IS NULL) missing
       FROM refunds r WHERE r.ts>=? AND r.ts<?`, from, to);
    const general = db.get('SELECT COALESCE(SUM(amount),0) s FROM expenses WHERE order_id IS NULL AND ts>=? AND ts<?', from, to).s;
    const f = { orders: rows.length, subtotal: 0, discounts: 0, shipping_charged: 0, net_sales: 0, refunds: 0, cogs: 0, order_expenses: 0,
      general_expenses: money(general), complete_orders: 0, incomplete_orders: 0, incomplete_sales: 0, profit_basis_sales: 0, net_profit: 0, margin: null };
    let profitOrders = 0, refundsComplete = 0;
    for (const r of rows) {
      f.subtotal += r.subtotal; f.discounts += r.discount; f.shipping_charged += r.shipping; f.net_sales += r.total;
      if (r.missing === 0) {
        f.complete_orders++; f.cogs += r.cogs; f.order_expenses += r.oexp; f.profit_basis_sales += r.total;
        profitOrders += r.total - r.cogs - r.oexp;
      } else { f.incomplete_orders++; f.incomplete_sales += r.total; }
    }
    for (const r of refunds) { f.refunds += r.amount; if (r.missing === 0) refundsComplete += r.amount; }
    f.net_profit = profitOrders - refundsComplete - general;
    for (const k of ['subtotal', 'discounts', 'shipping_charged', 'net_sales', 'refunds', 'cogs', 'order_expenses', 'incomplete_sales', 'profit_basis_sales', 'net_profit']) f[k] = money(f[k]);
    f.margin = f.profit_basis_sales > 0 ? Math.round(f.net_profit / f.profit_basis_sales * 1000) / 10 : null;
    const pend = db.get(`SELECT COUNT(*) n, COALESCE(SUM(total),0) s FROM orders WHERE status IN ('new_request','contacted','awaiting_payment')`);
    f.pipeline_orders = pend.n; f.pipeline_value = money(pend.s);
    return f;
  }
  function dailySales(from, to) {
    const ph = SALE_STATUSES.map(() => '?').join(',');
    return db.all(`SELECT strftime('%Y-%m-%d', confirmed_at/1000, 'unixepoch') d, ROUND(SUM(total),2) sales, COUNT(*) n
      FROM orders WHERE status IN (${ph}) AND confirmed_at>=? AND confirmed_at<? GROUP BY d ORDER BY d`, ...SALE_STATUSES, from, to);
  }

  function publicTrack(code, last4) {
    const o = db.get('SELECT * FROM orders WHERE code=?', code);
    if (!o || !String(o.phone).endsWith(String(last4))) return null;
    const ev = db.all('SELECT * FROM order_events WHERE order_id=? ORDER BY ts,id', o.id);
    const t = [null, null, null, null, null, null], loc = [null, null, null, null, null, null];
    for (const e of ev) {
      const k = STAGE[e.status];
      if (k === undefined) continue;
      t[k] = new Date(e.ts).toISOString();
      if (e.country || e.state || e.district || e.place) loc[k] = { c: e.country || '', s: e.state || '', d: e.district || '', p: e.place || '' };
    }
    const last = ev[ev.length - 1];
    return { code: o.code, status: o.status, label: LABEL[o.status], stage: STAGE[o.status] === undefined ? 0 : STAGE[o.status],
      final: (o.status === 'cancelled' || o.status === 'refunded') ? o.status : null, t, loc,
      note: last && last.public_note ? last.public_note : '', total: o.total };
  }

  return { getSetting, setSetting, allSettings, genCode, calcPromo, stockOf, moveStock, changeStatus, recalcTotal, finance, dailySales, publicTrack, now };
}

module.exports = { makeCore, STATUSES, NEXT, REQUEST_STATUSES, SALE_STATUSES, LABEL, DEFAULTS, DEFAULT_SECTIONS };
