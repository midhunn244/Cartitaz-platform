'use strict';
const fs = require('fs');
const path = require('path');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; Object.assign(this, extra || {}); }
}
const httpErr = (s, m, e) => new HttpError(s, m, e);

function baseHeaders(cfg) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    ...(cfg.prod ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
  };
}
const ADMIN_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const SHOP_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'";

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}
function json(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) return reject(httpErr(415, 'Content-Type must be application/json'));
    let size = 0, over = false; const chunks = [];
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > limit) { over = true; chunks.length = 0; reject(httpErr(413, 'Request is too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) return;
      try { const t = Buffer.concat(chunks).toString('utf8'); resolve(t ? JSON.parse(t) : {}); }
      catch { reject(httpErr(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function parseCookies(h) {
  const out = {};
  for (const part of String(h || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function serveFile(res, file, headers = {}, replace) {
  let data;
  try { data = fs.readFileSync(file); } catch { return false; }
  const ext = path.extname(file).toLowerCase();
  if (replace && (ext === '.html' || ext === '.js')) data = Buffer.from(replace(data.toString('utf8')));
  send(res, 200, data, { 'Content-Type': MIME[ext] || 'application/octet-stream', ...headers });
  return true;
}
// resolve a URL path inside root, refusing traversal
function safeJoin(root, rel) {
  let p; try { p = decodeURIComponent(rel); } catch { return null; }
  if (p.includes('\0')) return null;
  const full = path.resolve(root, '.' + path.posix.normalize('/' + p));
  return full.startsWith(path.resolve(root) + path.sep) || full === path.resolve(root) ? full : null;
}

// ---------- Validation ----------
class VErr extends Error { constructor(fields) { super('Please fix the highlighted fields'); this.status = 400; this.fields = fields; } }
class F {
  constructor(o) { this.i = o && typeof o === 'object' && !Array.isArray(o) ? o : {}; this.out = {}; this.err = {}; }
  bad(k, m) { this.err[k] = m; return this; }
  str(k, { req = false, min = 0, max = 200, re, msg, trim = true } = {}) {
    let v = this.i[k];
    if (v === undefined || v === null || v === '') { if (req) this.bad(k, 'Required'); else this.out[k] = null; return this; }
    if (typeof v !== 'string') return this.bad(k, 'Must be text');
    if (trim) v = v.trim();
    if (!v.length && req) return this.bad(k, 'Required');
    if (v.length < min) return this.bad(k, `At least ${min} characters`);
    if (v.length > max) return this.bad(k, `At most ${max} characters`);
    if (re && !re.test(v)) return this.bad(k, msg || 'Invalid format');
    this.out[k] = v; return this;
  }
  num(k, { req = false, min = -1e12, max = 1e12, int = false } = {}) {
    let v = this.i[k];
    if (v === undefined || v === null || v === '') { if (req) this.bad(k, 'Required'); else this.out[k] = null; return this; }
    if (typeof v === 'string') v = Number(v);
    if (typeof v !== 'number' || !Number.isFinite(v)) return this.bad(k, 'Must be a number');
    if (int && !Number.isInteger(v)) return this.bad(k, 'Must be a whole number');
    if (v < min || v > max) return this.bad(k, `Must be between ${min} and ${max}`);
    this.out[k] = int ? v : Math.round(v * 100) / 100; return this;
  }
  bool(k, def = 0) {
    const v = this.i[k];
    this.out[k] = v === undefined ? def : (v === true || v === 1 || v === '1' || v === 'true') ? 1 : 0; return this;
  }
  en(k, list, { req = true } = {}) {
    const v = this.i[k];
    if (v === undefined || v === null || v === '') { if (req) this.bad(k, 'Required'); else this.out[k] = null; return this; }
    if (!list.includes(v)) return this.bad(k, 'Invalid choice');
    this.out[k] = v; return this;
  }
  done() { if (Object.keys(this.err).length) throw new VErr(this.err); return this.out; }
}

const money = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const normPhone = (s) => String(s || '').replace(/[\s\-().]/g, '');

module.exports = { HttpError, httpErr, baseHeaders, ADMIN_CSP, SHOP_CSP, send, json, readJson, parseCookies, serveFile, safeJoin, VErr, F, money, normPhone, MIME };
