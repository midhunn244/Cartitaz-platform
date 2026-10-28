'use strict';
// Create the first administrator (or reset a password) directly on the server. No default account exists.
//   npm run create-admin                      -> interactive (password is not echoed)
//   npm run create-admin -- --username owner --name "Store Owner" --role owner --password-stdin   (reads one line from stdin)
//   npm run create-admin -- --reset owner     -> set a new password for an existing admin (also unlocks it)
//   npm run create-admin -- --disable-2fa owner -> remove two-factor (lost phone AND lost recovery codes), then sign in and enable it again
const readline = require('readline');
const { load } = require('../src/config');
const { open } = require('../src/db');
const sec = require('../src/security');

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : undefined; };
const flag = (n) => args.includes('--' + n);

function ask(q, hidden) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
    if (hidden && process.stdin.isTTY) {
      rl._writeToOutput = (s) => { if (s.includes(q)) process.stdout.write(s); else if (s.includes('\n') || s.includes('\r')) process.stdout.write('\n'); };
    }
    rl.question(q, (a) => { rl.close(); resolve(a); });
  });
}
async function readStdinLine() {
  const rl = readline.createInterface({ input: process.stdin });
  return new Promise((res) => { rl.once('line', (l) => { res(l); rl.close(); }); rl.once('close', () => res('')); });
}

(async () => {
  const off = opt('disable-2fa');
  if (off) {
    const c0 = load({ ...process.env, NODE_ENV: process.env.NODE_ENV || 'development' }), d0 = open(c0.dataDir), u = d0.get('SELECT * FROM admins WHERE username=?', off);
    if (!u) { console.error('No such administrator.'); process.exit(1); }
    d0.run('UPDATE admins SET totp_enabled=0, totp_secret=NULL, totp_last=0 WHERE id=?', u.id); d0.run('DELETE FROM recovery_codes WHERE admin_id=?', u.id); d0.run('DELETE FROM sessions WHERE admin_id=?', u.id);
    d0.run("INSERT INTO audit(ts,username,action,entity,entity_id,ip) VALUES(?,?,?,?,?,?)", Date.now(), 'cli', '2fa.disabled_cli', 'admin', String(u.id), 'local');
    console.log(`Two-factor removed for "${off}". Sign in with the password and set it up again straight away.`); d0.close(); return;
  }
  const cfg = load({ ...process.env, NODE_ENV: process.env.NODE_ENV || 'development' });
  const db = open(cfg.dataDir);
  const reset = opt('reset');
  let username = reset || opt('username') || (await ask('Username: ')).trim();
  const existing = db.get('SELECT * FROM admins WHERE username=?', username);
  if (reset && !existing) { console.error('No such administrator.'); process.exit(1); }
  if (!reset && existing) { console.error('That username already exists. Use --reset to change its password.'); process.exit(1); }
  if (!reset && !/^[a-zA-Z0-9._-]{3,40}$/.test(username)) { console.error('Username must be 3-40 letters, numbers, . _ -'); process.exit(1); }
  const name = reset ? existing.name : (opt('name') || (await ask('Display name: ')).trim() || username);
  let role = reset ? existing.role : (opt('role') || (db.get('SELECT 1 x FROM admins') ? 'manager' : 'owner'));
  if (!['owner', 'manager', 'support'].includes(role)) { console.error('Role must be owner, manager or support.'); process.exit(1); }
  let pw;
  if (flag('password-stdin')) pw = (await readStdinLine()).replace(/\r?\n$/, '');
  else {
    pw = await ask('Password (min 12 characters): ', true);
    const again = await ask('Repeat password: ', true);
    if (pw !== again) { console.error('Passwords do not match.'); process.exit(1); }
  }
  const prob = sec.passwordProblem(pw, username);
  if (prob) { console.error('Password rejected: ' + prob); process.exit(1); }
  const hash = await sec.hashPassword(pw);
  const t = Date.now();
  if (reset) {
    db.run('UPDATE admins SET pass_hash=?, failed=0, locked_until=0, must_change=0, disabled=0 WHERE id=?', hash, existing.id);
    db.run('DELETE FROM sessions WHERE admin_id=?', existing.id);
    db.run("INSERT INTO audit(ts,username,action,entity,entity_id,ip) VALUES(?,?,?,?,?,?)", t, 'cli', 'password.reset_cli', 'admin', String(existing.id), 'local');
    console.log(`Password reset for "${username}". All their sessions were signed out.`);
  } else {
    const r = db.run('INSERT INTO admins(username,name,role,pass_hash,created_at) VALUES(?,?,?,?,?)', username, name, role, hash, t);
    db.run("INSERT INTO audit(ts,username,action,entity,entity_id,detail,ip) VALUES(?,?,?,?,?,?,?)", t, 'cli', 'user.create_cli', 'admin', String(r.lastInsertRowid), JSON.stringify({ username, role }), 'local');
    console.log(`Administrator "${username}" created with role "${role}". Sign in at ${cfg.adminPath} and enable two-factor authentication under Security.`);
  }
  db.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
