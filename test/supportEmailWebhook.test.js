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

test('2. validationToken with URI encoded characters is decoded properly', async () => {
  const rawToken = 'Token with spaces & symbols + = 100%';
  const encodedToken = encodeURIComponent(rawToken);
  const req = {
    query: { validationToken: encodedToken },
    body: {}
  };
  const res = createMockResponse();

  await handleGraphWebhook(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body, rawToken);
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

    await assert.rejects(
      async () => {
        await handleGraphWebhook(req, res);
      },
      { message: /MongoNetworkError/ },
      'Must reject if notification cannot be durably persisted'
    );
  } finally {
    SupportEmailWebhookEvent.create = originalCreate;
  }
});
