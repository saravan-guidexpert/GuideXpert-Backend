/**
 * Add missing Consultancy CRM indexes. This command does not drop indexes.
 *
 * config/mongooseSafety.js turns autoIndex off for every remote MongoDB URI, so
 * deploying these models does not create indexes in Atlas. Run this script only
 * against an isolated local or test database, after duplicate preflight counts
 * for student phone, referral crmStudentId, active consultancy name, and
 * active contact phone are all zero.
 *
 * Automated check (in-memory, no .env database):
 *   node --test --test-concurrency=1 test/crmPhase1.test.js
 *
 * Additive local check:
 *   MONGODB_URI="mongodb://127.0.0.1:27017/crm_index_test" node scripts/syncCrmIndexes.js
 *
 * The script refuses NODE_ENV=production and every non-local URI.
 * ALLOW_CRM_INDEX_SYNC does not permit a remote database.
 *
 * syncCrmIndexes() still calls Model.syncIndexes(), which drops indexes that
 * are not declared on the schema. The in-memory test uses that function.
 * The command-line entry point calls ensureCrmIndexes() instead.
 */
const path = require('path');
const mongoose = require('mongoose');

const LOCAL_HOST_PATTERN = /(^|\/\/|@)(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i;

function isLocalMongoUri(uri) {
  return LOCAL_HOST_PATTERN.test(String(uri || ''));
}

function assertSafeIndexTarget(uri, env = process.env) {
  if ((env.NODE_ENV || '') === 'production') {
    throw new Error('Refusing CRM index sync when NODE_ENV is production.');
  }
  if (!isLocalMongoUri(uri)) {
    throw new Error(
      'Refusing CRM index sync for a non-local database. This script only accepts a local MongoDB URI.'
    );
  }
}

function crmModels() {
  return [
    require('../models/CrmConsultancy'),
    require('../models/CrmConsultancyContact'),
    require('../models/CrmConsultancyRemark'),
    require('../models/CrmConsultancyFollowUp'),
    require('../models/CrmStudent'),
    require('../models/CrmReferral'),
    require('../models/CrmAuditLog'),
    require('../models/CrmUser'),
    require('../models/CrmSession'),
    require('../models/CrmPasswordReset'),
    require('../models/CrmAuthAuditLog'),
    require('../models/CrmConsultancyAssignment'),
    require('../models/CrmRateLimit'),
  ];
}

async function syncCrmIndexes() {
  for (const Model of crmModels()) {
    await Model.syncIndexes();
  }
}

async function ensureCrmIndexes() {
  const created = [];
  for (const Model of crmModels()) {
    const collectionName = Model.collection.collectionName;
    const existing = await Model.db.db.listCollections({ name: collectionName }).toArray();
    const beforeNames = new Set();
    if (existing.length > 0) {
      const current = await Model.collection.indexes();
      current.forEach((index) => beforeNames.add(index.name));
    }
    await Model.createIndexes();
    const after = await Model.collection.indexes();
    after.forEach((index) => {
      if (!beforeNames.has(index.name)) {
        created.push({ collection: collectionName, name: index.name, key: index.key });
      }
    });
  }
  return created;
}

async function main() {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const uri = process.env.MONGODB_URI || '';
  assertSafeIndexTarget(uri);
  await mongoose.connect(uri);
  const created = await ensureCrmIndexes();
  if (created.length === 0) {
    console.log('CRM indexes already present. No index was created or dropped.');
  } else {
    created.forEach((index) => {
      console.log(`Created ${index.collection}.${index.name} ${JSON.stringify(index.key)}`);
    });
  }
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.message ? err.message : 'CRM index sync failed.');
    process.exit(1);
  });
}

module.exports = {
  syncCrmIndexes,
  ensureCrmIndexes,
  assertSafeIndexTarget,
  isLocalMongoUri,
};
