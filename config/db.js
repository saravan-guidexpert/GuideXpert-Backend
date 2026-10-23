const mongoose = require('mongoose');
require('./mongooseSafety');
const { createConnectionGate } = require('../utils/mongoConnectionGate');
const {
  redactSensitiveText,
  retryTransient,
} = require('../utils/mongoRetry');

const ATLAS_WHITELIST_MSG = `
--- MongoDB Atlas: fix connection ---
Your IP is not allowed. In Atlas:
1. Open https://cloud.mongodb.com → your project → Network Access
2. Click "Add IP Address"
3. Add your current IP, or use 0.0.0.0/0 to allow from anywhere (dev only)
4. Save and wait ~1 minute, then restart the server
---`;

/**
 * Driver 7 defaults maxPoolSize to 100 and never closes idle sockets.
 * Each warm Vercel isolate would otherwise hold that pool, plus a monitor
 * connection per replica member, against the M10 connection cap (1500).
 * One request needs only a couple of sockets (analytics is one $facet plus
 * one count). 10 leaves room for overlapping requests on the same isolate.
 *
 * socketTimeoutMS stays at 45s, which is what produces
 * "connection <id> to <host>:<port> timed out" when a command sends no bytes
 * for that long. Analytics queries set maxTimeMS (20s) so MongoDB aborts them
 * before this socket timer destroys the connection.
 *
 * bufferTimeoutMS must be greater than serverSelectionTimeoutMS. Mongoose
 * otherwise fails a buffered command at 10s while the driver is still
 * selecting a primary.
 */
const MONGO_DRIVER_OPTIONS = Object.freeze({
  maxPoolSize: 10,
  minPoolSize: 0,
  maxIdleTimeMS: 30_000,
  serverSelectionTimeoutMS: 12_000,
  socketTimeoutMS: 45_000,
  connectTimeoutMS: 15_000,
  waitQueueTimeoutMS: 10_000,
  bufferTimeoutMS: 20_000,
});

let listenersInstalled = false;

function installConnectionListeners() {
  if (listenersInstalled) return;
  listenersInstalled = true;
  mongoose.connection.on('disconnected', () => {
    console.warn('[db] MongoDB disconnected — next request reuses this client until it recovers');
  });
  mongoose.connection.on('error', (err) => {
    console.error('[db] MongoDB connection error:', redactSensitiveText(err?.message || err));
  });
  mongoose.connection.on('reconnected', () => {
    console.log('[db] MongoDB reconnected');
  });
}

function resolveMongoUri() {
  let uri = process.env.MONGODB_URI;
  if (!uri || !uri.trim()) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('MONGODB_URI is not defined. Add it to .env (see .env.example).');
    }
    uri = 'mongodb://localhost:27017/guidexpert';
    console.warn('[db] MONGODB_URI not set — using dev default:', uri);
  }
  return uri;
}

function isWhitelistError(error) {
  const message = String(error?.message || '');
  return message.includes('whitelist') || message.includes('Could not connect to any servers');
}

async function connectOnce(uri) {
  const isAtlas = uri.includes('mongodb.net');
  const options = { ...MONGO_DRIVER_OPTIONS };
  try {
    console.log('Attempting to connect to MongoDB...');
    await mongoose.connect(uri, options);
    console.log(`✓ MongoDB Connected: ${mongoose.connection.host}`);
    console.log(`✓ Database: ${mongoose.connection.name}`);
    return mongoose.connection;
  } catch (error) {
    if (isAtlas && isWhitelistError(error)) {
      console.error('MongoDB connection error: IP not whitelisted in Atlas.');
      console.error(ATLAS_WHITELIST_MSG);
    } else {
      console.error('MongoDB connection error:', redactSensitiveText(error?.message || error));
    }

    const fallbackUri = process.env.MONGODB_URI_FALLBACK;
    if (
      isAtlas &&
      isWhitelistError(error) &&
      fallbackUri &&
      fallbackUri !== uri &&
      !fallbackUri.includes('mongodb.net')
    ) {
      console.log('Trying fallback MongoDB URI...');
      try {
        await mongoose.connect(fallbackUri, { ...MONGO_DRIVER_OPTIONS });
        console.log(`✓ MongoDB Connected (fallback): ${mongoose.connection.host}`);
        return mongoose.connection;
      } catch (fallbackErr) {
        console.error('Fallback MongoDB failed:', redactSensitiveText(fallbackErr?.message || fallbackErr));
      }
    }

    throw error;
  }
}

async function openMongo() {
  const uri = resolveMongoUri();
  return retryTransient(
    async (attempt) => {
      if (attempt > 1 && mongoose.connection.client) {
        try {
          await mongoose.connection.close();
        } catch (err) {
          console.error('[db] failed to close client before connect retry:', redactSensitiveText(err?.message || err));
        }
      }
      return connectOnce(uri);
    },
    { attempts: 2, baseDelayMs: 400, maxDelayMs: 800, idempotent: true }
  );
}

const gate = createConnectionGate({
  getReadyState: () => mongoose.connection.readyState,
  hasClient: () => mongoose.connection.client != null,
  recoverTimeoutMs: MONGO_DRIVER_OPTIONS.serverSelectionTimeoutMS,
  connect: openMongo,
  closeExisting: async () => {
    try {
      await mongoose.connection.close();
    } catch (err) {
      console.error('[db] failed to close stale client before reconnect:', redactSensitiveText(err?.message || err));
    }
  },
});

/**
 * Cached connect for serverless and the local server.
 * Concurrent callers share one attempt. An existing driver client is given
 * serverSelectionTimeoutMS to recover (election or a thawed isolate) before
 * it is closed and replaced. Replacing it immediately leaks pools: Mongoose
 * 9 createClient assigns a new MongoClient without closing the previous one,
 * and openUri() does not wait when readyState is already "connecting".
 */
async function connectDB() {
  installConnectionListeners();
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  await gate.ensure();
  if (mongoose.connection.readyState !== 1) {
    const err = new Error('MongoDB connection is not ready');
    err.name = 'MongoServerSelectionError';
    throw err;
  }
  return mongoose.connection;
}

module.exports = connectDB;
module.exports.ensureDbConnected = connectDB;
module.exports.MONGO_DRIVER_OPTIONS = MONGO_DRIVER_OPTIONS;
