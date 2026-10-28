'use strict';
// Consistent online backup of the database (safe while the server is running).
//   npm run backup -- /path/to/backups/cartitaz-2025-01-31.db
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { load } = require('../src/config');

const out = process.argv[2];
if (!out) { console.error('Usage: npm run backup -- <output-file.db>'); process.exit(1); }
const cfg = load({ ...process.env, NODE_ENV: process.env.NODE_ENV || 'development' });
const target = path.resolve(out);
if (fs.existsSync(target)) { console.error('Refusing to overwrite an existing file: ' + target); process.exit(1); }
fs.mkdirSync(path.dirname(target), { recursive: true });
const db = new DatabaseSync(path.join(cfg.dataDir, 'cartitaz.db'));
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
db.close();
fs.chmodSync(target, 0o600);
console.log('Backup written to ' + target + '. It contains customer data: store it encrypted and access-controlled.');
