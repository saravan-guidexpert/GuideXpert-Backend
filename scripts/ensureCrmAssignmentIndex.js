/**
 * Add the active CRM consultancy-assignment unique index. This command does not
 * drop indexes, does not call syncIndexes(), and does not read or write any
 * other collection.
 *
 * It refuses to run until CRM_ASSIGNMENT_INDEX_APPLY=1 is set, and the
 * --database argument must equal the database name in MONGODB_URI.
 *
 *   CRM_ASSIGNMENT_INDEX_APPLY=1 node scripts/ensureCrmAssignmentIndex.js --database <name>
 *
 * Tests call ensureCrmAssignmentIndex(db) against an in-memory database.
 * Importing this file does not connect and does not load .env.
 */
const path = require('path');
const mongoose = require('mongoose');

const COLLECTION = 'crmConsultancyAssignments';
const INDEX_KEYS = { consultancyId: 1, crmUserId: 1 };
const INDEX_NAME = 'consultancyId_1_crmUserId_1';
const PARTIAL_FILTER = { revokedAt: null };

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
  if (!env || env.CRM_ASSIGNMENT_INDEX_APPLY !== '1') {
    throw Object.assign(
      new Error('Refusing to run until CRM_ASSIGNMENT_INDEX_APPLY=1 is set.'),
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
  return names.length === 2
    && names[0] === 'consultancyId'
    && names[1] === 'crmUserId'
    && Number(key.consultancyId) === 1
    && Number(key.crmUserId) === 1;
}

function samePartial(filter) {
  if (!filter || typeof filter !== 'object') return false;
  const names = Object.keys(filter);
  return names.length === 1 && names[0] === 'revokedAt' && filter.revokedAt === null;
}

function isExpectedIndex(index) {
  return Boolean(index) && sameKey(index.key) && index.unique === true && samePartial(index.partialFilterExpression);
}

async function listAssignmentIndexes(db) {
  const existing = await db.listCollections({ name: COLLECTION }).toArray();
  if (existing.length === 0) return [];
  return db.collection(COLLECTION).indexes();
}

async function ensureCrmAssignmentIndex(db) {
  const collection = db.collection(COLLECTION);
  const duplicates = await collection.aggregate([
    { $match: { revokedAt: null } },
    {
      $group: {
        _id: { consultancyId: '$consultancyId', crmUserId: '$crmUserId' },
        count: { $sum: 1 },
        ids: { $push: '$_id' },
      },
    },
    { $match: { count: { $gt: 1 } } },
  ]).toArray();

  if (duplicates.length > 0) {
    const ids = duplicates.flatMap((pair) => (pair.ids || []).map(String));
    const message = `Refusing to create the assignment index: ${duplicates.length} duplicated active pair(s). Assignment ids: ${ids.join(', ')}`;
    console.error(message);
    throw Object.assign(new Error(message), {
      code: 'duplicate_active_assignments',
      pairCount: duplicates.length,
      assignmentIds: ids,
    });
  }

  const indexes = await listAssignmentIndexes(db);
  const sameKeyIndexes = indexes.filter((index) => sameKey(index.key));
  const mismatched = sameKeyIndexes.filter((index) => !isExpectedIndex(index));
  if (mismatched.length > 0) {
    const message = 'Refusing to change an existing assignment index whose unique flag or partial filter does not match.';
    console.error(message);
    throw Object.assign(new Error(message), { code: 'index_mismatch' });
  }
  if (sameKeyIndexes.some(isExpectedIndex)) {
    return { created: false, name: INDEX_NAME };
  }

  await collection.createIndex(INDEX_KEYS, {
    name: INDEX_NAME,
    unique: true,
    partialFilterExpression: PARTIAL_FILTER,
  });
  const confirmed = (await collection.indexes()).find((index) => index.name === INDEX_NAME);
  if (!isExpectedIndex(confirmed)) {
    throw Object.assign(
      new Error('The assignment index was not confirmed after creation.'),
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
    const result = await ensureCrmAssignmentIndex(mongoose.connection.db);
    if (result.created) {
      console.log(`Created ${COLLECTION}.${INDEX_NAME}.`);
    } else {
      console.log('Assignment index already matches. No index was created or changed.');
    }
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.message ? err.message : 'Assignment index setup failed.');
    process.exit(1);
  });
}

module.exports = {
  INDEX_NAME,
  assertCliAllowed,
  databaseNameFromUri,
  ensureCrmAssignmentIndex,
};
