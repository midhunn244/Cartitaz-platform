
'use strict';

const http = require('http');
const { load } = require('./config');
const { createApp } = require('./app');
const bootstrap = require('./bootstrap');
const mongo = require('./mongo');

async function start(env = process.env) {
  const cfg = load(env);

  // Keep MongoDB connected while the server runs.
  await mongo.connect();
  console.log('[mongo] MongoDB Atlas connection verified.');

  const app = createApp(cfg);
  const server = http.createServer(app.handler);

  server.headersTimeout = 15000;
  server.requestTimeout = 30000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 60;

  bootstrap.run(app.db, cfg)
    .catch((e) => {
      console.error('[bootstrap] failed:', e.message);
    })
    .then(() => {
      server.listen(cfg.port, cfg.host, () => {
        console.log(
          `Cartitaz running on http://${cfg.host}:${cfg.port} ` +
          `(admin: ${cfg.adminPath}, env: ${cfg.prod ? 'production' : 'development'})`
        );

        if (!app.db.get('SELECT 1 x FROM admins LIMIT 1')) {
          console.log(
            'No administrator exists yet. Create one with: npm run create-admin'
          );
        }
      });
    });

  const stop = () => {
    server.close(async () => {
      try {
        app.close();
      } finally {
        await mongo.close();
        process.exit(0);
      }
    });
  };

  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  return { server, app, cfg };
}

if (require.main === module) {
  start().catch((e) => {
    console.error('[startup] failed:', e.message);
    process.exitCode = 1;
  });
}

module.exports = { start };
