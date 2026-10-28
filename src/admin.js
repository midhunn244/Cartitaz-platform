'use strict';
const crypto = require('crypto');
const sec = require('./security');
const { F, VErr, httpErr, money, normPhone } = require('./http');
const { STATUSES, NEXT, REQUEST_STATUSES, LABEL } = require('./core');

const ICONS = ['Bags', 'Watches', 'Home', 'Candle', 'Wellness'];
const HEX = /^#[0-9a-fA-F]{6}$/;
const EXPENSE_KINDS = ['shipping_cost', 'payment_fee', 'packaging', 'advertising', 'other'];
const ROLE_PERMS = {
  owner: new Set(['*']),
  manager: new Set(['products:r', 'products:w', 'categories:r', 'categories:w', 'orders:r', 'orders:status', 'orders:w', 'customers:r', 'customers:w',
    'suppliers:r', 'suppliers:w', 'inventory:r', 'inventory:w', 'promotions:r', 'promotions:w', 'settings:r', 'settings:w', 'finance:r', 'finance:w']),
  support: new Set(['products:r', 'categories:r', 'orders:r', 'orders:status', 'customers:r', 'inventory:r']),
};
const can = (role, perm) => { const s = ROLE_PERMS[role]; return !!s && (s.has('*') || s.has(perm)); };
const permList = (role) => ['products:r', 'products:w', 'categories:r', 'categories:w', 'orders:r', 'orders:status', 'orders:w', 'customers:r', 'customers:w', 'suppliers:r',
  'suppliers:w', 'inventory:r', 'inventory:w', 'promotions:r', 'promotions:w', 'settings:r', 'settings:w', 'finance:r', 'finance:w', 'security:r', 'security:w'].filter((p) => can(role, p));

function sniff(buf) {
  if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'image/png';
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}
const dayMs = (s, endOfDay = false) => { const t = Date.parse(s + 'T00:00:00Z'); return Number.isNaN(t) ? null : t + (endOfDay ? 86400000 : 0); };

function register({ db, core, cfg, limiter, audit }) {
  const routes = [];
  const now = () => Date.now();
  const add = (method, path, perm, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + path.replace(/:[a-z_]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, perm, handler, ...opts });
  };
  const idParam = (ctx, k = 'id') => { const n = Number(ctx.params[k]); if (!Number.isInteger(n) || n < 1) throw httpErr(404, 'Not found'); return n; };
  const page = (q) => ({ limit: Math.min(200, Math.max(1, parseInt(q.limit, 10) || 50)), offset: Math.max(0, parseInt(q.offset, 10) || 0) });
  const like = (s) => '%' + String(s).replace(/[\\%_]/g, '\\$&') + '%';
  const cookie = (v, clear) => `cc_session=${v}; HttpOnly; SameSite=Strict; Path=${cfg.adminPath}${cfg.cookieSecure ? '; Secure' : ''}${clear ? '; Max-Age=0' : ''}`;

  // =====================================================================
  // AUTH
  // =====================================================================
  const lockout = (a, t) => {
    const failed = a.failed + 1;
    if (failed >= 5) db.run('UPDATE admins SET failed=0, locked_until=? WHERE id=?', t + 15 * 60 * 1000, a.id);
    else db.run('UPDATE admins SET failed=? WHERE id=?', failed, a.id);
  };
  const RC = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
  function newRecoveryCodes(adminId) {
    const codes = [];
    db.tx(() => {
      db.run('DELETE FROM recovery_codes WHERE admin_id=?', adminId);
      for (let i = 0; i < 8; i++) {
        const b = crypto.randomBytes(10); let c = ''; for (const x of b) c += RC[x % RC.length];
        codes.push(c.slice(0, 5) + '-' + c.slice(5));
        db.run('INSERT INTO recovery_codes(admin_id,hash) VALUES(?,?)', adminId, sec.sha256('rc:' + c));
      }
    });
    return codes;
  }
  const recoveryLeft = (adminId) => db.get('SELECT COUNT(*) n FROM recovery_codes WHERE admin_id=? AND used_at IS NULL', adminId).n;
  add('POST', '/login', null, async (ctx) => {
    const d = new F(ctx.body).str('username', { req: true, max: 60 }).str('password', { req: true, max: 300, trim: false }).str('totp', { max: 24 }).done();
    const ipHit = limiter.hit('login:ip:' + ctx.ip, 15, 15 * 60 * 1000);
    if (!ipHit.ok) throw httpErr(429, 'Too many sign-in attempts. Try again later.', { retry: ipHit.retry });
    const a = db.get('SELECT * FROM admins WHERE username=?', d.username);
    const t = now();
    const generic = httpErr(401, 'Invalid username or password');
    if (!a) { await sec.verifyPassword(d.password, await sec.dummyHash()); audit(ctx, 'login.failed', 'admin', null, { username: d.username.slice(0, 40), reason: 'unknown_user' }); throw generic; }
    if (a.locked_until > t) {
      await sec.verifyPassword(d.password, await sec.dummyHash());
      audit(ctx, 'login.blocked', 'admin', a.id, { reason: 'locked' }, a);
      throw httpErr(429, 'This account is temporarily locked after repeated failed attempts. Try again in 15 minutes.', { retry: Math.ceil((a.locked_until - t) / 1000) });
    }
    const ok = await sec.verifyPassword(d.password, a.pass_hash);
    if (!ok || a.disabled) { if (!a.disabled) lockout(a, t); audit(ctx, 'login.failed', 'admin', a.id, { reason: a.disabled ? 'disabled' : 'bad_password' }, a); throw generic; }
    let counter = null;
    if (a.totp_enabled) {
      if (!d.totp) throw httpErr(401, 'Enter your authentication code', { need_totp: true });
      const secret = sec.decrypt(a.totp_secret, cfg.appSecret);
      const code = String(d.totp).trim();
      if (/^\d{6}$/.test(code)) counter = secret ? sec.totpVerify(secret, code, a.totp_last) : null;
      else {   // one-time recovery code (consumed on use)
        const norm = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
        const used = norm.length === 10 && db.run('UPDATE recovery_codes SET used_at=? WHERE admin_id=? AND hash=? AND used_at IS NULL', t, a.id, sec.sha256('rc:' + norm)).changes === 1;
        if (used) { counter = 0; audit(ctx, 'login.recovery_code_used', 'admin', a.id, null, a); } else counter = null;
      }
      if (counter === null) { lockout(a, t); audit(ctx, 'login.failed', 'admin', a.id, { reason: 'bad_totp' }, a); throw httpErr(401, 'Invalid authentication code', { need_totp: true }); }
    }
    db.run('UPDATE admins SET failed=0, locked_until=0, last_login=?, totp_last=CASE WHEN ? > 0 THEN ? ELSE totp_last END WHERE id=?', t, counter, counter, a.id);
    const sid = sec.token(32), csrf = sec.token(24);
    db.run('INSERT INTO sessions(id,admin_id,csrf,created_at,last_seen,expires_at,ip,ua) VALUES(?,?,?,?,?,?,?,?)', sec.sha256(sid), a.id, csrf, t, t, t + cfg.sessionMaxMs, ctx.ip, String(ctx.req.headers['user-agent'] || '').slice(0, 200));
    db.run('DELETE FROM sessions WHERE admin_id=? AND id NOT IN (SELECT id FROM sessions WHERE admin_id=? ORDER BY last_seen DESC LIMIT 8)', a.id, a.id);
    ctx.headers['Set-Cookie'] = cookie(sid);
    audit(ctx, 'login.success', 'admin', a.id, null, a);
    return { ok: true };
  }, { public: true });

  add('POST', '/logout', null, async (ctx) => {
    db.run('DELETE FROM sessions WHERE id=?', ctx.session.id);
    ctx.headers['Set-Cookie'] = cookie('', true);
    audit(ctx, 'logout', 'admin', ctx.admin.id);
    return { ok: true };
  }, { allowMustChange: true });

  add('GET', '/me', null, async (ctx) => {
    const a = ctx.admin;
    return { admin: { id: a.id, username: a.username, name: a.name, role: a.role, totp_enabled: !!a.totp_enabled, must_change: !!a.must_change, recovery_left: a.totp_enabled ? recoveryLeft(a.id) : 0 },
      csrf: ctx.session.csrf, perms: permList(a.role), currency: core.getSetting('currency'), statuses: STATUSES, next: NEXT, labels: LABEL, icons: ICONS };
  }, { allowMustChange: true });

  add('POST', '/password', null, async (ctx) => {
    const d = new F(ctx.body).str('current', { req: true, max: 300, trim: false }).str('next', { req: true, max: 300, trim: false }).done();
    if (!(await sec.verifyPassword(d.current, ctx.admin.pass_hash))) { audit(ctx, 'password.change_failed', 'admin', ctx.admin.id); throw new VErr({ current: 'Current password is incorrect' }); }
    const prob = sec.passwordProblem(d.next, ctx.admin.username);
    if (prob) throw new VErr({ next: prob });
    if (d.next === d.current) throw new VErr({ next: 'Choose a different password' });
    db.run('UPDATE admins SET pass_hash=?, must_change=0 WHERE id=?', await sec.hashPassword(d.next), ctx.admin.id);
    db.run('DELETE FROM sessions WHERE admin_id=? AND id<>?', ctx.admin.id, ctx.session.id);
    audit(ctx, 'password.changed', 'admin', ctx.admin.id);
    return { ok: true };
  }, { allowMustChange: true });

  add('POST', '/2fa/setup', null, async (ctx) => {
    if (ctx.admin.totp_enabled) throw httpErr(409, 'Two-factor authentication is already enabled');
    const secret = sec.newTotpSecret();
    db.run('UPDATE admins SET totp_secret=? WHERE id=?', sec.encrypt(secret, cfg.appSecret), ctx.admin.id);
    const issuer = encodeURIComponent('Cartitaz Admin');
    return { secret, uri: `otpauth://totp/${issuer}:${encodeURIComponent(ctx.admin.username)}?secret=${secret}&issuer=${issuer}&digits=6&period=30` };
  });
  add('POST', '/2fa/enable', null, async (ctx) => {
    const d = new F(ctx.body).str('code', { req: true, max: 8 }).done();
    if (ctx.admin.totp_enabled || !ctx.admin.totp_secret) throw httpErr(409, 'Start setup first');
    const secret = sec.decrypt(ctx.admin.totp_secret, cfg.appSecret);
    const c = secret ? sec.totpVerify(secret, d.code, 0) : null;
    if (c === null) throw new VErr({ code: 'That code is not correct' });
    db.run('UPDATE admins SET totp_enabled=1, totp_last=? WHERE id=?', c, ctx.admin.id);
    db.run('DELETE FROM sessions WHERE admin_id=? AND id<>?', ctx.admin.id, ctx.session.id);
    const recovery_codes = newRecoveryCodes(ctx.admin.id);
    audit(ctx, '2fa.enabled', 'admin', ctx.admin.id);
    return { ok: true, recovery_codes };
  });
  add('POST', '/2fa/disable', null, async (ctx) => {
    const d = new F(ctx.body).str('password', { req: true, max: 300, trim: false }).str('code', { req: true, max: 8 }).done();
    if (!(await sec.verifyPassword(d.password, ctx.admin.pass_hash))) throw new VErr({ password: 'Incorrect password' });
    const secret = ctx.admin.totp_secret ? sec.decrypt(ctx.admin.totp_secret, cfg.appSecret) : null;
    if (!ctx.admin.totp_enabled || !secret || sec.totpVerify(secret, d.code, ctx.admin.totp_last) === null) throw new VErr({ code: 'That code is not correct' });
    db.run('UPDATE admins SET totp_enabled=0, totp_secret=NULL, totp_last=0 WHERE id=?', ctx.admin.id);
    db.run('DELETE FROM recovery_codes WHERE admin_id=?', ctx.admin.id);
    audit(ctx, '2fa.disabled', 'admin', ctx.admin.id);
    return { ok: true };
  });
  add('POST', '/2fa/recovery', null, async (ctx) => {   // issue a fresh set; the old codes stop working
    const d = new F(ctx.body).str('password', { req: true, max: 300, trim: false }).str('code', { req: true, max: 8 }).done();
    if (!(await sec.verifyPassword(d.password, ctx.admin.pass_hash))) throw new VErr({ password: 'Incorrect password' });
    const secret = ctx.admin.totp_secret ? sec.decrypt(ctx.admin.totp_secret, cfg.appSecret) : null;
    const c = ctx.admin.totp_enabled && secret ? sec.totpVerify(secret, d.code, ctx.admin.totp_last) : null;
    if (c === null) throw new VErr({ code: 'That code is not correct' });
    db.run('UPDATE admins SET totp_last=? WHERE id=?', c, ctx.admin.id);
    audit(ctx, '2fa.recovery_regenerated', 'admin', ctx.admin.id);
    return { recovery_codes: newRecoveryCodes(ctx.admin.id) };
  });

  // =====================================================================
  // CATEGORIES
  // =====================================================================
  const catInput = (b) => new F(b).str('name', { req: true, max: 40 }).num('sort', { int: true, min: 0, max: 9999 }).bool('published', 1)
    .en('icon', ICONS, { req: false }).str('tint', { re: HEX }).done();
  add('GET', '/categories', 'categories:r', async () =>
    db.all('SELECT c.*, (SELECT COUNT(*) FROM products WHERE category_id=c.id) products FROM categories c ORDER BY sort, name'));
  add('POST', '/categories', 'categories:w', async (ctx) => {
    const c = catInput(ctx.body);
    if (db.get('SELECT 1 x FROM categories WHERE name=?', c.name)) throw new VErr({ name: 'A category with this name already exists' });
    const r = db.run('INSERT INTO categories(name,sort,published,icon,tint) VALUES(?,?,?,?,?)', c.name, c.sort || 0, c.published, c.icon || 'Bags', c.tint || '#E8E5E0');
    audit(ctx, 'category.create', 'category', r.lastInsertRowid, c); ctx.status = 201;
    return { id: Number(r.lastInsertRowid) };
  });
  add('PUT', '/categories/:id', 'categories:w', async (ctx) => {
    const id = idParam(ctx), c = catInput(ctx.body);
    if (!db.get('SELECT 1 x FROM categories WHERE id=?', id)) throw httpErr(404, 'Category not found');
    if (db.get('SELECT 1 x FROM categories WHERE name=? AND id<>?', c.name, id)) throw new VErr({ name: 'A category with this name already exists' });
    db.run('UPDATE categories SET name=?,sort=?,published=?,icon=?,tint=? WHERE id=?', c.name, c.sort || 0, c.published, c.icon || 'Bags', c.tint || '#E8E5E0', id);
    audit(ctx, 'category.update', 'category', id, c); return { ok: true };
  });
  add('DELETE', '/categories/:id', 'categories:w', async (ctx) => {
    const id = idParam(ctx);
    if (db.get('SELECT 1 x FROM products WHERE category_id=?', id)) throw httpErr(409, 'Move or delete the products in this category first');
    db.run('DELETE FROM categories WHERE id=?', id); audit(ctx, 'category.delete', 'category', id); return { ok: true };
  });

  // =====================================================================
  // SUPPLIERS (private)
  // =====================================================================
  const supInput = (b) => new F(b).str('name', { req: true, max: 80 }).str('contact', { max: 80 }).str('phone', { max: 30 })
    .str('email', { max: 120, re: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, msg: 'Enter a valid email' })
    .str('website', { max: 200, re: /^https?:\/\/[^\s]+$/i, msg: 'Must start with http:// or https://' })
    .num('lead_days', { int: true, min: 0, max: 365 }).str('notes', { max: 2000 }).done();
  add('GET', '/suppliers', 'suppliers:r', async () =>
    db.all('SELECT s.*, (SELECT COUNT(*) FROM products WHERE supplier_id=s.id) products FROM suppliers s ORDER BY name'));
  add('POST', '/suppliers', 'suppliers:w', async (ctx) => {
    const s = supInput(ctx.body), t = now();
    const r = db.run('INSERT INTO suppliers(name,contact,phone,email,website,lead_days,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', s.name, s.contact, s.phone, s.email, s.website, s.lead_days, s.notes, t, t);
    audit(ctx, 'supplier.create', 'supplier', r.lastInsertRowid, { name: s.name }); ctx.status = 201; return { id: Number(r.lastInsertRowid) };
  });
  add('PUT', '/suppliers/:id', 'suppliers:w', async (ctx) => {
    const id = idParam(ctx), s = supInput(ctx.body);
    if (!db.get('SELECT 1 x FROM suppliers WHERE id=?', id)) throw httpErr(404, 'Supplier not found');
    db.run('UPDATE suppliers SET name=?,contact=?,phone=?,email=?,website=?,lead_days=?,notes=?,updated_at=? WHERE id=?', s.name, s.contact, s.phone, s.email, s.website, s.lead_days, s.notes, now(), id);
    audit(ctx, 'supplier.update', 'supplier', id, { name: s.name }); return { ok: true };
  });
  add('DELETE', '/suppliers/:id', 'suppliers:w', async (ctx) => {
    const id = idParam(ctx);
    db.tx(() => { db.run('UPDATE products SET supplier_id=NULL WHERE supplier_id=?', id); db.run('UPDATE order_items SET supplier_id=NULL WHERE supplier_id=?', id); db.run('DELETE FROM suppliers WHERE id=?', id); });
    audit(ctx, 'supplier.delete', 'supplier', id); return { ok: true };
  });

  // =====================================================================
  // PRODUCTS
  // =====================================================================
  const scrubProduct = (p, role) => { if (!can(role, 'finance:r')) { delete p.cost_price; delete p.supplier_id; delete p.supplier_name; delete p.internal_notes; } return p; };
  add('GET', '/products', 'products:r', async (ctx) => {
    const q = ctx.query, w = [], p = [];
    if (q.q) { w.push("(p.name LIKE ? ESCAPE '\\' OR p.sku LIKE ? ESCAPE '\\' OR p.brand LIKE ? ESCAPE '\\')"); p.push(like(q.q), like(q.q), like(q.q)); }
    if (q.category_id) { w.push('p.category_id=?'); p.push(Number(q.category_id) || 0); }
    if (q.status === 'published') w.push('p.published=1'); else if (q.status === 'draft') w.push('p.published=0');
    const { limit, offset } = page(q);
    const rows = db.all(`SELECT p.*, c.name category_name, s.name supplier_name,
      (SELECT COUNT(*) FROM variants WHERE product_id=p.id) variant_count,
      CASE WHEN EXISTS(SELECT 1 FROM variants WHERE product_id=p.id) THEN (SELECT COALESCE(SUM(stock),0) FROM variants WHERE product_id=p.id) ELSE p.stock END stock_total,
      (SELECT media_id FROM product_images WHERE product_id=p.id ORDER BY sort,id LIMIT 1) cover
      FROM products p LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN suppliers s ON s.id=p.supplier_id
      ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY p.updated_at DESC LIMIT ? OFFSET ?`, ...p, limit, offset);
    return rows.map((r) => scrubProduct({ ...r }, ctx.admin.role));
  });
  const loadProduct = (id, role) => {
    const p = db.get('SELECT p.*, c.name category_name, s.name supplier_name FROM products p LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN suppliers s ON s.id=p.supplier_id WHERE p.id=?', id);
    if (!p) throw httpErr(404, 'Product not found');
    return scrubProduct({ ...p, variants: db.all('SELECT id,name,sku,stock FROM variants WHERE product_id=? ORDER BY sort,id', id),
      images: db.all('SELECT id,media_id FROM product_images WHERE product_id=? ORDER BY sort,id', id) }, role);
  };
  add('GET', '/products/:id', 'products:r', async (ctx) => loadProduct(idParam(ctx), ctx.admin.role));

  function productInput(b) {
    const f = new F(b).str('name', { req: true, max: 120 }).str('brand', { max: 60 }).num('category_id', { int: true, min: 1 }).num('supplier_id', { int: true, min: 1 })
      .str('caption', { max: 200 }).str('description', { max: 4000 }).num('price', { req: true, min: 0.01, max: 10000000 })
      .num('compare_price', { min: 0.01, max: 10000000 }).num('cost_price', { min: 0, max: 10000000 }).str('sku', { max: 60 })
      .num('stock', { int: true, min: 0, max: 1000000 }).num('low_stock', { int: true, min: 0, max: 100000 })
      .en('icon', ICONS, { req: false }).str('tint', { re: HEX }).bool('published').str('internal_notes', { max: 4000 });
    const o = f.out;
    if (o.price != null && o.compare_price != null && o.compare_price <= o.price) f.bad('compare_price', 'Original price must be higher than the selling price');
    if (o.category_id && !db.get('SELECT 1 x FROM categories WHERE id=?', o.category_id)) f.bad('category_id', 'Category not found');
    if (o.supplier_id && !db.get('SELECT 1 x FROM suppliers WHERE id=?', o.supplier_id)) f.bad('supplier_id', 'Supplier not found');
    if (o.published && !o.category_id) f.bad('category_id', 'Choose a category before publishing');
    let variants = [];
    if (b && b.variants !== undefined) {
      if (!Array.isArray(b.variants) || b.variants.length > 40) f.bad('variants', 'Up to 40 variants allowed');
      else {
        const seen = new Set();
        variants = b.variants.map((v, i) => {
          const vf = new F(v).str('name', { req: true, max: 60 }).str('sku', { max: 40 }).num('stock', { int: true, min: 0, max: 1000000 }).num('id', { int: true, min: 1 });
          if (Object.keys(vf.err).length) { f.bad('variants', `Variant ${i + 1}: ${Object.values(vf.err)[0]}`); return null; }
          const k = vf.out.name.toLowerCase(); if (seen.has(k)) f.bad('variants', `Duplicate variant name "${vf.out.name}"`); seen.add(k);
          return { id: vf.out.id, name: vf.out.name, sku: vf.out.sku, stock: vf.out.stock || 0 };
        }).filter(Boolean);
      }
    }
    f.done();
    return { p: { ...o, stock: o.stock || 0, low_stock: o.low_stock == null ? 3 : o.low_stock, icon: o.icon || 'Bags', tint: o.tint || '#E8E5E0' }, variants: b && b.variants !== undefined ? variants : null };
  }
  function syncVariants(pid, list, ctx) {
    const existing = new Map(db.all('SELECT id,stock FROM variants WHERE product_id=?', pid).map((r) => [r.id, r.stock]));
    const keep = new Set();
    list.forEach((v, i) => {
      if (v.id && existing.has(v.id)) {
        db.run('UPDATE variants SET name=?,sku=?,stock=?,sort=? WHERE id=?', v.name, v.sku, v.stock, i, v.id); keep.add(v.id);
        if (v.stock !== existing.get(v.id)) db.run('INSERT INTO stock_moves(ts,product_id,variant_id,delta,reason,admin_id) VALUES(?,?,?,?,?,?)', now(), pid, v.id, v.stock - existing.get(v.id), 'Edited in product form', ctx.admin.id);
      } else {
        const r = db.run('INSERT INTO variants(product_id,name,sku,stock,sort) VALUES(?,?,?,?,?)', pid, v.name, v.sku, v.stock, i); keep.add(Number(r.lastInsertRowid));
        if (v.stock) db.run('INSERT INTO stock_moves(ts,product_id,variant_id,delta,reason,admin_id) VALUES(?,?,?,?,?,?)', now(), pid, Number(r.lastInsertRowid), v.stock, 'Initial stock', ctx.admin.id);
      }
    });
    for (const id of existing.keys()) if (!keep.has(id)) db.run('DELETE FROM variants WHERE id=?', id);
  }
  add('POST', '/products', 'products:w', async (ctx) => {
    const { p, variants } = productInput(ctx.body), t = now();
    const id = db.tx(() => {
      const r = db.run(`INSERT INTO products(name,brand,category_id,supplier_id,caption,description,price,compare_price,cost_price,sku,stock,low_stock,icon,tint,published,internal_notes,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, p.name, p.brand, p.category_id, p.supplier_id, p.caption, p.description, p.price, p.compare_price, p.cost_price, p.sku, p.stock, p.low_stock, p.icon, p.tint, p.published, p.internal_notes, t, t);
      const pid = Number(r.lastInsertRowid);
      if (variants) syncVariants(pid, variants, ctx);
      if (p.stock && !(variants && variants.length)) db.run('INSERT INTO stock_moves(ts,product_id,delta,reason,admin_id) VALUES(?,?,?,?,?)', t, pid, p.stock, 'Initial stock', ctx.admin.id);
      return pid;
    });
    audit(ctx, 'product.create', 'product', id, { name: p.name, price: p.price, cost_price: p.cost_price, published: p.published });
    ctx.status = 201; return { id };
  });
  add('PUT', '/products/:id', 'products:w', async (ctx) => {
    const id = idParam(ctx), before = db.get('SELECT * FROM products WHERE id=?', id);
    if (!before) throw httpErr(404, 'Product not found');
    const { p, variants } = productInput(ctx.body);
    db.tx(() => {
      db.run(`UPDATE products SET name=?,brand=?,category_id=?,supplier_id=?,caption=?,description=?,price=?,compare_price=?,cost_price=?,sku=?,stock=?,low_stock=?,icon=?,tint=?,published=?,internal_notes=?,updated_at=? WHERE id=?`,
        p.name, p.brand, p.category_id, p.supplier_id, p.caption, p.description, p.price, p.compare_price, p.cost_price, p.sku, p.stock, p.low_stock, p.icon, p.tint, p.published, p.internal_notes, now(), id);
      if (p.stock !== before.stock) db.run('INSERT INTO stock_moves(ts,product_id,delta,reason,admin_id) VALUES(?,?,?,?,?)', now(), id, p.stock - before.stock, 'Edited in product form', ctx.admin.id);
      if (variants) syncVariants(id, variants, ctx);
    });
    const diff = {};
    for (const k of ['name', 'price', 'compare_price', 'cost_price', 'published', 'category_id', 'supplier_id']) if (before[k] !== p[k]) diff[k] = [before[k], p[k]];
    audit(ctx, 'product.update', 'product', id, diff); return { ok: true };
  });
  add('POST', '/products/:id/publish', 'products:w', async (ctx) => {
    const id = idParam(ctx), pub = new F(ctx.body).bool('published').done().published;
    const p = db.get('SELECT * FROM products WHERE id=?', id);
    if (!p) throw httpErr(404, 'Product not found');
    if (pub && !p.category_id) throw httpErr(409, 'Choose a category before publishing');
    db.run('UPDATE products SET published=?, updated_at=? WHERE id=?', pub, now(), id);
    audit(ctx, pub ? 'product.publish' : 'product.unpublish', 'product', id, { name: p.name }); return { ok: true, published: pub };
  });
  add('DELETE', '/products/:id', 'products:w', async (ctx) => {
    const id = idParam(ctx), p = db.get('SELECT name FROM products WHERE id=?', id);
    if (!p) throw httpErr(404, 'Product not found');
    db.tx(() => {
      const media = db.all('SELECT media_id FROM product_images WHERE product_id=?', id).map((r) => r.media_id);
      db.run('DELETE FROM products WHERE id=?', id);
      for (const m of media) db.run('DELETE FROM media WHERE id=?', m);
    });
    audit(ctx, 'product.delete', 'product', id, { name: p.name }); return { ok: true };
  });

  function saveMedia(dataB64, maxBytes) {
    if (typeof dataB64 !== 'string' || !dataB64) throw new VErr({ data: 'Choose an image' });
    const buf = Buffer.from(dataB64.replace(/^data:[^,]+,/, ''), 'base64');
    if (!buf.length) throw new VErr({ data: 'Empty image' });
    if (buf.length > maxBytes) throw new VErr({ data: `Image is too large (max ${Math.round(maxBytes / 1024)} KB)` });
    const mime = sniff(buf);
    if (!mime) throw new VErr({ data: 'Only JPEG, PNG or WebP images are allowed' });
    const id = crypto.randomBytes(12).toString('hex');
    db.run('INSERT INTO media(id,mime,data,created_at) VALUES(?,?,?,?)', id, mime, buf, now());
    return id;
  }
  add('POST', '/products/:id/images', 'products:w', async (ctx) => {
    const id = idParam(ctx);
    if (!db.get('SELECT 1 x FROM products WHERE id=?', id)) throw httpErr(404, 'Product not found');
    if (db.get('SELECT COUNT(*) n FROM product_images WHERE product_id=?', id).n >= 8) throw httpErr(409, 'A product can have up to 8 images');
    const mid = saveMedia(ctx.body && ctx.body.data, 1536 * 1024);
    const sort = db.get('SELECT COALESCE(MAX(sort),0)+1 s FROM product_images WHERE product_id=?', id).s;
    const r = db.run('INSERT INTO product_images(product_id,media_id,sort) VALUES(?,?,?)', id, mid, sort);
    db.run('UPDATE products SET updated_at=? WHERE id=?', now(), id);
    audit(ctx, 'product.image_add', 'product', id); ctx.status = 201; return { id: Number(r.lastInsertRowid), media_id: mid };
  }, { limit: 3 * 1024 * 1024 });
  add('POST', '/products/:id/images/:img/cover', 'products:w', async (ctx) => {
    const id = idParam(ctx), img = idParam(ctx, 'img');
    const min = db.get('SELECT COALESCE(MIN(sort),0)-1 s FROM product_images WHERE product_id=?', id).s;
    if (!db.run('UPDATE product_images SET sort=? WHERE id=? AND product_id=?', min, img, id).changes) throw httpErr(404, 'Image not found');
    audit(ctx, 'product.image_cover', 'product', id); return { ok: true };
  });
  add('DELETE', '/products/:id/images/:img', 'products:w', async (ctx) => {
    const id = idParam(ctx), img = idParam(ctx, 'img');
    const row = db.get('SELECT media_id FROM product_images WHERE id=? AND product_id=?', img, id);
    if (!row) throw httpErr(404, 'Image not found');
    db.tx(() => { db.run('DELETE FROM product_images WHERE id=?', img); db.run('DELETE FROM media WHERE id=?', row.media_id); });
    audit(ctx, 'product.image_remove', 'product', id); return { ok: true };
  });
  add('GET', '/media/:id', null, async (ctx) => {
    const m = db.get('SELECT mime,data FROM media WHERE id=?', ctx.params.id);
    if (!m) throw httpErr(404, 'Not found');
    return { __raw: true, status: 200, headers: { 'Content-Type': m.mime, 'Content-Security-Policy': "default-src 'none'", 'Cache-Control': 'private, max-age=300' }, body: Buffer.from(m.data) };
  });

  // =====================================================================
  // INVENTORY
  // =====================================================================
  add('GET', '/inventory', 'inventory:r', async () => db.all(`
    SELECT p.id product_id, NULL variant_id, p.name, NULL variant_name, p.sku, p.stock, p.low_stock, p.published FROM products p
      WHERE NOT EXISTS(SELECT 1 FROM variants v WHERE v.product_id=p.id)
    UNION ALL
    SELECT p.id, v.id, p.name, v.name, v.sku, v.stock, p.low_stock, p.published FROM variants v JOIN products p ON p.id=v.product_id
    ORDER BY 3, 4`));
  add('POST', '/inventory/adjust', 'inventory:w', async (ctx) => {
    const d = new F(ctx.body).num('product_id', { req: true, int: true, min: 1 }).num('variant_id', { int: true, min: 1 })
      .num('delta', { req: true, int: true, min: -1000000, max: 1000000 }).str('reason', { req: true, min: 3, max: 120 }).done();
    if (!d.delta) throw new VErr({ delta: 'Enter a non-zero change' });
    const have = core.stockOf(d.product_id, d.variant_id);
    if (have === null) throw httpErr(404, 'Stock item not found');
    if (have + d.delta < 0) throw httpErr(409, `Stock cannot go below zero (current: ${have})`);
    db.tx(() => core.moveStock(d.product_id, d.variant_id, d.delta, d.reason, null, ctx.admin.id));
    audit(ctx, 'inventory.adjust', 'product', d.product_id, { variant_id: d.variant_id, delta: d.delta, reason: d.reason });
    return { stock: have + d.delta };
  });
  add('GET', '/inventory/moves', 'inventory:r', async (ctx) => {
    const pid = Number(ctx.query.product_id) || 0;
    return db.all(`SELECT m.*, a.username, v.name variant_name, p.name product_name FROM stock_moves m LEFT JOIN admins a ON a.id=m.admin_id
      LEFT JOIN variants v ON v.id=m.variant_id LEFT JOIN products p ON p.id=m.product_id ${pid ? 'WHERE m.product_id=?' : ''} ORDER BY m.ts DESC, m.id DESC LIMIT 100`, ...(pid ? [pid] : []));
  });

  // =====================================================================
  // ORDERS & WHATSAPP REQUESTS
  // =====================================================================
  add('GET', '/orders', 'orders:r', async (ctx) => {
    const q = ctx.query, w = [], p = [];
    if (q.status) { const ss = q.status.split(',').filter((s) => STATUSES.includes(s)); if (ss.length) { w.push(`o.status IN (${ss.map(() => '?').join(',')})`); p.push(...ss); } }
    if (q.group === 'requests') w.push(`o.status IN ('${REQUEST_STATUSES.join("','")}')`);
    if (q.q) { w.push("(o.code LIKE ? ESCAPE '\\' OR o.name LIKE ? ESCAPE '\\' OR o.phone LIKE ? ESCAPE '\\')"); p.push(like(q.q), like(q.q), like(q.q)); }
    const { limit, offset } = page(q);
    const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
    const total = db.get(`SELECT COUNT(*) n FROM orders o ${where}`, ...p).n;
    const rows = db.all(`SELECT o.id,o.code,o.name,o.phone,o.status,o.total,o.created_at,o.confirmed_at,
      (SELECT COALESCE(SUM(qty),0) FROM order_items WHERE order_id=o.id) items FROM orders o ${where} ORDER BY o.created_at DESC LIMIT ? OFFSET ?`, ...p, limit, offset);
    return { total, rows };
  });
  function orderDetail(id, role) {
    const o = db.get('SELECT * FROM orders WHERE id=?', id);
    if (!o) throw httpErr(404, 'Order not found');
    const fin = can(role, 'finance:r');
    let items = db.all('SELECT i.*, s.name supplier_name, s.phone supplier_phone, s.lead_days supplier_lead_days FROM order_items i LEFT JOIN suppliers s ON s.id=i.supplier_id WHERE i.order_id=? ORDER BY i.id', id);
    const events = db.all('SELECT e.*, a.username FROM order_events e LEFT JOIN admins a ON a.id=e.admin_id WHERE e.order_id=? ORDER BY e.ts DESC, e.id DESC', id);
    const out = { ...o, items, events, allowed_next: NEXT[o.status] || [], label: LABEL[o.status] };
    if (fin) {
      out.expenses = db.all('SELECT * FROM expenses WHERE order_id=? ORDER BY ts DESC', id);
      out.refunds = db.all('SELECT * FROM refunds WHERE order_id=? ORDER BY ts DESC', id);
      const missing = items.filter((i) => i.unit_cost == null).length;
      const cogs = items.reduce((s, i) => s + (i.unit_cost || 0) * i.qty, 0);
      const exp = out.expenses.reduce((s, e) => s + e.amount, 0), refunded = out.refunds.reduce((s, r) => s + r.amount, 0);
      out.profit = { complete: missing === 0, missing_costs: missing, revenue: o.total, cogs: money(cogs), expenses: money(exp), refunded: money(refunded),
        profit: missing === 0 ? money(o.total - cogs - exp - refunded) : null };
    } else {
      out.items = items.map(({ unit_cost, supplier_id, supplier_name, supplier_phone, supplier_lead_days, ...rest }) => rest);
    }
    return out;
  }
  add('GET', '/orders/:id', 'orders:r', async (ctx) => orderDetail(idParam(ctx), ctx.admin.role));
  add('PUT', '/orders/:id', 'orders:w', async (ctx) => {
    const id = idParam(ctx), o = db.get('SELECT * FROM orders WHERE id=?', id);
    if (!o) throw httpErr(404, 'Order not found');
    const f = new F(ctx.body).str('name', { req: true, min: 2, max: 80 }).str('phone', { req: true, re: /^\+?[0-9\s\-()]{8,20}$/, msg: 'Enter a valid phone number' })
      .str('address', { req: true, min: 8, max: 300 }).str('pincode', { req: true, re: /^[A-Za-z0-9 \-]{3,10}$/, msg: 'Enter a valid pincode' })
      .str('internal_notes', { max: 4000 }).num('shipping', { req: true, min: 0, max: 1000000 }).num('discount', { req: true, min: 0, max: 10000000 });
    const items = [];
    if (Array.isArray(ctx.body.items)) {
      for (const it of ctx.body.items) {
        const itf = new F(it).num('id', { req: true, int: true, min: 1 }).num('unit_cost', { min: 0, max: 10000000 }).num('supplier_id', { int: true, min: 1 });
        if (Object.keys(itf.err).length) f.bad('items', 'Invalid item cost or supplier');
        else if (!db.get('SELECT 1 x FROM order_items WHERE id=? AND order_id=?', itf.out.id, id)) f.bad('items', 'Item does not belong to this order');
        else if (itf.out.supplier_id && !db.get('SELECT 1 x FROM suppliers WHERE id=?', itf.out.supplier_id)) f.bad('items', 'Supplier not found');
        else items.push(itf.out);
      }
    }
    const d = f.done(); d.phone = normPhone(d.phone);
    db.tx(() => {
      db.run('UPDATE orders SET name=?,phone=?,address=?,pincode=?,internal_notes=?,shipping=?,discount=?,updated_at=? WHERE id=?', d.name, d.phone, d.address, d.pincode, d.internal_notes, d.shipping, d.discount, now(), id);
      if (can(ctx.admin.role, 'finance:w')) for (const it of items) db.run('UPDATE order_items SET unit_cost=?, supplier_id=? WHERE id=?', it.unit_cost, it.supplier_id, it.id);
      core.recalcTotal(id);
    });
    const diff = {};
    if (o.shipping !== d.shipping) diff.shipping = [o.shipping, d.shipping];
    if (o.discount !== d.discount) diff.discount = [o.discount, d.discount];
    if (items.length) diff.item_costs = items.map((i) => ({ id: i.id, unit_cost: i.unit_cost, supplier_id: i.supplier_id }));
    audit(ctx, 'order.update', 'order', o.code, diff); return orderDetail(id, ctx.admin.role);
  });
  add('POST', '/orders/:id/status', 'orders:status', async (ctx) => {
    const id = idParam(ctx);
    const d = new F(ctx.body).en('status', STATUSES.filter((s) => s !== 'refunded')).str('note', { max: 500 }).str('public_note', { max: 300 })
      .str('country', { max: 80 }).str('state', { max: 80 }).str('district', { max: 80 }).str('place', { max: 80 }).done();
    const r = core.changeStatus(id, d.status, d, ctx.admin.id);
    audit(ctx, 'order.status', 'order', r.code, { from: r.from, to: r.to }); return orderDetail(id, ctx.admin.role);
  });
  add('POST', '/orders/:id/expenses', 'finance:w', async (ctx) => {
    const id = idParam(ctx);
    if (!db.get('SELECT 1 x FROM orders WHERE id=?', id)) throw httpErr(404, 'Order not found');
    const d = new F(ctx.body).en('kind', EXPENSE_KINDS).num('amount', { req: true, min: 0.01, max: 10000000 }).str('note', { max: 200 }).done();
    db.run('INSERT INTO expenses(order_id,kind,amount,note,ts,admin_id) VALUES(?,?,?,?,?,?)', id, d.kind, d.amount, d.note, now(), ctx.admin.id);
    audit(ctx, 'expense.create', 'order', id, d); ctx.status = 201; return orderDetail(id, ctx.admin.role);
  });
  add('POST', '/orders/:id/refund', 'finance:w', async (ctx) => {
    const id = idParam(ctx), o = db.get('SELECT * FROM orders WHERE id=?', id);
    if (!o) throw httpErr(404, 'Order not found');
    if (!['confirmed', 'ordered_from_supplier', 'shipped', 'out_for_delivery', 'delivered', 'refunded'].includes(o.status)) throw httpErr(409, 'Only confirmed orders can be refunded');
    const d = new F(ctx.body).num('amount', { req: true, min: 0.01, max: 10000000 }).str('note', { max: 200 }).bool('restock').done();
    const already = db.get('SELECT COALESCE(SUM(amount),0) s FROM refunds WHERE order_id=?', id).s;
    if (money(already + d.amount) > o.total) throw httpErr(409, `Refund exceeds the order total (already refunded ${money(already)})`);
    db.tx(() => {
      db.run('INSERT INTO refunds(order_id,amount,note,ts,admin_id) VALUES(?,?,?,?,?)', id, d.amount, d.note, now(), ctx.admin.id);
      if (money(already + d.amount) >= o.total) {
        db.run("UPDATE orders SET status='refunded', updated_at=? WHERE id=?", now(), id);
        db.run("INSERT INTO order_events(order_id,ts,status,note,admin_id) VALUES(?,?,?,?,?)", id, now(), 'refunded', d.note, ctx.admin.id);
      } else db.run("INSERT INTO order_events(order_id,ts,status,note,admin_id) VALUES(?,?,?,?,?)", id, now(), o.status, 'Partial refund ' + d.amount + (d.note ? ': ' + d.note : ''), ctx.admin.id);
      if (d.restock && o.stock_committed) {
        for (const it of db.all('SELECT * FROM order_items WHERE order_id=?', id)) {
          if (it.product_id && core.stockOf(it.product_id, it.variant_id) !== null) core.moveStock(it.product_id, it.variant_id, it.qty, 'Refund restock ' + o.code, id, ctx.admin.id);
        }
        db.run('UPDATE orders SET stock_committed=0 WHERE id=?', id);
      }
    });
    audit(ctx, 'order.refund', 'order', o.code, d); return orderDetail(id, ctx.admin.role);
  });
  add('GET', '/orders/:id/wa-template', 'orders:r', async (ctx) => {
    const id = idParam(ctx), o = db.get('SELECT * FROM orders WHERE id=?', id);
    if (!o) throw httpErr(404, 'Order not found');
    const store = core.getSetting('store_name'), cur = core.getSetting('currency');
    const items = db.all('SELECT name,variant_name,qty FROM order_items WHERE order_id=?', id).map((i) => `• ${i.name}${i.variant_name ? ' (' + i.variant_name + ')' : ''} x${i.qty}`).join('\n');
    const kinds = {
      confirm: `Hi ${o.name}, this is ${store}. We received your request ${o.code}:\n${items}\nTotal: ${cur}${o.total}\nCan you confirm the delivery address and pincode?\n${o.address} - ${o.pincode}`,
      payment: `Hi ${o.name}, thank you for your request ${o.code} (total ${cur}${o.total}). Please complete the payment and reply with the payment reference so we can confirm your order.`,
      update: `Hi ${o.name}, an update on your order ${o.code} from ${store}: `,
      custom: `Hi ${o.name}, `,
    };
    const kind = kinds[ctx.query.kind] ? ctx.query.kind : 'custom';
    return { phone: normPhone(o.phone).replace(/^\+/, ''), text: kinds[kind] };
  });

  // =====================================================================
  // CUSTOMERS (personal data: view requires customers:r)
  // =====================================================================
  add('GET', '/customers', 'customers:r', async (ctx) => {
    const q = ctx.query, w = ['c.anonymized=0'], p = [];
    if (q.q) { w.push("(c.name LIKE ? ESCAPE '\\' OR c.phone LIKE ? ESCAPE '\\')"); p.push(like(q.q), like(q.q)); }
    const { limit, offset } = page(q);
    return db.all(`SELECT c.id,c.name,c.phone,c.email,c.created_at,
      (SELECT COUNT(*) FROM orders WHERE customer_id=c.id) orders,
      (SELECT COALESCE(SUM(total),0) FROM orders WHERE customer_id=c.id AND confirmed_at IS NOT NULL AND status NOT IN ('cancelled','refunded')) spent
      FROM customers c WHERE ${w.join(' AND ')} ORDER BY c.created_at DESC LIMIT ? OFFSET ?`, ...p, limit, offset);
  });
  add('GET', '/customers/:id', 'customers:r', async (ctx) => {
    const id = idParam(ctx), c = db.get('SELECT * FROM customers WHERE id=?', id);
    if (!c) throw httpErr(404, 'Customer not found');
    return { ...c, orders: db.all('SELECT id,code,status,total,created_at FROM orders WHERE customer_id=? ORDER BY created_at DESC LIMIT 100', id) };
  });
  add('PUT', '/customers/:id', 'customers:w', async (ctx) => {
    const id = idParam(ctx), d = new F(ctx.body).str('name', { req: true, min: 2, max: 80 }).str('email', { max: 120, re: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, msg: 'Enter a valid email' })
      .str('address', { max: 300 }).str('pincode', { max: 10 }).str('notes', { max: 2000 }).done();
    if (!db.run('UPDATE customers SET name=?,email=?,address=?,pincode=?,notes=? WHERE id=? AND anonymized=0', d.name, d.email, d.address, d.pincode, d.notes, id).changes) throw httpErr(404, 'Customer not found');
    audit(ctx, 'customer.update', 'customer', id); return { ok: true };
  });
  add('POST', '/customers/:id/anonymize', 'customers:w', async (ctx) => {
    const id = idParam(ctx), c = db.get('SELECT * FROM customers WHERE id=? AND anonymized=0', id);
    if (!c) throw httpErr(404, 'Customer not found');
    if (db.get(`SELECT 1 x FROM orders WHERE customer_id=? AND status NOT IN ('delivered','cancelled','refunded')`, id)) throw httpErr(409, 'This customer has orders in progress');
    db.tx(() => {
      db.run("UPDATE orders SET name='Deleted customer', phone='deleted', address='deleted', pincode='000000' WHERE customer_id=?", id);
      db.run("UPDATE customers SET name='Deleted customer', phone='deleted-'||id, email=NULL, address=NULL, pincode=NULL, notes=NULL, anonymized=1 WHERE id=?", id);
    });
    audit(ctx, 'customer.anonymize', 'customer', id); return { ok: true };
  });

  // =====================================================================
  // PROMOTIONS
  // =====================================================================
  function promoInput(b) {
    const f = new F(b).str('code', { req: true, re: /^[A-Za-z0-9_-]{3,30}$/, msg: '3-30 letters, numbers, - or _' }).en('kind', ['percent', 'fixed'])
      .num('value', { req: true, min: 0.01, max: 10000000 }).num('min_subtotal', { min: 0, max: 10000000 }).num('usage_limit', { int: true, min: 1, max: 10000000 }).bool('active', 1)
      .str('starts', { re: /^\d{4}-\d{2}-\d{2}$/, msg: 'Use YYYY-MM-DD' }).str('ends', { re: /^\d{4}-\d{2}-\d{2}$/, msg: 'Use YYYY-MM-DD' });
    const o = f.out;
    if (o.kind === 'percent' && o.value > 100) f.bad('value', 'Percent cannot exceed 100');
    const s = o.starts ? dayMs(o.starts) : null, e = o.ends ? dayMs(o.ends, true) : null;
    if (o.starts && s === null) f.bad('starts', 'Invalid date'); if (o.ends && e === null) f.bad('ends', 'Invalid date');
    if (s && e && e <= s) f.bad('ends', 'End date must be after the start date');
    f.done(); return { ...o, starts_at: s, ends_at: e, min_subtotal: o.min_subtotal || 0 };
  }
  add('GET', '/promotions', 'promotions:r', async () => db.all('SELECT * FROM promotions ORDER BY created_at DESC'));
  add('POST', '/promotions', 'promotions:w', async (ctx) => {
    const p = promoInput(ctx.body);
    if (db.get('SELECT 1 x FROM promotions WHERE code=?', p.code)) throw new VErr({ code: 'This code already exists' });
    const r = db.run('INSERT INTO promotions(code,kind,value,min_subtotal,starts_at,ends_at,usage_limit,active,created_at) VALUES(?,?,?,?,?,?,?,?,?)', p.code, p.kind, p.value, p.min_subtotal, p.starts_at, p.ends_at, p.usage_limit, p.active, now());
    audit(ctx, 'promotion.create', 'promotion', r.lastInsertRowid, { code: p.code, kind: p.kind, value: p.value }); ctx.status = 201; return { id: Number(r.lastInsertRowid) };
  });
  add('PUT', '/promotions/:id', 'promotions:w', async (ctx) => {
    const id = idParam(ctx), p = promoInput(ctx.body);
    if (db.get('SELECT 1 x FROM promotions WHERE code=? AND id<>?', p.code, id)) throw new VErr({ code: 'This code already exists' });
    if (!db.run('UPDATE promotions SET code=?,kind=?,value=?,min_subtotal=?,starts_at=?,ends_at=?,usage_limit=?,active=? WHERE id=?', p.code, p.kind, p.value, p.min_subtotal, p.starts_at, p.ends_at, p.usage_limit, p.active, id).changes) throw httpErr(404, 'Promotion not found');
    audit(ctx, 'promotion.update', 'promotion', id, { code: p.code, active: p.active }); return { ok: true };
  });
  add('DELETE', '/promotions/:id', 'promotions:w', async (ctx) => { const id = idParam(ctx); db.run('DELETE FROM promotions WHERE id=?', id); audit(ctx, 'promotion.delete', 'promotion', id); return { ok: true }; });

  // =====================================================================
  // FINANCE / OVERVIEW
  // =====================================================================
  function range(q, days = 30) {
    const to = q.to ? dayMs(q.to, true) : now() + 1, from = q.from ? dayMs(q.from) : to - days * 86400000;
    if (from === null || to === null || to <= from || to - from > 800 * 86400000) throw httpErr(400, 'Invalid date range');
    return [from, to];
  }
  add('GET', '/finance', 'finance:r', async (ctx) => { const [from, to] = range(ctx.query); return { from, to, ...core.finance(from, to), daily: core.dailySales(from, to) }; });
  add('GET', '/expenses', 'finance:r', async (ctx) => {
    const [from, to] = range(ctx.query, 90);
    return db.all(`SELECT e.*, o.code order_code, a.username FROM expenses e LEFT JOIN orders o ON o.id=e.order_id LEFT JOIN admins a ON a.id=e.admin_id WHERE e.ts>=? AND e.ts<? ORDER BY e.ts DESC LIMIT 200`, from, to);
  });
  add('POST', '/expenses', 'finance:w', async (ctx) => {
    const d = new F(ctx.body).en('kind', EXPENSE_KINDS).num('amount', { req: true, min: 0.01, max: 10000000 }).str('note', { max: 200 })
      .str('date', { re: /^\d{4}-\d{2}-\d{2}$/, msg: 'Use YYYY-MM-DD' }).done();
    const ts = d.date ? dayMs(d.date) : now();
    if (ts === null) throw new VErr({ date: 'Invalid date' });
    db.run('INSERT INTO expenses(order_id,kind,amount,note,ts,admin_id) VALUES(NULL,?,?,?,?,?)', d.kind, d.amount, d.note, ts, ctx.admin.id);
    audit(ctx, 'expense.create', 'expense', null, d); ctx.status = 201; return { ok: true };
  });
  add('DELETE', '/expenses/:id', 'finance:w', async (ctx) => { const id = idParam(ctx); db.run('DELETE FROM expenses WHERE id=?', id); audit(ctx, 'expense.delete', 'expense', id); return { ok: true }; });

  add('GET', '/overview', null, async (ctx) => {
    const role = ctx.admin.role, o = {};
    const cnt = (s) => db.get(`SELECT COUNT(*) n FROM orders WHERE status='${s}'`).n;
    if (can(role, 'orders:r')) {
      o.requests = { new_request: cnt('new_request'), contacted: cnt('contacted'), awaiting_payment: cnt('awaiting_payment') };
      o.to_ship = cnt('confirmed') + cnt('ordered_from_supplier');
      o.recent = db.all('SELECT id,code,name,status,total,created_at FROM orders ORDER BY created_at DESC LIMIT 8');
    }
    if (can(role, 'inventory:r')) o.low_stock = db.get(`SELECT COUNT(*) n FROM (
      SELECT p.low_stock ls, p.stock s FROM products p WHERE NOT EXISTS(SELECT 1 FROM variants v WHERE v.product_id=p.id)
      UNION ALL SELECT p.low_stock, v.stock FROM variants v JOIN products p ON p.id=v.product_id) WHERE s<=ls`).n;
    if (can(role, 'products:r')) o.products = db.get('SELECT COUNT(*) total, COALESCE(SUM(published),0) published FROM products');
    if (can(role, 'finance:r')) {
      const to = now() + 1, from = to - 30 * 86400000;
      o.finance = core.finance(from, to); o.daily = core.dailySales(to - 14 * 86400000, to);
    }
    return o;
  });

  // =====================================================================
  // WEBSITE SETTINGS
  // =====================================================================
  const mediaOrEmpty = (f, k) => {
    const v = f.i[k];
    if (v === '' || v == null) { f.out[k] = ''; return; }
    if (typeof v !== 'string' || !/^[0-9a-f]{24}$/.test(v) || !db.get('SELECT 1 x FROM media WHERE id=?', v)) f.bad(k, 'Unknown image');
    else f.out[k] = v;
  };
  const SETTING_VALIDATORS = {
    store_name: (v) => new F({ v }).str('v', { req: true, max: 60 }).done().v,
    whatsapp_number: (v) => { const d = String(v || '').replace(/[^\d]/g, ''); if (v !== '' && v != null && (d.length < 8 || d.length > 15)) throw new VErr({ whatsapp_number: 'Enter the number with country code, digits only (8-15 digits)' }); return d; },
    currency: (v) => new F({ v }).str('v', { req: true, max: 4 }).done().v,
    free_over: (v) => new F({ v }).num('v', { req: true, min: 0, max: 10000000 }).done().v,
    shipping: (v) => new F({ v }).num('v', { req: true, min: 0, max: 10000000 }).done().v,
    announcement: (v) => { if (!Array.isArray(v) || v.length > 8) throw new VErr({ announcement: 'Up to 8 messages' }); return v.map((s) => { const x = new F({ s }).str('s', { req: true, max: 120 }).done().s; return x; }); },
    contact: (v) => new F(v).str('email', { max: 120, re: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, msg: 'Enter a valid email' }).str('phone', { max: 30 }).str('address', { max: 300 }).str('hours', { max: 120 }).done(),
    policies: (v) => { const o = new F(v).str('returns', { max: 8000 }).str('shipping', { max: 8000 }).str('privacy', { max: 8000 }).str('terms', { max: 8000 }).done(); return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, x || ''])); },
    banners: (v) => {
      if (!Array.isArray(v) || v.length > 6) throw new VErr({ banners: 'Up to 6 banners' });
      return v.map((b, i) => { const f = new F(b).str('title', { req: true, max: 80 }).str('subtitle', { max: 160 }).str('category', { max: 40 }).str('c1', { re: HEX }).str('c2', { re: HEX }); mediaOrEmpty(f, 'media');
        if (Object.keys(f.err).length) throw new VErr({ banners: `Banner ${i + 1}: ${Object.values(f.err)[0]}` });
        return { title: f.out.title, subtitle: f.out.subtitle || '', category: f.out.category || '', c1: f.out.c1 || '#1F2A24', c2: f.out.c2 || '#3B5246', media: f.out.media }; });
    },
    home_sections: (v) => {
      if (!Array.isArray(v) || v.length > 14) throw new VErr({ home_sections: 'Up to 14 sections' });
      return v.map((s, i) => { const f = new F(s).en('type', ['categories', 'deals', 'bestsellers', 'category', 'each_category']).str('title', { max: 60 }).str('category', { max: 40 }).bool('enabled', 1);
        if (Object.keys(f.err).length) throw new VErr({ home_sections: `Section ${i + 1}: ${Object.values(f.err)[0]}` });
        if (f.out.type === 'category' && !f.out.category) throw new VErr({ home_sections: `Section ${i + 1}: choose a category` });
        return { type: f.out.type, title: f.out.title || '', category: f.out.category || '', enabled: !!f.out.enabled }; });
    },
    logo_icon: (v) => { const f = new F({}); f.i = { v }; mediaOrEmpty(f, 'v'); f.done(); return f.out.v; },
    logo_wordmark: (v) => { const f = new F({}); f.i = { v }; mediaOrEmpty(f, 'v'); f.done(); return f.out.v; },
  };
  add('GET', '/settings', 'settings:r', async () => core.allSettings());
  add('PUT', '/settings', 'settings:w', async (ctx) => {
    const b = ctx.body, keys = Object.keys(b || {});
    if (!keys.length) throw httpErr(400, 'Nothing to update');
    const out = {}, errs = {};
    for (const k of keys) {
      if (!SETTING_VALIDATORS[k]) { errs[k] = 'Unknown setting'; continue; }
      try { out[k] = SETTING_VALIDATORS[k](b[k]); } catch (e) { if (e instanceof VErr) Object.assign(errs, e.fields); else throw e; }
    }
    if (Object.keys(errs).length) throw new VErr(errs);
    const before = {};
    db.tx(() => { for (const k of keys) { before[k] = core.getSetting(k); core.setSetting(k, out[k]); } });
    const short = (x) => JSON.stringify(x).slice(0, 200);
    audit(ctx, 'settings.update', 'settings', keys.join(','), Object.fromEntries(keys.map((k) => [k, k === 'policies' ? 'updated' : { from: short(before[k]), to: short(out[k]) }]))); return core.allSettings();
  }, { limit: 256 * 1024 });
  add('POST', '/media', 'settings:w', async (ctx) => {
    const id = saveMedia(ctx.body && ctx.body.data, 1536 * 1024);
    audit(ctx, 'media.upload', 'media', id); ctx.status = 201; return { id, url: '/media/' + id };
  }, { limit: 3 * 1024 * 1024 });

  // =====================================================================
  // SECURITY: audit log, sessions, users
  // =====================================================================
  add('GET', '/security/audit', 'security:r', async (ctx) => {
    const q = ctx.query, w = [], p = [], { limit, offset } = page(q);
    if (q.action) { w.push("action LIKE ? ESCAPE '\\'"); p.push(like(q.action) ); }
    if (q.user) { w.push('username=?'); p.push(q.user); }
    return db.all(`SELECT * FROM audit ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY id DESC LIMIT ? OFFSET ?`, ...p, limit, offset);
  });
  add('GET', '/security/sessions', null, async (ctx) => {
    const all = ctx.query.all === '1' && can(ctx.admin.role, 'security:r');
    return db.all(`SELECT s.id,s.created_at,s.last_seen,s.expires_at,s.ip,s.ua,a.username FROM sessions s JOIN admins a ON a.id=s.admin_id ${all ? '' : 'WHERE s.admin_id=?'} ORDER BY s.last_seen DESC`, ...(all ? [] : [ctx.admin.id]))
      .map((s) => ({ ...s, current: s.id === ctx.session.id }));
  });
  add('DELETE', '/security/sessions/:id', null, async (ctx) => {
    const s = db.get('SELECT * FROM sessions WHERE id=?', ctx.params.id);
    if (!s || (s.admin_id !== ctx.admin.id && !can(ctx.admin.role, 'security:w'))) throw httpErr(404, 'Session not found');
    db.run('DELETE FROM sessions WHERE id=?', s.id); audit(ctx, 'session.revoke', 'admin', s.admin_id); return { ok: true };
  });
  add('GET', '/security/status', 'security:r', async () => {
    const admins = db.all('SELECT role,totp_enabled,disabled FROM admins');
    const checks = [
      { ok: cfg.cookieSecure, label: 'Secure cookies (HTTPS only)', fix: 'Set NODE_ENV=production and serve the site over HTTPS' },
      { ok: cfg.prod, label: 'Production mode', fix: 'Set NODE_ENV=production' },
      { ok: cfg.appSecret.length >= 32 && !!process.env.APP_SECRET, label: 'APP_SECRET configured', fix: 'Set APP_SECRET to 32+ random characters' },
      { ok: admins.filter((a) => !a.disabled).every((a) => a.totp_enabled), label: 'Two-factor enabled for every active admin', fix: 'Each admin can enable 2FA under Security' },
      { ok: !!core.getSetting('whatsapp_number'), label: 'WhatsApp number configured', fix: 'Set it in Website Settings' },
    ];
    return { checks, admin_path: cfg.adminPath, trust_proxy: cfg.trustProxy, admins: admins.length, rate_limiting: 'in-memory (per server process)' };
  });
  const roleEn = ['owner', 'manager', 'support'];
  add('GET', '/security/users', 'security:r', async () =>
    db.all('SELECT id,username,name,role,totp_enabled,disabled,must_change,failed,locked_until,created_at,last_login FROM admins ORDER BY id'));
  add('POST', '/security/users', 'security:w', async (ctx) => {
    const d = new F(ctx.body).str('username', { req: true, re: /^[a-zA-Z0-9._-]{3,40}$/, msg: '3-40 letters, numbers, . _ -' }).str('name', { req: true, max: 80 })
      .en('role', roleEn).str('password', { req: true, max: 300, trim: false }).done();
    const prob = sec.passwordProblem(d.password, d.username); if (prob) throw new VErr({ password: prob });
    if (db.get('SELECT 1 x FROM admins WHERE username=?', d.username)) throw new VErr({ username: 'Username already exists' });
    const r = db.run('INSERT INTO admins(username,name,role,pass_hash,must_change,created_at) VALUES(?,?,?,?,1,?)', d.username, d.name, d.role, await sec.hashPassword(d.password), now());
    audit(ctx, 'user.create', 'admin', r.lastInsertRowid, { username: d.username, role: d.role }); ctx.status = 201; return { id: Number(r.lastInsertRowid) };
  });
  const ownersLeft = (exceptId) => db.get("SELECT COUNT(*) n FROM admins WHERE role='owner' AND disabled=0 AND id<>?", exceptId).n;
  add('PUT', '/security/users/:id', 'security:w', async (ctx) => {
    const id = idParam(ctx), u = db.get('SELECT * FROM admins WHERE id=?', id);
    if (!u) throw httpErr(404, 'User not found');
    const d = new F(ctx.body).str('name', { req: true, max: 80 }).en('role', roleEn).bool('disabled').done();
    if (id === ctx.admin.id && (d.role !== u.role || d.disabled)) throw httpErr(409, 'You cannot change your own role or disable yourself');
    if (u.role === 'owner' && (d.role !== 'owner' || d.disabled) && ownersLeft(id) === 0) throw httpErr(409, 'There must be at least one active owner');
    db.run('UPDATE admins SET name=?, role=?, disabled=? WHERE id=?', d.name, d.role, d.disabled, id);
    if (d.disabled || d.role !== u.role) db.run('DELETE FROM sessions WHERE admin_id=?', id);
    audit(ctx, 'user.update', 'admin', id, { role: [u.role, d.role], disabled: [u.disabled, d.disabled] }); return { ok: true };
  });
  add('POST', '/security/users/:id/reset-password', 'security:w', async (ctx) => {
    const id = idParam(ctx), u = db.get('SELECT * FROM admins WHERE id=?', id);
    if (!u) throw httpErr(404, 'User not found');
    const d = new F(ctx.body).str('password', { req: true, max: 300, trim: false }).done();
    const prob = sec.passwordProblem(d.password, u.username); if (prob) throw new VErr({ password: prob });
    db.run('UPDATE admins SET pass_hash=?, must_change=1, failed=0, locked_until=0 WHERE id=?', await sec.hashPassword(d.password), id);
    db.run('DELETE FROM sessions WHERE admin_id=?', id);
    audit(ctx, 'user.reset_password', 'admin', id); return { ok: true };
  });
  add('POST', '/security/users/:id/unlock', 'security:w', async (ctx) => {
    const id = idParam(ctx); db.run('UPDATE admins SET failed=0, locked_until=0 WHERE id=?', id); audit(ctx, 'user.unlock', 'admin', id); return { ok: true };
  });
  add('POST', '/security/users/:id/disable-2fa', 'security:w', async (ctx) => {
    const id = idParam(ctx); if (id === ctx.admin.id) throw httpErr(409, 'Use the Security page to disable your own 2FA');
    db.run('UPDATE admins SET totp_enabled=0, totp_secret=NULL, totp_last=0 WHERE id=?', id); db.run('DELETE FROM recovery_codes WHERE admin_id=?', id); db.run('DELETE FROM sessions WHERE admin_id=?', id);
    audit(ctx, 'user.disable_2fa', 'admin', id); return { ok: true };
  });

  return routes;
}

module.exports = { register, can, permList, sniff };
