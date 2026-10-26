/**
 * Add the CRM rate-limit unique index. This command does not drop indexes,
 * does not call syncIndexes(), does not update or delete rate-limit documents,
 * and does not read or write any other collection.
 *
 * It refuses to run until CRM_RATE_LIMIT_INDEX_APPLY=1 is set, and the
 * --database argument must equal the database name in MONGODB_URI.
 *
 *   CRM_RATE_LIMIT_INDEX_APPLY=1 node scripts/ensureCrmRateLimitIndex.js --database <name>
 *
 * Tests call ensureCrmRateLimitIndex(db) against an in-memory database.
 * Importing this file does not connect and does not load .env.
 */
const path = require('path');
const mongoose = require('mongoose');

const COLLECTION = 'crmRateLimits';
const INDEX_KEYS = { key: 1 };
const INDEX_NAME = 'key_1';

function databaseNameFromUri(uri) {
  const value = String(uri || '').trim();
  const match = value.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^/?]+)/i);
  return match ? decodeURIComponent(match[1]) : '';
}

function databaseArgument(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const index = args.indexOf('--database');
  if (index === -1) return '';
  return String(args[index + 1] || '').trim();
}

function assertCliAllowed(env, argv) {
  if (!env || env.CRM_RATE_LIMIT_INDEX_APPLY !== '1') {
    throw Object.assign(
      new Error('Refusing to run until CRM_RATE_LIMIT_INDEX_APPLY=1 is set.'),
      { code: 'apply_not_confirmed' }
    );
  }
  const database = databaseArgument(argv);
  const uriDatabase = databaseNameFromUri(env.MONGODB_URI);
  if (!database || !uriDatabase || database !== uriDatabase) {
    throw Object.assign(
      new Error('The --database argument must equal the database name in MONGODB_URI.'),
      { code: 'database_mismatch' }
    );
  }
  return { database };
}

function sameKey(key) {
  if (!key) return false;
  const names = Object.keys(key);
  return names.length === 1 && names[0] === 'key' && Number(key.key) === 1;
}

function isExpectedIndex(index) {
  return Boolean(index)
    && sameKey(index.key)
    && index.unique === true
    && index.partialFilterExpression == null;
}

async function listRateLimitIndexes(db) {
  const existing = await db.listCollections({ name: COLLECTION }).toArray();
  if (existing.length === 0) return [];
  return db.collection(COLLECTION).indexes();
}

async function ensureCrmRateLimitIndex(db) {
  const collection = db.collection(COLLECTION);
  const existingCollections = await db.listCollections({ name: COLLECTION }).toArray();
  if (existingCollections.length > 0) {
    const duplicates = await collection.aggregate([
      {
        $group: {
          _id: '$key',
          count: { $sum: 1 },
          ids: { $push: '$_id' },
        },
      },
      { $match: { count: { $gt: 1 } } },
    ]).toArray();
    if (duplicates.length > 0) {
      const ids = duplicates.flatMap((group) => (group.ids || []).map(String));
      const message = `Refusing to create the rate-limit index: ${duplicates.length} duplicated key group(s). Document ids: ${ids.join(', ')}`;
      console.error(message);
      throw Object.assign(new Error(message), {
        code: 'duplicate_rate_limit_keys',
        groupCount: duplicates.length,
        documentIds: ids,
      });
    }
  }

  const indexes = await listRateLimitIndexes(db);
  const named = indexes.find((index) => index.name === INDEX_NAME);
  if (named && !isExpectedIndex(named)) {
    const message = 'Refusing to change an existing rate-limit index named key_1 whose key, unique flag, or partial filter does not match.';
    console.error(message);
    throw Object.assign(new Error(message), { code: 'index_mismatch' });
  }
  const sameKeyIndexes = indexes.filter((index) => sameKey(index.key));
  const mismatched = sameKeyIndexes.filter((index) => !isExpectedIndex(index));
  if (mismatched.length > 0) {
    const message = 'Refusing to change an existing rate-limit index on { key: 1 } whose unique flag or partial filter does not match.';
    console.error(message);
    throw Object.assign(new Error(message), { code: 'index_mismatch' });
  }
  const already = sameKeyIndexes.find(isExpectedIndex);
  if (already) return { created: false, name: already.name };

  await collection.createIndex(INDEX_KEYS, { name: INDEX_NAME, unique: true });
  const confirmed = (await collection.indexes()).find((index) => index.name === INDEX_NAME);
  if (!isExpectedIndex(confirmed)) {
    throw Object.assign(
      new Error('The rate-limit index was not confirmed after creation.'),
      { code: 'index_not_confirmed' }
    );
  }
  return { created: true, name: INDEX_NAME };
}

async function main() {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const target = assertCliAllowed(process.env, process.argv.slice(2));
  await mongoose.connect(process.env.MONGODB_URI);
  try {
    if (mongoose.connection.db.databaseName !== target.database) {
      throw Object.assign(
        new Error('The connected database does not match --database.'),
        { code: 'database_mismatch' }
      );
    }
    const result = await ensureCrmRateLimitIndex(mongoose.connection.db);
    if (result.created) {
      console.log(`Created ${COLLECTION}.${result.name}.`);
    } else {
      console.log(`Rate-limit index already matches (${result.name}). No index was created or changed.`);
    }
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    const code = err && err.code ? err.code : 'rate_limit_index_failed';
    console.error(`Rate-limit index setup failed (${code}). No rate-limit document was changed.`);
    process.exit(1);
  });
}

module.exports = {
  INDEX_NAME,
  assertCliAllowed,
  databaseNameFromUri,
  ensureCrmRateLimitIndex,
};
