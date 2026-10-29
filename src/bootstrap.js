'use strict';

// Optional first-owner creation for hosts without shell access (e.g. Render).
// Set BOOTSTRAP_ADMIN_USERNAME and BOOTSTRAP_ADMIN_PASSWORD as secret
// environment variables, deploy once, sign in, then remove both variables.

const sec = require('./security');

async function run(db, cfg, log = console) {
const b = cfg.bootstrap || {};

if (!b.username && !b.password) return { status: 'none' };

if (!b.username || !b.password) {
log.warn('[bootstrap] Both BOOTSTRAP_ADMIN_USERNAME and BOOTSTRAP_ADMIN_PASSWORD are required. Ignored.');
return { status: 'incomplete' };
}

if (!/^[a-zA-Z0-9._-]{3,40}$/.test(b.username)) {
log.error('[bootstrap] BOOTSTRAP_ADMIN_USERNAME must be 3-40 letters, numbers, . _ -');
return { status: 'invalid' };
}

const prob = sec.passwordProblem(b.password, b.username);
if (prob) {
log.error('[bootstrap] Password rejected: ' + prob + '. No administrator was created.');
return { status: 'weak' };
}

const admins = db.collection('admins');
const audit = db.collection('audit');

if (await admins.findOne({}, { projection: { id: 1 } })) {
log.warn('[bootstrap] An administrator already exists, so BOOTSTRAP_ADMIN* is ignored. Delete these variables from your host settings.');
return { status: 'ignored' };
}

const t = Date.now();
const hash = await sec.hashPassword(b.password);

try {
const result = await admins.insertOne({
username: b.username,
name: b.name || b.username,
role: 'owner',
pass_hash: hash,
must_change: 1,
created_at: t
});

await audit.insertOne({
  ts: t,
  username: 'bootstrap',
  action: 'user.create_bootstrap',
  entity: 'admin',
  entity_id: String(result.insertedId),
  detail: JSON.stringify({ username: b.username, role: 'owner' }),
  ip: 'local'
});

log.log(`[bootstrap] Owner "${b.username}" created. Sign in, choose a new password, then DELETE the BOOTSTRAP_ADMIN_* variables.`);
return { status: 'created' };

} catch (error) {
// If two startup attempts race, never create a second owner.
if (error.code === 11000) {
log.warn('[bootstrap] An administrator already exists. Bootstrap was skipped.');
return { status: 'ignored' };
}
throw error;
}
}

module.exports = { run };
