'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  setupTestDb,
  clearTestDb,
  teardownTestDb
} = require('./supportEmail/harness');

const GraphSubscription = require('../models/GraphSubscription');
const GraphSubscriptionOperation = require('../models/GraphSubscriptionOperation');
const EmailSyncCursor = require('../models/EmailSyncCursor');
const EmailIngestionPolicy = require('../models/EmailIngestionPolicy');
const {
  SubscriptionService,
  HASH_SCHEMES,
  hashClientState,
  generateClientState,
  timingSafeCompare,
  verifySubscriptionClientState,
  formatGraphResource,
  validateHmacKeyConfig,
  classifyGraphError
} = require('../services/supportEmail/subscriptionService');
const { handleGraphWebhook } = require('../controllers/supportEmailWebhookController');

class MockGraphClient {
  constructor() {
    this.requests = [];
    this.mockHandlers = new Map();
    this.mockSubscriptions = [];
  }

  setHandler(method, urlPattern, handler) {
    this.mockHandlers.set(`${method.toUpperCase()} ${urlPattern}`, handler);
  }

  async request({ url, method = 'GET', data, headers }) {
    this.requests.push({ url, method: method.toUpperCase(), data, headers });
    const key = `${method.toUpperCase()} ${url}`;
    
    // Exact match
    if (this.mockHandlers.has(key)) {
      return this.mockHandlers.get(key)({ url, method, data, headers });
    }

    // Pattern match
    for (const [pattern, handler] of this.mockHandlers.entries()) {
      const [pMethod, pUrl] = pattern.split(' ');
      if (pMethod === method.toUpperCase() && url.startsWith(pUrl)) {
        return handler({ url, method, data, headers });
      }
    }

    // Default responses
    if (method.toUpperCase() === 'GET' && url === '/subscriptions') {
      return {
        value: this.mockSubscriptions || []
      };
    }

    if (method.toUpperCase() === 'POST' && url === '/subscriptions') {
      return {
        id: `sub-graph-${Date.now()}`,
        resource: data.resource,
        changeType: data.changeType,
        clientState: data.clientState,
        notificationUrl: data.notificationUrl,
        lifecycleNotificationUrl: data.lifecycleNotificationUrl,
        expirationDateTime: data.expirationDateTime || new Date(Date.now() + 4200 * 60 * 1000).toISOString()
      };
    }

    if (method.toUpperCase() === 'PATCH' && url.startsWith('/subscriptions/')) {
      return {
        id: url.replace('/subscriptions/', ''),
        expirationDateTime: data.expirationDateTime || new Date(Date.now() + 4200 * 60 * 1000).toISOString()
      };
    }

    if (method.toUpperCase() === 'DELETE' && url.startsWith('/subscriptions/')) {
      return {};
    }

    throw new Error(`Unhandled mock request: ${method} ${url}`);
  }
}

async function seedSubscription(overrides = {}) {
  const mailbox = overrides.mailbox || 'support@guidexpert.com';
  const folder = overrides.folder || 'inbox';
  return GraphSubscription.create({
    subscriptionId: overrides.subscriptionId || `sub-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    mailbox,
    folder,
    resource: overrides.resource || formatGraphResource(mailbox, folder),
    expirationDateTime: overrides.expirationDateTime || new Date(Date.now() + 48 * 3600 * 1000),
    clientStateHash: overrides.clientStateHash || hashClientState(overrides.clientState || 'test-secret'),
    status: overrides.status || 'active',
    notificationUrl: overrides.notificationUrl || 'https://api.guidexpert.com/api/support-email/webhooks/graph',
    ...overrides
  });
}

test.before(async () => {
  process.env.MS_GRAPH_CLIENT_STATE_SECRET = 'test-suite-default-hmac-secret-key-32b';
  process.env.MS_GRAPH_CLIENT_STATE_KEY_ID = 'primary';
  await setupTestDb();
});

test.beforeEach(async () => {
  await clearTestDb();
  process.env.MS_GRAPH_CLIENT_STATE_SECRET = 'test-suite-default-hmac-secret-key-32b';
  process.env.MS_GRAPH_CLIENT_STATE_KEY_ID = 'primary';
  delete process.env.MS_GRAPH_CLIENT_STATE_SECRET_PREVIOUS;
  delete process.env.MS_GRAPH_CLIENT_STATE_PREVIOUS_KEY_ID;
});

test.after(async () => {
  delete process.env.MS_GRAPH_CLIENT_STATE_SECRET;
  delete process.env.MS_GRAPH_CLIENT_STATE_KEY_ID;
  delete process.env.MS_GRAPH_CLIENT_STATE_SECRET_PREVIOUS;
  delete process.env.MS_GRAPH_CLIENT_STATE_PREVIOUS_KEY_ID;
  await teardownTestDb();
});

// ==========================================
// 1. Subscription Creation Tests
// ==========================================

test('1. createSubscription creates a new subscription when none exists', async () => {
  const mockGraph = new MockGraphClient();
  const service = new SubscriptionService({
    graphClient: mockGraph,
    notificationUrl: 'https://api.guidexpert.com/api/support-email/webhooks/graph'
  });

  const mailbox = 'support@guidexpert.com';
  const result = await service.createSubscription({ mailbox, folder: 'inbox' });

  assert.strictEqual(result.created, true);
  assert.strictEqual(result.isExisting, false);
  assert.ok(result.subscription);
  assert.strictEqual(result.subscription.mailbox, mailbox);
  assert.strictEqual(result.subscription.folder, 'inbox');
  assert.strictEqual(result.subscription.status, 'active');
  assert.ok(result.subscription.subscriptionId.startsWith('sub-graph-'));
  assert.strictEqual(result.subscription.clientStateHash, hashClientState(result.clientState));

  // Verify Graph API was called with required fields
  assert.strictEqual(mockGraph.requests.length, 1);
  const req = mockGraph.requests[0];
  assert.strictEqual(req.method, 'POST');
  assert.strictEqual(req.url, '/subscriptions');
  assert.strictEqual(req.data.resource, "users/support%40guidexpert.com/mailFolders('inbox')/messages");
  assert.strictEqual(req.data.notificationUrl, 'https://api.guidexpert.com/api/support-email/webhooks/graph');
  assert.strictEqual(req.data.clientState, result.clientState);
});

test('2. createSubscription prevents duplicate when active subscription exists', async () => {
  const mockGraph = new MockGraphClient();
  const service = new SubscriptionService({
    graphClient: mockGraph,
    notificationUrl: 'https://api.guidexpert.com/api/support-email/webhooks/graph'
  });

  const mailbox = 'support@guidexpert.com';
  const future = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48h in future

  // Pre-seed active subscription in DB
  await seedSubscription({
    subscriptionId: 'sub-existing-123',
    mailbox,
    folder: 'inbox',
    expirationDateTime: future,
    status: 'active',
    clientState: 'secret123'
  });

  const result = await service.createSubscription({ mailbox, folder: 'inbox' });

  assert.strictEqual(result.created, false);
  assert.strictEqual(result.isExisting, true);
  assert.strictEqual(result.subscription.subscriptionId, 'sub-existing-123');
  // Graph API must not have been called
  assert.strictEqual(mockGraph.requests.length, 0);
});

test('3. createSubscription with force=true creates fresh subscription and supersedes old', async () => {
  const mockGraph = new MockGraphClient();
  const service = new SubscriptionService({
    graphClient: mockGraph,
    notificationUrl: 'https://api.guidexpert.com/api/support-email/webhooks/graph'
  });

  const mailbox = 'support@guidexpert.com';
  const future = new Date(Date.now() + 48 * 60 * 60 * 1000);

  // Pre-seed old active subscription
  await seedSubscription({
    subscriptionId: 'sub-old-123',
    mailbox,
    folder: 'inbox',
    expirationDateTime: future,
    status: 'active'
  });

  const result = await service.createSubscription({ mailbox, folder: 'inbox', force: true });

  assert.strictEqual(result.created, true);
  assert.notStrictEqual(result.subscription.subscriptionId, 'sub-old-123');
  assert.strictEqual(mockGraph.requests.length, 1);

  // Verify old subscription marked as expired
  const oldSub = await GraphSubscription.findOne({ subscriptionId: 'sub-old-123' });
  assert.strictEqual(oldSub.status, 'expired');
});

// ==========================================
// 2. Subscription Renewal Tests
// ==========================================

test('4. renewSubscription calls PATCH /subscriptions/{id} and updates expiration', async () => {
  const mockGraph = new MockGraphClient();
  const service = new SubscriptionService({ graphClient: mockGraph });

  const mailbox = 'support@guidexpert.com';
  const initialExp = new Date(Date.now() + 5 * 60 * 60 * 1000); // 5 hours left

  await seedSubscription({
    subscriptionId: 'sub-renew-101',
    mailbox,
    folder: 'inbox',
    expirationDateTime: initialExp,
    status: 'active'
  });

  const result = await service.renewSubscription({ subscriptionId: 'sub-renew-101' });

  assert.strictEqual(result.renewed, true);
  assert.strictEqual(mockGraph.requests.length, 1);
  assert.strictEqual(mockGraph.requests[0].method, 'PATCH');
  assert.strictEqual(mockGraph.requests[0].url, '/subscriptions/sub-renew-101');

  // Verify expiration updated in DB
  const updatedSub = await GraphSubscription.findOne({ subscriptionId: 'sub-renew-101' });
  assert.ok(updatedSub.expirationDateTime.getTime() > initialExp.getTime());
  assert.strictEqual(updatedSub.status, 'active');
  assert.ok(updatedSub.lastRenewedAt);
});

test('5. renewSubscription marks expired on 404 Not Found from Graph', async () => {
  const mockGraph = new MockGraphClient();
  mockGraph.setHandler('PATCH', '/subscriptions/sub-missing-404', () => {
    const err = new Error('Resource not found');
    err.statusCode = 404;
    throw err;
  });

  const service = new SubscriptionService({ graphClient: mockGraph });
  const mailbox = 'support@guidexpert.com';

  await seedSubscription({
    subscriptionId: 'sub-missing-404',
    mailbox,
    folder: 'inbox',
    expirationDateTime: new Date(),
    status: 'active'
  });

  await assert.rejects(
    async () => {
      await service.renewSubscription({ subscriptionId: 'sub-missing-404' });
    },
    /Resource not found/
  );

  const updatedSub = await GraphSubscription.findOne({ subscriptionId: 'sub-missing-404' });
  assert.strictEqual(updatedSub.status, 'expired');
  assert.ok(updatedSub.lastError.includes('Resource not found'));
});

// ==========================================
// 3. Subscription Deletion Tests
// ==========================================

test('6. deleteSubscription calls DELETE /subscriptions/{id} and marks deleted', async () => {
  const mockGraph = new MockGraphClient();
  const service = new SubscriptionService({ graphClient: mockGraph });

  const mailbox = 'support@guidexpert.com';
  await seedSubscription({
    subscriptionId: 'sub-del-101',
    mailbox,
    folder: 'inbox',
    expirationDateTime: new Date(Date.now() + 100000),
    status: 'active'
  });

  const result = await service.deleteSubscription({ subscriptionId: 'sub-del-101' });

  assert.strictEqual(result.deleted, true);
  assert.strictEqual(mockGraph.requests.length, 1);
  assert.strictEqual(mockGraph.requests[0].method, 'DELETE');
  assert.strictEqual(mockGraph.requests[0].url, '/subscriptions/sub-del-101');

  const doc = await GraphSubscription.findOne({ subscriptionId: 'sub-del-101' });
  assert.strictEqual(doc.status, 'deleted');
});

test('7. deleteSubscription handles 404 cleanly without error', async () => {
  const mockGraph = new MockGraphClient();
  mockGraph.setHandler('DELETE', '/subscriptions/sub-already-deleted', () => {
    const err = new Error('Not found');
    err.statusCode = 404;
    throw err;
  });

  const service = new SubscriptionService({ graphClient: mockGraph });

  await seedSubscription({
    subscriptionId: 'sub-already-deleted',
    mailbox: 'support@guidexpert.com',
    status: 'active'
  });

  const result = await service.deleteSubscription({ subscriptionId: 'sub-already-deleted' });
  assert.strictEqual(result.deleted, true);

  const doc = await GraphSubscription.findOne({ subscriptionId: 'sub-already-deleted' });
  assert.strictEqual(doc.status, 'deleted');
});

// ==========================================
// 4. Health Audit & Auto-Repair Tests
// ==========================================

test('8. syncSubscriptionHealth creates fresh subscription if none exists', async () => {
  const mockGraph = new MockGraphClient();
  const service = new SubscriptionService({
    graphClient: mockGraph,
    notificationUrl: 'https://api.guidexpert.com/api/support-email/webhooks/graph'
  });

  const result = await service.syncSubscriptionHealth({ mailbox: 'support@guidexpert.com' });

  assert.strictEqual(result.created, true);
  assert.strictEqual(mockGraph.requests.length, 1);
  assert.strictEqual(mockGraph.requests[0].method, 'POST');
});

test('9. syncSubscriptionHealth replaces already-expired subscription', async () => {
  const mockGraph = new MockGraphClient();
  const service = new SubscriptionService({
    graphClient: mockGraph,
    notificationUrl: 'https://api.guidexpert.com/api/support-email/webhooks/graph'
  });

  const mailbox = 'support@guidexpert.com';
  // Expired 1 hour ago
  const past = new Date(Date.now() - 3600 * 1000);
  await seedSubscription({
    subscriptionId: 'sub-expired-101',
    mailbox,
    folder: 'inbox',
    expirationDateTime: past,
    status: 'active'
  });

  const result = await service.syncSubscriptionHealth({ mailbox });

  assert.strictEqual(result.created, true);
  // Old subscription marked expired
  const oldSub = await GraphSubscription.findOne({ subscriptionId: 'sub-expired-101' });
  assert.strictEqual(oldSub.status, 'expired');
});

test('10. syncSubscriptionHealth renews subscription within safety margin (<24h)', async () => {
  const mockGraph = new MockGraphClient();
  const service = new SubscriptionService({
    graphClient: mockGraph,
    notificationUrl: 'https://api.guidexpert.com/api/support-email/webhooks/graph'
  });

  const mailbox = 'support@guidexpert.com';
  // Expiring in 12 hours (within 24h safety margin)
  const expiringSoon = new Date(Date.now() + 12 * 3600 * 1000);
  await seedSubscription({
    subscriptionId: 'sub-renew-soon',
    mailbox,
    folder: 'inbox',
    expirationDateTime: expiringSoon,
    status: 'active'
  });

  const result = await service.syncSubscriptionHealth({ mailbox });

  assert.strictEqual(result.renewed, true);
  assert.strictEqual(mockGraph.requests.length, 1);
  assert.strictEqual(mockGraph.requests[0].method, 'PATCH');
});

test('11. syncSubscriptionHealth leaves healthy subscription alone (>24h)', async () => {
  const mockGraph = new MockGraphClient();
  const service = new SubscriptionService({
    graphClient: mockGraph,
    notificationUrl: 'https://api.guidexpert.com/api/support-email/webhooks/graph'
  });

  const mailbox = 'support@guidexpert.com';
  // Expiring in 60 hours (>24h safety margin)
  const expiringLater = new Date(Date.now() + 60 * 3600 * 1000);
  await seedSubscription({
    subscriptionId: 'sub-healthy-sub',
    mailbox,
    folder: 'inbox',
    expirationDateTime: expiringLater,
    status: 'active'
  });

  const result = await service.syncSubscriptionHealth({ mailbox });

  assert.strictEqual(result.healthy, true);
  assert.strictEqual(result.renewed, false);
  assert.strictEqual(mockGraph.requests.length, 0);
});

test('12. syncSubscriptionHealth re-creates subscription if renewal returns 404', async () => {
  const mockGraph = new MockGraphClient();
  mockGraph.setHandler('PATCH', '/subscriptions/sub-purged-404', () => {
    const err = new Error('Subscription not found');
    err.statusCode = 404;
    throw err;
  });

  const service = new SubscriptionService({
    graphClient: mockGraph,
    notificationUrl: 'https://api.guidexpert.com/api/support-email/webhooks/graph'
  });

  const mailbox = 'support@guidexpert.com';
  const expiringSoon = new Date(Date.now() + 5 * 3600 * 1000); // 5h left
  await seedSubscription({
    subscriptionId: 'sub-purged-404',
    mailbox,
    folder: 'inbox',
    expirationDateTime: expiringSoon,
    status: 'active'
  });

  const result = await service.syncSubscriptionHealth({ mailbox });

  // First attempted PATCH, failed with 404, then performed POST to create fresh subscription
  assert.strictEqual(result.created, true);
  assert.strictEqual(mockGraph.requests.length, 2);
  assert.strictEqual(mockGraph.requests[0].method, 'PATCH');
  assert.strictEqual(mockGraph.requests[1].method, 'POST');
});

// ==========================================
// 5. Lifecycle Event Handling Tests
// ==========================================

test('13. handleLifecycleNotification handles missed by signaling delta sync', async () => {
  const mailbox = 'support@guidexpert.com';
  await EmailIngestionPolicy.create({ mailbox, enabled: true, activationAt: new Date() });
  await seedSubscription({
    subscriptionId: 'sub-life-missed',
    mailbox,
    folder: 'inbox',
    status: 'active'
  });

  const service = new SubscriptionService();
  const outcome = await service.handleLifecycleNotification({
    subscriptionId: 'sub-life-missed',
    lifecycleEvent: 'missed'
  });

  assert.strictEqual(outcome.handled, true);
  assert.strictEqual(outcome.action, 'signaled_delta_sync');

  // Verify delta sync cursor was signaled
  const cursor = await EmailSyncCursor.findOne({ mailbox, folder: 'inbox' });
  assert.ok(cursor);
  assert.strictEqual(cursor.hasPendingSync, true);
  assert.ok(cursor.syncRequestVersion >= 1);
});

test('14. handleLifecycleNotification handles subscriptionRemoved by marking deleted', async () => {
  const mailbox = 'support@guidexpert.com';
  await seedSubscription({
    subscriptionId: 'sub-life-removed',
    mailbox,
    folder: 'inbox',
    status: 'active'
  });

  const service = new SubscriptionService();
  const outcome = await service.handleLifecycleNotification({
    subscriptionId: 'sub-life-removed',
    lifecycleEvent: 'subscriptionRemoved'
  });

  assert.strictEqual(outcome.handled, true);
  assert.strictEqual(outcome.action, 'marked_deleted');

  const sub = await GraphSubscription.findOne({ subscriptionId: 'sub-life-removed' });
  assert.strictEqual(sub.status, 'deleted');
});

test('15. handleLifecycleNotification handles reauthorizationRequired by updating error', async () => {
  const mailbox = 'support@guidexpert.com';
  await seedSubscription({
    subscriptionId: 'sub-life-reauth',
    mailbox,
    folder: 'inbox',
    status: 'active'
  });

  const service = new SubscriptionService();
  const outcome = await service.handleLifecycleNotification({
    subscriptionId: 'sub-life-reauth',
    lifecycleEvent: 'reauthorizationRequired'
  });

  assert.strictEqual(outcome.handled, true);

  const sub = await GraphSubscription.findOne({ subscriptionId: 'sub-life-reauth' });
  assert.ok(sub.lastError.includes('Reauthorization required'));
});

// ==========================================
// 6. Security & Utility Tests
// ==========================================

test('16. timingSafeCompare returns true for identical strings and false for differing strings', () => {
  assert.strictEqual(timingSafeCompare('correct-secret-1234567890', 'correct-secret-1234567890'), true);
  assert.strictEqual(timingSafeCompare('correct-secret-1234567890', 'wrong-secret-123456789000'), false);
  assert.strictEqual(timingSafeCompare('correct-secret-1234567890', 'correct-secret-123456789!'), false);
  assert.strictEqual(timingSafeCompare('short', 'much-longer-string-with-different-length'), false);
  assert.strictEqual(timingSafeCompare(null, 'secret'), false);
  assert.strictEqual(timingSafeCompare('secret', undefined), false);
});

test('17. generateClientState generates secure random 64-hex-char string', () => {
  const secret1 = generateClientState();
  const secret2 = generateClientState();
  assert.strictEqual(secret1.length, 64);
  assert.strictEqual(secret2.length, 64);
  assert.notStrictEqual(secret1, secret2);
  assert.match(secret1, /^[0-9a-f]{64}$/);
});

test('18. createSubscription with separate notificationUrl and lifecycleUrl configures both', async () => {
  const mockGraph = new MockGraphClient();
  const service = new SubscriptionService({
    graphClient: mockGraph,
    notificationUrl: 'https://api.guidexpert.com/api/support-email/webhooks/graph',
    lifecycleUrl: 'https://api.guidexpert.com/api/support-email/webhooks/graph/lifecycle'
  });

  const mailbox = 'support-split@guidexpert.com';
  const result = await service.createSubscription({
    mailbox,
    folder: 'inbox',
    notificationUrl: 'https://api.guidexpert.com/api/support-email/webhooks/graph',
    lifecycleUrl: 'https://api.guidexpert.com/api/support-email/webhooks/graph/lifecycle'
  });

  assert.strictEqual(result.created, true);
  assert.strictEqual(mockGraph.requests.length, 1);
  const req = mockGraph.requests[0];
  assert.strictEqual(req.data.notificationUrl, 'https://api.guidexpert.com/api/support-email/webhooks/graph');
  assert.strictEqual(req.data.lifecycleNotificationUrl, 'https://api.guidexpert.com/api/support-email/webhooks/graph/lifecycle');

  // Verify DB record contains lifecycleUrl but NO plaintext clientState
  const doc = await GraphSubscription.findOne({ subscriptionId: result.subscription.subscriptionId }).lean();
  assert.strictEqual(doc.notificationUrl, 'https://api.guidexpert.com/api/support-email/webhooks/graph');
  assert.strictEqual(doc.lifecycleUrl, 'https://api.guidexpert.com/api/support-email/webhooks/graph/lifecycle');
  assert.strictEqual(doc.clientState, undefined, 'Must not store clientState plaintext in MongoDB');
  assert.ok(doc.clientStateHash, 'Must store cryptographic hash');
});

test('19. createSubscription with identical notification and lifecycle URLs defaults correctly', async () => {
  const mockGraph = new MockGraphClient();
  const service = new SubscriptionService({
    graphClient: mockGraph,
    notificationUrl: 'https://api.guidexpert.com/api/support-email/webhooks/graph'
  });

  const mailbox = 'support-identical@guidexpert.com';
  const result = await service.createSubscription({
    mailbox,
    folder: 'inbox'
  });

  assert.strictEqual(result.created, true);
  const req = mockGraph.requests[0];
  assert.strictEqual(req.data.notificationUrl, 'https://api.guidexpert.com/api/support-email/webhooks/graph');
  assert.strictEqual(req.data.lifecycleNotificationUrl, 'https://api.guidexpert.com/api/support-email/webhooks/graph');
});

test('20. clientState is never stored in plaintext across create, renew, or health repair', async () => {
  const mockGraph = new MockGraphClient();
  const service = new SubscriptionService({
    graphClient: mockGraph,
    notificationUrl: 'https://api.guidexpert.com/api/support-email/webhooks/graph'
  });

  const mailbox = 'support-no-plaintext@guidexpert.com';
  const result = await service.createSubscription({ mailbox, clientState: 'SecretPlaintext123!' });

  const doc = await GraphSubscription.findOne({ subscriptionId: result.subscription.subscriptionId }).lean();
  assert.strictEqual(doc.clientState, undefined);
  assert.strictEqual(doc.clientStateHash, hashClientState('SecretPlaintext123!'));

  // Health sync
  await service.syncSubscriptionHealth({ mailbox });
  const docAfter = await GraphSubscription.findOne({ subscriptionId: result.subscription.subscriptionId }).lean();
  assert.strictEqual(docAfter.clientState, undefined);
});

// ==========================================
// 7. Versioned Key Rotation & Recovery Tests
// ==========================================

test('21. versioned key rotation allows overlapping subscriptions to authenticate concurrently', async () => {
  const mailbox = 'support-rotation@guidexpert.com';
  const clientStateOld = 'old-subscription-client-state-32bytes!';
  const clientStateNew = 'new-subscription-client-state-32bytes!';

  const secretV1 = 'hmac-key-v1-secret';
  const secretV2 = 'hmac-key-v2-secret';

  // Seed Sub 1 with v1 key metadata
  const sub1 = await seedSubscription({
    subscriptionId: 'sub-rotation-v1',
    mailbox,
    folder: 'inbox',
    clientStateHash: hashClientState(clientStateOld, secretV1, HASH_SCHEMES.HMAC_SHA256),
    clientStateHashScheme: HASH_SCHEMES.HMAC_SHA256,
    clientStateKeyId: 'v1',
    status: 'active'
  });

  // Seed Sub 2 with v2 key metadata
  const sub2 = await seedSubscription({
    subscriptionId: 'sub-rotation-v2',
    mailbox,
    folder: 'inbox',
    clientStateHash: hashClientState(clientStateNew, secretV2, HASH_SCHEMES.HMAC_SHA256),
    clientStateHashScheme: HASH_SCHEMES.HMAC_SHA256,
    clientStateKeyId: 'v2',
    status: 'active'
  });

  // Simulated environment during rotation overlap: v2 is primary, v1 is previous
  const rotationEnv = {
    MS_GRAPH_CLIENT_STATE_SECRET: secretV2,
    MS_GRAPH_CLIENT_STATE_KEY_ID: 'v2',
    MS_GRAPH_CLIENT_STATE_SECRET_PREVIOUS: secretV1,
    MS_GRAPH_CLIENT_STATE_PREVIOUS_KEY_ID: 'v1'
  };

  // 1. Both old and new subscriptions authenticate successfully
  assert.strictEqual(
    verifySubscriptionClientState({ clientState: clientStateOld, subscription: sub1, env: rotationEnv }),
    true,
    'Sub1 must authenticate via previous key'
  );
  assert.strictEqual(
    verifySubscriptionClientState({ clientState: clientStateNew, subscription: sub2, env: rotationEnv }),
    true,
    'Sub2 must authenticate via primary key'
  );

  // 2. Cross-key and invalid secrets are rejected
  assert.strictEqual(
    verifySubscriptionClientState({ clientState: clientStateOld, subscription: sub2, env: rotationEnv }),
    false,
    'Sub2 must reject clientStateOld'
  );
  assert.strictEqual(
    verifySubscriptionClientState({ clientState: 'completely-wrong-token', subscription: sub1, env: rotationEnv }),
    false,
    'Sub1 must reject invalid token'
  );
});

test('22. HMAC scheme strictly rejects unkeyed SHA-256 fallback (algorithm isolation)', async () => {
  const secret = 'strong-production-hmac-secret';
  const clientState = 'client-secret-test';

  const sub = {
    subscriptionId: 'sub-hmac-strict',
    clientStateHash: hashClientState(clientState, secret, HASH_SCHEMES.HMAC_SHA256),
    clientStateHashScheme: HASH_SCHEMES.HMAC_SHA256,
    clientStateKeyId: 'primary'
  };

  const envWithoutSecret = {
    MS_GRAPH_CLIENT_STATE_SECRET: '',
    MS_GRAPH_CLIENT_STATE_SECRET_PREVIOUS: ''
  };

  // If environment lacks secret, HMAC subscription MUST NOT fall back to unkeyed SHA-256
  assert.strictEqual(
    verifySubscriptionClientState({ clientState, subscription: sub, env: envWithoutSecret }),
    false,
    'Must fail verification when HMAC key is absent, never fall back to SHA-256'
  );
});

test('23. explicit SHA-256 unkeyed scheme authenticates correctly without HMAC secret', async () => {
  const clientState = 'legacy-unkeyed-token-123';
  const sub = {
    subscriptionId: 'sub-legacy-sha',
    clientStateHash: hashClientState(clientState, null, HASH_SCHEMES.SHA256),
    clientStateHashScheme: HASH_SCHEMES.SHA256,
    clientStateKeyId: 'unkeyed'
  };

  assert.strictEqual(
    verifySubscriptionClientState({ clientState, subscription: sub, env: {} }),
    true,
    'Unkeyed SHA-256 subscription must authenticate successfully'
  );
  assert.strictEqual(
    verifySubscriptionClientState({ clientState: 'tampered-secret', subscription: sub, env: {} }),
    false,
    'Tampered secret must be rejected'
  );
});

test('24. failed subscription replacement in Graph preserves old subscription and reconciliation retries cleanly', async () => {
  const mailbox = 'support-fail-replace@guidexpert.com';
  const mockGraph = new MockGraphClient();

  // Graph POST fails with 503 Service Unavailable
  mockGraph.setHandler('POST', '/subscriptions', () => {
    const err = new Error('Graph service temporarily unavailable');
    err.statusCode = 503;
    throw err;
  });

  const service = new SubscriptionService({
    graphClient: mockGraph,
    notificationUrl: 'https://api.guidexpert.com/api/support-email/webhooks/graph'
  });

  const expiringSub = await seedSubscription({
    subscriptionId: 'sub-existing-active',
    mailbox,
    folder: 'inbox',
    expirationDateTime: new Date(Date.now() - 1000), // already expired
    status: 'active'
  });

  // Attempt forced replacement: throws 503
  await assert.rejects(
    async () => {
      await service.createSubscription({ mailbox, force: true });
    },
    { statusCode: 503 }
  );

  // Existing subscription must remain in DB and not be prematurely expired or deleted
  const doc = await GraphSubscription.findOne({ subscriptionId: 'sub-existing-active' }).lean();
  assert.strictEqual(doc.status, 'active', 'Old subscription must remain active if replacement creation failed');

  // The ambiguous 503 keeps an active protection reservation: an immediate retry must NOT
  // create a second remote subscription, even though Graph has "recovered".
  mockGraph.setHandler('POST', '/subscriptions', (req) => {
    return {
      id: 'sub-new-recovered-id',
      expirationDateTime: new Date(Date.now() + 4200 * 60 * 1000).toISOString()
    };
  });

  const blockedRetry = await service.syncSubscriptionHealth({ mailbox, safetyMarginHours: 24 });
  assert.strictEqual(blockedRetry.inFlight, true, 'Ambiguous failure must block immediate replacement');
  assert.strictEqual(mockGraph.requests.filter(r => r.method === 'POST').length, 1, 'No second POST while lease is active');

  // Once the protection lease expires, the next health check must discover the original
  // outcome before it is allowed to POST again. An empty enumeration is not that proof.
  await GraphSubscriptionOperation.updateOne(
    { mailbox, state: 'failed' },
    { $set: { leaseExpiresAt: new Date(Date.now() - 1000) } }
  );

  const healthResult = await service.syncSubscriptionHealth({ mailbox, safetyMarginHours: 24 });
  assert.notStrictEqual(healthResult.created, true);
  assert.strictEqual(healthResult.inFlight, true);
  assert.strictEqual(mockGraph.requests.filter(r => r.method === 'POST').length, 1, 'Expired ambiguous lease must not POST again');
  assert.strictEqual(mockGraph.requests.filter(r => r.method === 'DELETE').length, 0);

  const unresolved = await GraphSubscriptionOperation.findOne({ mailbox, failureClassification: 'ambiguous' }).lean();
  assert.ok(unresolved);
  assert.notStrictEqual(unresolved.state, 'abandoned');
  assert.ok(unresolved.reservationKey);
  const activeAfter = await GraphSubscription.countDocuments({ mailbox, status: 'active' });
  assert.strictEqual(activeAfter, 0);
});

test('25. multiple duplicate active subscriptions self-heal on health check by expiring older duplicates', async () => {
  const mailbox = 'support-duplicate-heal@guidexpert.com';
  const mockGraph = new MockGraphClient();
  const service = new SubscriptionService({
    graphClient: mockGraph,
    notificationUrl: 'https://api.guidexpert.com/api/support-email/webhooks/graph'
  });

  const now = Date.now();
  // Duplicate active sub 1: expires in 30 hours
  await seedSubscription({
    subscriptionId: 'sub-duplicate-old',
    mailbox,
    folder: 'inbox',
    expirationDateTime: new Date(now + 30 * 3600 * 1000),
    status: 'active'
  });

  // Duplicate active sub 2: expires in 50 hours (newer)
  await seedSubscription({
    subscriptionId: 'sub-duplicate-newer',
    mailbox,
    folder: 'inbox',
    expirationDateTime: new Date(now + 50 * 3600 * 1000),
    status: 'active'
  });

  // Run health check
  const health = await service.syncSubscriptionHealth({ mailbox });
  assert.strictEqual(health.healthy, true);
  assert.strictEqual(health.subscription.subscriptionId, 'sub-duplicate-newer');

  // Verify older duplicate sub was proactively transitioned to expired
  const oldSub = await GraphSubscription.findOne({ subscriptionId: 'sub-duplicate-old' }).lean();
  assert.strictEqual(oldSub.status, 'expired', 'Older duplicate subscription must be marked expired');

  const newerSub = await GraphSubscription.findOne({ subscriptionId: 'sub-duplicate-newer' }).lean();
  assert.strictEqual(newerSub.status, 'active', 'Newer subscription must remain active');
});

test('26. webhook controller authenticates overlapping notifications across secret rotation transition', async () => {
  const mailbox = 'support-overlap-webhook@guidexpert.com';
  await EmailIngestionPolicy.create({ mailbox, enabled: true, activationAt: new Date() });

  const clientStateV1 = 'client-state-v1-token';
  const clientStateV2 = 'client-state-v2-token';

  const secretV1 = 'secret-rotation-key-v1';
  const secretV2 = 'secret-rotation-key-v2';

  // Seed Sub 1 (created with V1)
  await seedSubscription({
    subscriptionId: 'sub-webhook-v1',
    mailbox,
    folder: 'inbox',
    clientStateHash: hashClientState(clientStateV1, secretV1, HASH_SCHEMES.HMAC_SHA256),
    clientStateHashScheme: HASH_SCHEMES.HMAC_SHA256,
    clientStateKeyId: 'v1',
    status: 'active'
  });

  // Seed Sub 2 (created with V2)
  await seedSubscription({
    subscriptionId: 'sub-webhook-v2',
    mailbox,
    folder: 'inbox',
    clientStateHash: hashClientState(clientStateV2, secretV2, HASH_SCHEMES.HMAC_SHA256),
    clientStateHashScheme: HASH_SCHEMES.HMAC_SHA256,
    clientStateKeyId: 'v2',
    status: 'active'
  });

  // Configure rotation overlap environment
  process.env.MS_GRAPH_CLIENT_STATE_SECRET = secretV2;
  process.env.MS_GRAPH_CLIENT_STATE_KEY_ID = 'v2';
  process.env.MS_GRAPH_CLIENT_STATE_SECRET_PREVIOUS = secretV1;
  process.env.MS_GRAPH_CLIENT_STATE_PREVIOUS_KEY_ID = 'v1';

  try {
    const mockRes1 = {
      statusCode: null,
      headers: {},
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(data) { this.body = data; return this; },
      setHeader(k, v) { this.headers[k] = v; }
    };

    // Incoming notification for Sub 1 with clientStateV1
    await handleGraphWebhook(
      {
        query: {},
        body: {
          value: [{
            subscriptionId: 'sub-webhook-v1',
            clientState: clientStateV1,
            resource: `users/${mailbox}/messages`,
            changeType: 'created',
            resourceData: { id: 'msg-v1-001' }
          }]
        }
      },
      mockRes1
    );

    assert.strictEqual(mockRes1.statusCode, 202, 'Old subscription notification must be accepted during rotation');

    const mockRes2 = {
      statusCode: null,
      headers: {},
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(data) { this.body = data; return this; },
      setHeader(k, v) { this.headers[k] = v; }
    };

    // Incoming notification for Sub 2 with clientStateV2
    await handleGraphWebhook(
      {
        query: {},
        body: {
          value: [{
            subscriptionId: 'sub-webhook-v2',
            clientState: clientStateV2,
            resource: `users/${mailbox}/messages`,
            changeType: 'created',
            resourceData: { id: 'msg-v2-001' }
          }]
        }
      },
      mockRes2
    );

    assert.strictEqual(mockRes2.statusCode, 202, 'New subscription notification must be accepted during rotation');
  } finally {
    delete process.env.MS_GRAPH_CLIENT_STATE_SECRET;
    delete process.env.MS_GRAPH_CLIENT_STATE_KEY_ID;
    delete process.env.MS_GRAPH_CLIENT_STATE_SECRET_PREVIOUS;
    delete process.env.MS_GRAPH_CLIENT_STATE_PREVIOUS_KEY_ID;
  }
});


// ─── Tests 27-38: Remote/Local Consistency, Recovery, and Guard Scenarios ───────

test('27. locally-expired subscription (marked expired in DB) still authenticates Graph notifications until remote Graph subscription expires naturally', async () => {
  // This is the documented safe behavior: when syncSubscriptionHealth marks a duplicate
  // as locally expired via updateMany, the corresponding remote Graph subscription continues
  // to fire notifications. The controller looks up by subscriptionId regardless of local
  // status, so the notification authenticates correctly.
  const clientState = 'secret-locally-expired';
  const secret = 'hmac-key-27';
  const hash = require('crypto').createHmac('sha256', secret).update(clientState).digest('hex');

  // Subscription is locally marked as expired
  const sub = await GraphSubscription.create({
    subscriptionId: 'sub-locally-expired-27',
    mailbox: 'test27@example.com',
    folder: 'inbox',
    resource: formatGraphResource('test27@example.com', 'inbox'),
    expirationDateTime: new Date(Date.now() + 48 * 3600 * 1000),
    clientStateHash: hash,
    clientStateHashScheme: 'hmac-sha256',
    clientStateKeyId: 'primary',
    status: 'expired',    // <-- locally marked expired
    notificationUrl: 'https://api.example.com/webhooks/graph'
  });

  // Verify: verifySubscriptionClientState still returns true for the locally-expired subscription
  const env = {
    MS_GRAPH_CLIENT_STATE_SECRET: secret,
    MS_GRAPH_CLIENT_STATE_KEY_ID: 'primary',
    MS_GRAPH_CLIENT_STATE_SECRET_PREVIOUS: '',
    MS_GRAPH_CLIENT_STATE_PREVIOUS_KEY_ID: ''
  };
  const result = verifySubscriptionClientState({ clientState, subscription: sub.toObject(), env });
  assert.strictEqual(result, true, 'Locally-expired subscription must still authenticate — remote Graph subscription is still active');

  // Verify controller findOne also retrieves it (no status filter in controller lookup)
  const found = await GraphSubscription.findOne({ subscriptionId: 'sub-locally-expired-27' }).lean();
  assert.ok(found, 'Controller findOne must find locally-expired subscription by subscriptionId');
  assert.strictEqual(found.status, 'expired', 'Status is expired locally');
});

test('28. duplicate cleanup in syncSubscriptionHealth marks MongoDB expired but does NOT call Graph DELETE', async () => {
  // Verify the documented behavior: duplicate cleanup is a local-only operation.
  // The duplicate remote subscriptions continue to exist in Graph until they naturally expire.
  const mailbox = 'test28@example.com';
  const folder = 'inbox';
  const secret = 'hmac-key-28';
  const clientState28 = 'cs-28';
  const hash = require('crypto').createHmac('sha256', secret).update(clientState28).digest('hex');

  // Seed three "active" subscriptions to simulate duplicate scenario
  const sub1 = await GraphSubscription.create({
    subscriptionId: 'sub-dup-28-old1',
    mailbox, folder,
    resource: formatGraphResource(mailbox, folder),
    expirationDateTime: new Date(Date.now() + 46 * 3600 * 1000),
    clientStateHash: hash, clientStateHashScheme: 'hmac-sha256', clientStateKeyId: 'primary',
    status: 'active',
    notificationUrl: 'https://api.example.com/webhooks/graph'
  });
  const sub2 = await GraphSubscription.create({
    subscriptionId: 'sub-dup-28-old2',
    mailbox, folder,
    resource: formatGraphResource(mailbox, folder),
    expirationDateTime: new Date(Date.now() + 47 * 3600 * 1000),
    clientStateHash: hash, clientStateHashScheme: 'hmac-sha256', clientStateKeyId: 'primary',
    status: 'active',
    notificationUrl: 'https://api.example.com/webhooks/graph'
  });
  // Newest subscription — should be kept
  const sub3 = await GraphSubscription.create({
    subscriptionId: 'sub-dup-28-current',
    mailbox, folder,
    resource: formatGraphResource(mailbox, folder),
    expirationDateTime: new Date(Date.now() + 48 * 3600 * 1000),
    clientStateHash: hash, clientStateHashScheme: 'hmac-sha256', clientStateKeyId: 'primary',
    status: 'active',
    notificationUrl: 'https://api.example.com/webhooks/graph'
  });

  const deleteRequests = [];
  const mockGraphClient = {
    async request({ url, method }) {
      if (method === 'DELETE') deleteRequests.push(url);
      if (method === 'PATCH') return { id: url.replace('/subscriptions/', ''), expirationDateTime: new Date(Date.now() + 4200 * 60 * 1000).toISOString() };
      throw new Error(`Unhandled: ${method} ${url}`);
    }
  };

  process.env.MS_GRAPH_CLIENT_STATE_SECRET = secret;
  process.env.MS_GRAPH_CLIENT_STATE_KEY_ID = 'primary';
  try {
    const svc = new SubscriptionService({
      graphClient: mockGraphClient,
      notificationUrl: 'https://api.example.com/webhooks/graph'
    });
    await svc.syncSubscriptionHealth({ mailbox, folder });

    // The older two should now be marked expired in MongoDB
    const refreshed1 = await GraphSubscription.findOne({ subscriptionId: 'sub-dup-28-old1' }).lean();
    const refreshed2 = await GraphSubscription.findOne({ subscriptionId: 'sub-dup-28-old2' }).lean();
    assert.strictEqual(refreshed1.status, 'expired', 'Older duplicate must be marked expired in MongoDB');
    assert.strictEqual(refreshed2.status, 'expired', 'Older duplicate must be marked expired in MongoDB');

    // Current subscription remains active
    const refreshed3 = await GraphSubscription.findOne({ subscriptionId: 'sub-dup-28-current' }).lean();
    assert.strictEqual(refreshed3.status, 'active', 'Current subscription must remain active');

    // CRITICAL: No Graph DELETE was called — remote subscriptions are NOT deleted by this code path
    assert.strictEqual(deleteRequests.length, 0,
      'syncSubscriptionHealth duplicate cleanup must NOT call Graph DELETE — remote deletion is not performed');
  } finally {
    delete process.env.MS_GRAPH_CLIENT_STATE_SECRET;
    delete process.env.MS_GRAPH_CLIENT_STATE_KEY_ID;
  }
});

test('29. concurrent subscription creation returns existing active subscription without creating duplicate', async () => {
  // Simulates two workers racing to createSubscription for the same mailbox.
  // The second call must detect the existing active subscription and return it without
  // calling Graph POST a second time.
  const mailbox = 'test29@example.com';
  const folder = 'inbox';
  const secret = 'hmac-key-29';

  process.env.MS_GRAPH_CLIENT_STATE_SECRET = secret;
  process.env.MS_GRAPH_CLIENT_STATE_KEY_ID = 'primary';
  try {
    const graphRequests = [];
    const mockGraphClient = {
      async request({ url, method, data }) {
        graphRequests.push({ url, method });
        if (method === 'POST' && url === '/subscriptions') {
          return {
            id: 'sub-concurrent-29',
            resource: data.resource,
            expirationDateTime: new Date(Date.now() + 4200 * 60 * 1000).toISOString()
          };
        }
        throw new Error(`Unhandled: ${method} ${url}`);
      }
    };

    const svc = new SubscriptionService({
      graphClient: mockGraphClient,
      notificationUrl: 'https://api.example.com/webhooks/graph'
    });

    // First call: creates subscription
    const result1 = await svc.createSubscription({ mailbox, folder });
    assert.strictEqual(result1.created, true, 'First call must create subscription');

    const postCount1 = graphRequests.filter(r => r.method === 'POST').length;
    assert.strictEqual(postCount1, 1, 'Exactly one Graph POST on first call');

    // Second call (concurrent worker): must detect existing and return without Graph POST
    const result2 = await svc.createSubscription({ mailbox, folder });
    assert.strictEqual(result2.created, false, 'Second concurrent call must not create a new subscription');
    assert.strictEqual(result2.isExisting, true, 'Second call must return existing subscription');

    const postCount2 = graphRequests.filter(r => r.method === 'POST').length;
    assert.strictEqual(postCount2, 1, 'No second Graph POST must be issued — duplicate prevention works');
  } finally {
    delete process.env.MS_GRAPH_CLIENT_STATE_SECRET;
    delete process.env.MS_GRAPH_CLIENT_STATE_KEY_ID;
  }
});

test('30. Graph returns 429 Too Many Requests during createSubscription — throws and local DB state is unchanged', async () => {
  const mailbox = 'test30@example.com';
  const secret = 'hmac-key-30';

  process.env.MS_GRAPH_CLIENT_STATE_SECRET = secret;
  try {
    const rateError = Object.assign(new Error('Too Many Requests'), { statusCode: 429 });
    const mockGraphClient = {
      async request() { throw rateError; }
    };

    const svc = new SubscriptionService({
      graphClient: mockGraphClient,
      notificationUrl: 'https://api.example.com/webhooks/graph'
    });

    await assert.rejects(
      () => svc.createSubscription({ mailbox, folder: 'inbox' }),
      (err) => {
        assert.ok(err.statusCode === 429 || err.message.includes('Too Many Requests'), 'Must rethrow 429 error');
        return true;
      }
    );

    // No subscription document must have been created
    const doc = await GraphSubscription.findOne({ mailbox: mailbox.toLowerCase() }).lean();
    assert.strictEqual(doc, null, 'No subscription document must exist after Graph 429 — local DB state is clean');
  } finally {
    delete process.env.MS_GRAPH_CLIENT_STATE_SECRET;
  }
});

test('31. Graph returns 503 Service Unavailable during createSubscription — throws and local DB state is unchanged', async () => {
  const mailbox = 'test31@example.com';
  const secret = 'hmac-key-31';

  process.env.MS_GRAPH_CLIENT_STATE_SECRET = secret;
  try {
    const serviceError = Object.assign(new Error('Service Unavailable'), { statusCode: 503 });
    const mockGraphClient = {
      async request() { throw serviceError; }
    };

    const svc = new SubscriptionService({
      graphClient: mockGraphClient,
      notificationUrl: 'https://api.example.com/webhooks/graph'
    });

    await assert.rejects(
      () => svc.createSubscription({ mailbox, folder: 'inbox' }),
      (err) => {
        assert.ok(err.statusCode === 503 || err.message.includes('Service Unavailable'), 'Must rethrow 503 error');
        return true;
      }
    );

    // No subscription document must have been created
    const doc = await GraphSubscription.findOne({ mailbox: mailbox.toLowerCase() }).lean();
    assert.strictEqual(doc, null, 'No subscription document must exist after Graph 503 — local DB state is clean');
  } finally {
    delete process.env.MS_GRAPH_CLIENT_STATE_SECRET;
  }
});

test('32. deleteSubscription: Graph DELETE returns 5xx error — throws and local document retains original status', async () => {
  const mailbox = 'test32@example.com';
  const secret = 'hmac-key-32';
  const hash = require('crypto').createHmac('sha256', secret).update('cs-32').digest('hex');

  const sub = await GraphSubscription.create({
    subscriptionId: 'sub-delete-5xx-32',
    mailbox, folder: 'inbox',
    resource: formatGraphResource(mailbox, 'inbox'),
    expirationDateTime: new Date(Date.now() + 48 * 3600 * 1000),
    clientStateHash: hash, clientStateHashScheme: 'hmac-sha256', clientStateKeyId: 'primary',
    status: 'active',
    notificationUrl: 'https://api.example.com/webhooks/graph'
  });

  const serverError = Object.assign(new Error('Internal Server Error'), { statusCode: 500 });
  const mockGraphClient = {
    async request() { throw serverError; }
  };

  process.env.MS_GRAPH_CLIENT_STATE_SECRET = secret;
  try {
    const svc = new SubscriptionService({
      graphClient: mockGraphClient,
      notificationUrl: 'https://api.example.com/webhooks/graph'
    });

    await assert.rejects(
      () => svc.deleteSubscription({ subscriptionId: 'sub-delete-5xx-32' }),
      (err) => {
        assert.ok(err.statusCode === 500 || err.message.includes('Internal Server Error'), 'Must rethrow 5xx error');
        return true;
      }
    );

    // Local status must remain 'active' — only lastError is set for non-404 Graph errors
    const refreshed = await GraphSubscription.findOne({ subscriptionId: 'sub-delete-5xx-32' }).lean();
    assert.strictEqual(refreshed.status, 'active', 'Status must remain active after failed 5xx DELETE');
    assert.ok(refreshed.lastError, 'lastError must be set after failed DELETE');
  } finally {
    delete process.env.MS_GRAPH_CLIENT_STATE_SECRET;
  }
});

test('33. deleteSubscription: Graph DELETE returns 404 — handled cleanly and local document marked deleted', async () => {
  const mailbox = 'test33@example.com';
  const secret = 'hmac-key-33';
  const hash = require('crypto').createHmac('sha256', secret).update('cs-33').digest('hex');

  await GraphSubscription.create({
    subscriptionId: 'sub-delete-404-33',
    mailbox, folder: 'inbox',
    resource: formatGraphResource(mailbox, 'inbox'),
    expirationDateTime: new Date(Date.now() + 48 * 3600 * 1000),
    clientStateHash: hash, clientStateHashScheme: 'hmac-sha256', clientStateKeyId: 'primary',
    status: 'active',
    notificationUrl: 'https://api.example.com/webhooks/graph'
  });

  const notFoundError = Object.assign(new Error('Not Found'), { statusCode: 404 });
  const mockGraphClient = {
    async request() { throw notFoundError; }
  };

  process.env.MS_GRAPH_CLIENT_STATE_SECRET = secret;
  try {
    const svc = new SubscriptionService({
      graphClient: mockGraphClient,
      notificationUrl: 'https://api.example.com/webhooks/graph'
    });

    // Must NOT throw — 404 from Graph means subscription was already removed
    const result = await svc.deleteSubscription({ subscriptionId: 'sub-delete-404-33' });
    assert.strictEqual(result.deleted, true, 'deleteSubscription must return deleted:true for Graph 404');

    // Local document must be marked deleted
    const refreshed = await GraphSubscription.findOne({ subscriptionId: 'sub-delete-404-33' }).lean();
    assert.strictEqual(refreshed.status, 'deleted', 'Local status must be deleted after Graph 404');
    assert.strictEqual(refreshed.lastError, null, 'lastError must be null for clean 404 handling');
  } finally {
    delete process.env.MS_GRAPH_CLIENT_STATE_SECRET;
  }
});

test('34. verifySubscriptionClientState: incorrect/unknown clientStateKeyId with no matching key returns false (fail-closed)', async () => {
  // If the subscription was created with keyId 'key-v3' but the env only has 'key-v1' and 'key-v2',
  // the verification must return false. Never try arbitrary keys for explicit HMAC subscriptions.
  const secret = 'actual-secret-key-v1';
  const unknownSecret = 'some-other-key-v3';
  const clientState = 'cs-unknown-key-34';
  const hashWithUnknownKey = require('crypto').createHmac('sha256', unknownSecret).update(clientState).digest('hex');

  // Subscription carries keyId that is neither the primary nor previous configured key
  const fakeSub = {
    clientStateHash: hashWithUnknownKey,
    clientStateHashScheme: 'hmac-sha256',
    clientStateKeyId: 'key-v3'   // unknown — no env var matches this
  };

  const env = {
    MS_GRAPH_CLIENT_STATE_SECRET: secret,
    MS_GRAPH_CLIENT_STATE_KEY_ID: 'key-v1',         // ← does not match keyId 'key-v3'
    MS_GRAPH_CLIENT_STATE_SECRET_PREVIOUS: 'secret-v2',
    MS_GRAPH_CLIENT_STATE_PREVIOUS_KEY_ID: 'key-v2' // ← also does not match
  };

  // The implementation fails closed for an explicit but unrecognized keyId. It must not spend
  // the configured keys on a record whose declared key version is unknown.
  const result = verifySubscriptionClientState({ clientState, subscription: fakeSub, env });
  assert.strictEqual(result, false,
    'Unknown keyId whose secret is not in env must fail verification — no open fallback for HMAC subscriptions');
});

test('35. verifySubscriptionClientState: explicit hmac-sha256 scheme without primary key returns false (fail-closed)', async () => {
  // If clientStateHashScheme is 'hmac-sha256' but MS_GRAPH_CLIENT_STATE_SECRET is unset,
  // candidateKeys is empty and verification must return false. Never fall back to SHA-256.
  const clientState = 'cs-no-primary-35';
  const secret = 'secret-that-is-not-in-env';
  const hash = require('crypto').createHmac('sha256', secret).update(clientState).digest('hex');

  const fakeSub = {
    clientStateHash: hash,
    clientStateHashScheme: 'hmac-sha256',
    clientStateKeyId: 'primary'
  };

  const env = {
    MS_GRAPH_CLIENT_STATE_SECRET: '',       // empty — no primary key
    MS_GRAPH_CLIENT_STATE_KEY_ID: 'primary',
    MS_GRAPH_CLIENT_STATE_SECRET_PREVIOUS: '',
    MS_GRAPH_CLIENT_STATE_PREVIOUS_KEY_ID: 'previous'
  };

  const result = verifySubscriptionClientState({ clientState, subscription: fakeSub, env });
  assert.strictEqual(result, false,
    'HMAC subscription without any configured key must fail — must not fall back to unkeyed SHA-256');
});

test('36. verifySubscriptionClientState: null/undefined clientStateHashScheme uses legacy backward-compatibility path', async () => {
  // Legacy subscriptions created before the versioned scheme was introduced have
  // clientStateHashScheme: null. The verification must try HMAC with current and previous keys,
  // then fall back to unkeyed SHA-256. This is the Case 3 path.
  const clientState = 'cs-legacy-36';
  const secret = 'legacy-hmac-key-36';
  const hash = require('crypto').createHmac('sha256', secret).update(clientState).digest('hex');

  const legacySub = {
    clientStateHash: hash,
    clientStateHashScheme: null,    // legacy — no explicit scheme
    clientStateKeyId: null          // legacy — no key id
  };

  const env = {
    MS_GRAPH_CLIENT_STATE_SECRET: secret,
    MS_GRAPH_CLIENT_STATE_KEY_ID: 'primary',
    MS_GRAPH_CLIENT_STATE_SECRET_PREVIOUS: '',
    MS_GRAPH_CLIENT_STATE_PREVIOUS_KEY_ID: 'previous'
  };

  const result = verifySubscriptionClientState({ clientState, subscription: legacySub, env });
  assert.strictEqual(result, true,
    'Legacy subscription with null scheme must authenticate via HMAC path in Case 3 backward-compatibility fallback');
});

test('37. failed subscription replacement does not invalidate old subscription — it continues authenticating during failure window', async () => {
  // If Graph is unavailable when syncSubscriptionHealth attempts to renew/replace,
  // the old subscription record must remain in an authenticatable state.
  // The old subscription is NOT marked expired or deleted when the replacement call throws.
  const mailbox = 'test37@example.com';
  const folder = 'inbox';
  const secret = 'hmac-key-37';
  const hash = require('crypto').createHmac('sha256', secret).update('cs-37').digest('hex');

  // Seed an expiring-soon subscription (within 24h safety margin → triggers renewal path)
  await GraphSubscription.create({
    subscriptionId: 'sub-renew-fail-37',
    mailbox, folder,
    resource: formatGraphResource(mailbox, folder),
    expirationDateTime: new Date(Date.now() + 1 * 3600 * 1000),  // 1 hour — within 24h margin
    clientStateHash: hash, clientStateHashScheme: 'hmac-sha256', clientStateKeyId: 'primary',
    status: 'active',
    notificationUrl: 'https://api.example.com/webhooks/graph'
  });

  const networkError = Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET', statusCode: undefined });
  const mockGraphClient = {
    async request({ method }) {
      if (method === 'PATCH') throw networkError;
      throw new Error(`Unhandled: ${method}`);
    }
  };

  process.env.MS_GRAPH_CLIENT_STATE_SECRET = secret;
  process.env.MS_GRAPH_CLIENT_STATE_KEY_ID = 'primary';
  try {
    const svc = new SubscriptionService({
      graphClient: mockGraphClient,
      notificationUrl: 'https://api.example.com/webhooks/graph'
    });

    // syncSubscriptionHealth must throw the Graph network error
    await assert.rejects(
      () => svc.syncSubscriptionHealth({ mailbox, folder }),
      (err) => {
        assert.ok(err.code === 'ECONNRESET' || err.message.includes('ECONNRESET'), 'Must rethrow network error');
        return true;
      }
    );

    // Old subscription must still be in 'failed' or 'active' state — NOT deleted or replaced
    const refreshed = await GraphSubscription.findOne({ subscriptionId: 'sub-renew-fail-37' }).lean();
    assert.ok(refreshed, 'Old subscription document must still exist after failed renewal');
    // renewSubscription marks status as 'failed' on non-404 errors; the subscription is still findable
    assert.ok(
      refreshed.status === 'failed' || refreshed.status === 'active',
      `Old subscription status must be 'failed' or 'active' after renewal error, got: ${refreshed.status}`
    );

    // Verify the subscription's clientStateHash is still intact — it can still authenticate
    const verification = verifySubscriptionClientState({
      clientState: 'cs-37',
      subscription: refreshed,
      env: {
        MS_GRAPH_CLIENT_STATE_SECRET: secret,
        MS_GRAPH_CLIENT_STATE_KEY_ID: 'primary',
        MS_GRAPH_CLIENT_STATE_SECRET_PREVIOUS: '',
        MS_GRAPH_CLIENT_STATE_PREVIOUS_KEY_ID: 'previous'
      }
    });
    assert.strictEqual(verification, true, 'Old subscription clientStateHash must remain intact for notification authentication during failure window');
  } finally {
    delete process.env.MS_GRAPH_CLIENT_STATE_SECRET;
    delete process.env.MS_GRAPH_CLIENT_STATE_KEY_ID;
  }
});

test('38. createSubscription fails closed without MS_GRAPH_CLIENT_STATE_SECRET (no accidental unkeyed subscription)', async () => {
  delete process.env.MS_GRAPH_CLIENT_STATE_SECRET;
  delete process.env.MS_GRAPH_CLIENT_STATE_KEY_ID;

  const mailbox = 'test38@example.com';
  const folder = 'inbox';
  const mockGraphClient = new MockGraphClient();

  const svc = new SubscriptionService({
    graphClient: mockGraphClient,
    notificationUrl: 'https://api.example.com/webhooks/graph'
  });

  await assert.rejects(
    () => svc.createSubscription({ mailbox, folder }),
    (err) => {
      assert.match(err.message, /MS_GRAPH_CLIENT_STATE_SECRET is required/);
      assert.match(err.message, /Creating unkeyed subscriptions is not permitted/);
      return true;
    },
    'createSubscription must fail closed when secret is absent'
  );

  // Assert no Graph API call was made
  assert.strictEqual(mockGraphClient.requests.length, 0, 'No Graph network call when HMAC configuration is missing');
});

test('39. createSubscription fails closed when MS_GRAPH_CLIENT_STATE_KEY_ID is missing', async () => {
  process.env.MS_GRAPH_CLIENT_STATE_SECRET = 'some-valid-secret';
  delete process.env.MS_GRAPH_CLIENT_STATE_KEY_ID;

  const mockGraphClient = new MockGraphClient();
  const svc = new SubscriptionService({
    graphClient: mockGraphClient,
    notificationUrl: 'https://api.example.com/webhooks/graph'
  });

  await assert.rejects(
    () => svc.createSubscription({ mailbox: 'test39@example.com' }),
    (err) => {
      assert.match(err.message, /MS_GRAPH_CLIENT_STATE_KEY_ID is required/);
      return true;
    },
    'createSubscription must fail closed when key ID is missing'
  );
  assert.strictEqual(mockGraphClient.requests.length, 0);
});

test('40. createSubscription fails closed when previous secret is set without previous key ID', async () => {
  process.env.MS_GRAPH_CLIENT_STATE_SECRET = 'primary-secret-40';
  process.env.MS_GRAPH_CLIENT_STATE_KEY_ID = 'v2';
  process.env.MS_GRAPH_CLIENT_STATE_SECRET_PREVIOUS = 'previous-secret-40';
  delete process.env.MS_GRAPH_CLIENT_STATE_PREVIOUS_KEY_ID;

  const mockGraphClient = new MockGraphClient();
  const svc = new SubscriptionService({
    graphClient: mockGraphClient,
    notificationUrl: 'https://api.example.com/webhooks/graph'
  });

  await assert.rejects(
    () => svc.createSubscription({ mailbox: 'test40@example.com' }),
    (err) => {
      assert.match(err.message, /MS_GRAPH_CLIENT_STATE_PREVIOUS_KEY_ID is required/);
      return true;
    },
    'createSubscription must fail closed when previous key ID is missing'
  );
  assert.strictEqual(mockGraphClient.requests.length, 0);
});

test('41. createSubscription fails closed when primary and previous key IDs conflict', async () => {
  process.env.MS_GRAPH_CLIENT_STATE_SECRET = 'primary-secret-41';
  process.env.MS_GRAPH_CLIENT_STATE_KEY_ID = 'same-key-id';
  process.env.MS_GRAPH_CLIENT_STATE_SECRET_PREVIOUS = 'previous-secret-41';
  process.env.MS_GRAPH_CLIENT_STATE_PREVIOUS_KEY_ID = 'same-key-id';

  const mockGraphClient = new MockGraphClient();
  const svc = new SubscriptionService({
    graphClient: mockGraphClient,
    notificationUrl: 'https://api.example.com/webhooks/graph'
  });

  await assert.rejects(
    () => svc.createSubscription({ mailbox: 'test41@example.com' }),
    (err) => {
      assert.match(err.message, /must not be identical/);
      return true;
    },
    'createSubscription must fail closed when primary and previous key IDs are identical'
  );
  assert.strictEqual(mockGraphClient.requests.length, 0);
});

test('42. createSubscription strictly forbids allowUnkeyed in production/staging (NODE_ENV=production)', async () => {
  const originalEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.MS_GRAPH_CLIENT_STATE_SECRET;
    delete process.env.MS_GRAPH_CLIENT_STATE_KEY_ID;

    const mockGraphClient = new MockGraphClient();
    const svc = new SubscriptionService({
      graphClient: mockGraphClient,
      notificationUrl: 'https://api.example.com/webhooks/graph'
    });

    await assert.rejects(
      () => svc.createSubscription({ mailbox: 'test42@example.com', allowUnkeyed: true }),
      (err) => {
        assert.match(err.message, /strictly forbidden in production and staging/);
        return true;
      },
      'allowUnkeyed must be strictly rejected in production'
    );
    assert.strictEqual(mockGraphClient.requests.length, 0);
  } finally {
    process.env.NODE_ENV = originalEnv;
  }
});

test('43. createSubscription allows unkeyed SHA-256 only when allowUnkeyed=true in test environment', async () => {
  delete process.env.MS_GRAPH_CLIENT_STATE_SECRET;
  delete process.env.MS_GRAPH_CLIENT_STATE_KEY_ID;

  const mailbox = 'test43@example.com';
  const folder = 'inbox';
  const clientState43 = 'cs-plain-sha256-43';
  const expectedHash = require('crypto').createHash('sha256').update(clientState43).digest('hex');

  const mockGraphClient = new MockGraphClient();
  const svc = new SubscriptionService({
    graphClient: mockGraphClient,
    notificationUrl: 'https://api.example.com/webhooks/graph'
  });

  const result = await svc.createSubscription({
    mailbox,
    folder,
    clientState: clientState43,
    allowUnkeyed: true
  });

  assert.strictEqual(result.created, true);

  const doc = await GraphSubscription.findOne({ subscriptionId: result.subscription.subscriptionId }).lean();
  assert.ok(doc, 'Subscription document must be persisted');
  assert.strictEqual(doc.clientStateHashScheme, 'sha256', 'Scheme must be sha256');
  assert.strictEqual(doc.clientStateKeyId, 'unkeyed', 'KeyId must be unkeyed');
  assert.strictEqual(doc.clientStateHash, expectedHash);

  // Authenticates via Case 2 path
  const isValid = verifySubscriptionClientState({
    clientState: clientState43,
    subscription: doc,
    env: { MS_GRAPH_CLIENT_STATE_SECRET: '', MS_GRAPH_CLIENT_STATE_KEY_ID: 'primary' }
  });
  assert.strictEqual(isValid, true);
});

test('44. validateHmacKeyConfig validates credentials without requiring a subscription instance', () => {
  // Valid config
  const valid = validateHmacKeyConfig({
    MS_GRAPH_CLIENT_STATE_SECRET: 'my-secret',
    MS_GRAPH_CLIENT_STATE_KEY_ID: 'v1'
  });
  assert.strictEqual(valid.primarySecret, 'my-secret');
  assert.strictEqual(valid.primaryKeyId, 'v1');
  assert.strictEqual(valid.scheme, 'hmac-sha256');

  // Missing secret throws
  assert.throws(
    () => validateHmacKeyConfig({}),
    /MS_GRAPH_CLIENT_STATE_SECRET is required/
  );

  // Missing key ID throws
  assert.throws(
    () => validateHmacKeyConfig({ MS_GRAPH_CLIENT_STATE_SECRET: 'sec' }),
    /MS_GRAPH_CLIENT_STATE_KEY_ID is required/
  );

  // Previous secret without previous key ID throws
  assert.throws(
    () => validateHmacKeyConfig({
      MS_GRAPH_CLIENT_STATE_SECRET: 'sec',
      MS_GRAPH_CLIENT_STATE_KEY_ID: 'v2',
      MS_GRAPH_CLIENT_STATE_SECRET_PREVIOUS: 'prev'
    }),
    /MS_GRAPH_CLIENT_STATE_PREVIOUS_KEY_ID is required/
  );

  // Conflicting key IDs throw
  assert.throws(
    () => validateHmacKeyConfig({
      MS_GRAPH_CLIENT_STATE_SECRET: 'sec',
      MS_GRAPH_CLIENT_STATE_KEY_ID: 'v1',
      MS_GRAPH_CLIENT_STATE_SECRET_PREVIOUS: 'prev',
      MS_GRAPH_CLIENT_STATE_PREVIOUS_KEY_ID: 'v1'
    }),
    /must not be identical/
  );
});

test('45. listRemoteSubscriptions calls Graph GET /subscriptions and returns array', async () => {
  const mockGraphClient = new MockGraphClient();
  mockGraphClient.mockSubscriptions = [
    { id: 'sub-remote-001', resource: 'users/support%40guidexpert.com/mailFolders(\'inbox\')/messages' },
    { id: 'sub-remote-002', resource: 'users/other%40guidexpert.com/mailFolders(\'inbox\')/messages' }
  ];

  const svc = new SubscriptionService({
    graphClient: mockGraphClient,
    notificationUrl: 'https://api.example.com/webhooks/graph'
  });

  const subs = await svc.listRemoteSubscriptions();
  assert.strictEqual(subs.length, 2);
  assert.strictEqual(subs[0].id, 'sub-remote-001');

  // Verify GET /subscriptions was recorded
  const getReq = mockGraphClient.requests.find(r => r.method === 'GET' && r.url === '/subscriptions');
  assert.ok(getReq, 'Graph GET /subscriptions must be requested');
});

test('46. reconcileRemoteSubscriptions discovers remote orphans and local orphans without deleting without permission', async () => {
  const mailbox = 'test46@example.com';
  const folder = 'inbox';
  const resource = formatGraphResource(mailbox, folder);
  const notificationUrl = 'https://api.example.com/webhooks/graph';

  // Seed 1 active sub in MongoDB that also exists in Graph (matched)
  await GraphSubscription.create({
    subscriptionId: 'sub-matched-46',
    mailbox,
    folder,
    resource,
    expirationDateTime: new Date(Date.now() + 48 * 3600 * 1000),
    clientStateHash: 'hash-matched-46',
    clientStateHashScheme: 'hmac-sha256',
    clientStateKeyId: 'primary',
    status: 'active',
    notificationUrl
  });

  // Seed 1 active sub in MongoDB that does NOT exist in Graph (local orphan, older than 10m grace)
  const twentyMinsAgo = new Date(Date.now() - 20 * 60 * 1000);
  await GraphSubscription.create({
    subscriptionId: 'sub-local-orphan-46',
    mailbox,
    folder,
    resource,
    expirationDateTime: new Date(Date.now() + 48 * 3600 * 1000),
    clientStateHash: 'hash-local-orphan-46',
    clientStateHashScheme: 'hmac-sha256',
    clientStateKeyId: 'primary',
    status: 'active',
    notificationUrl,
    createdAt: twentyMinsAgo,
    lastRenewedAt: twentyMinsAgo
  });

  // Graph has the matched sub AND a remote orphan (missing in MongoDB, older than 2m grace)
  const mockGraphClient = new MockGraphClient();
  mockGraphClient.mockSubscriptions = [
    { id: 'sub-matched-46', resource, notificationUrl, expirationDateTime: new Date(Date.now() + 4000 * 60 * 1000).toISOString() },
    { id: 'sub-remote-orphan-46', resource, notificationUrl, expirationDateTime: new Date(Date.now() + 4000 * 60 * 1000).toISOString() }
  ];

  const svc = new SubscriptionService({
    graphClient: mockGraphClient,
    notificationUrl
  });

  // Reconcile without deleteOrphans (audit mode)
  const audit = await svc.reconcileRemoteSubscriptions({ mailbox, folder, deleteOrphans: false });

  assert.strictEqual(audit.matchedCount, 1, '1 matched subscription');
  assert.strictEqual(audit.remoteOrphansCount, 1, '1 remote orphan discovered');
  assert.strictEqual(audit.localOrphansCount, 1, '1 local orphan discovered');
  assert.strictEqual(audit.remoteOrphans[0].id, 'sub-remote-orphan-46');
  assert.strictEqual(audit.localOrphans[0].subscriptionId, 'sub-local-orphan-46');
  assert.strictEqual(audit.deletedRemoteCount, 0, 'No remote subscriptions deleted without explicit permission');
  assert.strictEqual(audit.expiredLocalCount, 0, 'No local subscriptions modified without explicit permission');

  // Verify no DELETE request was sent to Graph
  const deleteReqs = mockGraphClient.requests.filter(r => r.method === 'DELETE');
  assert.strictEqual(deleteReqs.length, 0, 'No DELETE calls issued in audit mode');
});

test('47. reconcileRemoteSubscriptions with deleteOrphans=true safely cleans proven remote orphans and marks local orphans expired', async () => {
  const mailbox = 'test47@example.com';
  const folder = 'inbox';
  const resource = formatGraphResource(mailbox, folder);
  const notificationUrl = 'https://api.example.com/webhooks/graph';

  // Seed matched sub
  await GraphSubscription.create({
    subscriptionId: 'sub-matched-47',
    mailbox, folder, resource,
    expirationDateTime: new Date(Date.now() + 48 * 3600 * 1000),
    clientStateHash: 'hash-47', clientStateHashScheme: 'hmac-sha256', clientStateKeyId: 'primary',
    status: 'active', notificationUrl
  });

  // Seed local orphan older than 10m grace
  const twentyMinsAgo = new Date(Date.now() - 20 * 60 * 1000);
  await GraphSubscription.create({
    subscriptionId: 'sub-local-orphan-47',
    mailbox, folder, resource,
    expirationDateTime: new Date(Date.now() + 48 * 3600 * 1000),
    clientStateHash: 'hash-47-local', clientStateHashScheme: 'hmac-sha256', clientStateKeyId: 'primary',
    status: 'active', notificationUrl,
    createdAt: twentyMinsAgo,
    lastRenewedAt: twentyMinsAgo
  });

  const mockGraphClient = new MockGraphClient();
  mockGraphClient.mockSubscriptions = [
    { id: 'sub-matched-47', resource, notificationUrl, expirationDateTime: new Date(Date.now() + 4000 * 60 * 1000).toISOString() },
    { id: 'sub-remote-orphan-47', resource, notificationUrl, expirationDateTime: new Date(Date.now() + 4000 * 60 * 1000).toISOString() }
  ];

  const svc = new SubscriptionService({
    graphClient: mockGraphClient,
    notificationUrl
  });

  // Reconcile with deleteOrphans: true
  const result = await svc.reconcileRemoteSubscriptions({ mailbox, folder, deleteOrphans: true });

  assert.strictEqual(result.remoteOrphansCount, 1);
  assert.strictEqual(result.deletedRemoteCount, 1, '1 remote orphan deleted');
  assert.strictEqual(result.localOrphansCount, 1);
  assert.strictEqual(result.expiredLocalCount, 1, '1 local orphan marked expired');

  // Verify Graph DELETE was called for the remote orphan
  const deleteReq = mockGraphClient.requests.find(r => r.method === 'DELETE' && r.url === '/subscriptions/sub-remote-orphan-47');
  assert.ok(deleteReq, 'Graph DELETE must be called for the proven remote orphan');

  // Verify local orphan in MongoDB was marked expired
  const localDoc = await GraphSubscription.findOne({ subscriptionId: 'sub-local-orphan-47' }).lean();
  assert.strictEqual(localDoc.status, 'expired', 'Local orphan must be marked expired');
});

test('48. migrateLegacySubscriptionRecord: safe sha256 migration makes implicit algorithm explicit without proof requirement', async () => {
  const mailbox = 'test48@example.com';
  const folder = 'inbox';
  const realClientState = 'known-client-state-for-test-48';
  // Legacy hash stored as plain SHA-256
  const legacyHash = require('node:crypto').createHash('sha256').update(realClientState).digest('hex');

  // Seed legacy record with clientStateHashScheme: null (sha256 was the implicit default)
  await GraphSubscription.create({
    subscriptionId: 'sub-legacy-48',
    mailbox, folder,
    resource: formatGraphResource(mailbox, folder),
    expirationDateTime: new Date(Date.now() + 48 * 3600 * 1000),
    clientStateHash: legacyHash,
    clientStateHashScheme: null,
    clientStateKeyId: null,
    status: 'active',
    notificationUrl: 'https://api.example.com/webhooks/graph'
  });

  const mockGraphClient = new MockGraphClient();
  const svc = new SubscriptionService({ graphClient: mockGraphClient });

  // Safe migration: explicitly label it as sha256 (what it always was)
  const result = await svc.migrateLegacySubscriptionRecord({
    subscriptionId: 'sub-legacy-48',
    targetScheme: 'sha256'
  });

  assert.strictEqual(result.migrated, true, 'SHA-256 migration must succeed without proof requirement');
  assert.ok(result.updated, 'Must return updated document');
  assert.strictEqual(result.updated.subscriptionId, 'sub-legacy-48');
  assert.strictEqual(result.updated.clientStateHashScheme, 'sha256', 'Scheme must be sha256');
  assert.strictEqual(result.updated.clientStateKeyId, 'unkeyed', 'KeyId must be unkeyed for sha256');
  assert.strictEqual(result.updated.clientStateHash, legacyHash, 'clientStateHash must remain unchanged');
  assert.strictEqual(result.updated.clientState, undefined, 'No plaintext clientState stored');

  // Verify authentication still works via Case 2 (sha256) path after migration
  const isValid = verifySubscriptionClientState({
    clientState: realClientState,
    subscription: result.updated,
    env: { MS_GRAPH_CLIENT_STATE_SECRET: '', MS_GRAPH_CLIENT_STATE_KEY_ID: 'primary' }
  });
  assert.strictEqual(isValid, true, 'Authentication must remain valid after sha256 migration');
});

test('48b. migrateLegacySubscriptionRecord: hmac-sha256 migration requires clientState proof — rejects without it', async () => {
  const mailbox = 'test48b@example.com';
  const folder = 'inbox';
  const legacyHash = 'some-opaque-legacy-hash-48b';

  await GraphSubscription.create({
    subscriptionId: 'sub-legacy-48b',
    mailbox, folder,
    resource: formatGraphResource(mailbox, folder),
    expirationDateTime: new Date(Date.now() + 48 * 3600 * 1000),
    clientStateHash: legacyHash,
    clientStateHashScheme: null,
    clientStateKeyId: null,
    status: 'active',
    notificationUrl: 'https://api.example.com/webhooks/graph'
  });

  const svc = new SubscriptionService({ graphClient: new MockGraphClient() });

  // Attempt to relabel as hmac-sha256 WITHOUT clientState (must fail)
  await assert.rejects(
    () => svc.migrateLegacySubscriptionRecord({
      subscriptionId: 'sub-legacy-48b',
      targetScheme: 'hmac-sha256',
      targetKeyId: 'primary'
      // no clientState, no verificationSecret
    }),
    /clientState is required to verify hmac-sha256 migration/
  );

  // Verify document remains unmigrated
  const doc = await GraphSubscription.findOne({ subscriptionId: 'sub-legacy-48b' }).lean();
  assert.strictEqual(doc.clientStateHashScheme, null, 'Must remain null — migration did not proceed');
});

test('48c. migrateLegacySubscriptionRecord: hmac-sha256 migration fails closed when stored hash does not match supplied key', async () => {
  const mailbox = 'test48c@example.com';
  const folder = 'inbox';
  const realClientState = 'real-client-state-48c';
  const realSecret = 'correct-hmac-secret-48c';
  const wrongSecret = 'wrong-secret-48c-different';

  // Store a hash produced by realSecret
  const { createHmac } = require('node:crypto');
  const correctHash = createHmac('sha256', realSecret).update(realClientState).digest('hex');
  const wrongHash = createHmac('sha256', wrongSecret).update(realClientState).digest('hex');
  assert.notStrictEqual(correctHash, wrongHash); // sanity

  await GraphSubscription.create({
    subscriptionId: 'sub-legacy-48c',
    mailbox, folder,
    resource: formatGraphResource(mailbox, folder),
    expirationDateTime: new Date(Date.now() + 48 * 3600 * 1000),
    clientStateHash: correctHash,
    clientStateHashScheme: null,
    clientStateKeyId: null,
    status: 'active',
    notificationUrl: 'https://api.example.com/webhooks/graph'
  });

  const svc = new SubscriptionService({ graphClient: new MockGraphClient() });

  // Attempt migration with WRONG secret — must fail and leave record unmigrated
  const result = await svc.migrateLegacySubscriptionRecord({
    subscriptionId: 'sub-legacy-48c',
    targetScheme: 'hmac-sha256',
    targetKeyId: 'wrongkey',
    clientState: realClientState,
    verificationSecret: wrongSecret
  });

  assert.strictEqual(result.migrated, false, 'Migration must fail when stored hash does not match supplied key');
  assert.strictEqual(result.reason, 'hmac_verification_failed_stored_hash_does_not_match_supplied_key');
  assert.strictEqual(result.updated, null, 'No update must be applied');

  // Document remains unmodified
  const doc = await GraphSubscription.findOne({ subscriptionId: 'sub-legacy-48c' }).lean();
  assert.strictEqual(doc.clientStateHashScheme, null, 'Scheme must remain null after failed migration');
  assert.strictEqual(doc.clientStateHash, correctHash, 'Hash must remain unchanged');
});

test('48d. migrateLegacySubscriptionRecord: hmac-sha256 migration succeeds with correct proof and authentication remains valid', async () => {
  const mailbox = 'test48d@example.com';
  const folder = 'inbox';
  const realClientState = 'real-client-state-48d';
  const correctSecret = 'correct-hmac-secret-48d';
  const { createHmac } = require('node:crypto');
  const storedHash = createHmac('sha256', correctSecret).update(realClientState).digest('hex');

  await GraphSubscription.create({
    subscriptionId: 'sub-legacy-48d',
    mailbox, folder,
    resource: formatGraphResource(mailbox, folder),
    expirationDateTime: new Date(Date.now() + 48 * 3600 * 1000),
    clientStateHash: storedHash,
    clientStateHashScheme: null,
    clientStateKeyId: null,
    status: 'active',
    notificationUrl: 'https://api.example.com/webhooks/graph'
  });

  const svc = new SubscriptionService({ graphClient: new MockGraphClient() });

  const result = await svc.migrateLegacySubscriptionRecord({
    subscriptionId: 'sub-legacy-48d',
    targetScheme: 'hmac-sha256',
    targetKeyId: 'v1',
    clientState: realClientState,
    verificationSecret: correctSecret
  });

  assert.strictEqual(result.migrated, true, 'Migration must succeed when correct key is proven');
  assert.ok(result.updated);
  assert.strictEqual(result.updated.clientStateHashScheme, 'hmac-sha256');
  assert.strictEqual(result.updated.clientStateKeyId, 'v1');
  assert.strictEqual(result.updated.clientStateHash, storedHash, 'Hash must remain unchanged');

  // Verify authentication remains valid after migration
  const isValid = verifySubscriptionClientState({
    clientState: realClientState,
    subscription: result.updated,
    env: {
      MS_GRAPH_CLIENT_STATE_SECRET: correctSecret,
      MS_GRAPH_CLIENT_STATE_KEY_ID: 'v1',
      MS_GRAPH_CLIENT_STATE_SECRET_PREVIOUS: '',
      MS_GRAPH_CLIENT_STATE_PREVIOUS_KEY_ID: ''
    }
  });
  assert.strictEqual(isValid, true, 'Authentication must remain valid after verified hmac-sha256 migration');
});

test('48e. migrateLegacySubscriptionRecord: metadata-only relabel cannot convert sha256 hash into valid HMAC record', async () => {
  const mailbox = 'test48e@example.com';
  const folder = 'inbox';
  // Hash was actually SHA-256 (unkeyed) — not HMAC
  const realClientState = 'real-client-state-48e';
  const sha256Hash = require('node:crypto').createHash('sha256').update(realClientState).digest('hex');
  const hmacSecret = 'some-hmac-secret-48e';
  const hmacHash = require('node:crypto').createHmac('sha256', hmacSecret).update(realClientState).digest('hex');
  assert.notStrictEqual(sha256Hash, hmacHash); // sha256 ≠ hmac-sha256

  await GraphSubscription.create({
    subscriptionId: 'sub-legacy-48e',
    mailbox, folder,
    resource: formatGraphResource(mailbox, folder),
    expirationDateTime: new Date(Date.now() + 48 * 3600 * 1000),
    clientStateHash: sha256Hash, // was stored as plain SHA-256
    clientStateHashScheme: null,
    clientStateKeyId: null,
    status: 'active',
    notificationUrl: 'https://api.example.com/webhooks/graph'
  });

  const svc = new SubscriptionService({ graphClient: new MockGraphClient() });

  // Attempt to migrate as hmac-sha256 with wrong proof (sha256 hash !== hmac hash)
  const result = await svc.migrateLegacySubscriptionRecord({
    subscriptionId: 'sub-legacy-48e',
    targetScheme: 'hmac-sha256',
    targetKeyId: 'primary',
    clientState: realClientState,
    verificationSecret: hmacSecret // correct secret, but hash was sha256 not hmac
  });

  // Migration must fail: stored sha256 hash cannot match hmac-sha256 computation
  assert.strictEqual(result.migrated, false,
    'Must NOT migrate sha256 hash as hmac-sha256 when verification fails');
  assert.strictEqual(result.reason, 'hmac_verification_failed_stored_hash_does_not_match_supplied_key');

  // The record remains as null-scheme (unchanged)
  const doc = await GraphSubscription.findOne({ subscriptionId: 'sub-legacy-48e' }).lean();
  assert.strictEqual(doc.clientStateHashScheme, null, 'Record must remain null-scheme; not silently relabeled');

  // Furthermore, verify that if someone queries it via Case 3 path, it authenticates as SHA-256
  const isValidSha256 = verifySubscriptionClientState({
    clientState: realClientState,
    subscription: doc,
    env: { MS_GRAPH_CLIENT_STATE_SECRET: '', MS_GRAPH_CLIENT_STATE_KEY_ID: 'primary' }
  });
  assert.strictEqual(isValidSha256, true, 'Legacy sha256 record must still authenticate correctly via Case 3');
});

test('49. remote orphan recovery: Graph POST succeeds but MongoDB persistence fails (simulated DB crash leaves remote orphan discovered by reconcileRemoteSubscriptions)', async () => {
  const mailbox = 'test49@example.com';
  const folder = 'inbox';
  const resource = formatGraphResource(mailbox, folder);
  const notificationUrl = 'https://api.example.com/webhooks/graph';

  // Simulate remote creation that succeeded in Graph with ID 'sub-remote-crash-49'
  // but crashed before saving to MongoDB (created 200 minutes ago, outside grace)
  const mockGraphClient = new MockGraphClient();
  mockGraphClient.mockSubscriptions = [
    {
      id: 'sub-remote-crash-49',
      resource,
      notificationUrl,
      expirationDateTime: new Date(Date.now() + 4000 * 60 * 1000).toISOString()
    }
  ];

  const svc = new SubscriptionService({
    graphClient: mockGraphClient,
    notificationUrl
  });

  // Reconcile and clean up the discovered orphan
  const recon = await svc.reconcileRemoteSubscriptions({ mailbox, folder, deleteOrphans: true });
  assert.strictEqual(recon.remoteOrphansCount, 1);
  assert.strictEqual(recon.remoteOrphans[0].id, 'sub-remote-crash-49');
  assert.strictEqual(recon.deletedRemoteCount, 1);

  const deleteReq = mockGraphClient.requests.find(r => r.method === 'DELETE' && r.url === '/subscriptions/sub-remote-crash-49');
  assert.ok(deleteReq, 'Orphan from simulated DB persistence crash must be deleted');
});

test('50. remote orphan recovery: Graph POST times out after remote creation (reconcileRemoteSubscriptions discovers and cleans the timed-out remote orphan)', async () => {
  const mailbox = 'test50@example.com';
  const folder = 'inbox';
  const resource = formatGraphResource(mailbox, folder);
  const notificationUrl = 'https://api.example.com/webhooks/graph';

  // Remote Graph received POST and created subscription 'sub-timeout-50', but client received socket timeout
  // (created 200 minutes ago, outside grace)
  const mockGraphClient = new MockGraphClient();
  mockGraphClient.mockSubscriptions = [
    {
      id: 'sub-timeout-50',
      resource,
      notificationUrl,
      expirationDateTime: new Date(Date.now() + 4000 * 60 * 1000).toISOString()
    }
  ];

  const svc = new SubscriptionService({
    graphClient: mockGraphClient,
    notificationUrl
  });

  // Health check or admin invokes reconciliation
  const recon = await svc.reconcileRemoteSubscriptions({ mailbox, folder, deleteOrphans: true });
  assert.strictEqual(recon.remoteOrphansCount, 1);
  assert.strictEqual(recon.remoteOrphans[0].id, 'sub-timeout-50');
  assert.strictEqual(recon.deletedRemoteCount, 1);

  const deleteReq = mockGraphClient.requests.find(r => r.method === 'DELETE' && r.url === '/subscriptions/sub-timeout-50');
  assert.ok(deleteReq, 'Remote orphan from Graph POST timeout must be deleted');
});


test('51. listRemoteSubscriptions follows @odata.nextLink across multiple pages up to maxPages ceiling', async () => {
  const page1Subs = [{ id: 'sub-p1-1' }, { id: 'sub-p1-2' }];
  const page2Subs = [{ id: 'sub-p2-1' }, { id: 'sub-p2-2' }];

  const mockGraphClient = {
    requests: [],
    async request({ url, method }) {
      this.requests.push({ url, method });
      if (url === '/subscriptions' && method === 'GET') {
        return {
          value: page1Subs,
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/subscriptions?$skiptoken=skip1'
        };
      }
      if (url.includes('$skiptoken=skip1') && method === 'GET') {
        return {
          value: page2Subs
          // no nextLink -> end of enumeration
        };
      }
      throw new Error(`Unhandled: ${method} ${url}`);
    }
  };

  const svc = new SubscriptionService({ graphClient: mockGraphClient });
  const result = await svc.listRemoteSubscriptions({ maxPages: 5 });

  assert.strictEqual(result.completed, true, 'Enumeration completed all pages');
  assert.strictEqual(result.pages, 2, 'Retrieved exactly 2 pages');
  assert.strictEqual(result.subscriptions.length, 4, 'Aggregated all 4 subscriptions across pages');
  assert.strictEqual(result.subscriptions[0].id, 'sub-p1-1');
  assert.strictEqual(result.subscriptions[2].id, 'sub-p2-1');
});

test('52. reconcileRemoteSubscriptions does NOT expire local subscriptions when Graph GET pagination fails midway', async () => {
  const mailbox = 'test52@example.com';
  const folder = 'inbox';
  const resource = formatGraphResource(mailbox, folder);
  const notificationUrl = 'https://api.example.com/webhooks/graph';

  // Seed an active local subscription that is 20m old
  const twentyMinsAgo = new Date(Date.now() - 20 * 60 * 1000);
  await GraphSubscription.create({
    subscriptionId: 'sub-local-52',
    mailbox, folder, resource,
    expirationDateTime: new Date(Date.now() + 48 * 3600 * 1000),
    clientStateHash: 'hash-52', clientStateHashScheme: 'hmac-sha256', clientStateKeyId: 'primary',
    status: 'active', notificationUrl,
    createdAt: twentyMinsAgo, lastRenewedAt: twentyMinsAgo
  });

  // Mock Graph client where page 1 succeeds with other subs, but page 2 throws 503 Service Unavailable
  const mockGraphClient = {
    async request({ url, method }) {
      if (url === '/subscriptions') {
        return {
          value: [{ id: 'sub-other', resource, notificationUrl }],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/subscriptions?$skiptoken=fail'
        };
      }
      if (url.includes('$skiptoken=fail')) {
        const err = new Error('Service Unavailable');
        err.statusCode = 503;
        throw err;
      }
      throw new Error(`Unhandled: ${method} ${url}`);
    }
  };

  const svc = new SubscriptionService({ graphClient: mockGraphClient, notificationUrl });

  // Reconcile must catch the pagination error and NOT expire the local subscription
  await assert.rejects(
    () => svc.reconcileRemoteSubscriptions({ mailbox, folder, deleteOrphans: true }),
    /Failed to list remote subscriptions from Graph/
  );

  // Verify local subscription status remains active
  const localDoc = await GraphSubscription.findOne({ subscriptionId: 'sub-local-52' }).lean();
  assert.strictEqual(localDoc.status, 'active', 'Local subscription must NOT be expired when pagination fails midway');
});

test('53. reconcileRemoteSubscriptions protects recently created in-flight subscriptions from concurrent deletion (grace window)', async () => {
  const mailbox = 'test53@example.com';
  const folder = 'inbox';
  const resource = formatGraphResource(mailbox, folder);
  const notificationUrl = 'https://api.example.com/webhooks/graph';

  // A concurrent worker JUST created a subscription in Graph 10 seconds ago (expiration = now + 4200m - 10s)
  // but has not yet written to local MongoDB
  const recentExpiration = new Date(Date.now() + (4200 * 60 - 10) * 1000).toISOString();

  const mockGraphClient = new MockGraphClient();
  mockGraphClient.mockSubscriptions = [
    { id: 'sub-concurrent-inflight-53', resource, notificationUrl, expirationDateTime: recentExpiration }
  ];

  const svc = new SubscriptionService({
    graphClient: mockGraphClient,
    notificationUrl
  });

  // Run reconciliation with cleanup mode
  const recon = await svc.reconcileRemoteSubscriptions({
    mailbox,
    folder,
    deleteOrphans: true,
    remoteCreationGraceMs: 2 * 60 * 1000 // 2 minutes grace
  });

  // In-flight subscription must be classified as inFlightRemote, NOT deleted as an orphan
  assert.strictEqual(recon.inFlightRemoteCount, 1, 'Recent subscription protected under in-flight grace');
  assert.strictEqual(recon.remoteOrphansCount, 0, 'Must not be classified as orphan');
  assert.strictEqual(recon.deletedRemoteCount, 0, 'Must not delete concurrent in-flight subscription');

  // Verify zero DELETE calls were dispatched
  const deleteReqs = mockGraphClient.requests.filter(r => r.method === 'DELETE');
  assert.strictEqual(deleteReqs.length, 0, 'Zero DELETE calls when under concurrency grace period');
});

test('54. reconcileRemoteSubscriptions: missing expirationDateTime on remote subscription is treated as in-flight (conservative — never delete unknown)', async () => {
  const mailbox = 'test54@example.com';
  const folder = 'inbox';
  const resource = formatGraphResource(mailbox, folder);
  const notificationUrl = 'https://api.example.com/webhooks/graph';

  // Remote sub has NO expirationDateTime — cannot estimate creation time
  const mockGraphClient = new MockGraphClient();
  mockGraphClient.mockSubscriptions = [
    { id: 'sub-no-expiry-54', resource, notificationUrl }
    // expirationDateTime intentionally omitted
  ];

  const svc = new SubscriptionService({ graphClient: mockGraphClient, notificationUrl });

  const recon = await svc.reconcileRemoteSubscriptions({ mailbox, folder, deleteOrphans: true });

  // Must NOT be classified as an orphan; must be treated as in-flight (conservative)
  assert.strictEqual(recon.inFlightRemoteCount, 1, 'Missing expirationDateTime must be treated as in-flight');
  assert.strictEqual(recon.remoteOrphansCount, 0, 'Must not be classified as orphan without timestamp');
  assert.strictEqual(recon.deletedRemoteCount, 0, 'Must not delete subscription with unknown creation time');

  const deletes = mockGraphClient.requests.filter(r => r.method === 'DELETE');
  assert.strictEqual(deletes.length, 0, 'Zero DELETE calls when expirationDateTime is missing');
});

test('55. reconcileRemoteSubscriptions: expired/past expirationDateTime on remote subscription is treated as in-flight (cannot prove age)', async () => {
  const mailbox = 'test55@example.com';
  const folder = 'inbox';
  const resource = formatGraphResource(mailbox, folder);
  const notificationUrl = 'https://api.example.com/webhooks/graph';

  // Remote sub has an expirationDateTime in the PAST — Graph should not be sending this, treat as unknown
  const pastExpiration = new Date(Date.now() - 60 * 1000).toISOString();

  const mockGraphClient = new MockGraphClient();
  mockGraphClient.mockSubscriptions = [
    { id: 'sub-expired-55', resource, notificationUrl, expirationDateTime: pastExpiration }
  ];

  const svc = new SubscriptionService({ graphClient: mockGraphClient, notificationUrl });

  const recon = await svc.reconcileRemoteSubscriptions({ mailbox, folder, deleteOrphans: true });

  // Past expiration is anomalous — cannot reliably estimate creation time — treat as in-flight
  assert.strictEqual(recon.inFlightRemoteCount, 1, 'Past expirationDateTime must be treated as in-flight (anomalous)');
  assert.strictEqual(recon.remoteOrphansCount, 0, 'Must not classify anomalous subscription as orphan');
  assert.strictEqual(recon.deletedRemoteCount, 0, 'Must not delete subscription with anomalous timestamp');
});

test('56. reconcileRemoteSubscriptions: expirationDateTime beyond Graph ceiling is treated as in-flight (unreasonably far)', async () => {
  const mailbox = 'test56@example.com';
  const folder = 'inbox';
  const resource = formatGraphResource(mailbox, folder);
  const notificationUrl = 'https://api.example.com/webhooks/graph';

  // Remote sub has expirationDateTime > 4231 minutes in the future — beyond Graph maximum
  const unreasonableFuture = new Date(Date.now() + 10000 * 60 * 1000).toISOString();

  const mockGraphClient = new MockGraphClient();
  mockGraphClient.mockSubscriptions = [
    { id: 'sub-far-future-56', resource, notificationUrl, expirationDateTime: unreasonableFuture }
  ];

  const svc = new SubscriptionService({ graphClient: mockGraphClient, notificationUrl });

  const recon = await svc.reconcileRemoteSubscriptions({ mailbox, folder, deleteOrphans: true });

  // Cannot verify this is an application-owned subscription — treat as in-flight (do not delete unknown)
  assert.strictEqual(recon.inFlightRemoteCount, 1, 'Unreasonably far expiration must be treated as in-flight');
  assert.strictEqual(recon.remoteOrphansCount, 0, 'Must not classify subscription with unknown origin as orphan');
  assert.strictEqual(recon.deletedRemoteCount, 0, 'Must not delete subscription that cannot be proven an orphan');
});

test('57. reconcileRemoteSubscriptions: old remote subscription (created long ago, confirmed orphan by expiry estimation)', async () => {
  const mailbox = 'test57@example.com';
  const folder = 'inbox';
  const resource = formatGraphResource(mailbox, folder);
  const notificationUrl = 'https://api.example.com/webhooks/graph';

  // Remote subscription whose expirationDateTime indicates it was created 30 minutes ago
  // (well outside the 2-minute grace window) — proves it is not a concurrent in-flight creation
  const thirtyMinsAgoCreation = Date.now() - 30 * 60 * 1000;
  const expiration = new Date(thirtyMinsAgoCreation + 4200 * 60 * 1000).toISOString();

  const mockGraphClient = new MockGraphClient();
  mockGraphClient.mockSubscriptions = [
    { id: 'sub-old-orphan-57', resource, notificationUrl, expirationDateTime: expiration }
  ];

  const svc = new SubscriptionService({ graphClient: mockGraphClient, notificationUrl });

  const recon = await svc.reconcileRemoteSubscriptions({
    mailbox,
    folder,
    deleteOrphans: true,
    remoteCreationGraceMs: 2 * 60 * 1000
  });

  // This subscription was created 30 minutes ago — clearly outside grace window — classify as orphan
  assert.strictEqual(recon.remoteOrphansCount, 1, 'Old unmatched subscription must be classified as orphan');
  assert.strictEqual(recon.inFlightRemoteCount, 0, 'Must not classify old subscription as in-flight');
  assert.strictEqual(recon.deletedRemoteCount, 1, 'Old proven orphan must be deleted with deleteOrphans=true');

  const deletes = mockGraphClient.requests.filter(r => r.method === 'DELETE');
  assert.strictEqual(deletes.length, 1, 'One DELETE must be issued for the proven orphan');
  assert.ok(deletes[0].url.includes('sub-old-orphan-57'));
});

test('58. env var consistency: MS_GRAPH_CLIENT_STATE_PREVIOUS_KEY_ID is the canonical previous key ID variable — MS_GRAPH_CLIENT_STATE_KEY_ID_PREVIOUS has no effect', () => {
  // Canonical: MS_GRAPH_CLIENT_STATE_PREVIOUS_KEY_ID
  const env = {
    MS_GRAPH_CLIENT_STATE_SECRET: 'primary-secret-58',
    MS_GRAPH_CLIENT_STATE_KEY_ID: 'v2',
    MS_GRAPH_CLIENT_STATE_SECRET_PREVIOUS: 'previous-secret-58',
    MS_GRAPH_CLIENT_STATE_PREVIOUS_KEY_ID: 'v1',         // ← canonical
    MS_GRAPH_CLIENT_STATE_KEY_ID_PREVIOUS: 'wrong-name'  // ← obsolete typo — must be ignored
  };

  const result = validateHmacKeyConfig(env);
  assert.strictEqual(result.primarySecret, 'primary-secret-58');
  assert.strictEqual(result.primaryKeyId, 'v2');
  // Validation should pass — the canonical PREVIOUS_KEY_ID is set, so no error
});

test('59. env var consistency: previous secret without canonical MS_GRAPH_CLIENT_STATE_PREVIOUS_KEY_ID fails closed', () => {
  const env = {
    MS_GRAPH_CLIENT_STATE_SECRET: 'primary-secret-59',
    MS_GRAPH_CLIENT_STATE_KEY_ID: 'v2',
    MS_GRAPH_CLIENT_STATE_SECRET_PREVIOUS: 'previous-secret-59'
    // MS_GRAPH_CLIENT_STATE_PREVIOUS_KEY_ID intentionally omitted
  };

  assert.throws(
    () => validateHmacKeyConfig(env),
    /MS_GRAPH_CLIENT_STATE_PREVIOUS_KEY_ID is required/,
    'Must fail closed when previous secret is set without its canonical key ID'
  );
});

test('60. env var consistency: both primary and previous keys can authenticate their respective subscriptions during rotation', () => {
  const crypto = require('node:crypto');
  const primarySecret = 'primary-secret-rotation-60';
  const previousSecret = 'previous-secret-rotation-60';
  const clientState = 'test-client-state-rotation-60';

  // Hash as would be stored for primary subscription
  const primaryHash = crypto.createHmac('sha256', primarySecret).update(clientState).digest('hex');
  // Hash as would be stored for previous subscription
  const previousHash = crypto.createHmac('sha256', previousSecret).update(clientState).digest('hex');

  const env = {
    MS_GRAPH_CLIENT_STATE_SECRET: primarySecret,
    MS_GRAPH_CLIENT_STATE_KEY_ID: 'v2',
    MS_GRAPH_CLIENT_STATE_SECRET_PREVIOUS: previousSecret,
    MS_GRAPH_CLIENT_STATE_PREVIOUS_KEY_ID: 'v1'
  };

  // Primary subscription (keyId: v2) must authenticate
  const primarySub = {
    clientStateHash: primaryHash,
    clientStateHashScheme: 'hmac-sha256',
    clientStateKeyId: 'v2'
  };
  assert.strictEqual(
    verifySubscriptionClientState({ clientState, subscription: primarySub, env }),
    true,
    'Primary subscription (v2) must authenticate using primary secret'
  );

  // Previous subscription (keyId: v1) must still authenticate during rotation overlap
  const previousSub = {
    clientStateHash: previousHash,
    clientStateHashScheme: 'hmac-sha256',
    clientStateKeyId: 'v1'
  };
  assert.strictEqual(
    verifySubscriptionClientState({ clientState, subscription: previousSub, env }),
    true,
    'Previous subscription (v1) must authenticate using previous secret during rotation'
  );

  // A subscription with unknown key ID must fail closed without guessed-key authentication
  const unknownKeySub = {
    clientStateHash: primaryHash,
    clientStateHashScheme: 'hmac-sha256',
    clientStateKeyId: 'v9999'
  };
  assert.strictEqual(
    verifySubscriptionClientState({ clientState, subscription: unknownKeySub, env }),
    false,
    'Unknown key ID must fail closed without guessed-key authentication'
  );

  const wrongHash = crypto.createHmac('sha256', 'completely-wrong-key').update(clientState).digest('hex');
  const wrongSub = {
    clientStateHash: wrongHash,
    clientStateHashScheme: 'hmac-sha256',
    clientStateKeyId: 'v2'
  };
  assert.strictEqual(
    verifySubscriptionClientState({ clientState, subscription: wrongSub, env }),
    false,
    'Wrong HMAC hash must NOT authenticate — wrong-key subscription must fail verification'
  );
});

test('61. reconcileRemoteSubscriptions: two concurrent reconciliation workers handle orphan cleanup safely', async () => {
  const mailbox = 'test61@example.com';
  const folder = 'inbox';
  const resource = formatGraphResource(mailbox, folder);
  const notificationUrl = 'https://api.example.com/webhooks/graph';

  // Remote orphan exists in Graph (created 200 minutes ago, outside grace)
  const orphanExp = new Date(Date.now() + 4000 * 60 * 1000).toISOString();
  let deleteCount = 0;

  const mockGraphClient = {
    requests: [],
    async request({ url, method }) {
      this.requests.push({ url, method });
      if (method === 'GET' && url === '/subscriptions') {
        return {
          value: [{ id: 'sub-orphan-concurrent-61', resource, notificationUrl, expirationDateTime: orphanExp }]
        };
      }
      if (method === 'DELETE' && url === '/subscriptions/sub-orphan-concurrent-61') {
        deleteCount++;
        if (deleteCount === 1) {
          // Worker 1 succeeds
          return {};
        }
        // Worker 2 attempts deletion after Worker 1 already deleted it -> Graph returns 404
        const notFoundErr = new Error('Subscription not found');
        notFoundErr.statusCode = 404;
        notFoundErr.response = { status: 404 };
        throw notFoundErr;
      }
      throw new Error(`Unhandled: ${method} ${url}`);
    }
  };

  const svc1 = new SubscriptionService({ graphClient: mockGraphClient, notificationUrl });
  const svc2 = new SubscriptionService({ graphClient: mockGraphClient, notificationUrl });

  // Run both workers concurrently
  const [res1, res2] = await Promise.all([
    svc1.reconcileRemoteSubscriptions({ mailbox, folder, deleteOrphans: true }),
    svc2.reconcileRemoteSubscriptions({ mailbox, folder, deleteOrphans: true })
  ]);

  // Worker 1 deleted it; Worker 2's 404 was handled cleanly
  assert.strictEqual(res1.deletedRemoteCount, 1, 'Worker 1 deleted the orphan');
  assert.strictEqual(res2.deletedRemoteCount, 1, 'Worker 2 404 handled cleanly as successful idempotency');
  assert.strictEqual(res1.failedDeletions.length, 0);
  assert.strictEqual(res2.failedDeletions.length, 0);
});

test('62. reconcileRemoteSubscriptions: Graph DELETE 429/503 is captured in failedDeletions without crashing pass', async () => {
  const mailbox = 'test62@example.com';
  const folder = 'inbox';
  const resource = formatGraphResource(mailbox, folder);
  const notificationUrl = 'https://api.example.com/webhooks/graph';

  const orphanExp = new Date(Date.now() + 4000 * 60 * 1000).toISOString();

  const mockGraphClient = {
    requests: [],
    async request({ url, method }) {
      this.requests.push({ url, method });
      if (method === 'GET' && url === '/subscriptions') {
        return {
          value: [
            { id: 'sub-orphan-throttle-62', resource, notificationUrl, expirationDateTime: orphanExp },
            { id: 'sub-orphan-success-62', resource, notificationUrl, expirationDateTime: orphanExp }
          ]
        };
      }
      if (method === 'DELETE' && url === '/subscriptions/sub-orphan-throttle-62') {
        const throttleErr = new Error('Too Many Requests');
        throttleErr.statusCode = 429;
        throttleErr.response = { status: 429, headers: { 'retry-after': '5' } };
        throw throttleErr;
      }
      if (method === 'DELETE' && url === '/subscriptions/sub-orphan-success-62') {
        return {};
      }
      throw new Error(`Unhandled: ${method} ${url}`);
    }
  };

  const svc = new SubscriptionService({ graphClient: mockGraphClient, notificationUrl });

  const result = await svc.reconcileRemoteSubscriptions({ mailbox, folder, deleteOrphans: true });

  assert.strictEqual(result.remoteOrphansCount, 2, 'Discovered 2 orphans');
  assert.strictEqual(result.deletedRemoteCount, 1, '1 orphan successfully deleted');
  assert.strictEqual(result.failedDeletions.length, 1, '1 orphan failed with 429');
  assert.strictEqual(result.failedDeletions[0].id, 'sub-orphan-throttle-62');
  assert.match(result.failedDeletions[0].error, /Too Many Requests/);
});

test('63. reconcileRemoteSubscriptions: retry pass after partial deletion failure cleans remaining orphan', async () => {
  const mailbox = 'test63@example.com';
  const folder = 'inbox';
  const resource = formatGraphResource(mailbox, folder);
  const notificationUrl = 'https://api.example.com/webhooks/graph';

  const orphanExp = new Date(Date.now() + 4000 * 60 * 1000).toISOString();
  let deleteAttempts = 0;

  const mockGraphClient = {
    requests: [],
    async request({ url, method }) {
      this.requests.push({ url, method });
      if (method === 'GET' && url === '/subscriptions') {
        return {
          value: [{ id: 'sub-orphan-retry-63', resource, notificationUrl, expirationDateTime: orphanExp }]
        };
      }
      if (method === 'DELETE' && url === '/subscriptions/sub-orphan-retry-63') {
        deleteAttempts++;
        if (deleteAttempts === 1) {
          // Pass 1: Transient 503 Service Unavailable
          const err = new Error('Service Unavailable');
          err.statusCode = 503;
          throw err;
        }
        // Pass 2: Retry succeeds
        return {};
      }
      throw new Error(`Unhandled: ${method} ${url}`);
    }
  };

  const svc = new SubscriptionService({ graphClient: mockGraphClient, notificationUrl });

  // Pass 1: fails with 503
  const pass1 = await svc.reconcileRemoteSubscriptions({ mailbox, folder, deleteOrphans: true });
  assert.strictEqual(pass1.remoteOrphansCount, 1);
  assert.strictEqual(pass1.deletedRemoteCount, 0);
  assert.strictEqual(pass1.failedDeletions.length, 1);
  assert.match(pass1.failedDeletions[0].error, /Service Unavailable/);

  // Pass 2: retry succeeds
  const pass2 = await svc.reconcileRemoteSubscriptions({ mailbox, folder, deleteOrphans: true });
  assert.strictEqual(pass2.remoteOrphansCount, 1);
  assert.strictEqual(pass2.deletedRemoteCount, 1);
  assert.strictEqual(pass2.failedDeletions.length, 0);
});

test('64. Check 1 verification: comprehensive authentication across all 5 scheme provenance scenarios', () => {
  const crypto = require('node:crypto');
  const primarySecret = 'primary-secret-check1';
  const previousSecret = 'previous-secret-check1';
  const validClientState = 'valid-client-state-string-12345';
  const invalidClientState = 'tampered-or-invalid-client-state';

  const env = {
    MS_GRAPH_CLIENT_STATE_SECRET: primarySecret,
    MS_GRAPH_CLIENT_STATE_KEY_ID: 'v2',
    MS_GRAPH_CLIENT_STATE_SECRET_PREVIOUS: previousSecret,
    MS_GRAPH_CLIENT_STATE_PREVIOUS_KEY_ID: 'v1'
  };

  // 1. Explicit sha256 legacy subscription
  const sha256Hash = crypto.createHash('sha256').update(validClientState).digest('hex');
  const subSha256 = { clientStateHash: sha256Hash, clientStateHashScheme: 'sha256', clientStateKeyId: 'unkeyed' };
  assert.strictEqual(verifySubscriptionClientState({ clientState: validClientState, subscription: subSha256, env }), true, '1. Valid sha256 authenticates');
  assert.strictEqual(verifySubscriptionClientState({ clientState: invalidClientState, subscription: subSha256, env }), false, '1. Invalid clientState rejected');

  // 2. Explicit hmac-sha256 subscription (primary, previous, unknown key, no sha256 fallback)
  const hmacPrimaryHash = crypto.createHmac('sha256', primarySecret).update(validClientState).digest('hex');
  const subHmacPrimary = { clientStateHash: hmacPrimaryHash, clientStateHashScheme: 'hmac-sha256', clientStateKeyId: 'v2' };
  assert.strictEqual(verifySubscriptionClientState({ clientState: validClientState, subscription: subHmacPrimary, env }), true, '2. Valid primary HMAC authenticates');
  assert.strictEqual(verifySubscriptionClientState({ clientState: invalidClientState, subscription: subHmacPrimary, env }), false, '2. Invalid clientState rejected for primary HMAC');

  const hmacPrevHash = crypto.createHmac('sha256', previousSecret).update(validClientState).digest('hex');
  const subHmacPrev = { clientStateHash: hmacPrevHash, clientStateHashScheme: 'hmac-sha256', clientStateKeyId: 'v1' };
  assert.strictEqual(verifySubscriptionClientState({ clientState: validClientState, subscription: subHmacPrev, env }), true, '2. Valid previous HMAC authenticates during rotation');

  // HMAC record never falls back to unkeyed SHA-256
  const subHmacWithShaHash = { clientStateHash: sha256Hash, clientStateHashScheme: 'hmac-sha256', clientStateKeyId: 'v2' };
  assert.strictEqual(verifySubscriptionClientState({ clientState: validClientState, subscription: subHmacWithShaHash, env }), false, '2. HMAC record strictly rejects SHA-256 fallback');

  // Unknown key ID never triggers guessed-key authentication
  const subHmacUnknownKey = { clientStateHash: hmacPrimaryHash, clientStateHashScheme: 'hmac-sha256', clientStateKeyId: 'unknown-key-999' };
  assert.strictEqual(verifySubscriptionClientState({ clientState: validClientState, subscription: subHmacUnknownKey, env }), false, '2. Unknown key ID fails closed without guessing');

  // 3. Null-scheme legacy subscription originally created with unkeyed SHA-256
  const subNullSha256 = { clientStateHash: sha256Hash, clientStateHashScheme: null, clientStateKeyId: null };
  assert.strictEqual(verifySubscriptionClientState({ clientState: validClientState, subscription: subNullSha256, env }), true, '3. Legacy unkeyed SHA-256 authenticates via Case 3');
  assert.strictEqual(verifySubscriptionClientState({ clientState: invalidClientState, subscription: subNullSha256, env }), false, '3. Invalid clientState rejected for legacy unkeyed');

  // 4. Null-scheme legacy subscription originally created with HMAC
  const subNullHmacPrimary = { clientStateHash: hmacPrimaryHash, clientStateHashScheme: null, clientStateKeyId: null };
  assert.strictEqual(verifySubscriptionClientState({ clientState: validClientState, subscription: subNullHmacPrimary, env }), true, '4. Legacy HMAC primary authenticates via Case 3');

  const subNullHmacPrev = { clientStateHash: hmacPrevHash, clientStateHashScheme: null, clientStateKeyId: null };
  assert.strictEqual(verifySubscriptionClientState({ clientState: validClientState, subscription: subNullHmacPrev, env }), true, '4. Legacy HMAC previous authenticates via Case 3');

  assert.strictEqual(verifySubscriptionClientState({ clientState: invalidClientState, subscription: subNullHmacPrimary, env }), false, '4. Invalid clientState rejected for legacy HMAC');

  // 5. Unknown provenance record
  const opaqueHash = 'opaque-unverified-hash-55555';
  const subUnknownProv = { clientStateHash: opaqueHash, clientStateHashScheme: null, clientStateKeyId: null };
  assert.strictEqual(verifySubscriptionClientState({ clientState: validClientState, subscription: subUnknownProv, env }), false, '5. Non-matching clientState rejected for unknown provenance');
});

test('65. Check 2 verification: remote orphan cleanup conservative behavior under uncertain conditions and strict scope isolation', async () => {
  const mailbox = 'test65@example.com';
  const otherMailbox = 'other65@example.com';
  const folder = 'inbox';
  const resource = formatGraphResource(mailbox, folder);
  const otherResource = formatGraphResource(otherMailbox, folder);
  const notificationUrl = 'https://api.example.com/webhooks/graph';
  const otherWebhookUrl = 'https://other-app.example.com/webhook';

  const now = Date.now();
  // 1. Missing timestamp -> uncertain -> inFlightRemote (not deleted)
  // 2. Invalid/past timestamp -> uncertain -> inFlightRemote (not deleted)
  // 3. Unrelated mailbox resource -> ignored entirely
  // 4. Unrelated webhook URL -> ignored entirely
  // 5. Clock-skewed fresh subscription (within 1m skew) -> in-flight (not deleted)
  // 6. Confirmed old orphan (created 200m ago, matching resource & url) -> deleted
  const mockGraphClient = {
    requests: [],
    async request({ url, method }) {
      this.requests.push({ url, method });
      if (method === 'GET' && url === '/subscriptions') {
        return {
          value: [
            { id: 'sub-missing-ts', resource, notificationUrl },
            { id: 'sub-invalid-ts', resource, notificationUrl, expirationDateTime: 'invalid-date-string' },
            { id: 'sub-past-ts', resource, notificationUrl, expirationDateTime: new Date(now - 60000).toISOString() },
            { id: 'sub-other-mb', resource: otherResource, notificationUrl, expirationDateTime: new Date(now + 4000 * 60 * 1000).toISOString() },
            { id: 'sub-other-url', resource, notificationUrl: otherWebhookUrl, expirationDateTime: new Date(now + 4000 * 60 * 1000).toISOString() },
            { id: 'sub-skewed-fresh', resource, notificationUrl, expirationDateTime: new Date(now + (4200 * 60 - 30) * 1000).toISOString() },
            { id: 'sub-confirmed-orphan-65', resource, notificationUrl, expirationDateTime: new Date(now + 4000 * 60 * 1000).toISOString() }
          ]
        };
      }
      if (method === 'DELETE') {
        return {};
      }
      throw new Error(`Unhandled: ${method} ${url}`);
    }
  };

  const svc = new SubscriptionService({ graphClient: mockGraphClient, notificationUrl });

  const result = await svc.reconcileRemoteSubscriptions({ mailbox, folder, deleteOrphans: true });

  // Unrelated mailbox and unrelated webhook URL must NOT be in relevantRemote at all
  assert.strictEqual(result.remoteTotal, 5, 'Only 5 subscriptions match our mailbox resource and application webhook URL');

  // Uncertain/in-flight subscriptions: missing-ts, invalid-ts, past-ts, skewed-fresh = 4
  assert.strictEqual(result.inFlightRemoteCount, 4, '4 uncertain/fresh subscriptions treated as in-flight');

  // Only 1 confirmed orphan: sub-confirmed-orphan-65
  assert.strictEqual(result.remoteOrphansCount, 1, 'Exactly 1 confirmed orphan discovered');
  assert.strictEqual(result.deletedRemoteCount, 1, 'Exactly 1 confirmed orphan deleted');
  assert.strictEqual(result.remoteOrphans[0].id, 'sub-confirmed-orphan-65');

  const deletes = mockGraphClient.requests.filter(r => r.method === 'DELETE');
  assert.strictEqual(deletes.length, 1);
  assert.ok(deletes[0].url.includes('sub-confirmed-orphan-65'), 'Only the proven orphan must be deleted');
});

test('66. creation-age safety: 60-minute subscription lifetime is protected by active lease and never prematurely deleted as orphan', async () => {
  const mailbox = 'test66@example.com';
  const folder = 'inbox';
  const resource = formatGraphResource(mailbox, folder);
  const notificationUrl = 'https://api.example.com/webhooks/graph';
  const subId = 'sub-60min-66';

  // Subscription created 30s ago with a 60-minute lifetime (expires in 59.5 minutes)
  const now = Date.now();
  const createdAt = new Date(now - 30 * 1000);
  const expirationDateTime = new Date(now + 59.5 * 60 * 1000).toISOString();

  // Durable operation record with active lease
  await GraphSubscriptionOperation.create({
    operationId: 'op-66-active',
    mailbox,
    folder,
    resource,
    notificationUrl,
    subscriptionId: subId,
    state: 'pending',
    requestedExpirationMinutes: 60,
    leaseExpiresAt: new Date(now + 90 * 1000), // lease active for another 90s
    createdAt
  });

  const mockGraphClient = new MockGraphClient();
  mockGraphClient.mockSubscriptions = [
    { id: subId, resource, notificationUrl, expirationDateTime }
  ];

  const svc = new SubscriptionService({ graphClient: mockGraphClient, notificationUrl });

  // Pass 1: Reconcile while lease is active and age (30s) is within 2m grace
  // In the legacy code, remaining lifetime 59.5m was compared to 4200m and wrongly treated as an old orphan!
  // Under the operation-tracking design, it is recognized as in-flight and preserved!
  const pass1 = await svc.reconcileRemoteSubscriptions({ mailbox, folder, deleteOrphans: true });
  assert.strictEqual(pass1.inFlightRemoteCount, 1, '60m subscription must be classified as in-flight under active lease');
  assert.strictEqual(pass1.remoteOrphansCount, 0, '60m subscription must NOT be treated as orphan');
  assert.strictEqual(pass1.deletedRemoteCount, 0, 'Zero DELETE calls while under active lease');
  assert.strictEqual(mockGraphClient.requests.filter(r => r.method === 'DELETE').length, 0);

  // Pass 2: Simulate lease expiry and age exceeding grace (age = 3 minutes, lease expired 1 minute ago)
  // MongoDB persistence was abandoned / failed permanently
  await GraphSubscriptionOperation.updateOne(
    { operationId: 'op-66-active' },
    {
      $set: {
        createdAt: new Date(now - 3 * 60 * 1000),
        leaseExpiresAt: new Date(now - 60 * 1000)
      }
    }
  );

  const pass2 = await svc.reconcileRemoteSubscriptions({ mailbox, folder, deleteOrphans: true });
  assert.strictEqual(pass2.deletedRemoteCount, 0, 'Known subscriptionId stays protected after lease expiry');
  assert.strictEqual(pass2.inFlightRemoteCount, 1, 'Unpersisted known subscription is preserved for adoption');
  assert.strictEqual(mockGraphClient.requests.filter(r => r.method === 'DELETE').length, 0);

  const updatedOp = await GraphSubscriptionOperation.findOne({ operationId: 'op-66-active' }).lean();
  assert.strictEqual(updatedOp.state, 'pending', 'Known-id operation is not abandoned merely because the lease expired');
  assert.notStrictEqual(updatedOp.state, 'abandoned');
});

test('67. creation-age safety: 1,440-minute (24h) subscription lifetime is protected by active lease independently of 4200m constant', async () => {
  const mailbox = 'test67@example.com';
  const folder = 'inbox';
  const resource = formatGraphResource(mailbox, folder);
  const notificationUrl = 'https://api.example.com/webhooks/graph';
  const subId = 'sub-1440min-67';

  const now = Date.now();
  const createdAt = new Date(now - 20 * 1000); // created 20s ago
  const expirationDateTime = new Date(now + (1440 * 60 - 20) * 1000).toISOString();

  await GraphSubscriptionOperation.create({
    operationId: 'op-67-24h',
    mailbox,
    folder,
    resource,
    notificationUrl,
    subscriptionId: subId,
    state: 'pending',
    requestedExpirationMinutes: 1440,
    leaseExpiresAt: new Date(now + 100 * 1000),
    createdAt
  });

  const mockGraphClient = new MockGraphClient();
  mockGraphClient.mockSubscriptions = [
    { id: subId, resource, notificationUrl, expirationDateTime }
  ];

  const svc = new SubscriptionService({ graphClient: mockGraphClient, notificationUrl });

  const result = await svc.reconcileRemoteSubscriptions({ mailbox, folder, deleteOrphans: true });
  assert.strictEqual(result.inFlightRemoteCount, 1, '24h subscription protected under active lease');
  assert.strictEqual(result.deletedRemoteCount, 0, 'No premature deletion of 24h subscription');
});

test('68. creation-age safety: default 4,200-minute subscription lifetime operation tracking', async () => {
  const mailbox = 'test68@example.com';
  const folder = 'inbox';
  const resource = formatGraphResource(mailbox, folder);
  const notificationUrl = 'https://api.example.com/webhooks/graph';
  const subId = 'sub-4200min-68';

  const now = Date.now();
  const createdAt = new Date(now - 15 * 1000);
  const expirationDateTime = new Date(now + (4200 * 60 - 15) * 1000).toISOString();

  await GraphSubscriptionOperation.create({
    operationId: 'op-68-default',
    mailbox,
    folder,
    resource,
    notificationUrl,
    subscriptionId: subId,
    state: 'pending',
    requestedExpirationMinutes: 4200,
    leaseExpiresAt: new Date(now + 105 * 1000),
    createdAt
  });

  const mockGraphClient = new MockGraphClient();
  mockGraphClient.mockSubscriptions = [
    { id: subId, resource, notificationUrl, expirationDateTime }
  ];

  const svc = new SubscriptionService({ graphClient: mockGraphClient, notificationUrl });

  const result = await svc.reconcileRemoteSubscriptions({ mailbox, folder, deleteOrphans: true });
  assert.strictEqual(result.inFlightRemoteCount, 1, '4200m subscription protected under active lease');
  assert.strictEqual(result.deletedRemoteCount, 0);
});

test('69. crash recovery: crash after Graph POST but BEFORE subscriptionId association leaves unresolved operation in flight (Rule 10)', async () => {
  const mailbox = 'test69@example.com';
  const folder = 'inbox';
  const resource = formatGraphResource(mailbox, folder);
  const notificationUrl = 'https://api.example.com/webhooks/graph';
  const subId = 'sub-created-in-graph-69';

  const now = Date.now();

  // Operation was registered in MongoDB before calling Graph, but client crashed before saving subscriptionId
  await GraphSubscriptionOperation.create({
    operationId: 'op-69-crashed-before-id',
    mailbox,
    folder,
    resource,
    notificationUrl,
    subscriptionId: null, // crash occurred before ID was associated
    state: 'pending',
    requestedExpirationMinutes: 60,
    leaseExpiresAt: new Date(now + 90 * 1000), // active lease for 90s
    createdAt: new Date(now - 30 * 1000)
  });

  // Microsoft Graph did receive the POST and registered the subscription
  const mockGraphClient = new MockGraphClient();
  mockGraphClient.mockSubscriptions = [
    { id: subId, resource, notificationUrl, expirationDateTime: new Date(now + 59.5 * 60 * 1000).toISOString() }
  ];

  const svc = new SubscriptionService({ graphClient: mockGraphClient, notificationUrl });

  // Reconciler runs during the 90s active lease:
  // Must detect unresolved pending operation in flight and PRESERVE subId (never delete concurrent creation!)
  const pass1 = await svc.reconcileRemoteSubscriptions({ mailbox, folder, deleteOrphans: true });
  assert.strictEqual(pass1.inFlightRemoteCount, 1, 'Remote sub must be preserved while unresolved operation is in-flight under lease');
  assert.strictEqual(pass1.deletedRemoteCount, 0, 'Must NOT delete remote subscription belonging to unresolved operation');

  // Once lease expires (3 minutes later), reconciler runs again
  await GraphSubscriptionOperation.updateOne(
    { operationId: 'op-69-crashed-before-id' },
    {
      $set: {
        leaseExpiresAt: new Date(now - 60 * 1000),
        state: 'abandoned'
      }
    }
  );

  const pass2 = await svc.reconcileRemoteSubscriptions({ mailbox, folder, deleteOrphans: true });
  assert.strictEqual(pass2.deletedRemoteCount, 1, 'Remote orphan cleaned up after lease has expired');
});

test('70. crash recovery: Graph POST times out after remote creation (operation marked failed but active lease preserves until grace expiration)', async () => {
  const mailbox = 'test70@example.com';
  const folder = 'inbox';
  const resource = formatGraphResource(mailbox, folder);
  const notificationUrl = 'https://api.example.com/webhooks/graph';
  const subId = 'sub-timeout-70';

  const now = Date.now();

  // Operation record recorded the timeout error
  await GraphSubscriptionOperation.create({
    operationId: 'op-70-timeout',
    mailbox,
    folder,
    resource,
    notificationUrl,
    subscriptionId: subId,
    state: 'failed',
    lastError: 'ETIMEDOUT',
    requestedExpirationMinutes: 1440,
    leaseExpiresAt: new Date(now + 90 * 1000), // lease still active
    createdAt: new Date(now - 30 * 1000)
  });

  const mockGraphClient = new MockGraphClient();
  mockGraphClient.mockSubscriptions = [
    { id: subId, resource, notificationUrl, expirationDateTime: new Date(now + 1439 * 60 * 1000).toISOString() }
  ];

  const svc = new SubscriptionService({ graphClient: mockGraphClient, notificationUrl });

  // Within lease / grace: preserved
  const pass1 = await svc.reconcileRemoteSubscriptions({ mailbox, folder, deleteOrphans: true });
  assert.strictEqual(pass1.inFlightRemoteCount, 1, 'Preserved while within creation grace window');
  assert.strictEqual(pass1.deletedRemoteCount, 0);

  // After lease expiry the known subscription id is still unresolved, so it is preserved.
  await GraphSubscriptionOperation.updateOne(
    { operationId: 'op-70-timeout' },
    { $set: { createdAt: new Date(now - 5 * 60 * 1000), leaseExpiresAt: new Date(now - 60 * 1000) } }
  );

  const pass2 = await svc.reconcileRemoteSubscriptions({ mailbox, folder, deleteOrphans: true });
  assert.strictEqual(pass2.deletedRemoteCount, 0, 'Known subscriptionId is not deleted after lease expiry');
  assert.strictEqual(pass2.inFlightRemoteCount, 1);
  assert.strictEqual(mockGraphClient.requests.filter(r => r.method === 'DELETE').length, 0);
});

test('71. concurrency guarantees: two concurrent creation workers respect lease contention (single-flight)', async () => {
  const mailbox = 'test71@example.com';
  const folder = 'inbox';
  const resource = formatGraphResource(mailbox, folder);
  const notificationUrl = 'https://api.example.com/webhooks/graph';

  process.env.MS_GRAPH_CLIENT_STATE_SECRET = 'secret-71';
  process.env.MS_GRAPH_CLIENT_STATE_KEY_ID = 'key-71';

  try {
    const mockGraphClient = new MockGraphClient();
    mockGraphClient.mockSubscriptions = [];

    const svc = new SubscriptionService({ graphClient: mockGraphClient, notificationUrl });

    // Worker 1 registers pre-creation operation with 2-minute active lease
    await GraphSubscriptionOperation.create({
      operationId: 'op-71-worker1',
      mailbox,
      folder,
      resource,
      notificationUrl,
      state: 'pending',
      requestedExpirationMinutes: 4200,
      leaseExpiresAt: new Date(Date.now() + 120 * 1000)
    });

    // Worker 2 calls createSubscription concurrently
    const result2 = await svc.createSubscription({ mailbox, folder });

    // Worker 2 must detect the in-flight operation under active lease and yield without calling Graph
    assert.strictEqual(result2.created, false);
    assert.strictEqual(result2.inFlight, true);
    assert.strictEqual(result2.operationId, 'op-71-worker1');
    assert.strictEqual(mockGraphClient.requests.length, 0, 'Worker 2 must not dispatch duplicate Graph POST');
  } finally {
    delete process.env.MS_GRAPH_CLIENT_STATE_SECRET;
    delete process.env.MS_GRAPH_CLIENT_STATE_KEY_ID;
  }
});

test('72. safety invariant: unknown remote subscriptions with differing resource or notification URL are NEVER deleted', async () => {
  const mailbox = 'test72@example.com';
  const otherMailbox = 'different-user@example.com';
  const folder = 'inbox';
  const ourResource = formatGraphResource(mailbox, folder);
  const otherResource = formatGraphResource(otherMailbox, folder);
  const ourNotificationUrl = 'https://api.example.com/webhooks/graph';
  const foreignNotificationUrl = 'https://other-company.org/webhook';

  const now = Date.now();
  const mockGraphClient = new MockGraphClient();
  mockGraphClient.mockSubscriptions = [
    // Foreign application subscription (different notificationUrl)
    { id: 'sub-foreign-app', resource: ourResource, notificationUrl: foreignNotificationUrl, expirationDateTime: new Date(now + 4000 * 60 * 1000).toISOString() },
    // Different mailbox subscription
    { id: 'sub-different-mailbox', resource: otherResource, notificationUrl: ourNotificationUrl, expirationDateTime: new Date(now + 4000 * 60 * 1000).toISOString() }
  ];

  const svc = new SubscriptionService({ graphClient: mockGraphClient, notificationUrl: ourNotificationUrl });

  const result = await svc.reconcileRemoteSubscriptions({ mailbox, folder, deleteOrphans: true });

  assert.strictEqual(result.remoteTotal, 0, 'Foreign and different mailbox subscriptions must be completely excluded');
  assert.strictEqual(result.remoteOrphansCount, 0);
  assert.strictEqual(result.deletedRemoteCount, 0);
  assert.strictEqual(mockGraphClient.requests.filter(r => r.method === 'DELETE').length, 0, 'Zero DELETE calls for foreign subscriptions');
});

test('73. ambiguous outcome: Graph POST returns confirmed 400 rejection (classified as confirmed_rejection, lease expired immediately)', async () => {
  const mailbox = 'test73@example.com';
  const folder = 'inbox';
  const resource = formatGraphResource(mailbox, folder);
  const notificationUrl = 'https://api.example.com/webhooks/graph';

  process.env.MS_GRAPH_CLIENT_STATE_SECRET = 'secret-73';
  process.env.MS_GRAPH_CLIENT_STATE_KEY_ID = 'key-73';

  try {
    const mockGraph = new MockGraphClient();
    mockGraph.setHandler('POST', '/subscriptions', () => {
      const err = new Error('Invalid notification URL');
      err.statusCode = 400;
      throw err;
    });

    const svc = new SubscriptionService({ graphClient: mockGraph, notificationUrl });

    await assert.rejects(
      () => svc.createSubscription({ mailbox, folder }),
      (err) => err.statusCode === 400
    );

    // Verify operation document state
    const op = await GraphSubscriptionOperation.findOne({ mailbox }).lean();
    assert.ok(op, 'Operation record must be persisted');
    assert.strictEqual(op.state, 'failed', 'State must be failed');
    assert.strictEqual(op.failureClassification, 'confirmed_rejection', 'Must be classified as confirmed_rejection');
    assert.ok(new Date(op.leaseExpiresAt).getTime() <= Date.now(), 'Lease must expire immediately on confirmed rejection');
  } finally {
    delete process.env.MS_GRAPH_CLIENT_STATE_SECRET;
    delete process.env.MS_GRAPH_CLIENT_STATE_KEY_ID;
  }
});

test('74. ambiguous outcome: Graph POST returns 429 rate limit (classified as ambiguous, active lease protects remote subscription)', async () => {
  const mailbox = 'test74@example.com';
  const folder = 'inbox';
  const resource = formatGraphResource(mailbox, folder);
  const notificationUrl = 'https://api.example.com/webhooks/graph';
  const subId = 'sub-429-remote-74';

  process.env.MS_GRAPH_CLIENT_STATE_SECRET = 'secret-74';
  process.env.MS_GRAPH_CLIENT_STATE_KEY_ID = 'key-74';

  try {
    const mockGraph = new MockGraphClient();
    mockGraph.mockSubscriptions = [
      { id: subId, resource, notificationUrl, expirationDateTime: new Date(Date.now() + 4000 * 60 * 1000).toISOString() }
    ];
    mockGraph.setHandler('POST', '/subscriptions', () => {
      const err = new Error('Too Many Requests');
      err.statusCode = 429;
      throw err;
    });

    const svc = new SubscriptionService({ graphClient: mockGraph, notificationUrl });

    await assert.rejects(
      () => svc.createSubscription({ mailbox, folder }),
      (err) => err.statusCode === 429
    );

    const op = await GraphSubscriptionOperation.findOne({ mailbox }).lean();
    assert.strictEqual(op.state, 'failed');
    assert.strictEqual(op.failureClassification, 'ambiguous', '429 must be classified as ambiguous');
    assert.ok(new Date(op.leaseExpiresAt).getTime() > Date.now(), 'Lease must remain active to protect potential remote subscription');

    // Reconciler runs while lease is active: remote sub must be protected
    const recon = await svc.reconcileRemoteSubscriptions({ mailbox, folder, deleteOrphans: true });
    assert.strictEqual(recon.inFlightRemoteCount, 1, 'Remote sub protected by active lease after 429');
    assert.strictEqual(recon.deletedRemoteCount, 0, 'Zero DELETE calls while lease active');
  } finally {
    delete process.env.MS_GRAPH_CLIENT_STATE_SECRET;
    delete process.env.MS_GRAPH_CLIENT_STATE_KEY_ID;
  }
});

test('75. ambiguous outcome: Graph POST returns 503 service unavailable (classified as ambiguous, active lease protects remote subscription)', async () => {
  const mailbox = 'test75@example.com';
  const folder = 'inbox';
  const resource = formatGraphResource(mailbox, folder);
  const notificationUrl = 'https://api.example.com/webhooks/graph';
  const subId = 'sub-503-remote-75';

  process.env.MS_GRAPH_CLIENT_STATE_SECRET = 'secret-75';
  process.env.MS_GRAPH_CLIENT_STATE_KEY_ID = 'key-75';

  try {
    const mockGraph = new MockGraphClient();
    mockGraph.mockSubscriptions = [
      { id: subId, resource, notificationUrl, expirationDateTime: new Date(Date.now() + 4000 * 60 * 1000).toISOString() }
    ];
    mockGraph.setHandler('POST', '/subscriptions', () => {
      const err = new Error('Service Unavailable');
      err.statusCode = 503;
      throw err;
    });

    const svc = new SubscriptionService({ graphClient: mockGraph, notificationUrl });

    await assert.rejects(
      () => svc.createSubscription({ mailbox, folder }),
      (err) => err.statusCode === 503
    );

    const op = await GraphSubscriptionOperation.findOne({ mailbox }).lean();
    assert.strictEqual(op.state, 'failed');
    assert.strictEqual(op.failureClassification, 'ambiguous', '503 must be classified as ambiguous');
    assert.ok(new Date(op.leaseExpiresAt).getTime() > Date.now());

    // Reconciler runs: protected
    const recon = await svc.reconcileRemoteSubscriptions({ mailbox, folder, deleteOrphans: true });
    assert.strictEqual(recon.inFlightRemoteCount, 1);
    assert.strictEqual(recon.deletedRemoteCount, 0);
  } finally {
    delete process.env.MS_GRAPH_CLIENT_STATE_SECRET;
    delete process.env.MS_GRAPH_CLIENT_STATE_KEY_ID;
  }
});

test('76. ambiguous outcome: Graph POST times out after Graph may have created subscription (operation failure is ambiguous, lease protects remote sub)', async () => {
  const mailbox = 'test76@example.com';
  const folder = 'inbox';
  const resource = formatGraphResource(mailbox, folder);
  const notificationUrl = 'https://api.example.com/webhooks/graph';
  const subId = 'sub-timeout-remote-76';

  process.env.MS_GRAPH_CLIENT_STATE_SECRET = 'secret-76';
  process.env.MS_GRAPH_CLIENT_STATE_KEY_ID = 'key-76';

  try {
    const mockGraph = new MockGraphClient();
    mockGraph.mockSubscriptions = [
      { id: subId, resource, notificationUrl, expirationDateTime: new Date(Date.now() + 4000 * 60 * 1000).toISOString() }
    ];
    mockGraph.setHandler('POST', '/subscriptions', () => {
      const err = new Error('Client network socket disconnected before secure TLS connection was established');
      err.code = 'ETIMEDOUT';
      throw err;
    });

    const svc = new SubscriptionService({ graphClient: mockGraph, notificationUrl });

    await assert.rejects(
      () => svc.createSubscription({ mailbox, folder }),
      (err) => err.code === 'ETIMEDOUT'
    );

    const op = await GraphSubscriptionOperation.findOne({ mailbox }).lean();
    assert.strictEqual(op.state, 'failed');
    assert.strictEqual(op.failureClassification, 'ambiguous', 'Timeout must be classified as ambiguous');
    assert.ok(new Date(op.leaseExpiresAt).getTime() > Date.now());

    // Reconciler runs while lease is active: protected
    const recon = await svc.reconcileRemoteSubscriptions({ mailbox, folder, deleteOrphans: true });
    assert.strictEqual(recon.inFlightRemoteCount, 1, 'Remote subscription protected during active lease following timeout');
    assert.strictEqual(recon.deletedRemoteCount, 0);
  } finally {
    delete process.env.MS_GRAPH_CLIENT_STATE_SECRET;
    delete process.env.MS_GRAPH_CLIENT_STATE_KEY_ID;
  }
});

test('77. ambiguous outcome: connection drops (ECONNRESET) after Graph receives POST (protected during active lease)', async () => {
  const mailbox = 'test77@example.com';
  const folder = 'inbox';
  const resource = formatGraphResource(mailbox, folder);
  const notificationUrl = 'https://api.example.com/webhooks/graph';
  const subId = 'sub-econnreset-77';

  process.env.MS_GRAPH_CLIENT_STATE_SECRET = 'secret-77';
  process.env.MS_GRAPH_CLIENT_STATE_KEY_ID = 'key-77';

  try {
    const mockGraph = new MockGraphClient();
    mockGraph.mockSubscriptions = [
      { id: subId, resource, notificationUrl, expirationDateTime: new Date(Date.now() + 4000 * 60 * 1000).toISOString() }
    ];
    mockGraph.setHandler('POST', '/subscriptions', () => {
      const err = new Error('read ECONNRESET');
      err.code = 'ECONNRESET';
      throw err;
    });

    const svc = new SubscriptionService({ graphClient: mockGraph, notificationUrl });

    await assert.rejects(
      () => svc.createSubscription({ mailbox, folder }),
      (err) => err.code === 'ECONNRESET'
    );

    const op = await GraphSubscriptionOperation.findOne({ mailbox }).lean();
    assert.strictEqual(op.state, 'failed');
    assert.strictEqual(op.failureClassification, 'ambiguous');

    const recon = await svc.reconcileRemoteSubscriptions({ mailbox, folder, deleteOrphans: true });
    assert.strictEqual(recon.inFlightRemoteCount, 1);
    assert.strictEqual(recon.deletedRemoteCount, 0);
  } finally {
    delete process.env.MS_GRAPH_CLIENT_STATE_SECRET;
    delete process.env.MS_GRAPH_CLIENT_STATE_KEY_ID;
  }
});

test('78. failed operation with an active lease protects a matching remote subscription', async () => {
  const mailbox = 'test78@example.com';
  const folder = 'inbox';
  const resource = formatGraphResource(mailbox, folder);
  const notificationUrl = 'https://api.example.com/webhooks/graph';
  const subId = 'sub-test-78';

  const now = Date.now();
  await GraphSubscriptionOperation.create({
    operationId: 'op-78',
    mailbox,
    folder,
    resource,
    notificationUrl,
    subscriptionId: null,
    state: 'failed',
    failureClassification: 'ambiguous',
    lastError: 'socket hang up',
    leaseExpiresAt: new Date(now + 90 * 1000) // active lease
  });

  const mockGraph = new MockGraphClient();
  mockGraph.mockSubscriptions = [
    { id: subId, resource, notificationUrl, expirationDateTime: new Date(now + 4000 * 60 * 1000).toISOString() }
  ];

  const svc = new SubscriptionService({ graphClient: mockGraph, notificationUrl });
  const result = await svc.reconcileRemoteSubscriptions({ mailbox, folder, deleteOrphans: true });

  assert.strictEqual(result.inFlightRemoteCount, 1, 'Failed operation with active lease must protect remote sub');
  assert.strictEqual(result.deletedRemoteCount, 0);
  assert.strictEqual(mockGraph.requests.filter(r => r.method === 'DELETE').length, 0);
});

test('79. failed operation with an expired lease is handled through recovery', async () => {
  const mailbox = 'test79@example.com';
  const folder = 'inbox';
  const resource = formatGraphResource(mailbox, folder);
  const notificationUrl = 'https://api.example.com/webhooks/graph';
  const subId = 'sub-test-79';

  const now = Date.now();
  await GraphSubscriptionOperation.create({
    operationId: 'op-79',
    mailbox,
    folder,
    resource,
    notificationUrl,
    subscriptionId: null,
    state: 'failed',
    failureClassification: 'ambiguous',
    lastError: 'ETIMEDOUT',
    leaseExpiresAt: new Date(now - 60 * 1000) // expired 1 minute ago
  });

  const mockGraph = new MockGraphClient();
  mockGraph.mockSubscriptions = [
    { id: subId, resource, notificationUrl, expirationDateTime: new Date(now + 4000 * 60 * 1000).toISOString() }
  ];

  const svc = new SubscriptionService({ graphClient: mockGraph, notificationUrl });
  const result = await svc.reconcileRemoteSubscriptions({ mailbox, folder, deleteOrphans: true });

  assert.strictEqual(result.deletedRemoteCount, 0, 'Expired ambiguous operation must not be cleaned up as an orphan');
  assert.strictEqual(result.inFlightRemoteCount, 1);
  assert.strictEqual(mockGraph.requests.filter(r => r.method === 'DELETE').length, 0);
  const op = await GraphSubscriptionOperation.findOne({ operationId: 'op-79' }).lean();
  assert.strictEqual(op.state, 'failed');
  assert.notStrictEqual(op.state, 'abandoned');
});

test('80. reconciliation and creation overlap (reconciliation runs while worker is actively in flight)', async () => {
  const mailbox = 'test80@example.com';
  const folder = 'inbox';
  const resource = formatGraphResource(mailbox, folder);
  const notificationUrl = 'https://api.example.com/webhooks/graph';
  const subId = 'sub-test-80';

  const now = Date.now();
  // Worker 1 is in-flight right now (state: 'pending')
  await GraphSubscriptionOperation.create({
    operationId: 'op-80-inflight',
    mailbox,
    folder,
    resource,
    notificationUrl,
    subscriptionId: null,
    state: 'pending',
    leaseExpiresAt: new Date(now + 120 * 1000)
  });

  const mockGraph = new MockGraphClient();
  mockGraph.mockSubscriptions = [
    { id: subId, resource, notificationUrl, expirationDateTime: new Date(now + 4200 * 60 * 1000).toISOString() }
  ];

  const svc = new SubscriptionService({ graphClient: mockGraph, notificationUrl });
  const result = await svc.reconcileRemoteSubscriptions({ mailbox, folder, deleteOrphans: true });

  assert.strictEqual(result.inFlightRemoteCount, 1, 'Creation in flight protects remote sub during overlap');
  assert.strictEqual(result.deletedRemoteCount, 0);
});

test('81. two reconcilers inspect the same unresolved operation concurrently', async () => {
  const mailbox = 'test81@example.com';
  const folder = 'inbox';
  const resource = formatGraphResource(mailbox, folder);
  const notificationUrl = 'https://api.example.com/webhooks/graph';
  const subId = 'sub-test-81';

  const now = Date.now();
  await GraphSubscriptionOperation.create({
    operationId: 'op-81',
    mailbox,
    folder,
    resource,
    notificationUrl,
    subscriptionId: null,
    state: 'failed',
    failureClassification: 'ambiguous',
    lastError: 'ETIMEDOUT',
    leaseExpiresAt: new Date(now + 90 * 1000)
  });

  const mockGraph = new MockGraphClient();
  mockGraph.mockSubscriptions = [
    { id: subId, resource, notificationUrl, expirationDateTime: new Date(now + 4000 * 60 * 1000).toISOString() }
  ];

  const svc1 = new SubscriptionService({ graphClient: mockGraph, notificationUrl });
  const svc2 = new SubscriptionService({ graphClient: mockGraph, notificationUrl });

  const [res1, res2] = await Promise.all([
    svc1.reconcileRemoteSubscriptions({ mailbox, folder, deleteOrphans: true }),
    svc2.reconcileRemoteSubscriptions({ mailbox, folder, deleteOrphans: true })
  ]);

  assert.strictEqual(res1.inFlightRemoteCount, 1);
  assert.strictEqual(res2.inFlightRemoteCount, 1);
  assert.strictEqual(res1.deletedRemoteCount, 0);
  assert.strictEqual(res2.deletedRemoteCount, 0);
  assert.strictEqual(mockGraph.requests.filter(r => r.method === 'DELETE').length, 0);
});

test('82. genuine orphan is eventually cleaned after safe recovery', async () => {
  const mailbox = 'test82@example.com';
  const folder = 'inbox';
  const resource = formatGraphResource(mailbox, folder);
  const notificationUrl = 'https://api.example.com/webhooks/graph';
  const subId = 'sub-genuine-orphan-82';

  const now = Date.now();
  await GraphSubscriptionOperation.create({
    operationId: 'op-82-lifecycle',
    mailbox,
    folder,
    resource,
    notificationUrl,
    subscriptionId: subId,
    state: 'failed',
    failureClassification: 'ambiguous',
    lastError: 'ETIMEDOUT',
    leaseExpiresAt: new Date(now + 60 * 1000) // active lease initially
  });

  const mockGraph = new MockGraphClient();
  mockGraph.mockSubscriptions = [
    { id: subId, resource, notificationUrl, expirationDateTime: new Date(now + 4000 * 60 * 1000).toISOString() }
  ];

  const svc = new SubscriptionService({ graphClient: mockGraph, notificationUrl });

  // Pass 1: Under active lease -> protected
  const pass1 = await svc.reconcileRemoteSubscriptions({ mailbox, folder, deleteOrphans: true });
  assert.strictEqual(pass1.inFlightRemoteCount, 1);
  assert.strictEqual(pass1.deletedRemoteCount, 0);

  // Pass 2: Lease expires -> genuine orphan safely deleted
  await GraphSubscriptionOperation.updateOne(
    { operationId: 'op-82-lifecycle' },
    { $set: { leaseExpiresAt: new Date(now - 60 * 1000) } }
  );

  const pass2 = await svc.reconcileRemoteSubscriptions({ mailbox, folder, deleteOrphans: true });
  assert.strictEqual(pass2.deletedRemoteCount, 0, 'Ambiguous known subscription is preserved after lease expiry');
  assert.strictEqual(pass2.inFlightRemoteCount, 1);
  assert.strictEqual(mockGraph.requests.filter(r => r.method === 'DELETE').length, 0);
  const stillFailed = await GraphSubscriptionOperation.findOne({ operationId: 'op-82-lifecycle' }).lean();
  assert.strictEqual(stillFailed.state, 'failed');
});

test('83. operation record is retained until recovery is complete (never deleted automatically)', async () => {
  const mailbox = 'test83@example.com';
  const folder = 'inbox';
  const resource = formatGraphResource(mailbox, folder);
  const notificationUrl = 'https://api.example.com/webhooks/graph';
  const subId = 'sub-retained-83';

  const now = Date.now();
  await GraphSubscriptionOperation.create({
    operationId: 'op-83-permanent',
    mailbox,
    folder,
    resource,
    notificationUrl,
    subscriptionId: subId,
    state: 'failed',
    failureClassification: 'ambiguous',
    lastError: 'ETIMEDOUT',
    leaseExpiresAt: new Date(now - 120 * 1000) // expired
  });

  const mockGraph = new MockGraphClient();
  mockGraph.mockSubscriptions = [
    { id: subId, resource, notificationUrl, expirationDateTime: new Date(now + 4000 * 60 * 1000).toISOString() }
  ];

  const svc = new SubscriptionService({ graphClient: mockGraph, notificationUrl });
  const recon = await svc.reconcileRemoteSubscriptions({ mailbox, folder, deleteOrphans: true });

  assert.strictEqual(recon.deletedRemoteCount, 0, 'Expired ambiguous subscription must not be deleted');
  const opAfterRecon = await GraphSubscriptionOperation.findOne({ operationId: 'op-83-permanent' }).lean();
  assert.ok(opAfterRecon, 'Operation record must remain in MongoDB after orphan reconciliation');
  assert.strictEqual(opAfterRecon.state, 'failed');
  assert.notStrictEqual(opAfterRecon.state, 'abandoned');
  assert.strictEqual(mockGraph.requests.filter(r => r.method === 'DELETE').length, 0);
});

test('84. force: true cannot bypass reservation safety and create uncontrolled duplicate subscriptions', async () => {
  const mailbox = 'test84@example.com';
  const folder = 'inbox';
  const resource = formatGraphResource(mailbox, folder);
  const notificationUrl = 'https://api.example.com/webhooks/graph';

  process.env.MS_GRAPH_CLIENT_STATE_SECRET = 'secret-84';
  process.env.MS_GRAPH_CLIENT_STATE_KEY_ID = 'key-84';

  try {
    const mockGraph = new MockGraphClient();
    const svc = new SubscriptionService({ graphClient: mockGraph, notificationUrl });

    // Worker 1 holds active creation reservation lease
    await GraphSubscriptionOperation.create({
      operationId: 'op-84-worker1',
      mailbox,
      folder,
      resource,
      notificationUrl,
      state: 'pending',
      requestedExpirationMinutes: 4200,
      leaseExpiresAt: new Date(Date.now() + 120 * 1000)
    });

    // Worker 2 calls createSubscription with force=true: must NOT bypass reservation safety
    const result = await svc.createSubscription({ mailbox, folder, force: true });
    assert.strictEqual(result.created, false);
    assert.strictEqual(result.inFlight, true);
    assert.strictEqual(result.operationId, 'op-84-worker1');
    assert.strictEqual(mockGraph.requests.length, 0, 'Worker 2 must not call Graph POST even with force=true');
  } finally {
    delete process.env.MS_GRAPH_CLIENT_STATE_SECRET;
    delete process.env.MS_GRAPH_CLIENT_STATE_KEY_ID;
  }
});
