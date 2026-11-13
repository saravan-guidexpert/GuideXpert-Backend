'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const {
  setupTestDb,
  clearTestDb,
  teardownTestDb
} = require('./supportEmail/harness');

const GraphSubscription = require('../models/GraphSubscription');
const SupportEmailWebhookEvent = require('../models/SupportEmailWebhookEvent');
const EmailIngestionPolicy = require('../models/EmailIngestionPolicy');
const EmailSyncCursor = require('../models/EmailSyncCursor');

const { handleGraphWebhook } = require('../controllers/supportEmailWebhookController');
const { hashClientState, generateClientState } = require('../services/supportEmail/subscriptionService');

function createMockResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(content) {
      this.body = content;
      return this;
    },
    json(content) {
      this.body = content;
      this.headers['content-type'] = 'application/json';
      return this;
    }
  };
}

test.before(async () => {
  await setupTestDb();
});

test.beforeEach(async () => {
  await clearTestDb();
});

test.after(async () => {
  await teardownTestDb();
});

// ==========================================
// 1. Webhook Validation Tests
// ==========================================

test('1. valid validationToken returns status 200 with text/plain exact token', async () => {
  const req = {
    query: { validationToken: 'SecretValidationToken_12345' },
    body: {}
  };
  const res = createMockResponse();

  await handleGraphWebhook(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'SecretValidationToken_12345');
  assert.ok(res.headers['content-type'].includes('text/plain'));
});

test('2. validationToken is returned exactly without double decoding', async () => {
  // When Express parses `?validationToken=Token%20with%2520literal`, req.query.validationToken is 'Token with%20literal'
  const tokenFromExpressQuery = 'Token with%20literal&symbols+=100%';
  const req = {
    query: { validationToken: tokenFromExpressQuery },
    body: {}
  };
  const res = createMockResponse();

  await handleGraphWebhook(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body, tokenFromExpressQuery, 'Must preserve literal percent-encoded sequence without secondary decoding');
  assert.ok(res.headers['content-type'].includes('text/plain'));
});

test('3. empty validationToken returns empty text/plain response', async () => {
  const req = {
    query: { validationToken: '' },
    body: {}
  };
  const res = createMockResponse();

  // If empty string in query, should treat as validation and return empty text
  await handleGraphWebhook(req, res);
  // Empty query string in Express may evaluate as empty string
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, '');
  assert.ok(res.headers['content-type'].includes('text/plain'));
});

test('4. validation does not query or mutate MongoDB database', async () => {
  const req = {
    query: { validationToken: 'NoDbToken' },
    body: {}
  };
  const res = createMockResponse();

  // Count documents before
  const subCountBefore = await GraphSubscription.countDocuments();
  const eventCountBefore = await SupportEmailWebhookEvent.countDocuments();

  await handleGraphWebhook(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'NoDbToken');
  assert.equal(await GraphSubscription.countDocuments(), subCountBefore);
  assert.equal(await SupportEmailWebhookEvent.countDocuments(), eventCountBefore);
});

test('5. validation response executes rapidly well within 10 second requirement', async () => {
  const req = {
    query: { validationToken: 'FastToken' },
    body: {}
  };
  const res = createMockResponse();

  const start = Date.now();
  await handleGraphWebhook(req, res);
  const duration = Date.now() - start;

  assert.equal(res.statusCode, 200);
  assert.ok(duration < 100, `Validation must execute in < 100ms, took ${duration}ms`);
});

// ==========================================
// 2. Notification Security & Validation Tests
// ==========================================

test('6. malformed payload (missing value array) returns 400 Bad Request', async () => {
  const req = {
    query: {},
    body: { somethingElse: true }
  };
  const res = createMockResponse();

  await handleGraphWebhook(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
  assert.ok(res.body.message.includes('missing value array'));
});

test('7. notification item missing subscriptionId returns 400 Bad Request', async () => {
  const req = {
    query: {},
    body: {
      value: [
        { clientState: 'some-state', resource: 'users/test/messages' }
      ]
    }
  };
  const res = createMockResponse();

  await handleGraphWebhook(req, res);

  assert.equal(res.statusCode, 400);
  assert.ok(res.body.message.includes('missing required subscriptionId'));
});

test('8. unknown subscription ID returns 404 Not Found', async () => {
  const req = {
    query: {},
    body: {
      value: [
        {
          subscriptionId: 'sub-unknown-123',
          clientState: 'some-state',
          resource: 'users/support@guidexpert.com/messages'
        }
      ]
    }
  };
  const res = createMockResponse();

  await handleGraphWebhook(req, res);

  assert.equal(res.statusCode, 404);
  assert.ok(res.body.message.includes('Unknown or unregistered subscription'));
});

test('9. invalid clientState returns 401 Unauthorized without leaking expected secret', async () => {
  const mailbox = 'support@guidexpert.com';
  const realSecret = 'SuperSecretClientStateKey123';
  await GraphSubscription.create({
    subscriptionId: 'sub-auth-test-1',
    mailbox,
    folder: 'inbox',
    resource: 'users/support@guidexpert.com/messages',
    expirationDateTime: new Date(Date.now() + 3600000),
    clientState: realSecret,
    clientStateHash: hashClientState(realSecret),
    status: 'active'
  });

  const req = {
    query: {},
    body: {
      value: [
        {
          subscriptionId: 'sub-auth-test-1',
          clientState: 'WrongAttackerSecret',
          resource: 'users/support@guidexpert.com/messages'
        }
      ]
    }
  };
  const res = createMockResponse();

  await handleGraphWebhook(req, res);

  assert.equal(res.statusCode, 401);
  assert.ok(res.body.message.includes('Unauthorized'));
  // Verify secret was NOT leaked
  assert.ok(!JSON.stringify(res.body).includes(realSecret));
});

test('10. missing clientState returns 401 Unauthorized', async () => {
  const mailbox = 'support@guidexpert.com';
  const realSecret = 'SecretKey';
  await GraphSubscription.create({
    subscriptionId: 'sub-auth-test-2',
    mailbox,
    resource: 'users/support@guidexpert.com/messages',
    expirationDateTime: new Date(Date.now() + 3600000),
    clientState: realSecret,
    clientStateHash: hashClientState(realSecret),
    status: 'active'
  });

  const req = {
    query: {},
    body: {
      value: [
        {
          subscriptionId: 'sub-auth-test-2',
          // missing clientState
          resource: 'users/support@guidexpert.com/messages'
        }
      ]
    }
  };
  const res = createMockResponse();

  await handleGraphWebhook(req, res);

  assert.equal(res.statusCode, 401);
});

test('11. valid clientState and subscription accepts notification and signals sync', async () => {
  const mailbox = 'support@guidexpert.com';
  const clientState = 'ValidClientSecret999';

  await EmailIngestionPolicy.create({ mailbox, enabled: true, activationAt: new Date() });

  await GraphSubscription.create({
    subscriptionId: 'sub-valid-1',
    mailbox,
    folder: 'inbox',
    resource: `users/${mailbox}/mailFolders('inbox')/messages`,
    expirationDateTime: new Date(Date.now() + 3600000),
    clientState,
    clientStateHash: hashClientState(clientState),
    status: 'active'
  });

  const req = {
    query: {},
    body: {
      value: [
        {
          subscriptionId: 'sub-valid-1',
          clientState,
          resource: `users/${mailbox}/mailFolders('inbox')/messages`,
          changeType: 'created',
          resourceData: { id: 'msg-webhook-1' }
        }
      ]
    }
  };
  const res = createMockResponse();

  await handleGraphWebhook(req, res);

  assert.equal(res.statusCode, 202);
  assert.equal(res.body.success, true);

  // Verify event was durably persisted in SupportEmailWebhookEvent
  const event = await SupportEmailWebhookEvent.findOne({ subscriptionId: 'sub-valid-1' }).lean();
  assert.ok(event, 'Event must be stored in DB');
  assert.equal(event.resourceDataId, 'msg-webhook-1');
  assert.equal(event.status, 'received');

  // Verify mailbox sync was signaled atomically
  const cursor = await EmailSyncCursor.findOne({ mailbox, folder: 'inbox' }).lean();
  assert.ok(cursor, 'Sync cursor must exist');
  assert.equal(cursor.hasPendingSync, true, 'hasPendingSync must be true');
  assert.ok((cursor.syncRequestVersion || 0) >= 1, 'syncRequestVersion must be incremented');
});

test('12. disabled mailbox policy gracefully ignores notification without error', async () => {
  const mailbox = 'disabled@guidexpert.com';
  const clientState = 'StateKey';

  // Ingestion policy disabled
  await EmailIngestionPolicy.create({ mailbox, enabled: false, activationAt: new Date() });

  await GraphSubscription.create({
    subscriptionId: 'sub-disabled-mailbox',
    mailbox,
    folder: 'inbox',
    resource: `users/${mailbox}/messages`,
    expirationDateTime: new Date(Date.now() + 3600000),
    clientState,
    clientStateHash: hashClientState(clientState),
    status: 'active'
  });

  const req = {
    query: {},
    body: {
      value: [
        {
          subscriptionId: 'sub-disabled-mailbox',
          clientState,
          resource: `users/${mailbox}/messages`
        }
      ]
    }
  };
  const res = createMockResponse();

  await handleGraphWebhook(req, res);

  assert.equal(res.statusCode, 202);

  // Sync cursor should NOT have been signaled
  const cursor = await EmailSyncCursor.findOne({ mailbox }).lean();
  assert.equal(cursor, null, 'No sync cursor created for disabled mailbox');
});

// ==========================================
// 3. Idempotency & Deduplication Tests
// ==========================================

test('13. duplicate notification with identical resourceData.id is deduplicated without duplicate sync signals', async () => {
  const mailbox = 'support@guidexpert.com';
  const clientState = 'StateKey';

  await EmailIngestionPolicy.create({ mailbox, enabled: true, activationAt: new Date() });
  await GraphSubscription.create({
    subscriptionId: 'sub-dedupe-test',
    mailbox,
    folder: 'inbox',
    resource: `users/${mailbox}/messages`,
    expirationDateTime: new Date(Date.now() + 3600000),
    clientState,
    clientStateHash: hashClientState(clientState),
    status: 'active'
  });

  const payload = {
    query: {},
    body: {
      value: [
        {
          subscriptionId: 'sub-dedupe-test',
          clientState,
          resource: `users/${mailbox}/messages`,
          changeType: 'created',
          resourceData: { id: 'msg-same-123' }
        }
      ]
    }
  };

  // Delivery 1
  const res1 = createMockResponse();
  await handleGraphWebhook(payload, res1);
  assert.equal(res1.statusCode, 202);

  const cursorAfter1 = await EmailSyncCursor.findOne({ mailbox }).lean();
  const version1 = cursorAfter1.syncRequestVersion;

  // Delivery 2 (Duplicate re-transmission from Graph)
  const res2 = createMockResponse();
  await handleGraphWebhook(payload, res2);
  assert.equal(res2.statusCode, 202);

  // Database must only have 1 webhook event record
  const eventCount = await SupportEmailWebhookEvent.countDocuments({ subscriptionId: 'sub-dedupe-test' });
  assert.equal(eventCount, 1, 'Exactly 1 webhook event stored');

  // Sync request version should NOT have incremented a second time
  const cursorAfter2 = await EmailSyncCursor.findOne({ mailbox }).lean();
  assert.equal(cursorAfter2.syncRequestVersion, version1, 'Duplicate event must NOT increment syncRequestVersion');
});

test('14. concurrent duplicate notifications resolve safely without duplicate sync version increments', async () => {
  const mailbox = 'support@guidexpert.com';
  const clientState = 'StateKey';

  await EmailIngestionPolicy.create({ mailbox, enabled: true, activationAt: new Date() });
  await GraphSubscription.create({
    subscriptionId: 'sub-conc-test',
    mailbox,
    folder: 'inbox',
    resource: `users/${mailbox}/messages`,
    expirationDateTime: new Date(Date.now() + 3600000),
    clientState,
    clientStateHash: hashClientState(clientState),
    status: 'active'
  });

  const payload = {
    query: {},
    body: {
      value: [
        {
          subscriptionId: 'sub-conc-test',
          clientState,
          resource: `users/${mailbox}/messages`,
          changeType: 'created',
          resourceData: { id: 'msg-conc-123' }
        }
      ]
    }
  };

  const resA = createMockResponse();
  const resB = createMockResponse();

  await Promise.all([
    handleGraphWebhook(payload, resA),
    handleGraphWebhook(payload, resB)
  ]);

  assert.equal(resA.statusCode, 202);
  assert.equal(resB.statusCode, 202);

  // Exactly 1 webhook event in DB
  const eventCount = await SupportEmailWebhookEvent.countDocuments({ subscriptionId: 'sub-conc-test' });
  assert.equal(eventCount, 1);

  // SyncRequestVersion incremented exactly once
  const cursor = await EmailSyncCursor.findOne({ mailbox }).lean();
  assert.equal(cursor.syncRequestVersion, 1);
});

test('15. collection-level notifications in different time buckets are not suppressed', async () => {
  const mailbox = 'support@guidexpert.com';
  const clientState = 'StateKey';

  await EmailIngestionPolicy.create({ mailbox, enabled: true, activationAt: new Date() });
  await GraphSubscription.create({
    subscriptionId: 'sub-coll-test',
    mailbox,
    folder: 'inbox',
    resource: `users/${mailbox}/mailFolders('inbox')/messages`,
    expirationDateTime: new Date(Date.now() + 3600000),
    clientState,
    clientStateHash: hashClientState(clientState),
    status: 'active'
  });

  // Event 1 (Now)
  const req1 = {
    query: {},
    body: {
      value: [
        {
          subscriptionId: 'sub-coll-test',
          clientState,
          resource: `users/${mailbox}/mailFolders('inbox')/messages`,
          changeType: 'updated'
          // No resourceData.id -> collection-level notification
        }
      ]
    }
  };
  const res1 = createMockResponse();
  await handleGraphWebhook(req1, res1);
  assert.equal(res1.statusCode, 202);

  const cursor1 = await EmailSyncCursor.findOne({ mailbox }).lean();
  assert.equal(cursor1.syncRequestVersion, 1);

  // Event 2 (10 minutes later -> different 5-minute time bucket)
  const originalDateNow = Date.now;
  try {
    Date.now = () => originalDateNow() + 10 * 60 * 1000;

    const res2 = createMockResponse();
    await handleGraphWebhook(req1, res2);
    assert.equal(res2.statusCode, 202);

    // Should NOT be suppressed: 2 distinct events stored
    const eventCount = await SupportEmailWebhookEvent.countDocuments({ subscriptionId: 'sub-coll-test' });
    assert.equal(eventCount, 2, 'Collection-level notifications in subsequent time windows must NOT be suppressed');

    const cursor2 = await EmailSyncCursor.findOne({ mailbox }).lean();
    assert.equal(cursor2.syncRequestVersion, 2, 'Legitimate later event must increment syncRequestVersion');
  } finally {
    Date.now = originalDateNow;
  }
});

test('16. same resource with different changeTypes generate distinct webhook events', async () => {
  const mailbox = 'support@guidexpert.com';
  const clientState = 'StateKey';

  await EmailIngestionPolicy.create({ mailbox, enabled: true, activationAt: new Date() });
  await GraphSubscription.create({
    subscriptionId: 'sub-change-type-test',
    mailbox,
    folder: 'inbox',
    resource: `users/${mailbox}/messages`,
    expirationDateTime: new Date(Date.now() + 3600000),
    clientState,
    clientStateHash: hashClientState(clientState),
    status: 'active'
  });

  // Created event
  const reqCreated = {
    query: {},
    body: {
      value: [
        {
          subscriptionId: 'sub-change-type-test',
          clientState,
          resource: `users/${mailbox}/messages`,
          changeType: 'created',
          resourceData: { id: 'msg-type-1' }
        }
      ]
    }
  };
  await handleGraphWebhook(reqCreated, createMockResponse());

  // Updated event for same message
  const reqUpdated = {
    query: {},
    body: {
      value: [
        {
          subscriptionId: 'sub-change-type-test',
          clientState,
          resource: `users/${mailbox}/messages`,
          changeType: 'updated',
          resourceData: { id: 'msg-type-1' }
        }
      ]
    }
  };
  await handleGraphWebhook(reqUpdated, createMockResponse());

  const events = await SupportEmailWebhookEvent.find({ subscriptionId: 'sub-change-type-test' }).lean();
  assert.equal(events.length, 2, 'Different changeTypes for same message must both be captured');
});

test('17. database write failure during event persistence returns 500 error for Graph retry', async () => {
  const mailbox = 'support@guidexpert.com';
  const clientState = 'StateKey';

  await EmailIngestionPolicy.create({ mailbox, enabled: true, activationAt: new Date() });
  await GraphSubscription.create({
    subscriptionId: 'sub-db-fail-test',
    mailbox,
    folder: 'inbox',
    resource: `users/${mailbox}/messages`,
    expirationDateTime: new Date(Date.now() + 3600000),
    clientState,
    clientStateHash: hashClientState(clientState),
    status: 'active'
  });

  const originalCreate = SupportEmailWebhookEvent.create;
  SupportEmailWebhookEvent.create = async () => {
    throw new Error('MongoNetworkError: failed to persist webhook event');
  };

  try {
    const req = {
      method: 'POST',
      query: {},
      body: {
        value: [
          {
            subscriptionId: 'sub-db-fail-test',
            clientState,
            resource: `users/${mailbox}/messages`,
            changeType: 'created',
            resourceData: { id: 'msg-db-fail-1' }
          }
        ]
      }
    };
    const res = createMockResponse();

    await handleGraphWebhook(req, res);

    assert.equal(res.statusCode, 500);
    assert.equal(res.body.success, false);
    assert.match(res.body.message, /retry/i);
  } finally {
    SupportEmailWebhookEvent.create = originalCreate;
  }
});

// ==========================================
// 5. POST Validation & Concurrency Tests
// ==========================================

test('18. POST method validationToken returns 200 text/plain exactly once decoded', async () => {
  // In Express, req.query is already parsed from the query string
  const token = 'PostValidationToken_@!$ 2026';
  const req = {
    method: 'POST',
    path: '/api/support-email/webhooks/graph',
    query: { validationToken: token },
    body: {}
  };
  const res = createMockResponse();

  await handleGraphWebhook(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body, token);
  assert.ok(res.headers['content-type'].includes('text/plain'));
});

test('19. POST validation executes successfully even when database is disconnected', async () => {
  // Simulate database unavailable by mocking readyState to 0 (disconnected)
  Object.defineProperty(mongoose.connection, 'readyState', { value: 0, configurable: true });

  try {
    const req = {
      method: 'POST',
      path: '/api/support-email/webhooks/graph',
      query: { validationToken: 'OfflineDbToken_999' },
      body: {}
    };
    const res = createMockResponse();

    await handleGraphWebhook(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body, 'OfflineDbToken_999');
    assert.ok(res.headers['content-type'].includes('text/plain'));
  } finally {
    delete mongoose.connection.readyState;
  }
});

test('20. lifecycle endpoint supports validation handshake via POST and GET', async () => {
  const reqPost = {
    method: 'POST',
    path: '/api/support-email/webhooks/graph/lifecycle',
    query: { validationToken: 'LifecycleTokenPost_123' },
    body: {}
  };
  const resPost = createMockResponse();
  await handleGraphWebhook(reqPost, resPost);

  assert.equal(resPost.statusCode, 200);
  assert.equal(resPost.body, 'LifecycleTokenPost_123');

  const reqGet = {
    method: 'GET',
    path: '/api/support-email/webhooks/graph/lifecycle',
    query: { validationToken: 'LifecycleTokenGet_456' },
    body: {}
  };
  const resGet = createMockResponse();
  await handleGraphWebhook(reqGet, resGet);

  assert.equal(resGet.statusCode, 200);
  assert.equal(resGet.body, 'LifecycleTokenGet_456');
});

test('21. clientState verification works with keyed HMAC when MS_GRAPH_CLIENT_STATE_SECRET is set', async () => {
  const secretKey = 'test-keyed-hmac-secret-12345';
  process.env.MS_GRAPH_CLIENT_STATE_SECRET = secretKey;
  const mailbox = 'support-hmac@guidexpert.com';
  const rawClientState = 'HmacClientSecretToken_789';

  await EmailIngestionPolicy.create({ mailbox, enabled: true, activationAt: new Date() });
  await GraphSubscription.create({
    subscriptionId: 'sub-hmac-test',
    mailbox,
    folder: 'inbox',
    resource: `users/${mailbox}/messages`,
    expirationDateTime: new Date(Date.now() + 3600000),
    clientStateHash: hashClientState(rawClientState, secretKey),
    status: 'active'
  });

  try {
    const req = {
      method: 'POST',
      query: {},
      body: {
        value: [
          {
            subscriptionId: 'sub-hmac-test',
            clientState: rawClientState,
            resource: `users/${mailbox}/messages`,
            changeType: 'created',
            resourceData: { id: 'msg-hmac-1' }
          }
        ]
      }
    };
    const res = createMockResponse();
    await handleGraphWebhook(req, res);

    assert.equal(res.statusCode, 202);
    assert.equal(res.body.success, true);
  } finally {
    delete process.env.MS_GRAPH_CLIENT_STATE_SECRET;
  }
});

test('22. slow database write does not acknowledge until durable persistence completes', async () => {
  const mailbox = 'support-slow@guidexpert.com';
  const clientState = 'SlowDbState';

  await EmailIngestionPolicy.create({ mailbox, enabled: true, activationAt: new Date() });
  await GraphSubscription.create({
    subscriptionId: 'sub-slow-db-test',
    mailbox,
    folder: 'inbox',
    resource: `users/${mailbox}/messages`,
    expirationDateTime: new Date(Date.now() + 3600000),
    clientStateHash: hashClientState(clientState),
    status: 'active'
  });

  const originalCreate = SupportEmailWebhookEvent.create;
  let persistenceFinished = false;

  SupportEmailWebhookEvent.create = async (...args) => {
    // Artificial 50ms I/O latency
    await new Promise(resolve => setTimeout(resolve, 50));
    const result = await originalCreate.apply(SupportEmailWebhookEvent, args);
    persistenceFinished = true;
    return result;
  };

  try {
    const req = {
      method: 'POST',
      query: {},
      body: {
        value: [
          {
            subscriptionId: 'sub-slow-db-test',
            clientState,
            resource: `users/${mailbox}/messages`,
            changeType: 'created',
            resourceData: { id: 'msg-slow-db-1' }
          }
        ]
      }
    };
    const res = createMockResponse();
    await handleGraphWebhook(req, res);

    assert.equal(res.statusCode, 202);
    assert.equal(persistenceFinished, true, 'Acknowledgement must happen only after durable write completes');
  } finally {
    SupportEmailWebhookEvent.create = originalCreate;
  }
});

test('23. concurrent webhook notifications for the same mailbox resolve cleanly', async () => {
  const mailbox = 'support-concurrent@guidexpert.com';
  const clientState = 'ConcurrentState';

  await EmailIngestionPolicy.create({ mailbox, enabled: true, activationAt: new Date() });
  await GraphSubscription.create({
    subscriptionId: 'sub-concurrent-test',
    mailbox,
    folder: 'inbox',
    resource: `users/${mailbox}/messages`,
    expirationDateTime: new Date(Date.now() + 3600000),
    clientStateHash: hashClientState(clientState),
    status: 'active'
  });

  // Launch 5 concurrent notification requests
  const requests = Array.from({ length: 5 }, (_, i) => ({
    method: 'POST',
    query: {},
    body: {
      value: [
        {
          subscriptionId: 'sub-concurrent-test',
          clientState,
          resource: `users/${mailbox}/messages`,
          changeType: 'created',
          resourceData: { id: `msg-concurrent-${i}` }
        }
      ]
    }
  }));

  const responses = await Promise.all(
    requests.map(async req => {
      const res = createMockResponse();
      await handleGraphWebhook(req, res);
      return res;
    })
  );

  // All 5 requests must return 202 Accepted
  for (const res of responses) {
    assert.equal(res.statusCode, 202);
  }

  // 5 events must be durably persisted
  const count = await SupportEmailWebhookEvent.countDocuments({ subscriptionId: 'sub-concurrent-test' });
  assert.equal(count, 5);

  // Cursor must be signaled monotonically
  const cursor = await EmailSyncCursor.findOne({ mailbox });
  assert.ok(cursor);
  assert.equal(cursor.hasPendingSync, true);
  assert.ok(cursor.syncRequestVersion >= 1);
});

// ==========================================
// 6. DB Gate Narrowing & Literal Percent-Encoding Tests
// ==========================================

test('24. POST validationToken with literal percent-encoded sequences returns exact token without double decoding', async () => {
  // Query token contains literal percent sequences e.g. %20, %25, %2B as parsed by Express query parser
  const literalToken = 'ValidationToken%20literal%2Bplus%25percent';
  const req = {
    method: 'POST',
    path: '/api/support-email/webhooks/graph',
    query: { validationToken: literalToken },
    body: {}
  };
  const res = createMockResponse();

  await handleGraphWebhook(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body, literalToken, 'Token must match literal string exactly without secondary decodeURIComponent');
  assert.ok(res.headers['content-type'].includes('text/plain'));
});

test('25. POST validation handshake works identically on primary and lifecycle endpoints', async () => {
  const primaryToken = 'PrimaryEndpointToken_111';
  const reqPrimary = {
    method: 'POST',
    path: '/api/support-email/webhooks/graph',
    query: { validationToken: primaryToken },
    body: {}
  };
  const resPrimary = createMockResponse();
  await handleGraphWebhook(reqPrimary, resPrimary);
  assert.equal(resPrimary.statusCode, 200);
  assert.equal(resPrimary.body, primaryToken);

  const lifecycleToken = 'LifecycleEndpointToken_222';
  const reqLifecycle = {
    method: 'POST',
    path: '/api/support-email/webhooks/graph/lifecycle',
    query: { validationToken: lifecycleToken },
    body: {}
  };
  const resLifecycle = createMockResponse();
  await handleGraphWebhook(reqLifecycle, resLifecycle);
  assert.equal(resLifecycle.statusCode, 200);
  assert.equal(resLifecycle.body, lifecycleToken);
});

test('26. shouldBypassDbGate restricts bypass strictly to exact webhook and lifecycle routes', () => {
  const app = require('../server');
  const shouldBypassDbGate = app.shouldBypassDbGate;
  assert.equal(typeof shouldBypassDbGate, 'function', 'shouldBypassDbGate must be exported for verification');

  // Exact primary route with validationToken -> TRUE
  assert.equal(shouldBypassDbGate({ path: '/api/support-email/webhooks/graph', query: { validationToken: 'token' } }), true);
  assert.equal(shouldBypassDbGate({ path: '/api/support-email/webhooks/graph/', query: { validationToken: 'token' } }), true);

  // Exact lifecycle route with validationToken -> TRUE
  assert.equal(shouldBypassDbGate({ path: '/api/support-email/webhooks/graph/lifecycle', query: { validationToken: 'token' } }), true);
  assert.equal(shouldBypassDbGate({ path: '/api/support-email/webhooks/graph/lifecycle/', query: { validationToken: 'token' } }), true);

  // Health route -> TRUE
  assert.equal(shouldBypassDbGate({ path: '/api/health' }), true);

  // Unrelated paths with validationToken must NOT bypass the database gate -> FALSE
  assert.equal(shouldBypassDbGate({ path: '/api/support-email/webhooks/graph/unrelated', query: { validationToken: 'token' } }), false);
  assert.equal(shouldBypassDbGate({ path: '/api/support-email/webhooks/graph_attack', query: { validationToken: 'token' } }), false);
  assert.equal(shouldBypassDbGate({ path: '/api/support-email/webhooks/graph/lifecycle/extra', query: { validationToken: 'token' } }), false);
  assert.equal(shouldBypassDbGate({ path: '/api/counsellor-support', query: { validationToken: 'token' } }), false);
  assert.equal(shouldBypassDbGate({ path: '/api/auth/login', query: { validationToken: 'token' } }), false);

  // Webhook notification payload POST (without validationToken) must NOT bypass database gate -> FALSE
  assert.equal(shouldBypassDbGate({ path: '/api/support-email/webhooks/graph', query: {} }), false);
  assert.equal(shouldBypassDbGate({ path: '/api/support-email/webhooks/graph/lifecycle', query: {} }), false);
});
