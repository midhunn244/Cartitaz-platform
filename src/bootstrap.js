'use strict';
// Optional first-owner creation for hosts without shell access (e.g. Render free instances).
// Set BOOTSTRAP_ADMIN_USERNAME and BOOTSTRAP_ADMIN_PASSWORD as SECRET environment variables, deploy once, sign in,
// choose a new password when asked, then DELETE both variables. It only ever acts while NO administrator exists.
const sec = require('./security');

async function run(db, cfg, log = console) {
  const b = cfg.bootstrap || {};
  if (!b.username && !b.password) return { status: 'none' };
  if (!b.username || !b.password) { log.warn('[bootstrap] Both BOOTSTRAP_ADMIN_USERNAME and BOOTSTRAP_ADMIN_PASSWORD are required. Ignored.'); return { status: 'incomplete' }; }
  if (db.get('SELECT 1 x FROM admins LIMIT 1')) {
    log.warn('[bootstrap] An administrator already exists, so BOOTSTRAP_ADMIN_* is ignored. Delete these variables from your host settings.');
    return { status: 'ignored' };
  }
  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(b.username)) { log.error('[bootstrap] BOOTSTRAP_ADMIN_USERNAME must be 3-40 letters, numbers, . _ -'); return { status: 'invalid' }; }
  const prob = sec.passwordProblem(b.password, b.username);
  if (prob) { log.error('[bootstrap] Password rejected: ' + prob + '. No administrator was created.'); return { status: 'weak' }; }
  const hash = await sec.hashPassword(b.password), t = Date.now();
  const r = db.run("INSERT INTO admins(username,name,role,pass_hash,must_change,created_at) VALUES(?,?,'owner',?,1,?)", b.username, b.name || b.username, hash, t);
  db.run("INSERT INTO audit(ts,username,action,entity,entity_id,detail,ip) VALUES(?,?,?,?,?,?,?)", t, 'bootstrap', 'user.create_bootstrap', 'admin', String(r.lastInsertRowid), JSON.stringify({ username: b.username, role: 'owner' }), 'local');
  log.log(`[bootstrap] Owner "${b.username}" created. Sign in, choose a new password, then DELETE the BOOTSTRAP_ADMIN_* variables.`);
  return { status: 'created' };
}
module.exports = { run };
