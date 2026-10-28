'use strict';
const path = require('path');
const crypto = require('crypto');

function load(env = process.env) {
  const prod = env.NODE_ENV === 'production';
  const adminPath = (env.ADMIN_PATH || '/control-center').replace(/\/+$/, '');
  if (!/^\/[a-z0-9][a-z0-9_\-/]{2,60}$/i.test(adminPath) || /^\/(api|media|assets|healthz)(\/|$)/i.test(adminPath)) {
    throw new Error('ADMIN_PATH is invalid or reserved');
  }
  let appSecret = env.APP_SECRET || '';
  if (prod && appSecret.length < 32) {
    throw new Error('APP_SECRET (>= 32 characters) is required when NODE_ENV=production');
  }
  if (!appSecret) {
    appSecret = crypto.randomBytes(32).toString('base64url');
    console.warn('[warn] APP_SECRET not set: using a temporary secret. Two-factor secrets will not survive a restart.');
  }
  return {
    prod,
    port: Number(env.PORT) || 3000,
    host: env.HOST || '0.0.0.0',
    dataDir: path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data')),
    adminPath,
    trustProxy: env.TRUST_PROXY === '1',
    appSecret,
    cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === '1' : prod,
    publicOrigin: (env.PUBLIC_ORIGIN || '').replace(/\/+$/, ''),
    bootstrap: { username: env.BOOTSTRAP_ADMIN_USERNAME || '', password: env.BOOTSTRAP_ADMIN_PASSWORD || '', name: env.BOOTSTRAP_ADMIN_NAME || '' },
    sessionIdleMs: 30 * 60 * 1000,
    sessionMaxMs: 12 * 60 * 60 * 1000,
  };
}
module.exports = { load };
