'use strict';

const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const CrmRateLimit = require('../models/CrmRateLimit');
const CrmConsultancyAssignment = require('../models/CrmConsultancyAssignment');
const {
  INDEX_NAME: ASSIGNMENT_INDEX_NAME,
} = require('../scripts/ensureCrmAssignmentIndex');
const {
  INDEX_NAME,
  assertCliAllowed,
  ensureCrmRateLimitIndex,
} = require('../scripts/ensureCrmRateLimitIndex');

const COLLECTION = 'crmRateLimits';

describe('CRM index declarations', () => {
  test('the rate-limit model and the assignment model match their procedures', () => {
    const rateIndexes = CrmRateLimit.schema.indexes();
    const rateIndex = rateIndexes.find(([spec]) => Object.keys(spec).length === 1 && spec.key === 1);
    assert.ok(rateIndex);
    assert.equal(rateIndex[1].unique, true);
    assert.equal(rateIndex[1].partialFilterExpression, undefined);
    assert.equal(INDEX_NAME, 'key_1');

    const assignmentIndexes = CrmConsultancyAssignment.schema.indexes();
    const assignmentIndex = assignmentIndexes.find(([spec]) => (
      spec.consultancyId === 1 && spec.crmUserId === 1 && Object.keys(spec).length === 2
    ));
    assert.ok(assignmentIndex);
    assert.equal(assignmentIndex[1].unique, true);
    assert.deepEqual(assignmentIndex[1].partialFilterExpression, { revokedAt: null });
    assert.equal(ASSIGNMENT_INDEX_NAME, 'consultancyId_1_crmUserId_1');

    const source = fs.readFileSync(path.join(__dirname, '../scripts/ensureCrmRateLimitIndex.js'), 'utf8');
    assert.equal(source.includes('syncIndexes'), true);
    assert.equal(source.includes('.syncIndexes('), false);
    assert.equal(source.includes('deleteMany'), false);
    assert.equal(source.includes('updateMany'), false);
  });
});

describe('CRM rate-limit index procedure', { timeout: 180000, concurrency: 1 }, () => {
  let mongo;

  before(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    await mongoose.connect(mongo.getUri(), { dbName: 'crm_rate_limit_index_test', autoIndex: false });
  });

  after(async () => {
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await mongoose.connection.db.collection(COLLECTION).drop().catch((err) => {
      if (err && err.codeName !== 'NamespaceNotFound') throw err;
    });
  });

  function collection() {
    return mongoose.connection.db.collection(COLLECTION);
  }

  async function indexRecord() {
    const found = await mongoose.connection.db.listCollections({ name: COLLECTION }).toArray();
    if (found.length === 0) return null;
    return (await collection().indexes()).find((index) => index.name === INDEX_NAME) || null;
  }

  test('creates the unique key index and leaves a second run unchanged', async () => {
    await collection().insertOne({ key: 'login:id:one', windowStart: new Date(), count: 1 });
    const created = await ensureCrmRateLimitIndex(mongoose.connection.db);
    assert.equal(created.created, true);
    assert.equal(created.name, INDEX_NAME);
    const stored = await indexRecord();
    assert.deepEqual(stored.key, { key: 1 });
    assert.equal(stored.unique, true);
    assert.equal(stored.partialFilterExpression, undefined);

    const namesBefore = (await collection().indexes()).map((index) => index.name).sort();
    const again = await ensureCrmRateLimitIndex(mongoose.connection.db);
    assert.equal(again.created, false);
    const namesAfter = (await collection().indexes()).map((index) => index.name).sort();
    assert.deepEqual(namesAfter, namesBefore);
    assert.equal(await collection().countDocuments(), 1);
  });

  test('aborts when a key is duplicated and does not change the documents', async () => {
    await collection().insertMany([
      { key: 'heartbeat:same', windowStart: new Date(), count: 1 },
      { key: 'heartbeat:same', windowStart: new Date(), count: 2 },
    ]);
    const before = await collection().find({}, { projection: { key: 0 } }).toArray();

    await assert.rejects(
      () => ensureCrmRateLimitIndex(mongoose.connection.db),
      (err) => err.code === 'duplicate_rate_limit_keys' && err.groupCount === 1 && err.documentIds.length === 2
    );
    assert.equal(await indexRecord(), null);
    const after = await collection().find({}, { projection: { key: 0 } }).toArray();
    assert.deepEqual(after, before);
  });

  test('leaves a non-unique or partial index on the same key untouched', async () => {
    await collection().insertOne({ key: 'login:ip:kept', windowStart: new Date(), count: 1 });
    await collection().createIndex({ key: 1 }, { name: INDEX_NAME, unique: false });
    const before = await indexRecord();

    await assert.rejects(
      () => ensureCrmRateLimitIndex(mongoose.connection.db),
      (err) => err.code === 'index_mismatch'
    );
    const after = await indexRecord();
    assert.deepEqual(after.key, before.key);
    assert.equal(after.unique, undefined);
    assert.equal(await collection().countDocuments(), 1);

    await collection().dropIndex(INDEX_NAME);
    await collection().createIndex(
      { key: 1 },
      { name: 'key_1_partial', unique: true, partialFilterExpression: { count: { $gt: 0 } } }
    );
    await assert.rejects(
      () => ensureCrmRateLimitIndex(mongoose.connection.db),
      (err) => err.code === 'index_mismatch'
    );
    const partial = (await collection().indexes()).find((index) => index.name === 'key_1_partial');
    assert.equal(partial.unique, true);
    assert.ok(partial.partialFilterExpression);
  });

  test('the command refuses to run without approval or a matching database name', () => {
    const uri = 'mongodb://127.0.0.1:27017/crm_rate_limit_index_test?retryWrites=true';
    assert.throws(
      () => assertCliAllowed({ MONGODB_URI: uri }, ['--database', 'crm_rate_limit_index_test']),
      (err) => err.code === 'apply_not_confirmed'
    );
    assert.throws(
      () => assertCliAllowed({ CRM_RATE_LIMIT_INDEX_APPLY: '1', MONGODB_URI: uri }, ['--database', 'other_db']),
      (err) => err.code === 'database_mismatch'
    );
    assert.deepEqual(
      assertCliAllowed(
        { CRM_RATE_LIMIT_INDEX_APPLY: '1', MONGODB_URI: 'mongodb+srv://cluster.example.net/crm_rate_limit_index_test' },
        ['--database', 'crm_rate_limit_index_test']
      ),
      { database: 'crm_rate_limit_index_test' }
    );
  });
});
