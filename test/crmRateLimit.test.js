'use strict';

process.env.NODE_ENV = 'test';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const CrmRateLimit = require('../models/CrmRateLimit');
const {
  consumeMemory,
  consumeMongo,
  consumeRateLimit,
  useSharedRateLimitStore,
} = require('../services/crm/crmRateLimit');

describe('CRM shared rate limit', { timeout: 180000 }, () => {
  let mongo;

  before(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    await mongoose.connect(mongo.getUri(), { dbName: 'crm_rate_limit_test' });
    await CrmRateLimit.syncIndexes();
  });

  after(async () => {
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
  });

  test('production selects MongoDB and other environments keep the memory fallback', async () => {
    assert.equal(useSharedRateLimitStore({ NODE_ENV: 'production' }), true);
    assert.equal(useSharedRateLimitStore({ NODE_ENV: 'test' }), false);
    assert.equal(useSharedRateLimitStore({ NODE_ENV: 'development' }), false);
    assert.equal(await consumeRateLimit('memory-only', 1, 1000, 1, { NODE_ENV: 'test' }), true);
    assert.equal(await consumeRateLimit('memory-only', 1, 1000, 2, { NODE_ENV: 'test' }), false);
  });

  test('two callers share one MongoDB key and a store error denies the attempt', async () => {
    const key = 'login:id:shared-user';
    const first = await consumeMongo(key, 2, 60_000, 1_000);
    const second = await consumeMongo(key, 2, 60_000, 1_100);
    const third = await consumeMongo(key, 2, 60_000, 1_200);
    assert.equal(first, true);
    assert.equal(second, true);
    assert.equal(third, false);
    const stored = await CrmRateLimit.findOne({ key }).lean();
    assert.equal(stored.count, 3);

    const heartbeatA = await consumeMongo('heartbeat:session-a', 1, 60_000, 5_000);
    const heartbeatB = await consumeMongo('heartbeat:session-b', 1, 60_000, 5_000);
    const heartbeatAAgain = await consumeMongo('heartbeat:session-a', 1, 60_000, 5_100);
    assert.equal(heartbeatA, true);
    assert.equal(heartbeatB, true);
    assert.equal(heartbeatAAgain, false);

    const original = CrmRateLimit.findOneAndUpdate;
    CrmRateLimit.findOneAndUpdate = async () => {
      throw new Error('database unavailable');
    };
    try {
      await assert.rejects(
        () => consumeMongo('login:ip:down', 5, 1000, 9_000),
        (err) => err.code === 'rate_limit_unavailable' && err.status === 503
      );
    } finally {
      CrmRateLimit.findOneAndUpdate = original;
    }
  });

  test('separate memory buckets do not share a key across instances', () => {
    const now = 20_000;
    assert.equal(consumeMemory('login:ip:10.0.0.8', 1, 1000, now), true);
    assert.equal(consumeMemory('login:ip:10.0.0.8', 1, 1000, now + 10), false);
    assert.equal(consumeMemory('login:ip:10.0.0.9', 1, 1000, now + 10), true);
  });
});
