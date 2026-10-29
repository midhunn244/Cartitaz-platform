
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

    client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 10000,
    });

    try {
      await client.connect();

      database = client.db(
        process.env.MONGODB_DB_NAME || 'cartitaz'
      );

      await database.command({ ping: 1 });

      // Indexes for frequently accessed records.
      await Promise.all([
        database.collection('admins').createIndex(
          { username: 1 },
          { unique: true }
        ),
        database.collection('sessions').createIndex(
          { id: 1 },
          { unique: true }
        ),
        database.collection('sessions').createIndex(
          { expires_at: 1 },
          { expireAfterSeconds: 0 }
        ),
        database.collection('products').createIndex(
          { slug: 1 },
          { unique: true }
        ),
        database.collection('categories').createIndex(
          { slug: 1 },
          { unique: true }
        ),
        database.collection('orders').createIndex(
          { code: 1 },
          { unique: true }
        ),
        database.collection('orders').createIndex(
          { created_at: -1 }
        ),
      ]);

      console.log('[mongo] MongoDB Atlas connected; indexes ready.');

      return database;
    } catch (error) {
      await client.close().catch(() => {});
      client = undefined;
      database = undefined;
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
  if (client) {
    const currentClient = client;
    client = undefined;
    database = undefined;
    await currentClient.close();
  }
}

module.exports = { connect, close };
