'use strict';

/**
 * Phase 2B — Webhook authentication, resource-scope and lifecycle recovery tests.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupTestDb, clearTestDb, teardownTestDb } = require('./supportEmail/harness');

const GraphSubscription = require('../models/GraphSubscription');
const EmailIngestionPolicy = require('../models/EmailIngestionPolicy');
const EmailSyncCursor = require('../models/EmailSyncCursor');
const SupportEmailWebhookEvent = require('../models/SupportEmailWebhookEvent');
const {
  HASH_SCHEMES,
  hashClientState,
  formatGraphResource
} = require('../services/supportEmail/subscriptionService');
const {
  handleGraphWebhook,
  resourceBelongsToSubscription
} = require('../controllers/supportEmailWebhookController');

const SECRET = 'webhook-security-suite-hmac-secret-32';
const KEY_ID = 'primary';

function createMockResponse() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
    send(data) {
      this.body = data;
      return this;
    },
    setHeader(key, value) {
      this.headers[key] = value;
    }
  };
}

async function seedSubscription({ mailbox, subscriptionId = 'sub-webhook-security', resource, status = 'active', clientState = 'client-state' }) {
  return GraphSubscription.create({
    subscriptionId,
    mailbox,
    folder: 'inbox',
    resource: resource || formatGraphResource(mailbox, 'inbox'),
    expirationDateTime: new Date(Date.now() + 48 * 3600 * 1000),
    clientStateHash: hashClientState(clientState, SECRET, HASH_SCHEMES.HMAC_SHA256),
    clientStateHashScheme: HASH_SCHEMES.HMAC_SHA256,
    clientStateKeyId: KEY_ID,
    status,
    notificationUrl: 'https://api.example.com/api/support-email/webhooks/graph'
  });
}

test.before(async () => {
  process.env.MS_GRAPH_CLIENT_STATE_SECRET = SECRET;
  process.env.MS_GRAPH_CLIENT_STATE_KEY_ID = KEY_ID;
  await setupTestDb();
});

test.beforeEach(async () => {
  await clearTestDb();
  process.env.MS_GRAPH_CLIENT_STATE_SECRET = SECRET;
  process.env.MS_GRAPH_CLIENT_STATE_KEY_ID = KEY_ID;
});

test.after(async () => {
  delete process.env.MS_GRAPH_CLIENT_STATE_SECRET;
  delete process.env.MS_GRAPH_CLIENT_STATE_KEY_ID;
  await teardownTestDb();
});

test('W1. resource validation accepts folder-scoped and message-scoped resources for the same mailbox', () => {
  const mailbox = 'support@niatindia.com';
  const subscription = {
    mailbox,
    resource: formatGraphResource(mailbox, 'inbox')
  };

  assert.strictEqual(
    resourceBelongsToSubscription({
      notificationResource: `users/${mailbox}/messages`,
      subscription
    }),
    true
  );
  assert.strictEqual(
    resourceBelongsToSubscription({
      notificationResource: `users('${mailbox}')/messages('AAMkADExample')`,
      subscription
    }),
    true
  );
  assert.strictEqual(
    resourceBelongsToSubscription({
      notificationResource: formatGraphResource(mailbox, 'inbox'),
      subscription
    }),
    true
  );
});

test('W2. resource validation rejects a different mailbox, unknown users path and missing resource', () => {
  const mailbox = 'support@niatindia.com';
  const subscription = { mailbox, resource: formatGraphResource(mailbox, 'inbox') };

  assert.strictEqual(
    resourceBelongsToSubscription({
      notificationResource: 'users/attacker@example.com/messages',
      subscription
    }),
    false
  );
  assert.strictEqual(
    resourceBelongsToSubscription({
      notificationResource: 'drives/abc/items/1',
      subscription
    }),
    false
  );
  assert.strictEqual(
    resourceBelongsToSubscription({ notificationResource: null, subscription }),
    false
  );
});

test('W3. spoofed notification resource for another mailbox is rejected and not persisted', async () => {
  const mailbox = 'support@niatindia.com';
  await EmailIngestionPolicy.create({ mailbox, enabled: true, activationAt: new Date() });
  await seedSubscription({ mailbox, subscriptionId: 'sub-w3', clientState: 'state-w3' });

  const res = createMockResponse();
  await handleGraphWebhook(
    {
      query: {},
      body: {
        value: [
          {
            subscriptionId: 'sub-w3',
            clientState: 'state-w3',
            resource: 'users/other-mailbox@niatindia.com/messages',
            changeType: 'created',
            resourceData: { id: 'msg-w3' }
          }
        ]
      }
    },
    res
  );

  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(await SupportEmailWebhookEvent.countDocuments({}), 0);
  assert.strictEqual(await EmailSyncCursor.countDocuments({}), 0);
});

test('W4. a mixed batch is rejected atomically: no valid event is persisted before an invalid one is found', async () => {
  const mailbox = 'support@niatindia.com';
  await EmailIngestionPolicy.create({ mailbox, enabled: true, activationAt: new Date() });
  await seedSubscription({ mailbox, subscriptionId: 'sub-w4', clientState: 'state-w4' });

  const res = createMockResponse();
  await handleGraphWebhook(
    {
      query: {},
      body: {
        value: [
          {
            subscriptionId: 'sub-w4',
            clientState: 'state-w4',
            resource: `users/${mailbox}/messages`,
            changeType: 'created',
            resourceData: { id: 'msg-w4-valid' }
          },
          {
            subscriptionId: 'sub-w4',
            clientState: 'wrong-client-state',
            resource: `users/${mailbox}/messages`,
            changeType: 'created',
            resourceData: { id: 'msg-w4-invalid' }
          }
        ]
      }
    },
    res
  );

  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(await SupportEmailWebhookEvent.countDocuments({}), 0, 'No partial persistence');
  assert.strictEqual(await EmailSyncCursor.countDocuments({}), 0);
});

test('W5. subscriptionRemoved lifecycle event marks the subscription deleted and signals catch-up sync', async () => {
  const mailbox = 'support@niatindia.com';
  await EmailIngestionPolicy.create({ mailbox, enabled: true, activationAt: new Date() });
  await seedSubscription({ mailbox, subscriptionId: 'sub-w5', clientState: 'state-w5' });

  const res = createMockResponse();
  await handleGraphWebhook(
    {
      query: {},
      body: {
        value: [
          {
            subscriptionId: 'sub-w5',
            clientState: 'state-w5',
            lifecycleEvent: 'subscriptionRemoved',
            resource: `users/${mailbox}/messages`
          }
        ]
      }
    },
    res
  );

  assert.strictEqual(res.statusCode, 202);
  const sub = await GraphSubscription.findOne({ subscriptionId: 'sub-w5' }).lean();
  assert.strictEqual(sub.status, 'deleted');

  const cursor = await EmailSyncCursor.findOne({ mailbox }).lean();
  assert.ok(cursor, 'Catch-up sync must be signalled after removal');
  assert.strictEqual(cursor.hasPendingSync, true);
});

test('W6. reauthorizationRequired flags the subscription and signals catch-up sync', async () => {
  const mailbox = 'support@niatindia.com';
  await EmailIngestionPolicy.create({ mailbox, enabled: true, activationAt: new Date() });
  await seedSubscription({ mailbox, subscriptionId: 'sub-w6', clientState: 'state-w6' });

  const res = createMockResponse();
  await handleGraphWebhook(
    {
      query: {},
      body: {
        value: [
          {
            subscriptionId: 'sub-w6',
            clientState: 'state-w6',
            lifecycleEvent: 'reauthorizationRequired',
            resource: `users/${mailbox}/messages`
          }
        ]
      }
    },
    res
  );

  assert.strictEqual(res.statusCode, 202);
  const sub = await GraphSubscription.findOne({ subscriptionId: 'sub-w6' }).lean();
  assert.match(sub.lastError, /reauthorization/i);

  const cursor = await EmailSyncCursor.findOne({ mailbox }).lean();
  assert.ok(cursor);
  assert.strictEqual(cursor.hasPendingSync, true);
});

test('W7. duplicate delivery repairs a prior persistence-without-signal failure exactly once', async () => {
  const mailbox = 'support@niatindia.com';
  await EmailIngestionPolicy.create({ mailbox, enabled: true, activationAt: new Date() });
  await seedSubscription({ mailbox, subscriptionId: 'sub-w7', clientState: 'state-w7' });

  const resource = `users/${mailbox}/messages`;
  // Simulate: event persisted, signalMailboxSync failed, handler returned 500.
  await SupportEmailWebhookEvent.create({
    subscriptionId: 'sub-w7',
    resource,
    changeType: 'created',
    dedupeKey: `sub-w7:${resource}:msg-w7:created`,
    resourceDataId: 'msg-w7',
    status: 'failed',
    errorCategory: 'sync_signal_failed',
    error: 'transient DB failure',
    metadata: { mailbox, folder: 'inbox' }
  });

  const payload = {
    query: {},
    body: {
      value: [
        {
          subscriptionId: 'sub-w7',
          clientState: 'state-w7',
          resource,
          changeType: 'created',
          resourceData: { id: 'msg-w7' }
        }
      ]
    }
  };

  const res1 = createMockResponse();
  await handleGraphWebhook(payload, res1);
  assert.strictEqual(res1.statusCode, 202);

  const cursor = await EmailSyncCursor.findOne({ mailbox }).lean();
  assert.ok(cursor, 'Duplicate retry must repair the missing sync signal');
  assert.strictEqual(cursor.syncRequestVersion, 1);

  const event = await SupportEmailWebhookEvent.findOne({ resourceDataId: 'msg-w7' }).lean();
  assert.strictEqual(event.status, 'received');
  assert.strictEqual(event.errorCategory, null);

  // A third identical delivery is a plain duplicate and must not signal again.
  const res2 = createMockResponse();
  await handleGraphWebhook(payload, res2);
  assert.strictEqual(res2.statusCode, 202);
  const cursorAfter = await EmailSyncCursor.findOne({ mailbox }).lean();
  assert.strictEqual(cursorAfter.syncRequestVersion, 1);
});
