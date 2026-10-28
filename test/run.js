'use strict';
// Integration tests: boots a real server on a temp database and exercises it over HTTP.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { load } = require('../src/config');
const { createApp } = require('../src/app');
const sec = require('../src/security');

let pass = 0, fail = 0; const failures = [];
const ok = (cond, name, extra) => { if (cond) pass++; else { fail++; failures.push(name + (extra ? ' -> ' + extra : '')); console.log('  FAIL: ' + name + (extra ? ' -> ' + extra : '')); } };
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, `got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`);
const section = (n) => console.log('\n# ' + n);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-test-'));
const env = { NODE_ENV: 'test', APP_SECRET: 'test-secret-'.repeat(4), DATA_DIR: tmp, TRUST_PROXY: '1' };
const cfg = load(env);
const A = cfg.adminPath + '/api';
let app, server, BASE, ipN = 1;
const newIp = () => '10.0.' + Math.floor(ipN / 250) + '.' + (ipN++ % 250);

async function call(method, url, { body, cookie, csrf, origin, ip, raw } = {}) {
  const headers = { 'X-Forwarded-For': ip || newIp() };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  if (origin !== null) headers.Origin = origin === undefined ? BASE : origin;
  const r = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)), redirect: 'manual' });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, headers: r.headers };
}
async function login(username, password, extra = {}) {
  const r = await call('POST', A + '/login', { body: { username, password, ...extra }, ip: extra.ip });
  if (r.status !== 200) return { r };
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  const me = await call('GET', A + '/me', { cookie });
  return { r, cookie, csrf: me.json && me.json.csrf, me: me.json };
}
const api = (s) => (method, url, body, o = {}) => call(method, A + url, { body, cookie: s.cookie, csrf: s.csrf, ...o });
const cliCreate = (args, pw) => spawnSync('node', ['scripts/create-admin.js', ...args, '--password-stdin'], { input: pw + '\n', env: { ...process.env, ...env }, cwd: path.join(__dirname, '..'), encoding: 'utf8' });
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(64, 1)]).toString('base64');

(async () => {
  app = createApp(cfg);
  server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  BASE = 'http://127.0.0.1:' + server.address().port;
  const db = app.db;

  // ---------------------------------------------------------------
  section('No default administrator; every admin route requires a session');
  eq(db.get('SELECT COUNT(*) n FROM admins').n, 0, 'fresh database has no administrators');
  let r = await call('POST', A + '/login', { body: { username: 'admin', password: 'admin' } });
  eq(r.status, 401, 'default credentials do not work');
  r = await call('GET', cfg.adminPath);
  ok(r.status === 200 && /stub login|login/i.test(r.text), 'unauthenticated admin page is the login page');
  ok(!/stub app/.test(r.text), 'dashboard shell is not served without a session');
  for (const f of ['app.js', 'app.css']) { r = await call('GET', cfg.adminPath + '/assets/' + f); eq(r.status, 404, `dashboard asset ${f} hidden without session`); }
  let unauth = 0, total = 0;
  for (const route of app.routes) {
    if (route.public) continue;
    total++;
    const p = A + route.re.source.replace(/^\^|\\\/\?\$$/g, '').replace(/\\\//g, '/').replace(/\(\[\^\/\]\+\)/g, '1').replace(/\$$/, '').replace(/\/\?$/, '');
    const x = await call(route.method, p, { body: route.method === 'POST' || route.method === 'PUT' ? {} : undefined });
    if (x.status === 401) unauth++; else console.log('   open route?', route.method, p, x.status);
  }
  ok(unauth === total && total > 40, `all ${total} protected admin API routes return 401 without a session`, `${unauth}/${total}`);
  r = await call('GET', '/api/admin/products'); eq(r.status, 404, 'no admin API exists on the public namespace');

  // ---------------------------------------------------------------
  section('Creating administrators with the CLI');
  let c = cliCreate(['--username', 'owner1', '--name', 'Owner', '--role', 'owner'], 'short');
  ok(c.status === 1 && /rejected/.test(c.stderr), 'CLI rejects a weak password');
  c = cliCreate(['--username', 'owner1', '--name', 'Owner', '--role', 'owner'], 'Correct-Horse-Battery-9');
  ok(c.status === 0, 'CLI creates the owner', c.stderr);
  c = cliCreate(['--username', 'mgr1', '--name', 'Manager', '--role', 'manager'], 'Manager-Strong-Pass-77');
  ok(c.status === 0, 'CLI creates a manager', c.stderr);
  c = cliCreate(['--username', 'sup1', '--name', 'Support', '--role', 'support'], 'Support-Strong-Pass-55');
  ok(c.status === 0, 'CLI creates a support agent', c.stderr);
  c = cliCreate(['--username', 'owner1', '--name', 'X'], 'Another-Strong-Pass-11');
  ok(c.status === 1, 'CLI refuses a duplicate username');
  const row = db.get("SELECT pass_hash FROM admins WHERE username='owner1'");
  ok(/^scrypt\$32768\$8\$1\$/.test(row.pass_hash) && !row.pass_hash.includes('Correct-Horse'), 'password stored as salted scrypt hash, never plaintext');
  const h2 = db.get("SELECT pass_hash FROM admins WHERE username='mgr1'").pass_hash;
  ok(row.pass_hash.split('$')[4] !== h2.split('$')[4], 'each hash has its own random salt');

  // ---------------------------------------------------------------
  section('Login protections');
  r = await call('POST', A + '/login', { body: { username: 'owner1', password: 'wrong-password-123' } });
  eq(r.status, 401, 'wrong password rejected');
  const r2 = await call('POST', A + '/login', { body: { username: 'nobody', password: 'wrong-password-123' } });
  eq(r.json.error, r2.json.error, 'unknown user and wrong password give the same message');
  r = await call('POST', A + '/login', { body: { username: 'owner1', password: 'Correct-Horse-Battery-9' }, origin: 'https://evil.example' });
  eq(r.status, 403, 'login from a foreign origin is blocked');
  r = await call('POST', A + '/login', { body: { username: 'owner1', password: 'Correct-Horse-Battery-9' }, origin: null });
  eq(r.status, 403, 'login without an Origin header is blocked');
  r = await call('POST', A + '/login', { body: 'username=owner1&password=x', raw: true, headers: {} });
  ok(r.status === 415 || r.status === 400, 'non-JSON login body rejected');
  const ipL = '203.0.113.9';
  for (let i = 0; i < 5; i++) await call('POST', A + '/login', { body: { username: 'mgr1', password: 'bad-bad-bad-bad' + i }, ip: ipL + i });
  r = await call('POST', A + '/login', { body: { username: 'mgr1', password: 'Manager-Strong-Pass-77' }, ip: '203.0.113.99' });
  eq(r.status, 429, 'account locks after 5 failed attempts, even with the right password');
  ok(!!r.headers.get('retry-after'), 'lockout sends Retry-After');

  const owner = await login('owner1', 'Correct-Horse-Battery-9');
  ok(owner.r.status === 200 && owner.csrf, 'owner can sign in');
  const sc = owner.r.headers.get('set-cookie');
  ok(/HttpOnly/i.test(sc) && /SameSite=Strict/i.test(sc) && sc.includes('Path=' + cfg.adminPath), 'session cookie is HttpOnly, SameSite=Strict, path-scoped');
  ok(!/Secure/i.test(sc), 'Secure flag off outside production (http test server)');
  const O = api(owner);
  r = await O('POST', '/security/users/' + db.get("SELECT id FROM admins WHERE username='mgr1'").id + '/unlock', {});
  eq(r.status, 200, 'owner can unlock a locked account');
  const mgr = await login('mgr1', 'Manager-Strong-Pass-77'); ok(mgr.r.status === 200, 'manager signs in after unlock');
  const sup = await login('sup1', 'Support-Strong-Pass-55'); ok(sup.r.status === 200, 'support signs in');
  const M = api(mgr), S = api(sup);
  r = await call('GET', cfg.adminPath, { cookie: owner.cookie });
  ok(r.status === 200 && /stub app|app/i.test(r.text), 'signed-in admin receives the dashboard shell');
  r = await call('GET', cfg.adminPath + '/assets/app.js', { cookie: owner.cookie }); eq(r.status, 200, 'dashboard assets served to a valid session');
  for (const k of ['content-security-policy', 'x-frame-options', 'x-content-type-options', 'cache-control', 'x-robots-tag']) ok(!!r.headers.get(k), 'admin response has ' + k);
  ok(/script-src 'self'/.test(r.headers.get('content-security-policy')) && !/unsafe-inline/.test(r.headers.get('content-security-policy')), 'admin CSP forbids inline scripts');

  // ---------------------------------------------------------------
  section('CSRF, origin and session checks');
  r = await call('POST', A + '/categories', { body: { name: 'X' }, cookie: owner.cookie });
  eq(r.status, 403, 'state change without CSRF token blocked');
  r = await call('POST', A + '/categories', { body: { name: 'X' }, cookie: owner.cookie, csrf: 'wrong' });
  eq(r.status, 403, 'state change with wrong CSRF token blocked');
  r = await call('POST', A + '/categories', { body: { name: 'X' }, cookie: owner.cookie, csrf: owner.csrf, origin: 'https://evil.example' });
  eq(r.status, 403, 'state change from a foreign origin blocked');
  r = await call('GET', A + '/me', { cookie: 'cc_session=forged-value' }); eq(r.status, 401, 'forged session cookie rejected');

  // ---------------------------------------------------------------
  section('Role-based access control');
  r = await S('GET', '/products'); eq(r.status, 200, 'support can read products');
  ok(r.json.length === 0 || !('cost_price' in r.json[0]), 'support product list has no cost fields');
  for (const [m, u, b] of [['POST', '/products', {}], ['POST', '/categories', { name: 'a' }], ['GET', '/finance'], ['GET', '/suppliers'], ['GET', '/promotions'], ['GET', '/settings'], ['PUT', '/settings', { store_name: 'x' }],
    ['GET', '/security/audit'], ['GET', '/security/users'], ['POST', '/expenses', { kind: 'other', amount: 1 }], ['POST', '/inventory/adjust', {}]]) {
    r = await S(m, u, b); eq(r.status, 403, `support blocked from ${m} ${u}`);
  }
  for (const [m, u, b] of [['GET', '/security/audit'], ['GET', '/security/users'], ['POST', '/security/users', {}], ['GET', '/security/status']]) {
    r = await M(m, u, b); eq(r.status, 403, `manager blocked from ${m} ${u}`);
  }
  r = await O('GET', '/security/audit'); eq(r.status, 200, 'owner can read the audit log');
  ok(r.json.some((a) => a.action === 'access.denied'), 'denied attempts are audit-logged');

  // ---------------------------------------------------------------
  section('Categories, suppliers, products');
  r = await M('POST', '/categories', { name: 'Bags', icon: 'Bags' }); eq(r.status, 201, 'create category'); const catBags = r.json.id;
  r = await M('POST', '/categories', { name: 'bags' }); eq(r.status, 400, 'duplicate category (case-insensitive) rejected');
  r = await M('POST', '/categories', { name: 'Hidden Cat', published: false }); const catHidden = r.json.id;
  r = await M('POST', '/suppliers', { name: 'Shenzhen Goods', phone: '+8613800000000', email: 'bad-email' }); eq(r.status, 400, 'invalid supplier email rejected');
  r = await M('POST', '/suppliers', { name: 'Shenzhen Goods', phone: '+8613800000000', email: 'sales@sz.example', lead_days: 7, notes: 'PRIVATE-SUPPLIER-NOTE' }); eq(r.status, 201, 'create supplier'); const sup1 = r.json.id;
  r = await M('POST', '/products', { name: 'Neg', price: -5 }); eq(r.status, 400, 'negative price rejected');
  r = await M('POST', '/products', { name: 'Bad compare', price: 50, compare_price: 40, category_id: catBags }); eq(r.status, 400, 'compare price below price rejected');
  r = await M('POST', '/products', { name: 'No cat', price: 50, published: true }); eq(r.status, 400, 'cannot publish without a category');
  r = await M('POST', '/products', { name: 'Leather Tote', brand: 'Linea', category_id: catBags, supplier_id: sup1, caption: 'Full-grain tote', description: 'Nice', price: 100, compare_price: 150,
    cost_price: 60, sku: 'TOTE-1', stock: 10, low_stock: 2, published: true, internal_notes: 'PRIVATE-PRODUCT-NOTE' });
  eq(r.status, 201, 'create product'); const pTote = r.json.id;
  r = await M('POST', '/products', { name: 'Canvas Weekender', category_id: catBags, price: 50, cost_price: 30, published: true, stock: 0,
    variants: [{ name: 'Black', sku: 'W-B', stock: 3 }, { name: 'Olive', sku: 'W-O', stock: 0 }] });
  eq(r.status, 201, 'create product with variants'); const pWeek = r.json.id;
  r = await M('POST', '/products', { name: 'Mystery Item', category_id: catBags, price: 50, published: true, stock: 5 }); const pNoCost = r.json.id;
  r = await M('POST', '/products', { name: 'Draft Item', category_id: catBags, price: 20, cost_price: 5, stock: 5 }); const pDraft = r.json.id;
  r = await M('POST', '/products', { name: 'In Hidden Category', category_id: catHidden, price: 20, cost_price: 5, stock: 5, published: true }); const pHiddenCat = r.json.id;
  r = await M('POST', '/products', { name: 'Dup variants', price: 5, variants: [{ name: 'A' }, { name: 'a' }] }); eq(r.status, 400, 'duplicate variant names rejected');
  r = await M('GET', '/products/' + pTote); ok(r.json.cost_price === 60 && r.json.internal_notes === 'PRIVATE-PRODUCT-NOTE', 'manager sees cost and internal notes');
  r = await S('GET', '/products/' + pTote); ok(r.status === 200 && !('cost_price' in r.json) && !('internal_notes' in r.json) && !('supplier_id' in r.json), 'support never receives cost/supplier/notes');
  r = await M('PUT', '/products/' + pTote, { name: 'Leather Tote', brand: 'Linea', category_id: catBags, supplier_id: sup1, price: 110, compare_price: 150, cost_price: 62, stock: 10, published: true, caption: 'Full-grain tote', description: 'Nice', internal_notes: 'PRIVATE-PRODUCT-NOTE' });
  eq(r.status, 200, 'update product price/cost');
  r = await O('GET', '/security/audit?action=product.update'); ok(r.json.some((a) => /"price":\[100,110\]/.test(a.detail) && /"cost_price":\[60,62\]/.test(a.detail)), 'price and cost changes are audit-logged with before/after');
  await M('PUT', '/products/' + pTote, { name: 'Leather Tote', brand: 'Linea', category_id: catBags, supplier_id: sup1, price: 100, compare_price: 150, cost_price: 60, stock: 10, published: true, caption: 'Full-grain tote', description: 'Nice', internal_notes: 'PRIVATE-PRODUCT-NOTE' });

  section('Images');
  r = await M('POST', '/products/' + pTote + '/images', { data: PNG }); eq(r.status, 201, 'upload a valid PNG'); const mediaOk = r.json.media_id;
  r = await M('POST', '/products/' + pTote + '/images', { data: Buffer.from('<script>alert(1)</script>').toString('base64') }); eq(r.status, 400, 'non-image upload rejected by content sniffing');
  r = await M('POST', '/products/' + pTote + '/images', { data: Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(20)]).toString('base64') }); eq(r.status, 400, 'GIF rejected (JPEG/PNG/WebP only)');
  r = await M('POST', '/products/' + pTote + '/images', { data: Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(1700 * 1024)]).toString('base64') }); ok(r.status === 400 || r.status === 413, 'oversized image rejected');
  r = await M('POST', '/products/' + pDraft + '/images', { data: PNG }); const mediaDraft = r.json.media_id;
  r = await call('GET', '/media/' + mediaOk); ok(r.status === 200 && r.headers.get('content-type') === 'image/png' && r.headers.get('x-content-type-options') === 'nosniff', 'published product image is public with nosniff');
  r = await call('GET', '/media/' + mediaDraft); eq(r.status, 404, 'image of an unpublished product is NOT public');
  r = await call('GET', A + '/media/' + mediaDraft, { cookie: owner.cookie }); eq(r.status, 200, 'admin can preview the unpublished image');
  r = await call('GET', '/media/' + mediaDraft, { cookie: owner.cookie }); eq(r.status, 404, 'session cookie does not unlock public media route');

  // ---------------------------------------------------------------
  section('Public catalog never leaks private data');
  r = await call('GET', '/api/public/catalog');
  const cat = r.json, txt = r.text;
  eq(r.status, 200, 'catalog loads');
  const names = cat.products.map((p) => p.name);
  ok(names.includes('Leather Tote') && names.includes('Canvas Weekender'), 'published products are listed');
  ok(!names.includes('Draft Item') && !names.includes('In Hidden Category'), 'drafts and products in unpublished categories are hidden');
  for (const secret of ['cost_price', 'internal_notes', 'supplier', 'PRIVATE-PRODUCT-NOTE', 'PRIVATE-SUPPLIER-NOTE', 'sales@sz.example', '"stock"', 'Shenzhen']) ok(!txt.includes(secret), `public catalog does not contain "${secret}"`);
  const tote = cat.products.find((p) => p.name === 'Leather Tote');
  ok(tote.price === 100 && tote.compare_price === 150 && tote.images.length === 1 && tote.in_stock === true, 'public product has price, offer, image and stock flag');
  const wk = cat.products.find((p) => p.name === 'Canvas Weekender');
  eq(wk.variants.map((v) => [v.name, v.in_stock]), [['Black', true], ['Olive', false]], 'variants expose only in-stock flags');

  // ---------------------------------------------------------------
  section('WhatsApp requests: created as requests, never auto-confirmed');
  const good = { name: 'Asha Rao', phone: '+91 98765 43210', address: '12 MG Road, Bengaluru', pincode: '560001', items: [{ product_id: pTote, qty: 2 }] };
  r = await call('POST', '/api/public/requests', { body: good });
  eq(r.status, 503, 'ordering is refused until a WhatsApp number is configured');
  r = await M('PUT', '/settings', { whatsapp_number: '12' }); eq(r.status, 400, 'invalid WhatsApp number rejected');
  r = await M('PUT', '/settings', { whatsapp_number: '+91 90000 11111', store_name: 'Cartitaz', currency: '$', free_over: 100, shipping: 4 }); eq(r.status, 200, 'manager configures WhatsApp number and delivery');
  r = await M('POST', '/promotions', { code: 'SAVE10', kind: 'percent', value: 10, min_subtotal: 50, usage_limit: 5 }); eq(r.status, 201, 'create promotion'); const promo1 = r.json.id;
  r = await M('POST', '/promotions', { code: 'SAVE10', kind: 'percent', value: 10 }); eq(r.status, 400, 'duplicate promo code rejected');
  r = await M('POST', '/promotions', { code: 'BIG', kind: 'percent', value: 150 }); eq(r.status, 400, 'percent over 100 rejected');
  const bad = [[{ ...good, name: '' }, 'missing name'], [{ ...good, phone: 'abc' }, 'bad phone'], [{ ...good, pincode: '!!' }, 'bad pincode'], [{ ...good, items: [] }, 'empty cart'],
    [{ ...good, items: [{ product_id: pDraft, qty: 1 }] }, 'draft product'], [{ ...good, items: [{ product_id: pTote, qty: 0 }] }, 'qty 0'], [{ ...good, items: [{ product_id: pTote, qty: 99 }] }, 'qty 99'],
    [{ ...good, items: [{ product_id: pWeek, qty: 1 }] }, 'variant required'], [{ ...good, items: [{ product_id: pWeek, variant_id: 999, qty: 1 }] }, 'bad variant'],
    [{ ...good, items: [{ product_id: pWeek, variant_id: db.get("SELECT id FROM variants WHERE name='Olive'").id, qty: 1 }] }, 'variant out of stock'],
    [{ ...good, items: [{ product_id: pTote, qty: 11 }] }, 'more than stock'], [{ ...good, promo: 'NOPE' }, 'unknown promo'], [{ ...good, website: 'http://spam' }, 'honeypot filled']];
  for (const [b, name] of bad) { r = await call('POST', '/api/public/requests', { body: b }); ok(r.status >= 400 && r.status < 500, 'request rejected: ' + name, r.status); }
  r = await call('POST', '/api/public/requests', { body: '{"x":' , raw: true }); eq(r.status, 400, 'malformed JSON rejected');
  r = await call('POST', '/api/public/requests', { body: { ...good, junk: 'x'.repeat(40000) } }); eq(r.status, 413, 'oversized request body rejected');

  const stockBefore = db.get('SELECT stock FROM products WHERE id=?', pTote).stock;
  r = await call('POST', '/api/public/requests', { body: { ...good, items: [{ product_id: pTote, qty: 2, price: 1 }], total: 1, promo: 'save10' } });
  eq(r.status, 201, 'valid request accepted');
  const req1 = r.json;
  ok(/^CT-[A-Z0-9]{7}$/.test(req1.code), 'request gets an unguessable code');
  eq([req1.subtotal, req1.discount, req1.shipping, req1.total], [200, 20, 0, 180], 'server recomputes totals (client price ignored, promo applied, free delivery)');
  ok(req1.whatsapp_number === '919000011111' && req1.message.includes(req1.code) && req1.message.includes('Asha Rao'), 'response carries the WhatsApp number and a message with the code');
  const o1 = db.get('SELECT * FROM orders WHERE code=?', req1.code);
  eq([o1.status, o1.confirmed_at, o1.stock_committed], ['new_request', null, 0], 'a new request is NOT confirmed and does not touch stock');
  eq(db.get('SELECT stock FROM products WHERE id=?', pTote).stock, stockBefore, 'stock unchanged until a human confirms');
  eq(db.get('SELECT used FROM promotions WHERE id=?', promo1).used, 0, 'promo usage not counted until confirmation');
  const it = db.get('SELECT * FROM order_items WHERE order_id=?', o1.id);
  eq([it.unit_price, it.unit_cost, it.supplier_id], [100, 60, sup1], 'supplier cost snapshot stored privately on the order item');
  r = await call('POST', '/api/public/requests', { body: { ...good, items: [{ product_id: pNoCost, qty: 1 }] } });
  const req2 = r.json; eq([req2.subtotal, req2.shipping, req2.total], [50, 4, 54], 'delivery charge applies below the free-delivery limit');
  const customers = db.all('SELECT * FROM customers'); eq(customers.length, 1, 'repeat phone number reuses one customer record');
  r = await call('POST', '/api/public/promo', { body: { code: 'SAVE10', subtotal: 20 } }); ok(r.json.ok === false, 'promo minimum enforced');

  // ---------------------------------------------------------------
  section('Manual order management');
  const id1 = o1.id, id2 = db.get('SELECT id FROM orders WHERE code=?', req2.code).id;
  r = await S('GET', '/orders/' + id1); ok(r.status === 200 && r.json.items.every((i) => !('unit_cost' in i) && !('supplier_name' in i)) && !('profit' in r.json) && !('expenses' in r.json), 'support sees the order but not supplier cost or profit');
  r = await M('GET', '/orders/' + id1); ok(r.json.items[0].unit_cost === 60 && r.json.items[0].supplier_name === 'Shenzhen Goods' && r.json.profit.complete === true, 'manager sees supplier cost, supplier and profit');
  r = await S('POST', '/orders/' + id1 + '/status', { status: 'shipped' }); eq(r.status, 409, 'cannot skip from new_request to shipped');
  r = await S('POST', '/orders/' + id1 + '/status', { status: 'bogus' }); eq(r.status, 400, 'unknown status rejected');
  r = await S('POST', '/orders/' + id1 + '/status', { status: 'refunded' }); eq(r.status, 400, 'refunds only through the refund endpoint');
  r = await S('POST', '/orders/' + id1 + '/status', { status: 'contacted', note: 'Called customer' }); eq(r.status, 200, 'support can mark contacted');
  r = await M('GET', '/orders?group=requests'); ok(r.json.rows.some((x) => x.code === req1.code), 'request list shows open WhatsApp requests');
  r = await M('GET', '/orders/' + id1 + '/wa-template?kind=confirm'); ok(r.json.phone === '919876543210' && r.json.text.includes(req1.code), 'WhatsApp template generated; opening it does not change status');
  eq(db.get('SELECT status FROM orders WHERE id=?', id1).status, 'contacted', 'status unchanged by generating a WhatsApp message');
  r = await M('PUT', '/orders/' + id1, { name: 'Asha Rao', phone: '+919876543210', address: '12 MG Road, Bengaluru', pincode: '560001', internal_notes: 'INTERNAL-ORDER-NOTE', shipping: 0, discount: 20, items: [{ id: it.id, unit_cost: 60, supplier_id: sup1 }] });
  eq(r.status, 200, 'manager edits internal notes');
  r = await M('POST', '/orders/' + id1 + '/status', { status: 'confirmed', note: 'Paid via UPI ref 123' }); eq(r.status, 200, 'manager confirms manually');
  eq(db.get('SELECT stock FROM products WHERE id=?', pTote).stock, stockBefore - 2, 'confirming commits stock');
  eq(db.get('SELECT used FROM promotions WHERE id=?', promo1).used, 1, 'promo usage counted at confirmation');
  ok(!!db.get('SELECT confirmed_at FROM orders WHERE id=?', id1).confirmed_at, 'confirmed_at is set by the human action');
  r = await M('POST', '/orders/' + id1 + '/status', { status: 'ordered_from_supplier', note: 'PO sent' }); eq(r.status, 200, 'ordered_from_supplier');
  r = await M('POST', '/orders/' + id1 + '/status', { status: 'shipped', country: 'India', state: 'Karnataka', district: 'Bengaluru Urban', place: 'Bengaluru hub', public_note: 'Dispatched today', note: 'INTERNAL-ONLY' });
  eq(r.status, 200, 'shipped with location');
  let t = await call('GET', '/api/public/track?code=' + req1.code + '&last4=0000'); eq(t.status, 404, 'tracking needs the right phone digits');
  t = await call('GET', '/api/public/track?code=' + req1.code + '&last4=3210');
  ok(t.status === 200 && t.json.status === 'shipped' && t.json.stage === 3 && t.json.loc[3].s === 'Karnataka' && t.json.loc[3].d === 'Bengaluru Urban', 'public tracking shows status and country/state/district');
  ok(!t.text.includes('INTERNAL-ONLY') && !t.text.includes('INTERNAL-ORDER-NOTE') && !t.text.includes('Asha') && !t.text.includes('MG Road') && !t.text.includes('Shenzhen'), 'public tracking leaks no internal notes, name, address or supplier');
  t = await call('GET', '/api/public/track?code=CT-AAAAAAA&last4=3210'); eq(t.status, 404, 'unknown code gives the same 404');
  r = await M('POST', '/orders/' + id1 + '/status', { status: 'delivered' }); eq(r.status, 200, 'delivered');
  r = await M('POST', '/orders/' + id1 + '/status', { status: 'cancelled' }); eq(r.status, 409, 'delivered orders cannot be cancelled');

  // insufficient stock blocks confirmation
  r = await call('POST', '/api/public/requests', { body: { ...good, phone: '+14155550101', items: [{ product_id: pTote, qty: 8 }] } }); const big = r.json;
  const bigId = db.get('SELECT id FROM orders WHERE code=?', big.code).id;
  r = await call('POST', '/api/public/requests', { body: { ...good, phone: '+14155550102', items: [{ product_id: pTote, qty: 8 }] } }); const big2Id = db.get('SELECT id FROM orders WHERE code=?', r.json.code).id;
  r = await M('POST', '/orders/' + bigId + '/status', { status: 'confirmed' }); eq(r.status, 200, 'first large order confirmed (8 of 8 left)');
  r = await M('POST', '/orders/' + big2Id + '/status', { status: 'confirmed' }); eq(r.status, 409, 'second large order blocked: not enough stock');
  ok(/Not enough stock/.test(r.json.error), 'error explains the shortage');
  r = await M('POST', '/orders/' + bigId + '/status', { status: 'cancelled' }); eq(r.status, 200, 'cancel a confirmed order');
  eq(db.get('SELECT stock FROM products WHERE id=?', pTote).stock, stockBefore - 2, 'cancelling restores the stock');

  // ---------------------------------------------------------------
  section('Profit uses only recorded data');
  const refundsBefore = db.get('SELECT COUNT(*) n FROM refunds').n;
  r = await M('POST', '/orders/' + id1 + '/expenses', { kind: 'shipping_cost', amount: 7, note: 'courier' }); eq(r.status, 201, 'record a per-order expense');
  r = await M('POST', '/expenses', { kind: 'advertising', amount: 10, note: 'ads' }); eq(r.status, 201, 'record a general expense');
  r = await S('POST', '/expenses', { kind: 'other', amount: 1 }); eq(r.status, 403, 'support cannot record expenses');
  // order 2 has no recorded cost -> confirm it
  r = await M('POST', '/orders/' + id2 + '/status', { status: 'confirmed' }); eq(r.status, 200, 'confirm the order whose supplier cost is unknown');
  let f = (await M('GET', '/finance')).json;
  eq([f.orders, f.net_sales, f.cogs, f.order_expenses, f.general_expenses], [2, 234, 120, 7, 10], 'sales include both orders; COGS/expenses come from recorded cost only');
  eq([f.complete_orders, f.incomplete_orders, f.incomplete_sales], [1, 1, 54], 'the order with an unknown supplier cost is flagged incomplete');
  eq(f.net_profit, 43, 'profit = 180 sales - 120 cost - 7 order expense - 10 general expense (incomplete order excluded)');
  ok(f.margin !== null && Math.abs(f.margin - 23.9) < 0.1, 'margin computed on the orders with recorded costs', f.margin);
  r = await M('POST', '/orders/' + id1 + '/refund', { amount: 500 }); eq(r.status, 409, 'refund above order total rejected');
  r = await M('POST', '/orders/' + id1 + '/refund', { amount: 30, note: 'partial', restock: false }); eq(r.status, 200, 'partial refund recorded');
  f = (await M('GET', '/finance')).json; eq([f.refunds, f.net_profit], [30, 13], 'refunds reduce profit');
  r = await M('PUT', '/orders/' + id2, { name: 'Asha Rao', phone: '+919876543210', address: '12 MG Road, Bengaluru', pincode: '560001', shipping: 4, discount: 0, items: [{ id: db.get('SELECT id FROM order_items WHERE order_id=?', id2).id, unit_cost: 30, supplier_id: sup1 }] });
  eq(r.status, 200, 'recording the missing supplier cost');
  f = (await M('GET', '/finance')).json; eq([f.incomplete_orders, f.net_profit], [0, 37], 'profit now includes the order once its cost is recorded: 234 sales - 150 cost - 7 - 10 - 30 refund');
  r = await M('GET', '/finance?from=2001-01-01&to=2001-01-31'); eq([r.json.orders, r.json.net_profit], [0, 0], 'date range filter works');
  r = await M('GET', '/finance?from=2020-01-01&to=2010-01-01'); eq(r.status, 400, 'invalid date range rejected');
  r = await M('GET', '/overview'); ok(r.json.finance && r.json.requests && r.json.recent.length >= 2, 'overview aggregates data');
  r = await S('GET', '/overview'); ok(!r.json.finance, 'overview hides finance from support');
  eq(refundsBefore, 0, 'sanity: no refunds before test');

  // ---------------------------------------------------------------
  section('Inventory');
  r = await M('POST', '/inventory/adjust', { product_id: pTote, delta: -1000, reason: 'oops' }); eq(r.status, 409, 'stock cannot go below zero');
  r = await M('POST', '/inventory/adjust', { product_id: pTote, delta: 5, reason: 'Restock delivery' }); eq(r.status, 200, 'adjust stock');
  r = await M('POST', '/inventory/adjust', { product_id: pWeek, delta: 1, reason: 'no variant given' }); eq(r.status, 404, 'variant products need a variant id');
  r = await M('GET', '/inventory/moves?product_id=' + pTote); ok(r.json.length >= 3 && r.json.some((x) => x.reason === 'Restock delivery'), 'stock movements are recorded');
  r = await S('GET', '/inventory'); ok(r.status === 200 && r.json.length >= 3, 'support can view inventory');

  // ---------------------------------------------------------------
  section('Website settings');
  r = await M('POST', '/media', { data: PNG }); eq(r.status, 201, 'upload a logo'); const logoId = r.json.id;
  r = await call('GET', '/media/' + logoId); eq(r.status, 404, 'uploaded media is private until referenced');
  r = await M('PUT', '/settings', { logo_icon: logoId, announcement: ['Free delivery over $100'], contact: { email: 'hello@cartitaz.example', phone: '+91 90000 11111', address: 'Bengaluru', hours: '9-6' },
    policies: { returns: '7 day returns', shipping: 'Ships in 3-5 days', privacy: 'We protect your data', terms: 'Terms' },
    banners: [{ title: 'Big sale', subtitle: 'Up to 35% off', category: 'Bags', c1: '#112233', c2: '#445566' }],
    home_sections: [{ type: 'deals', title: 'Deals', enabled: true }, { type: 'category', title: 'Bags', category: 'Bags', enabled: true }] });
  eq(r.status, 200, 'update logo, contact, policies, banners and homepage sections');
  r = await call('GET', '/media/' + logoId); eq(r.status, 200, 'logo becomes public once used by settings');
  r = await M('PUT', '/settings', { banners: [{ title: 'x', c1: 'red' }] }); eq(r.status, 400, 'invalid banner color rejected');
  r = await M('PUT', '/settings', { home_sections: [{ type: 'evil' }] }); eq(r.status, 400, 'invalid homepage section rejected');
  r = await M('PUT', '/settings', { admin_password: 'x' }); eq(r.status, 400, 'unknown settings keys rejected');
  const pubS = (await call('GET', '/api/public/catalog')).json.settings;
  ok(pubS.contact.email === 'hello@cartitaz.example' && pubS.policies.returns === '7 day returns' && pubS.banners[0].title === 'Big sale' && pubS.logo_icon === '/media/' + logoId, 'public site receives the new settings');
  r = await S('GET', '/settings'); eq(r.status, 403, 'support cannot read admin settings');

  // ---------------------------------------------------------------
  section('Two-factor authentication');
  r = await M('POST', '/2fa/setup', {}); eq(r.status, 200, '2FA setup returns a secret'); const totpSecret = r.json.secret;
  ok(/^[A-Z2-7]{32}$/.test(totpSecret), 'secret is base32');
  ok(!db.get("SELECT totp_secret FROM admins WHERE username='mgr1'").totp_secret.includes(totpSecret), '2FA secret is encrypted at rest');
  r = await M('POST', '/2fa/enable', { code: '000000' }); eq(r.status, 400, 'wrong code does not enable 2FA');
  const code1 = sec.totpAt(totpSecret);
  r = await M('POST', '/2fa/enable', { code: code1 }); eq(r.status, 200, 'correct code enables 2FA');
  const rec = r.json.recovery_codes; ok(Array.isArray(rec) && rec.length === 8 && rec.every((c) => /^[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(c)), 'enabling 2FA issues 8 recovery codes');
  ok(db.all('SELECT hash FROM recovery_codes').every((x) => !rec.some((c) => x.hash.includes(c.replace('-', '')))), 'recovery codes are stored only as hashes');
  r = await call('POST', A + '/login', { body: { username: 'mgr1', password: 'Manager-Strong-Pass-77' } }); ok(r.status === 401 && r.json.need_totp === true, 'login now asks for the code');
  r = await call('POST', A + '/login', { body: { username: 'mgr1', password: 'Manager-Strong-Pass-77', totp: code1 } }); eq(r.status, 401, 'the code used at enrolment cannot be replayed');
  const code2 = sec.totpAt(totpSecret, Date.now() + 30000);
  r = await call('POST', A + '/login', { body: { username: 'mgr1', password: 'Manager-Strong-Pass-77', totp: code2 } }); eq(r.status, 200, 'a fresh code signs in');
  r = await call('POST', A + '/login', { body: { username: 'mgr1', password: 'Manager-Strong-Pass-77', totp: code2 } }); eq(r.status, 401, 'the same code cannot be used twice');
  r = await O('GET', '/security/users'); ok(r.json.find((u) => u.username === 'mgr1').totp_enabled === 1, 'owner can see who has 2FA');
  const rcLogin = (code) => call('POST', A + '/login', { body: { username: 'mgr1', password: 'Manager-Strong-Pass-77', totp: code } });
  r = await rcLogin(rec[0].toLowerCase().replace('-', ' ')); eq(r.status, 200, 'a recovery code signs in (case and spacing tolerant)');
  r = await rcLogin(rec[0]); eq(r.status, 401, 'a recovery code works only once');
  r = await rcLogin('AAAAA-AAAAA'); eq(r.status, 401, 'a wrong recovery code is refused');
  const mgrRc = await login('mgr1', 'Manager-Strong-Pass-77', { totp: rec[1] }); const MR = api(mgrRc);
  r = await MR('GET', '/me'); eq(r.json.admin.recovery_left, 6, 'the dashboard shows how many recovery codes are left');
  r = await MR('POST', '/2fa/recovery', { password: 'Manager-Strong-Pass-77', code: '000000' }); eq(r.status, 400, 'new recovery codes need a valid authenticator code');
  db.run("UPDATE admins SET totp_last=0 WHERE username='mgr1'");
  r = await MR('POST', '/2fa/recovery', { password: 'Manager-Strong-Pass-77', code: sec.totpAt(totpSecret) }); eq(r.status, 200, 'new recovery codes issued with password + code');
  const rec2 = r.json.recovery_codes; r = await rcLogin(rec[2]); eq(r.status, 401, 'old recovery codes stop working after new ones are issued');
  r = await rcLogin(rec2[0]); eq(r.status, 200, 'new recovery code works');
  r = await O('GET', '/security/audit?action=recovery'); ok(r.json.length >= 2, 'recovery-code use is audit-logged');


  // ---------------------------------------------------------------
  section('Passwords, sessions and users');
  r = await S('POST', '/password', { current: 'Support-Strong-Pass-55', next: 'short' }); eq(r.status, 400, 'weak new password rejected');
  r = await S('POST', '/password', { current: 'wrong-current-pass', next: 'Brand-New-Strong-Pass-1' }); eq(r.status, 400, 'wrong current password rejected');
  const sup2 = await login('sup1', 'Support-Strong-Pass-55');
  r = await S('POST', '/password', { current: 'Support-Strong-Pass-55', next: 'Brand-New-Strong-Pass-1' }); eq(r.status, 200, 'password changed');
  r = await call('GET', A + '/me', { cookie: sup2.cookie }); eq(r.status, 401, 'other sessions are revoked after a password change');
  r = await S('GET', '/me'); eq(r.status, 200, 'current session stays signed in');
  r = await O('POST', '/security/users', { username: 'temp1', name: 'Temp', role: 'manager', password: 'Temporary-Pass-2024!' }); eq(r.status, 201, 'owner creates a user');
  const tmpU = await login('temp1', 'Temporary-Pass-2024!'); const T = api(tmpU);
  r = await T('GET', '/products'); ok(r.status === 403 && r.json.must_change === true, 'new users must change their password before doing anything else');
  r = await T('POST', '/password', { current: 'Temporary-Pass-2024!', next: 'Personal-Strong-Pass-3' }); eq(r.status, 200, 'forced password change works');
  r = await T('GET', '/products'); eq(r.status, 200, 'access after the password change');
  const ownerId = db.get("SELECT id FROM admins WHERE username='owner1'").id;
  r = await O('PUT', '/security/users/' + ownerId, { name: 'Owner', role: 'manager', disabled: false }); eq(r.status, 409, 'owner cannot demote themselves');
  const tempId = db.get("SELECT id FROM admins WHERE username='temp1'").id;
  r = await O('PUT', '/security/users/' + tempId, { name: 'Temp', role: 'support', disabled: true }); eq(r.status, 200, 'owner disables a user');
  r = await T('GET', '/me'); eq(r.status, 401, 'disabling a user ends their sessions');
  r = await call('POST', A + '/login', { body: { username: 'temp1', password: 'Personal-Strong-Pass-3' } }); eq(r.status, 401, 'disabled user cannot sign in');
  r = await O('GET', '/security/sessions?all=1'); ok(r.json.length >= 3 && r.json.some((s) => s.current), 'owner lists all sessions');
  r = await M('GET', '/security/sessions'); ok(r.json.every((s) => s.username === 'mgr1'), 'non-owners only see their own sessions');
  r = await O('GET', '/security/status'); ok(Array.isArray(r.json.checks) && r.json.checks.length >= 4, 'security checklist available');
  r = await O('POST', '/logout', {}); eq(r.status, 200, 'logout'); r = await O('GET', '/me'); eq(r.status, 401, 'session invalid after logout');

  // ---------------------------------------------------------------
  section('Customers and privacy');
  const own2 = await login('owner1', 'Correct-Horse-Battery-9'); const O2 = api(own2);
  r = await S('GET', '/customers'); ok(r.status === 200 && r.json.length === 3, 'support can see customers needed to serve orders');
  const cid = db.get("SELECT id FROM customers WHERE phone='+14155550101'").id;
  r = await O2('POST', '/customers/' + db.get("SELECT id FROM customers WHERE phone='+919876543210'").id + '/anonymize', {}); eq(r.status, 409, 'cannot erase a customer who has orders in progress');
  r = await O2('POST', '/customers/' + cid + '/anonymize', {}); eq(r.status, 200, 'customer data can be erased (anonymised)');
  const an = db.get('SELECT * FROM customers WHERE id=?', cid); ok(an.name === 'Deleted customer' && an.address === null && /^deleted-/.test(an.phone), 'personal fields removed');
  ok(db.all("SELECT * FROM orders WHERE customer_id=?", cid).every((o) => o.address === 'deleted' && o.name === 'Deleted customer'), 'order addresses and names scrubbed too');
  r = await O2('GET', '/security/audit?limit=200'); const acts = new Set(r.json.map((a) => a.action));
  for (const a of ['login.success', 'login.failed', 'product.create', 'product.update', 'order.status', 'order.refund', 'settings.update', 'inventory.adjust', '2fa.enabled', 'password.changed', 'user.create', 'customer.anonymize', 'expense.create']) ok(acts.has(a), 'audit log has ' + a);
  ok(!r.text.includes('Correct-Horse') && !r.text.includes('Manager-Strong') && !/pass_hash|scrypt\$/.test(r.text), 'audit log never contains passwords or hashes');
  r = await O2('DELETE', '/security/audit', undefined); ok(r.status === 404 || r.status === 405, 'audit log cannot be deleted through the API');

  // ---------------------------------------------------------------
  section('Public site hardening');
  r = await call('GET', '/'); ok(r.status === 200 && !!r.headers.get('content-security-policy') && r.headers.get('x-frame-options') === 'DENY', 'storefront served with CSP and frame protection');
  ok(!r.text.includes(cfg.adminPath) && !/control-center/i.test(r.text), 'storefront HTML contains no admin links or paths');
  for (const p of ['/.env', '/src/app.js', '/..%2f..%2fsrc%2fapp.js', '/%2e%2e/src/db.js', '/data/cartitaz.db', '/package.json', '/admin/app.js', '/test/run.js']) { r = await call('GET', p); eq(r.status, 404, 'cannot fetch ' + p); }
  r = await call('GET', '/healthz'); eq(r.status, 200, 'health check');
  // public request limit: 6 per 10 minutes per IP
  const spamIp = '198.51.100.7'; let blocked = 0;
  for (let i = 0; i < 8; i++) { const x = await call('POST', '/api/public/requests', { body: { ...good, phone: '+1415555' + (2000 + i), items: [{ product_id: pTote, qty: 1 }] }, ip: spamIp }); if (x.status === 429) blocked++; }
  ok(blocked >= 2, 'order-request flooding is rate limited', blocked);



  // ---------------------------------------------------------------
  section('Lost phone: staff and server-side recovery');
  const mgrId = db.get("SELECT id FROM admins WHERE username='mgr1'").id;
  r = await O2('POST', '/security/users/' + mgrId + '/disable-2fa', {}); eq(r.status, 200, 'owner can reset a staff member\'s 2FA');
  eq(db.get('SELECT COUNT(*) n FROM recovery_codes WHERE admin_id=?', mgrId).n, 0, 'resetting 2FA also deletes the recovery codes');
  eq(db.get('SELECT totp_enabled t FROM admins WHERE id=?', mgrId).t, 0, '2FA is off after the reset');
  c = cliCreate(['--username', 'cli1', '--name', 'Cli', '--role', 'manager'], 'Cli-Strong-Passphrase-12'); ok(c.status === 0, 'create a user for the CLI recovery test', c.stderr);
  db.run("UPDATE admins SET totp_enabled=1, totp_secret='x' WHERE username='cli1'"); db.run("INSERT INTO recovery_codes(admin_id,hash) VALUES((SELECT id FROM admins WHERE username='cli1'),'h')");
  c = spawnSync('node', ['scripts/create-admin.js', '--disable-2fa', 'cli1'], { env: { ...process.env, ...env }, cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  ok(c.status === 0 && /Two-factor removed/.test(c.stdout), 'CLI --disable-2fa removes 2FA for a locked-out admin', c.stderr);
  eq([db.get("SELECT totp_enabled t FROM admins WHERE username='cli1'").t, db.get("SELECT COUNT(*) n FROM recovery_codes WHERE admin_id=(SELECT id FROM admins WHERE username='cli1')").n], [0, 0], 'CLI removed the secret and the recovery codes');
  ok(!!db.get("SELECT 1 x FROM audit WHERE action='2fa.disabled_cli'"), 'the CLI recovery is audit-logged');
  // ---------------------------------------------------------------
  section('Bootstrap owner for hosts without a shell');
  const bootstrap = require('../src/bootstrap'); const quiet = { log() {}, warn() {}, error() {} };
  const mk = (extra) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-bs-')); const c = load({ ...env, DATA_DIR: d, ...extra }); return { d, c, a: createApp(c) }; };
  let b1 = mk({ BOOTSTRAP_ADMIN_USERNAME: 'firstowner', BOOTSTRAP_ADMIN_PASSWORD: 'weak' });
  eq((await bootstrap.run(b1.a.db, b1.c, quiet)).status, 'weak', 'weak bootstrap password is refused'); eq(b1.a.db.get('SELECT COUNT(*) n FROM admins').n, 0, 'no account is created from a weak password'); b1.a.close();
  b1 = mk({ BOOTSTRAP_ADMIN_USERNAME: 'firstowner' }); eq((await bootstrap.run(b1.a.db, b1.c, quiet)).status, 'incomplete', 'a username without a password creates nothing'); b1.a.close();
  b1 = mk({ BOOTSTRAP_ADMIN_USERNAME: 'firstowner', BOOTSTRAP_ADMIN_PASSWORD: 'Bootstrap-Strong-Pass-8' });
  eq((await bootstrap.run(b1.a.db, b1.c, quiet)).status, 'created', 'strong bootstrap password creates the owner');
  const bo = b1.a.db.get("SELECT * FROM admins WHERE username='firstowner'");
  ok(bo.role === 'owner' && bo.must_change === 1 && !bo.pass_hash.includes('Bootstrap'), 'bootstrap owner must change the password and is stored hashed');
  const before = bo.pass_hash;
  b1.c.bootstrap.password = 'Different-Strong-Pass-99'; eq((await bootstrap.run(b1.a.db, b1.c, quiet)).status, 'ignored', 'bootstrap variables are ignored once an administrator exists');
  eq(b1.a.db.get("SELECT pass_hash FROM admins WHERE username='firstowner'").pass_hash, before, 'the existing password is not overwritten by leftover variables');
  const s2 = http.createServer(b1.a.handler); await new Promise((r) => s2.listen(0, '127.0.0.1', r)); const B2 = 'http://127.0.0.1:' + s2.address().port;
  let lr = await fetch(B2 + cfg.adminPath + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: B2 }, body: JSON.stringify({ username: 'firstowner', password: 'Bootstrap-Strong-Pass-8' }) });
  const ck = (lr.headers.get('set-cookie') || '').split(';')[0]; eq(lr.status, 200, 'bootstrap owner can sign in');
  const me2 = await (await fetch(B2 + cfg.adminPath + '/api/me', { headers: { Cookie: ck } })).json();
  let pr = await fetch(B2 + cfg.adminPath + '/api/products', { headers: { Cookie: ck } }); eq(pr.status, 403, 'nothing but the password change works until it is changed');
  pr = await fetch(B2 + cfg.adminPath + '/api/password', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: B2, Cookie: ck, 'X-CSRF-Token': me2.csrf }, body: JSON.stringify({ current: 'Bootstrap-Strong-Pass-8', next: 'My-Own-Strong-Pass-2026' }) }); eq(pr.status, 200, 'forced password change succeeds');
  pr = await fetch(B2 + cfg.adminPath + '/api/products', { headers: { Cookie: ck } }); eq(pr.status, 200, 'full access after choosing a new password');
  s2.close(); b1.a.close(); fs.rmSync(b1.d, { recursive: true, force: true });

  section('Production configuration');
  let threw = false; try { load({ NODE_ENV: 'production', APP_SECRET: 'short' }); } catch { threw = true; }
  ok(threw, 'production refuses to start without a strong APP_SECRET');
  threw = false; try { load({ NODE_ENV: 'production', APP_SECRET: 'z'.repeat(40), ADMIN_PATH: '/api' }); } catch { threw = true; }
  ok(threw, 'reserved admin path refused');
  const pcfg = load({ NODE_ENV: 'production', APP_SECRET: 'z'.repeat(40), DATA_DIR: tmp }); ok(pcfg.cookieSecure === true, 'cookies are Secure by default in production');

  server.close(); app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nFailures:\n - ' + failures.join('\n - ')); process.exit(1); }
})().catch((e) => { console.error('TEST CRASH', e); process.exit(2); });
