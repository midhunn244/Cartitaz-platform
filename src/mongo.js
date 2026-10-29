
'use strict';

const { MongoClient } = require('mongodb');

let client;
let database;
let connecting;

async function connect() {
  if (database) return database;
  if (connecting) return connecting;

  connecting = (async () => {
    const uri = process.env.MONGODB_URI;

    if (!uri) {
      throw new Error('MONGODB_URI environment variable is not set');
    }

    const nextClient = new MongoClient(uri, {
      serverSelectionTimeoutMS: 10000,
    });

    try {
      await nextClient.connect();

      const db = nextClient.db(
        process.env.MONGODB_DB_NAME || 'cartitaz'
      );

      await db.command({ ping: 1 });

      await Promise.all([
        db.collection('admins').createIndex(
          { username: 1 },
          { unique: true }
        ),
        db.collection('sessions').createIndex(
          { id: 1 },
          { unique: true }
        ),
        db.collection('sessions').createIndex(
          { expires_at: 1 },
          { expireAfterSeconds: 0 }
        ),
        db.collection('products').createIndex(
          { slug: 1 },
          { unique: true, sparse: true }
        ),
        db.collection('categories').createIndex(
          { slug: 1 },
          { unique: true, sparse: true }
        ),
        db.collection('orders').createIndex(
          { code: 1 },
          { unique: true }
        ),
        db.collection('orders').createIndex(
          { created_at: -1 }
        ),
      ]);

      client = nextClient;
      database = db;

      console.log('[mongo] MongoDB connected; indexes ready.');

      return database;
    } catch (error) {
      await nextClient.close().catch(() => {});
      throw error;
    }
  })();

  try {
    return await connecting;
  } finally {
    connecting = undefined;
  }
}

async function close() {
  const currentClient = client;

  client = undefined;
  database = undefined;

  if (currentClient) {
    await currentClient.close();
  }
}

module.exports = { connect, close };
