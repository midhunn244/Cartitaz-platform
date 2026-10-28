'use strict';
// Optional: adds a few DRAFT sample products so you can try the dashboard. Nothing is published to customers.
const { load } = require('../src/config');
const { open } = require('../src/db');
const cfg = load({ ...process.env, NODE_ENV: process.env.NODE_ENV || 'development' });
const db = open(cfg.dataDir);
if (db.get('SELECT 1 x FROM products LIMIT 1')) { console.error('Products already exist. Nothing seeded.'); process.exit(1); }
const t = Date.now();
const cats = { Bags: 'Bags', Watches: 'Watches', Home: 'Home' };
const ids = {};
let sort = 1;
for (const [name, icon] of Object.entries(cats)) ids[name] = Number(db.run('INSERT INTO categories(name,sort,published,icon) VALUES(?,?,1,?)', name, sort++, icon).lastInsertRowid);
const items = [['Leather Tote', 'Bags', 96, 130, 55], ['Crossbody Bag', 'Bags', 74, 99, 40], ['Slim Watch', 'Watches', 89, null, 48], ['Ceramic Vase', 'Home', 42, 58, 18]];
for (const [name, cat, price, was, cost] of items) {
  db.run(`INSERT INTO products(name,category_id,caption,description,price,compare_price,cost_price,stock,icon,published,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,0,?,?)`, name, ids[cat], 'Sample product', 'Sample description. Replace with your own.', price, was, cost, 10, cats[cat], t, t);
}
console.log('Seeded 3 categories and 4 DRAFT products. Review them in the dashboard, then publish what you want.');
db.close();
