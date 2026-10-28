'use strict';
const crypto = require('crypto');

// ---------- Password hashing (scrypt, per-user random salt) ----------
const N = 32768, R = 8, P = 1, KEYLEN = 64;
const scrypt = (pw, salt, n, r, p, len) =>
  new Promise((res, rej) => crypto.scrypt(pw, salt, len, { N: n, r, p, maxmem: 128 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, N, R, P, KEYLEN);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}
async function verifyPassword(pw, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64');
  try {
    const key = await scrypt(pw, Buffer.from(salt, 'base64'), +n, +r, +p, expected.length);
    return crypto.timingSafeEqual(key, expected);
  } catch { return false; }
}
let dummy = null;
async function dummyHash() { return dummy || (dummy = await hashPassword(crypto.randomBytes(24).toString('hex'))); }

const COMMON = new Set(['password123456', '123456789012', 'qwertyuiop12', 'admin1234567', 'welcome12345', 'letmein123456',
  'changeme1234', 'iloveyou12345', 'password1234', 'cartitaz12345', 'cartitaz@123']);
function passwordProblem(pw, username = '') {
  if (typeof pw !== 'string') return 'Password is required';
  if (pw.length < 12) return 'Use at least 12 characters';
  if (pw.length > 200) return 'Password is too long';
  if (COMMON.has(pw.toLowerCase())) return 'That password is too common';
  if (username && pw.toLowerCase().includes(String(username).toLowerCase())) return 'Password must not contain the username';
  if (/^(.)\1+$/.test(pw)) return 'Password is too repetitive';
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  if (classes < 3 && pw.length < 16) return 'Use upper and lower case letters, numbers or symbols, or make it 16+ characters';
  return '';
}

// ---------- Tokens ----------
const token = (n = 32) => crypto.randomBytes(n).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------- Encryption at rest (for 2FA secrets) ----------
const keyFrom = (secret) => crypto.createHash('sha256').update('cartitaz-enc:' + secret).digest();
function encrypt(text, secret) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString('base64')).join('.');
}
function decrypt(blob, secret) {
  try {
    const [iv, tag, ct] = String(blob).split('.').map((s) => Buffer.from(s, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', keyFrom(secret), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch { return null; }
}

// ---------- TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32enc(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function b32dec(s) {
  let bits = 0, val = 0; const out = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(ch); if (i < 0) continue;
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function hotp(key, counter) {
  const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(b).digest();
  const o = h[19] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0');
}
const newTotpSecret = () => b32enc(crypto.randomBytes(20));
function totpAt(secretB32, t = Date.now()) { return hotp(b32dec(secretB32), Math.floor(t / 30000)); }
// returns the matched counter (for replay protection) or null
function totpVerify(secretB32, code, lastCounter = 0, t = Date.now()) {
  if (!/^\d{6}$/.test(String(code))) return null;
  const key = b32dec(secretB32), now = Math.floor(t / 30000);
  for (let d = -1; d <= 1; d++) {
    const c = now + d;
    if (c > lastCounter && safeEq(hotp(key, c), code)) return c;
  }
  return null;
}

// ---------- Fixed-window rate limiter (in-memory, per process) ----------
class Limiter {
  constructor() {
    this.m = new Map();
    this.timer = setInterval(() => { const n = Date.now(); for (const [k, v] of this.m) if (v.reset <= n) this.m.delete(k); }, 60000);
    this.timer.unref();
  }
  hit(key, limit, windowMs) {
    const n = Date.now(); let v = this.m.get(key);
    if (!v || v.reset <= n) { v = { c: 0, reset: n + windowMs }; this.m.set(key, v); }
    v.c++;
    return { ok: v.c <= limit, retry: Math.max(1, Math.ceil((v.reset - n) / 1000)) };
  }
}

module.exports = { hashPassword, verifyPassword, dummyHash, passwordProblem, token, sha256, safeEq, encrypt, decrypt,
  newTotpSecret, totpAt, totpVerify, Limiter };
