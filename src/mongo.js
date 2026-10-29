
'use strict';

const { MongoClient } = require('mongodb');

let client;
let database;

async function connect() {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    throw new Error('MONGODB_URI environment variable is not set');
  }

  if (database) {
    return database;
  }

  client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 10000,
  });

  await client.connect();

  database = client.db(process.env.MONGODB_DB_NAME || 'cartitaz');

  await database.command({ ping: 1 });

  console.log('Connected to MongoDB Atlas');

  return database;
}

async function close() {
  if (client) {
    await client.close();
    client = undefined;
    database = undefined;
  }
}

module.exports = { connect, close };
