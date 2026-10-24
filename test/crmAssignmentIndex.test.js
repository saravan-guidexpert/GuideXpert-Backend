'use strict';

const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const {
  INDEX_NAME,
  assertCliAllowed,
  ensureCrmAssignmentIndex,
} = require('../scripts/ensureCrmAssignmentIndex');

const COLLECTION = 'crmConsultancyAssignments';

function id() {
  return new mongoose.Types.ObjectId();
}

describe('CRM assignment index procedure', { timeout: 180000, concurrency: 1 }, () => {
  let mongo;

  before(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    await mongoose.connect(mongo.getUri(), { dbName: 'crm_assignment_index_test', autoIndex: false });
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

  test('creates the partial unique index and leaves a second run unchanged', async () => {
    const consultancyId = id();
    const crmUserId = id();
    await collection().insertOne({ consultancyId, crmUserId, revokedAt: null });

    const created = await ensureCrmAssignmentIndex(mongoose.connection.db);
    assert.equal(created.created, true);
    const stored = await indexRecord();
    assert.deepEqual(stored.key, { consultancyId: 1, crmUserId: 1 });
    assert.equal(stored.unique, true);
    assert.deepEqual(stored.partialFilterExpression, { revokedAt: null });

    const namesBefore = (await collection().indexes()).map((index) => index.name).sort();
    const again = await ensureCrmAssignmentIndex(mongoose.connection.db);
    assert.equal(again.created, false);
    const namesAfter = (await collection().indexes()).map((index) => index.name).sort();
    assert.deepEqual(namesAfter, namesBefore);
  });

  test('aborts when an active pair is duplicated and creates no index', async () => {
    const consultancyId = id();
    const crmUserId = id();
    await collection().insertMany([
      { consultancyId, crmUserId, revokedAt: null },
      { consultancyId, crmUserId, revokedAt: null },
    ]);

    await assert.rejects(
      () => ensureCrmAssignmentIndex(mongoose.connection.db),
      (err) => err.code === 'duplicate_active_assignments' && err.pairCount === 1 && err.assignmentIds.length === 2
    );
    assert.equal(await indexRecord(), null);
  });

  test('allows two revoked rows beside one active row', async () => {
    const consultancyId = id();
    const crmUserId = id();
    await collection().insertMany([
      { consultancyId, crmUserId, revokedAt: new Date('2026-01-01T00:00:00Z') },
      { consultancyId, crmUserId, revokedAt: new Date('2026-02-01T00:00:00Z') },
      { consultancyId, crmUserId, revokedAt: null },
    ]);

    const created = await ensureCrmAssignmentIndex(mongoose.connection.db);
    assert.equal(created.created, true);
    const stored = await indexRecord();
    assert.equal(stored.unique, true);
    assert.deepEqual(stored.partialFilterExpression, { revokedAt: null });
  });

  test('leaves a mismatched same-key index untouched', async () => {
    await collection().createIndex(
      { consultancyId: 1, crmUserId: 1 },
      { name: INDEX_NAME, unique: false }
    );
    const before = await indexRecord();

    await assert.rejects(
      () => ensureCrmAssignmentIndex(mongoose.connection.db),
      (err) => err.code === 'index_mismatch'
    );
    const after = await indexRecord();
    assert.deepEqual(after.key, before.key);
    assert.equal(after.unique, undefined);
    assert.equal(after.partialFilterExpression, undefined);
  });

  test('the command refuses to run without approval or a matching database name', () => {
    const uri = 'mongodb://127.0.0.1:27017/crm_assignment_index_test?retryWrites=true';
    assert.throws(
      () => assertCliAllowed({ MONGODB_URI: uri }, ['--database', 'crm_assignment_index_test']),
      (err) => err.code === 'apply_not_confirmed'
    );
    assert.throws(
      () => assertCliAllowed({ CRM_ASSIGNMENT_INDEX_APPLY: '1', MONGODB_URI: uri }, ['--database', 'other_db']),
      (err) => err.code === 'database_mismatch'
    );
    assert.deepEqual(
      assertCliAllowed(
        { CRM_ASSIGNMENT_INDEX_APPLY: '1', MONGODB_URI: 'mongodb+srv://cluster.example.net/crm_assignment_index_test' },
        ['--database', 'crm_assignment_index_test']
      ),
      { database: 'crm_assignment_index_test' }
    );
  });
});
