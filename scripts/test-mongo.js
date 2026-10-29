
'use strict';

const { connect, close } = require('../src/mongo');

async function main() {
  try {
    const db = await connect();
    await db.command({ ping: 1 });
    console.log('SUCCESS: MongoDB Atlas connection works.');
  } catch (error) {
    console.error('FAILED: MongoDB connection could not be verified.');
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await close();
  }
}

main();
