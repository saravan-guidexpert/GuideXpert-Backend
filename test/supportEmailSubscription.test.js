'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  setupTestDb,
  clearTestDb,
  teardownTestDb
} = require('./supportEmail/harness');

const GraphSubscription = require('../models/GraphSubscription');
const EmailSyncCursor = require('../models/EmailSyncCursor');
const EmailIngestionPolicy = require('../models/EmailIngestionPolicy');
const {
  SubscriptionService,
  hashClientState,
  generateClientState,
  timingSafeCompare,
  formatGraphResource
} = require('../services/supportEmail/subscriptionService');

class MockGraphClient {
  constructor() {
    this.requests = [];
    this.mockHandlers = new Map();
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
  await setupTestDb();
});

test.beforeEach(async () => {
  await clearTestDb();
});

test.after(async () => {
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
