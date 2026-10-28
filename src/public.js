'use strict';
const { F, VErr, httpErr, money, normPhone } = require('./http');
const { LABEL } = require('./core');

function register({ db, core, limiter }) {
  const routes = [];
  const add = (method, path, handler, opts = {}) => routes.push({ method, path, handler, ...opts });

  const publicSettings = () => {
    const s = core.allSettings();
    return { store_name: s.store_name, whatsapp_number: s.whatsapp_number, currency: s.currency, free_over: s.free_over, shipping: s.shipping,
      announcement: s.announcement, contact: s.contact, policies: s.policies, banners: s.banners.map((b) => ({ ...b, media: b.media ? '/media/' + b.media : '' })),
      home_sections: s.home_sections, logo_icon: s.logo_icon ? '/media/' + s.logo_icon : '', logo_wordmark: s.logo_wordmark ? '/media/' + s.logo_wordmark : '' };
  };

  // Only published products in published categories. Never includes cost, supplier, notes or exact stock.
  add('GET', '/catalog', async () => {
    const cats = db.all('SELECT id,name,icon,tint FROM categories WHERE published=1 ORDER BY sort,name');
    const prods = db.all(`SELECT p.id,p.name,p.brand,p.category_id,c.name category,p.caption,p.description,p.price,p.compare_price,p.icon,p.tint,p.low_stock,p.stock
      FROM products p JOIN categories c ON c.id=p.category_id AND c.published=1 WHERE p.published=1 ORDER BY p.id`);
    const vars = db.all('SELECT v.id,v.product_id,v.name,v.stock FROM variants v JOIN products p ON p.id=v.product_id WHERE p.published=1 ORDER BY v.sort,v.id');
    const imgs = db.all('SELECT i.product_id,i.media_id FROM product_images i JOIN products p ON p.id=i.product_id WHERE p.published=1 ORDER BY i.sort,i.id');
    const sold = Object.fromEntries(db.all('SELECT i.product_id pid, SUM(i.qty) s FROM order_items i JOIN orders o ON o.id=i.order_id WHERE o.stock_committed=1 GROUP BY i.product_id').map((r) => [r.pid, r.s]));
    const vBy = {}, iBy = {};
    for (const v of vars) (vBy[v.product_id] = vBy[v.product_id] || []).push(v);
    for (const i of imgs) (iBy[i.product_id] = iBy[i.product_id] || []).push('/media/' + i.media_id);
    return {
      settings: publicSettings(), categories: cats,
      products: prods.map((p) => {
        const vs = vBy[p.id] || [], total = vs.length ? vs.reduce((s, v) => s + v.stock, 0) : p.stock;
        return { id: p.id, name: p.name, brand: p.brand || '', category: p.category, caption: p.caption || '', description: p.description || p.caption || '',
          price: p.price, compare_price: p.compare_price, icon: p.icon, tint: p.tint, images: iBy[p.id] || [], sold: sold[p.id] || 0,
          in_stock: total > 0, low_stock: total > 0 && total <= p.low_stock, variants: vs.map((v) => ({ id: v.id, name: v.name, in_stock: v.stock > 0 })) };
      }),
    };
  });

  function priceCart(items, promo, { checkStock = true } = {}) {
    if (!Array.isArray(items) || !items.length || items.length > 30) throw httpErr(400, 'Your cart is empty');
    const merged = new Map();
    for (const it of items) {
      const f = new F(it).num('product_id', { req: true, int: true, min: 1 }).num('variant_id', { int: true, min: 1 }).num('qty', { req: true, int: true, min: 1, max: 20 });
      if (Object.keys(f.err).length) throw httpErr(400, 'One of the items is invalid');
      const key = f.out.product_id + ':' + (f.out.variant_id || 0);
      const cur = merged.get(key);
      if (cur) cur.qty += f.out.qty; else merged.set(key, { ...f.out });
    }
    const lines = []; let subtotal = 0;
    for (const it of merged.values()) {
      const p = db.get('SELECT p.*, c.published cpub FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE p.id=?', it.product_id);
      if (!p || !p.published || !p.cpub) throw httpErr(409, 'One of the items is no longer available', { product_id: it.product_id });
      const hasVariants = !!db.get('SELECT 1 x FROM variants WHERE product_id=?', p.id);
      let vname = null;
      if (hasVariants) {
        const v = it.variant_id ? db.get('SELECT * FROM variants WHERE id=? AND product_id=?', it.variant_id, p.id) : null;
        if (!v) throw httpErr(400, `Please choose an option for "${p.name}"`, { product_id: p.id });
        vname = v.name;
      } else if (it.variant_id) throw httpErr(400, 'Invalid option');
      if (it.qty > 20) throw httpErr(400, 'Maximum 20 per item');
      const have = core.stockOf(p.id, hasVariants ? it.variant_id : null);
      if (checkStock && have !== null && have < it.qty) throw httpErr(409, have > 0 ? `Only ${have} left of "${p.name}"` : `"${p.name}" is out of stock`, { product_id: p.id });
      lines.push({ p, variant_id: hasVariants ? it.variant_id : null, vname, qty: it.qty, price: p.price });
      subtotal += p.price * it.qty;
    }
    subtotal = money(subtotal);
    const pr = core.calcPromo(promo, subtotal);
    if (!pr.ok) throw httpErr(400, pr.message, { field: 'promo' });
    const freeOver = core.getSetting('free_over'), ship = core.getSetting('shipping');
    const shipping = subtotal >= freeOver ? 0 : ship;
    return { lines, subtotal, discount: pr.discount, promo: pr.code, shipping, total: money(subtotal - pr.discount + shipping) };
  }

  add('POST', '/promo', async (ctx) => {
    const h = limiter.hit('promo:' + ctx.ip, 20, 10 * 60 * 1000);
    if (!h.ok) throw httpErr(429, 'Too many attempts. Please wait a few minutes.', { retry: h.retry });
    const d = new F(ctx.body).str('code', { req: true, max: 30 }).num('subtotal', { req: true, min: 0, max: 10000000 }).done();
    const r = core.calcPromo(d.code, d.subtotal);
    return r.ok ? { ok: true, discount: r.discount } : { ok: false, message: r.message };
  });

  add('POST', '/requests', async (ctx) => {
    const h = limiter.hit('req:' + ctx.ip, 6, 10 * 60 * 1000);
    if (!h.ok) throw httpErr(429, 'Too many requests from your connection. Please wait a few minutes.', { retry: h.retry });
    const b = ctx.body || {};
    if (b.website) throw httpErr(400, 'Invalid request');            // honeypot field must stay empty
    const wa = core.getSetting('whatsapp_number');
    if (!wa) throw httpErr(503, 'Ordering is not available right now. Please try again later.');
    const f = new F(b).str('name', { req: true, min: 2, max: 80 }).str('phone', { req: true, max: 24 }).str('address', { req: true, min: 8, max: 300 })
      .str('pincode', { req: true, re: /^[A-Za-z0-9 \-]{3,10}$/, msg: 'Enter a valid pincode' }).str('promo', { max: 30 });
    const phone = normPhone(f.out.phone || '');
    if (f.out.phone && !/^\+?[0-9]{8,15}$/.test(phone)) f.bad('phone', 'Enter a valid phone number');
    const d = f.done();
    const cart = priceCart(b.items, d.promo);
    const code = core.genCode(), t = Date.now();
    const orderId = db.tx(() => {
      let cust = db.get('SELECT id FROM customers WHERE phone=? AND anonymized=0', phone);
      if (cust) db.run('UPDATE customers SET name=?, address=?, pincode=? WHERE id=?', d.name, d.address, d.pincode, cust.id);
      else cust = { id: Number(db.run('INSERT INTO customers(name,phone,address,pincode,created_at) VALUES(?,?,?,?,?)', d.name, phone, d.address, d.pincode, t).lastInsertRowid) };
      const oid = Number(db.run(`INSERT INTO orders(code,customer_id,name,phone,address,pincode,status,subtotal,discount,shipping,total,promo_code,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'new_request',?,?,?,?,?,?,?)`, code, cust.id, d.name, phone, d.address, d.pincode, cart.subtotal, cart.discount, cart.shipping, cart.total, cart.promo, t, t).lastInsertRowid);
      for (const l of cart.lines) db.run('INSERT INTO order_items(order_id,product_id,variant_id,name,variant_name,qty,unit_price,unit_cost,supplier_id) VALUES(?,?,?,?,?,?,?,?,?)',
        oid, l.p.id, l.variant_id, l.p.name, l.vname, l.qty, l.price, l.p.cost_price, l.p.supplier_id);
      db.run("INSERT INTO order_events(order_id,ts,status,public_note) VALUES(?,?,'new_request','We received your request and will confirm it on WhatsApp.')", oid, t);
      return oid;
    });
    const cur = core.getSetting('currency'), store = core.getSetting('store_name');
    const lines = cart.lines.map((l) => `• ${l.p.name}${l.vname ? ' (' + l.vname + ')' : ''} x${l.qty} – ${cur}${money(l.price * l.qty)}`).join('\n');
    const message = `Hello ${store}, I'd like to place an order (Order ID: ${code}):\n\n${lines}\n\nItems: ${cur}${cart.subtotal}` +
      (cart.discount ? `\nDiscount (${cart.promo}): -${cur}${cart.discount}` : '') + `\nDelivery: ${cart.shipping ? cur + cart.shipping : 'Free'}\nTotal: ${cur}${cart.total}\n\n` +
      `Name: ${d.name}\nPhone: ${phone}\nAddress: ${d.address}\nPincode: ${d.pincode}\n\nThis is an order request. Please confirm availability and payment.`;
    ctx.status = 201;
    return { code, order_id: orderId, subtotal: cart.subtotal, discount: cart.discount, shipping: cart.shipping, total: cart.total, whatsapp_number: wa, message };
  }, { limit: 32 * 1024 });

  add('GET', '/track', async (ctx) => {
    const h = limiter.hit('track:' + ctx.ip, 30, 10 * 60 * 1000);
    if (!h.ok) throw httpErr(429, 'Too many lookups. Please wait a few minutes.', { retry: h.retry });
    const code = String(ctx.query.code || '').toUpperCase(), last4 = String(ctx.query.last4 || '');
    if (!/^CT-[A-Z0-9]{7}$/.test(code) || !/^\d{4}$/.test(last4)) throw httpErr(404, 'Order not found');
    const r = core.publicTrack(code, last4);
    if (!r) throw httpErr(404, 'Order not found');
    return r;
  });

  // images are public only when used by a published product or by a site setting (logo/banners)
  function mediaPublic(id) {
    if (!/^[0-9a-f]{24}$/.test(id)) return null;
    const s = core.allSettings();
    const inSettings = s.logo_icon === id || s.logo_wordmark === id || s.banners.some((b) => b.media === id);
    const m = db.get(`SELECT mime,data FROM media m WHERE id=? AND (? OR EXISTS(SELECT 1 FROM product_images i JOIN products p ON p.id=i.product_id AND p.published=1
      JOIN categories c ON c.id=p.category_id AND c.published=1 WHERE i.media_id=m.id))`, id, inSettings ? 1 : 0);
    return m ? { mime: m.mime, data: Buffer.from(m.data) } : null;
  }
  return { routes, mediaPublic, LABEL };
}
module.exports = { register };
