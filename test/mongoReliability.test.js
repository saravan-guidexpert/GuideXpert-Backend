'use strict';

const fs = require('fs');
const path = require('path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { createConnectionGate } = require('../utils/mongoConnectionGate');
const {
  isTransientMongoError,
  retryTransient,
  cronFailurePayload,
  analyticsFailurePayload,
  publicClientMessage,
  safeErrorSummary,
} = require('../utils/mongoRetry');
const { MONGO_DRIVER_OPTIONS } = require('../config/db');
const { ANALYTICS_MAX_TIME_MS } = require('../utils/iitCounsellingVisitAnalytics');

function transientNotPrimary() {
  const error = new Error('not primary and secondaryOk=false');
  error.name = 'MongoServerError';
  error.code = 13435;
  return error;
}

describe('transient MongoDB errors', () => {
  test('recognizes not-primary, socket timeout, and selection timeout', () => {
    assert.equal(isTransientMongoError(transientNotPrimary()), true);

    const timeout = new Error('connection 4 to 159.41.252.70:27017 timed out');
    timeout.name = 'MongoNetworkTimeoutError';
    assert.equal(isTransientMongoError(timeout), true);

    const selection = new Error('Server selection timed out after 12000 ms');
    selection.name = 'MongoServerSelectionError';
    assert.equal(isTransientMongoError(selection), true);

    const wrapped = new Error('wrapped');
    wrapped.cause = timeout;
    assert.equal(isTransientMongoError(wrapped), true);
  });

  test('does not treat BSON limit, maxTimeMS, or auth failures as retryable', () => {
    const bson = new Error('BSON size limit hit while building Message');
    bson.name = 'MongoServerError';
    bson.code = 10334;
    assert.equal(isTransientMongoError(bson), false);

    const slow = new Error('operation exceeded time limit');
    slow.name = 'MongoServerError';
    slow.code = 50;
    assert.equal(isTransientMongoError(slow), false);

    const auth = new Error('Authentication failed');
    auth.name = 'MongoServerError';
    auth.code = 18;
    assert.equal(isTransientMongoError(auth), false);
  });

  test('retries an idempotent read and stops on a BSON error', async () => {
    const sleeps = [];
    let attempts = 0;
    const value = await retryTransient(async () => {
      attempts += 1;
      if (attempts === 1) throw transientNotPrimary();
      return 'ok';
    }, {
      idempotent: true,
      attempts: 3,
      baseDelayMs: 25,
      maxDelayMs: 100,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    assert.equal(value, 'ok');
    assert.equal(attempts, 2);
    assert.deepEqual(sleeps, [25]);

    let bsonAttempts = 0;
    await assert.rejects(() => retryTransient(async () => {
      bsonAttempts += 1;
      const error = new Error('BSON size limit hit while building Message');
      error.name = 'MongoServerError';
      error.code = 10334;
      throw error;
    }, { idempotent: true, attempts: 3, sleep: async () => {} }));
    assert.equal(bsonAttempts, 1);
  });

  test('refuses to retry a side effect that has not opted in', async () => {
    let sends = 0;
    await assert.rejects(
      () => retryTransient(async () => {
        sends += 1;
        throw transientNotPrimary();
      }, { attempts: 3 }),
      /non-idempotent/
    );
    assert.equal(sends, 0);
  });
});

describe('database failure responses', () => {
  test('cron and analytics failures hide hosts, URIs, and phone numbers', () => {
    const timeout = new Error('connection 4 to 159.41.252.70:27017 timed out');
    timeout.name = 'MongoNetworkTimeoutError';
    const cronTimeout = cronFailurePayload(timeout);
    assert.equal(cronTimeout.status, 503);
    assert.equal(cronTimeout.body.success, false);
    assert.equal(cronTimeout.body.data, undefined);
    assert.equal(JSON.stringify(cronTimeout).includes('159.41'), false);
    assert.equal(JSON.stringify(cronTimeout).includes('27017'), false);
    const summary = safeErrorSummary(timeout);
    assert.match(summary, /MongoNetworkTimeoutError/);
    assert.equal(summary.includes('159.41'), false);

    const leaked = new Error('connect mongodb+srv://appuser:s3cret@cluster.mongodb.net/guidexpert failed for 9876543210');
    const cronLeaked = cronFailurePayload(leaked);
    assert.equal(cronLeaked.body.success, false);
    const encoded = JSON.stringify(cronLeaked);
    assert.equal(encoded.includes('s3cret'), false);
    assert.equal(encoded.includes('mongodb'), false);
    assert.equal(encoded.includes('9876543210'), false);

    const analytics = analyticsFailurePayload(transientNotPrimary());
    assert.equal(analytics.status, 503);
    assert.equal(analytics.body.success, false);
    assert.equal('data' in analytics.body, false);

    const phone = publicClientMessage(new Error('send failed for 9876543210'));
    assert.equal(phone.includes('9876543210'), false);
  });

  test('analytics timeout and BSON failures are errors, not empty success payloads', () => {
    const slow = new Error('operation exceeded time limit');
    slow.code = 50;
    const timeout = analyticsFailurePayload(slow);
    assert.equal(timeout.body.success, false);
    assert.match(timeout.body.message, /timed out/);
    assert.equal(timeout.body.data, undefined);

    const bson = new Error('BSON size limit hit while building Message');
    bson.code = 10334;
    const tooLarge = analyticsFailurePayload(bson);
    assert.equal(tooLarge.body.success, false);
    assert.match(tooLarge.body.message, /too large/);
  });
});

describe('connection gate', () => {
  test('concurrent callers share one connect attempt', async () => {
    let calls = 0;
    let release;
    const started = new Promise((resolve) => { release = resolve; });
    const gate = createConnectionGate({
      getReadyState: () => 0,
      hasClient: () => false,
      connect: async () => {
        calls += 1;
        await started;
      },
      closeExisting: async () => { throw new Error('should not close'); },
    });

    const tasks = Array.from({ length: 25 }, () => gate.ensure());
    assert.equal(calls, 1);
    release();
    await Promise.all(tasks);
    assert.equal(calls, 1);
  });

  test('a failed attempt can be retried, and a live client is not replaced', async () => {
    let calls = 0;
    const failing = createConnectionGate({
      getReadyState: () => 0,
      hasClient: () => false,
      connect: async () => {
        calls += 1;
        throw transientNotPrimary();
      },
      closeExisting: async () => {},
    });
    await assert.rejects(() => failing.ensure());
    await assert.rejects(() => failing.ensure());
    assert.equal(calls, 2);

    let closed = 0;
    let connected = 0;
    let polls = 0;
    const recovering = createConnectionGate({
      getReadyState: () => {
        polls += 1;
        return polls > 3 ? 1 : 0;
      },
      hasClient: () => true,
      connect: async () => { connected += 1; },
      closeExisting: async () => { closed += 1; },
      recoverTimeoutMs: 1000,
      pollIntervalMs: 1,
    });
    await recovering.ensure();
    assert.equal(connected, 0);
    assert.equal(closed, 0);
  });

  test('an existing client that does not recover is closed once before reconnect', async () => {
    let closed = 0;
    let connected = 0;
    const gate = createConnectionGate({
      getReadyState: () => 0,
      hasClient: () => true,
      connect: async () => { connected += 1; },
      closeExisting: async () => { closed += 1; },
      recoverTimeoutMs: 30,
      pollIntervalMs: 5,
    });
    await gate.ensure();
    assert.equal(closed, 1);
    assert.equal(connected, 1);
  });
});

describe('pool settings', () => {
  test('serverless pool limits stay within an M10 isolate and above the analytics time limit', () => {
    assert.equal(MONGO_DRIVER_OPTIONS.maxPoolSize, 10);
    assert.equal(MONGO_DRIVER_OPTIONS.minPoolSize, 0);
    assert.ok(MONGO_DRIVER_OPTIONS.maxIdleTimeMS > 0);
    assert.ok(MONGO_DRIVER_OPTIONS.waitQueueTimeoutMS > 0);
    assert.ok(MONGO_DRIVER_OPTIONS.bufferTimeoutMS > MONGO_DRIVER_OPTIONS.serverSelectionTimeoutMS);
    assert.ok(MONGO_DRIVER_OPTIONS.socketTimeoutMS > ANALYTICS_MAX_TIME_MS);
    assert.ok(MONGO_DRIVER_OPTIONS.socketTimeoutMS < 60000);
  });

  test('the request path no longer drops the shared connect promise on every error', () => {
    const serverSrc = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    const cronSrc = fs.readFileSync(path.join(__dirname, '../routes/cronRoutes.js'), 'utf8');
    assert.equal(serverSrc.includes('dbConnectPromise'), false);
    assert.equal(cronSrc.includes('error.message'), false);
    assert.equal(cronSrc.includes('retryTransient'), false);
    assert.equal(cronSrc.includes('idempotent: true'), false);
  });
});
