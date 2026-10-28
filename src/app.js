'use strict';
const path = require('path');
const { open } = require('./db');
const sec = require('./security');
const { makeCore } = require('./core');
const adminMod = require('./admin');
const publicMod = require('./public');
const H = require('./http');

const ROOT = path.join(__dirname, '..');

function createApp(cfg) {
  const db = open(cfg.dataDir);
  const core = makeCore(db);
  const limiter = new sec.Limiter();
  const ADMIN = cfg.adminPath;

  const clientIp = (req) => {
    if (cfg.trustProxy) {
      const x = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (x.length) return x[x.length - 1];       // value appended by our single trusted proxy
    }
    return req.socket.remoteAddress || 'unknown';
  };
  const audit = (ctx, action, entity, id, detail, actor) => {
    const a = actor || ctx.admin || null;
    db.run('INSERT INTO audit(ts,admin_id,username,action,entity,entity_id,detail,ip) VALUES(?,?,?,?,?,?,?,?)', Date.now(), a ? a.id : null,
      a ? a.username : (detail && detail.username) || null, action, entity || null, id == null ? null : String(id), detail ? JSON.stringify(detail).slice(0, 4000) : null, ctx.ip);
  };
  const adminRoutes = adminMod.register({ db, core, cfg, limiter, audit });
  const pub = publicMod.register({ db, core, cfg, limiter });

  function loadSession(req) {
    const raw = H.parseCookies(req.headers.cookie).cc_session;
    if (!raw || raw.length > 100) return null;
    const id = sec.sha256(raw), s = db.get('SELECT * FROM sessions WHERE id=?', id), t = Date.now();
    if (!s) return null;
    if (s.expires_at <= t || t - s.last_seen > cfg.sessionIdleMs) { db.run('DELETE FROM sessions WHERE id=?', id); return null; }
    const a = db.get('SELECT * FROM admins WHERE id=?', s.admin_id);
    if (!a || a.disabled) { db.run('DELETE FROM sessions WHERE id=?', id); return null; }
    if (t - s.last_seen > 60000) db.run('UPDATE sessions SET last_seen=? WHERE id=?', t, id);
    return { session: s, admin: a };
  }
  const originOk = (req) => {
    const o = req.headers.origin; if (!o) return false;
    if (cfg.publicOrigin) return o === cfg.publicOrigin;
    try { return new URL(o).host === req.headers.host; } catch { return false; }
  };
  const match = (routes, method, p) => {
    let pathMatched = false;
    for (const r of routes) {
      const m = r.re.exec(p); if (!m) continue;
      pathMatched = true;
      if (r.method === method) { const params = {}; r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); }); return { route: r, params }; }
    }
    return { route: null, pathMatched };
  };

  async function adminApi(req, res, url, ip, base) {
    const sub = url.pathname.slice(ADMIN.length + 4) || '/';
    const { route, params, pathMatched } = match(adminRoutes, req.method, sub);
    const sess = route && route.public ? null : loadSession(req);
    if (!route) {
      if (!sess) throw H.httpErr(401, 'Sign in required');
      throw H.httpErr(pathMatched ? 405 : 404, pathMatched ? 'Method not allowed' : 'Not found');
    }
    if (!route.public && !sess) throw H.httpErr(401, 'Sign in required');
    const unsafe = req.method !== 'GET' && req.method !== 'HEAD';
    if (unsafe && !originOk(req)) throw H.httpErr(403, 'Cross-origin request blocked');
    const ctx = { req, res, url, query: Object.fromEntries(url.searchParams), params, body: {}, admin: sess && sess.admin, session: sess && sess.session, ip, headers: {}, status: 200 };
    if (sess) {
      const h = limiter.hit('api:' + sess.admin.id, 600, 60000);
      if (!h.ok) throw H.httpErr(429, 'Too many requests', { retry: h.retry });
      if (unsafe && !sec.safeEq(req.headers['x-csrf-token'] || '', sess.session.csrf)) throw H.httpErr(403, 'Invalid security token. Reload the page.');
      if (sess.admin.must_change && !route.allowMustChange) throw H.httpErr(403, 'You must change your password first', { must_change: true });
      if (route.perm && !adminMod.can(sess.admin.role, route.perm)) {
        audit(ctx, 'access.denied', 'route', route.method + ' ' + sub, { perm: route.perm });
        throw H.httpErr(403, 'You do not have permission to do this');
      }
    }
    if (req.method === 'POST' || req.method === 'PUT') ctx.body = await H.readJson(req, route.limit || 64 * 1024);
    const out = await route.handler(ctx);
    if (out && out.__raw) return H.send(res, out.status, out.body, { ...base, ...out.headers });
    H.json(res, ctx.status, out, { ...base, ...ctx.headers });
  }

  async function adminDispatch(req, res, url, ip, base) {
    const rel = url.pathname.slice(ADMIN.length) || '/';
    const adminHeaders = { ...base, 'Content-Security-Policy': H.ADMIN_CSP, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };
    const sub = (s) => s.replace(/%ADMIN%/g, ADMIN);
    if (rel === '/' || rel === '') {
      if (req.method !== 'GET') throw H.httpErr(405, 'Method not allowed');
      const file = path.join(ROOT, 'admin', loadSession(req) ? 'app.html' : 'login.html');
      if (!H.serveFile(res, file, adminHeaders, sub)) throw H.httpErr(404, 'Not found');
      return;
    }
    if (rel.startsWith('/assets/')) {
      if (req.method !== 'GET') throw H.httpErr(405, 'Method not allowed');
      const name = rel.slice(8);
      const open_ = ['login.js', 'login.css'].includes(name), priv = ['app.js', 'app.css'].includes(name);
      if (!(open_ || (priv && loadSession(req)))) throw H.httpErr(404, 'Not found');
      if (!H.serveFile(res, path.join(ROOT, 'admin', name), adminHeaders, sub)) throw H.httpErr(404, 'Not found');
      return;
    }
    if (rel.startsWith('/api/') || rel === '/api') return adminApi(req, res, url, ip, adminHeaders);
    throw H.httpErr(404, 'Not found');
  }

  async function publicApi(req, res, url, ip, base) {
    const sub = url.pathname.slice('/api/public'.length) || '/';
    const r = pub.routes.find((x) => x.path === sub && x.method === req.method);
    if (!r) throw H.httpErr(pub.routes.some((x) => x.path === sub) ? 405 : 404, 'Not found');
    const h = limiter.hit('pub:' + ip, 240, 60000);
    if (!h.ok) throw H.httpErr(429, 'Too many requests', { retry: h.retry });
    const ctx = { req, res, url, query: Object.fromEntries(url.searchParams), body: {}, ip, status: 200 };
    if (req.method === 'POST') {
      if (req.headers.origin && !originOk(req)) throw H.httpErr(403, 'Cross-origin request blocked');
      ctx.body = await H.readJson(req, r.limit || 8 * 1024);
    }
    const out = await r.handler(ctx);
    H.json(res, ctx.status, out, { ...base, 'Cache-Control': req.method === 'GET' && sub === '/catalog' ? 'no-cache' : 'no-store' });
  }

  async function handler(req, res) {
    const base = H.baseHeaders(cfg);
    const ip = clientIp(req);
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
      const p = url.pathname;
      if (p === '/healthz') return H.json(res, 200, { ok: true }, base);
      if (p === ADMIN || p.startsWith(ADMIN + '/')) return await adminDispatch(req, res, url, ip, base);
      if (p.startsWith('/api/public/')) return await publicApi(req, res, url, ip, base);
      if (p.startsWith('/media/') && req.method === 'GET') {
        const m = pub.mediaPublic(p.slice(7));
        if (!m) throw H.httpErr(404, 'Not found');
        return H.send(res, 200, m.data, { ...base, 'Content-Type': m.mime, 'Content-Security-Policy': "default-src 'none'", 'Cache-Control': 'public, max-age=3600' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw H.httpErr(405, 'Method not allowed');
      const rel = p === '/' ? '/index.html' : p;
      const file = H.safeJoin(path.join(ROOT, 'public'), rel);
      if (!file || path.basename(file).startsWith('.')) throw H.httpErr(404, 'Not found');
      const isHtml = file.endsWith('.html');
      if (!H.serveFile(res, file, { ...base, 'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=3600', ...(isHtml ? { 'Content-Security-Policy': H.SHOP_CSP } : {}) })) throw H.httpErr(404, 'Not found');
    } catch (e) {
      if (res.headersSent) return res.end();
      if (e instanceof H.HttpError || e instanceof H.VErr) {
        const body = { error: e.message };
        for (const k of ['fields', 'need_totp', 'must_change', 'retry', 'field', 'product_id']) if (e[k] !== undefined) body[k] = e[k];
        const hdr = { ...base }; if (e.retry) hdr['Retry-After'] = String(e.retry);
        return H.json(res, e.status, body, hdr);
      }
      console.error('[error]', req.method, url && url.pathname, e && e.stack || e);
      H.json(res, 500, { error: 'Something went wrong. Please try again.' }, base);
    }
  }

  const sweep = setInterval(() => { db.run('DELETE FROM sessions WHERE expires_at<?', Date.now()); }, 10 * 60 * 1000); sweep.unref();
  return { handler, db, core, routes: adminRoutes, close: () => { clearInterval(sweep); db.close(); } };
}
module.exports = { createApp };
